ADR-066: Asynchronous managed-agent session via an external "session waiter" service

Status: ACCEPTED (Blocks 4–8 shipped + verified live; **cutover done 2026-07-01** —
`config.session_waiter.enabled=true` is the standing production default, the synchronous poll loop is the
documented rollback). Block 4 shipped the
service skeleton + reliability seam + this draft; **Block 5 (orchestrator split) shipped + verified live
2026-06-30** — the managed lane forks on `config.session_waiter.enabled` (seeded `false`): `mode='handoff'`
runs the front half then `POST /handoff` and returns (no key in the body — the waiter re-derives it), while
`mode='sync'` keeps today's poll loop. **Block 6 (waiter event loop) shipped + verified live E2E 2026-06-30**
— the waiter (`app.mjs` v1.1.0-block6) re-derives the key via `get_anthropic_key()`, long-polls `GET /events`
(porting `Poll Round`'s analysis), services client tools through the new `Session Waiter Tool Bridge (v1)`
(delegating to the SSOT tail/extract handlers), captures `deliver_output`, and POSTs the finish callback;
crash-recovery re-adopts in-flight rows on startup. A2 ≥30-min survival is baseline-GO (non-blocking).
**Block 6.1 (SSE-incremental event source) shipped + verified live E2E 2026-07-01** — the waiter (`app.mjs`
v1.2.0-block6.1) now drives via SSE as the design intended: it seeds once with `GET /events`, then
accumulates events from `GET /events/stream` (full event objects with stable `sevt_` ids), so **steady state
does no full-log re-fetch**; a `GET /events` **delta** (`created_at[gte]=<cursor>`) runs only on (re)connect
reconcile + a slow safety tick. The Block-6 long-poll loop is kept as the SSE-independent fallback
(`SSE_ENABLED=false` forces it). Block 6.1.0 live-probed the assumptions (see the block-6.1.0 findings in the
master plan): SSE delivers full stable-id events + stays open across idle, the only event cursor is
`created_at[gte]` (`?after=` 400s), and a pending tool resolves across a forced mid-stream drop.
**Block 7 (finish-callback half) shipped + verified live E2E 2026-07-01** — the async terminal now posts
through a new HTTP-triggered `Session Waiter Finish (v1)` webhook that calls the **shared
`Publish Managed Result (v1)`** sub-workflow, which is *also* what the synchronous orchestrator now calls
(one publish path, decision B — see below); the waiter (`app.mjs` v1.3.0-block7) sends the finish callback
header-authed (`X-Watchdog-Key`). **Block 8 (cutover + reliability) shipped 2026-07-01** — the reliability
seam was drilled live (freshness monitor CRITICAL on a staged stuck row; a waiter restart mid-run re-adopted
a real long in-flight session and delivered), the whole-plan E2E delivered a real 8-slide `.pptx` with 4
byte-verified embedded images fully async (cost written, status Zakończono, 0 alerts), the finish half was
hardened with an actionable publish-fail CRITICAL (`session-waiter/finish-publish`), and the flag was flipped
to `true`. A live re-run of the original incident task surfaced a pre-existing, orthogonal issue — a
**transient** ClickUp-MCP connection failure makes the caller's `clickup_*` MCP tools fall back to
client-side calls n8n can't service, degrading doc-reading — which was diagnosed (a follow-up probe proved
the ClickUp MCP is healthy and reads docs in-harness) and accepted as graceful degradation (see Consequences).

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
- **Finish-callback half in n8n (Block 7).** `Session Waiter Finish (v1)` — an HTTP-triggered webhook
  (`/session-waiter-finish`, **header-authed** with the shared `X-Watchdog-Key`, since it posts ClickUp
  comments + flips status with the bot token; the waiter sends the header from v1.3.0). It receives the
  waiter's finish payload `{session_id, outcome, delivered_via_tool, output_blocks, final_message_text,
  session_usage, duration_seconds, +carry-state}` (usage/duration ride in the payload — no re-fetch),
  enumerates the produced office-docs via the Files API and computes the session USD cost in a `Build
  Result` node (**ported from `Build Final Output`** — keep the cost math / doc-MIME map in sync), logs the
  priced `agent_runs` row via `Log Model Run`, then calls the shared `Publish Managed Result (v1)`. It is
  **idempotent on `session_id`** via an atomic claim on `waiter_sessions` (flip `status` to `finished` only
  from a not-yet-finished state, `RETURNING` the row — one callback wins, a duplicate/retry matches 0 rows
  → 200 `idempotent_skip`, no double-post).
- **Shared publish path (Block 7, decision B — the "ages well" choice).** Rather than duplicate the
  orchestrator's post-publish wiring into the finish webhook, that wiring — the publishable-answer gate
  (`Session OK?`, the Block 1 guard), `Render Agent Output`, `Skip Cost If Chat?`, `Write Cost Field`,
  `Sum Execution Image Cost`, `Post Reply (Managed)`, and the non-delivery branch (`Post Reply (Incomplete)`
  \+ CRITICAL `managed-agents/non-delivery`) — is extracted into **one** `Publish Managed Result (v1)`
  sub-workflow that **both** the synchronous orchestrator and the async finish webhook call, over a
  normalized session-result contract (a `Normalize Input` node parses it so the moved nodes needed only
  their caller refs repointed). Since Block 8 makes async the default and keeps sync as the rollback, both
  paths MUST stay behaviourally identical — a single shared path is the only way that holds without drift.
  Cost logging (`Log Model Run`) stays in each caller *before* the call, so Publish's `Write Cost Field`
  task-sum includes the session row. The alternative (mirror the topology in the finish webhook) was
  rejected: it would duplicate the gate + guard + cost/render/post wiring and drift the instant either
  side changed. A future consolidation could go further (a single publish super-workflow owning cost
  logging too); deferred as unnecessary now.
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
  verbatim; the flag is the documented rollback. Cut over to `true` on 2026-07-01 after the whole-plan E2E.
- **Doc-reading depends on the external ClickUp MCP; a transient MCP failure degrades gracefully (accepted).**
  The caller's `clickup_*` discovery/doc tools (incl. `clickup_get_document_pages`) resolve server-side via
  the caller-scoped ClickUp MCP (`mcp.clickup.com`, ADR-054). When that MCP connection *transiently* fails
  for a session (proven possible in the Block-8 live re-run of the original task; a follow-up probe confirmed
  the MCP is otherwise healthy and reads docs in-harness), Anthropic surfaces those allowlisted tools as
  client-side `custom_tool_use` — which n8n does **not** service (they were never client-side tools), so the
  agent gets "unavailable", degrades, and emits fail-soft `managed-agents/tail-unknown-tool` WARNs. This is a
  rented-commodity dependency, not a code path we own; we **accept the graceful degradation** (WARN + re-run
  when healthy) rather than duplicate the MCP with an n8n REST fallback. If the failure rate proves
  material, the hardening (a caller-scoped REST fallback for the doc/search tools when they fall through) is
  a documented future ADR-054 block, deliberately scoped OUT of ADR-066.

Supersedes (cutover 2026-07-01): the synchronous held-poll loop of ADR-053 / ADR-063 (`Poll Round`). ADR-063's
structured `deliver_output` tool is retained and is *not* the bug — it never got to run because the
session was abandoned mid-task. Pairs with ADR-067 (downloadable generated-image bytes), which fixes the
in-document image-embedding half of the same incident.

Date

2026-06-30 (draft; Block 4 of 8) — 2026-07-01 (ACCEPTED; Blocks 5–8 shipped + cutover live)

## Amendment (2026-07-02) — remove the 840 s cap; waiter surfaces silent ClickUp denials

**840 s was a synchronous-path artefact.** The `Poll Round` ran inside one n8n Code node that n8n's task runner
kills at ~900 s, so 840 s kept it under the kill. The async waiter runs the loop in a standalone service with no
such limit — its budget is `config.session_waiter.absolute_budget_ms` (migration 049 seeded 45 min). Per operator
request the artificial cap is removed: **budget raised 45 → 90 min** (`5_400_000` ms). **Load-bearing coupling:**
`session_waiter.stuck_after_minutes` (freshness dead-man's-switch) must exceed the longest legit run, so it was
raised **50 → 100 min** in the same change (migration `050_session_waiter_budget_raise.sql`). The synchronous
fallback's own 840 s deadline (`execute-agent-session` "Build Initial State") is LEFT as-is — that path *is*
bounded by the n8n node kill, so its cap is correct. 90 min is a generous backstop, not truly unbounded, because
the non-delivery detection and cost/runaway protection still need a ceiling.

**Waiter now surfaces silent ClickUp-MCP denials.** `analyze()` additionally scans for
`agent.tool_result` "Permission to use clickup_… has been denied" (the shape when the hosted ClickUp MCP fails to
connect — see the ADR-054 2026-07-02 amendment for the incident), and `driveSession` raises one consolidated
`managed-agents/clickup-tool-denied` WARN into the finish payload (side-channel; run still delivers). This closes
the gap where the prior code only caught `mcp_authentication_failed_error`. Deployed to the live service
(rebuild + recreate); startup healthy.
