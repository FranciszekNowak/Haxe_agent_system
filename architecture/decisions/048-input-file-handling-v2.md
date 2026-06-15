# ADR-048: Input file handling v2 — zip unpacking, Supabase object storage for zip-inner images, a global file-processing config, and Docling tuning

Status: Accepted (implementation pending; see the attached Claude Code prompt). Two build-time gates inside (large-image provider acceptance; compression-node memory behavior) confirm one correctness point and tune one guard value.
Date: 2026-06-13
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

Supabase has no native object lifecycle (verified), so a daily pg_cron job deletes input-bucket objects older than 24 hours using the proper storage deletion path (a bare `delete from storage.objects` orphans the bytes; use the storage delete so bytes are freed). DB-native, not an n8n scheduled workflow, so it respects the event-driven-n8n principle, and it serves data minimization (aligns with ADR-044).

### 6. Docling tuning (low-hanging fruit only).

Measure first (is OCR firing on documents that do not need it; per-document time; resident RAM), then apply the cheap wins: scope OCR to scanned or image inputs only, use TableFormer fast mode if currently accurate, and bound Docling concurrency in front of `docling:5001` so a many-document zip cannot saturate the box. Keep Docling (its table and layout fidelity is the point); isolating it onto its own host is the durable move and is a follow-up, not done here.

## Consequences

- The zip OOM cannot occur: zip-inner images are URLs, never base64.
- Reader-only change. `invoke-model.json` is untouched (no crown-jewel edit), and the existing loose-image and loose-document paths are byte-for-byte unchanged. Smallest blast radius of the options considered. (Loose images still rely on ClickUp's own attachment-URL TTL covering that same reader-to-provider gap; whether that TTL is ever too short under heavy queuing is a separate, pre-existing question worth verifying independently, not something this change introduces or fixes.)
- New external dependency for zip-inner images only: Supabase Storage (EU bucket `zip-inner-images`, `haxe-agent-prod`/`eu-west-1`, private). No image transforms. Signed-URL TTL must outlive the internal gap from when the reader stores the image to when the provider fetches it at the invoke-model step. **Build gate D (the provider-fetch probe), 2026-06-15: PASSED** — a private-bucket object uploaded via the Store step, signed with a 6h TTL, was fetched and read by the provider through LiteLLM end-to-end (Gemini via Vertex returned a correct description; usage reported 1089 image tokens, so the bytes were genuinely retrieved and tokenized, not just URL-echoed). The chosen TTL is 21600 s (6 h), well under the 24 h cleanup, with `cache-control: max-age=3600`. Gates A (large-image acceptance) and B (compression-node memory) remain for Block 3. In queue mode that gap can include inter-stage queue latency (not the initial pre-run queue wait, which precedes the reader obtaining any URL), so set the TTL to several hours, under the 24h cleanup; set a short `cacheControl` since objects are deleted. GDPR: EU bucket plus 24h purge is a data-minimization positive; provider fetch is the same egress base64 would have produced, so no new residency surface; PD-blind posture (ADR-043) holds.
- No downscale step: zip-inner images are stored and served at original size, the same contract as loose images. One build-time probe confirms large images are accepted by the provider; if not, a provider-limit cap is reintroduced as a correctness guard.
- All file limits are global and DB-tunable; none scale with impact; no hardcoded caps remain.
- Docling tuning lowers CPU and the concurrency bound protects the shared box from zip document bursts.

## References

ADR-036 (input reading; `.zip` listed unsupported — superseded for `.zip`), ADR-046 (aggregate storage watchdog; covers the transient decompressed-file disk usage), ADR-044 (retention/erasure; the 24h purge aligns), ADR-043 (PD-blind posture, unchanged). Provider vision specs: Claude standard 1568 px / ~1.15 MP, high-res 2576 px; Gemini 768 px tiles, 3072 x 3072 cap. Cleanup mechanism: pg_cron (Supabase has no native object TTL).
