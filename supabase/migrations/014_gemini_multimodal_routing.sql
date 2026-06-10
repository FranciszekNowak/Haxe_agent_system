-- 014_gemini_multimodal_routing.sql
-- Adds Gemini (Vertex AI global) as the GDPR-compliant multimodal-input route.
-- ADR-038, ADR-039. Append-only.
--
-- Problem: Bedrock EU does not support vision/image input. For personal_data=true tasks
-- that include image attachments, the previous behaviour was to drop images with a WARN.
-- This migration seeds a separate modality='multimodal_input' route that sends GDPR
-- tasks to Gemini on Vertex AI (global endpoint, DPA+SCCs basis) instead of dropping images.
--
-- Note: originally designed for europe-west4; changed to global because Gemini 3.x models
-- (gemini-3.5-flash, gemini-3.1-pro-preview) are not yet available in EU regions. Revisit
-- when EU Vertex AI region support for Gemini 3.x lands (ADR-039).
--
-- Apply AFTER 013_image_tiers_match_clickup.sql. That migration keeps the partial unique index
-- model_routing_impact_modality_key on (impact, modality); this migration drops and recreates
-- it with personal_data in the key to allow two PD variants per (impact, modality) pair.

-- ── 1. Fix unique index to include personal_data ──────────────────────────────

drop index if exists model_routing_impact_modality_key;

create unique index model_routing_non_text_unique
  on model_routing (impact, modality, personal_data)
  where modality != 'text';

-- ── 2. Seed GDPR multimodal-input routes (Gemini EU) ─────────────────────────
-- Wysoki and Krytycznie ważne use Gemini Pro for higher-quality reasoning.
-- eu_only=true: these rows must never be selected for non-EU fallback paths.

insert into model_routing
  (impact, litellm_model, provider, personal_data, modality, eu_only, temperature, max_tokens, active)
values
  ('Niski',            'haxe-gemini-flash-eu', 'vertex_ai', true, 'multimodal_input', true, 0.7, 4000, true),
  ('Średni',           'haxe-gemini-flash-eu', 'vertex_ai', true, 'multimodal_input', true, 0.7, 4000, true),
  ('Wysoki',           'haxe-gemini-pro-eu',   'vertex_ai', true, 'multimodal_input', true, 0.7, 4000, true),
  ('Krytycznie ważne', 'haxe-gemini-pro-eu',   'vertex_ai', true, 'multimodal_input', true, 0.5, 8000, true);

-- ── 3. Seed non-GDPR multimodal-input routes (Anthropic direct) ───────────────
-- Claude direct aliases handle vision natively. Mirror the text-routing tier/model
-- mapping so the routing table is the single source of truth for all modalities.

insert into model_routing
  (impact, litellm_model, provider, personal_data, modality, eu_only, temperature, max_tokens, active)
values
  ('Niski',            'haxe-haiku-4-5-direct',  'anthropic', false, 'multimodal_input', false, 0.7, 4000, true),
  ('Średni',           'haxe-sonnet-4-6-direct',  'anthropic', false, 'multimodal_input', false, 0.7, 4000, true),
  ('Wysoki',           'haxe-opus-4-8-direct',    'anthropic', false, 'multimodal_input', false, 0.7, 4000, true),
  ('Krytycznie ważne', 'haxe-fable-5-direct',     'anthropic', false, 'multimodal_input', false, 0.5, 8000, true);
