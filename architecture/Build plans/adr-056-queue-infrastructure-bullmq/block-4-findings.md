# Block 4 findings — retry / backoff / dead-letter alert (2026-06-26)

Block 4 completes the retry/backoff/dead-letter story for the queue-consumer. The retry policy itself
(`attempts = retry_attempts = 5`, custom per-attempt backoff `60/300/900s`) and the error
classification (retryable throw vs `UnrecoverableError`) were already wired in **Block 2** so the
classification was demonstrable. The one piece deferred from Block 2 to here was the **terminal
dead-letter alert**: when a job is genuinely dead-lettered, fire **exactly one CRITICAL** to the Alerts
channel. That is the whole of Block 4's net-new code. Every Definition-of-Done item below is backed by a
live run against the production stack, not assertion.

Monitoring (`/metrics` + depth cron) + the consumer heartbeat dead-man's-switch + the 30–60s config
refresh poll remain **Block 5**; the §14 doc reconciliation + burst/priority scope-test + mark-LIVE is
**Block 6**.

---

## What was built (`services/queue-consumer/app.mjs`)

A single change: the BullMQ `worker.on('failed', …)` handler now posts a CRITICAL alert, but **only on
the terminal failure** — the dead-letter — never on a retryable interim failure.

**Why the terminal gate is the load-bearing detail.** BullMQ's `failed` event fires **once per failed
attempt**, not once per job. A job with `attempts = 5` that keeps hitting a retryable error fires
`failed` five times; only the fifth is the dead-letter. BullMQ itself stops retrying (moves the job to
the `failed` set) only when **either** the error is an `UnrecoverableError` **or** all attempts are
exhausted (`attemptsMade >= opts.attempts`). The handler mirrors exactly that condition:

```js
const unrecoverable = err instanceof UnrecoverableError;
const terminal = !!job && (unrecoverable || job.attemptsMade >= (job.opts?.attempts ?? 1));
if (!terminal) return;            // retryable interim failure: let the backoff schedule retry it
await postAlert('CRITICAL', …);   // dead-lettered: alarm exactly once
```

So the alert fires once per dead-letter, regardless of how many retries preceded it. The two ways a job
dead-letters get distinct messages:
- **non-retryable** (`UnrecoverableError` — a `200 status=failed` business outcome, a 4xx, an unknown
  status): `"agent job <id> dead-lettered (non-retryable) after N attempt(s)"`;
- **exhausted** (a retryable error that used up every attempt): `"agent job <id> dead-lettered:
  exhausted N/M attempts"`.

The alert `details` carry `jobId`, `task_id`, `invocation_type`, `priority`, `attempts_made`,
`max_attempts`, `unrecoverable`, the last `error`, and BullMQ's `failed_reason` — everything the
operator needs to act without opening the consumer logs. It rides the existing alert seam (`postAlert`
→ reused Storage Watchdog Intake → `Post Alert (v1)` → Alerts task), source `queue-consumer/dlq`.
`postAlert` swallows its own errors, so a failed alert can never crash the worker.

**The BullMQ `failed` set _is_ the dead-letter store.** Jobs are added with `removeOnFail: { age:
86400 }` (Block 1/2), so a dead-lettered job stays inspectable for 24h. No separate DLQ data structure
is needed; this handler is its alarm. (Block 5's `/metrics` will surface the `failed` count for the
depth cron.)

Three now-stale "Block 4" forward-notes in the source comments were updated to point at the implemented
handler.

---

## Definition of Done — live verification

Both terminal paths were exercised on an **isolated** queue (`agent-jobs-test`, same `haxeq` prefix →
keys `haxeq:agent-jobs-test:*`) via a **transient** consumer container (`docker run --rm`, same image),
so the production consumer (`agent-jobs`) and the **real spine were never touched** and no Anthropic
cost was incurred. No mock workflow was needed (a 404 from an unregistered webhook path is itself the
non-retryable case).

