# Spec: Multimodal I/O + Agent Spine decomposition

Status: ready to build. Build in n8n via the n8n MCP per ADR-018, then export JSON. Apply documentation write-back discipline: update `architecture/current.md` and append numbered ADRs when done. Repo is source of truth; this spec is a disposable execution instruction referencing durable docs.

## 0. Scope

In scope:
1. Two input-reader subworkflows (text-derived, visual) emitting one shared block contract, each using a single extractor (Docling).
2. Output multimodality with image generation as a core capability: the drafting model emits a block list (text + image intent); a deterministic resolver fills it (placement or generation); an assembler interleaves inline; posted as one ClickUp comment.
3. A tiered, multi-provider image-generation router selected by the task's `impact` field (product/launch value), with step-down fallback.
4. Decomposition of the Agent Spine into three subworkflows behind a thin orchestrator (Build Prompt / Execute+Create Output / Post Back).

Deferred (additive later, not an overhaul):
- Search v2 (agentic context-gathering loop). Keep the existing `Call Search` (v1) node in stage A unchanged.
- Personal-data EU-restriction route for image generation (see 0.1).

Use case: PDP mockups are generated before the real photo shoot so the team iterates fast. Generation is central, multiple images per comment are expected, and quality scales with product value via `impact`.

Governance of generated images: no hardcoded validator. The caller's rules/prefs doc (stage A) instructs image policy; the human-verification gate (nothing finalizes) is the backstop. Generated images here are pre-shoot mockups meant to be replaced by real photography.

## 0.1 GDPR boundary (read once)

Image-generation payloads carry no personal data, so they route across the full model set by `impact` alone. This is the documented premise; if a real need to generate or edit images of identifiable people ever appears, re-add a per-call EU-restriction route (a stage-A classification + a region filter). Residency is not stored as a flag: it is a property of the model's identity and region, which `model_routing` already carries and `agent_runs` already records per call, so the future filter keys off that, not a denormalized column.

This relaxation applies to the image-generation path only. The text and reasoning path keeps EU residency unchanged (Claude on Bedrock EU, PD Verifier in stage A), because it processes ClickUp content that can contain personal data. Do not loosen that.

---

## 1. Shared block contract (input and output)

> **SUPERSEDED for output delivery by ADR-063 (2026-06-27).** The *output* block contract below — the
> drafting model emitting the block list as a free-text/fenced JSON answer that a hand-rolled
> `parseBlockArray()` then parses — is replaced by the **`deliver_output` custom tool**: the model submits
> its final answer by *calling* `deliver_output`, whose input schema *is* the block array, and the Anthropic
> API returns that input as validated parsed JSON (no parse step to fail). Field names are unchanged (plus a
> new `doc` block type). The **input** block contract (readers) is unaffected. See
> `architecture/decisions/063-structured-tool-call-output-delivery.md` for the canonical output schema.

Both readers and the drafting model speak the same ordered list of blocks. References, never raw binaries, cross any workflow boundary. Image bytes live at a `ref` (a ClickUp-hosted URL, from whichever host policy is active per 3.6); bytes are resolved only inside the node that needs them.

Input block (emitted by readers):
```json
{ "type": "text",  "order": 0, "md": "..." }
{ "type": "image", "order": 1, "ref": "<clickup_url>", "mime": "image/png",
  "source": "input", "source_ref": "<attachment_id>", "alt": "..." }
```

Output block (emitted by the drafting model):
```json
{ "type": "text",  "md": "..." }
{ "type": "image", "mode": "embed_input", "ref": "photo_2", "caption": "...", "alt": "..." }
{ "type": "image", "mode": "generate", "prompt": "...", "aspect": "1:1", "caption": "...", "alt": "..." }
```

`mode` distinguishes placement (`embed_input`, references an existing image by handle, no upload) from generation (`generate`, carries a prompt). The resolver converts both into a concrete `ref` before the assembler runs.

---

## 2. Input readers (two subworkflows, one router, one extractor)

Single extractor: Docling on the VPS. It covers xlsx, docx, csv, pdf, pptx, and images (OCR), emitting markdown with layout and tables. There is no provider fallback; the only fallback is error to a missing-content marker. If a real file defeats Docling, it surfaces as a WARN with the filename and a targeted path is added then. Docling's layout models prefer a GPU; on a CPU-only VPS it is slower but fine at this volume.

