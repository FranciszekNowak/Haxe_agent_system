-- 009_triggered_by_search_step.sql
-- Add 'search_step' to agent_runs.triggered_by CHECK constraint so that
-- Search (v1) sub-workflow can log its Haiku sub-calls as agent_runs rows
-- without violating the constraint (Inc 4, ADR-031).
--
-- Append-only migration (CLAUDE.md). Apply before deploying Search (v1) workflow.

alter table agent_runs drop constraint agent_runs_triggered_by_check;

alter table agent_runs add constraint agent_runs_triggered_by_check
  check (triggered_by = any (array[
    'webhook_status_change',
    'webhook_field_change',
    'due_date_daily',
    'gmail_incoming',
    'gmail_sent_analysis',
    'weekly_proposer',
    'per_task_proposer',
    'explicit_mention',
    'explicit_command',
    'conversation_reply',
    'reset_restart',
    'search_step'
  ]));
