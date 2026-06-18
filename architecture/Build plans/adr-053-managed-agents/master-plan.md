# Master plan — ADR-053: Switch the spine to Anthropic Managed Agents

**Read this in full at the start of every block.** This is the durable, cross-desktop source of truth (the
`~/.claude` plan file does not travel between machines). Run the house block-by-block routine: read this file
top to bottom, do the first not-done block, write back to `architecture/current.md` + ADR-053, update the
status table, commit, emit a handoff, `/clear`, repeat. Decision record:
`architecture/decisions/053-switch-to-managed-agents.md`.

## Context (why)

ADR-053 (Accepted, not yet built) replaces the bare LiteLLM model-call spine with **Anthropic Managed
Agents** as the single orchestration lane: a hosted runtime giving us the tool loop, code execution,
built-in web search, and office-document Skills that we otherwise would hand-build in n8n. The value is
that the *harness* (not the model) is what makes the agent useful, and the providers now sell it. The bare
LiteLLM lane is retained only as a dormant failover. Residency is dropped (global Anthropic endpoint for
all tasks incl. PII; basis is lawful processing, not residency). Image generation stays our n8n workflow,
now exposed as a custom tool the agent calls.

This plan was written against the **live** repo state (spine contracts, image lane, cost logging, research
loop, read-input) confirmed by exploration, not against the ADR alone.

### Decisions locked with the operator (2026-06-18)

1. **API grounding** → Block 0 is a capability-gate spike that proves the real beta API shapes live before
   anything is built on top. Plan is written against the **tool-use pause/resume** assumption (session
   emits a `tool_use`, we POST a `tool_result` to resume). If Block 0 disproves that, the plan reshapes
   (sidecar SSE consumer) — this is the explicit gate.
2. **Scope** → full cutover: the master plan covers every surface (engine, image-gen-as-tool, built-in web
   search, office-doc Skills, Files-API image input, new cost path, failover). Blocks still each leave a
   working, verified state; the bare lane stays default until the final block flips the flag.
3. **Global rules** → baked into the agent definition's static `system`, kept correct by a **sync workflow**
   from the ClickUp global-rules doc, guarded by a freshness dead-man's-switch (stale rules must not serve
   silently). Per-person preferences stay per-run in the user message.
4. **Output protocol** → the agent emits the existing **structured block-array** as its final message, so
   `Image Resolver`'s markdown→ClickUp-ops renderer and `Post Reply` survive largely intact.
5. **Search orchestration** → left entirely to the agent (web search is an in-harness, server-side tool;
   we do not loop or re-implement it; any steering lives in the agent `system`). The only n8n-serviced
   callback is the custom `generate_image` tool.
6. **Routing** → impact→agent selection lives in a **separate `agent_routing` table**; `model_routing` is
   untouched and serves the bare lane.
7. **Cost** → `Log Model Run` stays the sole FX/PLN owner; the new work is producing a single session
   `usd_cost`. Whether the session API reports cost is a **Block-0 unknown**; the design computes it from
   token usage + wall-clock + search count if no aggregate is returned.

### Amendment (2026-06-18) — ADR-055: image generation moves to a self-hosted MCP server

After Block 5 landed, review (and the ADR-054 interplay) reshaped the image-tool mechanism. **ADR-055
supersedes ADR-053 §5 + R8:** image generation is exposed to the agent as a tool on a **self-hosted MCP
server** (harness calls our endpoint synchronously) rather than a client-side custom tool serviced by the
session pause/resume loop. Why: it removes the per-image polling latency, makes image consistent with the
built-in tools, corrects R8's wrong "MCP bypasses cost logging" premise (a self-hosted MCP reuses
`Generate Images Parallel` + cost logging), and exercises the Vault/`mcp_servers` plumbing ADR-054 needs.
**The client-side loop in `Execute Agent Session (v1)` is RETAINED**, not deleted — ADR-054's Google DWD
retrieval is itself a client-side custom tool that needs it; image is only de-registered as a custom tool.
Full loop retirement (Google → MCP too) is a larger, gated bet (does the harness pass session context to
MCP calls? — Block 5.1) deferred to a future ADR. This is interleaved as Blocks **5.1 → 5.2 → 5.3** (after
Block 5, before Block 6); Block 6 (output adapter + cost) is unchanged because the Agent Session output
contract is identical regardless of how images are produced. **Gate kill-criterion:** if the harness's MCP
tool-call timeout cannot hold an image-gen call (~170s for gpt-image-2 high), image-via-MCP is infeasible
and we stay on the verified client-side path (Block 5) — 5.2/5.3 are abandoned. Full reasoning:
`architecture/decisions/055-image-generation-via-mcp.md`.

### Gaps surfaced (carried into the plan)

- The spec ADR-053 references (`multimodal-io-and-spine-decomposition-spec.md`) **does not exist**; the ADR
  is the only spec. Block 0's findings note becomes the missing low-level spec.
- Managed Agents is **beta, postdating the model knowledge cutoff** → Block 0 gate, no node-level detail
  assumed without live proof.
- Input images reach Gemini today as **URLs** (LiteLLM fetches them); Anthropic needs the **Files API** →
  new input path (Block 3).
