-- 022_agent_runs_erasure_ready.sql
-- ADR-041: data-subject erasure schema readiness.
-- Makes agent_runs the erasure hub at ZERO behavioral risk: nothing reads or writes these
-- columns yet. subject_key activates with the email channel; clickup_comment_id is recorded
-- per run by post-reply's Record Artifact node (also added this block); drive_file_id is reserved.
-- Append-only (CLAUDE.md). Applied 2026-06-11 to haxe-agent-prod.

alter table agent_runs
  add column if not exists subject_key        text,
  add column if not exists clickup_comment_id text,
  add column if not exists drive_file_id      text;

create index if not exists idx_runs_subject_key
  on agent_runs (subject_key) where subject_key is not null;

comment on column agent_runs.subject_key is
  'ADR-041: channel-natural counterparty id from envelope metadata, never content. Nullable; populated only by PD-capable channels (email) once wired. Erasure hub key.';
comment on column agent_runs.clickup_comment_id is
  'ADR-041: id of the ClickUp comment this run posted (post-reply). For erasure via CU API.';
comment on column agent_runs.drive_file_id is
  'ADR-041: reserved for a Drive file id; no workflow writes it yet.';