### 2.1 `read-input-text` (xlsx, docx, csv, txt)
- Fetch attachment binary inside the reader (binary stays local; `binaryMode:"separate"`).
- Docling -> ordered `text` blocks. Images embedded in the doc are new bytes: host per the image-host policy (3.6), emit as `image` blocks.
- onError=continueRegularOutput: extraction failure emits `{type:"text", md:"[BRAK: extraction_failed <file>]"}` + WARN (`multimodal/extraction-failed`).

### 2.2 `read-input-visual` (pdf, pptx, images)
- Fetch binary locally.
- Images already attached to the task: reference the existing URL (no re-upload). Pages/slides rendered by Docling are new bytes: host per the image-host policy. Also emit extractable text as `text` blocks (hybrid allowed).
- Same onError/WARN discipline.

### 2.3 `input-router`
- Switch on MIME/extension, dispatch each attachment to the correct reader, concatenate into one ordered block list (stable order by source then page). Returns to Context Gather.

The split is by primary strategy, not exclusive output type. Both readers may emit mixed blocks.

---

## 3. Output multimodality (inside stage B)

### 3.1 Drafting model emits block list
> **SUPERSEDED by ADR-063 (2026-06-27).** The drafting model no longer *returns* the block list as its
> text answer; it **calls the `deliver_output` tool** with the block array. On the managed lane the tool is
> declared on the agent (`sync-agent-definitions.json → Build System`) and the persona contract mandates the
> call; on the bare lane `Invoke Model (v1)` forces it via `tool_choice`. The semantics below
> (`embed_input` vs `generate`, multiple `generate` blocks per comment, no render restrictions) are
> unchanged — only the *delivery channel* moved from free text to a tool call.

Build Prompt instructs the drafting model (vision-capable EU Claude alias) to return the output block contract: `embed_input` when a real asset exists, `generate` to mock up a visual that does not exist yet. For mockup PDPs, multiple `generate` blocks per comment are expected. No render restrictions (governance is the prefs doc + human gate).

### 3.2 `image-resolver` (deterministic)
Walk output blocks in order:
- `text` -> pass through.
- `image mode=embed_input` -> resolve the handle to the existing image ref (no model, no upload).
- `image mode=generate` -> call `invoke-image-model` (3.3) with the prompt and the task `impact`; write the result to the per-run temp dir (3.6); set the block ref to the temp path. Only images that remain in the final block list are uploaded later; discarded generations stay in temp and are purged.
- Generation count and resolution are impact-driven (3.4). Generate calls run in parallel up to the per-impact cap.
- Per-block failure handling -> step-down fallback (3.3). At the bottom tier, drop that image block, insert a caption note, WARN (`multimodal/image-gen-failed`). The comment still posts.

### 3.3 `invoke-image-model` (LiteLLM image seam; tiered, multi-provider, step-down fallback)
- Inputs: `prompt`, `impact`, generation params from 3.4.
- Selects the model from `model_routing` by `(impact, modality='image')` (direct lookup, one model per tier seeded).
- Calls LiteLLM `image_generation` for every provider so the cost seam is uniform.
- Fallback: on provider error, route to the same-modality model one impact increment lower and retry. Each degrade fires a loud WARN (`multimodal/tier-degrade`) so a human sees the result was rendered below the requested tier. At the lowest tier, fail the block (image: drop + WARN; the resolver continues).
- Captures cost from the LiteLLM response header; writes one `agent_runs` row per attempt, `triggered_by='image_gen'`, with `model` and `impact` (region/residency is implied by the model identity, not stored separately). If a provider returns no cost header, price from the static per-image table and still write the row.

### 3.4 Impact tiering
`impact` means product/launch value here. It selects model quality, image-count cap, and resolution together. It is also the fallback ladder.

| impact | seeded model (examples; verify availability/pricing at build) | max images | resolution |
|---|---|---|---|
| low (minor product) | fast/cheap: Stability SD3.5 / Core, or Flux schnell | 2 | standard |
| medium | mid: Gemini 3.1 Flash Image, Imagen 4, or Stability Stable Image Ultra | 4 | high |
| high (major launch) | top: Gemini 3 Pro Image (Nano Banana Pro), GPT-image high, or Imagen 4 Ultra | 8 | max |

Model lists are seed values in `model_routing` (data, not code), swappable as models turn over. One model per tier for now.

### 3.5 `assembler` (extends Build Comment, ADR-027/028)
- Walk resolved blocks: render `text` via markdown->Quill-Delta; insert inline image embeds at position, referencing the temp paths as placeholders (the actual ClickUp URLs are not known until C uploads them).
- Append the "Do weryfikacji, nie finalizuje" footer and the reviewer @-mention.
- Returns `{ rendered_comment: { delta, image_refs(temp paths) }, temp_manifest, total_cost_pln }`.