- `conversation_sessions` (§7) is **not actually wired** — the spine is stateless/single-turn. v1 keeps a
  **fresh session per run**; reusing Managed-Agents stateful sessions for multi-turn is a documented
  fast-follow, out of scope here.
- The unbuilt `architecture/Build plans/file-output-generation-build-plan.md` (office docs via the *bare*
  Messages API + code execution + Skills) is **superseded** by this plan; Block 9 marks it so.

## Target architecture (under ADR-053 + the four decisions)

- **Agent definitions:** four tier agents (Haiku/Sonnet/Opus/Fable) sharing `system` (stable output
  conventions + the synced CU global-rules), `tools` (`generate_image` custom tool + built-in `web_search`),
  `skills` (anthropic docx/xlsx/pptx/pdf + an optional thin custom Haxe skill), differing only in `model`.
  Impact → agent_id selection replaces `model_routing` for the managed lane.
- **Stage A (mostly unchanged):** still assembles task context, comments, read-input blocks, person prefs,
  triggering comment. Stops injecting the global rules into the prompt (now in the agent `system`). Hands
  off input image refs for Files-API upload.
- **New Stage B — `Execute Agent Session (v1)`:** resolve impact→agent; upload input images to Files API;
  create a session; send the user.message (person prefs + task context + triggering comment + input
  file_ids). **Web search, code execution, and Skills are server-side/in-harness — the agent orchestrates
  them itself; we do not loop and do not re-implement search (Anthropic defaults; any steering lives in the
  agent `system`).** The only thing n8n services in a loop is our **custom `generate_image` tool**: when the
  session pauses with that `tool_use`, call the tool handler, POST a `tool_result`, resume — repeat only for
  further custom-tool calls. On idle collect the final block-array + produced file_ids; compute session USD
  cost; branch-free terminal.
- **Output adapter (in Stage B):** download produced files (Files API), map images → `image_manifest`,
  office docs → an attachment list; reuse `Image Resolver`'s renderer for the block-array → `rendered_delta`.
- **Stage C (`Post Reply`, extended):** unchanged for text + inline images; gains office-doc attachment
  delivery (reuse the Block-10 upload half + a validation gate) and records attachment ids on the erasure hub.
- **Retired:** `decide-research-and-deliver` + `research-the-web` (built-in web search replaces them);
  `research_parameters` left dormant or dropped.
- **Failover:** a `config.agent_lane` flag (`managed` | `bare`); the orchestrator routes Stage B accordingly.
  The bare lane (`Invoke Model` + `Image Resolver`) is kept intact and dormant.

### Internal contracts (the shared references for the lane)

**Agent Session contract** (new Stage B):
- in: `{ user_message (person rules + task context + triggering comment), impact, input_file_refs[] ({url, mime, source_ref}), clickup_task_id, caller/trigger metadata }`
- out: `{ output_blocks[] (text/embed_input/generate/file), files[] ({file_id, kind:'image'|'doc', mime, filename, b64}), usd_cost, model_used, session_id, status, warnings[] }`

**`generate_image` tool contract** (exposed to the agent):
- tool input: `{ prompt, reference_file_ids?[], count?, aspect_ratio?, size? }`
- handler: map `reference_file_ids`→`reference_urls` via the session's `{file_id→url}` map → call
  `Generate Images Parallel (v1)` (the ADR-052 `reference_urls[]` seam, unchanged) → upload b64 to Files
  API → return `tool_result { file_ids[] }`. Per-image cost logged by the batch's existing `Log Model Run`.

Bytes never cross a workflow boundary except as base64 inside execution data (mirrors ADR-036 Block 10).

## Block status

