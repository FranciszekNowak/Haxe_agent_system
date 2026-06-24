# zip-extractor

Off-worker zip extraction for the Haxe agent reader (ADR-058).

## Why this exists

The n8n reader (`read-input`, workflow `zgGpONulGMohQQqI`) used to decompress zip attachments
inside the workflow with the `n8n-nodes-base.compression` node. That node uses **adm-zip, which
inflates the entire archive into memory at once**. On the production worker (768 MB Node heap,
1 GiB container, `N8N_CONCURRENCY_PRODUCTION_LIMIT=5`, 0 swap) a single >500 MB zip OOM-killed
the worker *process* — which, in n8n queue mode, took down every co-running execution with it
(the 2026-06-24 07:30 CRITICAL cascade: `Read Input` → `Assemble Context` → `Agent Orchestrator`
→ `CU Webhook Producer`, all "possible out-of-memory issue").

The existing size caps (`zip_max_entries`, `zip_max_file_mb`, `zip_max_total_uncompressed_mb`)
ran *downstream* of the decompress node, so they bounded what was forwarded to Docling/Supabase
but could not bound the decompress spike itself (migration 028's comment admits this).

This service moves extraction **off the n8n worker** onto isolated compute (Wardley: extraction
is commodity, so it runs on its own container, not the shared orchestration worker). It streams
the zip to local disk and walks it **one entry at a time** (`yauzl`), so peak memory is ~one
entry (bounded by the per-file cap), never the whole archive. The OOM becomes impossible by
construction.

## Contract

```
POST /extract
  { "url": "<clickup pre-signed zip url>",
    "task_id": "<clickup task id>",
    "attachment_id": "<parent attachment id>",
    "parent_title": "archive.zip",
    "caps": { "max_entries": 50, "max_file_mb": 25, "max_total_mb": 250 } }
```

`caps` are single-sourced from the n8n `config` table (the reader reads them via its existing
`Lookup File Processing Config` node and passes them in); the service falls back to 50/25/250.

Response:

```
200 { "ok": true, "entries": [
  { "index": 0, "name": "spec.pdf", "ext": "pdf", "mime": "application/pdf", "size": 1234567,
    "route": "document", "att_id": "<parent>:0", "storage_path": "<task>/<parent>_0",
    "signed_url": "https://…/storage/v1/object/sign/…?token=…", "stored": true },
  { "index": 1, "name": "logo.png", "ext": "png", "route": "image", … },
  { "index": 2, "name": "inner.zip", "route": "drop", "drop_reason": "nested_zip",
    "warn_source": "multimodal/zip-nested-skipped" }
] }
```

- `route`: `image` | `document` (uploaded to the bucket, `signed_url` set) or `drop`.
- Drop `drop_reason` / `warn_source` strings mirror the reader's old `Explode Zip Entries` node,
  so n8n's `Build Dropped Zip Block` and alerting paths are unchanged.
- Junk (directories, `__MACOSX`, dotfiles) is silently skipped (no manifest entry).
- A **corrupt/unreadable** archive returns `200` with a single `zip_extraction_failed` drop
  (graceful — the run continues, a WARN fires).
- An **infra failure** (download failed, unexpected exception) returns `502` so n8n's
  `onError: continueRegularOutput` degrades to a drop **and** escalates the alert.

`GET /health` → `200 { ok: true }`.

## Environment

| Var | Required | Default | Notes |
|-----|----------|---------|-------|
| `SUPABASE_URL` | yes | — | e.g. `https://hkeslnosxibeuesxndnz.supabase.co` |
| `SUPABASE_SERVICE_KEY` | yes | — | service_role key — private-bucket upload bypasses RLS |
| `BUCKET` | no | `zip-inner-images` | same bucket as zip-inner images (purge covers it) |
| `PORT` | no | `8080` | internal only |
| `SIGN_TTL` | no | `21600` | signed-URL TTL, 6 h — mirrors the reader |

`SUPABASE_URL` / `SUPABASE_SERVICE_KEY` are **not currently in `/opt/haxe-agents/.env`** (n8n
uses an encrypted `supabaseApi` credential). They must be added there for this container — that
`.env` edit is the one step requiring operator sign-off.

## Deploy (VPS)

1. Put the source on the VPS: `git pull` (or scp) so `/opt/haxe-agents/zip-extractor/` exists.
2. Add `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` to `/opt/haxe-agents/.env`.
3. Merge `docker-compose.snippet.yml` into `/opt/haxe-agents/docker-compose.yml`.
4. `cd /opt/haxe-agents && docker compose up -d zip-extractor` (ADR-033).
5. Smoke test from the n8n worker network:
   `docker exec n8n-worker node -e "fetch('http://zip-extractor:8080/health').then(r=>r.json()).then(console.log)"`

**Do not** mount `/tmp` as tmpfs — tmpfs is RAM-backed and would reintroduce the OOM. Leave
`/tmp` on the disk-backed overlay.

## Local dev

```
npm install
SUPABASE_URL=… SUPABASE_SERVICE_KEY=… node app.mjs
```
