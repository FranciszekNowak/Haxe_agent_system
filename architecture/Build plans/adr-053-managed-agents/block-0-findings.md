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
  `file_id` to reference input images in the session.

> **Resolved in Block 3 (live, 2026-06-18) — vision confirmed end-to-end:** an input image attaches to a
> `user.message` as an **image content block** `{type:"image", source:{type:"file", file_id:"file_…"}}`
> (Messages-API parity), *not* a session `resources` mount (resources are for sandbox/code-exec file
> access — wrong semantics for "the agent should see this image"). Probe `scripts/ma-spike3.py` uploaded a
> PNG to the Files API with `purpose=agent` (the upload default below), created a session on the live Haiku
> tier agent, POSTed that content block in a `user.message`, and the session reached `idle` with an
> `agent.message` correctly **describing the image** ("Red square."). So the file_ids `Upload Input Images
> (v1)` returns ARE usable as vision input — no change to the upload (`purpose=agent` is fine).
> - **Send BOTH betas on the events call** when a `user.message` references a `file_id`:
>   `anthropic-beta: managed-agents-2026-04-01,files-api-2025-04-14`. (Block 5 sets this on the
>   send-message HTTP node, mirroring the file-listing call.)
> - **Failure signature if the bytes are bad:** a malformed/corrupt image is *accepted at send* (HTTP 200,
>   the event lands in the log) and only fails later as a `session.error` `{message:"Could not process
>   image", retry_status: terminal}` → `session.status_terminated`. So "send 200" does **not** mean the
>   image is valid — you must read the events to idle and check for `session.error`. (A copy-corrupted
>   test base64 produced exactly this and looked like an API limitation until isolated against the bare
>   Messages API; generate test images in-process, never hand-copy base64.)

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

> **Correction found in Block 2 (live):** the **update** body (`POST /v1/agents/{id}`) **requires a
> `version` field** = the agent's *current* version (optimistic concurrency — it creates `version+1`).
> Omitting it returns `400 invalid_request_error "version: Field required"`. The **create** body
> (`POST /v1/agents`) must **not** carry `version`. So `Sync Agent Definitions (v1)` sends `version`
> only when updating, sourced from `agent_routing.agent_version`. Consequence: if the DB's recorded
> `agent_version` ever lags the live version (a writeback that failed after the API succeeded, or an
> out-of-band console edit), the next update `400`s on version mismatch — surfaced loudly via the sync's
> error-branch CRITICAL, healed by re-running sync after correcting the recorded version (a future
> hardening could `GET` the live version just before each update).

## Net effect on the master plan

- Pause/resume **holds** → no sidecar; the one custom-build risk is retired.
- Block 5: poll `GET /events` (+ `GET /session` status), dedup serviced tool ids session-wide; no SSE.
- Block 6: compute USD from tokens + `stats.duration_seconds` + web-search count; no cost header.
- Block 2: model is `{id, speed:"standard"}`; agents are updated (versioned), archived only when dead.
- Blocks 3/7/8 inputs confirmed (Files upload, session-output listing, built-in web search).