| # | Block | State |
|---|---|---|
| 0 | Capability gate: prove the beta API shapes live (sessions, custom-tool pause/resume, web_search, a skill, Files API up/down, the cost surface) | ✅ **DONE 2026-06-18** — see `block-0-findings.md`. Pause/resume confirmed (no sidecar); poll `GET /events`, not SSE; cost computed from tokens + `stats.duration_seconds`, no aggregate $ field |
| 1 | Anthropic credential + key plumbing + auth health-check | ✅ **DONE 2026-06-18** — `get_anthropic_key()` (migration 034); `Managed Agents Auth Monitor (v1)` (`X3GEjMgmByZgDJnt`, active, every 6h). Missing-key CRITICAL path verified live (exec 2619). **Vault secret `anthropic_api_key` is seeded** (confirmed live in Block 3: `get_anthropic_key()` returns a working key end-to-end) — success-path closed, monitor green |
| 2 | Agent definitions (4 tiers) + CU global-rules sync workflow + freshness dead-man's-switch + impact→agent routing | ✅ **DONE 2026-06-18** — 4 agents live (Haiku/Sonnet/Opus/Fable, share `system`/tools/skills, differ in `model.id`); `agent_routing` table (migration 035); `Sync Agent Definitions (v1)` (`4K1w78hJ7JhsUwdN`, idempotent create/version-update, every 6h); `Agent Rules Freshness Check (v1)` dead-man's-switch (`7lakbgmrH93ygiyZ`, every 6h, reads live agents' embedded rules hash). Update body requires `version` (Block-0 spec correction, recorded in findings). DoD verified live: create, idempotent-skip, content-change→update + read-back, stale-state→WARN |
| 3 | Files-API input path (image refs → bytes → file_id; carry the {file_id→url} map) | ✅ **DONE 2026-06-18** — `Upload Input Images (v1)` (`2VkZN5UeqVk6MDLW`, active). Takes Read Input's image blocks, fetches each to a binary, uploads to `POST /v1/files` (multipart, `purpose=agent`, beta `files-api-2025-04-14`), returns `{file_id,url,source_ref,mime,alt,order}` map + `warnings[]`. DoD verified live (exec 2661): a ClickUp pre-signed image **and** a zip-inner Supabase-signed image (both produced by the real Read Input run on test task `869drte1b`) uploaded → 2 real `file_…` ids, `uploaded_count:2`. Fail-soft verified (exec 2663): bad URL → 1 dropped + `files-api/fetch-failed` WARN, the good one still uploaded; empty-images → clean empty map, no spurious WARN. Open Block-0 sub-check **resolved (vision confirmed live)**: input image attaches to `user.message` as `{type:image, source:{type:file, file_id}}` — the live Haiku agent correctly **described a supplied image** (`scripts/ma-spike3.py`); events call carries both betas (`managed-agents-2026-04-01,files-api-2025-04-14`) when referencing a `file_id`; `purpose=agent` upload is fine. (Caveat for Block 5: a corrupt image is accepted at send=200 and fails later as `session.error` "Could not process image" — read events to idle, don't trust send=200.) |
| 4 | `generate_image` custom-tool handler (wraps Generate Images Parallel via the reference_urls seam) | ✅ **DONE 2026-06-18** — `Image Tool Handler (v1)` (`vpGswBj2kR2D85hl`, active). Parses `{prompt, reference_file_ids?, count?, aspect_ratio?, size?}`; resolves `reference_file_ids`→`reference_urls` via the session `{file_id→url}` map; calls `Generate Images Parallel (v1)` (`2keb6XVWq5PG0leK`) **unchanged** (ADR-052 seam); base64→binary (Convert to File) → Files-API upload (`purpose=agent`, Block-3 node) → returns `tool_result {status, file_ids[], images[]{file_id,b64_json,…}, warnings[], message}`. **No second cost writer** (batch's own Log Model Run writes per-image rows). Fail-soft, branch-free terminal, never throws into the session. DoD verified live: plain gen → `file_id` (exec 2683); reference path → `used_reference:true` + `file_id` (exec 2676); one priced `agent_runs` row (gemini flash, `cost_pln` 0.1414); no-prompt → clean `failed`. **Finding:** per-image `triggered_by` must satisfy `agent_runs_triggered_by_check` — handler fallback defaults to `image_gen`; **Block 5 must forward a valid `triggered_by`** (e.g. `explicit_mention`). 3 test image uploads left in the Files API (harmless, `purpose=agent`; matches Block 3 precedent — couldn't delete without exposing the key on the CLI). |
| 5 | `Execute Agent Session (v1)` — the session loop servicing the custom tool callback | ✅ **DONE 2026-06-18** — `Execute Agent Session (v1)` (`Rtb1cZbmUqmfGD98`, active). Persistent env `env_01T1PexJQheEUVnzVTKjyrz4` created once, stored in `config.managed_agent_environment_id`. Resolves tier agent from `agent_routing`; calls `Upload Input Images (v1)`; builds `user.message` (image file_id blocks + text); creates session; sends message. **Poll Round** (one Code node) does the whole wait via `GET /events`+`GET /session` polling with `this.helpers.httpRequest` + 840s absolute soft-deadline (carried `deadline_epoch`); stateless pending-tool detection (answered iff a `user.custom_tool_result` with the id exists in history); done = idle + `agent.message` after last user event. **Recurses** (research-the-web `executeWorkflow` idiom) once per `generate_image` tool round (cap 12), calling `Image Tool Handler (v1)` + POSTing the `user.custom_tool_result`. Single branch-free terminal (`Final Return` re-reads `Merge Final`); one consolidated `Post Alert (v1)`. Returns `{status, output_message (block-array), files[]{file_id,b64_json}, file_ids[], session_usage, duration_seconds, web_search_count, model_used, session_id, warnings[]}`; **`usd_cost` is a NULL stub for Block 6** (raw usage + duration carried). DoD verified live: text task → block-array + raw usage (exec 2688, 8s); web-search → cited findings, `web_search_count` 1, no research workflows (exec 2691); `generate_image` → serviced callback through one recursive round, returned `file_id`+b64, one priced image `agent_runs` row (gemini-flash, `triggered_by=explicit_mention` forwarded), clean alert channel (parent exec 2694 + child 2700). Test sessions/file + test `agent_runs` row deleted. |
| 5.1 | **(ADR-055)** MCP capability gate: prove the harness calls a self-hosted remote MCP tool; transport/auth; max tool-call duration; session-context-to-MCP; n8n MCP-trigger availability | ✅ **DONE 2026-06-18** — see `block-5.1-findings.md`. **GATE PASSES.** Harness calls a self-hosted MCP tool in-harness as `agent.mcp_tool_use`/`_result` (no client pause) when `mcp_toolset.permission_policy=always_allow` (default is `always_ask` → would pause; 5.3 must set `always_allow`). Registration: `mcp_servers:[{type:url,url,name}]` + paired `tools:[{type:mcp_toolset,mcp_server_name}]`. **Kill-criterion CLEARS:** harness held a **200s** tool call open (0s→8s, 30s→36s, 200s→206s) — over the ~170s gpt-image-2 worst case (thin margin → 5.2 bounds handler wall time). **Host = n8n MCP Server Trigger** (`@n8n/n8n-nodes-langchain.mcpTrigger`, works live, reachable at `https://agents.haxe.ai/mcp/<path>` over SSE, bearer auth available) — no new infra. Session-context-to-MCP not exposed via the n8n trigger (irrelevant for image; resolves refs via `agent_input_file_map`; deferred for the R4 Google-via-MCP question). No MCP-specific cost field (Block 6 formula unchanged). Throwaway agent/session/workflow torn down. |
| 5.2 | **(ADR-055)** Image MCP server + `agent_input_file_map` table + `Upload Input Images` write-back (reuses `Generate Images Parallel` + Files-API upload + cost logging) | ✅ **DONE 2026-06-18** — see `block-5.2-findings.md`. `Haxe Image MCP (v1)` (`c4vnNLb9usfHJWg3`, MCP Server Trigger at `/mcp/haxe-image-gen`, bearer cred `mTlnNTCynGhQtYMO`) → `Image MCP Tool Handler (v1)` (`zxY41zZWRbXon2Eq`) → `Image Tool Handler (v1)` unchanged. Migration 036 (`agent_input_file_map` RLS-no-policy + 24h pg_cron prune; `get_image_mcp_bearer()`; `triggered_by += image_mcp`); bearer seeded in Vault. `Upload Input Images (v1)` upserts the map (additive, fail-soft, single terminal). DoD verified live via direct MCP call (bearer): generate → `file_id` (24s, < 200s ceiling), one priced `agent_runs` row (`image_mcp`/`Średni`/~0.49 PLN), reference resolved via the table (`used_reference:true`), empty-prompt fail-soft + WARN no throw, clean alerts. Agents NOT yet switched (5.3). **Found+fixed live:** `__default__` is invalid for `agent_runs.impact` → handler passes `Średni`; n8n `$fromAI` marks all params required unless given a 4th default arg, and `json`-typed `$fromAI` forces non-empty → `reference_file_ids` exposed as an optional JSON-array string. **⚠ carries a Block-6 delivery gap (see below).** |
| 5.3 | **(ADR-055)** Switch the 4 agents from the `generate_image` custom tool → the image `mcp_servers` entry; image MCP health dead-man's-switch; loop retained for ADR-054's Google tool, dormant for image | ☐ to do — **NEXT** |
| 6 | Output adapter + session cost into Log Model Run | ☐ to do |
| 7 | Post Reply office-doc delivery (attachment + validation gate + erasure recording) | ☐ to do |
| 8 | Lane switch flag + orchestrator wiring + retire research workflows (+ note image custom-tool path is now the dormant rollback, ADR-055) | ☐ to do |
| 9 | End-to-end cutover, GDPR record (incl. the image MCP endpoint, ADR-055), current.md/ADR write-backs, supersede the file-output plan | ☐ to do |

