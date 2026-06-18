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
| 4 | `generate_image` custom-tool handler (wraps Generate Images Parallel via the reference_urls seam) | ☐ to do — **NEXT** |
| 5 | `Execute Agent Session (v1)` — the session loop servicing the custom tool callback | ☐ to do |
| 6 | Output adapter + session cost into Log Model Run | ☐ to do |
| 7 | Post Reply office-doc delivery (attachment + validation gate + erasure recording) | ☐ to do |
| 8 | Lane switch flag + orchestrator wiring + retire research workflows | ☐ to do |
| 9 | End-to-end cutover, GDPR record, current.md/ADR write-backs, supersede the file-output plan | ☐ to do |

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
- Migrations (append-only): `agent_routing` table (Block 2), optional `agent_runs` cost-breakdown columns
  (Block 6), `research_parameters` drop (Block 8).

## Open risks the plan stays alert to

- **Block 0 may invalidate the pause/resume assumption** → Blocks 4–5 reshape toward a sidecar SSE consumer
  (the one place that would force custom build; flagged loudly if hit).
- **Static-system rule drift** (decision #3) is the chief new reliability hazard → Block 2's dead-man's-switch
  is load-bearing, not optional.
- **Anthropic-only multimodal input** changes the input path (Block 3) and means image input now runs on
  Claude, not Gemini — capability-neutral per the existing ADR-045 research, verified in Block 9's matrix.
- **Stateful sessions for multi-turn** are deliberately deferred (fresh session per run in v1).

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
