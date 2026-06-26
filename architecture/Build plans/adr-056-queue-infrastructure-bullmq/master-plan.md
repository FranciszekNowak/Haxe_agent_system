# Master plan — ADR-056: BullMQ application queue + thin consumer service

> **This is the durable, cross-desktop source of truth** (the `~/.claude` plan file does not travel
> between machines). Run the house block-by-block routine: read this file top to bottom, do the first
> not-done block, write back to `architecture/current.md` + ADR-056 (+ a `block-N-findings.md`
> alongside this file), update the status table, commit, emit a handoff, `/clear`, repeat. Decision
> record: `architecture/decisions/056-queue-infrastructure-bullmq.md`.

## Context (why)

The agent pipeline today is **synchronous from trigger to spine**. The only live producer — the
`CU Webhook Producer (v1)` (`eS66Sk6fweQ0EOPa`) — returns its 200 instantly (`responseMode:
onReceived`) but then, in the background of that same execution, calls the Agent Orchestrator
(`a8XKaijkMFNBpRBa`) via an `executeWorkflow` node and runs it inline. There is no priority, no
admission control against the Anthropic Managed Agents concurrency limit, no retry-with-backoff, no
dead-letter, and no idempotency beyond the per-comment claim. `current.md` §14 specifies all of
these but names "n8n queue mode" as the mechanism — which (per ADR-056 R1) cannot express per-job
priority, custom backoff-to-DLQ, or token-bucket rate limiting.

ADR-056 resolves this: add **BullMQ** as the application-level job queue on the existing Redis,
fronted by a **thin Node consumer service** (mirroring `services/zip-extractor/` from ADR-058).
Producers enqueue and return; the consumer's BullMQ Worker dequeues by priority, enforces
concurrency = in-flight spine runs, checks idempotency, triggers the spine, and owns
retry/backoff/dead-letter. A `config.queue_enabled` flag with a synchronous fallback makes the
cutover reversible.

**Intended outcome:** a burst (the canonical "50 tasks due at midnight") is paced under the Managed
Agents cap without 429/529 storms; an interactive @-mention jumps the overnight batch; transient
failures retry on 60/300/900s and a terminal failure dead-letters exactly once to the Alerts task;
none of it double-drafts.

This plan is written against the **live** repo state confirmed by exploration, not the ADR alone.

## Decisions locked with the operator (2026-06-26)

1. **Keep n8n in queue mode; BullMQ coexists on the same Redis by key prefix.** Live n8n runs
   `N8N_EXECUTIONS_MODE: queue` on both `n8n-main` and `n8n-worker` (`n8n/docker-compose.yml:48,95`),
   and ADR-058 depends on that main/worker split for crash isolation. The two queues sit at different
   layers: **n8n queue mode distributes n8n *executions*** (infra + memory isolation of heavy/at-risk
   runs away from the webhook/UI process); **BullMQ admits *agent jobs*** (priority, Managed-Agents
   concurrency, retry/DLQ, idempotency). BullMQ cannot execute n8n workflows — only trigger them — so
   it cannot replace queue mode. The "duplication" is skin-deep (different key prefixes, ~tens of MB
   Redis). **ADR-056 §1/R3's "n8n stays in regular mode" line is stale and is amended in Block 6, not
   implemented.** Going regular-mode would collapse all executions into `n8n-main`'s 768 MB heap (the
   base64 image path included) — a reliability regression — and only becomes clean if image generation
   is also offloaded to a container (deliberately deferred by ADR-055). Not now.

2. **Scope = cut over the one live producer only.** Of ADR-056's four named producers, only the
   `CU Webhook Producer` (@-mention) exists; the daily due-date cron, Gmail watcher, and status/field
   webhook are Phase-3/unbuilt (`current.md` §15.10). Block 3 cuts over exactly the @-mention
   producer; the `/enqueue` contract is documented as the template the Phase-3 producers adopt when
   built. They are **out of scope** here.

