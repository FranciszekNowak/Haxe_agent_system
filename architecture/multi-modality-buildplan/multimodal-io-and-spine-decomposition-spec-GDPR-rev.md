# Spec: Multimodal I/O + Agent Spine decomposition

Status (2026-06-12): **Spine decomposition + Phase A (INPUT) are LIVE and verified. Phase B
(OUTPUT / image generation) is unbuilt.** This spec is the durable reference; the disposable,
block-by-block execution instruction is `Multimodal_Plan_divided_into_blocks-GDPR-rev (1).txt`
in this folder. Build in n8n via the n8n MCP per ADR-018, then export JSON. Apply the
documentation write-back discipline (CLAUDE.md): update `architecture/current.md` and append to
ADR-036 (and any new ADR) when each block lands. Repo is source of truth; this spec references
durable docs and must be reconciled against them, never applied blindly.

> **Drift note — read before trusting any section.** Earlier revisions of this spec predate
> three things that have since landed and reshaped it: (1) the **PD-blind global routing cutover**
> (ADR-043, migration 021) which deleted the entire `personal_data`/`eu_only`/EU-residency
> apparatus; (2) the **erasure-readiness** schema (ADR-044, migration 022); and (3) the **input
> readers being unified** into one `read-input` reader (ADR-036 "Input readers unified") instead
> of the two-reader + router split this spec originally described. Every section below has been
> reconciled to the live state. Where a design here was superseded, the superseding decision is
> cited inline. ADR numbers in older copies (ADR-039 global routing, ADR-040 erasure) were
> **renumbered** to ADR-043 / ADR-044 after a collision with the pre-existing ADR-040
> (thread-root replies) and ADR-041 (routing zero-row guard); this spec uses the final numbers.

## 0. Scope

In scope:
1. **[DONE]** A single unified input-reader subworkflow (`Read Input (v1)`) emitting one shared
   block contract, using a single extractor (Docling) for text-bearing files and URL-passthrough
   for already-attached images.
2. **[Phase B — unbuilt]** Output multimodality with image generation as a core capability: the
   drafting model emits a block list (text + image intent); a deterministic resolver fills it
   (placement or generation); an assembler interleaves inline; posted as one ClickUp comment.
3. **[Phase B — unbuilt]** A tiered, multi-provider image-generation router selected by the task's
   `impact` field (product/launch value), with step-down fallback.
4. **[DONE]** Decomposition of the Agent Spine into three subworkflows behind a thin orchestrator
   (`Assemble Context and Build Prompt` / `Execute LLM Call` / `Post Reply`).

Deferred (additive later, not an overhaul):
- Search v2 (agentic context-gathering loop). The existing `Search (v1)` node in Stage A is unchanged.
- Fully multimodal **input** for images that are *embedded inside* extracted documents and for
  pdf/pptx **page renders**. Both need the same temp-staging/hosting primitives that Phase B's
  delivery block builds; until then they surface as a `multimodal/embedded-image-skipped` WARN.

Use case: PDP mockups are generated before the real photo shoot so the team iterates fast.
Generation is central, multiple images per comment are expected, and quality scales with product
value via `impact`.

Governance of generated images: no hardcoded validator. The caller's rules/prefs doc (Stage A)
instructs image policy; the human-verification gate (nothing finalizes) is the backstop. Generated
images here are pre-shoot mockups meant to be replaced by real photography.

## 0.1 Data handling (read once)

Per **ADR-043** the pipeline is **personal-data-blind** and routes to **global** frontier models
for every task, text and image alike. There is no `personal_data` flag, no PD verifier, no
EU-residency route, and no `eu_only`/residency column — all of it was removed in migration 021 and
the PD plumbing stripped from every workflow (GDPR master plan, Blocks 1–4, all done 2026-06-11).
Lawfulness for processing personal data rests on each provider's default DPA + SCCs (plus DPF where
the provider is certified) and no-training terms, carried at the account/contract level, not in
workflow logic. Compliance is handled controller-side by standing documents (privacy notice, ROPA,
transfer impact assessment in `compliance/gdpr-processing-decisions.md`), not by per-call branching.

