# ADR-053 Block 0 — Capability-gate findings (the low-level Managed Agents spec)

**Status: DONE 2026-06-18.** Proven live against the production Anthropic org (the existing
`ANTHROPIC_API_KEY`) with two throwaway probes (`scripts/ma-spike.py`, `scripts/ma-spike2.py`); all test
resources were deleted/archived afterward (no orphans). This note is the durable low-level spec the ADR-053
header referenced (`multimodal-io-and-spine-decomposition-spec.md`, which never existed). Spike cost was
negligible (Haiku, a few short turns, <1 min of session runtime).

## Verdict

**The feasibility gate passes: the custom-tool pause/resume model is real, and n8n can drive it with plain
request/response polling — no SSE consumer, no sidecar.** Blocks 4–5 proceed as written in the master plan.
The one design refinement: the session loop **polls `GET /events`** (which returns full history) rather than
consuming the SSE stream.

## Access / transport (confirmed)

- Base `https://api.anthropic.com`; headers on every call: `x-api-key`, `anthropic-version: 2023-06-01`,
  `anthropic-beta: managed-agents-2026-04-01`. Files endpoints additionally need `files-api-2025-04-14`
  (send both, comma-joined, on session-scoped file listing).
- The existing key has beta access and billing — `GET /v1/agents` → `200 {"data":[]}`. No new key needed.
- ID prefixes: `env_…` (environment), `agent_…`, `sesn_…` (session), `sevt_…` (every event, incl. tool
  uses), `file_…`.

## Resource model (confirmed)

`POST /v1/environments {name, config:{type:"cloud", networking:{type:"unrestricted"}}}` → `env_…`
→ `POST /v1/agents {name, model, system, tools, skills}` → `agent_…` (+ integer `version`, starts at 1)
→ `POST /v1/sessions {agent:"<agent_id>", environment_id:"<env_id>"}` → `sesn_…` (status `idle`).

Agent object shape (as returned): `model` is an **object** `{id, speed:"standard"}` (not a bare string on
read; `speed:"fast"` is Opus-4.6-only — our tiers all use `standard`). `tools` entry
`{type:"agent_toolset_20260401"}` expands to `{type, default_config:{enabled:true,
permission_policy:{type:"always_allow"}}, configs:[]}`. Custom tool echoed as
`{type:"custom", name, description, input_schema}`. `skills` → `[{type:"anthropic", skill_id:"xlsx",
version:"latest"}]`. → **Block 2:** the four tier agents differ only in `model.id`
(`claude-haiku-4-5` / `claude-sonnet-4-6` / `claude-opus-4-8` / `claude-fable-5`).

## THE GATE — custom-tool pause/resume (confirmed)

Observed event sequence for one custom-tool turn:
`session.status_running → session.thread_status_running → user.message → span.model_request_start →
agent.thinking → agent.custom_tool_use → span.model_request_end → session.thread_status_idle →
session.status_idle` … then after we answer: `user.custom_tool_result → session.status_running → … →
agent.message`.

- `agent.custom_tool_use` payload: `{id:"sevt_…", name, input:{…}, processed_at, type}`. The session goes
  **idle** (waiting on us).
- Answer with `POST /v1/sessions/{id}/events` body
  `{events:[{type:"user.custom_tool_result", custom_tool_use_id:"<the sevt_ id>",
  content:[{type:"text", text:"<result JSON as string>"}]}]}`. **The id to echo is the
  `agent.custom_tool_use` event's own `id`** (the `sevt_…`), confirmed live.
- Session then resumes and produces `agent.message` (`content:[{type:"text", text}]`).

→ **Block 5 loop (polling, not SSE):** send `user.message` → loop: `GET /v1/sessions/{id}/events` (full
history; dedup by event `id`) + `GET /v1/sessions/{id}` for `.status`. On an unanswered
`agent.custom_tool_use` whose `name` is `generate_image`, call the image tool handler and POST the
`user.custom_tool_result`. Treat `status:"idle"` as **done only when no custom-tool use is still
unanswered** (idle also means "waiting on you"). Apply the planned soft-deadline cap.
  - **Implementation trap (found in the spike):** because `GET /events` returns the *whole* session
    history every poll, the loop must track answered `custom_tool_use` ids **for the life of the session**,
    not per-turn — otherwise a prior turn's tool use is re-serviced on every later poll. (My probe's
    per-turn set caused exactly this; harmless to the API, but n8n must dedup globally.)

