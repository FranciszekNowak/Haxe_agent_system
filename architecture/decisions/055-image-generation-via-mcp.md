# ADR-055: Image generation via a self-hosted MCP tool server

Status: Accepted
Date: 2026-06-18
Supersedes (in part): ADR-053 decision point 5 (image generation exposed as a **client-side custom
tool** serviced by the n8n session pause/resume loop) and rejected-alternative R8 (which rejected an
image MCP partly on the incorrect premise that it bypasses our cost logging).
Amends: ADR-054's reference to "the image-tool session-stream listener" (image no longer uses the
listener; ADR-054's Google DWD tool still does).
Depends on: ADR-053 (Managed Agents lane), ADR-051 (parallel image batch), ADR-052 (reference-image
seam), ADR-035 (cost logging)
Beta surface: Anthropic Managed Agents `mcp_servers` (remote MCP over HTTP; credentials held in the
Vault and attached per session, proxied outside the sandbox)

## Decision (verdict first)

Image generation is exposed to the managed agent as a tool on a **self-hosted MCP server**, not as a
client-side custom tool. The agent calls `generate_image` in-harness; Anthropic's harness calls our MCP
endpoint synchronously; our handler runs the existing image lane (generation + Files-API upload + cost
logging) and returns the produced `file_id`s; the session resumes with **no n8n round-trip**. The image
lane below the MCP entry (`Generate Images Parallel (v1)`, the Files-API upload, the per-image
`Log Model Run` rows) is reused **unchanged**. The client-side custom-tool servicing loop in
`Execute Agent Session (v1)` is **retained** — not deleted — because ADR-054's Google DWD retrieval is a
client-side custom tool that needs it; image is simply removed as a registered custom tool. Retiring the
loop entirely (moving Google DWD to MCP too) is a larger, gated bet deferred to a future ADR.

## Context

ADR-053 §5 chose a client-side custom tool for image generation, serviced by the n8n session loop built
in ADR-053 Block 5 (`Execute Agent Session (v1)`). When the agent emits a `generate_image`
`custom_tool_use`, the session pauses (goes idle); n8n detects the pause by polling
`GET /v1/sessions/{id}/events`, runs the image workflow, POSTs a `user.custom_tool_result`, and the
session resumes. Block 5 verified this works end-to-end.

Review of that mechanism surfaced two real costs:

1. **Latency.** Because the transport is polling (Block 0 found no usable streaming consumer for n8n),
   each image round-trip adds a poll-interval to *detect* the pause plus another to *detect* the resume —
   on the order of several seconds of pure overhead per image-generation call, on top of the generation
   time itself.
2. **Complexity / brittleness.** Servicing the callback in n8n requires leaving the polling Code node to
   call a sub-workflow, which forces a self-recursion plus several `Merge` nodes and hand-rolled
   "is-it-paused / is-it-done" event analysis (a 29-node workflow with the sub-workflow return-determinism
   traps). This is the most intricate, bug-prone surface of the lane.

The R8 rejection of MCP in ADR-053 rested partly on "MCP bypasses our cost logging and the parallel
executor." That is **false for a self-hosted MCP server**: its tool handler is *our* code and can call
`Generate Images Parallel (v1)`, upload to the Files API, and write the per-image `agent_runs` rows
exactly as the n8n handler does today. The genuine cost of MCP is operating an **inbound, authenticated,
always-on endpoint** — not a loss of logging. This ADR corrects that premise.

**Interplay with ADR-054 (the decisive constraint).** ADR-054 routes ClickUp retrieval through the stock
ClickUp MCP (per-session Vault credential), but Google Drive/Gmail retrieval is a **client-side custom
tool** ("n8n, knowing the triggering user U, makes the impersonated domain-wide-delegation call as U",
ADR-054 §2), and ADR-054 R5 rejected passing the user-id to a hosted MCP because the agent could spoof
it. A client-side custom tool *is* the pause/resume loop. Therefore moving image to MCP does **not** let
us retire the loop — the loop remains load-bearing for the Google tool. Moving image off it reduces image
latency and keeps image out of the per-call round-trip, but near-term *total* complexity rises slightly
(the loop persists **and** a new MCP endpoint exists). Full loop retirement would require also making
Google DWD a self-hosted MCP, which depends on whether the harness passes session/correlation context to
MCP tool calls (needed to bind per-user identity unspoofably) — an unknown that a capability gate must
resolve and that reopens ADR-054's identity design. That larger bet is out of scope here (R4 below).

