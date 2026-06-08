-- 005_agent_runs_rename_importance_to_impact.sql
-- Rename agent_runs.importance -> impact to match the pipeline field name (ADR-024 renamed
-- importance->impact everywhere except this log column; this removes the last mismatch).
-- The CHECK added in 004 (the 5-level Polish taxonomy) follows the column rename
-- automatically; we also rename the constraint for tidiness. Append-only (CLAUDE.md).

alter table agent_runs rename column importance to impact;
alter table agent_runs rename constraint agent_runs_importance_check to agent_runs_impact_check;
