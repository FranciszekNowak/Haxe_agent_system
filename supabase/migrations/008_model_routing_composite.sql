-- 008_model_routing_composite.sql
-- Multi-provider routing (ADR-030): promote model_routing to a composite
-- primary key (impact, personal_data) so each impact tier has two rows —
-- one for direct Anthropic API (personal_data=false, default) and one for
-- Bedrock EU GDPR path (personal_data=true).
--
-- personal_data BOOLEAN column already exists (nullable, added in 002).
-- This migration:
--   1. Drops the single-col PK and promotes (impact, personal_data) as the new PK.
--   2. Updates existing rows (personal_data=false, the direct/default path) to
--      versioned alias names that include provider and model version.
--   3. Inserts GDPR rows (personal_data=true) for Bedrock EU.
--   4. Adds 'n/d - zadanie nie jest dla AI' rows (missing from 002 seed).
--
-- Append-only migration (CLAUDE.md). Apply BEFORE deploying updated workflows.

-- 1. Make personal_data NOT NULL with default false (all existing rows become
--    the direct/non-GDPR path).
update model_routing set personal_data = false where personal_data is null;
alter table model_routing alter column personal_data set not null;
alter table model_routing alter column personal_data set default false;

-- 2. Drop old single-col PK; add composite PK.
alter table model_routing drop constraint model_routing_pkey;
alter table model_routing add primary key (impact, personal_data);

-- 3. Update existing (personal_data=false) rows to versioned direct-API aliases
--    and correct USD prices (Anthropic API list prices, verify at console.anthropic.com).
update model_routing
   set litellm_model         = 'haxe-haiku-4-5-direct',
       provider              = 'anthropic-direct',
       price_in_usd_per_1k  = 0.00025,
       price_out_usd_per_1k = 0.00125
 where impact = 'Niski'       and personal_data = false;

update model_routing
   set litellm_model         = 'haxe-sonnet-4-6-direct',
       provider              = 'anthropic-direct',
       price_in_usd_per_1k  = 0.003,
       price_out_usd_per_1k = 0.015
 where impact in ('Średni', '__default__') and personal_data = false;

update model_routing
   set litellm_model         = 'haxe-opus-4-8-direct',
       provider              = 'anthropic-direct',
       price_in_usd_per_1k  = 0.015,
       price_out_usd_per_1k = 0.075
 where impact in ('Wysoki', 'Krytycznie ważne') and personal_data = false;

-- 4. Insert GDPR (Bedrock EU) rows — personal_data=true.
--    Wysoki/Krytycznie ważne use Opus 4.5 (best available GDPR-safe model on Bedrock EU).
insert into model_routing
  (impact, personal_data, litellm_model, provider, temperature, max_tokens, priority,
   nudge, price_in_usd_per_1k, price_out_usd_per_1k, active)
values
  ('Niski',
   true, 'haxe-haiku-4-5-bedrock', 'bedrock-eu',
   0.7, 4000, 10, null, 0.00025, 0.00125, true),

  ('Średni',
   true, 'haxe-sonnet-4-6-bedrock', 'bedrock-eu',
   0.7, 4000, 5, null, 0.003, 0.015, true),

  ('Wysoki',
   true, 'haxe-opus-4-5-bedrock', 'bedrock-eu',
   0.5, 8000, 1, null, 0.015, 0.075, true),

  ('Krytycznie ważne',
   true, 'haxe-opus-4-5-bedrock', 'bedrock-eu',
   0.2, 16000, 1,
   'This task is CRITICALLY important to the company. Apply maximum effort: reason step by step, consider edge cases and failure modes, verify your reasoning before answering, and prioritise precision and correctness over brevity. Do not rush. Respond in the language of the task.',
   0.015, 0.075, true),

  ('__default__',
   true, 'haxe-sonnet-4-6-bedrock', 'bedrock-eu',
   0.7, 4000, 5, null, 0.003, 0.015, true);

-- 5. Add 'n/d - zadanie nie jest dla AI' rows (was missing from 002 seed).
insert into model_routing
  (impact, personal_data, litellm_model, provider, temperature, max_tokens, priority,
   price_in_usd_per_1k, price_out_usd_per_1k, active)
values
  ('n/d - zadanie nie jest dla AI',
   false, 'haxe-sonnet-4-6-direct', 'anthropic-direct',
   0.7, 4000, 5, 0.003, 0.015, true),

  ('n/d - zadanie nie jest dla AI',
   true, 'haxe-sonnet-4-6-bedrock', 'bedrock-eu',
   0.7, 4000, 5, 0.003, 0.015, true)
on conflict (impact, personal_data) do nothing;

comment on table model_routing is
  'Composite (impact, personal_data) -> model-call config + USD token prices. '
  'personal_data=false -> Anthropic direct (default); '
  'personal_data=true -> Bedrock EU (GDPR). ADR-013/023/024/030.';