### 3.6 Image delivery (comment_native, staged through server temp)

Decision: deliver images via the native ClickUp comment-attachment flow (inline image and task attachment are the same object in ClickUp). New image bytes are staged on the server and uploaded only as part of the final comment. `image_host` remains a setting (not a law) but its implemented value is `comment_native`; `assets_sink`/`object_store` are documented as unused alternatives, addable later.

Flow (generate in B, upload/post/cleanup in C, so C still owns every ClickUp side-effect):
1. B resolver generates each `generate` image and writes it to a per-run temp dir (`/<tmp_root>/<run_id>/`), keyed by run/task id for concurrency safety. Block refs are temp paths.
2. B returns the comment (Delta with temp-path refs) and a `temp_manifest` listing the files for the images actually present in the final block list. Discarded generations are left for cleanup, never uploaded.
3. C uploads the manifest's images to the task (attach -> ClickUp URL), rewrites the Delta refs from temp paths to those URLs, then posts the comment. `embed_input` images already on the task are referenced in place, never re-uploaded.
4. On success, C deletes the run's temp dir. On failure after any attach, C deletes the just-uploaded attachments (rollback, so a failed run leaves the task clean) and retains temp for retry; a periodic TTL sweep removes temp dirs from crashed runs that never reached cleanup.

API basis: the official Create Task Comment endpoint documents only `comment_text`, `notify_all`, and `assignee`/`group_assignee`. It has no file field and no field that takes a path, and ClickUp cannot read the agent's disk, so a temp filename cannot be referenced; image bytes must be uploaded to ClickUp (the separate multipart attachment endpoint) to become a referenceable URL. The documented path is therefore: upload to get a URL, then a comment that references it (attach-then-reference, as in steps 3-4).

To verify (could simplify): whether POST comment also accepts (a) a rich `comment[]` array with image elements positioned between text, referencing uploaded URLs, or (b) a multipart body carrying the files in one call (claimed by a third-party guide, not in the official reference). If either works, the attach, rewrite, and post steps collapse into one request and the orphan-rollback in step 4 is unnecessary. Until verified, keep attach-then-reference.

Other assumptions: temp-on-disk assumes single-host n8n (paths shared across the B and C executions). Verify whether an API-attached image referenced in a comment is bound to that comment's lifecycle (deleted with it) or is a free-floating task attachment; if free-floating, the final mockup images persist on the task after the draft is removed (acceptable: they are legitimate mockup content, not junk).

### 3.7 Bedrock image-input guard (model-call boundary, stage B)
If the assembled input `messages[]` contain an image block and the routed text alias is a Bedrock alias: WARN (`multimodal/image-on-bedrock`), drop the image, substitute `[BRAK: obraz nieczytelny na bieżącym providerze]`, continue. This is about input images to the text model; the generation path is handled in 3.3.

---

## 4. Agent Spine decomposition

Top level becomes a thin orchestrator. Each stage is a Call Workflow node with its own execution log.

```
Trigger (Form / When Called)
  -> Set Status "W trakcie"
  -> Call A: build-prompt
  -> Call B: execute-create-output
  -> Call C: post-back
  -> done
Every Call onError -> shared "Reset Status + Alert" path (one place, replacing per-node alert sprawl)
```

| Stage | Subworkflow | Absorbs (from current spine) | Returns |
|---|---|---|---|
| A | `build-prompt` | Call Context Gather (now calls `input-router`), Call PD Verifier, Call Search (v1, unchanged), Load Agent Rules, Check Rules Loaded, Alert Rules Missing, Build Prompt | `{ prompt_payload, input_blocks(refs), rules, prefs, impact, caller_user_id, clickup_task_id, reviewer }` |
| B | `execute-create-output` | Call Invoke Model (loop, emits block list), image-resolver (generates to per-run temp), assembler (Delta with temp refs), Sum Task Cost | `{ rendered_comment(delta, temp refs), temp_manifest, total_cost_pln }` |
| C | `post-back` | Upload final images (attach -> URL), Rewrite Delta refs, Is @mention?, Post Reply, Post Draft Comment, Update CU Cost Field, Delete temp on success / Rollback attachments + retain temp on failure, Set Status "Zakonczono" / Reset on Failure, and their alerts | `{ status }` |

