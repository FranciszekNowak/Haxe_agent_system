# ADR-036: Multimodal I/O and image generation

> **Status: IN PROGRESS** — Phase 1 schema decisions recorded below.
> Phases 2–5 will append consequences as each subworkflow is built and verified.

---

## Context

The agent spine (ADR-022/027/035) handles text-in → text-out. The next capability
needed is multimodal: teammates will attach product documents (`.docx`, `.xlsx`,
`.pdf`) and reference photos to tasks, and expect the agent to read them as context
and produce comments that may include generated images (product mockups, PDP layouts,
lifestyle visuals). The primary use case is pre-photoshoot PDP mockup generation for
new product launches — a fast visual iteration loop before the real shoot.

Two principles constrain the design:

1. **GDPR boundary.** The existing text path enforces EU-residency for `personal_data=true`
   content (Bedrock EU). Image-generation payloads carry no personal data (the prompt is
   a structured visual description, not PII), so they can route to non-EU image providers
   selected by `impact` alone. The text path is not relaxed.

2. **Block contract over raw binaries.** File bytes must not cross workflow boundaries.
   Everything is a reference (`ref`) — a ClickUp-hosted URL or a temp-dir path — resolved
   inside the node that needs the bytes. This keeps sub-workflow contracts clean and
   avoids serialisation explosions.

---

## Decision

### Schema (migration 012 — applied 2026-06-09)

**`model_routing` extensions** — three new columns:

- `modality text NOT NULL DEFAULT 'text'` — distinguishes text routing rows (existing)
  from image routing rows (new seeds: `low`/`medium`/`high` English keys).
- `eu_only boolean NOT NULL DEFAULT false` — set to `true` for all `personal_data=true`
  (Bedrock EU) text rows post-migration; `false` for Anthropic direct rows and all image
  rows. Used by the step-down fallback query: text fallback filters `eu_only=true`;
  image fallback does not.
- `fallback_price_per_unit numeric(10,6)` — static price for image providers that omit
  the `x-litellm-response-cost` header. NULL when LiteLLM returns the header.

**Unique index** — partial on `(impact, modality) WHERE modality != 'text'`. A full
unique constraint would fail: text rows have two `personal_data` variants per impact,
both landing on `modality='text'` after the column is added. The partial index enforces
one image model per tier while leaving text rows unrestricted.

**`image_gen_params` table** — per-tier caps keyed by English `impact`:

| impact | max_images | resolution |
|--------|-----------|------------|
| low    | 2         | standard   |
| medium | 4         | high       |
| high   | 8         | max        |

Image tiers use English keys (`low`/`medium`/`high`) intentionally distinct from the
Polish text-routing keys (`Niski`/`Średni`/`Wysoki`/`Krytycznie ważne`). Both coexist
in `model_routing` without PK collision.

> **Update 2026-06-10 (supersedes the English-key decision above — migration 013).**
> The English keys were a workaround for the `(impact, personal_data)` PK: a Polish-keyed
> image row would have collided with the text row of the same tier. But tasks only ever
> carry the Polish ClickUp field values, so the `low`/`medium`/`high` image rows were
> **unreachable by real routing**. Migration 013 fixes the root cause: the PK is promoted
> to `(impact, personal_data, modality)`, the image rows + `image_gen_params` are rekeyed
> to the ClickUp tiers, and two new image rows are added — `Krytycznie ważne` (shares the
> top image model with `Wysoki`, mirroring text routing) and `__default__` (blank-field
> fallback). Resulting image map: `Niski`→stable-diffusion-3-5 (2/standard),
> `Średni`→imagegeneration@006 (4/high), `Wysoki`/`Krytycznie ważne`→dall-e-3 (8/max),
> `__default__`→imagegeneration@006 (4/high).
>
> **Required non-DB change:** once image rows share Polish keys, the text-routing SELECTs
> can match them, so both `Invoke Model (v1)` and `Decide Research and Deliver (v1)` now
> filter `and modality = 'text'`. The `Fable 5 Access Monitor` remediation hint was
> likewise scoped with `AND modality='text'` so a copy-paste rollback can't clobber the
> image row. No image-consuming workflow exists yet (Phases 2–5 unbuilt), so nothing
> downstream of the seeds changed.

