# Block 2c findings — ADR-061 progressive zip disclosure

Date: 2026-06-26. Block 2b made input images lazy but its accepted regression was that whole-zip `get_attachment`
still dumped every inner file at once (and zip-inner images were invisible to the floor). Block 2c makes zip-open
itself progressive: the agent first sees a cheap inner manifest, then pulls exactly one inner file by `<zip>:<idx>`.

## The load-bearing invariant

An entry's `index` is assigned to **every non-junk entry in archive order, before any size-cap check**, so it is
**independent of caps and of mode**. The same physical entry therefore carries the same `<attId>:<index>` across the
three walk modes. That is what makes a `<zip>:<idx>` listed by `list_attachments` (manifest mode) a valid argument to
a later `get_attachment` (single-entry materialize). Junk (directories, `__MACOSX`, dotfiles) is skipped without
consuming an index, identically in all modes. Caps still classify entries as accept/drop and still account toward
`too_many`/`over_total`, but they never shift an index.

## What was built

1. **`zip-extractor` service (`services/zip-extractor/app.mjs`) — one shared walk, two new modes.** `processZip` now
   takes `manifestOnly` and `onlyIndex` and serves all three behaviours from one entry walk (accept/drop
   classification, cap accounting, and index numbering byte-identical; only the per-entry side effect differs):
   - **full materialize-all** (`manifest_only` absent, `only_index` absent) — unchanged ADR-058 behaviour; the
     bare lane / `extract_clickup_task` / Stage A keep this contract.
   - **`manifest_only:true`** — central-directory walk: emit `{index,name,ext,mime,size,route,att_id}` for every
     entry, **no** `openReadStream` / upload / sign. Cheap index.
   - **`only_index:N`** — walk all entries for cap+index accounting, but materialize (read+upload+sign) and RETURN
     only entry N; a no-match finishes with a structured `inner_index_not_found` drop (one item, never a 0-entry
     result that would null the n8n zip branch). `only_index` is validated as a non-negative integer (else 400).
   - The walk fn is exported and the `app.listen` guarded behind an `isMain` check so it is unit-testable.

2. **`Read Input (v1)` (`zgGpONulGMohQQqI`) — single zip-inner pull.** `Explode Attachments` parses an
   `only_att_id` of the form `<zipAttId>:<innerIndex>`: it matches the **parent zip** by its base id (strips the
   `:<idx>` suffix via `/^(.+):(\d+)$/`) and carries `only_inner_index` on the kept item. `Zip Caps` forwards it as
   `only_index` and `Call Extractor` includes it in the POST body. A plain top-level id (no `:<digits>`) is
   unchanged, and an empty `only_att_id` (Form Trigger / extract handler / Stage A) still means "all attachments".

3. **`Triggering Task Tail Handler (v1)` (`Ouo0BlYOw92DUXIh`) — `list_attachments` nests zip manifests.** New
   sub-path after `Get Attachment List`: `Build Zip Manifest Reqs` (one item per zip attachment, or a `kind:'none'`
   sentinel when there are no zips, so the chain never 0-items) → `Is Zip Req?` (IF) → TRUE `Fetch Zip Manifest`
   (one `manifest_only` extractor call per zip) → `Merge Manifests` input 0 / FALSE → input 1 → `Build Attachments
   Result`. The merge gives `Build Attachments Result` a single input (a Code node with two incoming connections
   would run once per connection). `Build Attachments Result` now nests each zip's inner manifest inline (indented
   `attachment_id="<zip>:<idx>"` lines with name/type/size; cap-dropped entries flagged `[POMINIETO: …]`),
   correlating each manifest to its zip by index alignment between `Build Zip Manifest Reqs[kind=zip]` and
   `Fetch Zip Manifest`. The footer steers the agent to pull a single inner file by its `<zip>:<idx>` id.
   `get_attachment("<zip>:<idx>")` reuses the existing `Call Read Input (single)` path (now zip-aware) +
   `Upload Tail Images` for inner-image vision.

