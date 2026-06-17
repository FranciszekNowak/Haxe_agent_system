# Master plan — ADR-052: Reference-image (image-to-image) generation

**Read this in full at the start of every block.** This is the durable, cross-desktop source of truth
(the ~/.claude plan file does not travel between machines). Decision record: `architecture/decisions/052-reference-image-generation.md`.

> **ADR numbering note.** This is repo `ADR-052`. The Managed Agents migration is a separate, later pair of
> ADRs (next free numbers, provisionally 053 = endpoint switch, 054 = permission-scoped context retrieval).
> Confirm free numbers in the repo before committing those. This plan is built to be forward-compatible with
> them (see the migration section below), so it ships now and is absorbed later rather than redone.

## Adjustments in this revision (vs the prior plan)

1. New section "Forward-compatibility with the Managed Agents migration": records which blocks are reused as
   the future image-tool internals and which are cheaply superseded, so building now is not throwaway.
2. Block 2 now factors the reference resolution into a standalone, pure, reusable function
   (`resolveReferenceToUrl`) so the future tool handler reuses it verbatim. This converts Block 2 from
   "rebuild at migration" to "relocate at migration".
3. Block 0 open half reordered: the dedicated **HTTP Request node** is the first thing to try for the
   gpt-image-2 edits transport (native multipart sidesteps the Code-node `form-data` block), then the
   hand-built buffer, then the documented downgrade. Timebox added.
4. Cross-references to the migration seam (`reference_urls[]` as the batch input) added to Blocks 2, 3, 4, 5.

## Goal

Let the drafting model anchor a `generate` image block on one of the run's INPUT photos so the image
model produces a NEW scene that visually reflects the real product (today it is pure text-to-image and
invents a wrong product — root cause of the Noven brief on task `869dp81xd`).

## Core design (see ADR-052 for the why)

- **Route by impact, unchanged.** A reference request stays on its tier's routed image model
  (`model_routing` `modality='image'`): Niski/`__default__` → `gemini-2.5-flash-image`, Średni →
  `gemini-3-pro-image-preview`, Wysoki/Krytycznie ważne → `gpt-image-2`. No model-forcing onto one provider.
  (This per-impact image-model routing IS the image-layer provider independence that the Managed Agents
  migration keeps; the migration changes nothing here.)
- **Transport branches by provider:** Gemini → `/v1/chat/completions` with an `image_url` part (PROVEN);
  gpt-image-2 → `/v1/images/edits` (transport OPEN — see Block 0).
- **Fail-soft:** reference failure → plain text-to-image on the same tier model + WARN; never CRITICAL.

## Forward-compatibility with the Managed Agents migration (ADR-053/054)

The migration turns `generate-images-parallel.json` into the **internals of the `generate_image` tool** that
the managed agent calls. Build this plan as-is; the migration swaps the front cheaply and reuses the back.

- **Reused as tool internals (do not design around the migration):** Block 0 (per-provider reference
  transport), Block 3 (per-provider reference routing), Block 4 (reference call + fail-soft), Block 5
  (warnings). The actual gemini-chat-route and gpt-image-edits calls are identical whether triggered by the
  resolver today or by the tool handler tomorrow. The hard, uncertain work (Block 0) is durable regardless.
- **Superseded but cheap at migration:** Block 1 (the `reference_refs` prompt contract) and Block 2 (the
  resolver resolving refs to URLs). Under managed agents the drafting model does not emit a `generate` block
  for a resolver to parse; the agent holds the input photos as Files-API `file_id`s and passes the chosen
  reference to the tool. Block 1 is instruction text. Block 2 **relocates** (not rebuilds) because of the
  `resolveReferenceToUrl` factoring below.
- **The migration seam is `reference_urls[]` as the batch input.** It is produced by the resolver today and
  by the tool handler tomorrow; the batch (Blocks 3–4) consumes it agnostically and does not change. Keep
  that boundary clean and the swap is local to the front.

## Block status

