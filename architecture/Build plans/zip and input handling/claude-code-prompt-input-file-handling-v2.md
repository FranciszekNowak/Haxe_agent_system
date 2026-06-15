# Claude Code prompt: implement ADR-048 (input file handling v2)

Attach `048-input-file-handling-v2.md`. The ADR is the source of truth for intent; this prompt is disposable execution detail. If they disagree, the ADR wins, stop and flag it. This change is reader-only plus a config table, a storage bucket, and a cleanup job. It does NOT touch `invoke-model.json` and does NOT change the loose-image or loose-document paths. Step 0 has gates that tune the wiring; do them before building.

## Ground yourself first (read, do not skip)

- The attached ADR-048 in full.
- `n8n/workflows/read-input.json` (id zgGpONulGMohQQqI): `Get Task` to `Explode Attachments` to `Classify Attachment`, the `Build Image Block` / `Build Text Block` envelopes, `Merge Branches`, the branch-free terminal `Aggregate Blocks`, `binaryMode: separate`, and the warn_source / needs_alert mechanism Aggregate collects.
- `architecture/current.md` Read Input sections; the existing count-ceiling lookup pattern.
- ADR-036 (lists `.zip` unsupported; you will supersede that note).
- Confirm the next free ADR is 048 and the next free migration numbers.

Do NOT open or edit `invoke-model.json`. This change does not touch it.

## Inherited rules (state them, do not re-derive)

- Build/edit n8n via the n8n MCP, then re-export with `node scripts/export-workflows.mjs` (preserve curated node notes) and confirm with `node scripts/check-workflow-drift.mjs`. Never hand-edit exported JSON.
- All alerts go through `Post Alert (v1)` (YSCdHlmdf3p9XEUx). The reader stays pure; it tags warn_source/needs_alert and Aggregate collects.
- Supabase migrations are append-only, new number each time.
- Loop guard: never read or post-watch the Alerts task 869dj2z2c.
- Verify live: `node scripts/inspect-execution.mjs <id>`, `node scripts/alerts-since.mjs <mins>`.
- At the end of each block, do a live test of whether it is working, do a write-back to relevant docs, and provide the user with a handoff prompt to be used after /clear.

## Step 0. Gates and measurements (before building)

A. Large-image acceptance. Push a 10-to-15 MB image through the live LiteLLM-to-provider path and confirm it is accepted (downsampled) rather than rejected on size. Zip-inner images are stored at original size, and a photo dump can contain files near the 25 MB per-file guard. If accepted, no cap is needed (the existing loose-image path already passes full-size URLs, so this is the working contract). If rejected, reintroduce a cap sized to the provider ceiling as a correctness guard and record it as an ADR consequence.
B. Compression-node memory behavior. Confirm whether `n8n-nodes-base.compression` decompresses to the filesystem (expected under `binaryMode: separate`) or buffers the whole archive in memory. If filesystem, `zip_max_total_uncompressed_mb` can be 500; if in-memory, set it to about 250. Also confirm the node exists in this n8n 2.x and its output shape (one item with N binary properties vs N items); if absent, stop and escalate.
C. Measure Docling: is OCR firing on documents that do not need it; per-document time for a typical business PDF; resident RAM. Feeds Block 5.
D. Provider fetch. Confirm the provider fetches a plain Supabase object URL for an input image end to end through LiteLLM. One probe.

## Block 1. `file_processing_config` (global)

Migration: create a small GLOBAL config table (not keyed by impact) with `zip_max_entries`, `zip_max_file_mb`, `zip_max_total_uncompressed_mb`. Represent global scope cleanly (a single fixed-key row, or a key-value shape). Seed: entries 50, per-file 25 MB, total 500 MB (or 250 per gate B). No image-resolution value: input images are not downscaled (see ADR-048 Decision 3). Add a lookup node in the reader. This is the single source for all file limits; remove the v1 hardcoded caps.

## Block 2. Supabase storage + Store Zip Image step

- Create a private Supabase bucket (EU project) for zip-inner images.
- Build a `Store Zip Image` step: input the zip-entry image bytes, upload under a unique key (e.g. `<clickup_task_id>/<att_id>`), output the plain Supabase object URL as the ref. No transform, no resize: store the original bytes (same full-size contract as loose images). Use a signed URL with a TTL of several hours: it must outlive the internal gap from storing the image (reader) to the provider fetching it (invoke-model step), which in queue mode can include inter-stage queue latency. Keep it under the 24h cleanup; set a short `cacheControl`. Never inline base64.
- This step is used ONLY by the zip-inner image branch. Loose images do not call it.

## Block 3. Zip unpacking

- `Zip?` Switch after `Explode Attachments`: zip on ext/mime zip and not the no-attachment sentinel; everything else (incl. sentinel) to the existing `Classify Attachment` unchanged.
- Zip branch: `Fetch Zip Binary` (mirror Fetch Attachment Binary) to `Decompress` to `Explode Zip Entries` (fan out; per item set clickup_task_id, att_id `<parentAttId>:<i>`, title, ext, mime, source `zip`, interleave order; apply the global guards from Block 1: junk silently skipped, nested-zip/oversize/too-many/over-total to a pre-tagged `route:drop` item with its `multimodal/zip-*` warn_source).
- Classify inner entries: image to `Store Zip Image` then a zip image block (envelope identical to Build Image Block, ref = the Supabase URL); document to the Docling path via a `Merge Extractable` (append) so one Docling Convert serves loose and zip docs; drop to `Build Dropped Zip Block` (`[BRAK: <reason> <title>]` + warn_source).
- Make `Build Text Block` metadata recovery source-agnostic (try Explode Attachments item, catch to Explode Zip Entries item) so zip docs keep order/title through the append-Merge and Docling.
- Expand `Merge Branches` to take the new streams and converge into `Aggregate Blocks` (single input, branch-free terminal, unchanged). Verify append does not stall on an empty input.

