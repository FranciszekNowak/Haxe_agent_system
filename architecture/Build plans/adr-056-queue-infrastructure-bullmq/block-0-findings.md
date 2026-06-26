# Block 0 findings — ADR-056 capability gates (resolved 2026-06-26)

Block 0 resolves the five capability gates **before** any consumer/migration/workflow is built.
Each answer below is backed by live verification (docs + live config + timed runs + a restart test),
not assertion. Two gates (**G2**, **G5**) overturned assumptions baked into the ADR and change what
Block 1 must seed — read those two carefully.

Definition of Done (from the master plan): C chosen; ingress shape proven with a timed run; max
runtime measured; versions + AOF confirmed; all five answers recorded here. **All met.**

---

## G1 — Managed-Agents environment-concurrency semantics → C and `env_concurrency_cap`

**Answer: sessions share a POOLED environment. C is NOT hard-capped at 5.**

Evidence:
- **Anthropic Managed Agents docs (claude-api skill, `managed-agents-environments.md` / `-core.md`):**
  an *environment* is a **reusable configuration template** for provisioning containers. Each *session*
  references one `environment_id` and gets its **own** container, provisioned lazily; "Anthropic handles
  scaling, container lifecycle, and work orchestration." Many sessions run against one environment.
- **The "5 concurrent" number is on the Environments *resource-endpoint* group, not running sessions.**
  The Managed Agents rate-limit table (`managed-agents-api-reference.md`) lists three org-scoped groups:
  Create operations (Agents/Sessions/Vaults) **300 RPM**; all other operations (Agents/Sessions/Vaults)
  **600 RPM**; **all operations (Environments) 60 RPM, max concurrent 5.** The `5` qualifies the
  *Environments* row — i.e. environment management calls — not how many agent sessions may run.
- **Live config confirms the pooled model in practice:** `config.managed_agent_environment_id =
  env_01T1PexJQheEUVnzVTKjyrz4` — a **single** shared environment template that every managed-agent
  session in the system runs against (one row, not one-per-session). ADR-053's "5 concurrent
  environments" line refers to this same environments cap, which we are nowhere near (we use one).

What actually bounds in-flight sessions (= in-flight spine runs = BullMQ concurrency C): the
**create-session RPM (300/min = 5/s)** — not binding, since a spine run lasts minutes, not seconds —
and **ITPM/OTPM** model-inference token limits, which are slack at five-person volume.

**Decision:**
- `queue.concurrency` (C) default = **5** (ADR-056 §4 conservative default — stands; safe, leaves every
  per-integration limit slack).
- `queue.env_concurrency_cap` = **10**. This is a **software safety-rail** (the read-side clamp ceiling),
  *not* a hard platform limit — because the real platform limit is pooled/token-based, there is no clean
  "5" to clamp to. 10 gives headroom above C=5 so the clamp never bites at the default, while still
  catching a fat-finger edit (e.g. `concurrency = 500`). **Before raising C above 5, validate
  empirically** in Block 6's burst test (watch for 429/529); do not assume headroom that hasn't been
  observed.

---

## G2 — Consumer→spine call shape (held connection) → **proven, but return-contract needs hardening**

**Answer: the held-connection ingress works over the internal Docker network in queue mode. The
held connection is the chosen mechanism (async-poll fallback NOT needed). BUT the raw HTTP
status/body of a `responseMode: lastNode` webhook is an UNRELIABLE spine-success signal — Block 1
must harden the ingress return contract.**

Probe setup: built `Spine HTTP Ingress (v1)` (live id `SQOkffGQhzMojrmN`, **left deactivated** for
Block 1) — `Webhook (responseMode: lastNode) → Execute Workflow (Agent Orchestrator a8XKaijkMFNBpRBa)`.
Called over the internal network (`http://n8n-main:5678/webhook/...`) from a throwaway
`curlimages/curl` container attached to `haxe-agents_n8n-internal` (n8n containers ship no curl/wget).
This path **bypasses nginx entirely** (nginx only fronts the public `agents.haxe.ai`), so the 300s
`proxy_read_timeout` does not apply.

**Run A — held-connection duration proof (side-effect-free):** a temp `Webhook(lastNode) → Code(sleep
330s)` workflow. Result: **`HTTP=200`, `TIME=330.03s`**, body `{"ok":true,"slept_ms":330001}`. n8n-main
held the HTTP connection open for **330 seconds — well past nginx's 300s cap** — in queue mode (the
worker ran the 330s node; main relayed the `lastNode` output). This is the decisive proof that the
nginx-bypassing internal call survives a multi-minute synchronous hold.

