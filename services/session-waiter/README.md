# session-waiter (ADR-066)

External async waiter for the Haxe **managed-agent** lane. Decouples an Anthropic Managed-Agents
session's wall-clock from any single n8n execution so a long task (the 2026-06-30 `.pptx` run, ~21 min)
can run to completion: today the session is polled inside one n8n Code node bounded by an 840 s soft
deadline under n8n's ~900 s per-node kill, so n8n abandons the still-running remote session and the real
answer is never consumed. This always-on Node service holds the session, services client-side tools, and
calls n8n back by webhook when the agent delivers — no node cap, no recursion-depth limit, arbitrary
runtime.

Mirrors `services/queue-consumer/` (ADR-056) and `services/zip-extractor/` (ADR-058): tiny always-on
Node service on the `n8n-internal` network, no public port, built on the VPS via the stack
`docker-compose.yml`, reachable internally at `http://session-waiter:8080`.

## Build status (block-by-block)

- **Block 4 (this) — skeleton.** `/health` (liveness for the n8n dead-man's-switch), `/handoff`
  (validate + persist a `waiter_sessions` row, return 202 — defines the Block-5 receiving contract and
  populates the store the freshness reconciliation check watches), structured JSON logging with secret
  **redaction** (the managed Anthropic key arrives in the handoff body per A6 and is never logged or
  persisted), the reused alert seam, graceful shutdown, crash self-alert. **No event loop yet** — a
  persisted handoff sits `handed_off` and is (correctly) caught by the freshness CRITICAL after the
  threshold. Nothing calls `/handoff` in production yet: the orchestrator split (Block 5) is gated behind
  `config.session_waiter.enabled`, seeded `false`.
- **Block 5 (next) — orchestrator split.** `agent-orchestrator.json` creates the session + sends the
  first message, then POSTs carry-state to `/handoff` and returns (no long hold). Behind the flag.
- **Block 6 — event loop.** Open SSE (`GET /v1/sessions/{id}/events/stream`) / long-poll; truth =
  `GET /events` dedup-by-id; reconnect + reconcile on stream close. Service client tools
  (`get_task_*`/`list_attachments`/`get_attachment`/`extract_clickup_task`) by delegating to the n8n
  tail/extract handlers, POST `user.custom_tool_result`, capture `deliver_output`, POST the finish
  callback. Always resolve a pending tool (deadlock guard). Re-derives the managed key from
  `public.get_anthropic_key()` rather than storing it.
- **Block 7 — finish-callback half in n8n.** HTTP-triggered sub-workflow: enumerate produced docs +
  cost + render + post (+ the Block 1 non-delivery guard). Idempotent on `session_id`.
- **Block 8 — cutover + reliability.** Flip `config.session_waiter.enabled=true`; verify the
  reconciliation cron + health monitor; finalize ADR-066.

## Endpoints

- `GET /health` — `200 { ok, service, version, uptime_s, active_sessions }`. Cheap liveness (no DB
  round-trip on the ping path — a wedged Supabase must not make a live waiter look dead). Pinged by the
  **Session Waiter Health Monitor (v1)** dead-man's-switch.
- `POST /handoff` — body `{ session_id (req), clickup_task_id, triggering_comment_id, caller_user_id,
  agent_id, model_id, surface, surface_ref, impact, deadline_at?|absolute_budget_ms?, anthropic_key?
  (redacted, not stored), ...carry-state }`. `202 { ok, session_id, persisted, processed:false }` on
  persist; `400` on a bad contract; `500` on a persistence failure (also fires a CRITICAL alert).

## Reliability seam (ADR-066 / CLAUDE.md)

A new always-on service is a new failure surface (a crashed/wedged waiter orphans running sessions
**silently**). Two proactive checks, both routed through `Post Alert (v1)`:

1. **Health dead-man's-switch** — `Session Waiter Health Monitor (v1)` pings `GET /health` on a schedule;
   a non-2xx / unreachable waiter → **CRITICAL** (`session-waiter/health`).
2. **Handed-off-but-not-finished freshness check** — `Session Waiter Freshness Monitor (v1)` calls
   `public.check_stuck_waiter_sessions()` on a schedule; any `waiter_sessions` row still
   `handed_off`/`running` past `config.session_waiter.stuck_after_minutes` → **CRITICAL**
   (`session-waiter/freshness`). Reactive layer: the global `Error Handler (v1)` is the `errorWorkflow`
   on both monitors.

## Environment

| var | purpose |
|---|---|
| `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` | read/write `waiter_sessions`, read `config` via REST (service_role bypasses RLS) |
| `ALERT_INTAKE_URL`, `ALERT_INTAKE_KEY` | reused Storage Watchdog Intake (header-auth) → Post Alert (v1) |
| `N8N_BASE_URL` (`http://n8n-main:5678`) | internal base for the Block-6/7 finish callback + tail/extract tool handlers |
| `ANTHROPIC_API_BASE` / `ANTHROPIC_VERSION` / `ANTHROPIC_BETA` | Anthropic Sessions API surface (defaults baked; used by the Block-6 loop) |
| `PORT` (`8080`) | listen port |

The managed Anthropic key is **not** an env var (A6): it is handed at handoff and, in Block 6, re-derived
from `public.get_anthropic_key()`. No ClickUp credentials. Do not touch `.env` beyond the already-present
reused values.

## Local notes

`docker compose up -d --build session-waiter` builds on the VPS (`npm install` inside the image). The
committed `package-lock.json` pins versions; `app.mjs` is the only source file.
