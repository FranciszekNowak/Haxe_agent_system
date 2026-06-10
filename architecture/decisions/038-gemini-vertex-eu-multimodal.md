# ADR-038: Gemini via Vertex AI EU as GDPR-compliant multimodal input route

## Context

The personal-data routing axis (ADR-030) sends GDPR-sensitive tasks to AWS Bedrock EU
(eu-central-1). Claude models on Bedrock EU do not support vision/image input. ADR-036
handled this by dropping image blocks and warning the user when `personal_data=true` and
images were present.

As the email workflow (Phase 3) approaches, GDPR tasks will routinely carry image
attachments: invoices, product photos, supplier screenshots. Silently degrading to
text-only is not acceptable for those use cases. A GDPR-compliant provider capable of
vision inference is needed.

## Decision

Add Gemini (Flash and Pro) via Vertex AI at `europe-west4` (Netherlands) as the
`(personal_data=true, modality='multimodal_input')` route.

**Tier assignment:**
- Niski, Średni, Wysoki → `haxe-gemini-flash-eu` (`vertex_ai/gemini-2.5-flash`, europe-west4)
- Krytycznie ważne → `haxe-gemini-pro-eu` (`vertex_ai/gemini-2.5-pro`, europe-west4)

**Non-GDPR multimodal (personal_data=false):** existing Anthropic direct aliases handle
vision natively; explicit routing rows are seeded for completeness.

**New `modality` value:** `'multimodal_input'` — set by the Build Prompt node when image
blocks are present in the input. The Lookup Routing query in Invoke Model gains a
`modality = $3` filter, defaulting to `'text'` when absent.

**Image passing:** The `image_blocks_json` field (array of `{ref, mime, alt}` objects) is
propagated through the entire subworkflow chain (Orchestrator → Execute LLM → Invoke
Model) and converted to the OpenAI vision format (`image_url` content blocks) immediately
before the LiteLLM call.

**Fallback:** If the primary Gemini EU call fails, the existing Opus fallback fires
text-only (Bedrock EU for PD tasks). Fallback drops images — WARN fires via Check
Degradation. This is acceptable: fallback is already a degraded path.

**GDPR stance:** `vertex_location: europe-west4` hardcoded per alias — independent of
`VERTEX_LOCATION` env var (which stays `us-central1` for image generation). Google Cloud's
standard Data Processing Addendum covers Vertex AI inference at EU regions.

## Consequences

- Supersedes the ADR-036 "GDPR / Bedrock image stance" drop-images behaviour. Images are
  no longer silently dropped for GDPR tasks; they route to Gemini EU.
- `model_routing_impact_modality_key` partial unique index from migration 012 is dropped
  and recreated as `model_routing_non_text_unique` on `(impact, modality, personal_data)`
  WHERE modality != 'text'. Migration 013.
- LiteLLM config gains two Gemini EU aliases (`haxe-gemini-flash-eu`,
  `haxe-gemini-pro-eu`). EU region availability must be smoke-tested on first deploy.
- `Parse Response` in Invoke Model detects Gemini aliases → sets provider to
  `'litellm/vertex-eu'` (not `'litellm/anthropic-direct'`).
- Vertex DPA obligation: confirm Google Cloud DPA is accepted for the GCP project. DPA is
  typically auto-accepted at project creation; verify it covers Vertex AI inference.
- `fallback_price_per_unit`: LiteLLM should return `x-litellm-response-cost` for Vertex
  calls; verify at first deploy and seed `fallback_price_per_unit` if the header is absent.
- Image URL accessibility: Gemini on Vertex may require base64-encoded images rather than
  external URLs. If ClickUp CDN URLs are rejected, add a pre-call fetch+encode step. This
  is a known open item; verify at first deploy.

## Date

2026-06-10

> **Update 2026-06-10 — deployment notes from first deploy:**
>
> Initial smoke tests returned 404 "project does not have access" for all Gemini models. Root cause
> was **wrong model IDs**: versioned suffixes (`-001`, `-002`) are discontinued on Vertex AI's
> publisher endpoint as of June 2026. Correct IDs use base names without version suffix:
> `gemini-2.5-flash` and `gemini-2.5-pro`. `gemini-2.0-flash-001` was discontinued 2026-06-01.
>
> During diagnosis we briefly pivoted to the Gemini API (`generativelanguage.googleapis.com`,
> `gemini/` LiteLLM prefix + API key) believing Vertex AI was blocked at org level. This was a
> misdiagnosis — Agent Platform Studio uses the Gemini API endpoint internally, so "it works in
> the browser" does not confirm Vertex AI publisher model access.
>
> Vertex AI path was restored once correct model IDs were identified. EU data residency (europe-west4)
> is maintained as originally designed. GEMINI_API_KEY remains optional in docker-compose.yml but
> is not used by any active alias.
>
> **Gemini 2.5 models use thinking tokens**: even a one-word reply consumes ~20 (Flash) or ~150
> (Pro) reasoning tokens. Cost estimation must account for this overhead.