| Block | Title | Status |
|---|---|---|
| 0 | Capability gate (prove reference transport per provider) | **DONE (2026-06-17)** — Gemini chat-route + gpt-image-2 `/v1/images/edits` (HTTP Request node) both proven with visual fidelity |
| 1 | Contract: add `reference_refs` to the `generate` block (Stage A) | **DONE (2026-06-17)** — conditional `reference_refs` contract + anchoring paragraph + real-ref example; live Stage A run on `869dp81xd` rendered it (incl. zip-unpacked `NovenPackshot.jpg` ref); non-image task gets plain contract |
| 2 | Resolver: resolve `reference_refs` → `reference_urls` (via reusable `resolveReferenceToUrl`) | **DONE (2026-06-17)** — standalone `resolveReferenceToUrl(ref, lookup)` in `Build Batch Request`; generate items carry `reference_refs[]`+`lookup_map`; each ref → `reference_urls[]`, miss → `prebatch_warnings` folded into `warnings[]` by `placeholder_id` in `Handle Gen Result`; deployed live + drift-clean; logic proven offline (7/7 assertions: source_ref/url resolve, bogus→WARN, no spurious warns) |
| 3 | Batch routing: per-provider reference transport flag (no model-forcing) | **DONE (2026-06-17)** — `Resolve Batch Requests` emits `use_reference`/`ref_transport`/`reference_urls` per request; transport classified by the already-routed model (`openai/gpt-image-2`→`edits`, gemini→`gemini`), NO reference-driven model-forcing; no-ref request untouched. Deployed live to `2keb6XVWq5PG0leK`, drift-clean, validates 0-error; logic proven offline (21/21 assertions). No live image run (path inert until Block 4) |
| 4 | Batch: per-provider reference call + parse both response shapes + fail-soft | not started — **NEXT** |
| 5 | Warnings + reliability sweep | not started |
| 6 | End-to-end @-mention verification + ADR finalisation | not started |

Migration legend: Blocks 0, 3, 4, 5 = reused as tool internals. Blocks 1, 2 = superseded-but-cheap at
migration (Block 1 prompt text; Block 2 relocates via the reusable resolver).

## Critical files

- `n8n/workflows/assemble-context-and-build-prompt.json` — `Build Prompt` (output-block contract text)
- `n8n/workflows/image-resolver.json` — `Resolve & Explode Blocks`, `Build Batch Request`, `Handle Gen Result`
- `n8n/workflows/generate-images-parallel.json` — `Resolve Batch Requests`, `Fire Images Concurrently`, `Assemble Batch Output`
- All sub-workflow returns stay **branch-free** (n8n return-determinism trap); resolver `Merge Branches →
  Assemble Output` stays the sole terminal. No new graph branches.

## What already exists and is reused (do not rebuild)

- Resolver `Resolve & Explode Blocks` already parses `input_image_refs_json` into a `lookup` map keyed by
  `source_ref` (att id) AND `ref` (URL) — used today only for `embed_input`. Input-image URLs (incl. zip-render
  Supabase signed URLs) are already in-hand at the resolver.
- Drafting model already references input images by `source_ref` in the `# Załączone obrazy` prompt section.
- Batch `Fire Images Concurrently` already uses `this.helpers.httpRequest`, an 840 s soft-deadline + per-call
  timeout clamp, and per-image try/catch that never throws.
- Observability seam fixed: per-image `warnings[]` → resolver `Assemble Output.warnings` → `execute-llm-call`
  `Has Warnings?` → `Alert Resolver Warnings` (WARN). **No new alert node needed.**

---

## Block 0 — Capability gate (DONE 2026-06-17)