Each block ends with: write-back to `current.md` + ADR-053, status-table update, commit, handoff. Live
verification (not "looks right") per Definition of Done; all alerts through `Post Alert (v1)`; never read or
post-watch the Alerts task `869dj2z2c`; migrations append-only; exported workflow JSON re-exported after any
live change, never hand-edited.

## The blocks

### Block 0 — Capability gate (the linchpin; everything is gated on it)
> ✅ **DONE 2026-06-18 — full results in `block-0-findings.md`.** Gate passed: custom-tool pause/resume is
> real and n8n-drivable by polling (no SSE, no sidecar). Probes `scripts/ma-spike.py` + `ma-spike2.py`.
- **Do:** against the live beta with our key + the `managed-agents-2026-04-01` beta header, prove each
  primitive in isolation and record the exact request/response shapes: (a) create an agent with `model` +
  `system` + one custom tool def + `web_search` + one anthropic skill; (b) create a session, send a
  user.message; (c) the **custom-tool pause/resume loop** — receive a `tool_use`, POST a `tool_result`,
  continue to idle; (d) built-in `web_search` runs in-harness; (e) a skill produces an xlsx → a `file_id`;
  (f) Files API upload (an input image) + download (the produced file); (g) the **cost/usage surface** at
  session end (token usage, the $0.08/session-hour runtime line, tool + web-search costs). Also test whether
  the LiteLLM gateway can proxy the Agents surface (decides the cost path in Block 6).
