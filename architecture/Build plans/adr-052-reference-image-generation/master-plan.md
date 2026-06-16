# Master plan — ADR-052: Reference-image (image-to-image) generation

**Read this in full at the start of every block.** This is the durable, cross-desktop source of truth
(the ~/.claude plan file does not travel between machines). Decision record: `architecture/decisions/052-reference-image-generation.md`.

## Goal

Let the drafting model anchor a `generate` image block on one of the run's INPUT photos so the image
model produces a NEW scene that visually reflects the real product (today it is pure text-to-image and
invents a wrong product — root cause of the Noven brief on task `869dp81xd`).

## Core design (see ADR-052 for the why)

- **Route by impact, unchanged.** A reference request stays on its tier's routed image model
  (`model_routing` `modality='image'`): Niski/`__default__` → `gemini-2.5-flash-image`, Średni →
  `gemini-3-pro-image-preview`, Wysoki/Krytycznie ważne → `gpt-image-2`. No model-forcing onto one provider.
- **Transport branches by provider:** Gemini → `/v1/chat/completions` with an `image_url` part (PROVEN);
  gpt-image-2 → `/v1/images/edits` (transport OPEN — see Block 0).
- **Fail-soft:** reference failure → plain text-to-image on the same tier model + WARN; never CRITICAL.

## Block status

| Block | Title | Status |
|---|---|---|
| 0 | Capability gate (prove reference transport per provider) | **IN PROGRESS** — Gemini proven; gpt-image-2 OPEN |
| 1 | Contract: add `reference_refs` to the `generate` block (Stage A) | not started |
| 2 | Resolver: resolve `reference_refs` → `reference_urls` | not started |
| 3 | Batch routing: per-provider reference transport flag (no model-forcing) | not started |
| 4 | Batch: per-provider reference call + parse both response shapes + fail-soft | not started |
| 5 | Warnings + reliability sweep | not started |
| 6 | End-to-end @-mention verification + ADR finalisation | not started |

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

## Block 0 — Capability gate (IN PROGRESS)

**DONE — Gemini chat-route PROVEN (2026-06-16).** Both `gemini-3-pro-image-preview` and
`gemini-2.5-flash-image` via `POST http://litellm:4000/v1/chat/completions` with
`messages:[{role:'user',content:[{type:'text',text},{type:'image_url',image_url:{url}}]}]` returned HTTP 200
with a generated image as a **data URI** in `choices[0].message.images[0].image_url.url`; input ref tokenized
(prompt image_tokens 560 pro / 1290 flash); cost headers reliable ($0.139 pro / $0.039 flash); **visual
fidelity confirmed** (decoded output preserved the reference product in a new scene). JSON only, no multipart.
The image-scoped Vault key (`select public.get_litellm_image_key()`, Postgres cred `EjK3iACTbSNRDhVz`)
authenticates on the chat route.

**OPEN — gpt-image-2 reference transport.** None of these worked from an n8n Code node:
chat-route → 400 (not a chat model); `/v1/images/edits` axios `formData` → 400; `require('form-data')` →
**blocked** (`Module 'form-data' is disallowed`); JSON-with-b64 `image` → 422. **Next to try (in order):**
(1) a **hand-built multipart Buffer** (boundary + parts assembled by hand, sent as `body` with
`Content-Type: multipart/form-data; boundary=…`) — built but its run was interrupted, so unverified;
(2) a **dedicated HTTP Request node** for the edit leg (native multipart; runs sequentially, acceptable since
reference batches are tiny). **If neither works:** decide to **downgrade Wysoki/Krytycznie reference requests
to `gemini-3-pro-image-preview` + inline Polish note** and close the gate on the Gemini path alone.

**Block 0 DoD:** ADR-052 records the working gpt-image-2 transport (or the downgrade decision) with a decoded
image that visibly reflects the reference. Then Blocks 1–6 proceed.

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

## Block 2 — Resolver: resolve `reference_refs` → `reference_urls`

