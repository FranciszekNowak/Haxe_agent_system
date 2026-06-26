# Block 1 findings — migration + consumer skeleton + fail-safe config reader (2026-06-26)

Block 1 lands the queue's foundations: the `config` seeds + write-side validation, the `queue-consumer`
service (enqueue path, priority, fail-safe reader, stub worker, health), and the hardened Spine HTTP
Ingress whose deterministic HTTP response will be the consumer's spine-result signal in Block 2. Every
Definition-of-Done item below is backed by a live run against the production stack, not assertion.

The stub worker only logs + completes — the **real processor (idempotency check → spine ingress await →
error classification) is Block 2**, retry/backoff/DLQ is Block 4, and the config refresh poll + the
"restart required" WARN are Block 5. Block 1 deliberately does not wire any producer to the queue (Block 3),
so the live @-mention path is unchanged and synchronous.

---

## What was built

### 1. Migration `045_queue_config.sql` (applied to `hkeslnosxibeuesxndnz`)
- Seeds all 14 `queue.*` knobs with the **Block-0-corrected** values (NOT the raw ADR amendment table):
  `concurrency=5`, `env_concurrency_cap=10` (G1), `max_runtime_ms=900000`, `spine_timeout_ms=1200000`,
  `lock_duration_ms=1500000` (G5), plus `enabled=true`, `retry_attempts=5`,
  `backoff_ms=[60000,300000,900000]`, `rate_limit_per_min=60`, `dedup_window_h=24`,
  `alert_depth_high=20`, `alert_depth_any=100`, `alert_failed=0`, `heartbeat_stale_s=120`.
  `queue.priority_high_impacts` is **not** seeded (retired by amendment 2026-06-23b — priority is
  contract-shape, a code constant).
