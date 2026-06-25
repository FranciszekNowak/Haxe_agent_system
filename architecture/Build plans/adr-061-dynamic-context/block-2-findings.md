# Block 2 findings — ADR-061 triggering-task tail readers as bot-token tools

Date: 2026-06-25. The tail that Block 1 dropped from the managed floor is now four pull-on-demand
custom tools the agent calls on the retained `Execute Agent Session` loop.

## What was built

1. **New `Triggering Task Tail Handler (v1)`** (`Ouo0BlYOw92DUXIh`, active). One sub-workflow,
   `When Called(tool_name, clickup_task_id, tool_input_json)` → **Switch on `tool_name`** → the right
   reused reader → a per-tool `Build … Result` → `Merge Result` (5 inputs) → side-branch
   `Should Warn? → Post Alert` (reconverging) → single branch-free `Return` (re-reads `Merge Result`).
   Output contract mirrors the extract handler: `{ status, tool_result_content_json, new_images_json:'[]',
   new_warnings_json:'[]' }`.
   - `get_task_comments` → `Assemble Task Context (v1)` (comments + interleaved threaded replies). Optional
     `limit`/`since`.
   - `get_parent_chain` → `Assemble Parent Context (v1)` (ancestor titles/descriptions, general→nearest).
     Optional `depth`.
   - `list_attachments` → bot `GET /api/v2/task/{id}` → native attachment index (attachment_id, title,
     mime, size). **No extraction.**
   - `get_attachment` → `Read Input (v1)` single-attachment mode + `Upload Input Images (v1)` for image
     vision. Missing `attachment_id` → guidance result (no WARN); id-not-found → "not found" result + WARN.
   - All reads on the **bot token**, **scoped to the n8n-supplied `clickup_task_id`** — the agent passes
     only `limit`/`since`/`depth`/`attachment_id`, never a task id, so it cannot widen scope. Other-task
     discovery stays on the per-user scoped `clickup_*` MCP (unchanged).

2. **`Read Input (v1)` gained `only_att_id`** (backward-compatible). New `When Called` input; `Explode
   Attachments` skips every attachment whose `att_id`/`id` ≠ `only_att_id` when it is non-empty (the index
   still increments so the kept attachment keeps its global order; no match → the existing no-attachment
   passthrough → `blocks:[]`). Empty `only_att_id` → all attachments, exactly as before (the as-U extract
   handler, Stage-A pre-gather, and the Form-Trigger harness are unaffected — they never pass it).