**`config` table** — system configuration key/value pairs:

| key           | value           |
|---------------|-----------------|
| image_host    | comment_native  |
| tmp_root      | /tmp/agent-runs |
| tmp_ttl_hours | 24              |

`image_host=comment_native` means generated images are staged in a per-run server temp
dir (`/<tmp_root>/<run_id>/`), uploaded to the ClickUp task as attachments to get a URL,
then referenced in the posted comment. An `assets_sink`/`object_store` alternative
(external S3 or similar) was designed for but not implemented; it is addable later by
changing this config value and adding the corresponding upload node.

**`agent_runs.triggered_by` CHECK** — extended to include `'image_gen'`. Each image
generation attempt logs one row with `triggered_by='image_gen'`, `impact` = the tier
used, and `model_used` = the LiteLLM alias. `Sum Task Cost` aggregates all rows
including image_gen automatically.

**Image model seeds** (verify availability + cost headers at build time; replace model
IDs if the listed versions are unavailable):

| impact | litellm_model                       | provider   |
|--------|-------------------------------------|------------|
| low    | stability/stable-diffusion-3-5      | stability  |
| medium | vertex_ai/imagegeneration@006       | vertex_ai  |
| high   | openai/dall-e-3                     | openai     |

### Extraction service (Docling)

Single extractor on the VPS (`quay.io/docling-project/docling-serve`, port 5001 internal).
Covers xlsx, docx, csv, txt, pdf, pptx, and images (OCR). Emits markdown with layout and
tables. No provider fallback — a file that defeats Docling surfaces as a `[BRAK:
extraction_failed <filename>]` marker and a WARN alert; the run continues. GPU preferred
but CPU-only is acceptable at this volume.

n8n reaches Docling at `http://docling:5001` (internal bridge network). Added to
`n8n/docker-compose.yml` alongside the existing n8n/LiteLLM stack.

### Block contract

All readers and the drafting model speak one shared ordered list of blocks. References
only cross workflow boundaries; bytes are resolved locally.

Input blocks (emitted by readers):
```json
{ "type": "text",  "order": 0, "md": "..." }
{ "type": "image", "order": 1, "ref": "<clickup_url>", "mime": "image/png",
  "source": "input", "source_ref": "<attachment_id>", "alt": "..." }
```

Output blocks (emitted by drafting model):
```json
{ "type": "text",  "md": "..." }
{ "type": "image", "mode": "embed_input", "ref": "photo_2", "caption": "...", "alt": "..." }
{ "type": "image", "mode": "generate",    "prompt": "...", "aspect": "1:1", "caption": "...", "alt": "..." }
```

`embed_input` = place an existing input image inline (no upload, no model call).
`generate` = synthesize a new image from the prompt via the image-resolver.

### GDPR / Bedrock image stance

When `personal_data=true` AND the input contains image blocks, SW1 (Stage A):
1. Posts a WARN via `Post Alert (v1)`: `source=assemble-context`, code `multimodal/image-dropped-pd`.
2. Replies to the triggering user (Polish): "Zdjęcia nie mogły zostać przetworzone — aktywna ochrona danych osobowych. Odpowiedź zostanie wygenerowana na podstawie treści tekstowych."
3. Drops image blocks from the prompt payload.
4. Routes to Bedrock EU alias (text-only call).

This replaces the earlier spec 3.7 silent guard. No silent drops.

### Step-down fallback

Image tier failure → retry at the next lower tier + WARN (`multimodal/tier-degrade`). At
the lowest tier, drop the block and insert `[Obraz niedostępny]` + WARN. The comment still
posts. Text step-down mirrors this but applies `eu_only=true` filter.

### Delivery (comment_native, staged)

1. B (execute-create-output): generate → write to `/tmp/agent-runs/<run_id>/`, return Delta
   with temp-path refs + `temp_manifest`.
2. C (post-back): upload manifest → CU attachment URL → rewrite Delta refs → post comment.
3. On success: delete run temp dir. On failure after partial upload: rollback uploaded
   attachments (DELETE by attachment ID), retain temp for retry.