4. **`Sync Agent Definitions (v1)` — `CONV 10→11` + steering.** Added: ZIP attachments expand in `list_attachments`
   to inner files (`attachment_id` `<zip>:<idx>`), and one inner file is pulled by that nested id via
   `get_attachment` (not the whole archive). `CONV=11` re-versioned all 5 tiers.

## Caps note

Config caps (`zip_max_entries` 50, `zip_max_file_mb` 25, `zip_max_total_uncompressed_mb` 250) equal the service
defaults, and the manifest call passes no caps (service defaults). Because indices are cap-independent, manifest and
single-materialize indices align regardless; caps only affect the displayed `route` of a cap-dropped entry, which is
consistent today. If config ever diverges from defaults, the displayed route in `list_attachments` could differ from
the materialized route, but the `<zip>:<idx>` index mapping stays stable.

## Reliability (ADR-025 / CLAUDE.md)

- **Manifest-mode failure** (extractor 502 / unreachable / corrupt archive) → `Fetch Zip Manifest` degrades
  (`onError continueRegularOutput` + retry) to no entries; the zip is still listed **plain** and a
  `managed-agents/tail-zip-manifest-failed` WARN fires on the handler's side branch (degrade, don't break — the
  agent can still pull the whole archive by the top-level id).
- **Bad inner index** → the service returns a structured `inner_index_not_found` drop → a `[BRAK]` block → a
  `tail-attachment-partial` WARN; the run does not abort (verified live with `:999`).
- **Corrupt archive** → the existing ADR-058 `zip_extraction_failed` graceful single-drop path, unchanged by the
  refactor (the `{ok:false}` branch is preserved for both modes).
- **Knowingly uncovered:** the agent *choosing not* to open a zip / pull an inner file it should — no thrown error
  detects it (same standing risk as Block 2/2b).

## Live verification (task `869dux9ne`, two real product-image zips, handler driven via `test-subworkflow.mjs`)

- **`list_attachments`** (exec 3929, 3 s) → status `ok`, **0 alerts**: both archives' inner manifests nested inline —
  `6966c837-…zip` (29.6 MB) → 23 PNG entries `…zip:0`…`:22`; `d56f0367-…zip` (4.0 MB) → 16 PNG entries `:0`…`:15` —
  plus the 2 top-level PNGs and the DOCX. No extraction, no upload (manifest mode).
- **`get_attachment("6966c837-…zip:13")`** (exec 3931, 3 s) → status `ok`, content = a header + **exactly one**
  `{type:image, source:{type:file, file_id:…}}` vision block ("0 dok., 1 obr." — provably not the other 22 entries).
- **Bad inner index `…zip:999`** → status `partial`, `inner_index_not_found` `[BRAK]` block; exactly one
  `managed-agents/tail-attachment-partial` WARN, no abort.
- **Top-level DOCX (no colon)** → status `ok`, 1 doc / 2 text blocks (Docling text) — Block 2 behaviour unchanged
  (regression safe).
- `alerts-since.mjs 15` → **0 CRITICAL, 1 WARN** (only the deliberate bad-index probe). `Sync` → `all_synced=true`,
  5 tiers on `conventions_version=11` (confirmed by direct DB query). Drift clean (38/38); the three touched n8n
  workflows re-exported; service redeployed (`docker compose up -d --build zip-extractor`) and `/health` ok.
- **Local walk unit test** (`processZip` driven directly over a 5-file test zip incl. a dotfile): index alignment
  full↔manifest PASS; manifest-is-metadata-only PASS; single-entry-returns-one PASS; bad-index→not-found-drop PASS;
  junk(`.secret`)-skipped PASS.

## Known limitation (narrows, does not fully close, the Block 2b regression)

A zip-inner **image** is now accessible as **vision** via `get_attachment("<zip>:<idx>")` and browsable via the
nested `list_attachments` manifest, but it is still **not** wired into `embed_input` / `reference_file_ids`. Those
resolve against the floor's top-level `image_blocks_json` / `agent_input_file_map`, which a Supabase-url'd zip-inner
image never enters; and the ClickUp inline `{type:attachment}` op that `embed_input` emits structurally requires a
real ClickUp attachment id+url, which a zip-inner image lacks. So the agent can **see and reason about** zip-inner
images, but cannot re-embed one into a reply or use one as a product-faithful generation reference. Accepted by the
operator (recorded in ADR-061 consequences + current.md §15).

