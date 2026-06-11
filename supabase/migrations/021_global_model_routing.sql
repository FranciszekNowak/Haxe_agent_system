-- 021_global_model_routing.sql
-- ADR-043: PD-blind global routing. Collapses model_routing to (impact, modality) only.
-- Append-only. Apply AFTER the workflows stop sending personal_data (Block 3 steps 1-2:
-- invoke-model Lookup Routing + decide-research Lookup Research Routing) and AFTER LiteLLM
-- deploy #1 added the -eu-free Gemini aliases (so the rename below strands no row).
--
-- DPA + SCCs (+ DPF where certified) make non-EU processing lawful, so the personal_data/EU
-- residency axis is removed entirely (ADR-043). Routing is now capability + modality only.
--
-- multimodal_input route = Gemini (operator decision 2026-06-11; ADR-043 Update note, ADR-042):
--   flash for n/d/Niski/Średni, pro for Wysoki/Krytycznie. This is the live-tuned, active
--   route (it has been serving image tasks since migration 019) — NOT the dormant-Claude
--   alternative the original plan assumed. The Claude vision rows are therefore dropped and
--   the Gemini rows kept. text = Claude direct; image = image-gen tiers (unchanged).

-- ── 1. Drop the EU-residency duplicates / non-chosen routes ───────────────────
-- text: drop the Bedrock-EU (personal_data=true) duplicates; keep the global Claude-direct rows.
delete from model_routing where modality = 'text' and personal_data = true;

-- multimodal_input: drop the Claude vision rows (all personal_data=false, provider='anthropic');
-- keep the Gemini flash/pro rows (ADR-042 tiering).
delete from model_routing where modality = 'multimodal_input' and provider = 'anthropic';

-- multimodal_input n/d: migration 019 seeded BOTH personal_data values, both haxe-gemini-flash-eu.
-- Drop the personal_data=false twin so (impact, modality) is unique under the new PK.
delete from model_routing
  where modality = 'multimodal_input'
    and impact = 'n/d - zadanie nie jest dla AI'
    and personal_data = false;

-- image modality is untouched: all rows are personal_data=false image-gen tiers (no PD duplicates).

-- ── 2. Rename the Gemini aliases -eu -> none (now global, not EU-pinned) ───────
-- LiteLLM deploy #1 already serves both names; deploy #2 removes the -eu aliases afterward.
update model_routing set litellm_model = 'haxe-gemini-flash' where litellm_model = 'haxe-gemini-flash-eu';
update model_routing set litellm_model = 'haxe-gemini-pro'   where litellm_model = 'haxe-gemini-pro-eu';

-- ── 3. Re-key the table on (impact, modality); drop the PD/EU columns ──────────
-- The old PK (impact, personal_data, modality) and the partial index both keyed on
-- personal_data. With one row per (impact, modality) the new PK enforces uniqueness for
-- ALL modalities, so model_routing_non_text_unique becomes fully redundant and is dropped
-- (not recreated). The PK btree (impact, modality) also serves the Lookup Routing filter.
drop index if exists model_routing_non_text_unique;

alter table model_routing drop constraint model_routing_pkey;       -- was (impact, personal_data, modality)
alter table model_routing add  primary key (impact, modality);

alter table model_routing drop column eu_only;
alter table model_routing drop column personal_data;

-- ── 4. Document the table ─────────────────────────────────────────────────────
comment on table model_routing is
  'Composite (impact, modality) -> model-call config + USD token prices. PD-blind global '
  'routing: capability + modality only (no personal_data / EU-residency axis). '
  'text = Claude direct; image = image-gen tiers (Stability/Vertex/DALL-E); '
  'multimodal_input = Gemini (flash for n/d/Niski/Średni, pro for Wysoki/Krytycznie). '
  'ADR-013/023/024/030/036/038/040/042.';
