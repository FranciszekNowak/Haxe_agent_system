-- 019_nd_multimodal_routing.sql
-- Adds the missing multimodal_input route for the "n/d - zadanie nie jest dla AI" impact tier.
-- Append-only. Companion to the Invoke Model 0-row routing guard (ADR-041).
--
-- Problem: every impact tier had a modality='multimodal_input' route EXCEPT
-- "n/d - zadanie nie jest dla AI" (and __default__ has none). A not-for-AI task that
-- carries an image attachment therefore matched no routing row -> Lookup Routing returned
-- 0 rows -> Resolve Routing never ran (0-item nulls the chain) -> Invoke Model produced no
-- completion and no reply, with NO alert. Observed on task 869dm1z8y (2026-06-11).
--
-- Decision (operator): route n/d + multimodal_input to Gemini Flash EU for BOTH personal_data
-- values — the cheapest GDPR-safe multimodal model, appropriate for the lowest tier. eu_only=true
-- (it is an EU route) — harmless for personal_data=false since the lookup does not filter on it.
--
-- max_tokens=12000 (not 4000 like the other gemini rows): Gemini Flash is a *reasoning* model and
-- max_tokens caps reasoning+output combined. At 4000 a single task burned ~3838 reasoning tokens and
-- truncated (finish_reason=length, content=null) -> empty completion. 12000 leaves ample room for
-- thinking plus a full answer (task 869dm1z8y, 2026-06-11).

insert into model_routing
  (impact, litellm_model, provider, personal_data, modality, eu_only, temperature, max_tokens, active)
values
  ('n/d - zadanie nie jest dla AI', 'haxe-gemini-flash-eu', 'vertex_ai', false, 'multimodal_input', true, 0.7, 12000, true),
  ('n/d - zadanie nie jest dla AI', 'haxe-gemini-flash-eu', 'vertex_ai', true,  'multimodal_input', true, 0.7, 12000, true)
on conflict (impact, personal_data, modality) do update
  set litellm_model = excluded.litellm_model,
      provider      = excluded.provider,
      eu_only       = excluded.eu_only,
      temperature   = excluded.temperature,
      max_tokens    = excluded.max_tokens,
      active        = excluded.active;
