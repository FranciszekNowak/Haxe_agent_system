# ADR-052: Reference-image (image-to-image) generation

**Status:** Proposed / In progress. Block 0 (capability gate) **DONE** — **both** reference transports are
now proven: the Gemini chat-route (prior session) and the gpt-image-2 `/v1/images/edits` multipart path
(2026-06-17, via a dedicated n8n HTTP Request node). No production workflow has been changed yet; Blocks 1–6
proceed. Tracked block-by-block in
`architecture/Build plans/adr-052-reference-image-generation/master-plan.md`.

**Date:** 2026-06-16
**Deciders:** Franciszek (operator), with design review

## Context

Image generation in the agent pipeline is **pure text-to-image**. The drafting model can *see* attached
product photos (including renders unpacked from a `.zip`, ADR-048) as vision input, but those pixels
never reach the image-**generation** call: `Generate Images Parallel (v1)` fires
`POST /v1/images/generations` with only a text prompt. So the image model invents a plausible-but-wrong
product. This was the root cause of the Noven brief on task `869dp81xd` — every generated frame distorted
the real device even though the genuine `NovenPackshot.jpg` was attached and successfully read.

**Goal:** let the drafting model anchor a `generate` block on one (or more) of the run's input photos, so
the image model produces a NEW scene that visually reflects the real product.

## Decision

1. **Unified, impact-based routing — not single-provider.** A reference-bearing generate request stays on
   **its tier's routed image model** (`model_routing` `modality='image'` by impact, unchanged: Niski/
   `__default__` → `gemini-2.5-flash-image`, Średni → `gemini-3-pro-image-preview`, Wysoki/Krytycznie ważne
   → `gpt-image-2`). We do **not** force every reference onto one provider — that would silently break tier
   semantics and re-introduce the single-provider lock-in the cross-provider ladder (ADR-051/036) was chosen
   to avoid. Only the **transport** branches by provider.

2. **Per-provider reference transport.**
   - **Gemini image models → chat-route.** `POST /v1/chat/completions` with the reference as an `image_url`
     content part; the generated image returns as a data URI in `choices[0].message.images[0].image_url.url`.
     **Proven in Block 0** (see below).
   - **gpt-image-2 → its native edits path** (`/v1/images/edits`). **Transport PROVEN (2026-06-17)** via a
     **dedicated n8n HTTP Request node** building the multipart body (see Block 0 findings). The
     downgrade-to-`gemini-3-pro-image-preview` fallback is therefore **not needed** for capability reasons;
     top-tier reference requests stay natively on gpt-image-2. (The design fork is resolved on the native side.)

3. **Contract.** The output-block `generate` schema gains an optional `reference_refs: ["<ref>"]`, using the
   same input-image identifiers (`source_ref`/`ref`) the `embed_input` block already uses (listed in the
   `# Załączone obrazy` prompt section). Semantics: `embed_input` = insert the existing photo unchanged;
   `generate` + `reference_refs` = synthesize a NEW image visually based on the referenced photo(s). The
   anchoring instruction is **strong but conditional** — only for product-visualisation tasks with attached
   photos.

4. **Fail-soft, never CRITICAL.** A reference that can't be resolved/fetched, or a reference call that fails,
   degrades to **plain text-to-image generation on the same tier model** + a WARN through the existing
   `warnings[]` → `Post Alert (v1)` seam. An unanchored image still beats a gap; the main reply path always
   returns. (Mirrors the existing image-degrade posture, ADR-047 Block B / ADR-051.)

## Block 0 findings (capability gate)

**Gemini chat-route — PROVEN (2026-06-16), with visual confirmation.** Via a throwaway `When Called` →
`Get Image Key` (Vault) → Code probe driven by `scripts/test-subworkflow.mjs`:
- Both `gemini-3-pro-image-preview` and `gemini-2.5-flash-image` on `POST /v1/chat/completions` with an
  `image_url` part returned **HTTP 200 with a generated image** (data URI in
  `choices[0].message.images[0].image_url.url`).
- The reference was genuinely ingested: response billed **input image tokens** (`prompt_tokens_details.image_tokens`
  = 560 pro / 1290 flash) — LiteLLM forwarded the photo, it was not dropped.
- **Cost headers reliable:** `x-litellm-response-cost` = $0.139 (pro) / $0.039 (flash). `finish_reason: stop`.
- **Fidelity confirmed:** decoded the pro output — the reference massager was preserved (shape, colour, head,
  handle, body branding) and re-rendered as a new photorealistic scene on a marble counter. Mechanism + fidelity both hold.
- JSON only — **no multipart, no `/v1/images/edits`** needed for Gemini. The existing image-scoped Vault key
  authenticates on the chat route.
- ADR-045's "LiteLLM drops Gemini `imageConfig`" caveat is about **size/aspect**, not input images — it does
  not apply here.

