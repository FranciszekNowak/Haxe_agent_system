-- 002_model_routing.sql
-- Data-driven model routing (ADR-013 seam #3 "routing as data", ADR-023 mapping,
-- ADR-024 LiteLLM gateway). The generic pipeline looks up the routing config by
-- impact label and calls the resulting LiteLLM alias. Editing routing = editing
-- this table, not n8n. Append-only migration (CLAUDE.md).
--
-- NOTE: 001_initial_schema.sql is applied to the live DB but was never committed;
-- it must be back-filled into this directory from the live schema (see ADR-024 /
-- the rollout plan). This migration assumes the base schema already exists.
--
-- Cost model (ADR-024): token counts come from LiteLLM (exact); prices here are in
-- USD (Bedrock is priced in USD); cost_pln = usd_cost x the daily NBP USD/PLN rate
-- from the fx_rates table (003). USD prices change rarely (set by AWS) so they live
-- here as operator-maintained config; only the FX multiplier is auto-imported daily.

create table if not exists model_routing (
  impact                text primary key,            -- '[AI] Wpływ zadania na wynik firmy' label, or '__default__'
  litellm_model         text not null,               -- LiteLLM alias n8n calls (e.g. 'haxe-opus'); see litellm-config.yaml
  provider              text not null default 'bedrock-eu',
  temperature           numeric not null default 0.7,
  max_tokens            integer not null default 4000,
  priority              integer not null default 5,  -- queue priority (future use; 1=high,5=normal,10=low)
  nudge                 text,                         -- optional prompt prefix (prepended by n8n before the task prompt)
  price_in_usd_per_1k   numeric not null default 0,  -- input-token price, USD per 1k tokens (VERIFY vs AWS Bedrock EU)
  price_out_usd_per_1k  numeric not null default 0,  -- output-token price, USD per 1k tokens (VERIFY vs AWS Bedrock EU)
  personal_data         boolean,                     -- reserved: sensitivity axis (ADR-013); null = applies to any
  active                boolean not null default true,
  updated_at            timestamptz not null default now()
);

comment on table model_routing is 'impact (and later sensitivity) -> model-call config + USD token prices. ADR-013/023/024. Edited as data, not code.';

-- Seed = the ADR-023 mapping. Opus tiers use 4.5 until 4.6/4.7/4.8 model access is
-- granted to the account (then change the haxe-opus alias in litellm-config.yaml).
-- USD prices are best-effort list prices (per 1k tokens) and MUST be verified against
-- current AWS Bedrock eu-central-1 pricing before cost_pln is trusted.
insert into model_routing
  (impact, litellm_model, temperature, max_tokens, priority, nudge, price_in_usd_per_1k, price_out_usd_per_1k)
values
  ('Niski',            'haxe-haiku',  0.7, 4000,  10, null, 0.001, 0.005),
  ('Średni',           'haxe-sonnet', 0.7, 4000,  5,  null, 0.003, 0.015),
  ('Wysoki',           'haxe-opus',   0.5, 8000,  1,  null, 0.005, 0.025),
  ('Krytycznie ważne', 'haxe-opus',   0.2, 16000, 1,
    'This task is CRITICALLY important to the company. Apply maximum effort: reason step by step, consider edge cases and failure modes, verify your reasoning before answering, and prioritise precision and correctness over brevity. Do not rush. Respond in the language of the task.',
    0.005, 0.025),
  ('__default__',      'haxe-sonnet', 0.7, 4000,  5,  null, 0.003, 0.015)
on conflict (impact) do nothing;
