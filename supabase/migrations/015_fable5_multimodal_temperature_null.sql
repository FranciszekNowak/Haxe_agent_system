-- 015: Fable 5 multimodal_input temperature fix (Block 1 hotfix, 2026-06-11).
--
-- claude-fable-5 now rejects the `temperature` parameter with HTTP 400
-- ("temperature is deprecated for this model"). The Krytycznie ważne x multimodal_input
-- routing row still carried temperature = 0.5 (seeded by 014_gemini_multimodal_routing),
-- so every critical-tier image task failed its primary call and fell back to Opus. The
-- matching `text` row was already NULL (010_model_routing_nullable_temperature exists for
-- exactly this case). Applied live during Block 1; codified here so migrations stay the
-- source of truth for model_routing (repo == reality).
--
-- Block 3's routing rewrite (016_global_model_routing) must keep temperature = NULL for
-- this row when it re-seeds / collapses the table.

update model_routing
set temperature = null
where litellm_model = 'haxe-fable-5-direct'
  and modality = 'multimodal_input'
  and temperature is not null;