**Run B — real spine end-to-end (disposable task `869dw9acb`):** drove the real orchestrator through the
ingress. Orchestrator execution **4035 succeeded** end-to-end (When Called → Assemble Context → managed
lane → **Call Execute Agent Session** → Render → Write Cost Field → **Call Post Reply (Managed)** →
`{target_id, updated:1}` — a reply was posted; `agent_runs` row 657 logged `status=completed`,
`model=claude-sonnet-4-6`). The held connection returned the instant the run finished (14.7s).
**No alerts fired** (latest `Post Alert (v1)` execution predates the probe).

**The decisive finding — HTTP status is not the success signal.** Run B returned **`HTTP=500
{"code":0,"message":"No item to return was found"}` on a fully-successful spine run.** Cause: bare
`responseMode: lastNode` returns the output of whichever node n8n deems the workflow's terminal, and the
orchestrator's terminal branches (`Call Post Reply (Managed)`, `Img Cost Missing?`,
`Render Has Warnings?`) are branchy — the node that surfaced as the return emitted **0 items** to the
Execute-Workflow caller, so the webhook had "no item to return" → 500. This is the documented n8n
sub-workflow-return-determinism trap (CLAUDE.md), surfacing as an HTTP 500 despite success.

**Implication for the consumer (carry into Block 1/2):** harden the ingress so its HTTP response **is**
the authoritative, deterministic signal — do not fall back to polling `agent_runs` to judge the result.
The 500 was only because bare `lastNode` let n8n pick the return node by accident; the orchestrator
itself already computes a clear outcome (`Call Execute Agent Session` → `{status, failure_kind, outcome,
warnings}`, gated by `Session OK?` / `If LLM Succeeded?`). **Block 1 adds an explicit terminal that
returns that outcome**, e.g. `Webhook(responseNode) → Execute Workflow (orchestrator, onError:
continueErrorOutput) → Set (coalesce to ONE item carrying the orchestrator's real outcome: {status,
outcome, failure_kind, clickup_task_id, warnings}) → Respond to Webhook`. Consumer classification then
reads that response:
- **transport error / timeout / genuine n8n-level 5xx** → retryable infra failure (ADR-047);
- **HTTP 200, `status=completed`** → job done;
- **HTTP 200, `status=failed` (business)** → `UnrecoverableError` → DLQ (no retry).

Keep business failures as **200 + a `status` field**, *not* an HTTP 5xx, so the HTTP client / BullMQ
don't auto-retry a business failure (that would double-draft). The `agent_runs` row keeps **only** its
ADR-035 role — the **pre-trigger idempotency skip** (don't re-run a task already drafted in the dedup
window); it is not used to judge this run's result. The two mechanisms compose cleanly: the ingress
response classifies the normal case, and the pre-trigger `agent_runs` check covers the one edge where
the connection drops *after* the spine wrote its run but *before* responding (consumer sees a transport
error → retries → idempotency check finds the completed run → skips). This refines ADR-056 §3/§6
("await completion and use success/failure"): classify **infra** failure by transport, classify
**business outcome** from the ingress's structured response.

**Async-poll fallback:** documented in the ADR as the recorded fallback; **not needed** — the held
connection is reliable.

---

## G3 — Immediate-200 safety → confirmed (already true)

`n8n/workflows/cu-webhook-producer.json:15` → `"responseMode": "onReceived"`. The CU Webhook Producer
returns its 200 instantly and runs the spine inline in the *background* of that same execution (the
`Run Agent Spine` `executeWorkflow` node). Nothing downstream depends on a synchronous spine result, so
swapping the inline call for an `/enqueue` POST that returns immediately changes nothing observable to
the producer's HTTP response. G3 holds.

---

## G4 — Versions + durability → confirmed

- **Redis: 7.4.9** (`redis:7-alpine`). BullMQ requires Redis ≥ 6.2 — satisfied with wide margin.
- **AOF: on.** `appendonly yes`, `appendfsync everysec`.
- **AOF survives a restart (tested live):** set sentinel `haxe:g4:aoftest=block0-persist` → `docker
  restart n8n-redis` → after the container came back (`PING`→`PONG`), `GET` returned `block0-persist`.
  Key survived; sentinel deleted afterward. `n8n-main` and `n8n-worker` both reconnected cleanly
  (`running`). `everysec` means a worst-case *hard crash* could lose ≤1s of writes, but a clean
  `docker restart` (SIGTERM → graceful shutdown) flushes fully — no loss. Re-confirm in Block 5.

---

## G5 — Max spine runtime → measured, and it **overturns the ADR's lock/timeout defaults**

