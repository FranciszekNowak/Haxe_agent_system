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

> **Update 2026-06-12 (Block 6, supersedes this entire "GDPR / Bedrock image stance" section).**
> The PD-blind/global cutover (ADR-043, migration 021) deleted `personal_data`/`eu_only` and the
> Bedrock-EU route. There is **no `personal_data` branch, no `multimodal/image-dropped-pd` WARN, no
> Bedrock alias, and no EU branch** anywhere in the pipeline. The unprocessable-image guard (spec
> §3.7) is now **generic robustness, not a residency/PD control** — see the Block 6 entry in
> Consequences below for the live mechanism (reactive Opus→text-only safety net + a
> `multimodal/image-unprocessable` WARN).

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
  > **Done in Block 3 (below):** this workflow was extended in place (same id) into the unified
  > `Read Input (v1)`; `read-input-text.json` was renamed to `read-input.json`.
- **Block 3 (`Read Input (v1)`, id `zgGpONulGMohQQqI`) — 2026-06-10.** The unified reader is LIVE and
  verified end-to-end (n8n MCP build, ADR-018). `Read Input Text (v1)` was extended **in place** (same
  id, renamed) per the "Input readers unified" decision above; the file `read-input-text.json` →
  `read-input.json`. Blocks 2+3+4 are now **one reader** — the separate `read-input-visual` and
  `input-router` were never built and are formally retired (not built).
  **Shape (pure, branch-free; in `{ clickup_task_id }` → out `{ blocks, clickup_task_id, warnings }`):**
  `When Called`/`Form Trigger` → **`Get Task`** (self-fetch — restored; both triggers now go through it,
  the router that previously pre-fetched is gone) → `Explode Attachments` (normalize raw ClickUp
  `attachments[]`, assign **global `order` by index** — the reader owns ordering now) → **`Classify
  Attachment`** (Switch v3.4: image vs extractable) → branches → **`Merge Branches`** (append) →
  `Aggregate Blocks` (sole terminal). Image branch = `Build Image Block` (URL passthrough, **no I/O**):
  `{ type:image, order, ref:<clickup_url>, mime, source:input, source_ref:att_id, alt:title }`.
  Extractable branch = `Fetch Attachment Binary` → `Docling Convert` → `Build Text Block` (the former
  `Build Block`, unchanged + a `warn_source` tag).
  **Images branch PAST Docling — verified** (decided 2026-06-10: don't fetch+OCR a photo to discard the
  OCR; per-answer latency is already ~1–2 min). Live exec 858 (mixed task: 2 png + docx/txt/csv): `Fetch`
  and `Docling` each processed **only the 3 extractable files** (image items never entered either node);
  image blocks were built from the ClickUp URL with zero I/O. ClickUp sets `mime=image/png` on png
  uploads so the mime-primary check fires; the ext allowlist is the fallback for `application/octet-stream`.
  **Global order preserved across block types** (exec 858 → blocks ordered 0–4: image, image, `[BRAK]`,
  txt, csv).
  **The two Block-2 n8n traps re-verified safe (the whole reason this needed a build-time check):**
  (1) the converging Switch→Merge→Aggregate keeps `Aggregate` the **sole terminal** with a **single**
  input, so n8n returns it deterministically (not the dead-end-branch ambiguity that bit Block 2), and a
  run-once-for-all-items node still has exactly one incoming connection (no per-connection re-run / item
  drop); (2) **`Merge` (append) does NOT stall on an empty branch — verified in BOTH directions**:
  all-text task (image branch empty, input 0) → exec 857 passed; all-image task (extractable branch
  empty, input 1) → exec 859 passed (`Fetch`/`Docling` didn't execute at all, Merge emitted the 2 image
  items). **No fallback needed** (the `alwaysOutputData` / single-builder fallback flagged above is
  unused).
  **Silent-failure coverage (reliability mandate).** The reader **detects** every degradation and tags
  it into `warnings` (each builder names its own `warn_source`): (1) Docling unreachable / non-200 /
  `status!=success` / empty `md_content` → `[BRAK: extraction_failed]` + `multimodal/extraction-failed`
  (verified: corrupt `broken.docx` → block returned + one warning, run continued); (2) attachment fetch
  failure → same `[BRAK]` + warning (`onError: continueRegularOutput` on Fetch/Docling); (3) **NEW —
  image attachment classified but missing `url` → `[BRAK: image_ref_missing]` + `multimodal/image-ref-missing`**
  (no silent drop); (4) embedded in-doc images → `multimodal/embedded-image-skipped` (hosting deferred to
  Block 10); (5) unsupported types (`.zip`/`.mp4`) → routed to extractable → Docling fails → `[BRAK]` +
  warning (no classifier needed); (6) hard `Get Task` failure throws → global `Error Handler (v1)`
  CRITICAL. The reader posts **no alerts itself** (pure function, **zero alert nodes**) and writes **no
  `agent_runs` row** (no model call — ADR-035 owner unchanged); the actual `Post Alert (v1)` firing of
  `warnings` is a hard requirement on **Stage A (Block 5)**. Safe because the reader is in **no live path
  until Block 5 wires it** — nothing calls it in production yet. _Knowingly DEFERRED:_ Block 5 alert
  firing; pdf/pptx **rendered page-image** hosting (Block 10); the PD/Bedrock image stance (Block 6);
  proactive Docling dead-man's-switch cron (operator decision — request-time detection only).