- **DoD:** a written findings note (the missing low-level spec, saved under this plan's directory) capturing
  every shape above **or** a clear "pause/resume is unsupported → sidecar required" finding that reshapes
  Blocks 4–5 before they start. No production wiring. Confirm we actually have beta access first.
- **Silent-failure modes:** none in production (spike only); the risk it retires is *building the loop on a
  wrong API assumption*.

### Block 1 — Anthropic credential + key plumbing
- **Do:** store the Managed Agents API key as a Supabase Vault secret with a `SECURITY DEFINER` getter,
  mirroring `get_litellm_image_key()` (ADR-051/032); pin the beta header(s) in one place. Build a tiny auth
  health-check (list agents / ping) that WARNs through `Post Alert (v1)` on auth failure.
- **DoD:** a credentialed call from n8n succeeds; a missing/invalid key writes a loud WARN, not a silent
  no-op.
- **Silent-failure modes:** key rotation/expiry breaking the whole lane → the health-check + missing-key
  WARN; secret unreachable from a Code node → use a credentialed Postgres getter (per the n8n crypto/$env
  constraints in CLAUDE.md), not a Code node.

### Block 2 — Agent definitions + CU-rules sync + dead-man's-switch
> ✅ **DONE 2026-06-18.** Agents: Haiku `agent_01VFVwm2tC8rmJvMRZLfSERY`, Sonnet
> `agent_01FJg94fqXkSdmocmBmT4NKL` (serves Średni + __default__), Opus `agent_01TNKHGAg5CHDe93Gai7CKoP`,
> Fable `agent_01DWhec9hSwE1Gt7dSyvzMoH`. Workflows `Sync Agent Definitions (v1)` (`4K1w78hJ7JhsUwdN`) +
> `Agent Rules Freshness Check (v1)` (`7lakbgmrH93ygiyZ`), both active, every 6h. Migration 035
> (`agent_routing`). Provenance: each agent's `system` ends with
> `<!-- HAXE-AGENT-PROVENANCE rules_sha256=… conventions_version=1 source=clickup:q7wz-44812 -->`; the
> dead-man's-switch matches that hash against a fresh hash of the CU doc. Idempotency keyed on rules
> hash + a `CONV` constant in Build System (bump `CONV` to force a re-sync after editing the static
> conventions text). **Update needs `version` in the body** (findings correction). Decisions kept:
> rules baked into static `system` (not per-run); the dead-man's-switch reads LIVE agents, not just the
> DB record, so out-of-band drift is caught. **Note vs original plan:** "all-or-nothing, reports
> per-tier success" is realised as per-tier `continueErrorOutput` → CRITICAL with the HTTP detail, plus
> a fresh-from-DB `Verify Synced` completeness gate; true rollback is impossible (agents have no delete),
> and the next idempotent run self-heals stale tiers.
- **Do:** create the four tier agents (identical `system`/`tools`/`skills`, differing only in `model`).
  Build `Sync Agent Definitions (v1)`: read the CU global-rules doc (Docs v3, as `Load Agent Rules` does
  today), compose `system` = stable conventions + rules, and create/version-update the four agents. Run it
  on demand and on a schedule. Add a **freshness dead-man's-switch**: compare the CU doc's last-edited
  timestamp / a content hash against what the live agents carry; if the agents are stale (or sync errored)
  fire a WARN/CRITICAL so old rules cannot serve silently. Add impact→agent selection via a **separate
  `agent_routing` table** (impact → agent_id), keyed by impact, leaving `model_routing` untouched for the
  bare lane.
- **DoD:** four agents exist; editing the CU doc + running sync updates them (verified by reading the live
  agent back); a deliberately stale state trips the dead-man's-switch.
- **Silent-failure modes:** the headline risk of decision #3 — *the static system drifting from the CU
  SSOT*. Covered by the hash/timestamp dead-man's-switch + a sync-failure CRITICAL. A partial sync (some
  tiers updated, some not) → sync is all-or-nothing per run and reports per-tier success.

### Block 3 — Files-API input path
- **Do:** a step (a new helper sub-workflow, or folded into the new Stage B preamble) that takes
  `Read Input (v1)`'s image blocks (ClickUp pre-signed and zip-inner Supabase-signed URLs), fetches the
  bytes, uploads each to the Files API, and returns a `{file_id, url, source_ref, mime}` map carried into
  the session. `Read Input (v1)` itself is unchanged (still URL-based).
- **DoD:** an input image on a test task is uploaded and a `file_id` returned; the map reaches Stage B; a
  zip-inner image (Supabase URL) also uploads.