**DONE — gpt-image-2 edits PROVEN (2026-06-17).** The `/v1/images/edits` reference transport works via a
**dedicated n8n HTTP Request node** (`typeVersion 4.2`) building the multipart body — this sidesteps the
Code-node `form-data` block that defeated every earlier Code-node attempt. Probe chain: `When Called` →
`Get Image Key` (Vault) → `Download Reference` (HTTP GET → binary) → `Edit Call` (HTTP Request node,
`multipart/form-data`: `model=openai/gpt-image-2`, `prompt`, `size=1024x1024`, `n=1`, `image`=binary via
`parameterType: formBinaryData` / `inputDataFieldName: data`; auth `Bearer <Vault image key>`) → `Shape Result`.
Returned **HTTP 200 in ~29 s**, image at **`data[0].b64_json`** (raw base64, **not** a data URI like Gemini),
`x-litellm-response-cost`=$0.0145 (treat as unreliable — keep the fallback price floor). **Visual fidelity
confirmed:** the decoded output preserved the reference subject (coloration, tabby markings, eyes, white
chin/chest, nose) re-rendered into a new photorealistic scene per the Polish prompt. The throwaway probe
(`ctfI4tzrM6le0wDY`) was deleted; the run fired 0 WARN / 0 CRITICAL, n8n stayed healthy (no incident repeat).

**Resolution for Blocks 3–4:** No downgrade. Top tiers keep gpt-image-2 natively. But the edits leg **cannot**
fire from the `Fire Images Concurrently` Code node (multipart needs the HTTP Request node) — Block 4 routes
`ref_transport==='edits'` to a dedicated HTTP Request node leg (sequential is fine — top-tier refs are rare),
and `ref_transport==='gemini'` stays in the Code node. The batch parser branches: `b64_json` (edits/generations)
vs Gemini's data URI in `message.images[0].image_url.url`.

**DONE — Gemini chat-route PROVEN (2026-06-16).** Both `gemini-3-pro-image-preview` and
`gemini-2.5-flash-image` via `POST http://litellm:4000/v1/chat/completions` with
`messages:[{role:'user',content:[{type:'text',text},{type:'image_url',image_url:{url}}]}]` returned HTTP 200
with a generated image as a **data URI** in `choices[0].message.images[0].image_url.url`; input ref tokenized
(prompt image_tokens 560 pro / 1290 flash); cost headers reliable ($0.139 pro / $0.039 flash); **visual
fidelity confirmed** (decoded output preserved the reference product in a new scene). JSON only, no multipart.
The image-scoped Vault key (`select public.get_litellm_image_key()`, Postgres cred `EjK3iACTbSNRDhVz`)
authenticates on the chat route.

**RESOLVED — gpt-image-2 reference transport (was OPEN).** Option (1) below — the dedicated HTTP Request node —
worked on the first run (see the DONE note at the top of this section). The earlier Code-node failures stand as
the record of *why* the Code node can't carry it: chat-route → 400 (not a chat model); `/v1/images/edits` axios
`formData` → 400; `require('form-data')` → **blocked** (`Module 'form-data' is disallowed`); JSON-with-b64
`image` → 422. The hand-built Buffer (2) and the downgrade (3) were **not needed**.

**Options at resumption (historical — (1) was taken):**
1. **[TAKEN] Dedicated HTTP Request node for the edit leg.** Native multipart, sidesteps the Code-node
   `form-data` block. Runs sequentially, acceptable since reference batches are tiny. Cleanest to carry into the
   future tool handler.
2. ~~Hand-built multipart Buffer~~ — not needed.
3. ~~Downgrade Wysoki/Krytycznie to `gemini-3-pro-image-preview`~~ — not needed; top tiers keep gpt-image-2.

**Block 0 DoD — MET:** ADR-052 records the working gpt-image-2 transport with a decoded image that visibly
reflects the reference (ginger-tabby fidelity test). Blocks 1–6 proceed; Block 1 is next.

**How to probe (reusable recipe):** create a throwaway `When Called` → `Get Image Key` (Postgres cred above) →
Code workflow via the n8n MCP; **activate/publish it** with `POST {N8N_API_URL}/workflows/{id}/activate`
(JSON body `{}`, header `Content-Type: application/json` — a sub-workflow must be PUBLISHED before the harness
caller can reference it); drive it with `node scripts/test-subworkflow.mjs <id> --file input.json`
(`N8N_API_KEY` is in the shell env; pass JSON via `--file`, NOT inline — PowerShell strips quotes). To inspect
a returned image without bloating context: have the Code node return the data URI, capture harness stdout to a
file, decode with Node, and Read the PNG. **DELETE the throwaway workflow afterwards** and keep execution
volume LOW (see incident note).

