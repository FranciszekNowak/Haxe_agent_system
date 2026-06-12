-- 024_image_token_prices.sql
-- Block 9 (ADR-036): fill the per-1k token prices on the five modality='image' rows so the
-- shared cost path (Log Model Run v1, ADR-035) can price an image generation by token-math —
-- identical to the text path — instead of leaning on the per-image floor. Append-only (CLAUDE.md);
-- UPDATEs only (the rows exist since migrations 012/013/023). PK/columns unchanged; PD-blind global
-- (no personal_data / eu_only — dropped in 021).
--
-- Cost layering after this migration (Block 9, in Invoke Model's image branch + Log Model Run):
--   1. PRIMARY  — live `x-litellm-response-cost` header (Block 8: verified accurate for all three at
--                 standard sizes). Always wins when present and > 0.
--   2. SECONDARY — token-math: (output_tokens/1000 * price_out_usd_per_1k) [+ tiny input term].
--                 The values below are derived DIRECTLY from Block 8's live measurements, so the
--                 fallback reproduces the real cost to ~4 decimals:
--                   gemini-2.5-flash-image    $0.0387 / 1290 out-tok = $0.030/1k  ($30/M)
--                   gemini-3-pro-image-preview $0.1344 / 1120 out-tok = $0.120/1k  ($120/M)
--                   gpt-image-2               $0.2108 / 7024 out-tok = $0.030/1k  ($30/M image-output)
--   3. TERTIARY — fallback_price_per_unit (per-image floor, migration 023) when even tokens are absent.
-- A header miss fires a WARN (invoke-model/image-cost-header-missing) regardless of which layer prices it.
--
-- price_in_usd_per_1k = each provider's TEXT-input rate (the image prompt is a few tokens, so this is a
-- negligible backup term; the header is authoritative): gemini-2.5-flash $0.30/M, gemini-3-pro $2.00/M,
-- gpt-image-2 text-input ~$5/M.

update model_routing
  set price_in_usd_per_1k = 0.0003, price_out_usd_per_1k = 0.030
  where modality = 'image' and litellm_model = 'vertex_ai/gemini-2.5-flash-image';   -- Niski + __default__

update model_routing
  set price_in_usd_per_1k = 0.002, price_out_usd_per_1k = 0.120
  where modality = 'image' and litellm_model = 'vertex_ai/gemini-3-pro-image-preview'; -- Średni

update model_routing
  set price_in_usd_per_1k = 0.005, price_out_usd_per_1k = 0.030
  where modality = 'image' and litellm_model = 'openai/gpt-image-2';                  -- Wysoki + Krytycznie ważne
