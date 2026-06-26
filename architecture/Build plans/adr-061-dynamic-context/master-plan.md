# Master plan — ADR-061: Dynamic context loading via progressive disclosure

> **This is the durable, cross-desktop source of truth** (the `~/.claude` plan file does not travel
> between machines). Run the house block-by-block routine: read this file top to bottom, do the first
> not-done block, write back to `architecture/current.md` + ADR-061, update the status table, commit,
> emit a handoff, `/clear`, repeat. Decision record:
> `architecture/decisions/061-dynamic-context-loading.md`.

## Context (why)

A trivial request ("2+2") posted on a heavy ClickUp task currently exceeds **100,000 input tokens**,
confirmed in real executions. The cause is a single legacy holdover: **Stage A
(`assemble-context-and-build-prompt.json`) still pre-assembles everything** — the full 30+ comment
thread, the full parent chain, and all unpacked attachment text — because that is how the old bare
model call worked (it could not ask for more mid-run, so the spine loaded defensively).

ADR-053 (Managed Agents) and ADR-054 (per-user-scoped ClickUp retrieval) already removed that
constraint: the agent can pull what it needs mid-reasoning. **ADR-054 already built ADR-061's
"Block 2" infrastructure for *discovery*** — the hosted ClickUp MCP exposes 14 read tools
(`clickup_get_task`, `clickup_get_task_comments`, `clickup_get_threaded_comments`,
`clickup_get_document_pages`, …) and `extract_clickup_task` pulls attachment bytes, all per-user
scoped. So ADR-061 is **much smaller than its four-block text implies**: the real work is to
**stop pre-loading the tail and re-steer the agent to pull it**, plus close one regression gap.

**Intended outcome:** trivial-task floor drops from 100k+ to low thousands (and latency with it);
heavy tasks pay tool round-trips only for the material the request actually implicates.

This plan is written against the **live** repo state confirmed by exploration (the ADR-053 managed
lane, the ADR-054 scoped-MCP + `extract_clickup_task` seam, the three Stage-A pre-gather
sub-workflows, the `agent_routing`/`config` tables), not against the ADR alone.

## Decisions locked with the operator (2026-06-25)

1. **Triggering-task tail = bot-token tools, not per-user scoping.** The triggering task carries no
   permission risk that scoping would mitigate (the caller @-mentioned the agent there → has access;
   the bot Member has access; the data is byte-identical). Per-user scoping earns its keep only for
   open-ended discovery of *other* tasks. Bot-token wins on reliability (no external
   `mcp.clickup.com` dependency or per-user-token validity in the core path), latency (fewer hops, no
   remote MCP), maintenance (reuses the three existing pre-gather sub-workflows; one path for all
   users), and marginally cost. **Seam: triggering task → deterministic bot-token readers; other
   tasks → per-user scoped MCP (already live).** This matches ADR-054 master-plan decision #2, which
   already kept the triggering-task pre-gather on the bot token for the same reason.
2. **Block 3 (tier-additive cached system prefix) is DEFERRED** to a follow-up ADR. It is explicitly
   *not* for token savings (the ADR says so); the entire token win is in Block 1. It also needs 4
   tier-specific agent `system` variants, an unconfirmed harness cache-semantics gate, and reconciling
   a rules-doc duplication (Stage A loads CU doc `q7wz-16892` into the prompt while
   `Sync Agent Definitions` bakes `q7wz-44812` into `system`). Out of scope here.
3. **Attachments are lazy / on-pull.** `list_attachments` returns ClickUp's native metadata
   (name/size/mime) for free — no extraction. `get_attachment(ref)` runs Read Input for that ONE
   attachment on demand. Pays Docling/zip cost only for attachments the request implicates.
4. **Floor = global rules + personal prefs + triggering comment + task title + task description +
   impact line.** No separate "current checklist step" parsing — the description already carries the
   checklist; the agent reads the step from it. All users will be onboarded, so per-user discovery is
   universally available.
