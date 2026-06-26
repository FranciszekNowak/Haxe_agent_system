-- 045_queue_config.sql
-- ADR-056 Block 1: seed the queue.* config knobs for the BullMQ application queue + thin consumer,
-- and add write-side validation (absolute sane bounds) via a queue.%-scoped BEFORE trigger.
--
-- Values are the Block-0-CORRECTED seeds (see architecture/Build plans/adr-056-.../block-0-findings.md),
-- NOT the raw ADR amendment table:
--   * env_concurrency_cap=10   (G1: software safety-rail. The real Managed-Agents limit is pooled /
--                               token-based, so there is no hard "5" to clamp to; 10 gives headroom
--                               above C=5 while still catching a fat-finger edit.)
--   * max_runtime_ms=900000    (G5: a single spine execution can run up to 15 min — 840s session
--                               deadline + orchestrator overhead; 872s observed.)
--   * spine_timeout_ms=1200000 (G5: 20 min — 5 min above the 15-min ceiling.)
--   * lock_duration_ms=1500000 (G5: 25 min — 10 min above the ceiling, 5 min above spine_timeout.)
-- queue.priority_high_impacts is intentionally NOT seeded — retired by ADR-056 amendment 2026-06-23b
-- (priority policy is contract-shape, a code constant, not an operational scalar).
--
-- TWO-LAYER validation (ADR-056 amendment "Validation in two layers"): this trigger enforces only
-- ABSOLUTE bounds (a fat-finger guard). The runtime-derived invariants (concurrency<=env_cap,
-- lock_duration>=max_runtime+MARGIN, spine_timeout<lock_duration-MARGIN) are enforced by the
-- consumer's fail-safe READ-side clamp, because they depend on DISCOVERED values, not constants.
-- DELIBERATELY, the trigger does NOT reject concurrency>env_cap — that row must reach the table so
-- the read-side clamp+WARN can be exercised (Block 1 DoD / Block 6 negative-config test).
--
-- The config table is (key text PK, value text NOT NULL); number/array knobs are stored as text JSON
-- and parsed by the consumer's fail-safe reader. Append-only migration (CLAUDE.md).

create or replace function validate_queue_config()
returns trigger
language plpgsql
as $$
declare
  k text := new.key;
  v text := new.value;
  n  bigint;
  j  jsonb;
  e  jsonb;
begin
  -- boolean knob
  if k = 'queue.enabled' then
    if v not in ('true','false') then
      raise exception 'config %: must be true or false (got %)', k, v;
    end if;
    return new;
  end if;

  -- JSON array knob (backoff schedule)
  if k = 'queue.backoff_ms' then
    begin
      j := v::jsonb;
    exception when others then
      raise exception 'config %: must be a JSON array (got %)', k, v;
    end;
    if jsonb_typeof(j) <> 'array' then
      raise exception 'config %: must be a JSON array (got %)', k, v;
    end if;
    for e in select * from jsonb_array_elements(j) loop
      if jsonb_typeof(e) <> 'number' or (e::text)::numeric < 0 then
        raise exception 'config %: backoff entries must be non-negative numbers (got %)', k, e;
      end if;
    end loop;
    return new;
  end if;

  -- integer knobs
  if k in ('queue.concurrency','queue.env_concurrency_cap','queue.max_runtime_ms',
           'queue.spine_timeout_ms','queue.lock_duration_ms','queue.retry_attempts',
           'queue.rate_limit_per_min','queue.dedup_window_h','queue.alert_depth_high',
           'queue.alert_depth_any','queue.alert_failed','queue.heartbeat_stale_s') then
    if v !~ '^-?\d+$' then
      raise exception 'config %: must be an integer (got %)', k, v;
    end if;
    n := v::bigint;
    if k in ('queue.concurrency','queue.env_concurrency_cap') and (n < 1 or n > 1000) then
      raise exception 'config %: must be between 1 and 1000 (got %)', k, n;
    elsif k in ('queue.max_runtime_ms','queue.spine_timeout_ms','queue.lock_duration_ms') and n < 60000 then
      raise exception 'config %: must be >= 60000 ms (got %)', k, n;
    elsif k = 'queue.retry_attempts' and (n < 1 or n > 10) then
      raise exception 'config %: must be between 1 and 10 (got %)', k, n;
    elsif k = 'queue.rate_limit_per_min' and (n < 1 or n > 60) then
      raise exception 'config %: must be between 1 and 60 (got %)', k, n;
    elsif k = 'queue.dedup_window_h' and (n < 1 or n > 168) then
      raise exception 'config %: must be between 1 and 168 (got %)', k, n;
    elsif k in ('queue.alert_depth_high','queue.alert_depth_any') and n < 1 then
      raise exception 'config %: must be >= 1 (got %)', k, n;
    elsif k = 'queue.alert_failed' and n < 0 then
      raise exception 'config %: must be >= 0 (got %)', k, n;
    elsif k = 'queue.heartbeat_stale_s' and n < 30 then
      raise exception 'config %: must be >= 30 (got %)', k, n;
    end if;
    return new;
  end if;

  -- unknown queue.* key: allow (forward-compat; the consumer's reader defaults/clamps unknown keys)
  return new;
end;
$$;

drop trigger if exists trg_validate_queue_config on config;
create trigger trg_validate_queue_config
  before insert or update on config
  for each row
  when (new.key like 'queue.%')
  execute function validate_queue_config();

insert into config (key, value) values
  ('queue.enabled',             'true'),
  ('queue.concurrency',         '5'),
  ('queue.env_concurrency_cap', '10'),
  ('queue.max_runtime_ms',      '900000'),
  ('queue.spine_timeout_ms',    '1200000'),
  ('queue.lock_duration_ms',    '1500000'),
  ('queue.retry_attempts',      '5'),
  ('queue.backoff_ms',          '[60000,300000,900000]'),
  ('queue.rate_limit_per_min',  '60'),
  ('queue.dedup_window_h',      '24'),
  ('queue.alert_depth_high',    '20'),
  ('queue.alert_depth_any',     '100'),
  ('queue.alert_failed',        '0'),
  ('queue.heartbeat_stale_s',   '120')
  on conflict (key) do update set value = excluded.value;
