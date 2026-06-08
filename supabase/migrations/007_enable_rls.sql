-- 007_enable_rls.sql
-- Enable Row-Level Security on all application tables. Supabase exposes every table over
-- the PostgREST HTTP API to the anon/authenticated roles (project API keys); with RLS off
-- those roles have unrestricted read/write (the "Unrestricted" warning). The pipeline does
-- NOT use that API — it connects with the direct Postgres role, which BYPASSES RLS — so
-- enabling RLS with NO policies denies all API access while the pipeline keeps working.
-- No FORCE (table owner / superuser still bypass). Append-only (CLAUDE.md).

alter table agent_runs                enable row level security;
alter table agent_run_evaluations     enable row level security;
alter table agent_proposals           enable row level security;
alter table agent_proposal_evaluations enable row level security;
alter table conversation_sessions     enable row level security;
alter table email_sends               enable row level security;
alter table schema_migrations         enable row level security;
alter table model_routing             enable row level security;
alter table fx_rates                  enable row level security;