- Adds `validate_queue_config()` + a `BEFORE INSERT OR UPDATE … WHEN (new.key LIKE 'queue.%')` trigger
  for **absolute** write-side bounds (the two-layer design: the trigger guards fat-fingers; the
  consumer's read-side clamp guards the runtime-derived invariants). Verified live: a garbage value
  (`queue.concurrency='notanint'`) is **rejected** by the trigger; `queue.concurrency='50'` (above the
  cap) is **allowed through** by design, so the read-side clamp+WARN can be exercised.

### 2. `services/queue-consumer/` (deployed to `/opt/haxe-agents/queue-consumer/`)
- `app.mjs`: BullMQ `Queue` **`agent-jobs`** with prefix **`haxeq`** (keys `haxeq:agent-jobs:*`, never
  colliding with n8n queue mode's `bull:*`); `POST /enqueue` (validates the job contract, computes the
  8-level priority, `queue.add` with `jobId` + an explicit `priority`); a **stub** Worker
  (`concurrency=C`, `lockDuration`, `maxStalledCount=1`, BullMQ limiter from `rate_limit_per_min`) that
  logs + completes; `loadQueueConfig()` (the fail-safe reader, `MARGIN=120000`); `GET /health`.
- Mirrors `services/zip-extractor/`: `package.json` (bullmq + ioredis + express, with committed
  `package-lock.json`), `Dockerfile` (node:20-slim), `.gitignore`, `.dockerignore`, `README.md`,
  `docker-compose.snippet.yml`. Container `queue-consumer` on `n8n-internal`, `expose:8080`,
  `mem_limit:256m`, `depends_on n8n-redis healthy`. Reads Supabase `config` via REST with the service
  key; **no ClickUp credentials**; alerts ride the reused Storage Watchdog Intake.
- **Deviation from the literal contract list (justified):** the consumer treats `idempotency_key` as
  optional and **derives the canonical `jobId` itself** as `${task_id}:${invocation_type}:${bucket}`,
  where `bucket = floor(enqueued_at / dedup_window_h)`. Reason: producers read **only** `queue.enabled`
  (ADR-056 "Single reader"), so they cannot compute the dedup-window bucket; making the consumer the
  authority keeps idempotency coherent. The other six contract fields (`task_id`, `caller_user_id`,
  `impact`, `invocation_type`, `enqueued_at`, `payload`) are required.

### 3. Spine HTTP Ingress (v1) hardened (`SQOkffGQhzMojrmN`, now **active**)
Resolves the Block-0 G2 finding (bare `responseMode:lastNode` returned HTTP 500 "No item to return" on a
*successful* run because the orchestrator's branchy terminal emits 0 items). New shape:
`Webhook(responseNode, onError:continueRegularOutput)` → `Execute Workflow (orchestrator,
onError:continueErrorOutput, alwaysOutputData:true)` → `Set "Build Outcome (completed)"` (success) /
`Set "Build Outcome (failed)"` (error) → `Respond to Webhook` (always HTTP 200). `alwaysOutputData`
guarantees the success branch carries ≥1 item even when the orchestrator returns 0 (the determinism
trap), so the Set always coalesces to one deterministic `{status, outcome, failure_kind,
clickup_task_id, warnings}` body. Business failures stay **200 + status**, not 5xx, so the consumer's
HTTP client / BullMQ don't auto-retry them. Validated (`n8n_validate_workflow` → 0 errors), exported to
`n8n/workflows/spine-http-ingress.json`, **drift-clean** (all 39 workflows match live). The real
end-to-end spine run through this ingress is exercised by **Block 2's** processor test (driving a real
spine here standalone would self-inflict the documented null-field alert cascade); the structure +
determinism guarantees are verified now.

---

## Definition of Done — live verification

| DoD item | Result |
|---|---|
| enqueue (curl from `n8n-internal`) → Worker picks up → logs → completes | ✅ `enqueued → stub_process → completed` for `qc-smoke-1:explicit_mention:…` (priority 3 = explicit+Średni, correct) |
| **by priority** | ✅ concurrency=1 + 4s stub delay, 6 buckets enqueued in reverse priority (8,7,6,4,3,2): pickup order **d8(8, in-flight), then e2(2), e3(3), e4(4), d6(6), d7(7)** — the waiting set drained strictly by priority, not FIFO. Proves explicit-before-automatic + impact-secondary. |
| config read at startup | ✅ startup log prints the full effective config; `/health` echoes `concurrency`, `lock_duration_ms=1500000`, `spine_timeout_ms=1200000`, `rate_limit_per_min=60` |
| out-of-bounds `queue.concurrency` clamps + WARNs | ✅ set `queue.concurrency=50`, restart → `[config][WARN] concurrency 50 out of [1,10] -> clamped to 10 (429-storm guard)`, effective `concurrency=10` |
| …and the WARN reaches the Alerts task | ✅ Post Alert (v1) execution **4053** carried `severity=WARN`, source/message containing `queue-consumer` + `concurrency 50` + `clamped`, via the reused Storage Watchdog Intake → Post Alert seam |
| contract validation | ✅ bad `impact` → 400; missing required field → 400 |
| idempotency dedup | ✅ second identical enqueue → `{"deduped":true}` |

After testing: `queue.concurrency` restored to **5**; the consumer recreated with `STUB_DELAY_MS=0` and
running at concurrency 5; **all `haxeq:*` test keys flushed** (0 remaining). No `agent_runs` rows and no
ClickUp tasks were created (the stub touches neither). n8n core unaffected (main up 2 days, worker 10
days, redis healthy).

---

## Silent-failure modes covered by Block 1

- **Config mis-edit → silent double-draft / 429s:** the fail-safe reader clamps the three invariants
  (`concurrency ≤ env_cap`; `lock_duration_ms ≥ max_runtime_ms+MARGIN`; `spine_timeout_ms ≤
  lock_duration_ms−MARGIN`) and **WARNs to the Alerts channel** on every clamp (verified end-to-end). A
  bad edit degrades to a safe value + an alert, never a silent break — the same discipline as
  `config.agent_lane`.
- **Garbage config value:** rejected at the write side by the validating trigger (immediate feedback).
- **Unset BullMQ priority breaking order:** `/enqueue` always sets an explicit 1..8 priority.
- **Enqueue failure going unnoticed:** `/enqueue` posts a CRITICAL alert on a `queue.add` failure
  (side-channel; the request still returns 500).
- **Ingress returning a misleading HTTP status:** the deterministic Respond terminal (200 + status
  field) removes the Block-0 false-500-on-success and the false-success-on-0-items.

**Knowingly deferred (not silent gaps, scheduled):** a dead consumer (Block 5 heartbeat dead-man's-switch),
backlog depth (Block 5 depth cron), terminal job failure → DLQ CRITICAL (Block 4). The stub worker
cannot fail in a way that needs DLQ yet (it always completes).

---

## Operational notes / carry-forward

- **VPS link was intermittently flapping** during this block (SSH port 22 and public 443 both dropped for
  ~2–3 min windows, several times; the box itself stayed healthy — `n8n-main`/`-worker` uptimes
  unbroken). All deploy/verify steps were completed inside stable windows; no work was lost. Worth a
  glance at the host/network if it recurs. `n8n-redis` shows ~1h uptime (a restart unrelated to this
  block; AOF is on, no data loss).
- **`STUB_DELAY_MS` test hook** (`${STUB_DELAY_MS:-0}`, default 0) was added to the `queue-consumer`
  compose env so the priority-order test is reproducible; it is inert in production. Block 2 replaces
  the stub, so this hook goes away with it.
- **Live env additions:** `/opt/haxe-agents/.env` gained one additive line `ALERT_INTAKE_KEY=…` (the
  reused Storage Watchdog key); `docker-compose.yml` gained the `queue-consumer` service. Both backed up
  (`*.bak-adr056`). `SPINE_INGRESS_URL` + `ALERT_INTAKE_URL` are inlined in the compose (non-secret
  internal topology).
