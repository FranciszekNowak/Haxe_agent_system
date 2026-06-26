# Block 2b findings — ADR-061 lazy attachments floor (Option E)

Date: 2026-06-26. Block 1 removed the attachment *tokens* from the managed floor but not the extraction
*latency*: Stage A's chain was linear and ungated, so `Call Read Input` still Docling-extracted every
document on the managed lane only to feed `Build Prompt`'s image blocks (then discarded the text). Option E
removes that last pin — the managed floor now builds its image metadata from the cheap ClickUp attachment
index, and input-image vision goes fully on-demand via `get_attachment`.

## What was built

1. **Stage A (`assemble-context-and-build-prompt.json`, `GGTBvFBgGSNbtUR6`, 12→15 nodes) — lane-branched
   input source.** New **`Is Managed? (Stage A)`** IF after `Load Agent Rules` reads the lane (fail-safe to
   bare):
   - **managed (TRUE)** → **`Fetch Attachment Index (Stage A)`** — bot `GET /api/v2/task/{id}` for ClickUp's
     native attachment index (the same endpoint `list_attachments` uses). `onError=continueRegularOutput` +
     retry, so a ClickUp blip degrades to an empty image list, not a throw.
   - **bare (FALSE)** → `Call Read Input` (unchanged — the dormant failover keeps full Docling assembly).
   - Both reconverge at new **`Merge Input Source`** (2 inputs) → `Build Prompt`, so `Build Prompt` keeps a
     single incoming connection (a `runOnceForAllItems` Code node with two incoming connections fires once
     *per connection* — CLAUDE.md trap).
   - `Build Prompt` is now lane-aware for images: managed builds `image_blocks_json` from the index
     (top-level images only, `mime.startsWith('image/')` or known ext), shape
     `{type:'image', ref:(a.url||a.url_w_query), mime, source:'input', source_ref:String(a.id), alt:title}`;
     the `# Załączone obrazy` section is reworded to "listed, NOT preloaded as vision — call `get_attachment`
     to see one" (embed/reference still work from the listed ref); `read_input_ok=true` on managed (Read
     Input is N/A).

2. **Orchestrator (`agent-orchestrator.json`, `a8XKaijkMFNBpRBa`, 27→30 nodes) — file-map write + dropped
   eager upload.** On the `Lane = managed?` TRUE branch, before the session:
   - **`Build Floor File Map`** parses the floor's `image_blocks_json` into rows
     `{file_id:'att_'+source_ref, url:ref, mime, source_ref}` (synthetic `file_id` is only the PK; the image
     MCP resolver matches `file_id OR source_ref` and returns `url`, and the external generator needs the
     URL, not a real Files-API id — same `url=ref` the eager `Upload Input Images` persisted).
   - **`Upsert File Map (Managed)`** reuses `Upload Input Images`' exact `agent_input_file_map` upsert SQL.
     `onError=continueErrorOutput` → **`Alert File Map Failed`** (`Post Alert (v1)` WARN) reconverging to the
     session; `alwaysOutputData=true` so a zero-image run still emits one item → the session is never
     skipped.
   - `Call Execute Agent Session` inputs switched from `$json.X` (the inserted Postgres node clobbers
     `$json`) to **`$('Call Assemble Context').first().json.X`**, and `input_images_json` set to **`'[]'`**
     — this is what drops the in-session eager Files-API upload (the `Upload Input Images` call inside the
     session now uploads nothing) and, with it, the preloaded vision blocks.

3. **`Sync Agent Definitions (v1)` — `CONV 9→10` + steering.** Added a system-prompt bullet: input images
   are LISTED but NOT preloaded as vision — call `get_attachment(attachment_id)` to see one; `embed_input`
   and `reference_file_ids` work straight from the listed ref without pulling. `CONV=10` forces every tier
   to re-version.

## Why the feared output regressions did not materialize

