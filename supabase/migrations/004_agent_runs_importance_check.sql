-- 004_agent_runs_importance_check.sql
-- Align agent_runs.importance CHECK with the live impact taxonomy.
--
-- The original 001 schema constrained importance to the old English 3-level set
-- ('Low','Medium','High'). The live ClickUp field "[AI] Wpływ zadania na wynik firmy"
-- uses five Polish levels (+ an n/d opt-out), and ADR-024 renamed importance->impact in
-- the pipeline while the agent_runs *log* column stays 'importance'. Result: any run on a
-- real tier (e.g. 'Niski') failed the insert with agent_runs_importance_check — so the
-- highest-value tasks silently lost their run/cost log (caught live 2026-06-08 via fault
-- injection). This migration replaces the check with the current taxonomy. Append-only
-- (CLAUDE.md): we add a new migration rather than editing 001.
--
-- Safe to apply: existing agent_runs rows have importance = null (no real-tier run ever
-- persisted), so the new constraint is satisfied on add.

alter table agent_runs drop constraint if exists agent_runs_importance_check;

alter table agent_runs add constraint agent_runs_importance_check
  check (
    importance is null
    or importance = any (array[
      'Niski',
      'Średni',
      'Wysoki',
      'Krytycznie ważne',
      'n/d - zadanie nie jest dla AI'
    ])
  );
