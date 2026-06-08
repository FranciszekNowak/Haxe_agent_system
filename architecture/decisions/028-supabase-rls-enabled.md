# ADR-028: Enable Row-Level Security on all Supabase tables

Date: 2026-06-08
Status: Accepted (applied — migration 007)

## Context
Supabase publishes every table over the PostgREST HTTP API to the `anon` / `authenticated`
roles (the project API keys). With RLS disabled, those roles can read/write the tables
freely — Supabase flags this as **"Unrestricted"**. The agent pipeline does **not** use
that API: it connects with the direct Postgres role (`postgres`, via the Session pooler),
which **bypasses RLS**.

## Decision
Enable RLS on **all** application tables (`agent_runs`, `agent_run_evaluations`,
`agent_proposals`, `agent_proposal_evaluations`, `conversation_sessions`, `email_sends`,
`schema_migrations`, `model_routing`, `fx_rates`) with **no policies** and **no FORCE**
(migration `007_enable_rls.sql`). No policies = deny-all to the PostgREST API roles; the
pipeline's `postgres` role bypasses RLS so it is unaffected.

## Consequences
- Closes the public-API exposure; the "Unrestricted" warning clears.
- **Verified on apply:** with RLS on, the pipeline's Postgres connection still reads
  `model_routing`/`fx_rates` and writes `agent_runs` (a smoke query returned the row counts).
- If a future component needs PostgREST/anon access to a table, it must get an explicit
  RLS **policy** (none exist today — server-side `postgres` access only).
- Rollback if ever needed: `alter table <t> disable row level security;`.

Related: ADR-026 (least-privilege / capability containment), ADR-024 (the tables), ADR-011
(stack/secrets).