3. **`Execute Agent Session (v1)` routing.** New **`Is tail tool?`** IF (combinator OR, the four names)
   inserted on the FALSE branch of `Is extract_clickup_task?` (its prior target, `Build Error Result Text`,
   becomes `Is tail tool?`'s FALSE branch — unknown tools still answered). TRUE → **`Call Tail Handler`**
   (`clickup_task_id` from the **carried** state, not the agent input) → **`Build Tail Result Text`**
   (mirrors `Build Extract Result Text`) → `Merge Result` **input 3** (`numberInputs` 3→4). `Post Tool Result`
   posts the content array verbatim, unchanged.

4. **Registration — `Sync Agent Definitions (v1)`, CONV 8→9.** Four `custom` tool defs added inline to
   `Build System`'s `tools[]` (now 8 tools); a steering bullet added to the system prompt explaining the floor
   no longer carries the tail and these four tools pull it on demand (and that `clickup_*` MCP + `extract_clickup_task`
   remain for OTHER tasks). `CONV=9` forces every agent to re-version.

## Reliability (ADR-025 / CLAUDE.md)

- Each handler failure mode (comments/parents/attachments sub-call failure, get_attachment empty/partial,
  unknown tool) fires **one WARN via `Post Alert (v1)` on a side branch** and returns a **structured error to
  the agent** — never a silent empty. To avoid double-firing, the handler returns `new_warnings_json='[]'`
  (it already alerted in-band); the session's consolidated alert path only fires if the handler returned
  *nothing at all* (total `onError` failure). The reused `Assemble Task Context` keeps its own
  comment/reply side-branch alerts (complementary, not duplicate — its failure path returns `task_comments:[]`,
  which the handler does **not** re-warn).
- `errorWorkflow = Error Handler (v1)` set on the handler. Branch-free return terminal preserved
  (`Return` re-reads `Merge Result`, the alert side-trip reconverges at `Merge Tail`).
- **Knowingly uncovered:** the agent *choosing not* to pull context it should — no thrown error can detect it.

## Live verification (handler-level, real task `869dux9ne`)

Driven via `scripts/test-subworkflow.mjs Ouo0BlYOw92DUXIh`:

| tool | result |
|---|---|
| `list_attachments` | `ok` — 5 attachments (2 PNG, 2 ZIP, 1 DOCX) with ids/mime/size + pull guidance |
| `get_attachment` (DOCX) | `ok` — 7.3k-char Docling text, **single-attachment** scoped (`1 dok., 0 obr.`) |
| `get_attachment` (PNG) | `ok` — `{type:image, source:{type:file, file_id:file_011CcPvaCgrTRf7jaei6DiJe}}` vision block |
| `get_task_comments` | `ok` — 11 comments with interleaved `↳` threaded replies |
| `get_parent_chain` | `ok` — "no parents" message, **no false WARN** |
| `get_attachment` (bogus id) | `empty` — structured "not found, check list_attachments"; **did not abort** |
| `get_attachment` (missing id) | `error` — guidance to call list_attachments first; **no WARN** |

`scripts/alerts-since.mjs` in-window: exactly **1 WARN** (`managed-agents/tail-attachment-empty` for the bogus
id), 0 CRITICAL — confirming the side-branch alert fires on real failure and stays silent on success / legit-empty
/ agent-input-error. `Sync` run: `all_synced=true, total=5, stale_tiers=''`. Drift clean (38/38), all touched
workflows re-exported.

## Deferred: lazy input images (new Block 2b)

The user instructed "make input images lazy," but the naive change (zero `image_blocks_json` on the managed
lane) **silently breaks two live output capabilities**, because that field fans out to three consumers:
1. `input_images_json` → the eager Files-API upload (vision + the `file_map` that **`reference_refs`** resolves
   against at image generation — product-faithful packshots);
2. `input_image_refs_json` → `Render Agent Output`'s **`embed_input`** lookup (re-embedding an original
   attachment into the reply);
3. the `# Załączone obrazy` prompt section.

`get_attachment` restores *vision* but not (1)/(2), which resolve before/after the session against Stage A's
ref list. Doing it right means threading pulled-image refs back into the session `file_map` **and** the
render-output embed lookup — plumbing across `Execute Agent Session`, the orchestrator, and `Render Agent
Output`. Operator decision (2026-06-25): **keep images eager (no regression), split lazy-images into its own
block (2b), explore a simpler architecture there.** Recorded in ADR-061 consequences + the master-plan status table.

## Residual for Block 3

The `Execute Agent Session` tail-routing (`Is tail tool? → Call Tail Handler → Build Tail Result Text →
Post Tool Result`) is verified **structurally** (drift-clean; it mirrors the proven `extract_clickup_task`
path node-for-node) but **not yet by an agent-driven full-spine run**. Block 3's e2e (the 100k rerun) is where
a real session confirms the agent actually emits a tail `custom_tool_use`, the loop services it, and the result
lands — plus the trivial-on-heavy (zero tail tools) and heavy (pull only the implicated items) splits.

## DoD

- ✅ Each tool returns correctly for the triggering task on the bot token (live).
- ✅ A failed pull WARNs via `Post Alert (v1)` on a side branch without aborting (live: bogus id).
- ✅ `extract_clickup_task` + the scoped `clickup_*` MCP untouched (routing only redirects the extract-FALSE
  branch; the MCP toolset is unchanged in `Build System`).
- ✅ No cross-department leak — the tools are pinned to the carried `clickup_task_id`; the agent supplies no
  task id (structural, like Block 1's bare-lane verification).
- ✅ Registered on 3 agents (CONV=9, `all_synced=true`); drift clean; touched workflows re-exported.
