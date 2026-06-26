# Block 2 findings — the real processor (2026-06-26)

Block 2 replaces the Block-1 stub Worker with the production processor in
`services/queue-consumer/app.mjs`. The processor does three things per job: a pre-trigger idempotency
check, a held-connection spine trigger, and error classification into retryable-vs-dead-letter. Every
Definition-of-Done item below is backed by a live run against the production stack, not assertion.

The terminal dead-letter CRITICAL alert (on attempts exhaustion) is **Block 4**; the producer cutover
behind `config.queue_enabled` is **Block 3**; monitoring + heartbeat is **Block 5**. Block 2 leaves the
live @-mention path unchanged and synchronous (no producer is wired to the queue yet).

---

## What was built (`services/queue-consumer/app.mjs`)

### 1. Pre-trigger idempotency check (ADR-035 role only)
Before triggering the spine, the processor queries Supabase `agent_runs` (REST) for a **completed** row
matching this job within `dedup_window_h`, and if found **succeeds the job as a no-op** (skip — does not
re-draft). This is the only role `agent_runs` plays in judging a run; the *result* of a run is judged
from the ingress response, not from `agent_runs` (Block 0 G2). The skip also covers the edge where a
prior attempt's held connection dropped **after** the spine wrote its run but **before** responding: the
consumer sees a transport error → BullMQ retries → the idempotency check finds the completed run → skips.

**Load-bearing schema fact (the match column).** The match is on **`agent_runs.triggered_by`**, *not*
`agent_runs.invocation_type`:
- The job-contract `invocation_type` (queue vocabulary: `explicit_mention`, `due_date`, …) aligns with
  `agent_runs.triggered_by` (`explicit_mention`, `due_date_daily`, …), **not** with
  `agent_runs.invocation_type`, which is the coarse `CHECK (autonomous|explicit|conversation_reply)` set.
- Matching `triggered_by` is both schema-correct and more precise than matching the 3-value
  `invocation_type` (it won't conflate an `explicit_mention` run with an `explicit_command` run on the
  same task).
- The consumer resolves a single `triggered_by` value (from `payload.triggered_by`, falling back to a
  derivation map) and uses **the same value** for both the idempotency query and the value it sends the
  ingress — so the check asks exactly "did a run that looks like the one I'm about to trigger already
  complete?". For the only in-scope producer (`explicit_mention`, Block 3) the derivation is exact.

**Fail-safe:** a failed idempotency read **throws retryable** (it does *not* proceed blind — a hidden
completed run would double-draft). Worst case is a delayed first draft during a Supabase outage, alerted
via Block 4's eventual DLQ; never a double-draft.

### 2. Held-connection spine trigger — `node:http`, deliberately not `fetch`
The processor POSTs the 7 ingress inputs and **awaits the held connection up to `spine_timeout_ms`**
(1 200 000 ms). The ingress returns a deterministic HTTP 200 `{status, outcome, failure_kind,
clickup_task_id, warnings}` (Block 1).

It uses **`node:http`, not Node's global `fetch`.** This is the non-obvious correctness point of the
block: the ingress holds the connection open with no response for the *entire* spine run (up to 15 min,
G5), and undici/`fetch`'s default **~300 s `headersTimeout`** would abort a *healthy* long run at 5 min
as a false transport error (→ needless retry; Block 0 proved the held connection with `curl`, never with
Node `fetch`, so this risk was latent). `node:http`'s socket-inactivity `timeout`, set to
`spine_timeout_ms`, is the only timer — exactly the intended held-connection cap.

The 7 ingress inputs are resolved from the job, preferring producer-supplied `payload` values and
deriving the two spine-vocabulary fields the producer may not supply:
- `taskId ← task_id`; `reviewer_user_id ← payload.reviewer_user_id ?? caller_user_id`;
  `caller_username ← payload.caller_username`; `triggering_comment_id/text ← payload.*`.
- `triggered_by ← payload.triggered_by ?? TRIGGERED_BY[invocation_type]` (the idempotency key).
- `invocation_type` (sent to the ingress) ← **spine** vocabulary `SPINE_INVOCATION[invocation_type]`
  (`explicit_mention → explicit`). Sending the job's `explicit_mention` here would violate the
  `agent_runs.invocation_type` CHECK and break the spine's own run insert — so the consumer derives it.

### 3. Error classification (ADR-047 / Block 0 G2 contract)
- transport error / held-connection timeout / genuine n8n **5xx** → **throw retryable** (BullMQ retries);
- HTTP **200 `status=completed`** → job done;
- HTTP **200 `status=failed`** (business) → **`UnrecoverableError`** → straight to dead-letter, no retry;
- non-5xx non-2xx (4xx) / unparseable 200 body / unknown `status` → conservative `UnrecoverableError`
  (4xx and unknown-contract won't fix on retry; an unparseable 200 is treated retryable as a likely
  transient proxy/HTML).

Business failures stay **200 + a `status` field** end-to-end, never an HTTP 5xx, so the HTTP client /
BullMQ never auto-retry a known-bad business outcome (double-draft guard).