This ADR is also a down-payment on infrastructure ADR-054 needs anyway: the Vault + `mcp_servers` agent
plumbing and a self-hosted MCP host pattern.

## Decision detail

1. **Image as an MCP tool.** The four tier agents drop the `generate_image` **custom tool** and gain an
   `mcp_servers` entry pointing at our self-hosted image MCP server, which exposes one tool
   `generate_image{prompt, reference_file_ids?, count?, aspect_ratio?, size?}` (the same contract). The
   agent calls it in-harness; the harness invokes our endpoint and resumes on the response.

2. **Reuse the image lane unchanged.** The MCP handler resolves `reference_file_ids` → reference URLs (see
   §4), calls `Generate Images Parallel (v1)` (`2keb6XVWq5PG0leK`, the ADR-052 `reference_urls[]` seam),
   uploads each base64 result to the Files API (`purpose=agent`), and returns `{ file_ids[], message,
   status, warnings[] }`. Per-image cost rows are written by the batch's own `Log Model Run` path
   (mode=each) — **no second cost writer**. This is the Block-4 `Image Tool Handler (v1)` logic moved
   behind (or called by) the MCP entry.

3. **Host (build-vs-buy / Wardley).** **Prefer the n8n MCP Server Trigger** if it exists and works on our
   instance: then the MCP server is just another n8n workflow reusing credentials and `Generate Images
   Parallel` — zero new always-on service. **Fall back** to a thin self-hosted server (a Supabase Edge
   Function, or a small Node service on the VPS behind the existing reverse proxy) only if the n8n trigger
   is unavailable, or cannot hold the image-generation call duration. Decided by the capability gate.

4. **Reference resolution without session context.** Input-image uploads (ADR-053 Block 3,
   `Upload Input Images (v1)`) additionally record a global append-only mapping
   `agent_input_file_map(file_id PK, url, mime, source_ref, created_at)`. The MCP handler resolves
   `reference_file_ids` → URLs from that table, so it needs **no** session/correlation context (a key
   robustness property, since whether the harness passes such context to MCP calls is unknown). Anthropic
   input files are not downloadable (Block 0), so resolving via our own signed URL is required regardless.
   Signed URLs are valid within a session's lifetime; rows are pruned on a TTL.

5. **Auth (no per-user scope — this is the key difference from ADR-054).** Generating an image is
   **identity-neutral**: it reads no departmental data, so ADR-054's per-user-identity trap and R5 do
   **not** apply. A **fixed service bearer token** is correct: minted once, stored in the Anthropic Vault
   and attached per session (the same plumbing ADR-054 uses), validated at our endpoint, and mirrored in
   Supabase Vault for rotation.

6. **The client-side loop is retained.** `Execute Agent Session (v1)` keeps its pause/resume servicing
   loop because ADR-054's Google DWD tool will need it. Image is removed only as a *registered* custom
   tool, so the loop is dormant for image but live for the future Google tool.

7. **Failover / rollback.** The just-built client-side image path (the loop's tool-servicing branch +
   `Image Tool Handler (v1)` via `executeWorkflow`) is kept in git history and re-enableable by
   re-registering the `generate_image` custom tool on the agents — the documented rollback if the MCP path
   proves unreliable in production.

## Rejected alternatives

- **R1. Keep image as a client-side custom tool (the ADR-053/Block-5 status quo).** Lower infrastructure,
  already verified live, no new endpoint. Rejected — but narrowly — in favour of the harness-native model:
  it removes the per-image polling latency, makes image consistent with how built-in tools (web search)
  already work, and builds the MCP host muscle ADR-054 needs. The trade accepted is a new always-on
  authenticated endpoint. (Honest note: with the loop retained for Google either way, this is a close
  call; the latency and consistency wins, plus the ADR-054 plumbing reuse, tip it.)
