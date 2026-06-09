-- 012_multimodal_image_tiers.sql
-- Multimodal I/O support: model_routing extensions for image routing,
-- image_gen_params tier table, system config table, agent_runs CHECK extension.
-- ADR-036. Append-only. RLS on new tables matches migration 007 / ADR-028 pattern.
--
-- Adaptations vs. the build plan (.txt):
--   - Column is `litellm_model`, not `model` (live schema)
--   - eu_only DEFAULT false + UPDATE (not DEFAULT true), to correctly reflect
--     existing personal_data=false rows (Anthropic direct = not eu_only)
--   - Unique index is PARTIAL (WHERE modality != 'text') — a full unique index on
--     (impact, modality) would fail: existing rows have two personal_data variants
--     per impact, both landing on modality='text' after the column is added
--   - Image seed rows use English impact keys ('low'/'medium'/'high'), which are
--     intentionally distinct from the Polish text-routing keys — no PK collision
--   - config table did not exist; CREATE TABLE added
--   - agent_runs CHECK: preserves all 12 existing triggered_by values, adds image_gen

-- ── 1. Extend model_routing ───────────────────────────────────────────────────

alter table model_routing
  add column modality             text        not null default 'text',
  add column eu_only              boolean     not null default false,
  add column fallback_price_per_unit numeric(10,6);

-- Backfill eu_only for existing text rows:
--   personal_data=true  → Bedrock EU  → eu_only=true
--   personal_data=false → Anthropic direct → eu_only=false (already the default)
update model_routing
  set eu_only = true
  where personal_data = true;

-- Partial unique index: one image model per tier.
-- Text rows are excluded — multiple personal_data variants share the same
-- (impact, 'text') pair and must stay separately addressable.
create unique index model_routing_impact_modality_key
  on model_routing (impact, modality)
  where modality != 'text';

-- ── 2. Image generation params per impact tier ────────────────────────────────
-- Keyed by English impact ('low'/'medium'/'high') matching the image seed rows
-- and the image-resolver workflow. These are separate from the Polish keys used
-- for text routing — both sets live in the same table, distinguished by modality.

create table image_gen_params (
  impact      text primary key,
  max_images  int  not null,
  resolution  text not null
);

insert into image_gen_params values
  ('low',    2, 'standard'),
  ('medium', 4, 'high'),
  ('high',   8, 'max');

alter table image_gen_params enable row level security;

-- ── 3. System config table ────────────────────────────────────────────────────

create table config (
  key    text primary key,
  value  text not null
);

insert into config (key, value) values
  ('image_host',    'comment_native'),
  ('tmp_root',      '/tmp/agent-runs'),
  ('tmp_ttl_hours', '24');

alter table config enable row level security;

-- ── 4. agent_runs: add image_gen to triggered_by CHECK ───────────────────────

alter table agent_runs
  drop constraint if exists agent_runs_triggered_by_check;

alter table agent_runs
  add constraint agent_runs_triggered_by_check
  check (triggered_by in (
    'webhook_status_change', 'webhook_field_change',
    'due_date_daily', 'gmail_incoming', 'gmail_sent_analysis',
    'weekly_proposer', 'per_task_proposer',
    'explicit_mention', 'explicit_command',
    'conversation_reply', 'reset_restart',
    'search_step', 'image_gen'
  ));

-- ── 5. Seed image models (one per tier) ──────────────────────────────────────
-- Verify these model IDs against LiteLLM /v1/models at build time and replace
-- with whatever is reachable. fallback_price_per_unit stays NULL when LiteLLM
-- returns a cost header; set it only for models whose header LiteLLM omits.
-- personal_data=false: image payloads carry no personal data (ADR-036 / spec 0.1).
-- temperature/max_tokens are irrelevant for image calls; left at column defaults.

insert into model_routing
  (impact, litellm_model, provider, personal_data, modality, eu_only, fallback_price_per_unit, active)
values
  ('low',    'stability/stable-diffusion-3-5', 'stability', false, 'image', false, null, true),
  ('medium', 'vertex_ai/imagegeneration@006',  'vertex_ai', false, 'image', false, null, true),
  ('high',   'openai/dall-e-3',                'openai',    false, 'image', false, null, true);
