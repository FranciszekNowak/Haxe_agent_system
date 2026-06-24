# ADR-048: Input file handling v2 — zip unpacking, Supabase object storage for zip-inner images, a global file-processing config, and Docling tuning

Status: Accepted, **partially superseded by [ADR-058](058-off-worker-zip-extraction.md) (2026-06-24)**: the in-workflow adm-zip `Decompress` (gate B / the 250 MB "accepted in-memory spike" below) OOM-killed the n8n worker on a >500 MB zip and cascaded to every co-running execution. Zip extraction now runs in a dedicated off-worker container; the in-memory spike no longer exists on the worker. The block contract, ordering, drop taxonomy, Supabase bucket, and purge from this ADR are unchanged. **All blocks landed** — Blocks 1–4 (global config + lookup; EU bucket + Store step; zip unpacking wired; daily 05:00 pg_cron purge + dead-man's-switch) and Block 5 (Docling tuning: OCR scoped off with a two-pass fallback, TableFormer fast, a pinned concurrency bound). Two build-time gates inside (large-image provider acceptance; compression-node memory behavior) confirm one correctness point and tune one guard value — gate B resolved in Block 3 (see Consequences); gate A is covered by the existing full-size loose-image contract plus gate D, with a >15 MB zip-path confirmation left to the operator (see Consequences).
Date: 2026-06-13 (Blocks 1–3 landed 2026-06-15; Block 4 landed 2026-06-15; Block 5 landed 2026-06-15)
Deciders: Franciszek (operator), with design review

Numbering note: confirm 048 is the next free ADR and that each migration here gets the next free number, against the live repo before committing. ADR-047 (fallback seam) precedes this.

## Context

`Read Input (v1)` (`n8n/workflows/read-input.json`, id zgGpONulGMohQQqI) cannot use a `.zip`: it classifies attachments as image or extractable, and a `.zip` is neither, so it degrades to `[BRAK]` (ADR-036). We want to unpack it and feed each inner file downstream as its own attachment.

The original fix inlined inner images as base64, which is an out-of-memory risk at the real workload (a 30-to-50 photo dump, several concurrent): the reader runs `binaryMode: separate` so fetched files sit on disk, but a base64 ref is JSON, held in worker memory, copied between nodes, and persisted to Postgres across roughly four sub-workflow execution records. Fifty 8 MB photos is about 530 MB of JSON and near 2 GB of DB writes per run, and a few concurrent on the shared 8 GB box is a credible OOM. The fix is to keep image bytes out of execution data entirely.

Two scope decisions made during planning narrow this from the earlier draft:
- Only zip-inner images go to object storage. Loose (directly attached) images already pass a ClickUp URL with no OOM, so routing them through storage would only add a fetch-plus-upload each for a marginal robustness benefit (a URL TTL we control rather than ClickUp's; see Consequences). They are left exactly as today, which keeps `invoke-model.json` untouched and the non-zip path unchanged.
- Input images are not downscaled at all. Providers downsample to their own ceiling regardless, egress is a rounding error against model cost (operator-verified), and 3072 px (the only lossless ceiling) changes nothing the model sees, so a downscale step would be pure machinery with no cost, latency, or fidelity benefit. Zip-inner images are stored and served at original size, identical to how loose images are already passed through. One correctness caveat is verified at build time (provider per-image limits, see Decision 3).

Docling (the document extractor) is CPU-and-RAM heavy on the CPU-only VPS, and the zip feature multiplies its load because one zip can carry many documents.

## Decision

### 1. Unpack zips.

Insert a zip gate after `Explode Attachments`; a `.zip` is downloaded, decompressed, and its inner files fanned out, then merged back into the existing `Classify Attachment` so non-zip behavior is unchanged. Inner files interleave at the parent zip's ordinal position (`order = parentOrder + (i+1)/1000`). Nested zips are not recursed (zip-bomb guard). Junk entries (directories, `__MACOSX`, dotfiles) are silently skipped. Every degradation surfaces as a `multimodal/zip-*` warning through the existing `Post Alert (v1)` choke point; the reader stays pure (no alert nodes).

### 2. Zip-inner images go to Supabase object storage; only a URL travels downstream, never base64.

Each zip-inner image is uploaded to a private Supabase Storage bucket (EU project) and referenced by its object URL. The heavy bytes never enter execution data, so the OOM cannot occur at any image count. Zip-inner documents go to Docling as today (binary on filesystem). Loose images and loose documents are untouched: loose images keep their ClickUp URL ref, loose documents keep their Docling path. The downstream contract is unchanged (`Resolve Routing` passes a ref verbatim into `image_url.url`), so a Supabase URL is a drop-in.

### 3. No input-image downscale; store originals.

Zip-inner images are stored in Supabase at original size and referenced by their plain object URL. No transform, no resize, no `image_max_long_edge_px`. This is deliberate: egress is a rounding error against model cost, providers downsample to their own ceiling so a lossless cap changes nothing the model perceives, and a downscale would only add a transform integration, a config value, and a gate to maintain. It also keeps zip-inner images consistent with loose images, which already flow to the provider as full-size URLs.

Build-time caveat (the one function a cap could have served): provider per-image limits. The vision APIs have a per-image ceiling (Anthropic auto-resizes below a max dimension around 8000 px and documents a per-image byte ceiling on the order of a few MB), while the per-file zip guard allows 25 MB, and photo dumps routinely produce multi-MB images. So verify, with one probe, that a large image (10 to 15 MB) is accepted through the live LiteLLM-to-provider path rather than rejected. The existing loose-image path already passes full-size URLs to that route, so this is likely already the working contract; the probe just confirms it for the larger sizes a zip dump can contain. If a large image is rejected, reintroduce a cap sized to the provider ceiling (a correctness guard, not an egress optimization), or lower the per-file guard accordingly.

### 4. A global `file_processing_config`; guards do not scale with impact.

A small global config table (not keyed by impact) holds `zip_max_entries`, `zip_max_file_mb`, and `zip_max_total_uncompressed_mb`. File and total-size limits have nothing to do with task importance (a low-impact task can legitimately carry many files), so they are global. Recommended values, set well below outage risk: entries 50, per-file 25 MB, total uncompressed 500 MB. No image-resolution value (Decision 3). Config lives in the DB so it is tunable without a code change; it replaces the v1 hardcoded caps.

The total-uncompressed value is the only outage-relevant guard, and its safety depends on the compression node writing decompressed files to the filesystem (expected under `binaryMode: separate`), making 500 MB a transient disk concern the ADR-046 storage watchdog already covers, not a RAM concern. If the node buffers the whole archive in memory (build gate), lower the total to about 250 MB to stay clear of OOM.

### 5. 24-hour cleanup via pg_cron.

Supabase has no native object lifecycle (verified), so a pg_cron job deletes input-bucket objects older than 24 hours using the proper storage deletion path (a bare `delete from storage.objects` orphans the bytes; use the storage delete so bytes are freed). DB-native, not an n8n scheduled workflow, so it respects the event-driven-n8n principle, and it serves data minimization (aligns with ADR-044). (Schedule + floor revised by operator decision on 2026-06-15 to **once daily at 05:00 Europe/Warsaw, deleting objects older than 12h**; see Block 4 outcomes for the reasoning and the accepted ~36h retention consequence.)

### 6. Docling tuning (low-hanging fruit only).

Measure first (is OCR firing on documents that do not need it; per-document time; resident RAM), then apply the cheap wins: scope OCR to scanned or image inputs only, use TableFormer fast mode if currently accurate, and bound Docling concurrency in front of `docling:5001` so a many-document zip cannot saturate the box. Keep Docling (its table and layout fidelity is the point); isolating it onto its own host is the durable move and is a follow-up, not done here.

## Consequences

- The zip OOM cannot occur: zip-inner images are URLs, never base64.
- Reader-only change. `invoke-model.json` is untouched (no crown-jewel edit), and the existing loose-image and loose-document paths are byte-for-byte unchanged. Smallest blast radius of the options considered. (Loose images still rely on ClickUp's own attachment-URL TTL covering that same reader-to-provider gap; whether that TTL is ever too short under heavy queuing is a separate, pre-existing question worth verifying independently, not something this change introduces or fixes.)
- New external dependency for zip-inner images only: Supabase Storage (EU bucket `zip-inner-images`, `haxe-agent-prod`/`eu-west-1`, private). No image transforms. Signed-URL TTL must outlive the internal gap from when the reader stores the image to when the provider fetches it at the invoke-model step. **Build gate D (the provider-fetch probe), 2026-06-15: PASSED** — a private-bucket object uploaded via the Store step, signed with a 6h TTL, was fetched and read by the provider through LiteLLM end-to-end (Gemini via Vertex returned a correct description; usage reported 1089 image tokens, so the bytes were genuinely retrieved and tokenized, not just URL-echoed). The chosen TTL is 21600 s (6 h), well under the 24 h cleanup, with `cache-control: max-age=3600`. Gates A (large-image acceptance) and B (compression-node memory) remain for Block 3. In queue mode that gap can include inter-stage queue latency (not the initial pre-run queue wait, which precedes the reader obtaining any URL), so set the TTL to several hours, under the 24h cleanup; set a short `cacheControl` since objects are deleted. GDPR: EU bucket plus 24h purge is a data-minimization positive; provider fetch is the same egress base64 would have produced, so no new residency surface; PD-blind posture (ADR-043) holds.
- No downscale step: zip-inner images are stored and served at original size, the same contract as loose images. One build-time probe confirms large images are accepted by the provider; if not, a provider-limit cap is reintroduced as a correctness guard.
- All file limits are global and DB-tunable; none scale with impact; no hardcoded caps remain.
- Docling tuning lowers CPU and the concurrency bound protects the shared box from zip document bursts.

### Block 3 outcomes (zip unpacking wired, 2026-06-15)

- **Gate B (compression-node memory) — RESOLVED: in-memory.** `n8n-nodes-base.compression` v1.1 `decompress` uses `adm-zip`, which loads the whole archive and extracts every entry into in-memory Buffers before n8n persists them to the `binaryMode: separate` store. Decompression is therefore an in-memory operation, not streamed-to-disk. Per Decision 4 the total-uncompressed guard was lowered **500 → 250 MB** (migration `028_zip_total_cap_in_memory.sql`, applied and verified live: `config.zip_max_total_uncompressed_mb = 250`). Note the guard is enforced **downstream** in `Explode Zip Entries` — it bounds what is handed to Docling/Supabase (the amplification), but cannot prevent the decompress-time spike itself; 250 MB keeps that transient spike survivable, backstopped by the ADR-046 storage watchdog. Decompress output shape: one item per zip carrying binary props `file_0…file_N` (outputPrefix `file_`), original name/ext/mime in each binary's metadata.
- **Decompress needs a `.zip` filename — hardened with `Stamp Zip Filename`.** The `n8n-nodes-base.compression` node refuses a binary whose metadata does not identify it as a zip, throwing `File extension not found for binary data data`, and `Fetch Zip Binary`'s filename depends on whatever `content-disposition` ClickUp returns on the attachment download. Because `Decompress` runs with `continueRegularOutput`, a missing filename would silently degrade a **valid** archive to a `zip_extraction_failed` drop + WARN — the exact silent-degradation trap. A `Stamp Zip Filename` Code node was inserted between `Fetch Zip Binary` and `Decompress`: since `Zip? Switch` has already proven the attachment is a zip, it stamps `fileExtension='zip'` + `mimeType='application/zip'` (and a `.zip` `fileName` from the parent title, else `archive.zip`). The exact failure-then-fix was demonstrated on a throwaway host workflow (no filename → decompress failed; filename stamped → all entries extracted), then confirmed in the integrated reader run below.
- **Gate A (large-image acceptance) — covered by contract; >15 MB zip-path probe deferred to operator.** The unique new variable is image byte-size. The existing loose-image path already passes full-size ClickUp images (up to the 25 MB attachment limit) to the same LiteLLM→provider route in production, and gate D (2026-06-15) proved Supabase-signed-URL delivery is fetched and tokenized by the provider. Binary delivery of a *valid small* zip into the reader was solved (see integrated verification below: an in-infrastructure n8n store/serve webhook on the VPS, fetched server-side by ClickUp via `file_url` — no binary ever transcribed through text). A dedicated **>15 MB** zip-path probe still could not be run: the VPS nginx caps the test-harness store webhook body at ~1 MB (`413`), and external file hosts / public buckets / SSH were all denied. This nginx cap is a **test-harness limit only** — the production reader downloads the archive from ClickUp's own host (`clickup-attachments.com`), not through that nginx, so real multi-MB zips up to ClickUp's 25 MB attachment cap are unaffected. No per-file cap beyond the existing 25 MB guard was added. **Operator follow-up:** attach a real ~12 MB-image zip to a task and @-mention the agent; if the provider rejects on size, add a provider-limit cap (Decision 3 caveat).
- **Degradation verification (reader exec 2132).** `Zip? Switch` correctly routes a `.zip` to the zip branch and everything else to `Classify Attachment` unchanged; `Fetch Zip Binary` downloads the archive; `Decompress` + `Explode Zip Entries` gracefully degrade an undecompressable archive to a single `zip_extraction_failed` drop (`warn_source: multimodal/zip-extraction-failed`) with the run completing `success` and no CRITICAL — the reactive error path is not tripped.
- **Integrated happy-path verification (reader run via the production `When Called` path, 2026-06-15).** A real `mixed.zip` (two HTML docs, two JPEGs, a nested `inner.zip`, a `.DS_Store`) was attached to a live ClickUp task — delivered byte-faithfully by having ClickUp download it server-side (`clickup_attach_task_file` `file_url`) from an in-infrastructure n8n store/serve webhook — and the reader was invoked with `{ clickup_task_id }` exactly as Stage A calls it. It returned the correct interleaved `blocks`: order 0.001/0.002 = the two docs as Docling markdown; order 0.003/0.004 = the two JPEGs as **Supabase private-bucket signed URLs** (one verified fetchable: HTTP 200, `image/jpeg`, correct byte length); order 0.005 = `[BRAK: nested_zip inner.zip]`. The `.DS_Store` was silently skipped; `warnings` carried the single `multimodal/zip-nested-skipped`. This exercises the full zip path end-to-end: `Stamp Zip Filename` → `Decompress` → `Explode Zip Entries` (fan-out, interleave, junk-skip, nested-drop, guards) → `Classify Zip Entry` 3-way fan → image branch (Zip Image Key → Upload → Sign → Compose → Build Zip Image Block), document branch (Merge Extractable → shared Docling Convert → Build Text Block), drop branch (Build Dropped Zip Block), all converging through the widened 5-input `Merge Branches` into the branch-free `Aggregate Blocks`. The workflow validates clean (0 errors, 29 connections). The only alert during testing was one CRITICAL from a malformed test-harness form POST (wrong content-type to the Form Trigger), unrelated to the zip path.

### Block 4 outcomes (24h pg_cron purge + dead-man's-switch, 2026-06-15)

- **Byte-free deletion mechanism — confirmed: there is no SQL-native helper that frees the bytes.** The
  `storage` schema exposes only a `protect_delete` trigger; no `storage.delete_object`-style function exists,
  and the bytes live in S3, reachable only through the storage service. So the purge **must** call the Storage
  REST API (`DELETE /storage/v1/object/{bucket}/{key}`), which removes both the S3 object and the
  `storage.objects` row. A bare `delete from storage.objects` would drop the row and **orphan the bytes** (the
  personal data would survive) — exactly what the ADR warned against. Implemented in `migration 029` as
  `public.purge_zip_inner_images()` (SECURITY DEFINER), using **pg_net** for the HTTP DELETE, with the
  service_role key read from **Supabase Vault** (`vault.decrypted_secrets`, name `service_role_key`) so no
  secret is committed. Object keys are `<task_id>/<sanitized att_id>` (URL-safe), so no percent-encoding.
- **Schedule + floor — landed hourly/>24h, then revised to once-daily 05:00 Warsaw / >12h (operator decision, 2026-06-15, migration 030).**
  Originally landed hourly with a >24h floor (migration 029) to cap lifetime at ~25h. The operator then chose a
  **single daily run at 05:00 Europe/Warsaw with a 12h floor**. The floor's purpose is to guarantee an in-flight
  agent run's attachment is never deleted mid-process (a run lasts minutes; 12h is a large margin). Red-team
  raised and the operator accepted: once-daily + *any* non-zero floor **cannot** hold ≤24h — an evening/overnight
  file is <12h old at the 05:00 run and waits for the next day, so real lifetime is up to **~36h**. That is an
  accepted, documented minimisation posture (24h was self-imposed, not legal); the GDPR record and `current.md`
  were updated from "24h" to "purged daily, ≤~36h". To restore a ≤24h guarantee, run more than once per day
  (e.g. `0 */6 * * *`). **DST:** pg_cron has no per-job timezone and the DB is UTC, so the job is scheduled
  `0 3,4 * * *` UTC and an in-function `Europe/Warsaw` hour-gate makes exactly one of the two fires act at 05:00
  local year-round (a `p_force` argument bypasses the gate for manual/verification runs).
- **Silent-degradation coverage.** The purge is a classic "fails without throwing" risk: if the cron stops,
  the function errors, or the Vault key is rotated away, objects accumulate past retention with nobody noticing.
  Two guards: (1) a missing Vault key writes a `SKIPPED` row to `public.storage_purge_runs` instead of a silent
  no-op or a crash; (2) an **independent** n8n dead-man's-switch, **`Zip Image Purge Watchdog (v1)`**
  (`2L4W4OQ7Qmmnl1Z1`), runs **every 6h** on its own scheduler (not pg_cron — a pg_cron-based watchdog would die
  with the thing it watches) and routes a **WARN** through `Post Alert (v1)` if any object in the bucket exceeds
  **40h** (the healthy ceiling is ~36h under the daily/>12h schedule; the threshold was 26h under the original
  hourly/>24h schedule). Every failure mode collapses to the same observable symptom: objects older than
  retention still present.
- **Live verification (2026-06-15).** Extensions `pg_cron` 1.6.4 + `pg_net` 0.20.3 enabled; the cron job
  `purge-zip-inner-images` is registered, active, hourly. The function runs cleanly and, with no Vault key yet
  set, correctly logged the `SKIPPED` row (no crash, no silent no-op). The watchdog was exercised end-to-end:
  with the bucket healthy it reported `stale=false` and fired no alert; after a test object was backdated to
  ~30h it reported `stale_count=1` and posted the WARN to the Alerts task through `Post Alert (v1)`; the test
  object's timestamp was then restored. **Operator follow-up (one step):** insert the service_role key into
  Vault (`select vault.create_secret('<KEY>', 'service_role_key', '…');`) so the purge can authenticate; until
  then the watchdog is the safety net. After the key is set, a single run on a backdated object will confirm a
  Storage-API `200` + the `storage.objects` row gone = bytes freed.
- **Revision + byte-free verification status (2026-06-15, same day).** (1) Schedule/floor revised to daily-05:00
  Warsaw / >12h (migration 030, above); the watchdog was retuned 26h → 40h and re-verified healthy, and the new
  function was verified live (the DST hour-gate correctly no-ops a non-forced call outside 05:00 Warsaw; a forced
  call runs and logs `nothing to purge`). (2) The byte-free deletion probe was **attempted but is still pending a
  valid key**: the operator inserted a Vault secret, but the value was a 16-char non-token (not a JWT / not an
  `sb_secret_`), so the Storage API returned `403 "Invalid Compact JWS"` and nothing was deleted. The correct
  value is a `service_role` JWT or a new `sb_secret_…` secret key from **Settings → API Keys** (the renamed
  panel — "service keys" no longer exists by that name; legacy `service_role` sits under the *Legacy API Keys*
  tab). The function accepts either (it sends the key in both `apikey` and `Authorization: Bearer`, which Supabase
  permits for secret keys when the two header values are identical, and both key classes bypass RLS). Update the
  secret with `vault.update_secret(...)` (not a second `create_secret`). **RESOLVED 2026-06-15:** the operator
  stored a valid `sb_secret_…` key; a forced purge of a 20h-backdated 280 KB test image returned Storage-API
  `200 {"message":"Successfully deleted"}` (`net._http_response`) and the `storage.objects` row is gone — bytes
  freed, not orphaned. **Block 4 is fully verified end-to-end and operational** (daily 05:00 Warsaw cron + valid
  key + watchdog).

### Block 5 outcomes (Docling tuning, 2026-06-15)

Measured first on the live `docling:5001` (4 vCPU / 7.6 GB CPU-only VPS), then applied the cheap wins. Docling
in our reader only ever receives **documents** (images route to the vision branch, never to Docling), so `do_ocr`
only affects scanned/image-only PDFs.

- **OCR scoping — `do_ocr=false` (primary pass), measured 50–67 % faster, byte-identical.** A real digital business
  PDF (`Karta Techniczna HX705.pdf`) converted in **2.0 s with OCR off vs 4–6 s with OCR on, producing byte-identical
  markdown** (1362 chars either way) — OCR was pure overhead. DOCX/XLSX/HTML/TXT/digital-PDF are unaffected (they have
  a text layer); only scanned/image-only PDFs lose text when OCR is off.
- **Two-pass OCR fallback preserves scanned docs (ADR Decision 6, "scope OCR to scanned inputs only").** Rather than
  drop scanned-PDF support, the reader runs `do_ocr=false` first and, when extraction comes back empty (`OCR Empty?`
  IF), re-runs that one document with `do_ocr=true` (`Restore Doc Binary` re-attaches the file bytes the first HTTP
  response dropped → `Docling OCR Retry`). The two branches converge through a **`Merge OCR Result`** append node so
  `Build Text Block` keeps a single input — a 2-input Code node made it (and `Aggregate Blocks`) run once per
  connection, splitting the reply into two partial outputs; the Merge fixes that (found and fixed during live
  verification). Common case (all-digital) pays nothing; only scanned docs incur the second pass (~+2–4 s).
- **TableFormer `table_mode=fast` — validated byte-identical, adopted.** On a real Haxe price table (model codes,
  EANs, `1 299,00` with a thousands space, right-aligned numerics) `fast` produced **byte-identical** markdown to
  `accurate` at **2.0 s vs 4.0 s**, and on three real production XLSX exports (R003 towary-w-drodze, L002 APC logistics,
  R001 PLB region — 73 k / 89 k / 703 k chars) `fast` and `accurate` were byte-identical (TableFormer does not affect
  native XLSX parsing). A single config flip back to `accurate` if a complex borderless/merged-cell PDF table ever
  regresses.
- **Concurrency bound — pinned `DOCLING_SERVE_ENG_LOC_NUM_WORKERS=2` + `OMP_NUM_THREADS=2` in compose.** docling-serve
  already capped concurrency at its image-default 2 workers (3 concurrent sync conversions ran 2-parallel + 1-queued,
  all succeeded, `max_sync_wait=120 s` governs shedding), but with `OMP=4` that was 8-thread demand on 4 cores. Pinned
  to **2 workers × 2 threads = 4 cores exactly** (no oversubscription, max 2 concurrent conversions, the rest queue
  server-side), so a multi-document zip burst cannot saturate the box. Pinned in **both** `n8n/docker-compose.yml`
  (repo master) and the VPS `/opt/haxe-agents/docker-compose.yml` so an image bump can't silently revert it.
  Single-doc latency unchanged at 2.0 s after the restart; `document_timeout=120` added as a per-doc server-side cap.
- **Silent-degradation coverage.** (1) Saturation/timeout under a zip burst → server-side queue + `document_timeout`
  + `continueRegularOutput` → empty/error → `[BRAK: extraction_failed]` + `needs_alert` + `warn_source` → `Post Alert
  (v1)` WARN; the run still completes. (2) A scanned PDF that defeats the no-OCR pass → the two-pass re-extracts; if
  **both** passes are empty (truly unextractable/corrupt) → `[BRAK]` + WARN (no silent loss). (3) Bound drift on an
  image bump → pinned in committed compose. Docling tuning is config-only and reversible.
- **Live verification (When Called path, throwaway caller).** A 3-attachment task returned all three blocks in one
  Aggregate output, correctly ordered: a digital table (fast path, full markdown table), a scanned PDF (recovered via
  the OCR retry), and a deliberately-corrupt PDF (`[BRAK]` + one `multimodal/extraction-failed` WARN). A digital-only
  task returned its single block with the OCR-retry branch empty and **no stall** (the common case). The reader stays
  pure (warnings returned to the caller, not posted). The one CRITICAL during testing was a malformed test-harness
  form POST (wrong content-type to the Form Trigger), unrelated to the Docling path — same artifact noted in Block 3.

## References

ADR-036 (input reading; `.zip` listed unsupported — superseded for `.zip`), ADR-046 (aggregate storage watchdog; covers the transient decompressed-file disk usage), ADR-044 (retention/erasure; the 24h purge aligns), ADR-043 (PD-blind posture, unchanged). Provider vision specs: Claude standard 1568 px / ~1.15 MP, high-res 2576 px; Gemini 768 px tiles, 3072 x 3072 cap. Cleanup mechanism: pg_cron (Supabase has no native object TTL).