`attempts = retry_attempts` (5) and a **custom per-attempt backoff** (`backoff:{type:'custom'}` + a
Worker `settings.backoffStrategy` returning `cfg.backoff_ms = [60000,300000,900000]`, clamped to the last
element) are wired here so the classification is demonstrable. The terminal `failed`→CRITICAL DLQ alert
is Block 4.

The Block-1 `STUB_DELAY_MS` test hook was removed (from `app.mjs` and the compose snippet; the inert env
line was dropped from the live `docker-compose.yml` during this deploy).

---

## Definition of Done — live verification

| DoD item | Result |
|---|---|
| **Real queued job → real spine run** | ✅ Enqueued `869dwb3j5:explicit_mention:20630` (priority 3) → consumer `spine_call` (attempt 0) → orchestrator execution **4061** success (13:30:26→13:30:45) → `agent_runs` row **658** `status=completed`, `triggered_by=explicit_mention`, `invocation_type=explicit`, `model=claude-sonnet-4-6` → **threaded ClickUp reply posted** by "Agent Haxe" (contextually correct, cost 0.3232 PLN) → consumer `spine_completed (outcome:ok)` → `completed`. |
| **Idempotent skip** | ✅ Re-enqueued the same task+invocation in a prior dedup-window bucket (`…:20629`, distinct jobId → bypasses queue dedup, reaches the processor). Processor logged `idempotent_skip` referencing `prior_run_id:658` then `completed` — **no `spine_call`, no new orchestrator run, no second reply**. |
| **Forced business failure → no retry** | ✅ Transient consumer on isolated queue `agent-jobs-test`, pointed at a throwaway mock ingress returning `200 {status:failed,failure_kind:forced_test}`. Job logged `spine_business_failure` → `failed unrecoverable=true attempts=1`. No retry (UnrecoverableError → straight to failed). |
| **Forced retryable failure → retries on backoff** | ✅ Same transient consumer pointed at `http://n8n-main:9999/x` (instant ECONNREFUSED). attempt 0 → `spine_transport_error` → `failed unrecoverable=false attempts=1`; **~60 s later** attempt 1 → `spine_transport_error` → `attempts=2`. Job opts confirm `opts.attempts=5`, `opts.backoff={type:custom}` (strategy → 60/300/900s). First interval observed live; full schedule by configuration. |
| **No spurious alerts** | ✅ Latest `Post Alert (v1)` execution is 4053 (12:50, the Block-1 clamp WARN); **no Post Alert executions during Block 2**. |

**Isolation of the classification tests:** they ran on a **separate queue** (`agent-jobs-test`, same
`haxeq` prefix → keys `haxeq:agent-jobs-test:*`) via a transient `qc-test` container, so the production
consumer (`agent-jobs`) and the real spine were never touched. After testing: `qc-test` removed, the
mock workflow deleted, all `haxeq:agent-jobs-test:*` keys flushed (0 remaining), test `agent_runs` row
658 deleted, disposable ClickUp task `869dwb3j5` deleted. The production consumer remained healthy on the
real ingress throughout.

---

## Silent-failure modes covered by Block 2

- **Double-draft via false held-connection timeout** (the new, latent risk): covered by using `node:http`
  with the socket timer = `spine_timeout_ms`, so a healthy ≤15-min run is never aborted by undici's
  hidden ~300 s `headersTimeout`.
- **Double-draft via blind-proceed on a failed idempotency read:** covered — a failed read throws
  retryable, never proceeds.
- **Double-draft via auto-retried business failure:** covered — business failures are `200 + status`
  classified to `UnrecoverableError` (no retry), never an HTTP 5xx.
- **Re-draft of an already-completed task** (incl. the connection-drops-after-write retry edge): covered
  by the pre-trigger `agent_runs` skip.
- **Spine-trigger infra failure going unnoticed:** transport/timeout/5xx → retryable throw → eventual DLQ
  (the CRITICAL alert lands in Block 4; until then these are logged `warn`/`error`, not silent).

**Knowingly deferred (scheduled, not silent gaps):** terminal attempts-exhaustion → CRITICAL DLQ alert
(Block 4); dead consumer → heartbeat dead-man's-switch (Block 5); backlog depth cron (Block 5); the
30–60s config refresh poll + "restart required" WARN (Block 5).

---

## Operational notes / carry-forward

- **VPS link flapped repeatedly** during this block (SSH port 22 dropped for multi-minute windows several
  times; the box and containers stayed healthy throughout). Mitigated by shipping multi-step VPS work as
  detached scripts writing to a log (`/tmp/classify-test.log`) and polling, rather than holding an
  interactive SSH session. Worth a host/network glance if it persists (also flagged in block-1).
- **`triggered_by` derivation is exact only for `explicit_mention`** (the in-scope producer). The
  `TRIGGERED_BY`/`SPINE_INVOCATION` maps cover the other queue invocation types, but the
  `autonomous_webhook → webhook_status_change` mapping is ambiguous (status vs field change) — the
  Phase-3 producer that builds those jobs must pass `payload.triggered_by` explicitly. Documented in code.
- **Mock-ingress test pattern is reusable** for Block 4 (DLQ) and Block 6 (negative config / burst):
  a transient consumer on `agent-jobs-test` + a throwaway mock webhook isolates classification/retry
  tests from prod and the real spine at zero Anthropic cost. Not persisted as a script (throwaway), but
  the shape is recorded here.