3. **Consumer→spine via a new thin HTTP ingress workflow, held connection (gate G2).** The
   orchestrator's only entries are a `When Called` (`executeWorkflowTrigger`) and a Form Trigger —
   neither HTTP-callable by a Node service. Add `Spine HTTP Ingress (v1)`:
   `Webhook (responseMode: lastNode) → Execute Workflow (Agent Orchestrator) → Respond`, called by the
   consumer over the **internal Docker network** (`http://n8n-main:5678/...`, bypassing nginx's 300s
   `proxy_read_timeout`), holding the connection until the spine finishes (job lifetime = spine run,
   ADR-056 §3). Block 0 proves a multi-minute held connection works in queue mode (main relays the
   worker's result); async-poll of the executions API is the recorded fallback.

4. **Consumer reuses the existing generic alert ingress.** `Storage Watchdog Intake (v1)`
   (`storage-watchdog-intake.json`, path `storage-watchdog-7e06358ac257ad20`) is already a
   **source-agnostic** header-auth (`X-Watchdog-Key`) webhook forwarding `{severity, source, message,
   details}` into `Post Alert (v1)` (`YSCdHlmdf3p9XEUx`) → Alerts task `869dj2z2c`. The consumer POSTs
   here (source = `queue-consumer/*`) — the unification-correct choice; **no new alert workflow**.
   (The Alerts task is dropped by the producer's `Not Telemetry Task?` guard, so consumer alerts can't
   loop.)

5. **Impact is supplied by the producer at enqueue.** Priority needs `impact` before the spine runs,
   and priority is computed at `/enqueue` (ADR-056 amendment 2026-06-23b). The CU producer gains a
   background ClickUp task-field fetch (after its instant 200), defaulting to `Średni` if absent, and
   puts `impact` in the job. The consumer stays ClickUp-credential-free; the spine still re-reads
   impact itself for tier routing. `queue.priority_high_impacts` is **retired** — the impact-rank map
   is a code constant (contract-shape, not config).

## Architecture / fixed design points

- **New service** `services/queue-consumer/` (container `queue-consumer`, `n8n-internal`,
  `expose: 8080` internal only; model: `services/zip-extractor/*`). Deps: `bullmq`, `ioredis`,
  `express`. Connects to `n8n-redis:6379`. Reads Supabase (`config`, `agent_runs`) via REST with
  `SUPABASE_SERVICE_KEY`. No ClickUp creds.
- **One queue** `agent-jobs`, BullMQ `prefix` distinct from n8n's (e.g. `haxeq` → keys
  `haxeq:agent-jobs:*`, never colliding with n8n's `bull:*`).
- **Job contract** = ADR-056's block verbatim (`task_id`, `caller_user_id`, `impact`,
  `invocation_type`, `priority` 1–8, `idempotency_key`, `enqueued_at`, `payload`). `jobId =
  idempotency_key = ${task_id}:${invocation_type}:${dedup_window}`.
- **Priority** = 8-level lexicographic (amendment 2026-06-23b): `priority = (is_explicit ? 0 : 4) +
  impact_rank`, `impact_rank = {Krytycznie ważne:1, Wysoki:2, Średni:3, Niski:4}`. Always set 1–8.
- **Fail-safe config reader** (load-bearing): read `queue.*` once at startup, poll every 30–60s;
  `clamp + WARN` the three silent-failure invariants (`concurrency ≤ env_cap`, `lock_duration_ms ≥
  max_runtime_ms + MARGIN`, `spine_timeout_ms < lock_duration_ms − MARGIN`); restart-only values
  (`lock_duration_ms`, `rate_limit_per_min`) WARN "restart required" on change. Consumer owns all
  `queue.*` reads; n8n producers read only `queue.enabled`.
- **Error classification (ADR-047):** 5xx / timeout / 429 / 529 / network → retryable throw;
  4xx-except-429 / validation / business-logic → `UnrecoverableError` → DLQ.
- **`config` table** is `key text PK, value text NOT NULL` — array/number knobs stored as text JSON,
  parsed by the reader. **`agent_runs`** already carries `queue_priority`/`queue_wait_ms`/
  `retry_attempt` columns (schema anticipated this queue); idempotency lookup uses
  `idx_runs_task`/`idx_runs_invocation_type`.

## Block status

