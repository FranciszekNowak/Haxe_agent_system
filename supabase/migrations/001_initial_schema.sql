-- 001_initial_schema.sql
-- Initial Supabase schema (the seven core tables). Back-filled 2026-06-08 from live
-- introspection (information_schema + pg_constraint + pg_indexes) to close the repo gap
-- noted in ADR-024 (applied to the DB long ago but never committed). It reflects the
-- INITIAL state: model_routing/fx_rates are added by 002/003, and the agent_runs
-- importance CHECK here is the ORIGINAL Low/Medium/High set (migration 004 later realigns
-- it to the live Polish taxonomy). Reconstructed faithfully for columns, defaults,
-- PK/FK/unique/check constraints, and secondary indexes; verify against a pg_dump
-- --schema-only if byte-exact reproduction is ever required. Append-only (CLAUDE.md).

-- ---------------------------------------------------------------------------
-- agent_runs — one row per agent execution (cost/observability + queue tracking)
-- ---------------------------------------------------------------------------
create table if not exists agent_runs (
  id              bigserial primary key,
  created_at      timestamptz default now(),
  clickup_task_id text,
  caller_user_id  text,
  process_type    text,
  triggered_by    text not null check (triggered_by = any (array[
                    'webhook_status_change','webhook_field_change','due_date_daily',
                    'gmail_incoming','gmail_sent_analysis','weekly_proposer',
                    'per_task_proposer','explicit_mention','explicit_command',
                    'conversation_reply','reset_restart'])),
  invocation_type text check (invocation_type = any (array[
                    'autonomous','explicit','conversation_reply'])),
  queue_priority  integer,
  queue_wait_ms   integer,
  retry_attempt   integer default 0,
  model_used      text,
  -- ORIGINAL taxonomy; superseded by migration 004 (Polish 5-level set).
  importance      text check (importance = any (array['Low','Medium','High'])),
  duration_ms     integer,
  cost_pln        numeric,
  input_tokens    integer,
  output_tokens   integer,
  status          text check (status = any (array[
                    'completed','in_progress','failed','error'])),
  error_details   text
);

create index idx_runs_caller          on agent_runs (caller_user_id, created_at desc);
create index idx_runs_invocation_type on agent_runs (invocation_type, created_at desc);
create index idx_runs_process_type    on agent_runs (process_type, created_at desc);
create index idx_runs_task            on agent_runs (clickup_task_id, created_at desc);
create index idx_runs_triggered_by    on agent_runs (triggered_by, created_at desc);

-- ---------------------------------------------------------------------------
-- agent_run_evaluations — append-only threaded feedback on a run
-- ---------------------------------------------------------------------------
create table if not exists agent_run_evaluations (
  id                bigserial primary key,
  agent_run_id      bigint not null references agent_runs(id) on delete cascade,
  created_at        timestamptz default now(),
  commenter_user_id text not null,
  rating            boolean,
  comment_text      text,
  check (rating is not null or comment_text is not null)
);

create index idx_run_evals_run  on agent_run_evaluations (agent_run_id, created_at);
create index idx_run_evals_user on agent_run_evaluations (commenter_user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- agent_proposals — org/process improvement proposals (self-referencing lineage)
-- ---------------------------------------------------------------------------
create table if not exists agent_proposals (
  id                    bigserial primary key,
  created_at            timestamptz default now(),
  proposer_type         text check (proposer_type = any (array['weekly_org','per_task'])),
  proposal_tier         text not null default 'artifact'
                          check (proposal_tier = any (array['artifact','meta'])),
  source_agent_run_id   bigint references agent_runs(id),
  source_proposal_id    bigint references agent_proposals(id),
  change_summary        text not null,
  change_description    text,
  change_category       text,
  clickup_task_id       text,
  initial_draft_reference text,
  final_output_reference  text,
  artifact_urls         text[],
  proposal_summary      text not null,
  proposal_details      text,
  affected_process_type text,
  proposed_change_type  text check (proposed_change_type = any (array[
                          'prompt','template','process','config','rule']))
);

create index idx_proposals_category        on agent_proposals (change_category, created_at desc);
create index idx_proposals_process         on agent_proposals (affected_process_type, created_at desc);
create index idx_proposals_source_proposal on agent_proposals (source_proposal_id);
create index idx_proposals_source_run      on agent_proposals (source_agent_run_id);
create index idx_proposals_tier            on agent_proposals (proposal_tier, created_at desc);
create index idx_proposals_type            on agent_proposals (proposed_change_type, created_at desc);

-- ---------------------------------------------------------------------------
-- agent_proposal_evaluations — append-only threaded feedback on a proposal
-- ---------------------------------------------------------------------------
create table if not exists agent_proposal_evaluations (
  id                bigserial primary key,
  agent_proposal_id bigint not null references agent_proposals(id) on delete cascade,
  created_at        timestamptz default now(),
  commenter_user_id text not null,
  rating            boolean,
  comment_text      text,
  check (rating is not null or comment_text is not null)
);

create index idx_prop_evals_proposal on agent_proposal_evaluations (agent_proposal_id, created_at);
create index idx_prop_evals_user     on agent_proposal_evaluations (commenter_user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- conversation_sessions — mutable multi-turn working state (expired, not deleted)
-- ---------------------------------------------------------------------------
create table if not exists conversation_sessions (
  id              bigserial primary key,
  created_at      timestamptz default now(),
  last_turn_at    timestamptz default now(),
  clickup_task_id text not null,
  comment_root_id text not null,
  caller_user_id  text not null,
  base_context    jsonb,
  approved_outputs jsonb[],
  turn_count      integer default 0,
  is_active       boolean default true,
  expired_at      timestamptz,
  expiry_reason   text
);

-- one active session per (task, comment thread, caller)
create unique index idx_sessions_active on conversation_sessions (clickup_task_id, comment_root_id, caller_user_id) where (is_active = true);
create index idx_sessions_last_turn on conversation_sessions (last_turn_at) where (is_active = true);

-- ---------------------------------------------------------------------------
-- email_sends — Gmail audit trail, linked to the originating run
-- ---------------------------------------------------------------------------
create table if not exists email_sends (
  id                    bigserial primary key,
  created_at            timestamptz default now(),
  gmail_message_id      text unique,
  gmail_thread_id       text,
  triggered_by_user_id  text,
  related_clickup_task_id text,
  to_addresses          text[],
  cc_addresses          text[],
  subject               text,
  body_preview          text,
  agent_run_id          bigint references agent_runs(id),
  was_human_edited      boolean,
  status                text check (status = any (array['draft_created','sent','discarded']))
);

create index idx_emails_task   on email_sends (related_clickup_task_id);
create index idx_emails_thread on email_sends (gmail_thread_id);
create index idx_emails_user   on email_sends (triggered_by_user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- schema_migrations — applied-migration ledger
-- ---------------------------------------------------------------------------
create table if not exists schema_migrations (
  version    text primary key,
  applied_at timestamptz default now()
);