4. TTL sweep cron (every 6 h): delete dirs older than `tmp_ttl_hours` (catches crashed runs
   that never reached cleanup).

### Spine decomposition

The existing Agent Spine becomes a thin orchestrator calling three stage subworkflows in
sequence, each with its own execution log and a shared Reset+Alert on failure:

| Stage | Subworkflow | Returns |
|-------|-------------|---------|
| A     | assemble-context-and-build-prompt | `{ prompt_payload, input_blocks, impact, ... }` |
| B     | execute-llm-call | `{ rendered_comment(delta, temp refs), temp_manifest, total_cost_pln }` |
| C     | post-reply | `{ status }` |

C owns every ClickUp side-effect: comment post, cost field write, status flip, temp cleanup.

### Input readers unified (Update 2026-06-10 — supersedes the two-reader split of spec §2.1–2.3)

The spec splits input reading into `read-input-text` and `read-input-visual` behind an
`input-router`. Building Block 2 showed that split cuts along the wrong axis: the scaffolding
(`fetch binary → Docling → build block → aggregate`) is **identical for everything Docling
extracts** — `xlsx/docx/csv/txt` **and** `pdf/pptx`. The only genuinely different case is an
**already-attached image**, which is pure URL passthrough (no fetch, no Docling — emit an image
block from the existing ClickUp URL). The `read-input-visual` reader would itself have had to
branch internally (pdf/pptx → Docling vs png/jpg → passthrough), which is the tell that the real
axis is **"Docling-extract vs image-passthrough," not "text vs visual."**

**Decision: one unified `read-input` reader that branches images past Docling.** Images are a
URL passthrough, so they must **skip Fetch+Docling** — confirmed 2026-06-10 (operator): per-answer
latency is already ~1–2 min, and fetching+OCR-ing reference photos only to discard the OCR is an
easy, obvious cut. Structure:

```
Explode → Switch (is-image?)
            ├─ image       → Build Image Block (ref = ClickUp URL, no I/O) ─┐
            └─ extractable → Fetch → Docling → Build Text Block ─────────────┤→ Merge → Aggregate → return
```

This is **not** the hazard that bit Block 2. The n8n sub-workflow-return gotcha is about *dead-end
side branches* making the return node ambiguous; here the branch **converges** and `Aggregate`
remains the **sole terminal**, so the return stays deterministic. Two things Block 3 MUST verify at
build (both are the *other* n8n traps from Block 2):
1. **`Aggregate` keeps exactly one input** — converge the two branches through a `Merge` (Append)
   first; never wire both branches straight into the run-once-for-all-items `Aggregate` (that runs
   it once per connection and drops items).
2. **`Merge` must not stall on an empty branch** — a task with only text files leaves the image
   branch empty (and vice-versa). Verify n8n 2.56's `Merge` proceeds; if it stalls, fall back
   (e.g. `alwaysOutputData` on the branch tails, or route both through a single run-once-for-each
   builder that emits the right block type per item, then one `Aggregate`).

`Build Block` is split by type: image → `{type:image, ref:<clickup_url>, mime, source_ref, alt}`;
Docling-extractable → `{type:text, order, md}`; failure → `[BRAK]` + a returned `warning`.