## Web search (confirmed) — retire our research workflows

`web_search` is built into `agent_toolset_20260401`. Triggering it produced `agent.tool_use`
`{name:"web_search", input:{query}, evaluated_permission:"allow"}` → `agent.tool_result`, run entirely
in-harness (no client action). → **Block 8:** delete `decide-research-and-deliver` + `research-the-web`;
the agent self-orchestrates search (steering, if any, lives in the agent `system`).

## Skills + file output (confirmed)

The `xlsx` skill + code execution wrote `budget.xlsx` (4956 bytes, mime
`application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`) to session outputs.
`GET /v1/files?scope_id=<session_id>` (with **both** beta headers) lists outputs:
`{data:[{id, filename, mime_type, size_bytes, downloadable:true, scope:{type:"session", id}}]}`. There is a
~1–3 s indexing lag after idle. → **Block 7:** office-doc delivery downloads these and uploads to ClickUp.

## Files API (confirmed) — both directions

- **Download (output):** `GET /v1/files/{id}/content` returns **binary bytes** — read as bytes, do **not**
  UTF-8-decode (that was the only failure in run 1, a probe bug, not an API issue).
- **Upload (input, Block 3):** `POST /v1/files` multipart (`file` part + `purpose=agent`, header
  `files-api-2025-04-14`) → `{id:"file_…", filename, mime_type, size_bytes, downloadable:false}`.
  Uploaded files are **not downloadable** (only code-exec/skill outputs are) — fine, we only need the
  `file_id` to reference input images in the session. (Open Block-3 sub-check: confirm the exact way to
  attach an input image to a `user.message` — image content block `{type:"image", source:{type:"file",
  file_id}}` vs a session `resources` file mount — pick during Block 3.)

## Cost / usage surface (confirmed) — Block 6 computes USD itself

- **Per inference:** `span.model_request_end.model_usage = {cache_creation_input_tokens,
  cache_read_input_tokens, input_tokens, output_tokens}`.
- **Aggregate per session:** `GET /v1/sessions/{id}` →
  - `.usage = {cache_creation:{ephemeral_1h_input_tokens, ephemeral_5m_input_tokens},
    cache_read_input_tokens, input_tokens, output_tokens}`
  - `.stats = {active_seconds, duration_seconds}`  ← the runtime surface for the $0.08/session-hour line.
- **There is no aggregate dollar field.** So Block 6 computes `usd_cost` =
  token cost (input/output/cache-tier tokens × the served Claude model's prices) +
  `0.08 × (stats.duration_seconds / 3600)` runtime +
  web-search cost (`$10/1k` × count of `web_search` `agent.tool_use` events) +
  (image-tool cost is logged independently by `Generate Images Parallel`). Then hand the single `usd_cost`
  to `Log Model Run`, which keeps sole FX/PLN ownership. **This confirms the plan's "no aggregate returned"
  branch is the actual case — drop the LiteLLM-passthrough cost-header option for the agentic lane.**
- **Automatic prompt caching is on** inside a session: first turn wrote ~5.4–5.7k
  `cache_creation` tokens (the agent system + tools), readable cheaply on later turns. Consequence for the
  v1 "fresh session per run" decision: each run re-pays that cache-creation cost; reusing a session across
  a task's turns would amortize it. (Multi-turn session reuse stays a documented fast-follow.)

## Lifecycle / cleanup verbs (confirmed)

`DELETE /v1/sessions/{id}` → 200; `DELETE /v1/environments/{id}` → 200; `DELETE /v1/files/{id}` → 200.
**Agents have no delete — `POST /v1/agents/{id}/archive` (→ 200) and archive is permanent/read-only.**
→ **Block 2:** change agent behavior by `POST /v1/agents/{id}` (new version), never recreate; archive only
truly-dead agents, and confirm with the operator first.

## Net effect on the master plan

- Pause/resume **holds** → no sidecar; the one custom-build risk is retired.
- Block 5: poll `GET /events` (+ `GET /session` status), dedup serviced tool ids session-wide; no SSE.
- Block 6: compute USD from tokens + `stats.duration_seconds` + web-search count; no cost header.
- Block 2: model is `{id, speed:"standard"}`; agents are updated (versioned), archived only when dead.
- Blocks 3/7/8 inputs confirmed (Files upload, session-output listing, built-in web search).