- **R2. A third-party / hosted image MCP.** Loses our cost logging, the parallel executor, and the
  provider-agnostic `reference_urls[]` seam. Rejected (a self-hosted MCP keeps all of these).
- **R3. Direct sandbox HTTP from the agent's code execution to the image provider.** Bypasses the
  workflow, the executor, and cost logging, and needs unrestricted sandbox egress with our key inside the
  sandbox. Rejected (the original ADR-053 R8 reasoning, which still holds for *this* variant).
- **R4. Go all-MCP now: also move Google DWD to a self-hosted MCP and delete the loop entirely.** The
  bigger prize (genuinely retires the brittle loop, leaving `Execute Agent Session` as create → send →
  poll-to-idle → collect). Deferred, not chosen here, because it (a) depends on whether the harness passes
  session/correlation context to MCP tool calls — unproven — to bind per-user identity unspoofably, and
  (b) reopens ADR-054's accepted identity design. The capability gate (Block 5.1) records the
  session-context finding so this can be decided on evidence later.

## Consequences

- **Image path is harness-native and lower-latency** (no per-image polling round-trips). **Gating risk:**
  image generation can take ~170s (gpt-image-2 high effort); the harness's MCP tool-call timeout must
  tolerate that. If it does not, image-via-MCP is infeasible and we stay on the client-side path (R1) —
  this is the gate's kill criterion.
- **A new inbound authenticated endpoint to operate and monitor** — or, if the n8n MCP Server Trigger
  works, merely another n8n workflow (minimal new surface). Either way, a **health dead-man's-switch**
  (mirroring `Managed Agents Auth Monitor (v1)`) is added so a down image MCP cannot fail silently.
- **`Execute Agent Session (v1)` keeps its loop** for ADR-054 but no longer routes image through it; near-
  term total complexity rises slightly (loop + MCP endpoint) — accepted, because the loop is required for
  Google regardless and the image path becomes simpler and faster.
- **New table `agent_input_file_map`** and a small additive change to `Upload Input Images (v1)`.
- **Reliability:** image failures become MCP tool errors the harness surfaces to the agent; our handler
  still fails soft and logs cost. The per-image cost rows and the provider-agnostic seam are unchanged.
- **GDPR (ADR-053 Block 9):** the image MCP endpoint is a new processing surface / the agent's image
  prompts transit it — record it in the processing decisions.
- ADR-054's "reuses the image-tool session-stream listener" line is superseded; ADR-054's Google DWD tool
  remains a client-side custom tool on the retained loop.

## Amendment (2026-06-19) — ADR-053 Block 6: the image-bytes delivery carrier

The MCP path created a delivery gap: Files-API uploads are `purpose=agent` (not downloadable) and on the MCP
path the produced base64 is consumed inside our endpoint and never returns to n8n — the harness/agent gets
only the `file_id`. Block 6 resolves it with a **self-owned Supabase Storage carrier** (private bucket
`agent-output-images`): `Image Tool Handler (v1)` persists each produced image's bytes there keyed by its
Files-API `file_id` (in the shared handler, so both lanes populate it), and the new output adapter `Render
Agent Output (v1)` resolves produced `file_id`s → bytes from there for ClickUp delivery. Migration 037 prunes
the bucket at 24h (Storage REST DELETE, mirrors the zip-inner purge). **The carrier bucket is an additional
GDPR processing surface** (agent-produced images may carry personal data) — record it in the Block-9
processing decisions alongside the MCP endpoint.

Block 6 also corrected the managed-lane **image-output protocol** (`conventions_version` 2→3): the agents
must **call `generate_image` and reference the returned `file_id`** in `{type:image, mode:generate,
ref:<file_id>}` (no `prompt` in the output block). The bare-lane "emit a generate-with-prompt block and the
system generates it" convention does not work on the managed lane (no downstream generator); without this fix
the agent generated images via MCP but referenced none of them. Verified live. Detail: `block-6-findings.md`.
