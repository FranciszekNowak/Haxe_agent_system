# ADR-052: Reference-image (image-to-image) generation

**Status:** Proposed / In progress. Block 0 (capability gate) partially done — the Gemini reference
path is **proven**; the gpt-image-2 reference transport is **still open**. No production workflow has
been changed yet. Tracked block-by-block in
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
   - **gpt-image-2 → its native edits path** (`/v1/images/edits`). **Transport not yet proven** (Block 0
     open item). If no Code-node-compatible transport works, the fallback decision is to **downgrade
     Wysoki/Krytycznie reference requests to `gemini-3-pro-image-preview` with an inline Polish note** rather
     than build a fragile path — pending Block 0 resolution.

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

**gpt-image-2 reference transport — OPEN.** Probed four transports; none yet works from an n8n Code node:
- chat-route (`/v1/chat/completions`) → **400** (gpt-image-2 is not a chat model).
- `/v1/images/edits` via the axios-style `formData` option → **400** (no body captured).
- `/v1/images/edits` via `require('form-data')` → **blocked**: `Module 'form-data' is disallowed` in the n8n
  Code sandbox.
- `/v1/images/edits` via JSON with a base64 `image` → **422** (LiteLLM rejected the shape).
- A **hand-built multipart Buffer** attempt (no external module) was created but its run was interrupted by the
  incident below, so it is **unverified**. This is the first thing to try on resumption.

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
- Open design fork (record the resolution here when taken): gpt-image-2 reference transport works → top tiers do
  references natively; OR it doesn't → top-tier references downgrade to `gemini-3-pro-image-preview` + note.

## References

ADR-036 (multimodal I/O, output-block contract, image gen), ADR-045 (size/aspect routing; Gemini imageConfig
caveat), ADR-047 (fallback seam; image non-blocking), ADR-048 (zip unpacking → input image refs), ADR-051
(parallel image batch; the build pattern + template for this ADR).
