-- 049_session_waiter.sql
-- ADR-066 Block 4: the external async managed-agent session waiter.
--
-- Adds (1) the waiter_sessions table — the durable record of every session handed off from the
-- orchestrator (Block 5) to the always-on session-waiter service, and the store the "handed-off-but-
-- not-finished" freshness reconciliation check watches; (2) the session_waiter.* config knobs behind a
-- write-side validation trigger; (3) check_stuck_waiter_sessions(), a SECURITY DEFINER getter the n8n
-- freshness monitor calls. Append-only (CLAUDE.md).
--
-- WHY a table: a crashed/wedged waiter orphans running sessions SILENTLY (the biggest cost of the
-- external-service design, ADR-066 red-team). The reactive Error Handler cannot catch a session that
-- simply stops being driven, so the row's status + handed_off_at are the proactive dead-man's signal:
-- a row still handed_off/running past session_waiter.stuck_after_minutes means the waiter died or wedged
-- -> CRITICAL. The row also carries the finish-callback carry-state (Block 7) and is the idempotency key
-- for the finish half (no double-post on a duplicate callback).
--
-- The managed Anthropic key is DELIBERATELY NOT stored here (A6): the waiter is handed it at handoff and
-- re-derives it from public.get_anthropic_key() when the Block-6 loop needs it. Never persist a credential.

create table if not exists waiter_sessions (
  session_id            text primary key,                 -- Anthropic Sessions API session id
  clickup_task_id       text,
  triggering_comment_id text,
  caller_user_id        text,
  agent_id              text,
  model_id              text,
  surface               text,                              -- task | chat (ADR-068), for the finish-callback path
  surface_ref           text,
  impact                text,
  status                text not null default 'handed_off'
                          check (status in ('handed_off','running','delivered','finished','failed','reconciled')),
  outcome               text,                              -- Build Final Output vocab: delivered|done|deadline|terminated|max_rounds|poll_error|...
  handed_off_at         timestamptz not null default now(),
  last_event_at         timestamptz,                       -- updated as the waiter sees session events (Block 6 liveness)
  finished_at           timestamptz,
  deadline_at           timestamptz,                       -- absolute budget; the waiter finishes non-delivery past it (Block 6)
  carry_state           jsonb,                             -- orchestrator carry-state for the finish callback (NO credential)
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

-- The freshness query and any status sweep hit (status, handed_off_at).
create index if not exists idx_waiter_sessions_status_handed_off
  on waiter_sessions (status, handed_off_at);

-- Keep updated_at honest on every write.
create or replace function set_waiter_sessions_updated_at()
returns trigger language plpgsql
set search_path = public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_waiter_sessions_updated_at on waiter_sessions;
create trigger trg_waiter_sessions_updated_at
  before update on waiter_sessions
  for each row execute function set_waiter_sessions_updated_at();

-- RLS: the pipeline connects with the direct Postgres role (bypasses RLS); enabling RLS with NO
-- policies denies the anon/authenticated PostgREST roles while the service (service_role) keeps working
-- (same pattern as migration 007). The SECURITY DEFINER getter below runs as owner, so the monitor is
-- unaffected.
alter table waiter_sessions enable row level security;

-- ---- session_waiter.* config knobs + write-side validation -------------------------------------
-- enabled            : Block 5 orchestrator-split flag. Seeded FALSE — the synchronous poll loop stays
--                      the live path until Block 8 verifies the waiter and flips it true.
-- stuck_after_minutes: freshness threshold. Must exceed the longest legit run (the waiter's absolute
--                      budget ~45 min, A2) so a healthy long task does not false-alarm; 50 min default.
-- absolute_budget_ms : the waiter's own per-session cap (Block 6 reads it; the orchestrator may override
--                      per-handoff). 2_700_000 ms = 45 min.
create or replace function validate_session_waiter_config()
returns trigger language plpgsql
set search_path = public
as $$
declare
  k text := new.key;
  v text := new.value;
  n bigint;
begin
  if k = 'session_waiter.enabled' then
    if v not in ('true','false') then
      raise exception 'config %: must be true or false (got %)', k, v;
    end if;
    return new;
  end if;
  if k in ('session_waiter.stuck_after_minutes','session_waiter.absolute_budget_ms') then
    if v !~ '^-?\d+$' then
      raise exception 'config %: must be an integer (got %)', k, v;
    end if;
    n := v::bigint;
    if k = 'session_waiter.stuck_after_minutes' and (n < 5 or n > 1440) then
      raise exception 'config %: must be between 5 and 1440 minutes (got %)', k, n;
    elsif k = 'session_waiter.absolute_budget_ms' and n < 60000 then
      raise exception 'config %: must be >= 60000 ms (got %)', k, n;
    end if;
    return new;
  end if;
  -- unknown session_waiter.* key: allow (forward-compat).
  return new;
end;
$$;

drop trigger if exists trg_validate_session_waiter_config on config;
create trigger trg_validate_session_waiter_config
  before insert or update on config
  for each row
  when (new.key like 'session_waiter.%')
  execute function validate_session_waiter_config();

insert into config (key, value) values
  ('session_waiter.enabled',             'false'),
  ('session_waiter.stuck_after_minutes', '50'),
  ('session_waiter.absolute_budget_ms',  '2700000')
  on conflict (key) do update set value = excluded.value;

-- ---- freshness getter for the n8n monitor ------------------------------------------------------
-- Returns ONE row {stuck_count, details} so the monitor's IF is trivial. A row is "stuck" when it is
-- still handed_off/running past session_waiter.stuck_after_minutes (single-sourced threshold). SECURITY
-- DEFINER so it runs regardless of the caller's RLS context; EXECUTE granted only to service_role (the
-- privileged backend role the pipeline's Postgres node connects as), revoked from anon/authenticated.
create or replace function public.check_stuck_waiter_sessions()
returns table(stuck_count bigint, details text)
language sql
security definer
set search_path = public
as $$
  with thr as (
    select coalesce(
      (select value from config where key = 'session_waiter.stuck_after_minutes'),
      '50'
    )::int as minutes
  ),
  stuck as (
    select w.session_id, w.clickup_task_id, w.status,
           round(extract(epoch from (now() - w.handed_off_at)) / 60.0)::int as minutes_stuck
    from waiter_sessions w, thr
    where w.status in ('handed_off','running')
      and w.handed_off_at < now() - make_interval(mins => thr.minutes)
    order by w.handed_off_at asc
  )
  select count(*)::bigint as stuck_count,
         string_agg(
           session_id || ' (task ' || coalesce(clickup_task_id, '?') || ', ' ||
           minutes_stuck || 'm, ' || status || ')',
           '; '
         ) as details
  from stuck;
$$;

revoke all on function public.check_stuck_waiter_sessions() from public;
revoke all on function public.check_stuck_waiter_sessions() from anon;
revoke all on function public.check_stuck_waiter_sessions() from authenticated;
grant execute on function public.check_stuck_waiter_sessions() to service_role;

comment on function public.check_stuck_waiter_sessions() is
  'ADR-066: returns {stuck_count, details} for waiter_sessions still handed_off/running past config.session_waiter.stuck_after_minutes. Drives the Session Waiter Freshness Monitor (handed-off-but-not-finished dead-man''s switch). SECURITY DEFINER; EXECUTE only service_role.';

comment on table waiter_sessions is
  'ADR-066: durable record of managed-agent sessions handed from the orchestrator to the session-waiter service. status + handed_off_at are the proactive dead-man''s signal; carry_state feeds the Block-7 finish callback; session_id is the finish-half idempotency key. No credential is stored here (A6).';