| # | Block | State |
|---|---|---|
| 0 | Capability gates G1–G5 (env-concurrency cap → C; prove held-connection ingress; immediate-200 safety; BullMQ↔Redis7+AOF; measure max spine runtime) | ✅ done (2026-06-26, `block-0-findings.md`). **G1** pooled env → C=5, `env_concurrency_cap`=10. **G2** held connection proven (330s + real spine over internal net, bypasses nginx); ingress `SQOkffGQhzMojrmN` left deactivated — Block 1 must harden its return contract — bare `lastNode` returns HTTP 500 on a *successful* run; add an explicit Respond terminal so the HTTP response carries the orchestrator's real outcome (consumer classifies from that response, not `agent_runs`). **G3** producer `onReceived` confirmed. **G4** Redis 7.4.9 + AOF survives restart. **G5** real ceiling **up to 15 min** per single n8n execution (872s observed) → **raise seeds**: `max_runtime_ms`=900000 (15m), `spine_timeout_ms`=1200000 (20m), `lock_duration_ms`=1500000 (25m). |
| 1 | Migration `045_queue_config.sql` + consumer skeleton (`/enqueue`, stub Worker, fail-safe reader, `/health`) deployed | ✅ done (2026-06-26, `block-1-findings.md`). Migration applied (14 `queue.*` seeds + write-side validating trigger). `services/queue-consumer/` deployed (container on `n8n-internal`, prefix `haxeq`). Spine HTTP Ingress hardened to a deterministic 200 outcome + **active** + exported (drift-clean). DoD verified live: enqueue→priority-ordered pickup→complete; config read at startup; `concurrency=50`→clamped to 10 + WARN delivered to Alerts (Post Alert exec 4053). |
| 2 | Processor: `agent_runs` idempotency check → spine ingress await (`spine_timeout`) → error classification | ✅ done (2026-06-26, `block-2-findings.md`). Real processor replaces the stub. Idempotency matches `agent_runs.triggered_by` (=job `invocation_type`) within `dedup_window_h` → skip-as-no-op. Spine held over **`node:http`** (not `fetch` — undici's ~300s `headersTimeout` would falsely abort a healthy 15-min run) up to `spine_timeout_ms`. Classification: transport/timeout/5xx → retryable (BullMQ backoff 60/300/900s, `attempts=5` wired); `200 status=failed`/4xx/unknown → `UnrecoverableError` → DLQ. **DoD verified live:** queued job → real spine → ClickUp reply (orchestrator exec 4061, `agent_runs` 658, model sonnet-4-6); idempotent skip (prior_run_id 658, no spine call); business failure → no retry (attempts=1, unrecoverable); transport failure → retried ~60s later (attemptsMade=2, backoff custom). Zero spurious alerts. Test fixtures (mock workflow, row 658, task 869dwb3j5, `agent-jobs-test` keys) deleted. |
| 3 | Producer cutover — CU Webhook Producer behind `config.queue_enabled` (enqueue vs sync fallback); re-export + drift-check | ✅ done (2026-06-26, `block-3-findings.md`). 6 nodes added to the live producer (`Read Queue Flag` → `Queue Enabled?` → `Fetch Task Impact` → `Build Enqueue Job` → `Enqueue Job`, + `Alert Enqueue Failed`); flag-on enqueues to `http://queue-consumer:8080/enqueue` with the task impact resolved, flag-off / enqueue-failure falls back to the unchanged `Run Agent Spine` + WARN. **Consumer dedup made invocation-class-aware** (the real fix): explicit jobs key `jobId` on the triggering comment (`…:c<id>`) so follow-up @-mentions aren't collapsed by the 24h window, and their `agent_runs` check runs only as a retry-after-partial guard; autonomous jobs unchanged. **DoD verified live:** two distinct mentions on one task both drafted (rows 659+660, two distinct threaded replies); same-comment re-enqueue deduped; a real tag-op webhook drove producer→`/enqueue`→spine→reply (exec 4107 → row 661, impact Wysoki fetched); flag-off fell back to a synchronous draft (row 662) with zero enqueues. Producer re-exported, drift-clean (39/39). All test artifacts deleted. |
| 4 | Retry/backoff (60/300/900s, attempts=5) + DLQ → one CRITICAL via the reused alert intake | ⬜ not started |
| 5 | Monitoring (consumer `/metrics` + depth cron) + consumer heartbeat dead-man's-switch (host systemd) + config refresh poll; AOF-survives-restart | ⬜ not started |
| 6 | Burst + priority + negative-config scope-test; reconcile `current.md` §14/§15 + amend ADR-056 (regular→queue mode); mark LIVE | ⬜ not started |

Each block ends with: write-back to `current.md` + ADR-056, a `block-N-findings.md`, status-table
update, commit, handoff. Live verification (not "looks right") per Definition of Done; all alerts
through `Post Alert (v1)`; never read or post-watch the Alerts task `869dj2z2c`; migrations
append-only; exported workflow JSON re-exported after any live change, never hand-edited (preserve
curated node `notes` + any `toolWorkflow` `schema[]` the exporter strips).

## The blocks

### Block 0 — Capability gates (resolve before building)
- **G1** Managed Agents environment-concurrency semantics → sets `C` + `queue.env_concurrency_cap`.
  Check ADR-053 + the live env (`config.managed_agent_environment_id`): pooled (C may exceed 5) or
  one-per-session (C ≤ 5)? Conservative default **C=5**.
- **G2** Build `spine-http-ingress.json` and **prove a real multi-minute held connection** end-to-end
  on the internal network returns the spine result (bypasses nginx). On failure → async-poll, recorded
  here.
- **G3** Confirm nothing depends on a synchronous spine result from the producer (already true).
- **G4** BullMQ ↔ Redis 7 compat (≥6.2 fine) + AOF confirmed surviving a restart.
- **G5** Measure the **longest real spine run** (image-heavy) → set `queue.max_runtime_ms` + the
  `lock_duration_ms` floor.
- **DoD:** C chosen; ingress proven with a timed run; max runtime measured; versions + AOF confirmed;
  all five answers recorded in `block-0-findings.md`.

### Block 1 — Migration + consumer skeleton + fail-safe config reader
- `supabase/migrations/045_queue_config.sql` (append-only): seed all `queue.*` defaults from the ADR
  amendment table **including** `queue.env_concurrency_cap` (G1) + `queue.max_runtime_ms` (G5); add
  write-side validation (per-key CHECK or a `queue.%` validating trigger for absolute bounds). Do
  **not** seed `priority_high_impacts`.
- `services/queue-consumer/`: `package.json`, `app.mjs` (BullMQ `Queue` + `/enqueue` validating the
  contract, computing 8-level priority, `queue.add` with `jobId`+`priority`; `Worker` `concurrency=C`,
  `lockDuration`, `maxStalledCount=1`, **stub** processor logs+completes; `loadQueueConfig()`
  clamp+WARN; `/health`), `Dockerfile`, `.gitignore`, `README.md`, `docker-compose.snippet.yml`.
- Deploy to `/opt/haxe-agents/queue-consumer/`, merge compose snippet, add `.env`
  (`SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `REDIS_HOST`, `REDIS_PORT`, `SPINE_INGRESS_URL`,
  `ALERT_INTAKE_URL`, `ALERT_INTAKE_KEY`), `docker compose up -d --build queue-consumer`.
- **DoD:** enqueue (curl from the n8n network) → Worker picks up **by priority** → logs → completes;
  config read at startup; an out-of-bounds `queue.concurrency` clamps + WARNs.

### Block 2 — Processor
- Idempotency check vs `agent_runs` (completed row for `clickup_task_id` + `invocation_type` within
  `dedup_window_h`) → skip-as-no-op if found; else call the spine ingress and await with
  `spine_timeout_ms`; classify errors (retryable vs `UnrecoverableError`).
- **DoD:** real spine run from a queued job (verify via `inspect-execution.mjs` + the produced ClickUp
  draft); idempotent skip verified; forced 4xx → no retry; forced 5xx → retries on 60/300/900s.
  **Delete test `agent_runs` rows + disposable ClickUp task afterward.**

### Block 3 — Producer cutover (CU Webhook Producer only)
- In `cu-webhook-producer.json`: after the instant 200, add a `Read config.queue_enabled` Postgres
  node + an impact fetch; `IF queue_enabled` → **HTTP POST `/enqueue`** (map live webhook fields to the
  contract: `invocation_type=explicit_mention`; pass `triggered_by`/`reviewer_user_id`/
  `triggering_comment_id`/`triggering_comment_text` through `payload`); **ELSE** → the existing
  `Run Agent Spine` `executeWorkflow` fallback. Re-export the JSON + `check-workflow-drift.mjs`.
- **DoD:** webhook still < 200ms; flag on → @-mention processed **async via the queue** (one draft, no
  double-draft); flag off → synchronous fallback still drafts.

### Block 4 — Retry / backoff / dead-letter
- Wire `attempts` + custom `backoff` (60/300/900s) from config; a `failed` handler (only on final
  exhaustion) posts **CRITICAL** to the Alerts task **exactly once** via the reused intake, with
  `jobId` + last error in `details`.
- **DoD:** an exhausted job → one CRITICAL alert (verify `alerts-since.mjs`); retryable vs
  non-retryable behave per §14.5.

### Block 5 — Monitoring + dead-man's-switch + config refresh
- **Queue-depth monitor** (`n8n/workflows/queue-depth-monitor.json`, 5-min cron): GET a new consumer
  **`/metrics`** (`queue.getJobCounts`) → alert on `queue.alert_depth_high`/`alert_depth_any`/
  `alert_failed` (keeps BullMQ-internal reads in the consumer — ADR-056 R4).
- **Consumer heartbeat dead-man's-switch:** consumer writes a Redis key (TTL) every minute; a host
  systemd timer (`infrastructure/systemd/consumer-heartbeat.{service,timer}` +
  `infrastructure/scripts/consumer-heartbeat-watchdog.sh`, mirroring ADR-046 disk-watchdog) checks it
  and POSTs the alert intake if stale beyond `queue.heartbeat_stale_s`.
- Add the 30–60s config refresh poll + the "restart required" WARN. Bull Board optional. Confirm AOF
  survives `docker restart n8n-redis` with no job loss.
- **DoD:** a killed consumer alerts within the heartbeat window; depth thresholds alert; queue
  survives a Redis restart.

### Block 6 — Burst scope-test + doc reconciliation
- **Scope-test:** ~50 due-date-style jobs paced under the Managed Agents cap (no 429/529 storms); an
  explicit job jumps the batch; runs idempotent; a forced failure dead-letters once. **Priority
  assertion:** one job of each of the 8 buckets while backed up → dequeue in rank order 1–8, and an
  automatic `Krytycznie ważne` waits behind an explicit `Niski`. **Negative config:** `concurrency` >
  `env_cap` and `lock_duration_ms` < floor → both clamp + WARN, never reach the queue.
- **Write-backs:** `current.md` §14.2 (→ BullMQ + thin consumer, **n8n stays in queue mode, BullMQ
  coexists by key prefix**), §14.3 (→ 8-level priority), §14.4 (Bedrock → Managed Agents limits),
  §14.5/§14.6, §15.7/§15.10; mark the queue **LIVE**. **Amend ADR-056** (flip Proposed→Accepted;
  correct the regular-mode line). `check-workflow-drift.mjs` clean.
- **DoD:** scope-test passes; docs reconciled; drift-clean.

## Files to create / modify

**Create:** `services/queue-consumer/{package.json, package-lock.json, app.mjs, Dockerfile,
.gitignore, README.md, docker-compose.snippet.yml}`; `supabase/migrations/045_queue_config.sql`;
`n8n/workflows/spine-http-ingress.json`; `n8n/workflows/queue-depth-monitor.json`;
`infrastructure/scripts/consumer-heartbeat-watchdog.sh`,
`infrastructure/systemd/consumer-heartbeat.{service,timer}`; `block-N-findings.md` per block (here).

**Modify:** `n8n/workflows/cu-webhook-producer.json` (Block 3; re-export, don't hand-edit live);
`n8n/docker-compose.yml` (add `queue-consumer`; reconcile to live after deploy);
`architecture/current.md` (§14, §15.7, §15.10); `architecture/decisions/056-queue-infrastructure-bullmq.md`.

**Reuse unchanged:** `Storage Watchdog Intake (v1)`, `Post Alert (v1)`, `agent_runs` + indexes, the
`config` table, `Agent Orchestrator (v1)` (fronted by the ingress, not modified).

## Verification (Definition of Done)

- **Per block:** trigger the real flow (`scripts/test-subworkflow.mjs` to drive the ingress / `curl`
  to `/enqueue` from inside `n8n-internal`); `scripts/inspect-execution.mjs <execId>` node-by-node;
  `scripts/alerts-since.mjs <minutes>` for unexpected WARN/CRITICAL; delete test `agent_runs` rows +
  disposable ClickUp tasks.
- **End-to-end (Block 3):** @-mention on a disposable task with `queue.enabled=true` → exactly one
  draft, job visible in `/metrics`, one completed `agent_runs` row; flip false → synchronous fallback
  still drafts.
- **Acceptance (Block 6):** the burst + priority + negative-config tests are the gate that catches the
  three silent-failure settings.

## Risks / red-team

- **Held-connection fragility (G2):** mitigated by the internal network (no nginx cap) + Block-0 proof;
  async-poll is the recorded fallback.
- **Double-draft** if `lock_duration_ms` ≤ max runtime or the idempotency check is skipped — guarded by
  the read-side clamp + Block-2 check + Block-6 negative test; none may be dropped.
- **Two Bull queues on one Redis:** safe via distinct prefix; monitored by the depth cron + heartbeat.
- **Silent-failure coverage (operator mandate):** dead consumer → heartbeat switch (B5); backlog →
  depth cron (B5); config mis-edit → clamp+WARN (B1); terminal job failure → DLQ CRITICAL (B4);
  spine-trigger infra failure → retryable throw → eventual DLQ. Each block's summary states which modes
  it covered.
