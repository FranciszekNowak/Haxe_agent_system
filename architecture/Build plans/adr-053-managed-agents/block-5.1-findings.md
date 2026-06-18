# ADR-055 Block 5.1 — MCP capability-gate findings

**Status: DONE 2026-06-18. GATE PASSES — image generation via a self-hosted MCP server is feasible, and
the host is the n8n MCP Server Trigger (no new infrastructure).** Proven live against the production
Anthropic org (the existing `ANTHROPIC_API_KEY`) and our live n8n (`agents.haxe.ai`) with a throwaway
echo MCP server and a throwaway agent; all test resources torn down. Probe: `scripts/ma-spike-mcp.py` +
the throwaway n8n workflow `SPIKE MCP Echo (053 Block 5.1)`.

## Verdict

The harness calls a **self-hosted MCP tool in-harness** (no client pause/round-trip) when the toolset is
set to `always_allow`, and it **held a 200-second tool call open** — clearing the ~170s gpt-image-2-high
kill-criterion. The n8n **MCP Server Trigger** node works on our live instance, is reachable on the
existing `agents.haxe.ai` surface, speaks MCP over SSE, and supports bearer auth. So Blocks 5.2/5.3
proceed as planned, hosted on n8n.

## Registration shape (confirmed live)

Agent definition gains two paired pieces (probed by creating throwaway agents and reading the API's own
validation errors):

- `mcp_servers: [{ "type":"url", "url":"https://…", "name":"<server_name>" }]` (optionally an auth token —
  see Auth).
- `tools: [{ "type":"mcp_toolset", "mcp_server_name":"<server_name>",
  "default_config":{ "enabled":true, "permission_policy":{ "type":"always_allow" } } }]`

**Two findings that matter:**
1. `mcp_servers` **must** be referenced by an `mcp_toolset` tool entry, else create fails 400
   *"mcp_servers […] declared but no mcp_toolset in tools references them"* (mirrors the
   `agent_toolset_20260401` pattern for built-in tools).
2. **`mcp_toolset` defaults to `permission_policy:{type:"always_ask"}`.** Left at the default, the harness
   would **pause for a permission decision** on every MCP call — re-introducing a client round-trip and
   defeating the whole point. **Block 5.3 MUST set `permission_policy:{type:"always_allow"}`** on the image
   toolset (image generation needs no human gate). With `always_allow`, the spike saw zero pauses.

## Event model (confirmed) — MCP tool calls run in-harness, no client loop

Observed per MCP tool turn:
`session.status_running → user.message → span.model_request_start → agent.thinking →
agent.mcp_tool_use → span.model_request_end → agent.mcp_tool_result → span.model_request_start →
agent.message → … → session.status_idle`.

- MCP calls surface as **`agent.mcp_tool_use` / `agent.mcp_tool_result`** — a **distinct** event type from
  both `agent.tool_use` (built-in, e.g. web_search) and `agent.custom_tool_use` (the **client-pause** type
  that drives the Block-5 loop). They run entirely server-side; the agent's reply echoed our n8n tool's
  output verbatim. **So an image MCP call never enters `Execute Agent Session`'s pause/resume loop.**
- Consequence for `Execute Agent Session (v1)`: its `Poll Round` already treats only unanswered
  `agent.custom_tool_use` as a client callback; `agent.mcp_tool_use` is ignored by that logic and the
  session simply runs to idle. So **no Execute Agent Session change is required for image to work via MCP**
  beyond de-registering the `generate_image` custom tool (Block 5.3). The loop stays intact for ADR-054's
  Google DWD tool.

## Tool-call duration (the kill-criterion) — PASSES, thin margin noted

Three turns, echo tool sleeping N seconds inside the n8n Code Tool, wall time send→idle:
- `0s` → idle in **8s**; `30s` → **36s**; `200s` → **206s** (agent replied "echoed after 200s: 200").
- n8n side: the `echo` node ran **200003 ms** within one webhook execution (well under
  `N8N_RUNNERS_TASK_TIMEOUT=900s`); the harness waited the full 200s for the MCP response.