---

## Block 1 — Contract: `reference_refs` on the `generate` block (Stage A only)

`assemble-context-and-build-prompt.json` → `Build Prompt` (instruction-text edits only; no graph change).
Add optional `"reference_refs":["<ref z sekcji Załączone obrazy>"]` to the `generate` schema line; a strong-but-
conditional Polish instruction (anchor on attached product photos for product-visualisation tasks); a line on
the `embed_input` vs `generate`+`reference_refs` semantic split; update the example. `reference_refs` rides
opaque inside `output_blocks_json`. **DoD:** Stage A test shows the contract + example render with real refs;
non-image task still gets the plain contract.

> Migration note: this block is superseded at migration (the agent passes a `file_id` to the `generate_image`
> tool instead of the drafting model emitting `reference_refs`). It is cheap prompt text; do not over-invest.

## Block 2 — Resolver: resolve `reference_refs` → `reference_urls`

`image-resolver.json`, Code-node edits, graph unchanged.

**Factor the resolution as a standalone, pure, reusable function** (this is the one migration-hardening change):

```
// reusable, caller-agnostic: usable by the resolver today and the tool handler post-migration
function resolveReferenceToUrl(ref, lookup) {
  // lookup keyed by source_ref (att id) AND ref (URL); returns a usable image URL or null
  return lookup[ref] || lookup[ref?.source_ref] || null;
}
```

Keep it free of resolver-specific item/block context (no reliance on n8n `$json` shape inside it); pass the
`lookup` map in explicitly. Wire it into the resolver nodes:

- `Resolve & Explode Blocks`: carry `reference_refs` and stamp `lookup_map` onto the generate item.
- `Build Batch Request`: for each ref call `resolveReferenceToUrl(ref, lookup_map)` → `reference_urls[]`; a
  miss → drop ref + `multimodal/reference-ref-not-found` warning (stash as `prebatch_warnings`).
- `Handle Gen Result`: fold `prebatch_warnings` into `warnings[]` by `placeholder_id`.

New requests_json item: `{placeholder_id,prompt,size,aspect,caption,alt,block_order,reference_urls[]}`.

**DoD:** `requests_json` carries resolved `reference_urls`; bogus ref → WARN, proceeds unanchored; **and
`resolveReferenceToUrl` is a standalone function with no resolver-context dependencies** (so the future tool
handler reuses it verbatim with a `file_id`-derived lookup). `reference_urls[]` is the migration seam — the
batch consumes it agnostic to who produced it.

## Block 3 — Batch routing: per-provider reference flag (`Resolve Batch Requests`)

`generate-images-parallel.json` → `Resolve Batch Requests`, no graph change. **No model-forcing** — keep the
tier's routed model. If `reference_urls.length > 0`: set `use_reference=true` and `ref_transport` by provider
(`gemini` for `vertex_ai/gemini-*`, `edits` for `openai/gpt-image-2`), carry `reference_urls`. Top-tier handling
follows the Block 0 resolution (native gpt-image-2 edits, or downgrade to `gemini-3-pro-image-preview` + note).
**DoD:** ref request keeps its tier model with the right `ref_transport`; no-ref request untouched.

> Migration note: reused as tool internals. The tool handler sets the same `reference_urls`/`ref_transport`
> shape this block already consumes.

## Block 4 — Batch: per-provider reference call + fail-soft (`Fire Images Concurrently`)

`generate-images-parallel.json` → `Fire Images Concurrently`, no graph change. Add `callImageReference(req)`:
- `ref_transport==='gemini'` → `POST /v1/chat/completions` with the text prompt + an `image_url` part per
  reference URL; parse image from `choices[0].message.images[0].image_url.url` (strip `data:…;base64,` → b64).
- `ref_transport==='edits'` → the Block-0-proven gpt-image-2 edits transport; parse `data[0].b64_json`.
`worker(req)`: if `use_reference` → `callImageReference`; on failure (fetch/4xx-5xx/empty) + time remaining →
fall back to plain `callImage(model,req)` text-to-image, `degrade_reason='reference-unanchored'`. Else existing
path unchanged. Track `used_reference`. Keep soft-deadline/Promise.race/`notGenerated` intact.
**DoD:** valid ref → decoded image reflects ref, `used_reference:true`, cost logged, 0 CRITICAL; bad ref →
plain-gen fallback + WARN, `success:true`; no-ref unchanged.

