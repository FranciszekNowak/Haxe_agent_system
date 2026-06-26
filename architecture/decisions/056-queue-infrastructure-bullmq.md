# ADR-056: Queue infrastructure (BullMQ application queue + thin consumer)

Status: Proposed (flip to Accepted on commit)
Date: 2026-06-23
Depends on: ADR-053 (Managed Agents lane, rate limits, `config.agent_lane` failover flag), ADR-054 (caller-scoped retrieval: the job carries `caller_user_id`), ADR-055 (image MCP runtime sets max spine duration; self-hosted-service pattern)
References: ADR-035 (sole `agent_runs` writer, idempotency source), ADR-043 (PD-blind), ADR-046 (host systemd dead-man's-switch pattern), ADR-047 (retry/backoff discipline, 529 handling)
Touches: `current.md` §14 (Queue infrastructure), §15.10 (producers), §15 (Agent Spine)

## Decision (verdict first)

Use **BullMQ** as the application-level job queue on the existing Redis. A **thin Node consumer service** (beside or co-located with the ADR-055 image MCP service) exposes an `/enqueue` endpoint for producers and runs a BullMQ **Worker** that dequeues by priority, enforces concurrency and idempotency, triggers the existing **n8n Agent Spine** over its REST/webhook interface, and owns retry-with-backoff and dead-letter. Producers (n8n webhook + crons) enqueue and return 200 in under 200ms. **n8n stays in regular mode** (not queue mode). The first build is scoped to the load-bearing subset; per-integration token buckets and n8n queue mode are deferred.

## Context

`current.md` §14 specifies four needs: rate limiting, decoupling, priority scheduling, retry-with-backoff. It names "n8n queue mode" as the stack (§14.2) but then specifies priority lanes (§14.3), per-integration token buckets (§14.4), and a 1/5/15-minute-to-dead-letter retry policy (§14.5). **n8n queue mode cannot deliver §14.3 to §14.5.** n8n queue mode is itself BullMQ wired to distribute n8n executions, but it exposes only execution distribution and a concurrency cap: no per-job priority, no token-bucket rate limiting, no custom backoff-to-DLQ. So the priority/rate-limit/retry semantics require an application-level queue regardless. Using BullMQ directly gives the full §14 spec as configuration rather than as code to hand-roll.

Current baseline (§15.10): the webhook path calls the spine **synchronously**. The producer/consumer split is unbuilt. This ADR builds it from that synchronous baseline.

One decisive constraint from ADR-053: the live lane is Anthropic Managed Agents (global), not Bedrock. §14.4's "Bedrock 50/min" is stale. The binding limits are now Managed Agents: 60 create-session RPM, 600 other RPM, 5 concurrent environments, plus ITPM/OTPM. At five-person volume the **concurrency cap is the primary control** and keeps every per-integration limit slack, so per-integration token buckets are premature.

## Decision detail

1. **Topology.** Existing Redis container (AOF on). One BullMQ queue `agent-jobs`. One consumer service with two responsibilities: an `/enqueue` HTTP endpoint (producers call it) and a BullMQ Worker (processes jobs). n8n runs regular mode; the spine is invoked by the Worker.

2. **Producers enqueue, never process.** ClickUp status/field webhook, daily due-date cron, `@`-mention/`~command` webhook, and the Gmail watcher build a job and `POST /enqueue`, then return 200 in under 200ms. The synchronous spine call is removed from producers. The queue absorbs bursts, so the §15.10 staggered ~5s enqueue delays are dropped (the queue paces).

3. **Consumer triggers the spine and awaits completion.** The Worker processor: idempotency check, then call the n8n spine and await its result with a timeout below `lockDuration`. The job's lifetime equals the spine run, so BullMQ concurrency = in-flight spine runs = the real concurrency control, and success/failure is known for retry and DLQ. Fire-and-forget is rejected (R6): it would mark the job done while the spine runs detached, breaking retry semantics.

4. **Concurrency and rate limit.** Worker `concurrency = C`, where C respects the Managed Agents environment-concurrency limit (capability gate G1). Conservative default C = 5. An optional BullMQ global `limiter` (~60 jobs/min) mirrors the create-RPM ceiling, but concurrency is the primary lever. Per-integration token buckets (§14.4) deferred (R5).

5. **Priority, two bands now, extensible to §14.3 later.** `HIGH` if the invocation is explicit (`explicit_mention`/`explicit_command`) **or** impact ∈ {Wysoki, Krytycznie ważne}; `NORMAL` otherwise. BullMQ priority: lower number = higher priority, so HIGH = 1, NORMAL = 5. The full §14.3 1/5/10-plus-boost scheme is computable from the same fields later without rework. The one binding case today: an interactive pull arriving while the overnight batch drains must jump it.

6. **Retry, backoff, dead-letter (§14.5).** `attempts = 5`, custom `backoff`: attempt 2 → 60s, 3 → 300s, 4 → 900s; attempt 5 exhausted → `failed` → DLQ handler posts to the Agent Errors task. **Error classification in the Worker:** 5xx / timeout / 429 / 529 / network → throw retryable (BullMQ retries per backoff, per ADR-047). 4xx (except 429) / validation / business-logic → throw BullMQ `UnrecoverableError` (skip remaining attempts → straight to DLQ), implementing §14.5's "4xx → dead-letter immediately."

7. **Idempotency (no double-draft).** `jobId = idempotency_key` (`${task_id}:${invocation_type}:${dedup_window}`) so a duplicate enqueue is ignored while the job exists. Inside the Worker, before triggering the spine, run the existing ADR-035 check (completed `agent_runs` row for this task+invocation in the dedup window); if found, succeed as a no-op. This guards the retry-after-partial-completion case (spine completed but the job was marked failed by a later error → retry sees the completed run and skips).

8. **Lock duration exceeds max spine runtime.** Image generation can take ~170s (ADR-055) and a managed-agent session runs minutes. Set Worker `lockDuration = 600000` (10 min), `maxStalledCount = 1`. The Worker's spine-call timeout is set below that (~9 min) so a genuinely slow run fails the job (and retries) rather than BullMQ declaring it stalled and re-running a healthy job (double-draft).

9. **Failover / rollback (de-risks cutover).** A `config.queue_enabled` flag (default true). If false, or if `/enqueue` is unreachable, producers fall back to the **synchronous spine call** (the current path), which stays in n8n and git, re-enableable. Mirrors the ADR-053/055 failover discipline. Flip the flag to cut over; flip back if the queue misbehaves.

10. **Monitoring + dead-man's-switch.** (a) Queue-depth cron every 5 min reads BullMQ counts (waiting/active/delayed/failed) → alerts to Agent Errors on §14.6 thresholds (HIGH waiting > 20, any waiting > 100, failed > 0). (b) Consumer **heartbeat dead-man's-switch**: the consumer writes a heartbeat (Redis key with TTL, or a timestamp file) every minute; a **host systemd timer** (mirroring ADR-046, external to n8n) alerts if the heartbeat goes stale. Depth alone misses a dead consumer when no new jobs arrive. (c) Bull Board (optional) for the §16.2 weekly queue-health metrics.

## Job contract (stable interface)

```jsonc
{
  "task_id": "string",                 // ClickUp task id
  "caller_user_id": "string",          // triggering user; ADR-054 scoping binds the session to this
  "impact": "Niski|Średni|Wysoki|Krytycznie ważne",
  "invocation_type": "autonomous_webhook|due_date|explicit_mention|explicit_command|email|weekly_proposer",
  "priority": 1,                        // 1 = HIGH, 5 = NORMAL (derived per decision detail §5)
  "idempotency_key": "string",         // `${task_id}:${invocation_type}:${dedup_window}`; also the BullMQ jobId
  "enqueued_at": "ISO8601",
  "payload": {}                         // minimal extras: comment_id (replies), command_name (~command), etc.
}
```

The consumer→spine call passes this through; the spine reads `caller_user_id` for ADR-054 scoping and `impact` for ADR-053 model-tier routing.

## Rejected alternatives

- **R1. n8n queue mode only.** Cannot deliver priority (§14.3), token buckets (§14.4), or the custom backoff-to-DLQ (§14.5); silently downgrades the documented design. May be added later, orthogonally, for n8n execution scaling, but it is not the application queue.
- **R2. Hand-roll priority/rate-limit/retry on raw Redis.** Reinvents BullMQ; blows the budget; the atomicity, visibility-timeout, and crash-safety bugs are exactly what BullMQ already solved.
- **R3. Run BullMQ and n8n queue mode together.** Two Bull queues on one Redis: redundant and confusing at this scale. Pick one (BullMQ); n8n stays regular mode.
- **R4. Producers add to BullMQ via the n8n Redis node directly.** Fragile against BullMQ's internal Redis structure. Use the `/enqueue` endpoint so all BullMQ interaction lives in one codebase.
- **R5. Per-integration token buckets now.** Premature; C = 5 keeps every per-integration limit slack. Add only if a specific integration 429s.
- **R6. Fire-and-forget spine trigger.** Breaks retry/DLQ (job completes while the spine runs detached). The Worker must await spine completion.

## Capability gates (Block 0 — resolve before building)

- **G1. Environment-concurrency semantics.** Do managed-agent sessions share a pooled environment (C may exceed 5, bounded by create-RPM and token limits) or need one each (C ≤ 5)? Resolve against ADR-053 / Anthropic docs. Sets C.
- **G2. Consumer→spine call shape.** Can the n8n spine be invoked synchronously and return its result over a multi-minute call (webhook response-mode), or must the Worker poll an execution-status endpoint? Determines the await mechanism.
- **G3. Immediate-200 safety.** Confirm no current consumer of the webhook path depends on a synchronous spine result (it should not, async is the goal).
- **G4. Versions.** BullMQ ↔ Redis version compatibility on the existing container; AOF enabled.
- **G5. Max spine runtime.** Measure the longest real run (image-heavy) to set `lockDuration` and the spine-call timeout.

### Capability gates — RESOLVED (Block 0, 2026-06-26)

Full evidence in `architecture/Build plans/adr-056-queue-infrastructure-bullmq/block-0-findings.md`. Summary, with the changes Block 1 must apply:

- **G1 — pooled environment.** Managed-Agents *environments* are reusable templates; each session gets its own container, scaled by Anthropic. The "5 concurrent" limit is on the Environments *resource-endpoint* group, **not** running sessions; the live system uses a single shared `managed_agent_environment_id`. So **C is not capped at 5** — it is bounded by create-session RPM (300/min) + ITPM/OTPM, both slack at our scale. Keep **C = 5** (conservative); set `queue.env_concurrency_cap = 10` as a software safety-rail (not a hard platform limit). Validate empirically in Block 6 before raising C.
- **G2 — held connection proven; return-contract must be hardened.** A `responseMode: lastNode` webhook called over the internal Docker network (`http://n8n-main:5678`, bypassing nginx's 300s cap) holds a multi-minute synchronous connection in queue mode: a side-effect-free probe held **330s** and returned `200`; a real spine run completed and posted a reply through the same held connection. **However, a fully-successful run returned `HTTP 500 "No item to return was found"`** (the orchestrator's branchy terminal emitted 0 items — the n8n sub-workflow-return-determinism trap). The 500 came only from bare `lastNode` letting n8n pick the return node by accident — **Block 1 makes the ingress HTTP response the authoritative, deterministic signal** by adding an explicit terminal that returns the orchestrator's own outcome (`Call Execute Agent Session` already yields `{status, failure_kind, outcome, warnings}`): `Webhook(responseNode) → Execute Workflow(orchestrator, onError:continueErrorOutput) → Set(coalesce to ONE item: {status, outcome, failure_kind, clickup_task_id, warnings}) → Respond to Webhook`. Consumer classification reads that response — transport error/timeout/genuine n8n 5xx → retryable infra (ADR-047); `200 status=completed` → done; `200 status=failed` → `UnrecoverableError` → DLQ. Keep business failures as **200 + status** (not HTTP 5xx) so the client/BullMQ don't auto-retry them. `agent_runs` is **not** used to judge the result — it keeps only its ADR-035 pre-trigger idempotency role (which also covers the connection-drops-after-write edge: retry → idempotency skip). This refines §3/§6 (classify infra by transport, business outcome from the structured response). Async-poll fallback **not needed**. (Live workflow `SQOkffGQhzMojrmN`, deactivated, awaits this in Block 1.)
- **G3 — confirmed.** CU Webhook Producer is `responseMode: onReceived`; nothing depends on a synchronous spine result.
- **G4 — confirmed.** Redis 7.4.9 (BullMQ needs ≥6.2); AOF on (`appendonly yes`, `appendfsync everysec`) and a sentinel key **survived `docker restart n8n-redis`** with n8n reconnecting cleanly.
- **G5 — measured; §8 / amendment defaults corrected.** Longest real run **872s** (the managed session's internal **840s deadline** + ~32s orchestrator overhead; the session self-terminates with a partial, so this is the ceiling). The §8 / amendment-table defaults `lock_duration_ms=600000` and `spine_timeout_ms=540000` are **both below this real ceiling** and would cause double-drafts (stalled-job re-run; premature consumer abort). **Block 1 seeds instead** (operator-confirmed: a single n8n spine execution can run up to **15 min** as a normal case, so both caps sit a full 5/10 min above it; MARGIN=120000): `queue.max_runtime_ms=900000` (15 min), `queue.spine_timeout_ms=1200000` (20 min), `queue.lock_duration_ms=1500000` (25 min) — preserving `concurrency ≤ env_cap`, `lock_duration ≥ max_runtime+MARGIN`, `max_runtime < spine_timeout < lock_duration−MARGIN`.

## Build sequence (blocks)

- **Block 0 — Capability gates.** Resolve G1 to G5. DoD: C chosen, spine-call shape chosen, max runtime measured, versions confirmed, AOF on.
- **Block 1 — Consumer skeleton.** Node service: BullMQ queue `agent-jobs`; `/enqueue` (validate the job contract, `queue.add` with `jobId = idempotency_key` and `priority`); Worker with `concurrency = C`, `lockDuration`, `maxStalledCount = 1`; stub processor. DoD: enqueue → Worker picks up by priority → logs → completes. **✅ done 2026-06-26** (`block-1-findings.md`): `services/queue-consumer/` deployed; migration `045_queue_config.sql` seeds the **Block-0-corrected** G1/G5 values (`env_concurrency_cap=10`, `max_runtime_ms=900000`, `spine_timeout_ms=1200000`, `lock_duration_ms=1500000`) + a write-side validating trigger; `idempotency_key`/`jobId` is **consumer-derived** (`${task_id}:${invocation_type}:${floor(enqueued_at/dedup_window_h)}`) since producers read only `queue.enabled`; the hardened Spine HTTP Ingress returns a deterministic 200 outcome. Clamp+WARN verified end-to-end (`concurrency=50`→10, alert delivered).
- **Block 2 — Processor.** Idempotency check (ADR-035 `agent_runs`); call spine and await (timeout < lockDuration); error classification (retryable vs `UnrecoverableError`). DoD: real spine run from a queued job; idempotent skip verified; forced 4xx → no retry; forced 5xx → retries on the backoff schedule. **✅ done 2026-06-26** (`block-2-findings.md`). Two implementation facts worth recording: (1) the idempotency check matches `agent_runs.triggered_by` (= the job's `invocation_type`, e.g. `explicit_mention`), **not** `agent_runs.invocation_type` — that column is the coarse `autonomous|explicit|conversation_reply` CHECK set, so the job's queue-vocabulary `invocation_type` maps to `triggered_by`; correspondingly the value the consumer sends the ingress as `invocation_type` is the *spine* vocabulary (`explicit`), derived by the consumer, because sending `explicit_mention` there would violate that CHECK and break the spine's own run insert. (2) The held connection uses **`node:http`, not global `fetch`** — undici's default ~300s `headersTimeout` would abort a healthy ≤15-min held run (G5) as a false transport error; `node:http`'s socket-inactivity `timeout` set to `spine_timeout_ms` is the only timer. A failed idempotency read throws **retryable** (never proceed blind → double-draft). `attempts`+custom backoff (60/300/900s) were wired here so classification is demonstrable; the terminal DLQ CRITICAL alert remains Block 4.
- **Block 3 — Producer cutover.** Switch the webhook, due-date cron, and `@`-mention paths from synchronous spine call to `/enqueue` + immediate 200, behind `config.queue_enabled` with synchronous fallback. DoD: webhook returns < 200ms; job processed async; flag-off falls back to the synchronous path. **✅ done 2026-06-26** (`block-3-findings.md`). Scoped to the one live producer (`CU Webhook Producer`); the due-date cron + Gmail + status/field producers remain Phase-3/unbuilt and adopt this `/enqueue` contract when built. Two facts worth recording: (1) **the consumer dedup was made invocation-class-aware** here, because the as-built single-`dedup_window` design would have silently dropped follow-up @-mentions on a task for ~24h — explicit jobs now key the `jobId` on the **triggering comment id** (`${task_id}:${invocation_type}:c${comment_id}`) so each distinct mention is its own job, and their pre-trigger `agent_runs` check runs **only as a retry-after-partial guard** (on `attemptsMade>0`, bounded to runs created after the job's `enqueued_at`); autonomous jobs keep the time-bucket `jobId` + `dedup_window_h` window. This needed no `agent_runs` schema change (the producer's permanent `Claim Comment` PK already guarantees one enqueue per comment). (2) The producer puts **two distinct comment ids** in the job: `payload.triggering_comment_id` = the **thread-root** (the spine's reply target, single-level threads) and `payload.dedup_comment_id` = the comment's **own** id (the consumer's dedup key) — conflating them would re-collapse in-thread follow-ups. Impact is fetched by the producer from the `[AI] Wpływ` field (`55c7ff79…`, default `Średni`). DoD verified live end-to-end (two distinct mentions both drafted; same-comment re-enqueue deduped; real tag-op webhook → enqueue → spine → reply; flag-off → synchronous draft, no enqueue).
- **Block 4 — Retry/backoff/DLQ.** Custom backoff (60/300/900s), `attempts = 5`; `failed` handler posts to Agent Errors exactly once. DoD: exhausted job lands in Agent Errors once; retryable vs non-retryable behave per §14.5. **✅ done 2026-06-26** (`block-4-findings.md`). Backoff/`attempts`/classification were wired in Block 2; Block 4 added the **terminal dead-letter alert** to `worker.on('failed')`, gated on `err instanceof UnrecoverableError || job.attemptsMade >= job.opts.attempts` so the per-attempt BullMQ `failed` event fires CRITICAL **exactly once** — on the dead-letter, never on a retryable interim failure. The BullMQ `failed` set (`removeOnFail` age 24h) is the DLQ store; this handler is its alarm. DoD verified live on the isolated `agent-jobs-test` queue (no real spine): a 404 → non-retryable → 1 CRITICAL; an unreachable target with per-job `attempts:2` → interim attempt no alert, exhaustion → 1 CRITICAL; `alerts-since.mjs` confirmed 2 CRITICAL / 0 WARN total (not 3).
- **Block 5 — Monitoring + dead-man's-switch.** Queue-depth cron alerts (§14.6 thresholds); consumer heartbeat via host systemd timer (mirror ADR-046); Bull Board optional; confirm AOF survives a Redis restart. DoD: a killed consumer alerts within the heartbeat window; depth thresholds alert; queue survives Redis restart with no job loss. **✅ done 2026-06-26** (`block-5-findings.md`; design in the Block-5 amendment below). Consumer `GET /metrics` (BullMQ `getJobCounts` + a consumer-**computed** alert), the 5-min `Queue Depth Monitor (v1)` (`M48svwpdhDg8l6An`) cron, the host `consumer-heartbeat.timer` dead-man's-switch (Redis TTL key + `consumer-heartbeat-watchdog.sh`, reusing the ADR-046 `watchdog.env`/intake), and the 45s config-refresh poll. DoD verified live: 100 delayed jobs → `/metrics` CRITICAL flood → cron posted one CRITICAL (manual run + the scheduled tick) → cleared on removal; a stopped consumer let the heartbeat key expire → the host watchdog fired CRITICAL within the window → clean restart; AOF confirmed enabled (Block 0 G4 already proved live restart-survival). Bull Board not added (deferred — `/metrics` + the cron cover the operator need). The config-refresh poll's live concurrency-apply + "restart required" WARN are deployed and verified-by-construction (the interval mechanism is proven by the heartbeat timer rewriting its key after restart; `loadQueueConfig` is the proven startup reader); a shared-config live mutation test was left for explicit operator authorization.
- **Block 6 — Burst scope-test + doc reconciliation.** Enqueue 50 due-date tasks: paced under the Managed Agents cap (no 429/529 storms), an interactive job jumps the batch, runs are idempotent, a forced failure dead-letters once. Update `current.md` §14.2 (stack → BullMQ + thin consumer, n8n regular mode) and §14.4 (Bedrock → Managed Agents limits), mark the queue LIVE. DoD: scope-test passes; `current.md` reconciled; drift-clean.

## Consequences

- **Delivers the full §14 spec as configuration**, not hand-rolled code: priority, concurrency, rate limiter, retry-with-backoff, DLQ, all from a Lindy library.
- **One new always-on service** (the consumer), mitigated by co-locating with the ADR-055 image MCP service and guarded by a heartbeat dead-man's-switch. This is the accepted cost.
- **Cutover is reversible** via `config.queue_enabled` + the retained synchronous path, so a misbehaving queue degrades to today's behavior rather than blocking work.
- **Accepted deferrals:** per-integration token buckets (concurrency cap suffices now), n8n queue mode (orthogonal, redundant at this scale), full 1/5/10 priority granularity (two bands cover the one binding case).
- **Correctness depends on three settings not being skipped:** `lockDuration` > max runtime, the idempotency check before spine trigger, and C set from the real environment-concurrency semantics. Each silently causes double-drafts or 429s if wrong; Block 6's scope-test is the acceptance gate that catches them.
- **Doc drift fixed:** §14.4's stale Bedrock limits are corrected to the Managed Agents limits in the same change.

## Amendment (2026-06-23) — runtime-tunable settings live in Supabase `config`

The queue knobs move into the existing Supabase `config` table so they are tunable without a code change. The load-bearing part is not the move, it is the **fail-safe reader**: three settings cause silent double-drafts or 429s if set wrong, so the reader **clamps them to safe bounds and WARNs**, exactly as `config.agent_lane` already fails safe to `bare` + WARN when unreadable. A bad edit degrades to a safe value plus an alert, never to a silent production break.

### Two tiers of config

- **Bound-defining (operator-set, rarely touched):** discovered from Block 0 gates, they define the safe bounds for the tunable tier. Not for casual editing.
  - `queue.env_concurrency_cap` (from G1) — the Managed Agents environment-concurrency ceiling.
  - `queue.max_runtime_ms` (from G5) — measured longest spine run; the `lock_duration` floor derives from it.
- **Tunable (edit freely in Supabase):** the operational knobs, each clamped to the bounds above at read time.

### Settings

| key (jsonb) | default | clamp / invariant | read by | applies |
|---|---|---|---|---|
| `queue.enabled` | `true` | — | n8n producers + consumer | live |
| `queue.concurrency` | `5` | `1 .. env_concurrency_cap`; clamp + WARN | consumer Worker | live (BullMQ dynamic `worker.concurrency`) |
| `queue.lock_duration_ms` | `600000` | `>= max_runtime_ms + MARGIN`; raise + WARN | consumer Worker | **restart** |
| `queue.spine_timeout_ms` | `540000` | `< lock_duration_ms - MARGIN`; lower + WARN | consumer processor | live (per job) |
| `queue.retry_attempts` | `5` | `1 .. 10` | consumer `/enqueue` | live (new jobs) |
| `queue.backoff_ms` | `[60000,300000,900000]` | length `= attempts-1`, each `>= 0` | consumer `/enqueue` | live (new jobs) |
| `queue.rate_limit_per_min` | `60` | `1 .. 60` (create-RPM) | consumer Queue limiter | **restart** |
| `queue.dedup_window_h` | `24` | `1 .. 168` | consumer `/enqueue` + processor | live |
| `queue.priority_high_impacts` | `["Wysoki","Krytycznie ważne"]` | subset of the impact enum | consumer `/enqueue` | live (new jobs) |
| `queue.alert_depth_high` | `20` | `>= 1` | monitor cron | live |
| `queue.alert_depth_any` | `100` | `>= 1` | monitor cron | live |
| `queue.alert_failed` | `0` | `>= 0` | monitor cron | live |
| `queue.heartbeat_stale_s` | `120` | `>= 30` | dead-man's-switch | live |

### Fail-safe reader (the load-bearing piece)

The consumer reads `queue.*` once, then refreshes on a poll (every 30 to 60s; Supabase Realtime is an optional upgrade). The reader is validating, not a dumb getter:

```
loadQueueConfig():
  raw  = SELECT key,value FROM config WHERE key LIKE 'queue.%'
  cfg  = DEFAULTS merged with raw            // missing/unparseable key → default + WARN
  cap  = cfg.env_concurrency_cap
  floor= cfg.max_runtime_ms + MARGIN
  cfg.concurrency      = clamp(cfg.concurrency, 1, cap)         ; if changed → WARN
  cfg.lock_duration_ms = max(cfg.lock_duration_ms, floor)        ; if raised  → WARN
  cfg.spine_timeout_ms = min(cfg.spine_timeout_ms,
                             cfg.lock_duration_ms - MARGIN)       ; if lowered → WARN
  return cfg
```

The three invariants the reader enforces, each a known silent-failure mode from this ADR: `concurrency <= env_cap` (or 429s), `lock_duration_ms >= max_runtime + MARGIN` (or stalled-job re-runs → double-drafts), `spine_timeout_ms < lock_duration_ms` (or BullMQ declares a healthy job stalled). WARNs ride the existing alert seam.

### Live vs restart (Pareto, no graceful-recreate machinery)

Most knobs are read at the moment of use, so they apply to new work within one poll interval. Two are set at Worker/Queue construction (`lock_duration_ms`, `rate_limit_per_min`) and a change needs a **service restart**, not a code change. They are set once from measurement and rarely touched, so live-reloading them (graceful Worker recreate) is not worth building. `concurrency` is the exception: it is construction-time in principle but BullMQ exposes a dynamic setter, so it stays live. On poll, if a restart-only value changed, the consumer WARNs "restart required to apply" rather than silently ignoring it.

### Single reader

The consumer service owns all `queue.*` reads (it computes job options at `/enqueue` and Worker settings at startup). n8n producers read only `queue.enabled`, to choose enqueue versus the synchronous fallback. This keeps one validating reader rather than two drifting copies.

### Validation in two layers

- **Write-side CHECK** on the `config` row for absolute sane bounds (for example `lock_duration_ms >= 60000`, `concurrency >= 1`), giving immediate feedback on an obviously bad edit.
- **Read-side clamp** (above) for the runtime-derived invariants a static CHECK cannot express (the `env_cap` and `max_runtime` bounds are discovered values, not constants).

### Build-sequence delta

Fold into the blocks: **Block 1** reads `queue.*` via the fail-safe reader at startup (not hard-coded constants) and seeds the `config` rows with defaults; **Block 5** adds the 30-to-60s refresh poll and the "restart required" WARN for construction-only values; **Block 6**'s scope-test adds a negative case: set `concurrency` above `env_cap` and `lock_duration_ms` below the floor, confirm both clamp + WARN rather than reaching the queue.

### Consequences

- The `config` table becomes a new failure surface (a bad edit), which is why the read-side clamp is mandatory, not optional: it is the same fail-safe discipline as `agent_lane`.
- Do not put contract-shape values (the job schema, the queue name, `jobId` derivation) in `config`. Those are invariants, not knobs; making them editable invites incoherent state. Config holds operational scalars only.
- Accepted: restart-only application for `lock_duration_ms` and `rate_limit_per_min`. Documented as a restart, not a code change, which satisfies the requirement without graceful-recreate complexity.

## Amendment (2026-06-23b) — full priority order: explicit primary, impact secondary

Supersedes decision detail §5 (the two-band HIGH/NORMAL scheme) and the §14.3 +1-boost scheme. Priority is now a single lexicographic key: **explicit vs automatic is primary, impact is secondary.** Explicit always outranks automatic, even explicit Niski over automatic Krytycznie ważne.

### The eight levels → BullMQ priority

| Rank | Invocation | Impact | BullMQ `priority` |
|---|---|---|---|
| 1 | explicit | Krytycznie ważne | 1 |
| 2 | explicit | Wysoki | 2 |
| 3 | explicit | Średni | 3 |
| 4 | explicit | Niski | 4 |
| 5 | automatic | Krytycznie ważne | 5 |
| 6 | automatic | Wysoki | 6 |
| 7 | automatic | Średni | 7 |
| 8 | automatic | Niski | 8 |

BullMQ uses lower number = higher priority, so the rank column is the priority value directly.

### Computation

```
is_explicit = invocation_type in {explicit_mention, explicit_command}
impact_rank = {Krytycznie ważne:1, Wysoki:2, Średni:3, Niski:4}[impact]
priority    = (is_explicit ? 0 : 4) + impact_rank        // → 1..8
```

Set at `/enqueue`, written to the job's `priority`. **Always set an explicit 1..8 value**: never enqueue a job with priority unset, because an unset BullMQ priority falls into a separate FIFO path and breaks the ordering. Within one bucket (same invocation and impact) ordering is FIFO by enqueue time, which is correct.

### Config note

The `queue.priority_high_impacts` key from the prior amendment is **retired**. Priority policy is contract-shape (a structural ordering decision), not an operational scalar, so it lives in code and changing it is an ADR-level decision, not a Supabase edit. This is consistent with the prior amendment's rule that `config` holds scalars, not contract shape. The impact-rank map is a fixed constant in code.

### Second-order effect (the one to watch, not to fix now)

Strict explicit-primacy means a steady stream of explicit jobs can starve automatic jobs: an automatic Krytycznie ważne waits behind every explicit job, including explicit Niski. This is defensible because explicit means a human is actively waiting (interactive latency matters to a person) while automatic is async (nobody is blocked), so the human-waiting case should win. It is safe at current scale: explicit volume is a few pulls a day, they clear in seconds, and workers free up for the automatic batch, so starvation does not bind. **Watch trigger:** if explicit volume ever rises enough to keep all workers saturated, automatic Krytycznie ważne starves. **Deferred mitigations (build only if the trigger fires):** reserve one worker for automatic, or add an age-based priority boost so a long-waiting automatic job escalates. Not built now (premature, inversion: do not pre-engineer a fairness mechanism for contention that does not exist yet).

### Build delta

Block 6's scope-test adds a priority-order assertion: enqueue one job of each of the eight buckets while the queue is backed up, confirm they dequeue in rank order 1 through 8, and confirm an automatic Krytycznie ważne does wait behind an explicit Niski (the intended, not accidental, behavior).

## Amendment (2026-06-26, Block 3) — dedup unit is invocation-class-aware (jobId derivation)

Supersedes the §7 / job-contract line `jobId = idempotency_key = ${task_id}:${invocation_type}:${dedup_window}` for **explicit** invocations. The single fixed `dedup_window` collapsed *all* same-task same-type jobs in one window into one job — correct for **autonomous** invocations (a cron must not reprocess a task twice within the window) but **wrong for interactive ones**: two distinct `@`-mentions on one task within 24h share `task_id` + `explicit_mention`, so the second silently never drafts (regression found in Block 3 before cutover). The dedup *unit* must depend on what a "duplicate" means for the source, and `@`-mention volume is the agent's bread-and-butter interactive case.

**Decision.** Make the dedup unit invocation-class-aware (still one consumer, one contract, one code path — only the key derivation forks):

- **Explicit** (`explicit_mention` / `explicit_command`): the unit is the **triggering comment**, not a time bucket. `jobId = ${task_id}:${invocation_type}:c${dedup_comment_id}` (the comment's **own** id, supplied by the producer in `payload.dedup_comment_id`). The pre-trigger `agent_runs` idempotency check becomes a **retry-after-partial guard only**: it runs solely on a retry (`attemptsMade > 0`), bounded to completed runs created **after** the job's `enqueued_at` (a completed run appearing post-enqueue on a retry is this job's own prior attempt that drafted then lost its held connection). On the first attempt the comment-keyed `jobId` is the sole dedup, so a distinct follow-up always drafts.
- **Autonomous** (`due_date`, `autonomous_webhook`, `email`, `weekly_proposer`): **unchanged** — `jobId = ${task_id}:${invocation_type}:${floor(enqueued_at / dedup_window_h)}` and the full `dedup_window_h` `agent_runs` window on every attempt.

**Why no `agent_runs` schema change.** `agent_runs` has no comment-id column, but it doesn't need one: the producer's permanent `Claim Comment` (`agent_webhook_dedup`, PK on the comment id, migration 018) already guarantees a given comment enqueues **at most once**, so the comment-keyed `jobId` only ever collapses a true duplicate enqueue of the same comment — the "same comment far apart" hole can't occur. The cutoff-by-`enqueued_at` retry guard distinguishes a retry-after-partial (completed run stamped *after* enqueue → skip) from a genuine follow-up (sibling run stamped *before* enqueue → no match → draft) without any new column.

**Producer carries two distinct comment ids** (do not conflate): `payload.triggering_comment_id` = the **thread-root** id (the spine's reply target; ClickUp threads are single-level), `payload.dedup_comment_id` = the comment's **own** id (the dedup key). Two mentions in one thread share a root but have distinct own-ids — keying dedup on the root would re-introduce the collapse.

## Amendment (2026-06-26, Block 5) — monitoring topology: where each silent-failure alarm lives

Block 5 wires the observability layer. The design choices below depart from the §14.6 "original" list (which named raw depth thresholds and a `Dead letter queue > 0` alarm) in ways worth recording, all driven by the reliability rules (no alert storms; the consumer is the single `queue.*` reader).

- **The depth/health alarm is COMPUTED IN THE CONSUMER, not the cron.** `GET /metrics` returns `getJobCounts()` **plus** a consumer-decided `alert` object (or `null`). The 5-min `Queue Depth Monitor (v1)` cron is therefore thresholds-free — it GETs `/metrics` and forwards a present alert to `Post Alert (v1)`. This keeps every `queue.*` read in the one fail-safe reader (the "Single reader" amendment / R4): the cron never reads `config`. A consumer-down/unreachable `/metrics` is the cron's own WARN branch (the *host heartbeat* owns the consumer-down CRITICAL).
- **Backlog alarm is TARGETED, not raw-depth — so the designed midnight burst doesn't false-alarm.** A raw `waiting > 20` WARN would fire on the very 50-task burst the queue exists to absorb. Instead: **CRITICAL** when `waiting + delayed ≥ alert_depth_any` (absolute flood, something is badly wrong); **WARN** when `waiting ≥ alert_depth_high` **and** `active === 0` (jobs queued but nothing draining = a wedged worker — a healthy burst has `active = concurrency`, so it cannot trip this). This makes the WARN mean "stuck," not "busy."
- **The failed-set alarm is EDGE-triggered, and Block 4 stays the primary.** The original `Dead letter queue > 0` is level-triggered; with `removeOnFail: { age: 86400 }` a single dead-letter would re-alarm every 5 min for 24 h — an alert storm. Block 4 already fires **exactly one CRITICAL per dead-letter** through the same seam. So `/metrics` only alarms (WARN) when the failed count **rises** vs the consumer's last read (a backstop for a lost Block-4 alert), never on the standing count. Baselined at startup to the current failed count so pre-existing dead-letters don't alarm on boot.
- **Heartbeat dead-man's-switch: staleness is encoded as the Redis TTL.** The consumer SETs `haxeq:consumer:heartbeat` with `EX = queue.heartbeat_stale_s`, refreshing every ~⅓-TTL. The **host** systemd watchdog (outside the container, so it survives the consumer dying — same independence principle as ADR-046) therefore only needs `redis-cli EXISTS` — no clock math, one knob governs both sides. It distinguishes two CRITICALs: Redis unreachable (`docker exec`/`redis-cli` failed) vs key absent (consumer dead/hung). It reuses the ADR-046 `watchdog.env` (`WATCHDOG_URL`/`WATCHDOG_KEY`) and the Storage Watchdog Intake — **no new secret, no new alert workflow**. Like the disk-watchdog, it `exit 1`s on a breach (so systemd marks the oneshot failed) *after* delivering the alert — the `ALERTED` log line, not the exit code, is the success signal.
- **Heartbeat cadence (revised 2026-06-26, operator request).** `heartbeat_stale_s` raised 120 → **300** and the host timer moved from 1-min to **5-min**. The cost asymmetry is the reason: the consumer's Redis `SET` is trivially cheap, but the watchdog's per-tick `docker exec n8n-redis redis-cli` spawns a process + enters a namespace, so the *timer* is the real recurring cost — slow it, not the write. Detection of a dead consumer is now ≈5–10 min (TTL 300 + up to one 5-min tick), which is fine for a durable queue (jobs just wait until restart). The consumer writes every ~100 s (`stale_s/3`), so a single missed write still can't expire the key (no false positive).
- **Config refresh poll — cadence is itself a config knob, default once/day (revised 2026-06-26, operator request).** New key `queue.config_refresh_s` (default **86400**; reader floors at 60 s, DB trigger bounds 60..604800). The original 45 s poll did ≈1,900 Supabase reads/day for almost no benefit — config edits are rare. The poll applies `concurrency` live (BullMQ's dynamic `worker.concurrency` setter); for the construction-only knobs (`lock_duration_ms`, `rate_limit_per_min`, read once at Worker build) it WARNs "restart required" instead of silently no-op'ing. Warnings are de-duplicated against the previous poll; the clamp logic is the same fail-safe reader used at startup. **Consequence to accept:** at a daily cadence the "live concurrency apply" lags up to a day — so for an *immediate* concurrency change the operator **restarts the consumer** (reads config at startup) or temporarily lowers `config_refresh_s`; the poll is a slow drift-catcher, not a live-tuning mechanism. The `config_refresh_s` and `heartbeat_stale_s` timers reschedule themselves on change (the new cadence takes effect on the next scheduled poll).
- **Bull Board deferred.** `/metrics` + the depth cron cover the operator's need (counts + alarms); a Bull Board UI adds an exposed surface for no current benefit. Revisit if manual queue inspection becomes routine.