- **Silent-failure modes:** an un-fetchable/oversize image silently dropped from the agent's view → a
  per-image WARN (mirrors the reader's `multimodal/*` warnings) and the block continues; Files-API upload
  failure → WARN, the task proceeds text-only rather than failing.

### Block 4 — `generate_image` custom-tool handler
- **Do:** `Image Tool Handler (v1)`: accepts the tool contract `{prompt, reference_file_ids?, count?,
  aspect_ratio?, size?}`; resolves `reference_file_ids`→`reference_urls` via the session map; calls
  `Generate Images Parallel (v1)` unchanged (the ADR-052 `reference_urls[]` seam); uploads the b64 results
  to the Files API; returns `tool_result { file_ids[] }`. Cost rows are written by the batch's existing
  `Log Model Run` path.
- **DoD:** called in isolation it generates an image and returns a `file_id`; the reference path produces a
  visually-anchored image; per-image `agent_runs` cost rows are written.
- **Silent-failure modes:** a generation failure must **fail-soft** so the agent keeps reasoning (return a
  tool_result describing the failure + a WARN, never throw into the session); reuse the batch's existing
  per-image `warnings[]` + fail-soft (ADR-051/052).

### Block 5 — `Execute Agent Session (v1)` (new Stage B core)
- **Do:** create a session bound to (tier agent, environment) with the user.message (person prefs + task
  context + triggering comment + input `file_id`s). **Web search, code execution, and Skills run in-harness
  — the agent drives them; we add no loop and no Tavily/search logic (Anthropic defaults; steering, if any,
  in the agent `system`).** The n8n loop exists solely to service the **custom `generate_image` tool**: on
  its `tool_use`, call Block 4, POST the `tool_result`, resume; iterate only for further custom-tool calls.
  Reuse the `research-the-web` recursive-`executeWorkflow` *mechanism* for that callback servicing (not its
  search content). **Block 0 confirmed the transport: poll `GET /v1/sessions/{id}/events` (full history) +
  `GET /v1/sessions/{id}` for `.status`; no SSE; dedup answered `custom_tool_use` ids session-wide (the
  history re-returns them every poll); `status:"idle"` is "done" only when no custom-tool use is
  unanswered.** On idle collect the final **block-array** message + produced `file_id`s. Keep the return
  a single branch-free terminal (n8n return-determinism trap). Carry a soft-deadline/partial-return like the
  image batch's 840 s pattern.
- **DoD:** a text task runs end-to-end through one session and returns the block-array + a usd cost, verified
  live; a task that triggers web search returns cited findings without our research workflows.
- **Silent-failure modes:** a session that hangs → soft-deadline → partial return + WARN, never a silent
  stall; a non-deterministic multi-branch return → enforced single terminal; a tool loop that never settles
  → a max-rounds cap (mirrors research `max_depth`) + WARN.

### Block 5.1 — MCP capability gate (ADR-055; the linchpin for 5.2/5.3)
- **Do:** against the live beta, with a throwaway self-hosted MCP server (a minimal endpoint exposing one
  echo tool), prove and record: (a) Managed Agents can register a **remote/self-hosted** MCP server on an
  agent (`mcp_servers`) and the agent invokes its tool in-harness — the exact transport (Streamable HTTP?)
  and auth shape (Vault bearer); (b) the **maximum tool-call duration** the harness tolerates before it
  times out (must clear ~170s for gpt-image-2 high — the kill-criterion); (c) whether the MCP tool call
  carries any **session/correlation context** (decides whether Google DWD could later be MCP, ADR-055 R4 —
  not needed for image, which resolves references via the `agent_input_file_map` table); (d) whether
  **n8n's MCP Server Trigger** exists and works on our instance (preferred host) or we need a thin
  server (Supabase Edge Function / a small VPS Node service). Also confirm any MCP-specific cost surface.
- **DoD:** a findings note (saved under this plan's dir) capturing every shape above, **or** a clear
  "infeasible (tool-call timeout < image-gen time)" finding that abandons 5.2/5.3 and keeps image on the
  Block-5 client-side path. No production wiring; tear down the throwaway server + agent edits.
- **Silent-failure modes:** none in production (spike only); the risk it retires is *building the image MCP
  on a wrong transport/timeout assumption*.

### Block 5.2 — Image MCP server + reference-resolution table (ADR-055)
- **Do:** migration for `agent_input_file_map(file_id pk, url, mime, source_ref, created_at)` (append-only)
  + a TTL prune; extend `Upload Input Images (v1)` to upsert `{file_id→url,mime,source_ref}` rows (additive,
  fail-soft). Build the **image MCP server** (n8n MCP Server Trigger workflow if the gate allows, else the
  thin server) exposing `generate_image{prompt, reference_file_ids?, count?, aspect_ratio?, size?}`: resolve
  `reference_file_ids`→URLs from the table, call `Generate Images Parallel (v1)` **unchanged** (ADR-052
  seam) + Files-API upload + the batch's own per-image `Log Model Run` (reuse the Block-4 logic behind the
  MCP entry — **no second cost writer**), return `{file_ids[], message, status, warnings[]}`. Bearer auth;
  secret in Supabase Vault, mirrored into the Anthropic Vault.
- **DoD:** the MCP server, invoked directly (curl as the harness would, with the bearer), generates an image
  and returns `file_id`s, writes exactly one priced per-image `agent_runs` row, fails soft on bad input; the
  reference path resolves a `reference_file_id` via the table to a real generation; verified live.
- **Silent-failure modes:** a generation/upload failure → a tool-error result + WARN, never a throw into the
  session; a missing key/down image lane → the batch's existing CRITICAL + this server's health check (5.3);
  an unresolved `reference_file_id` → generate without the reference + WARN (mirrors the Block-4 fail-soft).

### Block 5.3 — Switch agents to the image MCP; retire image from the loop (ADR-055)
- **Do:** via `Sync Agent Definitions (v1)`, update the four tier agents to **drop the `generate_image`
  custom tool** and **add the image `mcp_servers` entry** (Vault-held bearer) — only after 5.2 is verified
  live. `Execute Agent Session (v1)` keeps its pause/resume loop (ADR-054's Google DWD tool needs it) but no
  longer sees image as a registered custom tool, so the tool-servicing branch is dormant for image. Add an
  **image-MCP health dead-man's-switch** (mirror `Managed Agents Auth Monitor (v1)`: probe the endpoint,
  WARN/CRITICAL via `Post Alert (v1)`). Document the rollback (re-register the custom tool → the Block-5
  client-side path re-activates).
- **DoD live:** an @-mention (or `test-subworkflow.mjs`) image task generates via the **MCP path**
  end-to-end and returns the `file_id`(s); the `Execute Agent Session` custom-tool branch does **not** fire;
  one priced image `agent_runs` row; alert channel clean; the health check trips on a deliberately-down
  endpoint.
- **Silent-failure modes:** a down image MCP silently failing every image → the health dead-man's-switch;
  agents updated but the MCP unregistered/misconfigured (sync partial) → `Sync Agent Definitions`' existing
  per-tier CRITICAL + a live image test; image quietly falling back to text-only → the agent surfaces the
  tool error + WARN.

### Block 6 — Output adapter + session cost
- **Do:** convert the session output into the Post Reply contract: download produced files (Files API) →
  `image_manifest` (kind image) + an attachment list (kind doc); reuse `Image Resolver`'s block-array →
  `rendered_delta` renderer. **Cost (depends on Block 0's finding of the session surface):** if the session
  returns an aggregate cost or token usage, extract/sum it; otherwise compute USD ourselves from data we
  control — token usage × the per-model prices we hold, plus runtime from session wall-clock ($0.08/hr),
  plus a web-search count from the events ($10/1k). **Block 0 resolved this: there is NO aggregate $ field
  and NO LiteLLM passthrough for the agentic lane — compute USD from `session.usage` token tiers (incl.
  `cache_creation.ephemeral_5m_input_tokens` / `cache_read_input_tokens`) + `0.08 × stats.duration_seconds /
  3600` + the web-search count.** Either way pass a single `usd_cost` to
  `Log Model Run`, which keeps **sole FX/PLN ownership**. The `generate_image` tool's per-image cost is
  already logged by `Generate Images Parallel`'s own `Log Model Run` path. Optionally add `agent_runs`
  columns (migration) for a runtime/tool cost breakdown.
  **NB (ADR-055 / Block 5.2):** "download produced files (Files API)" does **not** work for images — Files-API
  uploads are `purpose=agent` (not downloadable). On the client-side image path the bytes are carried as
  `b64_json` through n8n; on the **MCP image path the bytes do not return to n8n at all** (see the Open-risks
  delivery-gap bullet), so Block 6 must add a carrier (persist produced bytes to Storage / an output
  `file_id→signed_url` map) before MCP-produced images can be delivered. Skills/code-exec **output** files
  (office docs) *are* downloadable (Block 0) — that download still applies to Block 7.
- **DoD:** a session output renders to `rendered_delta` + `image_manifest` + a doc attachment list; exactly
  one priced session `agent_runs` row (plus the tool's per-image rows) with a correct non-zero cost.
- **Silent-failure modes:** the cost surface missing a field → a floor estimate + a cost-missing WARN
  (mirrors the image cost-header-missing pattern), never a silent 0; a file_id that fails to download →
  WARN + omit that artifact, never a broken post.

### Block 7 — Post Reply office-doc delivery
- **Do:** extend `Post Reply (v1)` to deliver office-doc files as ClickUp attachments + a comment link,
  reusing the Block-10 upload half and the file-output plan's F5 delivery; add a **validation gate** (open
  the file, assert non-corrupt / sheet or page present) — on failure WARN + a short Polish note, never post
  a broken file. Record the attachment id on the run's `agent_runs` row (erasure hub, ADR-044).
- **DoD:** an xlsx task posts an attachment that opens and contains the fed numbers; a deliberately corrupt
  output yields a WARN + note and no broken attachment; the attachment id is recorded.
- **Silent-failure modes:** corrupt/empty file posted as valid → the validation gate; a half-failed upload
  (orphaned attachment) → the existing Block-10 rollback/WARN; an unrecorded artifact id → the Record
  Artifact 0-row WARN (ADR-044).

### Block 8 — Lane switch + orchestrator wiring + retire research
- **Do:** add `config.agent_lane` (`managed` | `bare`, default `bare` until Block 9); the orchestrator reads
  it and routes Stage B to `Execute Agent Session (v1)` or the existing `Execute LLM Call (v1)`. Remove
  `decide-research-and-deliver` + `research-the-web` from Stage A (web search is in-harness now); leave
  `research_parameters` dormant or drop it (migration). The bare `Invoke Model` + `Image Resolver` stay
  intact as the dormant failover lane.
- **DoD:** flipping the flag switches lanes; the bare lane still completes a task when selected; no orphan
  calls to the retired research workflows; `check-workflow-drift.mjs` clean.
- **Silent-failure modes:** a mis-read flag silently routing wrong → default to `bare` (fail-safe) on an
  unreadable/absent flag + a WARN; a dangling reference to a deleted research workflow → caught by the drift
  check + a live run.

### Block 9 — End-to-end cutover, GDPR, write-backs
- **Do:** full @-mention Definition-of-Done across tiers and modalities (text; image generation; image
  input; office-doc; a web-research-needing task). Flip `config.agent_lane=managed` as default. Update
  `compliance/gdpr-processing-decisions.md` (global Anthropic endpoint for PII; Files API + sandbox + Skills
  + web search as processing activities / sub-processors; confirm the DPA/no-training terms cover them).
  Rewrite `current.md` §2 Layer 3, §3, and §15 to describe the managed lane as live and **collapse the
  "Accepted redirection" section** added on 2026-06-18. Flip ADR-053 consequences to landed. Mark
  `file-output-generation-build-plan.md` superseded. Final commit.
- **DoD:** every surface verified live; the Alerts channel clean (or every WARN explained); docs reconciled;
  the bare lane confirmed still selectable as failover.
- **Silent-failure modes:** an un-migrated surface silently still on the bare lane → the per-modality live
  matrix; a doc claiming managed-is-live while a surface isn't → the DoD matrix gates the flip.

## Critical files / components

- `n8n/workflows/agent-orchestrator.json` — lane routing (Block 8), Stage B swap.
- `n8n/workflows/assemble-context-and-build-prompt.json` — stop injecting global rules; hand off input image
  refs (Block 3); drop the research call (Block 8).
- **New:** `Execute Agent Session (v1)`, `Image Tool Handler (v1)`, `Sync Agent Definitions (v1)`, the
  Files-API input helper.
- `n8n/workflows/generate-images-parallel.json` + `image-resolver.json` — reused unchanged behind the tool
  handler / as the renderer (the ADR-052 seam already anticipated this).
- `n8n/workflows/post-reply.json` — office-doc delivery (Block 7).
- `n8n/workflows/log-model-run.json` — sole cost writer; session-cost input (Block 6).
- Retire: `decide-research-and-deliver.json`, `research-the-web.json` (Block 8).
- Reuse pattern: `research-the-web.json`'s recursive `executeWorkflow` mechanism → reused **only** to service
  the custom `generate_image` tool callback (web search is in-harness; not re-implemented).
- Migrations (append-only): `agent_routing` table (Block 2), `agent_input_file_map` table (Block 5.2,
  ADR-055), optional `agent_runs` cost-breakdown columns (Block 6), `research_parameters` drop (Block 8).
- **ADR-055:** new image **MCP server** (n8n MCP-trigger workflow or a thin self-hosted endpoint); a small
  additive change to `Upload Input Images (v1)` (write the `agent_input_file_map` rows); `Sync Agent
  Definitions (v1)` swaps the `generate_image` custom tool for the `mcp_servers` entry (Block 5.3); the
  Block-4/Block-5 client-side image path is retained as the dormant rollback.

## Open risks the plan stays alert to

- **Block 0 may invalidate the pause/resume assumption** → Blocks 4–5 reshape toward a sidecar SSE consumer
  (the one place that would force custom build; flagged loudly if hit).
- **Static-system rule drift** (decision #3) is the chief new reliability hazard → Block 2's dead-man's-switch
  is load-bearing, not optional.
- **Anthropic-only multimodal input** changes the input path (Block 3) and means image input now runs on
  Claude, not Gemini — capability-neutral per the existing ADR-045 research, verified in Block 9's matrix.
- **Stateful sessions for multi-turn** are deliberately deferred (fresh session per run in v1).
- **(ADR-055) MCP tool-call timeout vs image-gen duration** is the chief new unknown: if the harness times
  out MCP tool calls below ~170s (gpt-image-2 high), image-via-MCP is infeasible → Block 5.1 gate kills
  5.2/5.3 and image stays on the verified client-side path. A new always-on image MCP endpoint is also a new
  operational/failure surface (covered by the Block-5.3 health dead-man's-switch).
- **(ADR-055) The client-side servicing loop is NOT retired** by this change — ADR-054's Google DWD tool
  needs it. Retiring it entirely (all-MCP) is gated on the session-context-to-MCP finding (Block 5.1) and is
  a separate future decision, not part of this plan.
- **(ADR-055, surfaced in Block 5.2) MCP-produced image bytes have no delivery carrier — a Block-6
  blocker.** Files-API uploads are `purpose=agent` → **not downloadable** (Block 0), and on the MCP path the
  produced base64 is consumed inside our endpoint and **does not return to n8n** (the harness gets only the
  `file_id`s, which the agent embeds). So when Block 6 turns the agent's block-array into a ClickUp delivery,
  it has the produced `file_id`s but **no way to fetch their bytes**. The client-side path (Block 5) avoided
  this by carrying `b64_json` back through n8n execution data; MCP severs that. **Block 6 must add a carrier**
  — e.g. the image MCP handler also persists each produced image's bytes to Supabase Storage (or an output
  `agent_output_file_map(file_id→signed_url)`), and the output adapter resolves produced `file_id`s → bytes
  from there — or this needs an ADR-055 amendment. This does not affect 5.2's isolation DoD (which returns
  `file_id`s only) but **must be resolved before MCP image delivery works end-to-end.**

## Verification (how each block and the whole is proven)

- Per block: `node scripts/test-subworkflow.mjs <id> --file ./input.json` to drive `When Called`
  sub-workflows (build the input JSON with Node, never hand-escaped); `node scripts/inspect-execution.mjs
  <execId>` for the per-node view; `node scripts/alerts-since.mjs <minutes>` to scan the Alerts channel;
  `node scripts/check-workflow-drift.mjs` after any live change; delete test `agent_runs` rows + disposable
  ClickUp test tasks afterward.
- Whole-system (Block 9): @-mention the agent on real `Lista testy AI` tasks covering text, image
  generation, image input, office-doc output, and a web-research-needing task; confirm the ClickUp comment,
  attachments, status flow, exactly-correct `agent_runs` cost rows, and a clean Alerts channel; confirm the
  bare lane still completes a task when `agent_lane=bare`.
