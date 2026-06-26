-- 046_queue_refresh_and_heartbeat.sql
-- ADR-056 Block 5 revision (operator request 2026-06-26): the config-refresh poll cadence is now a
-- config knob and defaults to once/day (a 45s Supabase poll bought nothing — config edits are rare),
-- and the heartbeat operates on a ~5-min scale to cut the host watchdog's per-tick docker-exec cost.
--
--   * NEW  queue.config_refresh_s = 86400  (consumer config-refresh poll interval, seconds; default 1d).
--          The consumer's fail-safe reader floors it at 60s; this trigger bounds it 60..604800 (1 week).
--   * EDIT queue.heartbeat_stale_s 120 -> 300  (TTL of haxeq:consumer:heartbeat; consumer writes every
--          ~stale_s/3 = 100s; the host systemd timer also moves to a 5-min cadence — see
--          infrastructure/systemd/consumer-heartbeat.timer). Detection of a dead consumer ≈ 5-10 min,
--          acceptable for a durable queue (jobs just wait until restart).
--
-- Append-only (CLAUDE.md): this re-defines validate_queue_config() (adding config_refresh_s to the
-- integer-validated set) without modifying migration 045. The two-tier validation philosophy is kept —
-- the trigger enforces ABSOLUTE bounds (fat-finger guard); the consumer's read-side clamp is the
-- load-bearing safety layer (ADR-056 amendment "Validation in two layers").

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
           'queue.alert_depth_any','queue.alert_failed','queue.heartbeat_stale_s',
           'queue.config_refresh_s') then
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
    elsif k = 'queue.config_refresh_s' and (n < 60 or n > 604800) then
      raise exception 'config %: must be between 60 and 604800 (got %)', k, n;
    end if;
    return new;
  end if;

  -- unknown queue.* key: allow (forward-compat; the consumer's reader defaults/clamps unknown keys)
  return new;
end;
$$;

-- the trigger from migration 045 already binds this function on config (queue.% rows); no re-create needed.

update config set value = '300' where key = 'queue.heartbeat_stale_s';

insert into config (key, value) values
  ('queue.config_refresh_s', '86400')
  on conflict (key) do update set value = excluded.value;
