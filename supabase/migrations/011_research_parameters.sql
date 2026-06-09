-- 011_research_parameters.sql
-- Per-impact effort knobs for the agentic web-search loop (Model Turn v1).
-- Kept SEPARATE from model_routing: model_routing picks the chat model by
-- (impact, personal_data); research effort scales with impact only (not GDPR routing).
-- Append-only. RLS enabled with NO policies — the pipeline connects via the direct
-- Postgres role and bypasses RLS (same pattern as migration 007 / ADR-028). See ADR-035.

create table if not exists research_parameters (
  impact               text primary key,
  max_research_rounds  integer not null default 3,   -- recursion depth cap for Model Turn
  tavily_max_results   integer not null default 5,   -- Tavily "effort" knob (results per search)
  active               boolean not null default true,
  updated_at           timestamptz not null default now()
);

comment on table research_parameters is
  'Per-impact effort knobs for the web-search agentic loop (Model Turn v1): max recursion rounds + Tavily max_results. Keyed by impact only — effort scales with importance, not GDPR routing. ADR-035.';

insert into research_parameters (impact, max_research_rounds, tavily_max_results) values
  ('Niski',                          2, 5),
  ('Średni',                         3, 5),
  ('Wysoki',                         5, 8),
  ('Krytycznie ważne',               8, 10),
  ('n/d - zadanie nie jest dla AI',  1, 3),
  ('__default__',                    3, 5)
on conflict (impact) do nothing;

alter table research_parameters enable row level security;