- **Block 5 (input wired into the spine; multimodal model call) — 2026-06-10.** Phase A INPUT is LIVE and
  verified end-to-end: an @-mention (or orchestrator Form) on a task with attachments now produces a draft
  that uses the attached doc text **and** visibly accounts for attached photos. Edits across four workflows:
  (1) **Stage A** (`assemble-context-and-build-prompt.json`) — added `Call Read Input` (executeWorkflow →
  `Read Input (v1)`, `onError:continueRegularOutput`) after `Load Agent Rules`; `Build Prompt` now folds
  text blocks into a `# Treść załączników` section and emits `image_blocks_json` (image refs when
  `personal_data=false`); added `Check Input Warnings` IF → `Alert Input Warnings` (Post Alert,
  `source=assemble-context/input-reader`) reconverging into `Return Context` — this **fires the reader's
  `warnings`** (discharges Block 3's deferral). (2) **Orchestrator** + (3) **Stage B**
  (`execute-llm-call.json`) thread `image_blocks_json` through to Invoke Model. (4) **Invoke Model**
  (`invoke-model.json`) — `Resolve Routing` builds `messages` with **content ALWAYS an array** (one schema):
  `[{type:'text',text:prompt}, …{type:'image_url',image_url:{url:<clickup_url>}}]`; `Call LiteLLM` and
  `Fallback to Opus` use `$json.messages`. **Vision via remote `image_url`** — LiteLLM fetches the ClickUp
  URL; no bytes cross any n8n boundary (ADR-036 reference-not-bytes). No DB/routing change — `-direct`
  Claude aliases are vision-capable; `modality='text'` SELECT unchanged.
  **Verified live:** low-impact task (`869dmwh6g`, Haiku 4.5) → posted draft describing a green
  "HAXE-VISION-OK" image + summarizing the text note; high-impact research task (`869dmx4z2`, Fable 5) →
  posted draft with a sea-vs-rail research table **and** a description of a red "HAXE-FABLE-OK" image
  (research + vision together at the top tier); a `broken.docx` task fired the new
  `assemble-context/input-reader` WARN. **Interim PD guard:** `personal_data=true` + images → images dropped
  **+ WARN** (`multimodal/image-dropped-pd`), no user-facing notice yet (Block 6 adds it + the Bedrock guard).
  - **Two PRE-EXISTING spine return-determinism bugs found + fixed (the documented "keep the return path
    branch-free" trap, surfaced by Block 5's end-to-end testing — not caused by Block 5's edits):**
    (a) **Stage B** — `Return LLM Result` raced in parallel with the cost branch (`Sum Task Cost → Update CU
    Cost Field`); the cost branch (a ClickUp write, ~650ms) finished **last**, so n8n returned its empty
    `{}` as Stage B's result → orchestrator saw no `completion` → `Post Reply` never ran (no draft posted).
    **Fix:** linearized `Call Invoke Model → Sum Task Cost → Update CU Cost Field → Return LLM Result`, with
    the cost-error branch reconverging via `Alert Cost Sync Failed → Return LLM Result`; `Return LLM Result`
    is now the deterministic sole terminal (reads via absolute refs, so a cost-sync failure still returns the
    answer). (b) **Decide Research and Deliver** (`decide-research-and-deliver.json`) — `Collect Research
    Results` ran in parallel with `Check Research Degradation → Alert Research Degraded` (a competing
    dead-end leaf), so on research-"deliver" runs its output landed on the caller's output index 1 (index 0
    empty) → Stage A's `Call Decide Research → Load Agent Rules` (index 0) carried nothing → Stage A halted
    after Decide Research and returned the research blob. **Fix:** linearized `Call Research the web → Check
    Research Degradation →[true] Alert Research Degraded / [false] Collect`, `Alert Research Degraded →
    Collect`; `Collect Research Results` is now the sole terminal. Both fixes verified by the live re-tests
    above. **Lesson:** every executeWorkflow sub-workflow must end in a single branch-free terminal; parallel
    side-effect branches (cost sync, degradation alerts) must reconverge into it, never race it.
  - **NEW reliability gap → Block 6.** A single **unprocessable input image** (e.g. a 1×1 px PNG) makes
    Anthropic reject the whole request (`"Could not process image"`, 400) → both primary and Opus fallback
    fail → CRITICAL, no draft (observed on `869dhad2q`, which still has 1×1 test-junk attachments). Real
    photos are unaffected. Block 6 (image guards) should add graceful degradation: on an image-processing
    400, retry text-only + WARN, so one bad attachment can't sink the answer.
  - **Deferred requirement → fully multimodal INPUT (Block 10 hosting).** Two input-image cases are NOT
    yet seen by the model, only their surrounding text: (i) **images embedded inside a Docling-extracted
    document** (xlsx/docx/pdf) — Docling runs in `image_export_mode=placeholder`, so each embedded image
    becomes a `<!-- image -->` marker and the reader emits a `multimodal/embedded-image-skipped` WARN
    (observed: a product photo inside `…Wzorcowa specyfikacja.xlsx`); (ii) **pdf/pptx page renders**.
    Both were deferred because passing them to the model needs the **same temp-staging/upload primitives
    Block 10 builds for output delivery** (ClickUp can't read our disk; bytes must be hosted to get a URL,
    or base64-inlined). **Goal state: an input image is an input image** — whether attached directly
    (already works) or embedded in a file — and reaches the vision model. Block 10 should extend the
    reader to host embedded images + page renders (Docling can emit them) and feed them into the same
    `image_blocks_json` path Block 5 built. Until then the WARN is the honest signal that an in-file image
    was skipped. **Noise caveat:** this WARN fires on every doc with a logo/icon/chart embedded (most real
    spec sheets) — when Block 10 lands, either host those images or downgrade decorative-image skips to
    INFO so the WARN channel isn't flooded.
- **Block-5 follow-up — zero-attachment empty-return bug (2026-06-11).** A task with **no attachments**
  made `Read Input (v1)`'s `Explode Attachments` emit **0 items**, so `Classify`/`Merge`/`Aggregate Blocks`
  were all skipped and the reader returned nothing. That empty **cascaded up** (Assemble Context →
  orchestrator) and **silently skipped** Set Status, Execute LLM, and Post Reply — while every execution
  still reported `success`: no reply, no cost, status never reached "W trakcie" (observed on `869dm1z8y`,
  two morning runs). The common **no-attachment** case had been broken all along; only attachment-bearing
  tasks worked, which masked it. Two-layer fix:
  - **(A) Reader (correctness).** `Explode Attachments` now emits a single `_passthrough` sentinel when the
    task has no attachments, routed through the **no-I/O image branch** (extended the `Classify` image rule
    + a `_passthrough` short-circuit in `Build Image Block` that emits a block-less item) so `Aggregate
    Blocks` still runs and returns `{ blocks: [], clickup_task_id, warnings: [] }`. Branch-free terminal
    preserved.
  - **(B) Orchestrator (reliability mandate).** `Call Assemble Context` gains `alwaysOutputData`; a new
    **`Context OK?`** IF gates on a non-empty `prompt` → empty stops the run at **`Alert Context Empty`
    (CRITICAL)** instead of a green no-op, and the `If LLM Succeeded?` false branch now fires **`Alert LLM
    Failed` (CRITICAL)** on an empty completion. This catches the whole class (any 0-item emit anywhere in
    the long Assemble chain), not just attachments. Also repositioned **Set Status W trakcie** to fire
    immediately off the trigger (up-front feedback, ~1 s vs ~30 s).
  - **Verified end-to-end** on `869dm1z8y` (exec 1155): Sonnet 4.6 draft posted, status W trakcie→Zakończono,
    cost field written; `Context OK?`/`If LLM Succeeded?` took the success path and neither CRITICAL
    false-fired. _Silent-failure coverage:_ the previously-uncovered "context/reader returned empty" mode is
    now a loud CRITICAL on a non-blocking side branch.
- **Block 6 (unprocessable-image robustness, `invoke-model.json`) — 2026-06-12.** Phase A INPUT is now
  **closed**. The Block-5 gap (a 1×1/corrupt image 400s the whole request → primary *and* Opus fallback
  fail → CRITICAL, no draft) is fixed with a **reactive text-only safety net**, PD-blind per ADR-043 — no
  Bedrock/PD/EU branch (the old "GDPR / Bedrock image stance" section above is superseded; see its dated
  update). Decisions locked with the operator: **whole-set reactive degrade** (on a failed image call,
  drop *all* images + a `[BRAK]` marker, not per-image isolation — only junk images 4xx, so a co-attached
  good image is rarely lost) and **reactive-only, no `vision_capable` column** (every routed model is
  vision-capable today; a non-vision model 4xxs into the same path).
  **Mechanism (all in `invoke-model.json`; Stage B wrapper unchanged).** The existing fallback chain is
  extended into a final net: `Call LiteLLM` (routed model, **with** images) →err→ `Fallback to Opus`
  (Opus, **with** images — ADR-037, recovers *transient* errors without losing the image) →err→ **NEW
  `Retry Text-Only`** (Opus, images **stripped** + `[BRAK: obraz nieczytelny na bieżącym providerze]`
  appended). This chain *itself* discriminates the cases with **no HTTP-status parsing**: a transient 5xx
  on a good image is recovered by Opus with the image intact; a genuinely-bad image 4xxs on both
  image-bearing calls and is rescued text-only; a real non-image failure fails all three and still
  surfaces as **CRITICAL** (not masked — `Retry Text-Only` has no `onError`, so it throws onward).
  `Resolve Routing` now also emits `messages_text_only` (+ `had_images`); `Parse Response` adds
  `$('Retry Text-Only')` as a third success source and sets `image_unprocessable=true`
  (`fell_back_to_opus` stays false, so the generic degradation WARN does **not** double-fire);
  `Image Unprocessable?` IF → `Alert Image Unprocessable` (WARN, `source=multimodal/image-unprocessable`)
  reconverges into `Routing Missing?` so `Shape Output` stays the **sole branch-free leaf**.
  **One bug found + fixed during node-by-node verification (the reconvergence data-provenance trap):** the
  first wiring put the image-WARN node *before* `Call Log Model Run` (which reads its fields via **relative
  `$json`**, unlike every other node here which uses absolute `$('Parse Response')` refs), so on the
  image-unprocessable branch its input item became the Post Alert return → it logged a **null `agent_runs`
  row** and the null cost tripped a spurious `cost_missing` degradation WARN. **Fix:** reordered to
  `Parse Response → Call Log Model Run → Image Unprocessable? → [Alert →] Routing Missing?` (log first,
  then reconverge the alert), restoring the direct Parse-Response feed.
  **Verified live (orchestrator Form trigger → full A→B→C on `869dhad2q`, impact `Krytycznie ważne` →
  `haxe-gemini-pro`; exec 1569 / Invoke Model).** 3 images (2× 1×1 junk + 1 real) → Gemini 4xx → Opus 4xx
  → `Retry Text-Only` succeeded (≈40 s) → a 4888-char **text-only Polish draft posted** by Stage C
  (@-mention intact), status flipped, **one** `multimodal/image-unprocessable` WARN on Alerts `869dj2z2c`,
  **no CRITICAL**, `Call Log Model Run` logged **one priced row** (0.579 PLN, `cost_missing=false`),
  `Check Degradation` took the clean branch (no second WARN). The draft itself acknowledged *"wersja
  robocza powstała wyłącznie z danych tekstowych — 3 dołączone obrazy są nieczytelne (uszkodzone pliki
  1×1)"*. Happy-path regression (exec 1561, text-only Haiku call): `had_images=false`, `Retry Text-Only`
  **not executed**, no image WARN, cost logged — the new nodes are transparent to normal/successful calls.
  The **non-vision case is covered by construction** (identical 4xx path; no non-vision model exists to
  test directly). A co-fired `assemble-context/input-reader` WARN (the task's intentional `broken.docx`)
  is pre-existing Block 3 behavior, not Block 6.
  **Silent-failure coverage (reliability mandate).** _Covered:_ unprocessable input image (corrupt 4xx /
  non-vision-model 4xx) → loud `multimodal/image-unprocessable` WARN + visible Polish `[BRAK]` substitute
  + text-only draft; the call **never sinks** to CRITICAL/no-draft. _Not masked:_ a genuine non-image
  failure still fails all three calls → CRITICAL. _Cost:_ logged exactly once via `Log Model Run (v1)`
  even on the text-only retry; `Sum Task Cost` stays correct (no double-count, no zero-cost silent run).
  _Knowingly DEFERRED:_ per-image isolation (whole-set drop accepted); fully multimodal input (embedded +
  page-render images) → Block 10 hosting.
- **Block 8 (image-gen providers provisioned + verified through LiteLLM) — 2026-06-12.** The GATE that
  unblocks Phase B. The dated seeds were all dead/dying — `dall-e-3` deprecated, `stable-diffusion-3-5`
  superseded, and the **entire Vertex Imagen family is shutting down ~2026-06-24..30** (Google's own
  migration target is `gemini-2.5-flash-image`). Operator-confirmed refresh to a cross-provider ladder:
  Niski/`__default__` → `vertex_ai/gemini-2.5-flash-image` (Nano Banana, ~$0.039), Średni →
  `vertex_ai/gemini-3-pro-image-preview` (Nano Banana Pro, ~$0.134), Wysoki/Krytycznie ważne →
  `openai/gpt-image-2` (~$0.21 high/1024²). This gives Block 9's step-down ladder cross-provider
  resilience (OpenAI top → Google mid/low). **No new Google account** (Imagen retired; gemini-image rides
  the existing Vertex cred on `vertex_location: global`); **OpenAI** needed only a key + billing in the
  existing workspace. PD-blind/global throughout (ADR-043) — no EU pin, no PD branch, Stability dropped.
  **What changed:** `litellm-config.yaml` (3 dead aliases → the 3 above; `model_name` == `litellm_model`,
  1:1); migration `023_image_gen_block8_providers.sql` (UPDATEs the 5 `modality='image'` rows + a static
  `fallback_price_per_unit` floor each; PK/columns untouched, no `personal_data`/`eu_only`); `.env.example`
  (Stability dropped, `VERTEX_LOCATION` marked unused). Deployed to the VPS (LiteLLM v1.87.0) — note a
  **config-file-only change needs `docker compose restart` to reload the mounted YAML** (`up -d` recreates
  only on a compose/.env change, so it left the old config in memory the first time); `up -d` was used
  after the OpenAI key landed in `.env`.
  **Verified live** (one `/v1/images/generations` call per model through the gateway): `gemini-2.5-flash-image`
  → image + `x-litellm-response-cost`=$0.0387 (1290 out-tokens); `gemini-3-pro-image-preview` → $0.1344
  (1120); `gpt-image-2` (high, 1024²) → $0.2108 (7024 image-output tokens × $30/1M = OpenAI's real rate).
  **Cost-header reality (correction to the going-in assumption):** v1.87.0 returns ACCURATE costs for all
  three — including gpt-image-2 at standard sizes; the #26863 "$0" bug only bites EXOTIC resolutions that
  miss the cost map. So `fallback_price_per_unit` is a genuine safety net (live header wins; floor used only
  when the header is missing/zero), NOT the active price.
  **Silent-failure coverage (reliability mandate).** _Covered:_ provider availability/credit cliff caught
  here at the gate by the per-model test calls (a missing key / dead provider 4xxs visibly); a zero/absent
  cost header → static floor logs a non-zero priced row (no zero-cost silent run), with the live header
  auto-overriding once reliable. _Deferred to Block 9 (stated, not yet built):_ per-call provider-down WARN
  + the `cost=0`-with-image-tokens guard. **Compliance:** `gdpr-processing-decisions.md` §4 updated — Google
  (Vertex) now also image-gen, OpenAI is image-gen-only; OpenAI ZDR + EU residency are sales-gated (not
  blocking). **Phase B still gated on the generation pipeline itself** (Blocks 9–12): invoke-image-model,
  image-resolver, the assembler, comment_native delivery — the image rows have no caller yet.
- Phase 2–5: consequences recorded when each phase is verified end-to-end. **Phase A (INPUT) COMPLETE —
  attachment-level text + directly-attached images, with robust unprocessable-image degradation (Blocks
  1–6).** Still owed for *fully* multimodal input: Block 10 (host embedded in-document images + pdf/pptx
  page renders → vision model). Then Phase B (image generation).
- **Block 9 — image generation as a new OUTPUT MODALITY of `Invoke Model (v1)` (2026-06-12).** Operator
  decision (reversing this plan's "separate invoke-image-model sub-workflow"): image gen is "the same
  setup with a fork after routing," so it was folded INTO `Invoke Model (v1)` (`XcOIVdZnVCCWNPeb`), reusing
  its routing lookup, the Log Model Run cost seam, Post Alert, and the single-branch-free-terminal return
  discipline. **New input `requested_modality_of_output`** (default `'text'`) — set **per output block by
  the future Block 11 resolver** (`'text'` for the text part of a reply, `'image'` for each `generate`
  block); plus optional `requested_size`/`aspect`. **Graph:** `Resolve Routing → Output Is Image?` forks;
  the image branch is `Call Image Gen → (onError) Fallback Image Gen → Parse Image`, and **both branches
  converge at a new `Normalize Model Result` Code node** (one uniform schema), so `Shape Output` stays the
  sole leaf (return determinism intact — verified node-by-node in a degraded run). A **single image-fallback
  hop** to `vertex_ai/gemini-2.5-flash-image` mirrors the text path's single Opus fallback (the spec's
  3-tier step-down ladder was dropped — simpler, keeps the live text hot path uncluttered). **Routing** is
  `(impact, modality='image')` (no PD axis) with a `LEFT JOIN image_gen_params` for `resolution`; an `n/d`
  impact (no image row) falls back to `__default__` via the `impact in ($1,'__default__')` clause. **Cost**
  layers: live `x-litellm-response-cost` header → token-math (migration `024_image_token_prices.sql` filled
  `price_out_usd_per_1k`: flash 0.030, pro 0.120, gpt-image-2 0.030 — each derived from Block 8's measured
  cost ÷ output-tokens, so token-math reproduces the header to the cent) → per-image `fallback_price_per_unit`
  floor; **any header miss fires WARN `invoke-model/image-cost-header-missing`** regardless of which layer
  priced it. **Size precedence:** `requested_size` > model `aspect` > tier default (base 1024, safe across
  providers; `'max'` maps to gpt-image-2 `quality=high`, NOT a 1536² size that the API rejects). **Return
  contract note (frozen-contract exception):** these models return base64, not a hosted URL, and Block 10's
  temp-staging isn't a Block 9 prereq — so `Invoke Model` returns `b64_json` across the boundary; the Block
  11 resolver is the designated temp-writer. **Batch rejected:** image API `n>1` only varies ONE prompt;
  distinct-prompt generations can't share a call, and the async Batch API is wrong for an interactive reply
  — the real latency lever is parallel fan-out in the Block 11 resolver. **Verified live** (temporary
  webhook harness driving `Invoke Model` directly; harness + builder scripts torn down): all five tiers
  generate + route correctly — Niski/`__default__`/n-d → `gemini-2.5-flash-image` ($0.0387), Średni →
  `gemini-3-pro-image-preview` ($0.1344), Wysoki/Krytycznie → `gpt-image-2` ($0.2108, 7024 out-tokens) —
  each a real ~1.2–1.5 MB image with a priced `agent_runs` row (`triggered_by='image_gen'`, FX→PLN); the
  forced-degrade path (gpt-image-2 timeout → gemini-flash fallback) fired `invoke-model/image-degrade` and
  still returned the image; the `requested_size=1024x1536` override reached the API; **text + vision
  regression clean** (haiku text reply + vision flow unchanged through the rewired Normalize); 0 CRITICAL,
  all test WARNs explained. **Operational note:** `gpt-image-2` at `high` takes **~176 s**, so `Call Image
  Gen`'s timeout was raised to **240 000 ms** and its retry dropped (retrying a slow-but-succeeding call just
  burns another timeout); the gemini tiers return in ~5 s. The top tier is functional but slow — a Block-8
  provider characteristic, not a Block 9 defect. **Silent-failure coverage:** image provider error → caught
  → single fallback hop → `image-degrade` WARN, image still returned; total failure → `success:false` so the
  Block 11 caller drops the block (no throw); 2xx-without-image → gated on `b64_json` presence → fallback;
  cost header missing/zero → token-math or floor + `image-cost-header-missing` WARN (the header-miss branch
  was verified by node-level wiring + token-math arithmetic equivalence, not a forced live header omission —
  LiteLLM returned an accurate header on every call). **`requested_size` extraction surface is deferred +
  tracked** (ADR-045 + master-plan Block 13). The generation pipeline still owes Blocks 10–12 (delivery,
  resolver/assembler, end-to-end drafting-model block list).

- **Block 10 — comment_native delivery primitives in Stage C, IN-MEMORY base64 (Option A) — 2026-06-12.**
  Supersedes spec §3.6's disk-temp delivery (temp dir / TTL sweep / upload-from-disk). **Why the pivot:**
  this n8n (2.x) ships **no `Execute Command` node** (confirmed: not an env exclusion — the node type is
  unrecognized) and **`Read/Write Files` has no delete operation**, so nothing can clean a temp dir from
  inside n8n — the disk design was un-garbage-collectable here. So generated images travel as **base64 in
  the manifest** (matching Block 9, which already returns `b64_json`): Stage C `Parse Manifest` → `To Binary`
  (`convertToFile`) → `Upload Attachment` (multipart `POST /task/{id}/attachment` → `{id,url}`) → `Aggregate`
  → `Rewrite Delta` → `Finalize Comment` → existing reply/draft post. **No disk, no shared volume, no temp,
  no TTL sweep, no shell** — the Phase-1 shared-volume compose change was reverted and the orphan-temp failure
  class is gone entirely.
  - **Spike (live, task 869dhad2q), the inline-image format — the load-bearing finding:** ClickUp's comment
    API renders an image inline ONLY via the **undocumented op `{ "type":"attachment", "attachment":{ "id":…,
    "url":… } }`** referencing a real ClickUp **task attachment**. A bare `{ "image":"<url>" }` op is *accepted
    and stored but never rendered* (blank); `comment_text` markdown `![](url)` stays literal text. Public docs
    + community say inline is "impossible" — they miss this op. `Rewrite Delta` emits exactly this op.
  - **No delete-attachment API** (ClickUp v2, confirmed). And the spike proved the attachment is **free-floating**:
    deleting the comment does NOT remove it. So **rollback = best-effort WARN, not deletion** — on post-failure
    after upload, `Alert Post-back Failed` lists the orphaned attachment ids (`orphaned_attachments=[…]`) for
    manual UI cleanup; no temp to retain (there is none). Operator decision: **accept persistence** — generated
    mockups are legitimate task content; the only inline mechanism *is* a task attachment, so persistence is
    inherent, and humans can delete in the UI (where deletion works). Verified live: forced post-failure →
    one `post-reply/post-back` WARN with the two orphan ids, no partial post, no double-post, 0 CRITICAL.
  - **Per-run payload-weight observability (migration 025):** `agent_runs.run_payload_bytes` (+ nullable
    `n8n_execution_id`). `Finalize Comment` computes `run_payload_bytes` = UTF-8 bytes of
    `JSON.stringify({rendered_comment, image_manifest})` for **every** delivering run (text + image), appends a
    Polish footer line `rozmiar danych przebiegu: <X KB|MB>`, and `Record Artifact` writes it onto the same
    answer row it already targets (no second `agent_runs` writer). It is a **proxy + lower bound** for n8n
    execution-data weight (true ≈ this × nodes traversed); `n8n_execution_id` enables an exact backfill later.
    Verified: image run 495 815 B (484 KB), text run 547 B (1 KB); footer present on both; null before delivery.
  - **base64 never reaches Supabase** (verified: the delivered row's full JSON is 607 B, no PNG signature) —
    `Record Artifact`/`Log Model Run` receive only scalar fields, never the manifest. **Execution-data hygiene:**
    base64 lives in n8n execution data, multiplied per node traversed; mitigations are (a) minimal base64 hops
    (manifest → `To Binary` → upload, dropped after) and (b) n8n execution pruning — **no `EXECUTIONS_DATA_*`
    env is set, so n8n defaults apply (prune ON, max age 336 h, max count 10 000).** Recommend tightening if
    image volume grows: `EXECUTIONS_DATA_MAX_AGE=168` (7 d) + `EXECUTIONS_DATA_PRUNE_MAX_COUNT=5000`.
  - **Provider coverage:** all current image tiers return `b64_json` via LiteLLM, so the manifest always
    carries bytes; no tier returns a URL-only result today, so the resolver's fetch→encode-for-URL safeguard
    (Block 11) has nothing to exercise yet (documented, not built). **Verified live, node-by-node:** 2 real
    gemini-flash images → 2 `{type:attachment}` ops → one comment with both rendered inline (operator-confirmed)
    + size footer; text-only regression unchanged. **Contract for Blocks 11/12:** the resolver fills
    `image_manifest=[{placeholder_id,b64,mime,caption,alt}]` (base64, NOT temp paths) and the assembler emits
    `rendered_delta` ops with `{type:'image_ref',placeholder_id}` placeholders; Stage C does the rest.
  - **Known pre-existing limitation (out of Block-10 scope, "don't touch the spine"):** on *total* post-failure
    Stage C swallows the error (`continueErrorOutput` + WARN) and does not reach `Set Status Zakończono`, so the
    task stays at `W trakcie` (no auto-reset). Same as the prior text-only path; a reset would require the
    orchestrator to treat post-failure as a stage error.

- **Block 11 — image-resolver + multimodal assembler (`Image Resolver (v1)`, `znDqcfgXK6CNte20`) — 2026-06-12.**
  New sub-workflow that sits between the drafting model's output-block list and Stage C: it resolves `embed_input`
  blocks to existing ClickUp attachments, calls `Invoke Model (v1)` once per `generate` block, and assembles the
  `image_manifest` (base64) + `rendered_delta` (with `{type:'image_ref',placeholder_id}` placeholders) that Block
  10's Stage C already consumes. Graph: `When Called → Lookup Count Ceiling → Resolve & Explode Blocks → Classify
  Block (Switch, 4 routes) → {text↦Merge | Resolve Embed | Call Invoke Model → Handle Gen Result | Build Dropped
  Block} → Merge Branches (append, 4 in) → Assemble Output`. `Assemble Output` is the **sole branch-free terminal**
  (sub-workflow return determinism) and `Merge Branches` has exactly one downstream — the two traps from Block 2.
  - **Per-impact image-COUNT cap retired → single global safety ceiling (migration 026).** Spec §3.4 had `impact`
    select model + count + resolution together. That conflates *priority* with *content-need* (a Niski catalogue
    task can legitimately need many thumbnails), so the per-impact `image_gen_params.max_images` cap is **no longer
    read** for count (column kept, now dead for counting; `resolution` still used by Invoke Model). Replaced by one
    tier-agnostic `config.image_count_ceiling=20` — a pure runaway guard against a malformed/hallucinated block
    list. Over-ceiling generate blocks become a placeholder text op + `multimodal/image-count-ceiling` WARN
    (abnormal; should never fire normally). Impact still drives image **model + resolution** via `model_routing` /
    `image_gen_params.resolution`. **Verified live:** ceiling temporarily set to 2 with 3 generate blocks → 2
    rendered, 3rd dropped with the placeholder + warning; ceiling restored to 20.
  - **`executeWorkflow` must run "once for each item" for fan-out.** `Invoke Model` reads `$('When Called').first()`
    throughout, so a default "run once for all items" call with N generate items only processes the FIRST and
    returns one image (caught live: 2 generate blocks → 1 image). Fix: `Call Invoke Model` set to `mode:'each'`
    (one Invoke Model execution per block; sequential). Block metadata (`block_order`, `placeholder_id`, `caption`,
    `alt`) is smuggled through `Invoke Model`'s `task_type` as `block_meta::{…}` and recovered in `Handle Gen
    Result`; required adding a `task_type` pass-through to Invoke Model's `Shape Output` (it was already carried by
    `Normalize Model Result`, just not surfaced).
  - **Footer unified + made per-modality (operator requirement).** The attribution footer was previously written
    only by `Build Comment` (text path), named a single model, and used only the text cost — and the image path
    skipped it entirely. Moved to a single builder in **`Finalize Comment`** (the convergence point for both paths;
    `Build Comment` now only renders the body + web-sources). It names the model **per modality** and shows
    **aggregate** cost across every model run that fed the comment: text-only → `(model: X, koszt: …)`; multimodal →
    `(tekst: X, obraz: Y; koszt łączny: text+image …)`. Needs two new `Post Reply` inputs — `image_models` (deduped
    list the resolver returns) and `total_image_cost_pln` — alongside the existing `model`/`cost_pln`. As a side
    effect the text path's web-sources section now precedes the footer (was after); behaviourally trivial.
  - **Image-path reviewer @mention parity.** `Build Comment` prepends the reviewer tag, but the image path
    (`Rewrite Delta`) didn't — so a Block-10 image reply would not @-mention the reviewer. `Rewrite Delta` now
    prepends `{type:'tag',user:{id:reviewer}}` when `reviewer_user_id` is set (verified live: posted comment shows
    `comment-tagged-user`).
  - **Markdown→ops reuse.** `Assemble Output` renders text blocks with the **same** markdown→`{text,…}` ops logic
    as `Build Comment` (links/bold/italic/code/headers/lists/tables/code-fences), so text rendering is identical on
    both paths. `embed_input` → `{type:'attachment',{id,url}}` directly (no re-upload — the image already exists on
    the task); `generate` success → manifest entry + `{type:'image_ref'}`; failure/degraded → `[Generowanie obrazu
    nieudane]` + `multimodal/image-gen-failed` WARN; embed miss → `[Obraz niedostępny]` +
    `multimodal/embed-ref-not-found` WARN — all non-throwing so the comment still posts.
  - **Silent-failure coverage:** embed miss, generate failure/degrade, and ceiling-exceed each degrade to a
    placeholder op + a `warnings[]` entry (resolver returns `warnings`; Block 12 will route them to `Post Alert`).
    `Invoke Model` throwing is caught by `Call Invoke Model` `onError:continueRegularOutput` (→ `Handle Gen Result`
    reads `success:false`) and by Invoke Model's own `errorWorkflow` (→ CRITICAL). Resolver itself throwing →
    caller's `errorWorkflow`.
  - **Verified live, node-by-node** (task 869dhad2q, exec 1692): text + 1 real `embed_input` + 2 `generate` →
    resolver returned manifest=2, `image_models=[gemini-2.5-flash-image]`, `total_image_cost_pln≈0.2855`,
    `warnings=[]` → Post Reply uploaded both (`failed_count=0`), posted ONE comment with **3 images inline** (embed
    + 2 generated, each captioned), reviewer @mention, and the footer `(tekst: haxe-sonnet-4-6-direct, obraz:
    vertex_ai/gemini-2.5-flash-image; koszt łączny: 0.2978 PLN)`; `Record Artifact updated=1`; 0 alerts. Embed-miss
    and ceiling cases verified separately (above).
  - **Done in Block 12 (below):** Stage B now auto-calls the resolver (drafting model emits the block list), the
    four image fields are forwarded to Post Reply, and resolver `warnings[]` route to `Post Alert`. Sequential
    generation is still in place; parallel fan-out remains the latency lever if multi-image high-tier requests get slow.

- **Block 12 — end-to-end multimodal run: drafting model emits the block list, full A→B→C (2026-06-13).**
  Wired the four upstream pieces so the resolver/delivery built in Blocks 9–11 actually run on real tasks.
  Operator decisions this build: **full unification** — *every* task is instructed to emit the JSON output-block
  contract and routes through `Image Resolver (v1)`; the prose `Build Comment` renderer in Stage C is **retired**,
  so there is now ONE rendering path (the resolver's `rendered_delta`). **embed_input wired end-to-end** — the agent
  can place an EXISTING attached image inline, not only generate new ones.
  - **Stage A `Build Prompt`:** the prose trailer (Wyniki/Pytania/… as headings) is replaced by a strict-JSON
    block-contract instruction (text / embed_input / generate shapes + a one-line example); the soft
    Wyniki/Pytania/Decyzje/Sugestie structure now lives *inside* text blocks' `md`. Input images are enumerated with
    their `ref` so the model can `embed_input` them; `source_ref` is added to the emitted image refs (it was dropped
    before) so the resolver's embed lookup resolves.
  - **Stage B `Execute LLM Call`:** new `Parse Output Blocks` (tolerant — strips a ```json fence, falls back to the
    first `[...]`, then to a single `{type:text,md:completion}` block; the unify format-reliability net) →
    `Call Image Resolver` → re-sequenced so `Sum Task Cost` runs AFTER the resolver (per-`generate` `image_gen` rows
    are counted). `Return LLM Result` now carries `rendered_delta`/`image_manifest`/`image_models`/
    `total_image_cost_pln`. Resolver `warnings[]` → `Has Warnings?` → `Alert Resolver Warnings` (WARN
    `multimodal/resolver`), reconverging into the sole terminal. A resolver **throw** is left to propagate to the
    orchestrator's global `Error Handler` (CRITICAL + status rollback) rather than caught locally — internal
    gen/embed/ceiling failures are warnings, not throws.
  - **Orchestrator:** `Call Post Reply` forwards the four image fields; `If LLM Succeeded?` accepts a non-empty
    `completion` OR a non-empty `rendered_delta`.
  - **Stage C `Post Reply`:** `Build Comment` deleted; `Has Images?` false branch → new `Pass Delta` (uses
    `rendered_delta` directly, prepends the reviewer @mention, no upload) → `Finalize Comment`; the web-sources
    `Źródła` section moved from Build Comment into `Finalize Comment`.
  - **Verified live, node-by-node** (form-triggered: the unchanged webhook producer's mention-detection can't be
    invoked programmatically, and Block 12 touches only A/B/C + orchestrator): (1) Niski text + 1 generate → image
    inline via `{type:attachment}`, per-modality footer, `Record Artifact updated=1`, 0 alerts (exec 1725);
    (2) text-only regression → prose rendered via resolver + `Pass Delta`, text-only footer, no image nodes fired;
    (3) Niski task with an attached image → routed `multimodal_input` → `haxe-gemini-flash`, Gemini **read** the image
    (found label typos, rendered a markdown table) and `embed_input` placed the existing attachment inline with **no
    re-upload**; (4) two `generate` blocks → both images interleaved at the correct positions, distinct uploads,
    aggregate footer (`koszt łączny 0.3202 PLN`); (5) forced embed-miss (`ref=photo_999`) → `[Obraz niedostępny]`
    placeholder + WARN `multimodal/resolver` (`embed-ref-not-found`), comment still posts. Cost cross-check
    (agent_runs vs CU field): the `image_gen` row is logged once (Log Model Run) and summed in.
  - **Not re-run (cost/time):** the Wysoki `gpt-image-2` end-to-end (~$0.21/img, ~176 s). Block 9 already verified
    gpt-image-2 generation + tier routing live across all five tiers, and the Block-12 wiring is tier-agnostic (the
    resolver calls `Invoke Model` with `impact`; routing is unchanged), so the high tier is covered transitively.
  - **Phase B (multimodal OUTPUT) is COMPLETE.**

- **Block 13 — model-inferred image resolution + gpt-image-2 constraint guard (2026-06-13, ADR-045).** Closes the
  ADR-045 extraction half. The drafting model emits an optional per-block `size:"WxH"` (Build Prompt instruction —
  emit only on an explicit user resolution request); the resolver threads `size`→`Invoke Model.requested_size`;
  `Resolve Routing` validates against **gpt-image-2's real constraints** (edges ÷16, aspect 1:3–3:1, longest edge
  ≤3840, pixel count 655 360–8 294 400) and honors a valid explicit size **exactly**, snapping to nearest-valid only
  on a real violation (+ an honest Polish note rendered inline by the resolver + `invoke-model/size-snapped` WARN via
  the existing resolver-`warnings[]` seam). **Key correction (empirical).** An interim design that rerouted high-tier
  + specific-resolution requests to `gemini-3-pro-image-preview` was built and then **reversed** after a live probe:
  (a) gpt-image-2 honors arbitrary in-constraint sizes — a `1280x512` request returned an exact 1280×512 (decoded
  from the PNG IHDR); (b) Vertex **gemini image via LiteLLM ignores `imageConfig`/`size`** — a non-square request
  returned 1024×1024 (a known LiteLLM limitation). So gpt-image-2 *is* the resolution-flexible model and the reroute
  moved work onto the one that can't honor it. Net: explicit-resolution control is **live on the gpt-image-2 tiers
  (Wysoki/Krytycznie)**; the gemini tiers (Niski/Średni) cannot honor `size`/`aspect` through the gateway (follow-up:
  native `generateContent` bypass, or route aspect-sensitive generation to gpt-image-2). Verified live node-by-node
  (form-triggered): exact 1280×512 generated on gpt-image-2 (`api.openai.com`, cost header $0.073) + posted inline,
  priced `image_gen` row, no snap/WARN on the clean path. The only alerts were pre-existing test-task noise (12 junk
  attachments → Block-6 `image-unprocessable`; `broken.docx`; a flaky `Research the web` CRITICAL) — none from
  Block 13. No migration; no model-end work (the `requested_size` seam pre-existed from Block 9).

---

## Date

2026-06-09 (Phase 1 schema decisions)
2026-06-10 (Block 1 — Docling verified live; spine doc-drift corrected)
2026-06-10 (Block 2 — `Read Input Text (v1)` verified live)
2026-06-10 (Block 3 — unified `Read Input (v1)` verified live; readers unified, router retired)
2026-06-10 (Block 5 — input wired into spine; multimodal model call verified; Stage B + Decide Research return-path bugs fixed)
2026-06-12 (Block 6 — unprocessable-image robustness: reactive Opus→text-only safety net + `multimodal/image-unprocessable` WARN; Phase A INPUT closed; PD/Bedrock image stance superseded per ADR-043)
2026-06-12 (Block 8 — image-gen providers provisioned + verified live through LiteLLM: Vertex gemini-image (Nano Banana/Pro) + OpenAI gpt-image-2; migration 023 + litellm-config; Imagen/dall-e-3/Stability retired; Phase B gate open, generation pipeline Blocks 9–12 still to build)
2026-06-12 (Block 9 — image generation folded into `Invoke Model (v1)` as output modality `requested_modality_of_output='image'`; routing `(impact, modality='image')` + single gemini-flash fallback hop; cost via header→token-math (migration 024)→floor; all 5 tiers + degrade + size-override + text/vision regression verified live; gpt-image-2 ~176 s so image timeout raised to 240 s)
2026-06-12 (Block 10 — comment_native delivery in Stage C, **in-memory base64 (Option A)** superseding the disk-temp design: `Execute Command` + file-delete are unavailable on this n8n, so no cleanup is possible on disk; `convertToFile`→multipart upload→inline `{type:attachment}` op (the only ClickUp form that renders inline, proven by spike); no delete-attachment API → orphan-WARN rollback + accepted persistence; `run_payload_bytes`/`n8n_execution_id` observability (migration 025); base64 kept out of the DB; verified live incl. 2-image inline render + rollback. Blocks 11/12 now carry base64 manifests, not temp paths; the disk TTL-sweep phase is dropped)
2026-06-12 (Block 11 — `Image Resolver (v1)` sub-workflow: resolves `embed_input` to existing attachments + calls `Invoke Model` per `generate` block + assembles `image_manifest`/`rendered_delta` for Stage C; per-impact image-COUNT cap retired for a single global `config.image_count_ceiling=20` safety guard (migration 026; impact still drives model+resolution); `executeWorkflow` set to once-per-item for fan-out + `task_type` metadata smuggling (Shape Output pass-through added); footer unified into `Finalize Comment`, now per-modality (`tekst:`/`obraz:`) with aggregate cost; image-path reviewer @mention parity added to `Rewrite Delta`; verified live — 3 images inline (1 embed + 2 generated) + footer + 0 alerts, plus embed-miss and ceiling cases. Block 12 still owed: auto-wire Stage B → resolver and route resolver `warnings[]` to Post Alert)
2026-06-13 (Block 13 — model-inferred image resolution: optional per-block `size`, validated against gpt-image-2's real constraints (honor-exact / snap-on-violation); interim gemini reroute reversed after a live probe proved gpt-image-2 honors arbitrary sizes and gemini-via-LiteLLM ignores `imageConfig`; live on gpt-image-2 tiers, gemini-tier aspect/resolution deferred to a gateway-bypass follow-up)
2026-06-13 (Block 12 — end-to-end multimodal: drafting model emits the JSON block list; **full unification** (prose `Build Comment` retired → one rendering path via the resolver's `rendered_delta`); `embed_input` wired end-to-end; Stage B `Parse Output Blocks`→`Call Image Resolver`, cost-sum re-sequenced after the resolver, resolver `warnings[]`→Post Alert; orchestrator forwards the four image fields; Stage C adds `Pass Delta` + web-sources in `Finalize Comment`; verified live across generate / text-only regression / Gemini-vision+embed / multi-image interleave / forced embed-miss degrade; **Phase B multimodal OUTPUT complete**; Wysoki gpt-image-2 not re-run — covered transitively by Block 9)