## Known cost

The zip is downloaded once per distinct pull (the manifest call, then each inner pull, each re-fetch the archive).
Fine at Haxe's archive sizes (≤30 MB observed); an extractor-side disk cache keyed by zip url is the obvious later
optimization.

## DoD

- ✅ `list_attachments` on a multi-file zip shows the inner manifest with no extraction (live: 2 zips, 39 entries, 0 alerts).
- ✅ `get_attachment("<zip>:<idx>")` returns exactly that one inner file (image→vision; doc→text path is the existing
  per-entry Docling path, exercised structurally — the test task's zips are image-only).
- ✅ Provably not touching the other entries (live: "0 dok., 1 obr.", not 23).
- ✅ Corrupt zip + bad index degrade with a WARN, no abort (bad index live; corrupt path unchanged from ADR-058).
- ✅ Bare-lane `/extract` (materialize-all) path still works — full mode unchanged (unit-verified + structurally preserved).
- ✅ Drift clean (38/38); microservice redeployed; `services/zip-extractor` committed.

## Follow-on (operator-requested, 2026-06-26): live caps + lazy task description

Two refinements after the block shipped.

**1. Tail handler `list_attachments` reads live config caps.** The manifest call previously omitted caps and
leaned on the service defaults equalling `config`. New `Lookup Zip Caps (Tail)` Postgres node, chained **linearly**
between `Get Attachment List` and `Build Zip Manifest Reqs` (so it always executes first — avoids the parallel-Lookup
unexecuted-node race that bit Read Input; `onError continueRegularOutput` + `alwaysOutputData` → defaults 50/25/250 on
a DB blip). `Build Zip Manifest Reqs` attaches `caps` to each zip item; `Fetch Zip Manifest` passes them in the body.
Indices remain cap-independent regardless; this also keeps the displayed *route* of cap-dropped entries consistent if
caps ever diverge from defaults.

**2. Task description is lazy on the managed floor.** It is large and unneeded in a double-digit % of runs, so Stage A
`Build Prompt` (managed lane / `floorOnly`) now folds only the task **title** plus a hint to call **`get_task_details`**;
the bare lane keeps the full description inline. New 5th tail tool `get_task_details` (bot `GET /task` → title +
description (markdown_description preferred) + status) via a new Route Tool `details` rule → `Get Task Details` →
`Build Details Result` → `Merge Result` input 5 (fallback re-pointed to output 5); `Execute Agent Session`'s
`Is tail tool?` OR-gate gained the 5th name. `Sync` `CONV 11→12` with steering (description not eager → pull via
`get_task_details`; four-tools bullet → five). **Trade-off (red-teamed with the operator):** the description is the
task spec, needed in most runs, so this adds one round-trip on the majority case to save tokens on the
trivial-comment minority + the 100k case — accepted (async system, token floor is the priority).

**Live verification (task `869dux9ne`):**
- Stage A managed floor (exec 3962): `# Zadanie` now shows the title + the `get_task_details` hint, **not** the
  4.7k-char description (`PROMPT MOODBOARD` absent); prompt fell ~10k → **5378 chars**.
- `get_task_details` → status `ok`, returns title + status + the full 4759-char description.
- `list_attachments` (exec 3960) → status `ok`, still nests all **39** inner refs with the live caps passed.
- Unknown tool → routes to `Build Unknown Result` (fallback re-point works) + a `tail-unknown-tool` WARN.
- `Sync all_synced=true`, 5 tiers on `conventions_version=12` (DB-confirmed); 0 CRITICAL alerts; drift clean (38/38);
  four touched workflows re-exported.
- **Knowingly uncovered:** the agent choosing not to pull the description when it should — same standing risk as the
  other lazy tail tools.
