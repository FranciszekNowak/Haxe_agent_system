ADR-066: Asynchronous managed-agent session via an external "session waiter" service

Status: DRAFT (in progress — Blocks 4–8 of the adr-066-session-waiter master plan). Block 4 shipped the
service skeleton + reliability seam + this draft; **Block 5 (orchestrator split) shipped + verified live
2026-06-30** — the managed lane forks on `config.session_waiter.enabled` (seeded `false`): `mode='handoff'`
runs the front half then `POST /handoff` and returns (no key in the body — the waiter re-derives it), while
`mode='sync'` keeps today's poll loop. **Block 6 (waiter event loop) shipped + verified live E2E 2026-06-30**
— the waiter (`app.mjs` v1.1.0-block6) re-derives the key via `get_anthropic_key()`, long-polls `GET /events`
(porting `Poll Round`'s analysis), services client tools through the new `Session Waiter Tool Bridge (v1)`
(delegating to the SSOT tail/extract handlers), captures `deliver_output`, and POSTs the finish callback;
crash-recovery re-adopts in-flight rows on startup. A2 ≥30-min survival is baseline-GO (non-blocking). The
finish-callback half (7) and cutover (8) follow. Finalized at Block 8.

Context

A high-impact managed-agent task on 2026-06-30 ("build a .pptx about the Haxe agent system from my
ClickUp doc"; ClickUp task `869dxn3d8`, session `sesn_017tJw1dSoJXUyBK1HKmPxnj`) did the work correctly
but **never delivered its answer**. Root cause (the structural half — the doc-link and image-embedding
fixes are ADR-067 / Blocks 1–3): the managed session is polled inside a **single n8n Code node**
(`Execute Agent Session → Poll Round`) bounded by an absolute **840 s soft deadline**
(`Build Initial State → SOFT_DEADLINE_MS`), sitting under n8n's ~900 s per-node task-runner kill. After
the early context tools, all remaining work (image generation via the in-harness MCP, deck build, slide
QA) produced **no client-side tool calls**, so the held-poll loop never recursed — it sat in one node
until 840 s fired, returned `outcome='deadline'`, and set `output_message` to the agent's last mid-work
English narration. The orchestrator then published that narration as the answer. The agent's real
`deliver_output` fired ~7 min later — after n8n had already abandoned the still-running remote session —
with nothing left to consume it.

**The load-bearing structural fact:** raising 840 s cannot fix this. One Code node is capped at ~900 s,
so a 21-minute task can never be polled to completion inside a single n8n execution. The agent session
runs on Anthropic's side **independently of n8n** (proven: it kept working 7 min after n8n quit, the
`deliver_output` event still queryable). Therefore the fix must **decouple the agent's wall-clock from
any single n8n execution**, not stretch the execution.

Block 0 verified the capabilities this depends on (see `block-0-findings.md`): the Sessions API exposes
`GET /v1/sessions/{id}/events/stream` (SSE) + `GET /v1/sessions/{id}/events` (full history, dedup by id);
sessions stay queryable after the stream closes / goes idle; a tool result is posted from any external
process via `POST /v1/sessions/{id}/events` with `user.custom_tool_result`; the VPS already runs always-on
Node services (`queue-consumer`, `zip-extractor`) on `n8n-internal`; and the managed key is read from
`public.get_anthropic_key()`, not the stale bare-lane `.env` value.

Decision

Re-architect managed sessions from a **synchronous held-poll loop** (ADR-053/063 `Poll Round`) to an
**external always-on "session waiter" service** plus an n8n finish-callback, behind
`config.session_waiter.enabled` (the poll loop stays the live fallback until Block 8 verifies the waiter).

- **`session-waiter`** — a small always-on Node service on the VPS (`services/session-waiter/`, container
  on `n8n-internal`, `expose:8080` internal only; mirrors `queue-consumer`/`zip-extractor`). It holds one
  session at a time per handoff: opens the SSE stream (truth = `GET /events` dedup-by-id; reconnect +
  reconcile on stream close), services client-side tools by **delegating to the existing n8n tail/extract
  handlers** (anti-duplication — the handlers stay the single source of truth; the waiter only calls
  them), posts `user.custom_tool_result`, captures `deliver_output`, and POSTs an n8n **finish callback**
  when the agent delivers (or on terminal error / absolute-budget timeout). No node cap, no
  recursion-depth limit, arbitrarily long runs; it also relieves the ADR-056 ~15-min spine ceiling for
  managed tasks.
- **Orchestrator split (Block 5).** The front half (resolve agent/key → create session → send first
  message) stays in `execute-agent-session.json` as ONE copy — it is not duplicated into the orchestrator,
  because the managed key + agent/model + clickup_scope are resolved there and never surface to the
  orchestrator. A `mode` input forks the tail: `mode='handoff'` runs the front half then a new
  `Mode = handoff?` IF → `Build Handoff Output` returns `outcome='handed_off'` + carry-state (reusing the
  existing "alternative terminal via Merge Final" idiom, so the single-leaf return stays deterministic);
  `mode='sync'` keeps the synchronous poll loop. `agent-orchestrator.json` reads
  `config.session_waiter.enabled` (`Read Waiter Flag`), passes `mode` accordingly, and on a `handed_off`
  return routes (`Handoff?` IF) to `Post Handoff to Waiter` (`POST /handoff`) and **returns** — no long
  hold, no comment. `Set Status W trakcie` stays. The managed key is **not** sent in the handoff body (the
  waiter re-derives it via `get_anthropic_key()`, A6-minimal). Behind the flag: `enabled=false` →
  `mode='sync'`, today's synchronous path unchanged.
- **Finish-callback half in n8n (Block 7).** A new HTTP-triggered sub-workflow receives
  `{session_id, outcome, delivered_via_tool, output_blocks, final_message_text, +carry-state}`, re-fetches
  usage/duration, runs the doc-files enumeration + cost computation now in `Build Final Output`, then
  `Render Agent Output → Post Reply (Managed) → Write Cost Field → flip status`. It integrates the
  **Block 1 fail-loud guard** (a non-delivery outcome posts an incomplete-status comment + CRITICAL,
  never narration) and is **idempotent on `session_id`** (no double-post on a duplicate callback).
- **`waiter_sessions` table + `session_waiter.*` config** (migration 049). The table is the durable
  record of every handoff and the store the reliability seam watches; the config knobs are the cutover
  flag (`enabled`, seeded false), the freshness threshold (`stuck_after_minutes`, 50), and the waiter's
  absolute per-session budget (`absolute_budget_ms`, 45 min). The managed key is **never** stored — the
  waiter is handed it at handoff and re-derives it from `public.get_anthropic_key()` (A6).

Reliability (a new always-on service is a new, silent failure surface — the biggest cost of this design):

- **Health dead-man's-switch** — `Session Waiter Health Monitor (v1)` pings `GET /health` every 10 min; a
  down/unreachable waiter → CRITICAL (`session-waiter/health`).
- **Handed-off-but-not-finished freshness check** — `Session Waiter Freshness Monitor (v1)` calls
  `public.check_stuck_waiter_sessions()` every 15 min; any row still `handed_off`/`running` past
  `stuck_after_minutes` → CRITICAL (`session-waiter/freshness`). This catches exactly what the reactive
  layer cannot: a session the waiter took and then stopped driving (nothing throws). Both monitors carry
  the global `Error Handler (v1)` as `errorWorkflow` (reactive layer).
- The waiter self-alerts on a handoff-persistence failure and on `uncaughtException`, and logs structured
  JSON with **secret redaction** (the managed key is never logged or persisted). `restart: unless-stopped`
  brings a crashed process back; the health monitor catches the gap.

Consequences

- **Long managed tasks complete.** The session's wall-clock is no longer bounded by one n8n execution;
  the agent's real `deliver_output` is captured whenever it lands and the finish callback posts the real
  answer. Premature narration can no longer be published (Block 1 guard + the callback only posts on a
  real terminal outcome).
- **New operational surface.** One more container to run, monitor, and reason about. Mitigated by the two
  proactive checks above + `restart: unless-stopped`; the reconciliation freshness check is the safety
  net for the failure mode (orphaned session) that has no exception to catch.
- **Two systems, one secret.** The managed key now also flows to the waiter — but only at handoff /
  via the existing getter; it is never written to the repo, `.env`, or the DB (A6).
- **Recursion-depth concern removed.** The wait no longer self-recurses an n8n execution — a strict win
  over the chunked-recurse alternative.
- **Drift discipline.** The tail/extract handlers remain the single source of truth for client-tool
  servicing; the waiter only calls them, so a future handler change does not have to be mirrored.
- **Reversible cutover.** `config.session_waiter.enabled=false` restores the synchronous poll loop
  verbatim; the flag is the documented rollback.

Supersedes (at Block 8): the synchronous held-poll loop of ADR-053 / ADR-063 (`Poll Round`). ADR-063's
structured `deliver_output` tool is retained and is *not* the bug — it never got to run because the
session was abandoned mid-task. Pairs with ADR-067 (downloadable generated-image bytes), which fixes the
in-document image-embedding half of the same incident.

Date

2026-06-30 (draft; Block 4 of 8)
