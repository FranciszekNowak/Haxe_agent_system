-- 047_spend_limits.sql
-- Daily spend limits + pre-execution spend gate (ADR-064).
--
-- WHAT THIS DOES
--   1. Renames user_clickup_credentials -> user_data_and_config. The table stops being
--      credentials-only; it now also carries per-user config (the daily spend cap). To keep
--      the hot path (Execute Agent Session's Resolve Agent SELECT) and onboarding working
--      across the deploy, this migration uses the expand/contract pattern: it renames the
--      table AND leaves a temporary compatibility VIEW under the old name so the still-live
--      workflows keep resolving. Workflows are cut over to the new name in the same block;
--      migration 048 then drops the view (contract step). The view supports the hot-path
--      SELECT; it deliberately does not need to support the onboarding ON CONFLICT insert
--      (onboarding is a rare, deliberate operation, never run during this maintenance window).
--   2. Adds user_data_and_config.daily_spend_limit_pln (per-user daily cap in PLN, default 40).
--   3. Seeds the spend.* config keys (company cap, per-user default, warn thresholds, kill-switch).
--   4. Creates get_spend_status(p_user_id) -- the single source of the spend math: per-user and
--      company SUM(cost_pln) over today's Warsaw calendar day, the limits, ratios, and the
--      block/warn flags. Both consumers (the pre-execution gate and the end-of-message warning)
--      call this; the rule lives in exactly one place.
--   5. Recreates get_clickup_onboarding_state() against the new table name (Postgres does NOT
--      rewrite function bodies on table rename, so the old body would break).
--
-- DAY BOUNDARY: calendar day in Europe/Warsaw (spend resets at 00:00 Warsaw), per ADR-064.
-- CAP HARDNESS: soft -- block when ALREADY-INCURRED spend >= limit; the in-flight run's cost is
--   unknown pre-execution, so one run may overshoot by its own cost (ADR-064). Append-only (CLAUDE.md).

-- 1. Rename (PK, indexes, RLS move with the table automatically).
alter table user_clickup_credentials rename to user_data_and_config;

-- 2. Per-user daily spend cap (PLN). Existing rows inherit the 40 default.
alter table user_data_and_config
  add column daily_spend_limit_pln numeric not null default 40;

comment on table user_data_and_config is
  'ADR-054 / ADR-064: per-user data + config row keyed by clickup_user_id (= caller_user_id). '
  'Holds the per-user Anthropic Vault mapping for permission-scoped ClickUp retrieval (ADR-054) '
  'AND per-user config such as daily_spend_limit_pln (ADR-064 daily spend cap, PLN). Token values '
  'never live here (write-only in the Vault). RLS enabled, no policy: API roles denied, the '
  'pipeline''s Postgres role bypasses. Renamed from user_clickup_credentials in migration 047.';

comment on column user_data_and_config.daily_spend_limit_pln is
  'ADR-064: this user''s daily agent-spend cap in PLN. Default 40. Falls back to '
  'config spend.user_daily_limit_pln_default when null is ever introduced.';

-- 1b. Compatibility view (expand step) -- dropped in migration 048 after workflow cut-over.
create view user_clickup_credentials as
  select * from user_data_and_config;

comment on view user_clickup_credentials is
  'ADR-064 TRANSITIONAL: compatibility view over user_data_and_config so live workflows that '
  'still reference the old table name keep working during the rename cut-over. Dropped in '
  'migration 048 once execute-agent-session and clickup-onboarding are deployed against the new name.';

-- 3. Spend config (key/value text store). on conflict do nothing -> never clobber an operator override.
insert into config (key, value) values
  ('spend.enabled',                    'true'),   -- master kill-switch: false disables blocking AND warnings
  ('spend.company_daily_limit_pln',    '100'),    -- company-wide daily cap (PLN)
  ('spend.user_daily_limit_pln_default','40'),    -- fallback per-user cap when the row has none (PLN)
  ('spend.user_warn_pct',              '60'),     -- warn user at message-end past this % of their cap
  ('spend.company_warn_pct',           '70')      -- warn at message-end past this % of company cap
on conflict (key) do nothing;

-- 4. Single source of the spend math. Returns one row.
--    SECURITY DEFINER (owner postgres) so it reads agent_runs / user_data_and_config (RLS) regardless
--    of the connecting role; mirrors the house getter pattern (migrations 034/042/044). STABLE.
create or replace function public.get_spend_status(p_user_id text)
returns table (
  user_spend       numeric,
  user_limit       numeric,
  user_ratio       numeric,
  user_blocked     boolean,
  user_warn        boolean,
  company_spend    numeric,
  company_limit    numeric,
  company_ratio    numeric,
  company_blocked  boolean,
  company_warn     boolean,
  blocked          boolean,
  warn             boolean,
  block_reason     text,
  warn_reason      text,
  enabled          boolean
)
language sql
stable
security definer
set search_path = public
as $$
  with day as (
    select date_trunc('day', now() at time zone 'Europe/Warsaw') at time zone 'Europe/Warsaw' as start_ts
  ),
  cfg as (
    select
      coalesce((select value::numeric from config where key = 'spend.company_daily_limit_pln'), 100)         as company_limit,
      coalesce((select value::numeric from config where key = 'spend.user_daily_limit_pln_default'), 40)      as user_default,
      coalesce((select value::numeric from config where key = 'spend.user_warn_pct'), 60) / 100.0            as user_warn_pct,
      coalesce((select value::numeric from config where key = 'spend.company_warn_pct'), 70) / 100.0         as company_warn_pct,
      coalesce(lower((select value from config where key = 'spend.enabled')), 'true') <> 'false'             as enabled
  ),
  lims as (
    select
      coalesce(
        (select daily_spend_limit_pln from user_data_and_config where clickup_user_id = p_user_id),
        cfg.user_default
      ) as user_limit,
      cfg.company_limit, cfg.user_warn_pct, cfg.company_warn_pct, cfg.enabled
    from cfg
  ),
  spend as (
    select
      coalesce((select sum(cost_pln) from agent_runs, day
                 where caller_user_id = p_user_id and created_at >= day.start_ts), 0) as user_spend,
      coalesce((select sum(cost_pln) from agent_runs, day
                 where created_at >= day.start_ts), 0)                                as company_spend
  )
  select
    s.user_spend,
    l.user_limit,
    case when l.user_limit    > 0 then round(s.user_spend    / l.user_limit,    4) else 0 end as user_ratio,
    (l.enabled and s.user_spend    >= l.user_limit)                       as user_blocked,
    (l.enabled and s.user_spend    >= l.user_limit    * l.user_warn_pct)  as user_warn,
    s.company_spend,
    l.company_limit,
    case when l.company_limit > 0 then round(s.company_spend / l.company_limit, 4) else 0 end as company_ratio,
    (l.enabled and s.company_spend >= l.company_limit)                    as company_blocked,
    (l.enabled and s.company_spend >= l.company_limit * l.company_warn_pct) as company_warn,
    (l.enabled and (s.user_spend >= l.user_limit or s.company_spend >= l.company_limit)) as blocked,
    (l.enabled and (s.user_spend >= l.user_limit * l.user_warn_pct
                    or s.company_spend >= l.company_limit * l.company_warn_pct))          as warn,
    case
      when s.user_spend >= l.user_limit and s.company_spend >= l.company_limit then 'both'
      when s.user_spend >= l.user_limit                                        then 'user'
      when s.company_spend >= l.company_limit                                  then 'company'
      else 'none'
    end as block_reason,
    case
      when s.user_spend >= l.user_limit * l.user_warn_pct
       and s.company_spend >= l.company_limit * l.company_warn_pct then 'both'
      when s.user_spend >= l.user_limit * l.user_warn_pct          then 'user'
      when s.company_spend >= l.company_limit * l.company_warn_pct then 'company'
      else 'none'
    end as warn_reason,
    l.enabled
  from spend s, lims l;
$$;

revoke all on function public.get_spend_status(text) from public;
revoke all on function public.get_spend_status(text) from anon;
revoke all on function public.get_spend_status(text) from authenticated;
grant execute on function public.get_spend_status(text) to service_role;

comment on function public.get_spend_status(text) is
  'ADR-064: single source of the daily spend math for caller p_user_id. Returns one row with '
  'per-user and company spend (SUM(cost_pln) over today''s Europe/Warsaw calendar day), the '
  'limits (per-user from user_data_and_config.daily_spend_limit_pln, else config default; '
  'company from config), ratios, and block/warn flags. blocked = spend >= limit (soft cap). '
  'warn = spend >= warn_pct * limit. spend.enabled=false forces all flags false. Consumed by '
  'the pre-execution gate and the end-of-message warning. SECURITY DEFINER; EXECUTE only service_role.';

-- 5. Recreate the onboarding-state getter against the new table name (rename does not rewrite bodies).
create or replace function public.get_clickup_onboarding_state()
returns jsonb
language sql
security definer
set search_path = public, vault
as $$
  select jsonb_build_object(
    'mcp_ids',  coalesce(
                  (select jsonb_agg(clickup_user_id)
                     from public.user_data_and_config
                    where status = 'active'),
                  '[]'::jsonb),
    'rest_ids', coalesce(
                  (select jsonb_agg(replace(name, 'clickup_rest_token_', ''))
                     from vault.secrets
                    where name like 'clickup_rest_token_%'),
                  '[]'::jsonb)
  );
$$;

revoke all on function public.get_clickup_onboarding_state() from public;
revoke all on function public.get_clickup_onboarding_state() from anon;
revoke all on function public.get_clickup_onboarding_state() from authenticated;
grant execute on function public.get_clickup_onboarding_state() to service_role;

comment on function public.get_clickup_onboarding_state() is
  'ADR-054 Block 6 / ADR-064: returns {mcp_ids:[...], rest_ids:[...]} for the onboarding-coverage '
  'monitor. Reads user_data_and_config (renamed from user_clickup_credentials in migration 047). '
  'Returns ids only, never token values. SECURITY DEFINER; EXECUTE only service_role.';