The Block 2 deferral worried that zeroing `image_blocks_json` would break `embed_input` and `reference_refs`.
Option E keeps `image_blocks_json` populated (from the index), so:
- **`embed_input`** resolves the agent's ref against `image_blocks_json` (shape unchanged: `{ref,mime,alt,
  source_ref}`) → a ClickUp inline-`{type:attachment}` op. Untouched.
- **`reference_refs`** resolves the agent's ref against `agent_input_file_map.source_ref` → `url`. The
  orchestrator now writes those rows from the floor metadata instead of the eager upload. The eager path
  already stored `url = the ClickUp attachment url` (the Files-API `file_id` was never used by the
  generator), so the metadata-sourced row is behaviourally identical.

## Reliability (ADR-025 / CLAUDE.md)

- **Attachment-index fetch failure** → `Fetch Attachment Index` degrades to an empty image list (the floor
  still emits); the managed run is never starved.
- **File-map write failure** → `Alert File Map Failed` WARN on a side branch, the session still runs
  (degrade, don't break). A failed write only weakens later `reference_refs` resolution; `embed_input` is
  unaffected (it resolves from `image_blocks_json`, not the DB).
- **Knowingly uncovered:** the agent *choosing not* to pull an image it should — no thrown error detects it
  (same standing risk as Block 2's lazy tools).

## Live verification (task `869dux9ne`: 2 PNG + 2 ZIP + 1 DOCX)

- **Stage A** (exec 3904): `Is Managed?` → TRUE; `Fetch Attachment Index` ran (391 ms) and returned the
  5-attachment index; **`Call Read Input` did not run** (no output) — the no-Docling proof; `image_blocks_json`
  = the 2 PNGs only (DOCX/ZIP excluded), each `ref`=ClickUp url, `source_ref`=attachment id; floor ≈ 10k chars.
- **Full spine** (orchestrator exec 3910, 39 s): `Lane = managed?` → TRUE; `Build Floor File Map` produced
  both rows; `Upsert File Map (Managed)` `success=true` (error branch silent); `Call Execute Agent Session`
  `completed`, and the agent **described the image** ("dojrzałe czerwone jabłko… na białym tle studyjnym") —
  proving lazy vision works (no eager preload, agent fetched via `get_attachment`, not blind); cost ≈ 0.95 PLN,
  output 753 tok; `Render Agent Output` clean. `agent_input_file_map` rows confirmed persisted. **0 alerts**
  in-window.
- **`embed_input`** (Render Agent Output exec 3926): an `embed_input` block with `ref=<source_ref>` resolved
  to `{type:attachment, attachment:{id,url}}`, 0 warnings.
- **`reference_refs`** resolution proven deterministically: the persisted `source_ref`→`url` row + the
  resolver's `where source_ref in (...)` SQL (`image-mcp-tool-handler.json`); the agent is shown `ref=<source_ref>`,
  so the lookup matches. (No paid image generation run — the changed surface is only the file-map write +
  the SQL match, both verified.)
- **Drift clean (38/38)**; all three touched workflows re-exported.

## Caveat — bare lane not runtime re-tested

The bare failover's new sub-path is an IF-false leg + a `Merge Input Source` passthrough, and `Build Prompt`'s
bare branch still reads `Call Read Input` directly (unchanged from Block 1, which *was* runtime-verified). A
fresh runtime bare test would have required flipping the shared production `config.agent_lane` to `bare`,
which the access classifier (correctly) denied as an unauthorized shared-state change. Recommend confirming
bare on the next genuine failover, or authorize a brief supervised flip.

## Accepted regression

Images **inside ZIPs** are absent from the ClickUp attachment index, so they lose eager `embed_input`/
`reference_refs` metadata on the floor (reading them via `get_attachment` is unaffected). Block 2c (progressive
zip disclosure) nests zip-inner entries into `list_attachments` and pulls one inner file by `<zip>:<idx>`.

## DoD

- ✅ Trivial image+doc task → managed floor with **no Docling latency** (Call Read Input did not run), no
  eager upload (`input_images_json='[]'`), correct answer; floor still lists the attachments.
- ✅ `embed_input` of a top-level image renders (inline-attachment op); `reference_refs` resolves
  (`source_ref`→`url` row + resolver SQL).
- ⚠️ Bare lane keeps full assembly — **structurally** verified; runtime re-test deferred (prod-config flip
  denied).
- ✅ Drift clean (38/38); touched workflows re-exported; `Sync` `all_synced=true` (`CONV=10`); 0 alerts.
