# ADR-039: Vertex AI Gemini GDPR posture — DPA+SCCs on global endpoint

## Context

ADR-038 added Gemini via Vertex AI as the GDPR-compliant multimodal-input route
(`personal_data=true`, `modality='multimodal_input'`), specifying `vertex_location: europe-west4`
(Netherlands) for geographic data residency under Google Cloud's DPA.

Gemini 2.5-flash was deprecated on Vertex AI's publisher endpoint in June 2026. Its replacement,
Gemini 3.x (`gemini-3.5-flash` and `gemini-3.1-pro-preview`), is not yet available in
`europe-west4` or any EU single-region on Vertex AI. The EU multi-region endpoint
(`europe-aiplatform.googleapis.com`, `vertex_location: europe`) also returns 404 for these model
IDs. Only the global endpoint (`aiplatform.googleapis.com`, `vertex_location: global`) serves
Gemini 3.x.

The Agent Platform Studio browser interface uses `generativelanguage.googleapis.com` (the Google
AI Studio / Gemini API path) internally. "It works in the browser" is not evidence that Vertex AI
publisher models are accessible — these are entirely separate API surfaces.

## Decision

Use `vertex_location: global` for both Gemini aliases (`haxe-gemini-flash-eu`,
`haxe-gemini-pro-eu`), accepting that inference may physically route outside EU data centers.

**GDPR basis:** Vertex AI Data Processing Addendum (DPA) + Standard Contractual Clauses (SCCs).
Google Cloud's DPA is accepted at GCP project creation and covers all Vertex AI inference
including the global endpoint. This is the same contractual basis used by AWS Bedrock for
inference that may transit non-EU AWS infrastructure.

This is a deliberate downgrade from geographic residency (strongest) to contractual protection
(standard enterprise SaaS baseline). For Haxe's current scale and use cases (5-person team,
operational drafting and product work), contractual basis is legally defensible and operationally
acceptable.

**Revisit condition:** When Gemini 3.x models become available at `europe-west4` or another
acceptable EU Vertex AI region, change both aliases' `vertex_location` from `global` to the EU
region in `n8n/litellm-config.yaml`. No Supabase, workflow, or ADR changes are required — the
routing logic, alias names, and `model_routing` rows are region-agnostic. Check Vertex AI
regional model availability when evaluating Gemini upgrades.

**Scope:** This posture applies only to the two Gemini EU aliases used for
`modality='multimodal_input'` GDPR tasks. Text GDPR tasks continue on AWS Bedrock EU
(eu-central-1) with geographic residency unchanged. Image generation aliases use their own
`VERTEX_LOCATION` env var (currently `us-central1` for `imagegeneration@006` — that is a
separate non-PD path).

## Consequences

- GDPR multimodal inference may physically occur outside the EU until Gemini 3.x lands in an EU
  Vertex AI region.
- Contractual GDPR basis (DPA+SCCs) is active; no GDPR violation, but weaker assurance than
  geographic lock for sensitive data.
- Migration to EU region when available: one line change in `litellm-config.yaml` + redeploy.
- Gemini 3.x uses thinking tokens: Flash consumes ~65 reasoning + 1 text tokens per response;
  Pro consumes ~133 + 1. Both are billed on top of output text tokens. Monitor Vertex AI billing
  in the GCP console (`haxe-agent-system-499018`) — real task costs significantly exceed text
  token counts alone.
- The `VERTEX_PROJECT=haxe-agent-system-499018` env var must be set in the VPS `.env`. The
  service account key (`vertex-key.json`) must be present at `/opt/haxe-agents/` on the VPS and
  sourced from 1Password; it is never committed to the repo.

## Date

2026-06-10

> **Update 2026-06-11 (superseded by ADR-043):** this ADR's premise — that a `personal_data`/EU axis
> requires a GDPR-specific Gemini route — is reversed. DPA + SCCs make global model processing lawful,
> so the PD/EU gating is removed and routing becomes PD-blind (capability + modality only). The Gemini
> global-endpoint aliases introduced here are **retained** as global, non-PD capability aliases (dormant
> until opted into). See ADR-043.
