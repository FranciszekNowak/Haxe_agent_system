-- 035_agent_routing.sql
-- ADR-053 Block 2: routing + registry for the Managed Agents lane.
--
-- Mirrors model_routing (migration 002) but for the managed lane: impact label ->
-- the Anthropic Managed Agent that serves it. model_routing is left UNTOUCHED and
-- continues to serve the bare LiteLLM lane (the dormant failover, ADR-053 §9). The
-- two lanes are selected by config.agent_lane in Block 8; this table only describes
-- the managed side.
--
-- Per ADR-053 §3 / the master plan, four tier agents share system/tools/skills and
-- differ only in model.id; impact selects the tier:
--   Niski            -> Haiku   (claude-haiku-4-5)
--   Średni           -> Sonnet  (claude-sonnet-4-6)
--   Wysoki           -> Opus    (claude-opus-4-8)
--   Krytycznie ważne -> Fable   (claude-fable-5)
--   __default__      -> Sonnet  (fallback for an unset/unknown impact; mis-set
--                                impact degrades to a model tier, never a missing
--                                capability — tools are universal on every tier)
--
-- The agent_id / agent_version / rules_sha256 / conventions_version / synced_at
-- columns are provenance written by `Sync Agent Definitions (v1)` after it
-- creates/version-updates each agent against api.anthropic.com. They start NULL and
-- are filled on first sync. Agents are created once and then VERSION-UPDATED
-- (POST /v1/agents/{id}); Anthropic has no delete (archive is permanent) — Block 0.
--
-- Idempotency contract used by the sync workflow:
--   * agent_id IS NULL                         -> CREATE the agent
--   * rules_sha256 <> current OR conv <> cur   -> UPDATE (new version)
--   * else                                     -> SKIP (avoid version inflation)
-- where "current" = SHA256(CU global-rules doc q7wz-44812) + the static-conventions
-- version baked into the system. The freshness dead-man's-switch
-- (`Agent Rules Freshness Check (v1)`) independently re-derives the CU hash and
-- compares it to what each LIVE agent carries (a provenance marker in its system),
-- so a stale or out-of-band-changed agent cannot serve old rules silently.
--
-- Two impact rows (Średni and __default__) point at the same Sonnet agent. The sync
-- reads DISTINCT agents (one per model_id) and writes the result back to EVERY row
-- sharing that model_id, so both Sonnet rows stay consistent.
--
-- Append-only (CLAUDE.md). RLS: this table holds no PII and is read by the pipeline's
-- Postgres role; consistent with model_routing (002), no RLS policy is added here.

create table if not exists agent_routing (
  impact               text primary key,           -- '[AI] Wpływ zadania na wynik firmy' label, or '__default__'
  tier_label           text not null,              -- human tier name: 'Haiku' | 'Sonnet' | 'Opus' | 'Fable'
  model_id             text not null,              -- bare model string sent on POST /v1/agents (Block 0: create takes a string)
  agent_name           text not null,              -- the agent's name in the Anthropic org (stable, human-recognisable)
  agent_id             text,                        -- 'agent_…' set by Sync Agent Definitions (v1) on first create
  agent_version        integer,                     -- last synced integer version (starts at 1, bumps per update)
  rules_sha256         text,                        -- SHA256(hex) of the CU global-rules markdown baked at last sync
  conventions_version  integer,                     -- static-conventions template version baked at last sync
  synced_at            timestamptz,                 -- when this row was last successfully synced to Anthropic
  active               boolean not null default true,
  updated_at           timestamptz not null default now()
);

comment on table agent_routing is
  'ADR-053: impact -> Managed Agent (agent_id) for the managed lane, plus sync provenance (rules hash, conventions version, version, synced_at). model_routing (002) is untouched and serves the bare failover lane. Edited as data; agent_id/version/sha filled by Sync Agent Definitions (v1).';

insert into agent_routing (impact, tier_label, model_id, agent_name) values
  ('Niski',            'Haiku',  'claude-haiku-4-5',  'Haxe Agent — Haiku (Niski) [ADR-053]'),
  ('Średni',           'Sonnet', 'claude-sonnet-4-6', 'Haxe Agent — Sonnet (Średni) [ADR-053]'),
  ('Wysoki',           'Opus',   'claude-opus-4-8',   'Haxe Agent — Opus (Wysoki) [ADR-053]'),
  ('Krytycznie ważne', 'Fable',  'claude-fable-5',    'Haxe Agent — Fable (Krytycznie ważne) [ADR-053]'),
  ('__default__',      'Sonnet', 'claude-sonnet-4-6', 'Haxe Agent — Sonnet (Średni) [ADR-053]')
on conflict (impact) do nothing;