**Cascade:** with one reader there is no text/visual classification to centralize, so the
**`input-router` (Block 4) largely dissolves** — the reader reverts to taking `{ clickup_task_id }`,
self-fetching the task, exploding + assigning global `order` to all attachments itself, and
returning `{ blocks, clickup_task_id, warnings }`. (This partially reverts Block 2's "dumb reader
takes a pre-classified list" shape, which was correct only under the two-reader assumption.) The
reader stays a pure/branch-free function whose `warnings` are fired by its caller (Stage A) through
`Post Alert (v1)`. Unsupported attachment types (`.zip`, `.mp4`, …) need no classifier — they fail
Docling → `[BRAK]` + warning, handled by the same path.

**Plan impact:** Blocks 2 + 3 + 4 collapse toward a single `read-input`. Block 3 is no longer "build
a second (visual) reader" but **"extend `read-input-text` → unified `read-input`"**: add the image
branch to `Build Block`, restore self-fetch (`{clickup_task_id}` in), rename the workflow, retire
the separate router. Unaffected and still separate: pdf/pptx page-image rendering/hosting (Block 10)
and image **generation** (Phase B) — those are output/hosting concerns, not reader extraction.

---

## Consequences

> _To be filled in as phases complete._

- Phase 1 (schema): migration 012 applied; Docling service added to compose; image model
  seeds require LiteLLM availability check before Phase 2 begins.
- **Block 1 (Docling LIVE) — 2026-06-10.** Docling verified running on the VPS: image
  `quay.io/docling-project/docling-serve@sha256:c7ba482f…`, and the running container's resolved
  digest **matches** the pin in `n8n/docker-compose.yml` (no drift). `GET /health` → 200; ~1.9 GB
  RSS idle with ≥4 GB free, no OOM. API confirmed against the container's own OpenAPI:
  `POST /v1/convert/file` (multipart field `files`), markdown returned at `document.md_content`
  (also `html_content`/`text_content`/`json_content`/`doctags_content`; async + chunking endpoints
  exist but are unused). Smoke-tested on the committed fixtures — `HBG Sharp.docx` (clean structured
  md), `2026-06-10 Wzorcowa specyfikacja.xlsx` (**260 pipe-table rows → table structure survives**),
  and `Karta Techniczna…HX705.pdf` (graphic one-pager; clean product text in `placeholder` mode).
  **Gotcha for the readers (Blocks 2–3):** Docling's default `image_export_mode=embedded` inlines
  page images as base64 data URIs — one PDF ballooned to 242 KB vs **1.3 KB** of clean text with
  `image_export_mode=placeholder`. Readers MUST pass `image_export_mode=placeholder` or LLM payloads
  / token cost silently explode. Also corrected the spine doc-drift in `current.md` (§11/§15 still
  described a monolithic 26-node `agent-spine.json`; reality is the decomposed `Agent Orchestrator
  (v1)` → Stage A/B/C, id `a8XKaijkMFNBpRBa` now the thin orchestrator).
  **Silent-failure coverage (reliability mandate).** _Covered:_ an unhealthy/OOM Docling is guarded
  at the Docker level by the container `healthcheck` (`GET /health`) + `restart: unless-stopped`;
  digest reconcile prevents silent image drift. _Knowingly DEFERRED:_ there is **no `Post Alert (v1)`
  ClickUp alert for "Docling down / erroring at request time"** in Block 1, because nothing consumes
  Docling yet — it is added in **Block 2** (`read-input-text`'s per-file `multimodal/extraction-failed`
  WARN). A proactive Docling freshness / dead-man's-switch cron only becomes meaningful once a reader
  depends on it; deferred to Block 2. Until then, a Docling outage degrades the (not-yet-wired) input
  path **silently** — acceptable only because no live workflow reads it yet.
- **Block 2 (`Read Input Text (v1)`, id `zgGpONulGMohQQqI`) — 2026-06-10.** First input reader is LIVE and
  verified end-to-end (n8n MCP build, ADR-018). It turns text-family attachments
  (`xlsx`/`docx`/`csv`/`txt`) into ordered input **text blocks** via Docling. **It is a PURE, branch-free
  function** — `When Called` in: `{ clickup_task_id, attachments:[{att_id,title,url,ext,mime,order}] }`;
  out: `{ blocks:[{type:'text',order,md}], clickup_task_id, warnings:[{source,title,err}] }`.
  **Division of responsibility (decided with the operator, aligns with spec §2.3):** the **input-router
  (Block 4) owns classification, global ordering, AND alert-firing**; the reader is a dumb processor that
  receives a pre-classified, ordered text-family list, extracts each, and *reports* problems as structured
  `warnings` for the router to fire through `Post Alert (v1)` (single alerting choke-point). This replaces
  the earlier self-filtering + in-reader-WARN design (which duplicated the router's MIME/ext switch and
  split the ordering logic). A `Get Task` HTTP node remains **only on the Form-Trigger test branch** for
  standalone runs.
  **Build mechanics confirmed live (exec 851, router-shaped call on `869dhad2q`):**
  (a) the n8n **ClickUp `get` node omits `attachments[]`**, so the test-harness fetch is an HTTP Request
  with the `clickUpApi` credential against `/api/v2/task/{id}` (ADR-019); (b) attachment bytes download
  from the pre-signed `url`/`url_w_query` with `authentication:none` into a **binary property**
  (`responseFormat:file` → n8n `filesystem-v2` store) — never base64 in the JSON flow; (c) `Docling
  Convert` is a multipart POST (`files` field) carrying **`image_export_mode=placeholder`** — verified:
  csv → clean markdown **pipe-table**, txt → clean text, ~no payload bloat; (d) a deliberately **scrambled
  input array sorted back to the router's `order`** → reader honors global order, not arrival order.
  (Heavy-format `.docx`/`.xlsx` Docling fidelity was already proven directly in Block 1; Block 2's live
  test used small `sample.csv`/`sample.txt` + a corrupt `broken.docx`.)
  **Two n8n gotchas found + fixed (durable — relevant to every sub-workflow):**
  (1) Docling returns **HTTP 200 with `status:"failure"` + `md_content:null`** for a corrupt file (it does
  *not* HTTP-error), so success is gated on **`document.md_content` presence**, not the status code.
  (2) **An `executeWorkflow` sub-workflow's return value is whichever node n8n deems "last"** — with any
  branching (IFs / side-effect nodes) it is NON-deterministic and was observed to return an IF branch's
  output, *not* the intended aggregator, regardless of connection order or node-array order. **The robust
  fix is a single, branch-free linear terminal**: collapsing the reader to `… → Build Block → Aggregate`
  with no side branches makes n8n return `Aggregate` deterministically. (This is the deeper reason the
  reader is a pure function and alerting moved to the router.) An earlier multi-input `Aggregate` also hit
  the classic *"run-once-for-all-items with N input connections runs once per branch, dropping items"* trap.
  **Silent-failure coverage (reliability mandate).** The reader **detects** every degradation and tags it
  into `warnings`: (1) Docling unreachable / non-200 / `status!=success` / empty `md_content` → `[BRAK:
  extraction_failed <file>]` block + a `multimodal/extraction-failed` warning, run continues (verified:
  corrupt file → block returned + one warning surfaced); (2) attachment binary fetch failure → same
  `[BRAK]` + warning; (3) embedded in-doc images dropped → `multimodal/embedded-image-skipped` warning;
  (4) a hard `Get Task` failure (test branch) throws → global `Error Handler (v1)` CRITICAL. **The actual
  `Post Alert (v1)` firing of `warnings` is a hard requirement on the input-router (Block 4)** and is the
  single point where these reach the Alerts channel. This is safe because the reader is in **no live path
  until the router + Stage-A wiring exist (Blocks 4–5)** — nothing calls it in production yet.
  _Knowingly DEFERRED:_ proactive Docling health / dead-man's-switch cron (operator decision — request-time
  detection only); real input-**image** blocks + page-render hosting (Block 3 / Block 10); the PD image
  stance (Block 6). The reader writes **no `agent_runs` row** (pure extractor, no model call — ADR-035
  owner unchanged).
  > **Update 2026-06-10 — superseded by the "Input readers unified" decision above.** The separate
  > `input-router` + `read-input-visual` split is retired. Block 3 instead extends this reader into the
  > unified `read-input` (add the image-passthrough branch to `Build Block`; restore self-fetch with
  > `{ clickup_task_id }` in; assign global `order` itself). Classification dissolves (one reader); the
  > reader still returns `warnings` for its caller (Stage A) to fire through `Post Alert (v1)`, and
  > unsupported types fail Docling → `[BRAK]` + warning (no classifier needed).
- Phase 2–5: consequences recorded when each phase is verified end-to-end.

---

## Date

2026-06-09 (Phase 1 schema decisions)
2026-06-10 (Block 1 — Docling verified live; spine doc-drift corrected)
2026-06-10 (Block 2 — `Read Input Text (v1)` verified live)