`image-resolver.json`, Code-node edits, graph unchanged. `Resolve & Explode Blocks`: carry `reference_refs`
and stamp `lookup_map` onto the generate item. `Build Batch Request`: resolve each ref via
`map[ref] || map[source_ref]` → `reference_urls[]`; a miss → drop ref + `multimodal/reference-ref-not-found`
warning (stash as `prebatch_warnings`). `Handle Gen Result`: fold `prebatch_warnings` into `warnings[]` by
`placeholder_id`. New requests_json item: `{placeholder_id,prompt,size,aspect,caption,alt,block_order,reference_urls[]}`.
**DoD:** `requests_json` carries resolved `reference_urls`; bogus ref → WARN, proceeds unanchored.

## Block 3 — Batch routing: per-provider reference flag (`Resolve Batch Requests`)

`generate-images-parallel.json` → `Resolve Batch Requests`, no graph change. **No model-forcing** — keep the
tier's routed model. If `reference_urls.length > 0`: set `use_reference=true` and `ref_transport` by provider
(`gemini` for `vertex_ai/gemini-*`, `edits` for `openai/gpt-image-2`), carry `reference_urls`. Top-tier handling
follows the Block 0 resolution (native gpt-image-2 edits, or downgrade to `gemini-3-pro-image-preview` + note).
**DoD:** ref request keeps its tier model with the right `ref_transport`; no-ref request untouched.

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

## Block 5 — Warnings + reliability sweep (`Assemble Batch Output`)

Emit per-image WARNs riding the existing seam (no new alert node): `multimodal/reference-ref-not-found`,
`multimodal/reference-fetch-failed`, `image-batch/reference-edit-unsupported`, `multimodal/reference-oversize`,
`image-batch/reference-unanchored`. Full success → no warning. Every delivering path stays `success:true`,
never CRITICAL. **DoD:** each warning fires once as WARN; `alerts-since.mjs --crit` empty.

## Block 6 — End-to-end + ADR finalisation

Real @-mention on a task with an attached product photo + visualisation prompt. Verify node-by-node
(`inspect-execution.mjs`): Stage A emits `reference_refs`; resolver resolves `reference_urls`; batch routes to
the tier model with the right transport; reference call 200 + `used_reference:true`; image renders inline and
**visibly reflects the attached product** (the incident's acceptance test). Then the fail-soft case (bad ref →
plain image + WARN). **DoD:** ADR-052 → Accepted with the transcript; `architecture/current.md` multimodal
section marks the reference path LIVE + the routing rule; drift-clean re-export of all three workflows
(`node scripts/check-workflow-drift.mjs`).

---

## Handoff / open items (as of 2026-06-16)

1. **Resume at Block 0's open half:** prove a gpt-image-2 reference transport (hand-built multipart Buffer first,
   then dedicated HTTP Request node) OR adopt the gemini-pro downgrade for top tiers. Then proceed to Block 1.
2. **Orphaned throwaway workflow to delete:** `1fEEAhXlqgo1B8Sf` ("_TMP test-subworkflow PROBE adr052 reference
   image (throwaway)") — left active when a harness run was killed; it produces the "Workflow activation failed
   sub-workflow validation" log line. The auto-mode classifier blocked the MCP delete (workflow not created by
   the agent in-session); delete it from the n8n UI or with explicit authorization. (The probe TARGET workflows
   were already deleted.)
3. **Testing discipline (hard lesson — see ADR-052 incident + CLAUDE.md):** the Block 0 spike took prod down by
   flooding n8n with throwaway executions + rapid workflow create/delete, wedging the Insights subsystem →
   502. Recover with `docker restart n8n-main`. Keep test execution volume LOW; delete throwaway workflows
   promptly.
4. **Nothing has shipped to production.** All workflow JSON in the repo is unchanged; only docs + CLAUDE.md were
   committed. `architecture/current.md` is updated only when blocks land.
