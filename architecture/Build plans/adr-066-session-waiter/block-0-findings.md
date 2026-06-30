# ADR-066 / Block 0 — assumption verification (GO/NO-GO)

Date: 2026-06-30. Verifies the capabilities the external-session-waiter design depends on before any
build. **Verdict: GO** (two items need a live probe at their own block; both have proven fallbacks and
block nothing else).

## A1 — Sessions API streaming endpoint — ✅ GO

The Anthropic Managed Agents Sessions API exposes an SSE stream:

- **Stream:** `GET /v1/sessions/{id}/events/stream` (real-time agent output).
- **Full history:** `GET /v1/sessions/{id}/events` (complete event log).
- **No replay.** The SSE stream closes when the agent pauses between turns; on reconnect the client must
  (1) re-open the stream, (2) fetch full history via `GET /events`, (3) **dedup events by id**, (4) resume.
- **Pending-tool deadlock.** If the stream drops while an `agent.custom_tool_use` (or `agent.tool_use` /
  `agent.mcp_tool_use`) is unresolved, the session locks until the client posts the matching
  `user.custom_tool_result` / `user.tool_confirmation`. The waiter must always resolve a pending tool.

**Design consequence:** the waiter's source of truth is `GET /events` (dedup by id); SSE is the
low-latency wakeup. *Fallback if streaming proves awkward in practice:* long-poll `GET /events` exactly
as today's `Poll Round` does — proven, and n8n-independent once it runs inside the waiter. Either way GO.

Refs: Anthropic engineering, "Scaling Managed Agents: Decoupling the brain from the runtime" (this is the
exact decouple-long-running-agent-from-orchestrator pattern we are building); `anthropics/skills`
`skills/claude-api/shared/managed-agents-overview.md` (+ `managed-agents-events.md` for event shapes).

## A2 — Session survival + event retention — ⚠ GO, confirm with a live probe in Block 6

No public TTL/idle-timeout is documented; the overview states sessions **remain queryable after streaming
ends / go idle**, and event history is persisted server-side. The 06-30 incident already proves ~20 min of
agent runtime with **no** client polling plus post-idle retrieval of the `deliver_output` event. Unknown:
the hard upper bound (≥45 min). **Mitigation:** the waiter enforces its own large absolute budget
(e.g. 45 min) and the Block 8 reconciliation cron catches a session that never finishes; confirm true
long-survival (≥30 min idle, then event still retrievable) with a cheap live probe at Block 6 kickoff.
Non-blocking for GO.

## A3 — Tool-result submission from an external process — ✅ GO

Confirmed from `execute-agent-session.json → Post Tool Result`. The waiter replicates exactly:

```
POST https://api.anthropic.com/v1/sessions/{session_id}/events
headers: x-api-key: <managed key>, anthropic-version: 2023-06-01,
         anthropic-beta: managed-agents-2026-04-01,files-api-2025-04-14
body: { "events": [ { "type": "user.custom_tool_result",
                      "custom_tool_use_id": "<the agent.custom_tool_use id>",
                      "content": [ { "type": "text", "text": "<result>" } ] } ] }
```

The full servicing chain to port: `Poll Round` (detect pending) → route by tool name → call the n8n
handler → `Post Tool Result` → continue. Session create/first-message are `POST /v1/sessions`
(`{agent, environment_id, vault_ids}`) and `POST /v1/sessions/{id}/events` (`user.message`) — these
stay in the orchestrator's front half (Block 5); the waiter takes over from the first poll.

## A4 — Sandbox egress to the carrier — ⚠ gates Block 3 only; live probe needed

Whether the managed-agent sandbox (`bash`/`node`) can make outbound HTTPS to the Supabase carrier bucket
is unconfirmed (Anthropic sandboxes have historically used network allowlists). Probe at Block 3 kickoff:
run a tiny session, `curl` the carrier signed URL + the Files-API download from `bash`, observe. *Fallback:*
deliver image bytes via a one-shot signed Files-API download the sandbox can reach, or (last resort) keep
images out of office docs and revisit. Blocks 1, 2, 4–8 do not depend on A4.

## A5 — VPS can host an always-on Node service — ✅ GO

`/opt/haxe-agents/docker-compose.yml` already runs custom Node services on `haxe-agents_n8n-internal`:
`queue-consumer` (ADR-056 BullMQ consumer) and `zip-extractor`, alongside `n8n-main`, `n8n-redis`,
`litellm`, `docling`. A `session-waiter` service follows that exact pattern (add a service, `docker compose
up -d` per ADR-033). Internal reachability `n8n-main ⇄ session-waiter` is on the shared network; outbound
to api.anthropic.com + Supabase is available (the stack already calls both).

## A6 — Which credentials — ✅ GO

The managed-lane key is **not** the stale bare-lane `.env` `ANTHROPIC_API_KEY`. `Build Setup` reads it from
a Postgres node `Get Anthropic Key` (`.key`), and sessions attach `vault_ids` (image-MCP + per-user ClickUp
OAuth). The waiter obtains the key either (preferred) **handed at handoff** by the orchestrator (which
already has it), avoiding new DB creds in the waiter, or by reading the same DB row. Do not touch `.env`.

## GO/NO-GO

**GO.** The external waiter is feasible. Proceed with the block order. Items to carry forward:
- Waiter uses `GET /events` (dedup by id) as truth + SSE for wakeups; reconnect/reconcile on stream close.
- Waiter must always resolve a pending tool (deadlock risk) and is itself a failure surface → Block 4/8
  health dead-man's-switch + "handed-off-but-not-finished" reconciliation cron are mandatory.
- A2 long-survival and A4 sandbox egress get live probes at Block 6 / Block 3 respectively; both have
  fallbacks and gate only their own block.