## Block 4. 24-hour cleanup (pg_cron)

**STATUS: LANDED 2026-06-15** (migrations 029 → 030 + n8n `Zip Image Purge Watchdog (v1)`). Runs **once daily at 05:00 Europe/Warsaw**, deleting objects older than **12h** (operator decision: the 12h floor stops mid-run deletion; DST-correct via a `0 3,4 * * *` UTC schedule + in-function Warsaw-hour gate). Deletes via the Storage REST API (frees bytes, not just the row); key (legacy `service_role` JWT or new `sb_secret_…`) read from Supabase Vault. Accepted consequence: once-daily + 12h floor → real lifetime up to **~36h** (not 24h); GDPR record + current.md updated accordingly. Independent dead-man's-switch (every 6h) WARNs through Post Alert if any object exceeds **40h**. One operator step remains: the Vault secret currently holds an invalid value — set a real key via `vault.update_secret(...)`, then confirm byte-free deletion on a backdated object. See ADR-048 Block 4 outcomes.

A daily pg_cron job deleting input-bucket objects older than 24h via the proper storage deletion (free the bytes, not just the metadata row). Verify on a test object that bytes are reclaimed. Not an n8n scheduled workflow.

## Block 5. Docling tuning (apply Step 0.C findings)

Scope OCR to scanned/image inputs only; TableFormer fast mode if currently accurate; a concurrency bound in front of `docling:5001` so a multi-document zip cannot launch all conversions at once. Do not replace Docling. Record per-doc time before and after.

## Verification (Definition of Done)

1. Mixed zip (2 docs + 2 images): reply uses doc text and both images; blocks interleaved at the zip's position; images served from Supabase URLs; 0 alerts.
2. Docs-only zip and images-only zip: no stall on the empty branch; correct extraction; 0 alerts.
3. Non-zip regression: a loose pdf + png task behaves EXACTLY as today (png still served from its ClickUp URL; no Supabase involvement; no diff in that path's behavior).
4. Guards (all global): corrupt zip to one zip-extraction-failed WARN; nested zip to zip-nested-skipped, outer still processed; oversize/too-many/over-total to zip-too-large, partial delivered. Run completes each time.
5. Object storage: zip-inner images land in the EU bucket; only URLs appear in execution data (grep an execution for base64, expect none); a delayed/queued run still fetches a valid URL (TTL outlives the wait).
6. Large-image acceptance: a 10-to-15 MB zip-inner image is stored at original size and accepted by the provider through LiteLLM (gate A). If the provider rejects it, a provider-limit cap must be added before this is considered done.
7. Cleanup: insert a test object dated >24h, run the pg_cron function, confirm it is gone and bytes are freed.
8. Docling: a multi-document zip does not saturate the box (concurrency bound holds); record the per-doc improvement from OCR scoping.
9. No CRITICAL on clean runs; storage watchdog not tripped; execution-DB growth from a mixed-zip run is small (zip images are URLs).

## Write-backs and commit (together)

- ADR-048 to landed; record gate outcomes (large-image acceptance result, decompress memory behavior, the chosen total cap, Docling numbers).
- `architecture/current.md`: the reader's zip path; zip-inner images to Supabase; the global `file_processing_config`; the pg_cron cleanup; the Docling tuning. Note explicitly that loose images and `invoke-model.json` are unchanged. Supersede ADR-036's `.zip`-unsupported note.
- `compliance/gdpr-processing-decisions.md`: add Supabase zip-inner-image storage (EU) with 24h retention as a processing activity.
- Re-export the reader, run drift check, commit workflow, migrations, and docs together.

## Guardrails (do not cross)

- Do NOT touch `invoke-model.json`. Do NOT change the loose-image or loose-document paths.
- Never inline base64 into an image ref. Zip-inner images are always a Supabase URL.
- No input-image downscale: zip-inner images are stored and served at original size, identical to loose images. Any cap is added only if gate A shows the provider rejects large images, and then as a correctness guard, not an egress optimization.
- `file_processing_config` is global and the single source for file limits; no impact key, no hardcoded caps.
- Cleanup is pg_cron, not an n8n scheduled workflow.
- Keep Docling; tune only.

## Files

- `n8n/workflows/read-input.json` (zip unpacking; zip-inner images to Supabase; loose paths unchanged)
- migration: global `file_processing_config` + seed
- migration / SQL: pg_cron cleanup function + schedule
- Supabase bucket (provisioned; infra, not a repo file)
- `architecture/decisions/048-input-file-handling-v2.md` (landed)
- `architecture/current.md`, `compliance/gdpr-processing-decisions.md`
- Untouched: `n8n/workflows/invoke-model.json`, the loose-image/document paths
- Reused: `scripts/export-workflows.mjs`, `scripts/check-workflow-drift.mjs`, `scripts/inspect-execution.mjs`, `scripts/alerts-since.mjs`
