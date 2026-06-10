-- 013_image_tiers_match_clickup.sql
-- Align image-modality impact tiers with the ClickUp '[AI] Wpływ' custom field
-- (= the Polish text-routing tiers). ADR-036 originally seeded image rows with
-- English keys ('low'/'medium'/'high') purely to dodge a PK collision: the
-- model_routing PK was (impact, personal_data), and an image row keyed 'Niski'
-- (personal_data=false) would collide with the text/Anthropic-direct row for
-- 'Niski'. But the live tasks only ever carry the Polish field values, so the
-- image rows were unreachable by real routing. This migration fixes the root
-- cause instead of the symptom.
--
-- Append-only migration (CLAUDE.md). Apply BEFORE deploying the updated
-- routing workflows (Invoke Model / decide-research-and-deliver now filter
-- modality='text'; this migration makes that filter necessary AND correct).
--
-- Mapping (mirrors text routing, which collapses the top two tiers onto the
-- best model):
--   Niski            -> stability/stable-diffusion-3-5   (was 'low')
--   Średni           -> vertex_ai/imagegeneration@006    (was 'medium')
--   Wysoki           -> openai/dall-e-3                  (was 'high')
--   Krytycznie ważne -> openai/dall-e-3                  (NEW, shared with Wysoki)
--   __default__      -> vertex_ai/imagegeneration@006    (NEW, blank-field fallback)

-- ── 1. Promote PK to include modality ─────────────────────────────────────────
-- Lets (impact, personal_data, 'text') and (impact, personal_data, 'image')
-- coexist for the same Polish impact key. modality is NOT NULL DEFAULT 'text'
-- (migration 012), so it is a valid PK column.

alter table model_routing drop constraint model_routing_pkey;
alter table model_routing add primary key (impact, personal_data, modality);

-- ── 2. Rekey existing image rows to the ClickUp/Polish keys ────────────────────
-- Safe under the new PK: the target (Niski/Średni/Wysoki, false, 'image') triples
-- do not collide with the text rows (different modality).

update model_routing set impact = 'Niski'  where impact = 'low'    and modality = 'image';
update model_routing set impact = 'Średni' where impact = 'medium' and modality = 'image';
update model_routing set impact = 'Wysoki' where impact = 'high'   and modality = 'image';

-- ── 3. Add the two new image rows ──────────────────────────────────────────────
-- Krytycznie ważne shares the top image model with Wysoki (mirrors text routing).
-- __default__ covers a blank/unmapped impact field, matching the text fallback.

insert into model_routing
  (impact, litellm_model, provider, personal_data, modality, eu_only, fallback_price_per_unit, active)
values
  ('Krytycznie ważne', 'openai/dall-e-3',               'openai',    false, 'image', false, null, true),
  ('__default__',      'vertex_ai/imagegeneration@006', 'vertex_ai', false, 'image', false, null, true);

-- The partial unique index model_routing_impact_modality_key (impact, modality)
-- WHERE modality != 'text' (migration 012) still holds: the five image impacts
-- are all distinct. No change needed.

-- ── 4. Rekey image_gen_params to match ─────────────────────────────────────────

update image_gen_params set impact = 'Niski'  where impact = 'low';
update image_gen_params set impact = 'Średni' where impact = 'medium';
update image_gen_params set impact = 'Wysoki' where impact = 'high';

insert into image_gen_params (impact, max_images, resolution) values
  ('Krytycznie ważne', 8, 'max'),
  ('__default__',      4, 'high');

-- ── 5. Refresh table comment ───────────────────────────────────────────────────

comment on table model_routing is
  'Composite (impact, personal_data, modality) -> model-call config + USD token prices. '
  'modality=text: personal_data=false -> Anthropic direct (default), true -> Bedrock EU (GDPR). '
  'modality=image: personal_data=false only; impact uses the ClickUp Polish tiers. '
  'ADR-013/023/024/030/036. Image keys aligned to ClickUp field in migration 013.';