5. **Block 2b = Option E (lazy attachments floor), not the "re-thread pulled refs" plan.** Exploration
   (2026-06-25) found that Block 1 only removed the attachment *tokens* from the floor, not the
   extraction *latency*: Stage A's chain is linear and ungated, so `Call Read Input` still runs on the
   managed lane and Docling-extracts every document (12–20 s each), with `Build Prompt` then discarding
   the text. **The only thing keeping `Call Read Input` on the managed lane is producing the eager image
   blocks** — so eager input images are the last pin holding eager Docling in place. Both output paths
   that the earlier note feared breaking need *only metadata*, never bytes: `embed_input` resolves a
   `{source_ref,url}` ref list into a ClickUp `{type:attachment}` op (no re-upload, no file_id), and
   `reference_refs` resolves the agent's ref to the original ClickUp **URL** (the Files-API `file_id` is
   not used for it). The Files-API upload exists purely to give the model **vision**, which
   `get_attachment` already serves on demand (Block 2). So Option E: on the managed lane, build the
   image-metadata floor from the **ClickUp attachment index** (the same `GET /task` `list_attachments`
   uses — no Docling, no upload), drop `Call Read Input`, populate `agent_input_file_map` (source_ref→url)
   from that metadata so the MCP `reference_refs` path still resolves, keep the `# Załączone obrazy` ref
   list so embed/reference are round-trip-free, and make vision fully lazy. **Accepted regression:**
   images *inside ZIPs* are not in the ClickUp attachment index, so they lose eager embed/reference
   metadata (they become vision-only via `get_attachment`); reading them is unaffected, and that
   embed-of-zip-inner-image path was already shaky (a ClickUp inline `{type:attachment}` op needs a real
   ClickUp attachment id+url, which a Supabase-url'd zip-inner image lacks). Chosen over Option A
   (suppress vision blocks only) because A leaves eager Docling — the bigger latency prize — on the table
   and adds a permanent double-upload wart.
6. **Block 2c = progressive zip disclosure (the operator's requirement).** Whole-zip `get_attachment`
   still dumps every inner file at once, which defies ADR-061's purpose. The `zip-extractor` microservice
   (ADR-058, `services/zip-extractor/app.mjs`) already walks the archive entry-by-entry with `yauzl`
   lazy-entries and returns a per-entry manifest (`index,name,ext,mime,size,route,att_id=<zip>:<idx>,
   signed_url`); Docling/vision is applied **downstream per entry** in n8n. So the manifest is already
   separable from the expensive work. Add (a) a **manifest-only mode** (central-directory walk — names/
   sizes/types, no byte read, no upload, no sign — genuinely cheap) and (b) a **single-entry materialize**
   (`only_index=N` — read+upload+sign just that entry), sharing one walk fn so indices match between the
   two. Then `list_attachments` nests each zip's inner manifest inline, and `get_attachment("<zip>:<idx>")`
   pulls exactly one inner file. This recovers the regression from decision 5 *and* makes zip-open itself
   progressive. **Known minor cost:** the zip is downloaded once per distinct pull (manifest + each inner
   pull re-fetch) — fine at Haxe's archive sizes; an extractor-side disk cache is an easy later optimization.

## Key files

- **Stage A:** `n8n/workflows/assemble-context-and-build-prompt.json` (id `GGTBvFBgGSNbtUR6`) — the
  `Build Prompt` Code node and the `Call Assemble Task Context` / `Call Read Input` steps are what
  shrink.
- **Reused tail sources (wrapped as tools, not rebuilt):**
  `n8n/workflows/assemble-task-context.json` (id `eL3fJuRMpzVRuVUT`, comments + threaded replies),
  `n8n/workflows/assemble-parent-context.json` (id `qgM37HdQj78Rn090`, ancestor chain + impact),
  `n8n/workflows/read-input.json` (id `zgGpONulGMohQQqI`, Docling/zip extraction),
  `n8n/workflows/upload-input-images.json` (id `2VkZN5UeqVk6MDLW`, Files-API for vision).
- **Tool loop:** `n8n/workflows/execute-agent-session.json` (id `Rtb1cZbmUqmfGD98`) — add tool-routing
  branches beside the existing `Is extract_clickup_task?` branch.
- **Tool/steering registration:** `n8n/workflows/sync-agent-definitions.json` (currently CONV=8) —
  add the new tools + steering, bump CONV, re-sync the 3 routed agents (Haiku/Sonnet/Opus).
- **Pattern to mirror:** `extract_clickup_task` (custom tool → `clickup-extract-tool-handler.json`,
  id `y985MgyA5lCxOFCH`) is the exact template for a client-side tool that returns a
  `user.custom_tool_result` content array.
- **Cost/alerts:** `Log Model Run (v1)` (sole `agent_runs` writer), `Post Alert (v1)` seam (ADR-025).
- **ADR:** `architecture/decisions/061-dynamic-context-loading.md` (note: line-1 title says
  "ADR-060" — typo, fix in write-back). Doc to reconcile: `architecture/current.md` §15.2 + §15.5.

## Block status

| # | Block | State |
|---|---|---|
| 0 | Capability gates: prove lazy single-attachment extraction works mid-session (G2); measure floor size + one round-trip latency (G3) | ✅ **done 2026-06-25** — `block-0-findings.md`. **No reshape.** G2: extraction primitive live (Read Input Docling 12–20 s) + mid-session `user.custom_tool_result` delivery already proven by `extract_clickup_task` (Block 4b); single-attachment filter = one-line `att_id` skip in `Explode Attachments`. G3: floor ≈ 5–7k tok with rules in the uncached floor (real decomposition of exec 3767); the 100k→floor win is the removed tail (heavy doc text + 30+ comment thread). Latency: comments/parents <1 s, document extraction 12–20 s (lazy, one at a time). **Two carry-forwards to Block 1:** (a) verify CU doc `q7wz-16892` (per-run rules fold) vs `q7wz-44812` (cached `system` rules) overlap — if they overlap, drop the redundant per-run rules fold on the managed lane → floor falls to true low-thousands without Block 3; (b) lane-aware guard keeps the bare lane on full assembly. |
| 1 | Floor assembler — shrink Stage A's prompt string to the floor; lane-aware guard (managed → floor, bare → full) | ✅ **done 2026-06-25** — `block-1-findings.md`. New `Read Lane (Stage A)` Postgres node (fail-safe to bare); `Build Prompt` rewritten lane-aware: managed → floor (personal prefs + triggering comment + new `# Waga zadania` impact line + title/desc + eager images), drops tail (comments, parent bodies, leaves, semantic ctx, attachment text) **and** the per-run global-rules fold (carry-forward (a): same `q7wz-44812` page already baked into cached `system`; verified current via freshness check 3819 — sha match, stale=0). Bare lane unchanged (gates are `!floorOnly`). Live: exec 3835 (task `869dux9ne`) floor = **~3.4k tok vs ~9.6k** before, floor-only sections confirmed; drift clean; validation passes. **Carry-forward to ADR consequences:** managed rules currency now depends on sync+freshness (no per-run net) — recorded in ADR-061 + current.md. **Op note:** freshness check WARNs sync hasn't run in 26h (content still matches) — pre-existing, flag the Sync schedule. **Images kept eager** (deferred to Block 2 with `get_attachment`, so no blind window). |
| 2 | Triggering-task tail readers as bot-token custom tools (`get_task_comments`, `get_parent_chain`, `list_attachments`, lazy `get_attachment`) via one `Triggering Task Tail Handler (v1)`; register + steer (CONV→9) | ✅ **done 2026-06-25** — `block-2-findings.md`. New `Triggering Task Tail Handler (v1)` (`Ouo0BlYOw92DUXIh`): Switch on `tool_name` → reused `Assemble Task Context`/`Assemble Parent Context`/bot `GET /task` index/`Read Input` single-attachment (`only_att_id`) + `Upload Input Images`; side-branch `Post Alert` WARN; single branch-free `Return`. Routed in `Execute Agent Session` via new `Is tail tool?` beside `Is extract_clickup_task?` → `Call Tail Handler` → `Build Tail Result Text` → `Merge Result` (now 4 inputs), scope-pinned to the carried `clickup_task_id`. `Read Input` gained backward-compatible `only_att_id` filter. Registered + steered on 3 agents via `Sync` (CONV→9, `all_synced=true`). **Live-verified** all 4 tools on real task `869dux9ne` (5-attachment index; 7.3k-char DOCX; PNG→vision `file_id`; 11 comments w/ threaded replies; "no parents" no false WARN); bogus id → "not found" + 1 `tail-attachment-empty` WARN, no abort; missing id → guidance, no WARN. Drift clean (38/38). **Image laziness deferred to Block 2b (see below).** **Residual for Block 3:** the `Execute Agent Session` tail-routing is verified structurally (drift-clean, mirrors the proven extract path) but not yet by an agent-driven full-spine run — Block 3's e2e confirms the agent actually calls a tail tool. |
| 2b | **Lazy attachments floor (Option E)** — drop eager `Call Read Input`/Docling from the managed floor; build the image-metadata floor from the ClickUp attachment index (no extraction, no eager Files-API upload); vision goes fully on-demand via `get_attachment`; populate `agent_input_file_map` (source_ref→url) from metadata so `reference_refs` resolves; keep the `# Załączone obrazy` ref list so `embed_input`/`reference_refs` work round-trip-free. n8n-only, no microservice risk. | ✅ **done 2026-06-26** — `block-2b-findings.md`. Stage A lane-branched: new `Is Managed? (Stage A)` IF → managed: `Fetch Attachment Index (Stage A)` (bot `GET /task`, no Docling, no eager upload); bare: `Call Read Input` (unchanged) → `Merge Input Source` → `Build Prompt` (managed image floor built from the attachment index; `# Załączone obrazy` reworded "listed, not preloaded — call get_attachment"; `read_input_ok=true` on managed). Orchestrator: on `Lane = managed?` TRUE → `Build Floor File Map` (records `{file_id:"att_"+source_ref, url:ref, mime, source_ref}` from `image_blocks_json`) → `Upsert File Map (Managed)` (reuses the upsert SQL; `onError continueErrorOutput` → `Alert File Map Failed` WARN reconverging; `alwaysOutputData` so 0-image runs still feed the session) → `Call Execute Agent Session`; session inputs switched to `$('Call Assemble Context')` refs and **`input_images_json='[]'`** (drops the eager Files-API vision upload). `Sync` CONV 9→10 + lazy-image steering; `all_synced=true` (5 tiers). **Live-verified** task `869dux9ne` (2 PNG + 2 ZIP + 1 DOCX): managed floor took the index path (**`Call Read Input` did NOT run → no Docling**), floor ~10k chars; full spine exec 3910 — file_map rows written for both PNGs, no eager upload, agent **saw + described the image via `get_attachment`** (lazy vision — not blind), 0 alerts; `embed_input` → ClickUp inline-attachment op (exec 3926); `reference_refs` resolution proven (row `source_ref`→`url` + resolver SQL `where source_ref in (...)`). Drift clean (38/38). **Bare lane:** structurally verified (new sub-path = IF-false + Merge passthrough; Build Prompt bare branch unchanged, reads `Call Read Input` directly) — a runtime bare re-test was deferred because flipping shared prod `config.agent_lane` was correctly access-denied. zip-internal-image *output*-path regression accepted by operator. |
| 2c | **Progressive zip disclosure** — extend the `zip-extractor` microservice with a cheap manifest mode (central-directory walk only — no read/upload/sign) + single-entry materialize (`only_index`); `list_attachments` nests each zip's inner manifest inline (`<zip>:<idx>` refs); `get_attachment("<zip>:<idx>")` pulls exactly one inner file. Removes the whole-zip over-fetch on zip-open. | ✅ **done 2026-06-26** — `block-2c-findings.md`. `zip-extractor` walk refactored into one shared fn driven by `manifest_only` + `only_index`; **entry `index` assigned before the caps → cap- and mode-independent**, so a manifest `<zip>:<idx>` is a valid single-pull arg (proven by a local walk test). `Read Input` `Explode Attachments` parses `only_att_id="<zip>:<idx>"` (base-id match + `only_inner_index` → `Zip Caps` → `Call Extractor` `only_index`); full materialize-all path unchanged. Tail handler `list_attachments` gained `Build Zip Manifest Reqs → Is Zip Req? → Fetch Zip Manifest (manifest_only) → Merge Manifests`, and `Build Attachments Result` nests each zip's inner manifest inline; `get_attachment("<zip>:<idx>")` pulls one inner file. `Sync` `CONV 10→11` + zip steering (`all_synced=true`, 5 tiers). **Live-verified** task `869dux9ne` (two product-image zips): `list_attachments` nested 23 + 16 inner PNGs with **no extraction/upload** (0 alerts); `get_attachment("<zip>:13")` returned **exactly one** PNG as vision ("0 dok., 1 obr."); bad inner index `:999` → `inner_index_not_found` + 1 `tail-attachment-partial` WARN, no abort; top-level DOCX pull unchanged (Docling text). Drift clean (38/38); service redeployed + `/health` ok. **Known limit:** zip-inner images are now vision-accessible but still not in `embed_input`/`reference_file_ids`. **Known cost:** zip re-downloaded per distinct pull. **Follow-on (operator, 2026-06-26):** tail handler `list_attachments` now reads **live** config caps (new linear `Lookup Zip Caps (Tail)` node) instead of relying on defaults; and the **task description is no longer eager** on the managed floor — `Build Prompt` keeps only the title + a hint to call the new 5th tail tool **`get_task_details`** (bot `GET /task`), bare lane keeps it inline; `Sync` `CONV 11→12`. Live-verified (floor ~10k→5.4k chars, description gone; `get_task_details` returns it; `list_attachments` still nests 39 with live caps; 0 CRITICAL; drift clean). |
| 3 | End-to-end + scope test (the 100k case rerun); write-backs (current.md §15, flip ADR Accepted, fix title typo, record deferred additive-prefix follow-up) | ✅ **done 2026-06-26** — `block-3-findings.md`. Full spine driven via orchestrator `When Called` (`a8XKaijkMFNBpRBa`) with the producer's exact inputs on heavy task `869dux9ne`. **(1) Trivial-on-heavy** ("2+2"): Stage A floor = **5,409 chars (~1.35k tok)** (prefs + triggering comment + impact + title + `get_task_details` hint; no description/comments/attachment text); session **single turn, zero tail tools** (`input_tokens=2`, `cache_read=0`); answered "4"; exec 3969. The 100k→floor win realized — **2 uncached input tokens** (rules in cached `system`) vs Block-0 G3's ~6.8k-tok floor-with-rules. **(2) Heavy** (4-part request): agent pulled **only implicated** material via four tail round-trips — `get_task_details` (3988), `list_attachments` (3990, both zips' inner manifests nested), `get_task_comments` (3992), `get_attachment("…zip:5")` (3995, exactly one inner PNG as vision); answered all parts correctly; exec 3982, `cache_read=98299` re-read across the loop (G1 re-use confirmed). **Runtime-confirms the two earlier structural-only items:** agent reliably pulls the description via `get_task_details`, and the loop services a `<zip>:<idx>` inner pull end-to-end. **(3) Scope:** per-user scoped `clickup_*` MCP + `extract_clickup_task` (caller vault credential) untouched; tail tools pinned to n8n-supplied `clickup_task_id` (agent passed only `attachment_id` — can't widen). Full ADR-054 Block 5 two-dept live negative **not** re-run (orthogonal/unchanged mechanism — flagged). **(4)** 0 CRITICAL / 0 WARN (`alerts-since`), execs inspected node-by-node, **drift clean (38/38)**; cost rows attributed via `Log Model Run`; test `agent_runs` rows 654/655 deleted. **Write-backs:** ADR-061 line-1 typo `ADR-060→ADR-061` fixed, Status `Proposed→Accepted`, Block-3 + deferred consequences added; `current.md` §15.2 Block-3 note added; **ADR-062** (tier-additive cached prefix) created as a Proposed deferred follow-up. **Bare failover lane:** runtime coverage still deferred (prod `config.agent_lane` flip is access-gated; structurally unchanged — operator may supervise a flip for runtime coverage). |

Each block ends with: write-back to `current.md` + ADR-061, status-table update, commit, handoff.
Live verification (not "looks right") per Definition of Done; all alerts through `Post Alert (v1)`;
never read or post-watch the Alerts task `869dj2z2c`; migrations append-only; exported workflow JSON
re-exported after any live change, never hand-edited (preserve curated node `notes` + any
`toolWorkflow` `schema[]` the exporter strips).

## The blocks

### Block 0 — Capability gates

Resolve before cutting Stage A. (G1's tier-cache gate is deferred with Block 3.)

- **G2 — lazy single-attachment extraction works mid-session.** Confirm `Read Input (v1)` can be
  driven for **one** attachment id (filter/param) and return its text + (for images) a Files-API
  `file_id` vision block, returned as a `user.custom_tool_result` inside the 840s poll loop. Largely
  de-risked: `extract_clickup_task` already proves a custom tool can extract a task's attachments
  mid-session; this narrows it to a single attachment on the **bot** token.
- **G3 — floor size + round-trip latency.** Measure the floor token count on a representative heavy
  task (target: low thousands) and the wall-clock of one tail tool round-trip (to size heavy-task
  cost).

**DoD:** single-attachment bot-token extraction returns correct content mid-session; floor size and
per-round-trip latency measured and recorded in `block-0-findings.md`.

### Block 1 — Floor assembler

Reduce the prompt string `Build Prompt` emits to the **floor only**: global rules + personal prefs +
triggering comment + `current_task.name` + `current_task.description` + an impact line. **Stop
injecting** `task_comments`, the ancestor-chain bodies, `additional_context`, attachment text blocks,
and upfront `image_blocks_json`.

- **Keep** the metadata fields Build Prompt already returns (impact, `clickup_task_id`,
  `caller_user_id`/`reviewer_user_id`, `triggering_comment_id`, assignee/creator for the autonomous
  rule, `process_type`) — only the prompt **string** shrinks, not the payload contract.
- **Keep** `Call Assemble Parent Context` running (it resolves the impact custom field + assignee/
  creator that routing and the autonomous-caller rule need) — just don't fold the ancestor **bodies**
  into the prompt.
- **Lane-awareness (shared-workflow guard).** Stage A is shared by both lanes and the bare (dormant)
  lane cannot pull tools. Gate the tail assembly on lane: read `config.agent_lane` early in Stage A;
  **managed → floor only**, **bare → keep today's full assembly** (so the emergency failover keeps its
  current behavior). One IF, reversible, documented as an ADR-061 consequence — not a silent
  half-cutover.

**DoD:** a trivial task on a heavy parent produces a low-thousands prompt and a correct answer with
**zero** tail tools called; the bare-lane path still receives full context; `Context OK?` guard and
the existing CRITICAL/WARN seams still fire correctly.

### Block 2 — Triggering-task tail readers as bot-token tools

Expose the triggering task's tail as **client-side custom tools** (mirroring `extract_clickup_task`),
routed in the `Execute Agent Session` poll loop, all on the **bot** token and scoped to the
triggering `clickup_task_id` (n8n-supplied; the agent cannot widen the scope):

- `get_task_comments` → reuse `Assemble Task Context (v1)` (comments + interleaved threaded replies).
  Optional `limit`/`since`. (Metadata-first `comment_summary` deliberately **not** built — for a
  5-person system a bounded comment fetch is cheap; revisit only if measurement shows over-pulling.)
- `get_parent_chain` → reuse `Assemble Parent Context (v1)`, depth-bounded titles/descriptions.
- `list_attachments` → ClickUp native attachment index (name/size/mime). **No extraction.**
- `get_attachment(attachment_id)` → run `Read Input (v1)` for that one attachment (Block-0
  single-attachment mode), reusing `Upload Input Images (v1)` for image vision; return text/vision as
  a `user.custom_tool_result`.

Implementation shape: **one** new handler sub-workflow `Triggering Task Tail Handler (v1)` with a
Switch on tool name → the right reused sub-workflow → shape the result (one workflow, one return
terminal — respects the branch-free sub-workflow-return rule). Add the matching routing branches in
`Execute Agent Session` beside `Is extract_clickup_task?`. Register the four tools + steering ("the
triggering task's own comments/parents/attachments are now pull-on-demand via these tools; use the
scoped `clickup_*` MCP for OTHER related tasks") on the 3 agents via `Sync Agent Definitions`
(bump CONV to 9).

**Reliability (mandatory, ADR-025 / CLAUDE.md):** every tail handler fires a `Post Alert (v1)` **WARN
on a side branch** on failure (Docling failure, bot-token read failure, empty-when-shouldn't-be) and
returns a structured error to the agent — never a silent empty. The handler sub-workflow sets
`Error Handler (v1)` as its `errorWorkflow`. **Knowingly uncovered:** the agent *choosing not* to pull
context it should is a quality risk no thrown error can detect — stated, not silently ignored.

**DoD:** each tool returns correctly for the triggering task on the bot token; a failed pull WARNs
without aborting the run; `extract_clickup_task` + the scoped `clickup_*` MCP still work for
other-task discovery; no cross-department leak (triggering-task tools are pinned to the supplied id).

### Block 2b — Lazy attachments floor (Option E)

Finish what Block 1 started: stop the managed floor paying for *any* attachment extraction. n8n-only —
no microservice change.

- **Drop `Call Read Input` on the managed lane.** Today it runs unconditionally and Doclings every
  document just so `Build Prompt` can read its image blocks (then discards the text). Gate it by lane
  (managed → skip; bare → keep, the failover needs full assembly). The lane is already read by
  `Read Lane (Stage A)`.
- **Build the image-metadata floor from the ClickUp attachment index** (the same `GET /task` that
  `list_attachments` uses): for each **top-level** image attachment emit `{source_ref=attachment_id,
  url, mime, alt=filename}` into `image_blocks_json`. No Docling, no eager Files-API upload.
- **Keep the `# Załączone obrazy` ref list** in the floor prompt (cheap text) so the agent can
  `embed_input`/`reference_refs` without a round-trip; reword it to say the images are *not* preloaded as
  vision — call `get_attachment` to actually see one.
- **Make vision lazy** — the eager Files-API upload of input images is dropped on the managed lane;
  `get_attachment` (Block 2) already returns a Files-API vision block on demand.
- **Keep `reference_refs` working** — populate `agent_input_file_map` (source_ref→url, mime) from the
  same metadata (no upload; the MCP resolver matches `source_ref` and the external generator needs the
  URL, not a `file_id`). Decide the write point (Stage A vs. Stage B `Build Setup`) during build; reuse
  the existing `Upsert File Map` Postgres node shape with a synthetic/placeholder `file_id` if needed.
- **`embed_input` is untouched** — `Render Agent Output`'s `input_image_refs_json` is still
  `image_blocks_json`, now sourced from the attachment index.
- **Steering** (`Sync Agent Definitions`, bump CONV): "attached images are listed but NOT preloaded as
  vision — call `get_attachment(attachment_id)` to see one; their refs for embed/generate are in the
  message." Re-sync the 3 agents.

**Reliability:** attachment-index fetch failure → `Post Alert (v1)` WARN on a side branch, floor still
emits (degrade, don't break). Bare lane unchanged. **Knowingly uncovered:** the agent not pulling an
image it should — no thrown error detects it (same standing risk as Block 2).

**DoD:** a trivial task with image+doc attachments produces a floor with **no Docling latency**, no eager
upload, zero tail tools called, and a correct answer; the floor still lists the attachments; `embed_input`
of a top-level image and `reference_refs` (packshot) both still render correctly when the agent uses them;
bare lane still gets full assembly; drift clean; touched workflows re-exported.

### Block 2c — Progressive zip disclosure

Make zip contents progressively disclosed instead of whole-zip-at-once. Microservice + n8n; sequenced
after 2b (separate risk surface).

- **`zip-extractor` (`services/zip-extractor/app.mjs`):** refactor the entry-walk into one shared fn,
  then expose: (a) **manifest mode** — walk the central directory and return
  `[{index,name,ext,mime,size,route,att_id:"<zip>:<idx>"}]` with **no** `openReadStream`/upload/sign
  (cheap); (b) **single-entry materialize** — `only_index=N` reads+uploads+signs just entry N and returns
  its one-entry manifest. Keep the junk-skip/drop rules identical across both so `<zip>:<idx>` is stable
  between list and pull. Preserve the `/extract` (materialize-all) contract for the bare lane / existing
  callers. **Deploy:** `services/zip-extractor` change → VPS `docker compose up -d zip-extractor`
  (ADR-033); `GET /health` after.
- **`list_attachments` (Triggering Task Tail Handler):** for each attachment whose ext/mime is a zip,
  also call the extractor manifest mode and nest its entries inline under the zip (indented, with their
  `<zip>:<idx>` attachment_ids + sizes/types). One cheap call reveals the whole tree.
- **`get_attachment("<zip>:<idx>")` (Read Input single mode):** detect the inner-ref form (the `:`),
  route to the extractor single-entry materialize for that index, then Docling (doc) or vision-reference
  (image) **only that one** file. Top-level `attachment_id` (no `:`) keeps Block 2's behavior.
- **Steering:** note that zip attachments expand to inner files in `list_attachments` and one inner file
  is pulled by its `<zip>:<idx>` id.

**Reliability:** manifest-mode failure / corrupt archive → the existing `zip_extraction_failed` graceful
drop + `Post Alert (v1)` WARN; a bad `only_index` → structured "not found" result (mirror Block 2's bogus-id
path), no abort. Handler keeps its single branch-free return.

**DoD:** `list_attachments` on a task with a multi-file zip shows the inner manifest (no extraction);
`get_attachment("<zip>:<idx>")` returns exactly that one inner file (doc→text or image→vision), provably
not touching the other entries; corrupt zip and bad index degrade with a WARN, no abort; bare-lane
`/extract` path still works; drift clean; microservice redeployed and `services/zip-extractor` committed.

### Block 3 — End-to-end + scope test (was ADR-061 Block 4)

Rerun the original 100k case and the heavy/trivial split:

1. **Trivial-on-heavy:** small floor, **zero** tail tools called, correct answer, low-thousands prompt
   (compare against the Block-0 G3 baseline).
2. **Heavy task:** agent sees the cheap `list_attachments`/comment count, pulls only the implicated
   comment(s) and attachment(s), stays correct; cost rows attribute correctly via `Log Model Run`.
3. **Other-task discovery** still permission-scoped per-user (onboarded user sees only their scope;
   cross-dept negative check still passes — unchanged from ADR-054 Block 5).
4. **Alerts clean** (`scripts/alerts-since.mjs`), executions inspected node-by-node
   (`scripts/inspect-execution.mjs`), drift-clean (`node scripts/check-workflow-drift.mjs`).

**DoD (+ write-backs):** trivial floor confirmed low-thousands; heavy pulls correct and scoped;
`architecture/current.md` §15.2 + §15.5 reconciled (Stage A = floor + lane guard; tail = bot-token
on-demand tools); ADR-061 flipped to **Accepted**, line-1 title typo fixed, Block 3-additive-prefix
recorded as a **deferred follow-up ADR**; per-block findings files in this dir; each block committed.

## Verification (how to test end-to-end)

Per CLAUDE.md Definition of Done — autonomously before handing back:

- **Drive the spine** via `scripts/test-subworkflow.mjs <orchestrator-When-Called-id> --file ./input.json`
  with the producer's exact inputs (`triggered_by=explicit_mention`, `invocation_type=explicit`, a real
  `reviewer_user_id`). Build `input.json` with Node (`JSON.stringify`), project-relative path — never a
  hand-escaped heredoc, never the Form Trigger over the API (both documented foot-guns).
- **Two probe tasks on a disposable ClickUp task:** (a) a trivial comment ("2+2") on a task loaded with
  30+ comments + a PDF + an XLSX → expect floor-only prompt, zero tail tools; (b) a request that needs
  a specific attachment → expect `list_attachments` then a single `get_attachment` pull.
- **Inspect** the execution node-by-node (`scripts/inspect-execution.mjs <execId>`) — confirm Stage A
  emitted the floor, the session called exactly the implicated tools, no silent fallback.
- **Scan alerts** (`scripts/alerts-since.mjs <minutes>`) — any WARN/CRITICAL is a failure until
  explained.
- **Check `agent_runs`** cost rows for the test runs, then **delete test rows + the disposable ClickUp
  task** afterward (ClickUp has no delete-attachment API → prefer a fresh disposable task).
- **Drift check** clean before each commit; re-export touched workflows via `export-workflows.mjs`.
