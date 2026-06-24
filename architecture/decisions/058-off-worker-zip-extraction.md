# ADR-058: Zip extraction moved off the n8n worker (dedicated container)

## Context

On 2026-06-24 at 07:30 a chain of four CRITICAL alerts fired — `Read Input (v1)`,
`Assemble Context and Build Prompt (v1)`, `Agent Orchestrator (v1)`, `CU Webhook Producer (v1)`
— all reading *"Workflow did not finish, possible out-of-memory issue."* Investigation showed
this was **one failure, not four**:

- `Read Input` execution 3428 ran for ~1.5 s and crashed at the **`Decompress`** node (an
  out-of-memory kill, not a timeout). Every other node in the four executions carried
  `isArtificialRecoveredEventItem` — n8n crash-recovery markers written because the worker
  *process* died mid-run.
- The other three executions had no bug of their own. In n8n **queue mode many executions share
  one worker process**, so when `Decompress` exhausted the worker heap the kernel OOM-killer
  killed the whole worker and took every co-running execution down with it (the cascade).

Root cause: the reader's zip path (added in ADR-048 Block 3) used
`n8n-nodes-base.compression` (`Decompress`), which wraps **adm-zip — and adm-zip inflates the
*entire* archive into in-memory Buffers at once**. The size guards (`zip_max_entries`,
`zip_max_file_mb`, `zip_max_total_uncompressed_mb`, migrations 027/028) run *downstream* in
`Explode Zip Entries`, so they bound what is forwarded to Docling/Supabase but **cannot bound
the decompress-time spike**. ADR-048 Decision 4 / migration 028 explicitly *accepted* that
spike, sizing the total-uncompressed cap to 250 MB to "keep it survivable" — but on two wrong
premises: (1) the cap is checked after extraction, so it never bounds the spike, and (2) it
assumed an "8 GB box" when the n8n worker is actually capped at **1 GiB container /
`--max-old-space-size=768`**, runs `N8N_CONCURRENCY_PRODUCTION_LIMIT=5`, with **0 swap**. A
single >500 MB zip (or a few concurrent mid-size ones) blows the heap in ~1 second.

The operator confirmed the real-world workload these zips represent: **regular, large
(>500 MB), mixed images + documents, expected to be read within the agent's turn.** So the fix
must actually *process* big zips, not reject them.

Two in-n8n alternatives were ruled out:
- A Code-node per-entry `require('zlib')` inflation: the Code sandbox blocks `require`
  (`NODE_FUNCTION_ALLOW_BUILTIN` is unset), and even per-entry the *compressed* bytes of a
  >500 MB archive won't fit in 768 MB heap.
- Raising the worker memory: the box has ~2.9 GB free and 0 swap; throwing RAM at an unbounded
  input is fragile (a bigger zip still OOMs, and concurrency multiplies it) and risks trading a
  zip OOM for a whole-box OOM that takes down Docling too.

## Decision

**Move zip extraction off the n8n worker onto a dedicated, isolated container**
(`services/zip-extractor/`, deployed at `/opt/haxe-agents/zip-extractor/`, on the
`n8n-internal` network next to `docling`).

The service exposes `POST /extract { url, task_id, attachment_id, parent_title?, caps? }`. It:
1. streams the zip to local disk (never the whole archive in RAM),
2. walks it **entry-by-entry** with `yauzl`, applying the same caps + junk-skip + nested-zip-drop
   taxonomy as the old `Explode Zip Entries` node (caps are single-sourced — n8n passes them from
   the `config` table),
3. uploads each accepted entry to the existing private Supabase bucket `zip-inner-images`
   (service_role key, mirroring the reader's `Zip Image Key`/upload/sign nodes, 6 h signed URLs),
4. returns a **manifest** (`[{ index, name, ext, mime, size, route, att_id, storage_path,
   signed_url, stored, drop_reason?, warn_source? }]`).

n8n's reader then fans the manifest into its **existing** image / document / drop paths (Block 2);
it never decompresses anything. Peak heap on the extractor is ~one entry (bounded by the per-file
cap), **flat in archive size**.

This placement follows the project's build-vs-buy gate: generic zip extraction is a **commodity**,
so it runs on its own isolated compute, not the scarce shared orchestration worker. A managed
Supabase Edge Function was considered and rejected for this scale: its ~256 MB memory cap, wall-
clock limit, and the need for HTTP range reads on the (directory-at-the-end) zip — which ClickUp
signed URLs may not support — make a self-hosted container that streams to real disk the robust
choice for ">500 MB, regularly." A self-hosted container is the justified exception because no
managed option cleanly covers the size + the ClickUp-URL/Supabase-upload glue.

## Consequences

- **The OOM is eliminated by construction**, not merely made less likely: the worker no longer
  holds any archive bytes. Verified live — processing a 176 KB archive that inflates to 180 MB
  uncompressed (the dangerous tiny-compressed/huge-uncompressed case), peak extractor RSS held at
  ~184 MiB / 512 MiB and did not grow with content size. The collateral cascade is resolved by the
  same fix (no worker death → no co-execution kills).
- **Supersedes ADR-048 Block 3 "Gate B" / Decision 4**: zip extraction is no longer in-workflow
  adm-zip, and migration 028's "accepted in-memory spike" no longer applies (the spike is now off
  the worker and bounded). The 250 MB total cap remains as a forwarded-content bound, enforced in
  the extractor and re-checkable downstream.