**gpt-image-2 reference transport — PROVEN (2026-06-17), with visual confirmation.** A throwaway `When Called`
→ `Get Image Key` (Vault) → `Download Reference` (HTTP GET → binary) → **`Edit Call` (a dedicated n8n HTTP
Request node, `typeVersion 4.2`)** → `Shape Result` Code node, driven by `scripts/test-subworkflow.mjs`:
- `POST http://litellm:4000/v1/images/edits` as **`multipart/form-data`** with fields `model=openai/gpt-image-2`,
  `prompt`, `size=1024x1024`, `n=1`, and `image` = the reference bytes (HTTP Request node bodyParameter
  `parameterType: formBinaryData`, `inputDataFieldName: data`). Auth: `Bearer <image Vault key>` (the same
  `get_litellm_image_key()` key that authenticates the Gemini chat-route).
- Returned **HTTP 200** in **~29 s** with the generated image at **`data[0].b64_json`** (a raw base64 string —
  **NOT** a data URI like the Gemini chat-route; the batch parser must branch on transport, see below).
- **Fidelity confirmed:** decoded the output — the reference subject was preserved (coloration, tabby
  forehead "M" + flank striping, eye colour, white chin/chest, nose) and re-rendered as a new photorealistic
  scene per the Polish prompt. Mechanism + fidelity both hold.
- A `x-litellm-response-cost` header *was* present ($0.0145) on this edits call — but per the config note
  (`output_cost_per_image=null` for gpt-image-2) treat it as **unreliable** and keep `model_routing.
  fallback_price_per_unit` as the cost floor (Block 9 WARN-on-zero posture, ADR-051).

**Why the dedicated HTTP Request node, and what it means for Block 4.** The earlier-probed Code-node transports
all failed — chat-route → 400 (not a chat model); axios-style `formData` → 400 (no body captured);
`require('form-data')` → **blocked** (`Module 'form-data' is disallowed` in the n8n Code sandbox); JSON-with-b64
`image` → 422. The n8n **HTTP Request node** assembles multipart in n8n's own runtime, sidestepping the Code
sandbox's `form-data` block entirely. **Consequence for Blocks 3–4:** the Gemini reference call is plain JSON
and rides the existing `Fire Images Concurrently` Code node (`this.helpers.httpRequest`), but the gpt-image-2
edits call **cannot** be fired from that Code node — it needs a dedicated HTTP Request node leg. Top-tier
reference requests are rare and batches are tiny, so this leg may run **sequentially** without material cost.
Block 3 sets `ref_transport` (`gemini` vs `edits`); Block 4 routes `edits` to the HTTP Request node leg and
`gemini` through the Code node, and parses both response shapes (`b64_json` vs the Gemini data URI).

**Response-shape note for Block 4.** The Gemini chat-route returns the image as a **data URI** in
`message.images[0].image_url.url` (strip the `data:image/...;base64,` prefix → b64), whereas `/v1/images/generations`
(and edits) return `data[0].b64_json`. The batch must parse both.

## Incident during Block 0 (must inform resumption)

The Block 0 spike **took production down**. A burst of probe + harness executions plus rapid throwaway-workflow
create/delete drove n8n's **Insights subsystem into a tight write-error loop** ("Error while saving insights
metadata and raw data"), which starved `n8n-main`'s event loop → **502 Bad Gateway** (worker stayed healthy; not
an OOM — 4.7 G/7.5 G used, no swap, no OOM-kill). Recovered with `docker restart n8n-main` (healthz 200, editor
back, insights quiet at 0 errors/60 s once the churn stopped). **Lesson, now in CLAUDE.md:** test the image
pipeline *sparingly* — no large bursts of throwaway executions; the Insights subsystem is fragile under flood.

## Consequences

- Reference support adds **no new graph branches**: the resolver already parses `input_image_refs_json` into a
  `lookup` map (used today for `embed_input`); the batch already routes by impact. Changes are localized to Code
  nodes and one prompt-text edit.
- Cost/latency stays per-tier: Gemini reference ≈ $0.04–0.14 and ~5 s; gpt-image-2 (if/when its transport lands)
  ≈ $0.21 and ~176 s. The conditional anchoring instruction keeps references off the expensive tier unless the
  task warrants it.
- Design fork **resolved (2026-06-17): gpt-image-2 reference transport works**, so top tiers do references
  natively via `/v1/images/edits`. The `gemini-3-pro-image-preview` downgrade is **not** taken. The only
  structural cost is that the edits leg lives on a dedicated HTTP Request node rather than the concurrent Code
  node (see Block 0 findings) — acceptable given how rare top-tier references are.

## References

ADR-036 (multimodal I/O, output-block contract, image gen), ADR-045 (size/aspect routing; Gemini imageConfig
caveat), ADR-047 (fallback seam; image non-blocking), ADR-048 (zip unpacking → input image refs), ADR-051
(parallel image batch; the build pattern + template for this ADR).