Boundary decisions:
- `Update CU Cost Field` lives in C, so C owns every ClickUp side-effect (comment, cost, status). B computes cost and returns it.
- `Set Status "W trakcie"` at the top before A. Status resolves only in C or the shared failure path.
- References only across A->B->C. No raw binary crosses a boundary.
- Text-turn fallback mirrors images: on a model-turn error, retry at one impact increment lower (same modality); at the lowest tier, fail the stage -> Reset+Alert.
- Image upload, ref-rewrite, comment post, and temp cleanup all live in C (C owns ClickUp side-effects). B passes temp paths, never bytes. On post failure, C rolls back the just-uploaded attachments.
- Loop guard: exclude the Alerts task `869dj2z2c` from any read.

---

## 5. Data / migrations

Migration 010:
- `model_routing`: add `modality text NOT NULL DEFAULT 'text'`. Selection key `(impact, modality)`, one model per tier seeded. No residency column: residency is implied by the model identity/region already in the row.
- Add an `image_gen_params` config (per impact: max_images, resolution), an `image_host` setting (implemented value `comment_native`), and a temp config (`tmp_root`, sweep TTL).
- `agent_runs` CHECK: add `'image_gen'` to allowed `triggered_by` values.
- Static per-image price table for providers whose LiteLLM response omits a cost header.

`Sum Task Cost` is unchanged; image_gen rows are summed automatically.

---

## 6. Files

New:
- `n8n/workflows/read-input-text.json`
- `n8n/workflows/read-input-visual.json`
- `n8n/workflows/input-router.json`
- `n8n/workflows/build-prompt.json` (stage A)
- `n8n/workflows/execute-create-output.json` (stage B)
- `n8n/workflows/post-back.json` (stage C)
- `n8n/workflows/image-resolver.json`
- `n8n/workflows/invoke-image-model.json` (tiered, multi-provider, step-down fallback)
- `infrastructure/` compose entry for the Docling extraction service + `infrastructure/deployment.md`
- `architecture/decisions/035-multimodal-io-and-spine-decomposition.md`
- `db/migrations/010-model-routing-image-tiers.sql`

Edited:
- `n8n/workflows/agent-spine.json` -> thin orchestrator calling A/B/C; shared Reset+Alert.
- `n8n/workflows/context-gather.json` -> calls `input-router`.
- `n8n/workflows/invoke-model.json` -> unchanged text path; cost seam reused by the image sibling; add the text-turn step-down fallback.
- Build Comment -> `assembler` handling the block list + inline images per host policy.
- `architecture/current.md` -> sections for the single-extractor readers, output multimodality, image-tiering router, image-host policy, GDPR boundary; rewrite the spine section to the three-stage form; touch sec.7 if loop state interacts with sessions.
- ADR appends: 027/028 (assembler now multimodal), 021/024 (image_gen = one priced row per attempt), 014 (file pipe realized via Docling), 004/026 (read-only surface unchanged).

---

## 7. Build sequence

1. Migration 010 (model_routing `modality` + one seeded image model per tier; image_gen params; `image_host` setting; agent_runs CHECK; static price table).
2. Stand up the Docling extraction service on the VPS; verify .docx and .pdf -> blocks.
3. Implement the comment_native staging flow: per-run temp dir; upload-then-reference ordering; orphan rollback on post failure; TTL sweep. Verify the comment/attachment lifecycle binding (deleted-with-comment vs free-floating).
4. Build `read-input-text`, `read-input-visual`, `input-router`; test each against the contract.
5. Build `invoke-image-model`; unit-test one generation per tier, confirm cost row and step-down fallback.
6. Build `image-resolver` and `assembler`; test placement (in-place ref) and multi-image generation.
7. Build the three stage subworkflows; test each in isolation.
8. Rebuild `agent-spine` as the thin orchestrator; wire shared Reset+Alert and the text-turn step-down.
9. End-to-end on the Noven test task; then ADR appends + current.md rewrite; export all JSON.

---

## 8. Verification (Definition of Done; node-by-node logs, not just green overall)

