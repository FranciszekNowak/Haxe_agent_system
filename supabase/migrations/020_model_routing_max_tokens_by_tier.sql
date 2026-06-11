-- 020_model_routing_max_tokens_by_tier.sql
-- Re-baselines model_routing.max_tokens per impact tier (operator decision, 2026-06-11).
-- Supersedes earlier per-row values, including 019's n/d multimodal 12000.
--
-- IMPORTANT: max_tokens is the OUTPUT (completion) cap only. It does NOT limit input/context —
-- that is the model's context window. Large-context tasks are unaffected; this only bounds how
-- long the model's REPLY may be. Reasoning models (Gemini 3.x, Fable 5) count thinking tokens
-- against this cap, which is why the old 4000 truncated gemini-flash to an empty completion.
--
-- Tiers (operator): Niski 8k, Średni 16k, Wysoki + Krytycznie ważne 32k.
-- n/d and __default__ are not separately specified -> default to 8k (the Niski/floor value);
-- adjust if a different floor is wanted. Image-generation rows (modality='image') are left
-- untouched — max_tokens does not apply to them.

update model_routing set max_tokens = 8000  where impact = 'Niski'                         and modality <> 'image';
update model_routing set max_tokens = 16000 where impact = 'Średni'                        and modality <> 'image';
update model_routing set max_tokens = 32000 where impact in ('Wysoki', 'Krytycznie ważne') and modality <> 'image';
update model_routing set max_tokens = 8000  where impact = 'n/d - zadanie nie jest dla AI' and modality <> 'image';
update model_routing set max_tokens = 8000  where impact = '__default__'                   and modality <> 'image';