| DoD item | Result |
|---|---|
| **Non-retryable → immediate dead-letter → one CRITICAL** (§14.5 "4xx → dead-letter immediately") | ✅ Consumer pointed at `http://n8n-main:5678/webhook/nonexistent-b4-404-xyz` → n8n returns **HTTP 404**. Job `B4TESTA:due_date:20630` (priority 7): `spine_call (attempt 0)` → `spine_4xx (404)` → `failed attempts:1 max_attempts:5 unrecoverable:true terminal:true`. **One** CRITICAL `queue-consumer/dlq` "dead-lettered (non-retryable) after 1 attempt(s)". No retry (UnrecoverableError short-circuits the remaining 4 attempts). |
| **Retryable → backoff → exhaustion → one CRITICAL, no interim alert** | ✅ Consumer pointed at `http://n8n-main:9999/x` (instant ECONNREFUSED). Job `B4TESTB-manual` enqueued with **per-job** `attempts:2, backoff:{type:'fixed',delay:3000}` (so exhaustion is ~3s, touching **no** shared config): attempt 0 → `spine_transport_error` → `failed attempts:1 max_attempts:2 terminal:false` (**no alert**); ~3s later attempt 1 → `spine_transport_error` → `failed attempts:2 max_attempts:2 terminal:true` → **one** CRITICAL "dead-lettered: exhausted 2/2 attempts". |
| **Exactly once, end-to-end via the alert channel** | ✅ `node scripts/alerts-since.mjs 15 --crit --source queue-consumer/dlq` → **2 CRITICAL, 0 WARN** — exactly one per dead-lettered job, **not three** (the interim retryable failure produced none). Both alerts carried the full `details` (jobId, attempts_made/max_attempts, unrecoverable, error). |

**Why per-job `attempts`/`backoff` for Test B instead of editing config.** The fast-exhaustion test
needs `attempts=2` + a short backoff, but those live in the shared Supabase `queue.*` config and the
production consumer would read the lowered values on its next restart. Setting them **per-job** at
enqueue (BullMQ job options on the test job only) exercises the **real** `failed` handler and the real
exhaustion path while mutating no shared state — strictly cleaner than the config-edit + revert dance.
(A `backoff:{type:'fixed'}` per-job option also bypasses the Worker's `custom` `backoffStrategy`, which
only fires for `type:'custom'`, so the 3s delay is exact.)

**Test-induced alerts (explained, not a failure).** The two CRITICALs above are the *intended* output of
the test and now sit in the Alerts task as comments, clearly labelled `B4TESTA…` / `B4TESTB-manual`.
They are test artifacts, not real incidents. `alerts-since.mjs` reads them from n8n Post Alert
executions (no ClickUp token), which is the channel the DoD checks.

**Cleanup.** Both transient consumers stopped/removed (`--rm`); all `haxeq:agent-jobs-test:*` keys
flushed (7 deleted, 0 remaining). **No `agent_runs` rows and no ClickUp tasks were created** (neither
target ran a real spine), so there was nothing else to delete. The production consumer stayed healthy
throughout (`/health` ok, concurrency 5, Redis PONG); no shared config was changed (nothing to revert).

---

## Silent-failure modes covered by Block 4

- **Terminal job failure going unnoticed** (the mode Blocks 2/3 explicitly deferred to here): covered —
  every dead-letter, by either route (exhaustion or `UnrecoverableError`), fires exactly one CRITICAL
  with actionable `details` through the standard seam. This closes the loop on the "spine-trigger infra
  failure → retryable throw → eventual DLQ" chain from Block 2: the eventual DLQ now alarms.
- **Alert storm from per-attempt firing** (the new risk this block introduces): covered — the terminal
  gate (`unrecoverable || attemptsMade >= attempts`) means a 5-attempt job fires the `failed` event 5
  times but alerts **once**. Verified live (a 2-attempt job → 1 CRITICAL, not 2).
- **A failing alert crashing the worker:** covered — `postAlert` never throws; a dropped alert is logged
  at error level and the worker keeps running.

**Knowingly deferred (scheduled, not silent gaps):** dead consumer → heartbeat dead-man's-switch
(Block 5); growing `failed`/`waiting` backlog → `/metrics` depth cron (Block 5); the 30–60s config
refresh poll + "restart required" WARN for construction-only values (Block 5); §14 doc reconciliation +
mark-LIVE (Block 6).

---

## Operational notes / carry-forward

- **No mock-ingress workflow was needed for the DLQ tests** — a 404 from an unregistered webhook path
  gives the non-retryable case and an unreachable port gives the retryable case, both with zero n8n
  workflow churn (which also sidesteps the Insights write-error caution in CLAUDE.md). Recorded as the
  preferred shape for Block 6's forced-failure case too.
- **The transient-consumer network name is compose-prefixed** (`haxe-agents_n8n-internal`, not
  `n8n-internal`); `docker run --network n8n-internal` fails with "network not found". Use
  `docker network ls | grep internal` (or `docker inspect queue-consumer`) to get the real name.
- **`docker run` overrides + `--env-file`:** the transient consumer reuses `/opt/haxe-agents/.env`
  (`--env-file`) for `SUPABASE_*` / `ALERT_INTAKE_KEY`, and overrides `QUEUE_NAME`, `SPINE_INGRESS_URL`,
  `ALERT_INTAKE_URL` with `-e` (the latter two are hard-coded in compose, not `.env`). The `-e` values win.
