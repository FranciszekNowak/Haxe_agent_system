# queue-consumer (ADR-056)

BullMQ application queue + thin Node consumer for the Haxe agent pipeline. Producers `POST /enqueue`
and return immediately; a BullMQ **Worker** dequeues **by priority**, enforces concurrency (=
in-flight spine runs) and idempotency, triggers the n8n Agent Spine, and owns retry/backoff/dead-letter.

Mirrors `services/zip-extractor/` (ADR-058): tiny always-on Node service on the `n8n-internal`
network, no public port, built on the VPS via the stack `docker-compose.yml`.

## Build status (block-by-block)

- **Block 1 (this):** `Queue` + `/enqueue` (validate contract, compute 8-level priority, `queue.add`
  with `jobId`+`priority`), **stub** Worker (logs + completes), the **fail-safe config reader**,
  `/health`. Deployed and verified (enqueue → priority-ordered pickup → complete; out-of-bounds
  `queue.concurrency` clamps + WARNs to the Alerts task).
- **Block 2 (this):** real processor — `agent_runs` idempotency check (match `clickup_task_id` +
  `triggered_by` within `dedup_window_h`) → spine ingress await over a held `node:http` connection
  (`spine_timeout_ms`; **not** global `fetch`, whose ~300s `headersTimeout` would falsely abort a
  healthy 15-min run) → error classification (transport/timeout/5xx → retryable; `200 status=failed`
  / 4xx / unknown → `UnrecoverableError` → DLQ). `attempts` + custom backoff (60/300/900s) wired so
  classification is demonstrable; the terminal DLQ alert is Block 4.
- **Block 4:** retry/backoff (60/300/900s, attempts=5) + DLQ → one CRITICAL alert.
- **Block 5:** `/metrics` + depth cron, heartbeat dead-man's-switch, 30–60s config refresh poll +
  "restart required" WARN for construction-only values.

## Endpoints

- `POST /enqueue` — body: `{ task_id, caller_user_id, impact, invocation_type, enqueued_at, payload,
  idempotency_key? }`. Returns `200 { ok, jobId, priority, deduped }`, `400` on a bad contract, `500`
  on enqueue failure (also fires a CRITICAL alert).
- `GET /health` — `200` with the effective config + a Redis `PING`, else `503`.

## Priority (ADR-056 amendment 2026-06-23b)

`priority = (is_explicit ? 0 : 4) + impact_rank`, `impact_rank = {Krytycznie ważne:1, Wysoki:2,
Średni:3, Niski:4}`, `is_explicit = invocation_type ∈ {explicit_mention, explicit_command}`. Always
1..8, always set (an unset BullMQ priority breaks ordering). Explicit always outranks automatic; this
is contract-shape, a code constant — **not** a `config` knob.

## Idempotency

`jobId = idempotency_key = ${task_id}:${invocation_type}:${dedup_window}`, where `dedup_window` is the
time bucket `floor(enqueued_at / dedup_window_h)`. A duplicate enqueue within the window is ignored
while the job exists. The **consumer** derives this (producers read only `queue.enabled`), so a
producer-sent `idempotency_key` is advisory; the consumer's derivation is authoritative.

## Config (Supabase `config`, keys `queue.*`)

The consumer owns all `queue.*` reads via the **fail-safe reader** (`loadQueueConfig`): read once at
startup, clamp + WARN the three silent-failure invariants, default + WARN on any missing/unparseable
key. Defaults are the Block-0-corrected values (G1/G5). `MARGIN = 120000` ms.

| invariant | clamp | guards against |
|---|---|---|
| `concurrency ≤ env_concurrency_cap` (and ≥ 1) | clamp + WARN | 429/529 storm |
| `lock_duration_ms ≥ max_runtime_ms + MARGIN` | raise + WARN | stalled-job re-run → double-draft |
| `spine_timeout_ms ≤ lock_duration_ms − MARGIN` | lower + WARN | premature consumer abort → double-draft |

Restart-only values: `lock_duration_ms`, `rate_limit_per_min` (construction-time). `concurrency` is
live (BullMQ dynamic setter). The 30–60s refresh poll + the "restart required" WARN land in Block 5.

## Environment

| var | purpose |
|---|---|
| `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` | read `config` (and `agent_runs` in Block 2) via REST |
| `REDIS_HOST` (`n8n-redis`), `REDIS_PORT` (`6379`) | BullMQ Redis (shared with n8n queue mode; prefix `haxeq` isolates keys) |
| `QUEUE_NAME` (`agent-jobs`), `QUEUE_PREFIX` (`haxeq`) | queue identity |
| `SPINE_INGRESS_URL` | hardened Spine HTTP Ingress webhook (Block 2 processor) |
| `ALERT_INTAKE_URL`, `ALERT_INTAKE_KEY` | reused Storage Watchdog Intake (header-auth) → Post Alert |
| `STUB_DELAY_MS` | test-only: makes priority-ordered pickup observable (default `0`) |

No ClickUp credentials. Alerts ride the existing seam; the Alerts task is dropped by the producer's
own guard, so consumer alerts cannot loop.

## Local notes

`docker compose up -d --build queue-consumer` builds on the VPS (`npm install` inside the image). The
committed `package-lock.json` pins versions; `app.mjs` is the only source file.