> Migration note: reused as tool internals. This is the durable reference engine; keep `callImageReference`
> self-contained (inputs: prompt, model, `reference_urls`, `ref_transport`) so the tool handler calls it directly.

## Block 5 — Warnings + reliability sweep (`Assemble Batch Output`)

Emit per-image WARNs riding the existing seam (no new alert node): `multimodal/reference-ref-not-found`,
`multimodal/reference-fetch-failed`, `image-batch/reference-edit-unsupported`, `multimodal/reference-oversize`,
`image-batch/reference-unanchored`. Full success → no warning. Every delivering path stays `success:true`,
never CRITICAL. **DoD:** each warning fires once as WARN; `alerts-since.mjs --crit` empty.

> Migration note: the warning TYPES and per-image fail-soft logic are reused. Only the carrier relocates: today
> warnings ride `execute-llm-call`'s seam; post-migration they ride the `custom_tool_result` back to the agent,
> which surfaces them via post-reply. Keep `warnings[]` on the batch output shape so both carriers can read it.

## Block 6 — End-to-end + ADR finalisation

Real @-mention on a task with an attached product photo + visualisation prompt. Verify node-by-node
(`inspect-execution.mjs`): Stage A emits `reference_refs`; resolver resolves `reference_urls`; batch routes to
the tier model with the right transport; reference call 200 + `used_reference:true`; image renders inline and
**visibly reflects the attached product** (the incident's acceptance test). Then the fail-soft case (bad ref →
plain image + WARN). **DoD:** ADR-052 → Accepted with the transcript; `architecture/current.md` multimodal
section marks the reference path LIVE + the routing rule; drift-clean re-export of all three workflows
(`node scripts/check-workflow-drift.mjs`).

---

## Handoff / open items (as of 2026-06-17)

0. **Resume at Block 4** (batch: per-provider reference call + parse both response shapes + fail-soft, in
   `generate-images-parallel.json` → `Fire Images Concurrently`). Blocks 0–3 are DONE. Block 3 landed the
   routing flag in `generate-images-parallel.json` → `Resolve Batch Requests` (deployed live to
   `2keb6XVWq5PG0leK`, drift-clean, validates 0-error):
   - Per request, after the (unchanged) model routing + shape-upgrade logic, it now emits three fields:
     `use_reference` (true when the request carries ≥1 non-blank `reference_urls`), `ref_transport`
     (`'edits'` when the chosen model is `openai/gpt-image-2`, else `'gemini'`), and the cleaned
     `reference_urls[]`. Classification follows the **already-chosen** model — there is **no
     reference-driven model-forcing** (a Niski reference stays on `gemini-2.5-flash-image`; the pre-existing
     gemini→gpt-image-2 *shape* upgrade still applies and correctly carries `ref_transport:'edits'`).
   - A no-reference request gets `use_reference:false`, `ref_transport:''`, `reference_urls:[]` and is
     otherwise byte-for-byte unchanged (model, size, prices, quality all preserved).
   - **Block 4 consumes these three fields.** `worker(req)`: if `use_reference` → `callImageReference(req)`
     (gemini chat-route for `ref_transport:'gemini'`, gpt-image-2 `/v1/images/edits` for `'edits'`,
     parsing the two response shapes from Block 0); on failure + time remaining → fall back to the existing
     plain `callImage` text-to-image with `degrade_reason='reference-unanchored'`. Keep `callImageReference`
     self-contained (inputs: prompt, model, `reference_urls`, `ref_transport`) so the future tool handler
     reuses it verbatim (ADR-053/054).
   - **Verification:** logic proven offline (21/21 assertions on the real extracted node code — gemini tiers
     classify `gemini`, gpt-image-2 classifies `edits`, no-ref untouched, blank/empty urls filtered, mixed
     batch handled per-request, shape-upgrade interaction yields `edits`). **No live image run fired** — the
     reference path is inert until Block 4, so a live batch would only exercise plain text-to-image and add
     prod execution volume (incident lesson) without testing references; the meaningful end-to-end (real
     attached product photo, visible anchoring) is Block 6's DoD. Live workflow validates 0-error.
   - **`current.md` still intentionally NOT updated** — `reference_urls`/`ref_transport` are produced but not
     yet consumed; the "reference path LIVE" write-back stays Block 6's DoD.