The only data-subject machinery that touches this system is the **erasure-readiness** schema from
**ADR-044** (migration 022): a nullable, indexed `subject_key` on `agent_runs`, plus
`clickup_comment_id` (recorded per run by Post Reply's `Record Artifact` node) and a reserved
`drive_file_id`. `subject_key` stays dormant until the email channel is wired and is **not** part of
the multimodal flow. Phase B's image delivery must record any new external artifact id it creates on
the `agent_runs` row so the erasure hub stays complete.

---

## 1. Shared block contract (input and output) — LIVE

Both readers and the drafting model speak the same ordered list of blocks. **References, never raw
binaries, cross any workflow boundary.** Image bytes live at a `ref` (a ClickUp-hosted URL, or a
per-run temp path during Phase B generation); bytes are resolved only inside the node that needs them.

Input block (emitted by the reader):
```json
{ "type": "text",  "order": 0, "md": "..." }
{ "type": "image", "order": 1, "ref": "<clickup_url>", "mime": "image/png",
  "source": "input", "source_ref": "<attachment_id>", "alt": "..." }
```

Output block (emitted by the drafting model — Phase B):
```json
{ "type": "text",  "md": "..." }
{ "type": "image", "mode": "embed_input", "ref": "photo_2", "caption": "...", "alt": "..." }
{ "type": "image", "mode": "generate", "prompt": "...", "aspect": "1:1", "caption": "...", "alt": "..." }
```

`mode` distinguishes placement (`embed_input`, references an existing image by handle, no upload)
from generation (`generate`, carries a prompt). The resolver converts both into a concrete `ref`
before the assembler runs.

Stage A currently threads input image blocks to the model as `image_blocks_json` (image refs →
`{type:'image_url', image_url:{url:<clickup_url>}}` content parts; LiteLLM fetches the URL, so no
bytes cross an n8n boundary).

---

## 2. Input reading — one unified reader, one extractor — LIVE

> **Superseded design (kept for context):** this section originally specified two readers
> (`read-input-text`, `read-input-visual`) behind an `input-router`. Building it showed the split
> cut along the wrong axis — the `fetch → Docling → build block → aggregate` scaffolding is identical
> for *everything Docling extracts* (xlsx/docx/csv/txt **and** pdf/pptx); the only genuinely
> different case is an **already-attached image** (pure URL passthrough). The real axis is
> **"Docling-extract vs image-passthrough," not "text vs visual."** Per ADR-036 "Input readers
> unified," the two-reader split and the router were **retired (never built)** and replaced by one
> `Read Input (v1)`.

Single extractor: **Docling** on the VPS (`quay.io/docling-project/docling-serve`, port 5001
internal, digest-pinned in `n8n/docker-compose.yml`, reachable at `http://docling:5001`). It covers
xlsx, docx, csv, txt, pdf, pptx, and images (OCR), emitting markdown with layout and tables. There is
no provider fallback; the only fallback is error → a missing-content marker. A file that defeats
Docling surfaces as `[BRAK: extraction_failed <file>]` + a WARN (`multimodal/extraction-failed`), and
the run continues. Docling's layout models prefer a GPU; CPU-only is slower but fine at this volume.

**Critical Docling flag:** readers MUST pass `image_export_mode=placeholder` on
`POST /v1/convert/file`. The default `embedded` mode inlines page images as base64 data URIs (one PDF
ballooned to 242 KB vs 1.3 KB of clean text), silently exploding token cost. Docling returns
**HTTP 200 with `status:"failure"` + `md_content:null`** on a corrupt file (it does *not* HTTP-error),
so success is gated on **`document.md_content` presence**, not the status code.

### 2.1 `Read Input (v1)` — the unified reader (id `zgGpONulGMohQQqI`, `n8n/workflows/read-input.json`)

A **pure, branch-free function.** In: `{ clickup_task_id }`. Out:
`{ blocks: [{type, order, ...}], clickup_task_id, warnings: [{source, title, err}] }`.

Shape:
```
When Called / Form Trigger
  → Get Task (self-fetch; the n8n ClickUp `get` node omits attachments[], so this is an HTTP
              Request with the clickUpApi credential against /api/v2/task/{id} — ADR-019)
  → Explode Attachments (normalize raw attachments[], assign global `order` by index — the reader
                         owns ordering; emits a `_passthrough` sentinel when there are 0 attachments)
  → Classify Attachment (Switch: image vs extractable)
        ├─ image       → Build Image Block  (URL passthrough, NO I/O: ref = ClickUp URL) ─┐
        └─ extractable → Fetch Attachment Binary → Docling Convert → Build Text Block ────┤
                                                                                          ↓
  → Merge Branches (append) → Aggregate Blocks (sole terminal) → return
```

- **Images branch PAST Docling** (decided 2026-06-10): per-answer latency is already ~1–2 min;
  fetching+OCR-ing a reference photo only to discard the OCR is an obvious cut. ClickUp sets
  `mime=image/png` on png uploads so the mime-primary check fires; the ext allowlist is the fallback
  for `application/octet-stream`.
- **The reader fires no alerts itself.** It *reports* problems as structured `warnings`; **Stage A**
  fires them through `Post Alert (v1)`. This keeps the return path a single branch-free terminal
  (the n8n sub-workflow-return gotcha: any branching makes the returned node non-deterministic).
- **Verified safe at build:** `Aggregate Blocks` keeps exactly one input (branches converge through
  `Merge` first — a run-once-for-all-items node with N inputs runs once per connection and drops
  items); `Merge` (append) does **not** stall on an empty branch (verified both directions:
  all-text and all-image tasks); global `order` preserved across block types; the zero-attachment
  `_passthrough` path returns `{ blocks: [] }` instead of nulling the chain.

### 2.2 Deferred input cases (need Phase B hosting primitives)

Two input-image cases are **not yet seen by the model**, only their surrounding text:
1. **Images embedded inside a Docling-extracted document** (xlsx/docx/pdf): under
   `image_export_mode=placeholder` each becomes a `<!-- image -->` marker; the reader emits a
   `multimodal/embedded-image-skipped` WARN.
2. **pdf/pptx page renders.**

Both were deferred because feeding them to the model needs the **same temp-staging/upload primitives
the delivery block builds for output** (ClickUp can't read our disk; bytes must be hosted to get a
URL, or base64-inlined). Goal state: *an input image is an input image* — attached or embedded — and
reaches the vision model. **Noise caveat:** the `embedded-image-skipped` WARN fires on any doc with a
logo/icon/chart; when hosting lands, host them or downgrade decorative skips to INFO so the alert
channel isn't flooded.

---

## 3. Output multimodality (inside Stage B) — Phase B, unbuilt

### 3.1 Drafting model emits block list
Build Prompt instructs the drafting model to return the output block contract: `embed_input` when a
real asset exists, `generate` to mock up a visual that does not exist yet. For mockup PDPs, multiple
`generate` blocks per comment are expected. No render restrictions (governance is the prefs doc +
human gate). The drafting model for a task with input images is the **routed `multimodal_input`
model — currently Gemini** (`haxe-gemini-flash` for n/d/Niski/Średni, `haxe-gemini-pro` for
Wysoki/Krytycznie ważne; ADR-042/ADR-043). For text-only tasks it is the Claude-direct `text` route.

### 3.2 `image-resolver` (deterministic)
Walk output blocks in order:
- `text` → pass through.
- `image mode=embed_input` → resolve the handle to the existing image ref (no model, no upload).
- `image mode=generate` → call `invoke-image-model` (3.3) with the prompt and the task `impact`;
  write the result to the per-run temp dir (3.6); set the block ref to the temp path. Only images
  that remain in the final block list are uploaded later; discarded generations stay in temp and are
  purged.
- Generation count and resolution are impact-driven (3.4). Generate calls run in parallel up to the
  per-impact cap.
- Per-block failure → step-down fallback (3.3). At the bottom tier, drop that image block, insert a
  caption note, WARN (`multimodal/image-gen-failed`). The comment still posts.

### 3.3 `invoke-image-model` (LiteLLM image seam; tiered, multi-provider, step-down fallback)
- Inputs: `prompt`, `impact`, generation params from 3.4.
- Selects the model from `model_routing` by **`(impact, modality='image')`** (direct lookup, one
  model per tier seeded). The table is now keyed on `(impact, modality)` only — no `personal_data`
  component (migration 021).
- Calls LiteLLM `image_generation` for every provider so the cost seam is uniform.
- Fallback: on provider error, route to the same-modality model one impact increment lower and retry.
  Each degrade fires a loud WARN (`multimodal/tier-degrade`). At the lowest tier, fail the block
  (resolver drops it + WARN; the resolver continues). **No `eu_only` filter** — the step-down ladder
  is impact-only (the residency filter described in older copies is gone, ADR-043).
- **Cost logging goes through `Log Model Run (v1)` (id `ztSIUkp9ytbG1xpE`), the sole `agent_runs`
  writer and cost owner (ADR-035).** One row per attempt, `triggered_by='image_gen'`, with `model`
  and `impact`; cost from the LiteLLM `x-litellm-response-cost` header, or from
  `model_routing.fallback_price_per_unit` (static per-image price) when the header is absent. **Do
  not write `agent_runs` or do FX/PLN math anywhere else** — this overrides the per-node inserts shown
  in older copies of this spec, which predate ADR-035.

### 3.4 Impact tiering
`impact` means product/launch value here. It selects model quality, image-count cap, and resolution
together, and is also the fallback ladder. Keys are the **Polish ClickUp `[AI] Wpływ` tiers**
(`Niski`/`Średni`/`Wysoki`/`Krytycznie ważne`/`__default__`), aligned to the field in migration 013.

| impact (ClickUp tier) | model (LIVE — Block 8, migration 023) | max images | resolution | ~$/img |
|---|---|---|---|---|
| Niski | `vertex_ai/gemini-2.5-flash-image` (Nano Banana) | 2 | standard | 0.039 |
| Średni | `vertex_ai/gemini-3-pro-image-preview` (Nano Banana Pro) | 4 | high | 0.134 |
| Wysoki | `openai/gpt-image-2` | 8 | max | ~0.21 |
| Krytycznie ważne | `openai/gpt-image-2` (shares top with Wysoki) | 8 | max | ~0.21 |
| __default__ | `vertex_ai/gemini-2.5-flash-image` (Nano Banana) | 4 | high | 0.039 |

These are seed values in `model_routing` / `image_gen_params` (data, not code), swappable as models
turn over. **DONE (Block 8, 2026-06-12):** the original dated seeds (SD3.5 / Imagen@006 / dall-e-3) were
all deprecated/shutting down (Imagen retired ~2026-06-24) and were refreshed to the live map above via
migration 023; all three models provisioned (existing Vertex cred + a new OpenAI key) and verified
end-to-end through the LiteLLM gateway with accurate cost headers. The count/resolution caps are unchanged.

### 3.5 `assembler` (extends `Post Reply`'s Build Comment, ADR-027/028)
- Walk resolved blocks: render `text` via markdown→Quill-Delta; insert inline image embeds at
  position, referencing the temp paths as placeholders (real ClickUp URLs aren't known until C uploads).
- Append the "Do weryfikacji — nie finalizuje" footer and the reviewer @-mention.
- Returns `{ rendered_comment: { delta, image_refs(temp paths) }, temp_manifest, total_cost_pln }`.

### 3.6 Image delivery (comment_native)

> **SUPERSEDED IN PART — Block 10 (2026-06-12, ADR-036): in-memory base64, NOT server temp.** This n8n
> ships no `Execute Command` node and `Read/Write Files` has no delete op, so a temp dir cannot be cleaned
> from inside n8n. The **disk-temp staging, the per-run temp dir, the rollback-retain-temp, and the TTL sweep
> below are retired**; images travel as **base64 in the manifest** (`{placeholder_id,b64,mime,caption,alt}`,
> matching Block 9's `b64_json`) and Stage C does `convertToFile → multipart upload → inline op` in memory.
> What STILL holds: comment_native delivery; attach-then-reference (the comment API is JSON-only, no multipart);
> and the **inline-image op proven by the Block-10 spike** — `{ "type":"attachment","attachment":{ "id":…,"url":… } }`
> referencing a real ClickUp task attachment (a bare `{image:url}` op / markdown does NOT render). Also settled:
> **no delete-attachment API exists** and the attachment is **free-floating** (deleting the comment does not
> remove it) → rollback is a best-effort orphan-WARN (no deletion), persistence accepted. See ADR-036 Block 10.

Decision (ADR-036, `config.image_host=comment_native`): deliver images via the native ClickUp
comment-attachment flow. New image bytes are staged on the server and uploaded only as part of the
final comment. `image_host` is a setting (`config` table), not a law; `assets_sink`/`object_store`
are documented unused alternatives, addable later by changing the config value + adding an upload node.

Flow (generate in B, upload/post/cleanup in C, so C still owns every ClickUp side-effect):
1. B resolver generates each `generate` image → writes to a per-run temp dir
   (`<config.tmp_root>/<run_id>/`, default `/tmp/agent-runs/<run_id>/`), keyed by run/task id for
   concurrency safety. Block refs are temp paths.
2. B returns the comment (Delta with temp-path refs) + a `temp_manifest` listing the files for the
   images actually present in the final block list. Discarded generations are left for cleanup, never
   uploaded.
3. C uploads the manifest's images to the task (attach → ClickUp URL), rewrites the Delta refs from
   temp paths to those URLs, then posts the comment. `embed_input` images already on the task are
   referenced in place, never re-uploaded. **C records the resulting external artifact ids on the
   `agent_runs` row** (extends the ADR-044 `Record Artifact` pattern; `drive_file_id` is reserved if a
   non-ClickUp host is ever used).
4. On success, C deletes the run's temp dir. On failure after any attach, C deletes the just-uploaded
   attachments (rollback — a failed run leaves the task clean) and retains temp for retry; a periodic
   TTL sweep (`config.tmp_ttl_hours`, default 24h) removes temp dirs from crashed runs that never
   reached cleanup.

API basis: the official Create Task Comment endpoint documents only `comment_text`, `notify_all`,
and `assignee`/`group_assignee` — no file field, no path field, and ClickUp cannot read the agent's
disk. Image bytes must be uploaded to ClickUp (the separate multipart attachment endpoint) to become
a referenceable URL. Hence attach-then-reference (steps 3–4).

**To verify (could simplify):** whether POST comment also accepts (a) a rich `comment[]` array with
positioned inline image elements referencing uploaded URLs, or (b) a multipart body carrying the files
in one call. If either works, attach + rewrite + post collapse into one request and the orphan-rollback
in step 4 is unnecessary. Until verified, keep attach-then-reference. Also verify the comment/attachment
**lifecycle binding** (deleted-with-comment vs free-floating task attachment); if free-floating, final
mockup images persist on the task after the draft is removed (acceptable — they are legitimate mockup
content). Temp-on-disk assumes single-host n8n (paths shared across the B and C executions).

### 3.7 Unprocessable-image guard (model-call boundary, Stage B) — input robustness, Phase A close-out — **DONE (Block 6, 2026-06-12)**

If the assembled input `messages[]` contain an image block and the routed model cannot consume it —
either the selected model is not vision-capable, or the image is corrupt/unreadable (provider returns
a 4xx on the image) — drop the image, substitute `[BRAK: obraz nieczytelny na bieżącym providerze]`,
WARN (`multimodal/image-unprocessable`), and continue text-only so the whole call does not sink.

**Live implementation (Block 6, `invoke-model.json`).** Built as a reactive text-only safety net rather
than a pre-flight check, so it needs no `vision_capable` flag and no HTTP-status parsing: `Call LiteLLM`
(routed model, with images) →err→ `Fallback to Opus` (Opus, with images — recovers transient errors
without losing the image) →err→ **`Retry Text-Only`** (Opus, images stripped + the `[BRAK]` marker). A
genuinely-bad image 4xxs both image-bearing calls and is rescued text-only; a real non-image failure
fails all three → CRITICAL (not masked). Decisions locked: **whole-set drop** (all images dropped on a
4xx, not per-image isolation — only junk images 4xx) and **reactive-only, no `vision_capable` column**
(the non-vision case is the same 4xx path). Verified live on `869dhad2q` (Krytycznie ważne → Gemini Pro;
3 junk+real images → 4xx → text-only draft + one `multimodal/image-unprocessable` WARN, no CRITICAL, one
priced Opus cost row). See ADR-036 Consequences (Block 6).

**This is generic robustness, not a residency or personal-data control.** The PD/Bedrock image
guards described in older copies (and in ADR-036's original "GDPR / Bedrock image stance" section)
are **removed per ADR-043** — there is no PD branch, no Bedrock branch, no EU branch. The concrete
failure this closes: a single 1×1px / corrupt PNG currently makes the provider reject the *whole*
request (400) → both primary and Opus fallback fail → CRITICAL, no draft (observed on `869dhad2q`).
The generation path is handled in 3.3. This is the only remaining INPUT-side work (Block 6).

---

## 4. Agent Spine decomposition — LIVE

The top level is a **thin orchestrator** (`Agent Orchestrator (v1)`, id `a8XKaijkMFNBpRBa`). Each
stage is a Call-Workflow node with its own execution log.

```
Trigger (Form / When Called from CU Webhook Producer)
  → Set Status "W trakcie"  (parallel fire-and-forget side-branch off the trigger; ~1s feedback)
  → Call A: Assemble Context and Build Prompt (v1)
  → Context OK? guard  (Stage A runs alwaysOutputData; empty prompt → Alert Context Empty CRITICAL)
  → Call B: Execute LLM Call (v1)
  → If LLM Succeeded?  (empty completion → Alert LLM Failed CRITICAL)
  → Call C: Post Reply (v1)
  → done
Every Call onError → shared "Reset Status + Alert" path (ADR-032; one place, no per-node sprawl)
```

| Stage | Subworkflow (live name / id) | Absorbs | Returns |
|---|---|---|---|
| A | `Assemble Context and Build Prompt (v1)` / `GGTBvFBgGSNbtUR6` (12 nodes) | Context Gather (+ threaded-comment read, ADR-040), Search (v1), Decide Research, Load Agent Rules, **Read Input (v1)**, Build Prompt | `{ prompt_payload, image_blocks_json, input_warnings_*, rules, prefs, impact, modality, clickup_task_id, reviewer }` |
| B | `Execute LLM Call (v1)` / `9qdJA4xnAGbxqkt9` (8 nodes) | Invoke Model (forwards `image_blocks_json`); **Phase B adds:** image-resolver (generate→temp), assembler (Delta + temp refs), and Sum Task Cost already present | `{ completion / rendered_comment(delta, temp refs), temp_manifest, total_cost_pln }` |
| C | `Post Reply (v1)` / `t17moGs7Vxo5ZcFv` (9 nodes) | Post draft/thread reply, Update CU Cost Field, Set Status, Record Artifact (ADR-044); **Phase B adds:** Upload final images → URL, Rewrite Delta refs, Rollback + retain temp on failure, Delete temp on success | `{ status }` |

Boundary decisions (live):
- **C owns every ClickUp side-effect** (comment, cost field, status flip, and — Phase B — image
  upload + temp cleanup). B computes cost and returns it.
- `Set Status "W trakcie"` fires off the trigger; status resolves only in C or the shared failure path.
- **References only across A→B→C. No raw binary crosses a boundary.**
- **Return-path determinism:** every Call-Workflow sub-workflow must end in a single branch-free
  terminal; parallel side-effect branches (cost sync, degradation alerts) must reconverge into it,
  never race it. (Two pre-existing races — Stage B cost-branch and Decide Research deliver-branch —
  were found and fixed during Block 5; see ADR-036.)
- Text-turn fallback: on a model-turn error, `Invoke Model` falls back to `haxe-opus-4-8-direct`
  (the former `eu_only`-filtered text step-down is gone, ADR-043). Phase B image step-down mirrors
  this per impact tier (3.3).
- Loop guard: exclude the Alerts task `869dj2z2c` from any read/post-watch.

---

## 5. Data / migrations — LIVE state

The migrations that this spec's earlier "Migration 010" referred to landed as a series, **all
applied to `haxe-agent-prod`**:

- **012** `multimodal_image_tiers` — adds `model_routing.modality`, `eu_only`,
  `fallback_price_per_unit`; `image_gen_params`, `config` tables; `agent_runs.triggered_by += image_gen`.
- **013** `image_tiers_match_clickup` — promotes PK to `(impact, personal_data, modality)`; rekeys
  image rows to the Polish ClickUp tiers; adds `Krytycznie ważne` + `__default__` image rows.
- **014** `gemini_multimodal_routing` — seeds `modality='multimodal_input'` rows (Gemini EU + Claude
  direct), per ADR-038/039.
- **015** `fable5_multimodal_temperature_null` — `temperature=NULL` for the Fable 5 multimodal row.
- **019** `nd_multimodal_routing` — adds the missing `n/d` × `multimodal_input` route (Gemini Flash);
  companion to the 0-row routing guard (ADR-041). `max_tokens=12000` for Gemini's reasoning overhead.
- **020** `model_routing_max_tokens_by_tier` — output `max_tokens` per impact (ADR-042).
- **021** `global_model_routing` **(ADR-043)** — the PD-blind collapse: deletes all
  `personal_data=true` rows; drops the Claude `multimodal_input` rows and **keeps Gemini as the
  active multimodal route**; renames `-eu` Gemini aliases → global; re-keys the PK to **`(impact,
  modality)`**; **drops the `eu_only` and `personal_data` columns** and the partial unique index.
  (This is the "later append-only migration that drops `personal_data` from the PK and retires
  `eu_only`" that older copies forward-referenced — it is DONE.)
- **022** `agent_runs_erasure_ready` **(ADR-044)** — adds nullable `subject_key` (indexed),
  `clickup_comment_id`, `drive_file_id` to `agent_runs`. Zero behavioral change.

Result: `model_routing` is keyed `(impact, modality)` only — `text` → Claude direct, `image` →
image-gen tiers (Stability/Vertex/DALL-E, dated seeds), `multimodal_input` → Gemini (flash×3 / pro×2).

**Phase B migration work:** if Block 8 refreshes the image seeds, add a new append-only migration
updating the `modality='image'` rows / `fallback_price_per_unit`. The PK/column cleanup is already
done — do **not** re-add a `personal_data` or `eu_only` column.

`Sum Task Cost` is unchanged; `image_gen` rows logged via `Log Model Run (v1)` are summed automatically.

---

## 6. Files — LIVE vs to-build

**Live (built):**
- `n8n/workflows/read-input.json` — `Read Input (v1)`, the unified reader (replaces the planned
  `read-input-text.json` / `read-input-visual.json` / `input-router.json`, which were never built).
- `n8n/workflows/assemble-context-and-build-prompt.json` — Stage A (was planned `build-prompt.json`).
- `n8n/workflows/execute-llm-call.json` — Stage B (was planned `execute-create-output.json`).
- `n8n/workflows/post-reply.json` — Stage C (was planned `post-back.json`).
- `n8n/workflows/agent-orchestrator.json` — thin orchestrator (was the monolithic `agent-spine.json`).
- `n8n/workflows/invoke-model.json` — text + multimodal model seam (messages always an array; vision
  via remote `image_url`).
- `n8n/workflows/context-gather.json` — unchanged reading path.
- Docling compose entry + `infrastructure/deployment.md §Docling` (digest-pinned, LIVE).
- `architecture/decisions/036-multimodal-io-image-generation.md` (the ADR; "035" in older copies).
- `supabase/migrations/012`–`022` (above).

**To build (Phase B):**
- `n8n/workflows/invoke-image-model.json` — tiered, multi-provider, step-down fallback.
- `n8n/workflows/image-resolver.json` — and the assembler (extend `post-reply.json`'s Build Comment).
- Append-only migration if image seeds are refreshed (Block 8).
- ADR-036 Consequences appends per block; current.md §15 updates.

---

## 7. Build sequence (remaining)

Phase A (input) + spine decomposition are DONE (migrations through 022; Docling live; reader live;
input wired into the spine and verified end-to-end). Remaining:

1. ~~**Block 6** — input-image robustness fallback (§3.7): unprocessable/non-vision image → WARN +
   `[BRAK]` + text-only, the call never sinks. Closes Phase A.~~ **DONE 2026-06-12** (reactive
   Opus→text-only safety net in `invoke-model.json`; verified live). **Phase A INPUT is complete.**
2. **Block 8 (GATE)** — provision + verify image providers through LiteLLM; refresh dated seeds;
   accept provider DPAs/SCCs (account-level, residency-agnostic per ADR-043); one
   `image_generation` call per tier returns an image + a cost header (or static price).
3. **Block 9** — `invoke-image-model` (tiered, step-down, one priced row per attempt via Log Model Run).
4. **Block 10** — comment_native delivery primitives in Stage C (temp staging / upload / rollback /
   TTL sweep), proven with a dummy image; also unblocks fully-multimodal **input** (host embedded +
   page-render images → the same `image_blocks_json` path).
5. **Block 11** — `image-resolver` + multimodal assembler (resolve embed_input / generate→temp;
   interleave inline Delta).
6. **Block 12** — end-to-end: flip Stage B's drafting model to the output block contract; full
   A→B→C multimodal run; tiered by impact; nothing finalized.

(Block numbers preserve ADR-036's existing cross-references; there is no Block 7.)

---

## 8. Verification (Definition of Done; node-by-node logs, not just green overall)

1. **[DONE]** Prereqs: Docling up; migrations applied. Phase B adds: each seeded image model
   reachable via LiteLLM `image_generation` (cost header verified or static price set).
2. **[DONE]** One extractor: a .docx and a .pdf each produce the shared contract via Docling; a
   corrupt file yields `[BRAK: extraction_failed]` + WARN, run continues.
3. **[DONE — Block 10, 2026-06-12, in-memory base64]** comment_native delivery: generated images travel as
   base64 in the manifest; Stage C `convertToFile → multipart upload → inline {type:attachment} op` renders
   them inline (verified live, 2 images); forced post-failure after upload → orphan-WARN (no delete API,
   persistence accepted); no temp/disk/sweep (retired — `Execute Command`/file-delete unavailable here).
   Lifecycle binding recorded: attachment is free-floating (survives comment deletion). One-call path
   confirmed absent (comment endpoint is JSON-only). `run_payload_bytes` observability added (migration 025).
4. **[DONE]** Decomposition: one trigger → three executions (A, B, C), each its own log; every Call
   onError reaches the one Reset+Alert path.
5. Tiering (Phase B): Niski selects the cheap model + low cap; Wysoki the top model + high cap.
   Confirm via `model` + `impact` on the `image_gen` rows.
6. Multi-image (Phase B): a mockup-PDP request → multiple images interleaved correctly, each a priced
   `image_gen` row, within the per-impact cap.
7. Step-down (Phase B): force a top-tier provider error → next attempt uses the lower tier +
   `tier-degrade` WARN, comment posts degraded; force all tiers → image dropped with a note + WARN,
   comment still posts. Text-turn error → Opus fallback.
8. Unprocessable-image guard (Block 6): an input image on a non-vision model, or a corrupt/4xx image,
   → WARN + `[BRAK]` + text-only continuation, no hallucination, the call does not sink.
9. **[DONE]** References-not-binaries: no raw binary crosses A→B→C.
10. Cost: Sum Task Cost includes text turns + all `image_gen` rows (incl. degraded retries); CU cost
    field written in C; cross-check `SELECT count(*), sum(cost_pln) FROM agent_runs WHERE clickup_task_id=…`.
11. **[DONE]** Status: "W trakcie" up-front; "Zakończono" in C; any stage failure → Reset + alert, no
    partial post.
12. **[DONE]** Loop guard: Alerts task `869dj2z2c` never read.

---

## 9. Open decisions (confirm at the relevant block; recommendations in brackets)

1. **Image delivery** is `comment_native` via server-temp staging (decided). Remaining verify (not a
   decision): the comment/attachment lifecycle binding (deleted-with-comment vs free-floating), and
   whether a one-call `comment[]`/multipart post collapses attach-then-reference. `assets_sink`/
   `object_store` stay documented future alternatives.
2. **Per-tier image models** — **RESOLVED (Block 8, 2026-06-12):** refreshed to gemini-image (Nano
   Banana / Pro) + `gpt-image-2` via migration 023 (see §3.4), all verified live. Count/resolution caps
   unchanged. Still swappable as models turn over.
3. **Cost field write location**: Stage C [decided].
4. **Provider terms** — **RESOLVED (Block 8):** image providers are Google Vertex (existing DPA+SCCs,
   no-training, `global` per ADR-043) and OpenAI (`gpt-image-2`; DPA+SCCs + API no-training default; ZDR +
   EU residency available but sales-gated, not enabled). Recorded in `compliance/gdpr-processing-decisions.md`
   §4. Residency is **not** a routing concern (ADR-043) — account-level only.
5. **Multimodal input route** is **Gemini** (flash/pro by tier, active; ADR-042/043), not Claude.
   Block 6's vision-capability check applies to whatever the routed model is.

---

## 10. Worked flow: mockup PDP from a .docx + product photos (Phase B target)

Trigger: a teammate @-mentions the agent on a high-value Noven launch task with a `.docx` spec, a
couple of reference photos, and `impact=Wysoki`.

1. Orchestrator sets status "W trakcie", calls Stage A.
2. **Stage A** (`Assemble Context and Build Prompt`): `Read Input (v1)` self-fetches the task — the
   `.docx` → Docling → markdown text blocks; the reference photos → image blocks referencing their
   existing ClickUp URLs (no re-upload). Rules + prefs load; threaded comments read. Build Prompt
   folds attachment text into the prompt, emits `image_blocks_json`, sets `modality='multimodal_input'`,
   and fires any reader `warnings`. Returns the payload.
3. **Stage B** (`Execute LLM Call`): the unprocessable-image guard (Block 6) confirms the routed
   model — **Gemini Pro** for this tier — is vision-capable, so the reference photos pass. The model
   reads the spec and sees the references, then emits the output block list for a full mockup PDP:
   text lead, `generate` hero, text benefits, `generate` lifestyle, `generate` head-comparison
   diagram, text spec table, `generate` detail close-up, text CTA. (No `embed_input` — the real shots
   do not exist yet.)
4. **`image-resolver`** (Block 11) walks the blocks. For each `generate` it calls `invoke-image-model`
   (Block 9) with `impact=Wysoki`: the top-tier image model at max resolution up to the high cap, in
   parallel. On error it steps down one tier + `tier-degrade` WARN. Each attempt writes a priced
   `image_gen` row via `Log Model Run`. Each finished image → per-run temp dir; the block ref is its
   temp path.
5. **`assembler`** interleaves: text → Quill-Delta, generated images inline by temp-path placeholder,
   footer + reviewer @-mention. B returns the comment (temp refs), `temp_manifest`, `total_cost_pln`.
6. **Stage C** (`Post Reply`, Block 10): uploads the manifest's images (attach → ClickUp URL),
   rewrites the Delta refs, posts the mockup PDP as one comment, records the artifact ids on
   `agent_runs`, writes the cost field, deletes the temp dir, sets status "Zakończono". On post
   failure: rollback the just-uploaded attachments, retain temp. Any stage failure → shared Reset +
   Alert; Alerts task never read.

Contrast for a minor product (`impact=Niski`): identical flow, but the router picks the cheap model,
caps at the low image count + standard resolution, for a fraction of the cost. That is the
overpay/underpay control, driven entirely by `impact`.

Result: a fast, fully visual mockup PDP drafted by the model with generated imagery tiered to the
launch's value, ready for the team to iterate on before the real photo shoot, with nothing finalized.