**200s clears the ~170s gpt-image-2-high worst case.** Margin is thin and the true harness ceiling was not
located (200s worked; higher untested). Because `Generate Images Parallel (v1)` runs images **in parallel**
(batch wall-time ≈ slowest single image, not the sum) and its own soft-deadline is 840s, **Block 5.2 must
bound the image-MCP handler's wall time** (e.g. cap concurrency/count so the slowest realistic batch stays
well under ~200s, and/or probe the true ceiling) so a slow batch can't exceed the harness MCP timeout. If a
future need pushes past the ceiling, the fallback is an async/poll tool pattern or keeping that case on the
client-side path.

## Auth (confirmed available; spike used none)

The n8n MCP Server Trigger offers `none` / **`bearerAuth`** / `headerAuth`. The spike used `none` (throwaway,
obscure path, torn down). **Block 5.2/5.3 use bearer:** mint a token, store it in Supabase Vault (rotation)
**and** in the Anthropic Vault attached to the agent's `mcp_servers` entry; the harness sends it; the
trigger validates it. (Auth-token field on the `mcp_servers` entry to be set when wiring — the
Messages-API MCP connector uses `authorization_token`; confirm the exact field in 5.2.)

## Session/correlation context to the MCP call — NOT determined here (and not needed for image)

The n8n MCP Server Trigger abstraction does **not** surface the raw inbound request (headers/body) to the
connected tool node (the Code Tool sees only its `query`; the trigger node output was empty). So whether the
harness passes a session/correlation id to MCP calls is **unresolved via the n8n host**. **This does not
matter for image:** reference images resolve via the global `agent_input_file_map(file_id→url)` table
(Block 5.2), needing no session context. It matters only for the **deferred all-MCP / Google-DWD-via-MCP**
question (ADR-055 R4), which would need per-user identity bound unspoofably — that investigation would
likely require a **standalone** MCP server able to read raw inbound headers, not the n8n trigger. Recorded
as an open item for that future decision; **out of scope here**.

## Cost surface

No MCP-specific cost field appeared; MCP tool calls produce `agent.mcp_tool_use`/`_result` events and their
tokens count in `session.usage` like any tool. **Block 6's USD formula is unchanged.** Per-image generation
cost is still written by `Generate Images Parallel`'s own `Log Model Run` (now invoked behind the MCP
handler).

## n8n host details (for Block 5.2)

- Node: `@n8n/n8n-nodes-langchain.mcpTrigger` (typeVersion 2), params `{authentication, path}`; tools are
  connected via `ai_tool` sub-node connections (the spike used a `@n8n/n8n-nodes-langchain.toolCode` Code
  Tool). Accepted + activated on our live instance.
- Endpoint URL pattern: **`https://agents.haxe.ai/mcp/<path>`** (production). Responds to MCP `initialize`
  over SSE (`event: message` / `data: {…}`), `serverInfo.name = "MCP_Server_Trigger"`,
  `protocolVersion 2024-11-05`.
- For the image server (5.2), the exposed `generate_image` tool will be a tool sub-node whose handler calls
  `Generate Images Parallel (v1)` + the Files-API upload (reuse the Block-4 `Image Tool Handler` logic),
  resolving `reference_file_ids` via `agent_input_file_map`.

## Net effect on the plan

- Gate **passes** → Blocks 5.2 (image MCP server + `agent_input_file_map`) and 5.3 (switch agents to the
  `mcp_servers` entry, `always_allow`, health monitor) proceed; host = n8n MCP Server Trigger.
- Block 5.3 must use `permission_policy: always_allow` on the image `mcp_toolset`.
- Block 5.2 must bound the handler wall time under the harness MCP timeout (≥200s confirmed; keep margin).
- `Execute Agent Session (v1)` needs no structural change for image-via-MCP; its loop is retained for
  ADR-054's Google DWD tool.
- Open (deferred, R4): session-context delivery to MCP calls — needed only if Google DWD later moves to MCP.