- **New operational surface**: one more container to run/patch, and two new `.env` keys
  (`SUPABASE_URL`, `SUPABASE_SERVICE_KEY`) on the VPS. The service holds a service_role key — it
  must stay server-side (it already lives in n8n's `supabaseApi` credential for the same reason).
- **Failure modes** route through the existing seam: a corrupt/unreadable archive returns a single
  `zip_extraction_failed` drop (graceful, WARN, run continues); an infra failure (download/
  unexpected) returns 502 so the reader's `onError: continueRegularOutput` degrades to a drop and
  escalates the alert. The container has a healthcheck; if it is down, the reader's call fails →
  CRITICAL via `Post Alert (v1)`.
- **Latency is unchanged for the synchronous read** but is *not* solved by this ADR: a
  document-heavy >500 MB zip can still exceed the agent's 840 s soft-deadline because each document
  goes through Docling. If that proves regular, a two-phase **async** design (job table + out-of-
  band Docling drain + deferred re-invocation) layers on this container foundation — deferred to a
  future ADR, gated on evidence. Images are cheap (signed URLs) and are never the latency sink.
- **Memory note**: `/tmp` in the container must stay on the disk-backed overlay; mounting it as
  tmpfs (RAM-backed) would reintroduce the exact OOM this ADR removes.

## Block 2 — reader rewiring (landed 2026-06-24)

The `read-input.json` zip branch (workflow `zgGpONulGMohQQqI`) now reads
`Zip? Switch[zip] → Zip Caps → Call Extractor → Fan Manifest → Classify Zip Entry`, with
`Classify Zip Entry` unchanged (image → `Build Zip Image Block`; document → `Fetch Zip Doc Binary →
Stamp Zip Doc Filename → Merge Extractable → Docling`; drop → `Build Dropped Zip Block`). Eight nodes
were removed: the in-workflow `Fetch Zip Binary → Stamp Zip Filename → Decompress → Explode Zip
Entries` chain and the now-redundant `Zip Image Key → Upload Zip Image → Sign Zip Image URL → Compose
Signed URL` (the extractor does upload+sign server-side).

Three nodes beyond the original wiring sketch proved necessary:

- **`Zip Caps` + `Await Caps` (honoring live `config`)** — the caps must be resolved in a Code node, not
  inline in the `Call Extractor` HTTP body: referencing `$('Lookup File Processing Config').first()` from
  an n8n *expression* **throws** (`Node … hasn't been executed`) because n8n's v1 order defers the parallel
  `Lookup` side-branch until *after* the whole zip branch; `onError` caught the throw and silently degraded
  every zip to a false `zip_extraction_failed` drop (exec 3571). The first fix (a defensive `try/catch →
  50/25/250` in `Zip Caps`, mirroring the old `Explode Zip Entries`) stopped the crash but kept using
  defaults, **not** live config — which is what the old zip path did too, and which the operator flagged as
  wrong (config is the single source of truth). Reordering `Get Task`'s outputs did **not** help (verified:
  `Lookup` still ran last, `caps_source=default`, exec 3575). The working fix is **`Await Caps`**, a `Merge`
  (chooseBranch, output Input 1) on the spine — `Explode Attachments → Await Caps → Zip? Switch`, with
  `Lookup` as its second input — that **waits for both inputs**, forcing `Lookup` to execute before the zip
  branch. It sits on the *main* spine (after `Explode`, which always emits ≥1 item) rather than the
  conditional `Zip? Switch[zip]` output, because a barrier on the conditional output **hangs** when there
  is no zip (input never delivers → the whole convergence stalled and the sub-workflow returned the raw
  config row, exec 3579). With the spine barrier, `Zip Caps` reads live config (`caps_source=config`,
  verified exec 3583); the `'default'` fallback remains only for a genuine DB-read failure and is visible
  in the execution data via `caps_source`.