1. Prereqs: Docling service up; migration 010 applied; each seeded image model reachable via LiteLLM `image_generation` (cost header verified or static price set).
2. One extractor: a .docx and a .pdf each produce the shared contract via Docling; a corrupt file yields `[BRAK: extraction_failed]` + WARN, run continues.
3. comment_native delivery: generated images are staged in the per-run temp dir; only images in the final comment are uploaded (discards are not); upload-then-reference produces correct inline rendering; on a forced post failure the just-uploaded attachments are rolled back (task left clean) and temp retained; on success temp is deleted; the TTL sweep removes a stale temp dir. Record the observed comment/attachment lifecycle binding, and test the one-call paths (rich comment[] array with positioned inline images, and multipart-with-files); if either works, switch to a single-call post and drop the attach-then-reference rollback.
4. Decomposition: one trigger yields three separate executions (A, B, C), each with its own log; every Call onError reaches the one Reset+Alert path.
5. Tiering: low-impact selects the cheap model with the low cap; high-impact selects the top model with the high cap. Confirm via `model` and `impact` on the `image_gen` rows.
6. Multi-image: a mockup-PDP request produces multiple generated images interleaved correctly, each with its own priced `image_gen` row, within the per-impact cap.
7. Step-down fallback: force a top-tier provider error -> the next attempt uses the medium model, a `tier-degrade` WARN fires, the comment posts with the degraded image; force all tiers to fail -> the image is dropped with a note + WARN, comment still posts. Same test for a text-turn error degrading one tier.
8. Bedrock image-input guard: input image routed to a Bedrock text alias -> WARN + `[BRAK]`, no hallucination.
9. References-not-binaries: no raw binary crosses A->B->C.
10. Cost: Sum Task Cost includes text turns + all image_gen rows (including degraded retries); CU cost field written in C; cross-check `SELECT count(*), sum(cost_pln) FROM agent_runs WHERE clickup_task_id=...`.
11. Status: "W trakcie" before A; "Zakonczono" in C; any stage failure -> Reset + alert, no partial post.
12. Loop guard: Alerts task `869dj2z2c` never read.

---

## 9. Open decisions (confirm at build start; recommendations in brackets)

1. Image delivery is `comment_native` via server-temp staging (decided). Remaining verify, not a decision: the comment/attachment lifecycle binding (deleted-with-comment vs free-floating). `assets_sink`/`object_store` stay documented as future alternatives.
2. Per-tier seeded models and the impact->(count, resolution) mapping in 3.4 [recommended starting values]; expect revision as models turn over.
3. Cost field write location: stage C [recommended].
4. Non-EU image providers accepted (Google Vertex, OpenAI/Azure): confirm and keep DPAs in place even though payloads carry no personal data.

---

## 10. Worked flow: mockup PDP from a .docx + product photos

Trigger: a teammate @-mentions the agent on a high-value Noven launch task. The task has a `.docx` spec, a couple of reference photos, and `impact=high`.

1. Top level sets status "W trakcie", calls stage A.
2. Stage A (`build-prompt`): the input router sends the `.docx` to `read-input-text` (Docling -> markdown text blocks) and the reference photos to `read-input-visual` (existing task images referenced in place; any rendered pages hosted per the host policy). PD Verifier runs; rules and prefs load. Build Prompt assembles the payload with input blocks, rules, `impact=high`, reviewer, and the output-contract instruction. Returns the payload.
3. Stage B (`execute-create-output`): the Bedrock image-input guard confirms the alias is vision-capable, so the reference photos pass. Claude reads the spec and sees the references, then emits the output block list for a full mockup PDP: text lead, `generate` hero, text benefits, `generate` lifestyle, `generate` head-comparison diagram, text spec table, `generate` detail close-up, text CTA. (No `embed_input` because the real shots do not exist yet.)
4. `image-resolver` walks the blocks. For each `generate` block it calls `invoke-image-model` with `impact=high`. The router uses the high-tier model at high resolution up to the high cap, in parallel. If the high model errors, it steps down to the medium model and fires a `tier-degrade` WARN. Each attempt writes a priced `image_gen` row. Each finished image is written to the per-run temp dir; the block ref is its temp path.
5. `assembler` interleaves: text blocks to Quill-Delta, generated images inline at position by temp-path placeholder, footer and reviewer @-mention appended. B returns the comment (temp refs), the `temp_manifest`, and `total_cost_pln` (text turns + image_gen rows).
6. Stage C (`post-back`): uploads the manifest's images to the task (attach -> ClickUp URL), rewrites the Delta refs from temp paths to those URLs, posts the mockup PDP as one comment, writes the cost field, deletes the run's temp dir, sets status "Zakonczono". On a post failure it rolls back the just-uploaded attachments and retains temp for retry. Any stage failure routes to the shared Reset + Alert path; the Alerts task is never read.

Contrast for a minor product (`impact=low`): identical flow, but the router picks the cheap model, caps at the low image count and standard resolution, for a fraction of the cost. That is the overpay/underpay control, driven entirely by `impact`.

Result: a fast, fully visual mockup PDP drafted by Claude with generated imagery tiered to the launch's value, ready for the team to iterate on before the real photo shoot, with nothing finalized.