**Answer: the spine's runtime ceiling is anchored by the managed-agent session's internal 840s
deadline + orchestrator overhead ≈ 872s observed worst case. ADR-056 §8 / the amendment table seed
`lock_duration_ms=600000` and `spine_timeout_ms=540000` — BOTH are below the real ceiling and would
cause double-drafts. Block 1 must seed corrected values.**

Evidence (longest of the last ~30 orchestrator executions, via `n8n_executions`):
- **Execution 3642 — total 871.8s.** `Call Execute Agent Session` ran **852.9s**; the managed session
  **hit its internal 840s deadline** (`outcome: "deadline"`, `duration_seconds: 840.73`, warning
  *"Sesja agenta przekroczyla limit czasu (840s) — zwrocono wynik czesciowy"*) and returned a partial.
  Orchestrator overhead beyond the session ≈ 19s. This is an image-heavy run (reference-image moodboard).
- Other long runs: 3601 ≈ 627s, 3306 ≈ 498s, 3592 ≈ 390s. Several routinely exceed the ADR's assumed
  10-minute lock.

The 840s session deadline (ADR-053 Block 5) is the dominant cap — the session self-terminates with a
partial rather than running unbounded — so worst-case spine total ≈ 840s + orchestrator pre/post
overhead. Round up for headroom.

**Why the ADR defaults are unsafe:**
- `lock_duration_ms=600000` (10 min) **< 872s real run** → BullMQ would declare a *healthy* 14.5-min job
  stalled and re-run it (`maxStalledCount`) → **double-draft**.
- `spine_timeout_ms=540000` (9 min) **< 872s real run** → the consumer would abort a *healthy* held
  connection before the 840s session deadline returns → retry → **double-draft**.

**Corrected seed values for Block 1** (MARGIN = 120000 ms = 2 min):

| key | ADR default | **Block-1 seed** | rationale |
|---|---|---|---|
| `queue.max_runtime_ms` (G5) | — (new) | **900000** | 840s session deadline + ~32s orchestrator overhead (872s observed), rounded up |
| `queue.lock_duration_ms` | 600000 | **1200000** | floor = `max_runtime + MARGIN` = 1020000; 1.2M gives headroom (a healthy ≤900s run is never declared stalled) |
| `queue.spine_timeout_ms` | 540000 | **1020000** | must be `> max_runtime` (won't abort a healthy ~872s run) **and** `< lock_duration − MARGIN` (1080000) |
| `queue.env_concurrency_cap` (G1) | — (new) | **10** | software safety-rail ceiling (see G1) |
| `queue.concurrency` (C) | 5 | **5** | conservative default (G1) |

Invariant check (the three the fail-safe reader enforces):
`concurrency(5) ≤ env_cap(10)` ✓ · `lock_duration(1.2M) ≥ max_runtime(900k)+MARGIN(120k)=1.02M` ✓ ·
`spine_timeout(1.02M) < lock_duration(1.2M)−MARGIN(120k)=1.08M` ✓ · and `spine_timeout(1.02M) >
max_runtime(900k)` ✓ (so a healthy slow run is awaited, not killed).

---

## Silent-failure modes covered by Block 0

- **Double-draft via stalled-job re-run** (lock too short): caught by measuring the real 872s ceiling and
  raising `lock_duration_ms` default (G5).
- **Double-draft via premature consumer abort** (spine timeout too short): caught by raising
  `spine_timeout_ms` above the 840s session deadline (G5).
- **Double-draft via misread HTTP 500** (ingress returns 500 on a *successful* run): caught by the G2
  finding — Block 1/2 verify success via `agent_runs`, not HTTP status.
- **429/529 storm via over-concurrency:** bounded by C=5 default + the `env_concurrency_cap` clamp;
  empirically re-validated in Block 6's burst test before C is ever raised.

## Artifacts left live / cleaned up

- **Left live (for Block 1):** `Spine HTTP Ingress (v1)` workflow `SQOkffGQhzMojrmN`, **deactivated**.
  Block 1 must (a) harden its return contract (deterministic 200 terminal, per G2) and (b) export it to
  `n8n/workflows/spine-http-ingress.json`. Flagged here so the live object is not silent drift.
- **Cleaned up:** temp `G2 Hold Test` workflow (deleted); disposable ClickUp task `869dw9acb` (deleted);
  test `agent_runs` row 657 (deleted); G4 sentinel Redis key (deleted).
- **Observed, not actioned:** `n8n-main` is emitting a recurring "Error while saving insights metadata
  and raw data" log loop (the known Insights write-noise; CLAUDE.md warns it can escalate to a 502 under
  heavy execution floods). It did not affect either probe run. Not chasing it in Block 0; keep
  throwaway-execution volume low in later blocks.
