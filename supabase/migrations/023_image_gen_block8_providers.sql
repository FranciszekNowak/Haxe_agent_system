-- 023_image_gen_block8_providers.sql
-- Block 8 (ADR-036): refresh the image-generation tier map to live, current providers.
-- Append-only (CLAUDE.md). UPDATEs only — the five modality='image' rows already exist
-- (migrations 012/013); this repoints them and sets a static price floor per row.
--
-- Why the seeds changed (all dated/dead as of 2026-06):
--   - stability/stable-diffusion-3-5  -> dropped (Stability provider retired in Block 8)
--   - vertex_ai/imagegeneration@006   -> the entire Vertex Imagen family is being shut down
--                                        ~2026-06-24..30; Google's own migration target is
--                                        gemini-2.5-flash-image. Imagen also could not run on
--                                        the `global` endpoint our Vertex creds use.
--   - openai/dall-e-3                 -> deprecated.
--
-- New map (operator-confirmed, 2026-06-12), keyed (impact, modality) — PK unchanged, no
-- personal_data/eu_only (dropped in 021; PD-blind global per ADR-043):
--   Niski            -> vertex_ai/gemini-2.5-flash-image    (Nano Banana,      ~$0.039/img)
--   Średni           -> vertex_ai/gemini-3-pro-image-preview (Nano Banana Pro, ~$0.134/img)
--   Wysoki           -> openai/gpt-image-2                  (flagship)
--   Krytycznie ważne -> openai/gpt-image-2                  (shares top with Wysoki)
--   __default__      -> vertex_ai/gemini-2.5-flash-image    (cheap safe default)
-- This gives Block 9's step-down ladder cross-provider resilience (OpenAI top -> Google).
--
-- fallback_price_per_unit = static USD-per-image FLOOR, used by Log Model Run ONLY when the
-- live x-litellm-response-cost header is missing/invalid (ADR-035 owns cost). Live price always
-- wins; the floor self-retires once the header is reliable.
--   - gemini-image: LiteLLM v1.87.0 cost map HAS a per-image price, and the header was verified
--     live & accurate (Block 8: $0.0387 flash, $0.1344 pro) — the floor here is a pure safety net.
--   - gpt-image-2:  LiteLLM v1.87.0 returned an ACCURATE header live (Block 8: $0.2108 for a high
--     1024x1024 image = 7024 image-output tokens x $30/1M, OpenAI's real rate). The #26863 "$0"
--     bug only bites EXOTIC/non-standard resolutions that miss the cost map, so the floor here is a
--     safety net for that edge (Block 9 WARNs on cost=0-with-tokens). Floor = the measured value.
--
-- Aliases (model_name == litellm_model, 1:1) live in litellm-config.yaml + deployed (LiteLLM
-- v1.87.0). All three models verified live via /v1/images/generations (Block 8).

update model_routing
  set litellm_model = 'vertex_ai/gemini-2.5-flash-image', provider = 'vertex_ai',
      fallback_price_per_unit = 0.038703
  where modality = 'image' and impact = 'Niski';

update model_routing
  set litellm_model = 'vertex_ai/gemini-3-pro-image-preview', provider = 'vertex_ai',
      fallback_price_per_unit = 0.134422
  where modality = 'image' and impact = 'Średni';

update model_routing
  set litellm_model = 'openai/gpt-image-2', provider = 'openai',
      fallback_price_per_unit = 0.210805   -- live-measured: gpt-image-2 high 1024x1024 (Block 8)
  where modality = 'image' and impact = 'Wysoki';

update model_routing
  set litellm_model = 'openai/gpt-image-2', provider = 'openai',
      fallback_price_per_unit = 0.210805   -- live-measured: gpt-image-2 high 1024x1024 (Block 8)
  where modality = 'image' and impact = 'Krytycznie ważne';

update model_routing
  set litellm_model = 'vertex_ai/gemini-2.5-flash-image', provider = 'vertex_ai',
      fallback_price_per_unit = 0.038703
  where modality = 'image' and impact = '__default__';

-- image_gen_params (per-tier max_images / resolution) is UNCHANGED in Block 8.

comment on table model_routing is
  'Composite (impact, modality) -> model-call config + USD token prices. PD-blind global '
  'routing: capability + modality only (no personal_data / EU-residency axis). '
  'text = Claude direct; image = gemini-image (Nano Banana/Pro) + OpenAI gpt-image-2 (Block 8); '
  'multimodal_input = Gemini (flash for n/d/Niski/Średni, pro for Wysoki/Krytycznie). '
  'ADR-013/023/024/030/036/042/043.';