- **`Stamp Zip Doc Filename`** — a zip-inner document is fetched from its Supabase signed URL, whose
  object key is the sanitized `att_id` with **no file extension**, so the downloaded binary lacks the
  filename Docling uses for format detection. This node restores `fileName`/`fileExtension`/`mimeType`
  from the manifest entry (the same class of fix as the old `Stamp Zip Filename` for the compression
  node), so PDF/DOCX/XLSX/HTML are detected reliably.

Verified end-to-end via `scripts/test-subworkflow.mjs` against a disposable ClickUp task carrying a
mixed zip (PNG, CSV, a real 10 KB DOCX, a nested zip, a junk dotfile): `Call Extractor` returned a
4-entry manifest, the reader produced correctly interleaved blocks (image signed-URL block at 0.001,
CSV and DOCX Docling text blocks at 0.002/0.003, nested-zip `[BRAK]` drop at 0.004), the junk dotfile
was silently skipped, and only the expected `multimodal/zip-nested-skipped` WARN rode the reader's
returned `warnings`. Zero CRITICAL, every node `status=success` with no `isArtificialRecoveredEventItem`
markers (i.e. no worker crash), and `Zip Caps` emitted `caps_source=config` (live config honored). A
separate **non-zip** run (a task with only a loose image) was checked after adding `Await Caps` to confirm
the barrier did not regress that path: it returned the single loose-image block with no spurious zip drop.

## Block 3 — retention coverage for zip-inner documents (verified, closed 2026-06-24)

Block 3 was scoped as "extend the bucket purge to zip-inner *documents*." Investigation showed the
extension is **already in place by construction — no purge code change is needed** — and the real
deliverable is bringing the compliance and architecture records into line with what the bucket now
holds. Reasoning and evidence:

- **Documents and images share one bucket.** The extractor (`services/zip-extractor/app.mjs`) uploads
  **every** accepted entry — image *and* document — to `zip-inner-images` (the `BUCKET` env, set to
  `zip-inner-images` in `docker-compose.snippet.yml`), with an identical, extension-less key shape
  `<task_id>/<sanitized att_id>`. Image vs document is therefore **indistinguishable by object key**.
- **The purge has no type predicate.** `purge_zip_inner_images(p_force boolean)` (migration 030) selects
  `from storage.objects where bucket_id = 'zip-inner-images' and created_at < now() - interval '12h'` and
  deletes each by `name` via the Storage REST API. There is no extension/mime/route filter anywhere in the
  path, and the keys carry no type marker — so the purge **cannot** delete an image yet skip a document;
  they are the same kind of row. Coverage of documents is a logical certainty, not a probabilistic claim,
  which is why no destructive live test was run (it could only re-confirm what the code makes impossible to
  violate).
- **Live verification (2026-06-24).** The cron job `purge-zip-inner-images` is `active`, schedule
  `0 3,4 * * *`, running `select public.purge_zip_inner_images()`; the live function signature is the
  migration-030 `(p_force boolean)` overload; the bucket is `public=false` with `allowed_mime_types = null`
  (no MIME allowlist — document uploads are accepted, as Block 2's live DOCX/CSV test already proved); the
  daily run logs `nothing to purge` cleanly in `storage_purge_runs`. The independent n8n
  `Zip Image Purge Watchdog (v1)` watches the **bucket** (not a type), so it covers documents too.

**Retention decision for documents (unified, not split).** Zip-inner documents inherit the **same**
retention as images — purged daily ~05:00 Europe/Warsaw, >12h, ≤~36h max. A separate, *shorter* purge for
documents was considered and rejected: (1) the bucket keys carry no type marker, so a key-based selective
purge is impossible without a side index — added surface for no real gain; (2) it would fork one pg_cron
job + one watchdog into two, against the project's unification default (CLAUDE.md), for a path that does
not need it — documents are fetched by Docling *within the same agent run* (minutes), so the 12h floor is
already a large safety margin; (3) ~36h for EU-private, signed-URL-only files is the same documented
data-minimization posture already accepted for images. The one substantive consequence is that the bucket
now also holds **documents** (PDF/DOCX/XLSX/CSV), which can carry more concentrated personal data than a
photo — so the GDPR processing record (§6) and `architecture/current.md` are updated from "images" to
"images **and** documents," which is the actual write-back this block lands.

**Definition of Done (this block):** purge demonstrably covers document objects (closed by the no-type-
predicate argument + live function/bucket/cron checks above); the GDPR record and `current.md` accurately
describe the bucket as holding images *and* documents with the unified retention; ADR closed. ✅

## Date

2026-06-24 (Block 1); 2026-06-24 (Block 2 reader rewiring); 2026-06-24 (Block 3 — document retention coverage verified + records reconciled)