1. **(historical — Block 2 handoff, kept for context)** Block 2 landed the resolver in
   `image-resolver.json` (deployed live to `znDqcfgXK6CNte20`, drift-clean):
   - `Build Batch Request` now holds the standalone, caller-agnostic `resolveReferenceToUrl(ref, lookup)` (no
     `$json`/item context — the future `generate_image` tool handler reuses it verbatim with a `file_id`-derived
     lookup, ADR-053/054). It resolves each generate block's `reference_refs[]` against that block's `lookup_map`
     into `reference_urls[]`, appended to each item in `requests_json`. A miss → `prebatch_warnings[]` (placeholder
     + `multimodal/reference-ref-not-found`).
   - `Resolve & Explode Blocks` stamps `reference_refs[]` + `lookup_map` (the same `source_ref`/url-keyed input
     map embed uses) onto each generate item.
   - `Handle Gen Result` reads `prebatch_warnings` back by node reference (`$('Build Batch Request').first().json`
     — executeWorkflow drops the field across the boundary) and folds them into each placeholder's `warnings[]`,
     which ride the existing seam → `Assemble Output.warnings` → `execute-llm-call Has Warnings?` → WARN. **No new
     alert node.**
   - **`reference_urls[]` is the migration seam** — Block 3 consumes it from `requests_json` agnostic to who
     produced it. The batch's `Resolve Batch Requests` already ignores unknown request fields, so `reference_urls`
     rides harmlessly today and is wired in Blocks 3–4.
   - **Verification:** logic proven offline (7/7 assertions — resolve by `source_ref` and by url, bogus→empty+WARN,
     no-ref→empty, warning folds to the right placeholder, no spurious warns on good refs). **No image-generating
     live run was fired** — the reference path is inert until Blocks 3–4, so a live run would only generate plain
     text-to-image and add prod execution volume (incident lesson) without exercising references; the meaningful
     end-to-end run (real attached product photo, visible anchoring) is Block 6's DoD.
   - **`current.md` still intentionally NOT updated** — `reference_urls` is produced but not yet consumed; the
     "reference path LIVE" write-back stays Block 6's DoD.
2. **Orphaned throwaway workflow STILL pending manual deletion:** `1fEEAhXlqgo1B8Sf` ("_TMP test-subworkflow
   PROBE adr052 reference image (throwaway)"). It is now **archived + inactive** (no longer active, so the
   "Workflow activation failed sub-workflow validation" log line has stopped — it is benign), but it still
   exists. The auto-mode classifier blocked the MCP delete again (workflow not created by the agent in-session).
   **Action: delete it from the n8n UI**, or authorize the delete. This session's own probe (`ctfI4tzrM6le0wDY`)
   was created and deleted in-session — already gone.
3. **Testing discipline (hard lesson — see ADR-052 incident + CLAUDE.md):** the Block 0 spike took prod down by
   flooding n8n with throwaway executions + rapid workflow create/delete, wedging the Insights subsystem →
   502. Recover with `docker restart n8n-main`. Keep test execution volume LOW; delete throwaway workflows
   promptly.
4. **Nothing has shipped to production.** All workflow JSON in the repo is unchanged; only docs + CLAUDE.md were
   committed. `architecture/current.md` is updated only when blocks land.
5. **Migration hardening (this revision):** keep `resolveReferenceToUrl` (Block 2) and `callImageReference`
   (Block 4) self-contained and caller-agnostic. They are the two functions the future `generate_image` tool
   handler reuses verbatim, which is what makes this whole plan absorbed-not-redone by ADR-053.
