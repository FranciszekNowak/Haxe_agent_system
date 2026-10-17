--
-- PostgreSQL database dump
--

\restrict AtCspjl3zGBiEOINv1Q32VD7VLfa83XYnCDXI5WNsQ03iIg0lDBCSxX4Sfln42H

-- Dumped from database version 17.6
-- Dumped by pg_dump version 17.11 (Debian 17.11-1.pgdg13+2)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA public;


--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA public IS 'standard public schema';


--
-- Name: check_stuck_waiter_sessions(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.check_stuck_waiter_sessions() RETURNS TABLE(stuck_count bigint, details text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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


--
-- Name: FUNCTION check_stuck_waiter_sessions(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.check_stuck_waiter_sessions() IS 'ADR-066: returns {stuck_count, details} for waiter_sessions still handed_off/running past config.session_waiter.stuck_after_minutes. Drives the Session Waiter Freshness Monitor. SECURITY DEFINER; EXECUTE only service_role.';


--
-- Name: get_anthropic_key(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_anthropic_key() RETURNS text
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'vault'
    AS $$
  select decrypted_secret from vault.decrypted_secrets where name = 'anthropic_api_key' limit 1;
$$;


--
-- Name: FUNCTION get_anthropic_key(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.get_anthropic_key() IS 'ADR-053: returns the decrypted anthropic_api_key Vault secret for the Managed Agents lane (direct api.anthropic.com calls). SECURITY DEFINER; EXECUTE granted only to service_role (revoked from anon/authenticated -> not a public PostgREST RPC).';


--
-- Name: get_clickup_oauth_app(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_clickup_oauth_app() RETURNS jsonb
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'vault'
    AS $$
  select jsonb_build_object(
    'client_id',     (select decrypted_secret from vault.decrypted_secrets where name = 'clickup_oauth_client_id'     limit 1),
    'client_secret', (select decrypted_secret from vault.decrypted_secrets where name = 'clickup_oauth_client_secret' limit 1)
  );
$$;


--
-- Name: FUNCTION get_clickup_oauth_app(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.get_clickup_oauth_app() IS 'ADR-054: returns {client_id, client_secret} of the ClickUp OAuth app from the Vault for the onboarding code->token exchange. SECURITY DEFINER; EXECUTE granted only to service_role (revoked from anon/authenticated -> not a public PostgREST RPC).';


--
-- Name: get_clickup_onboarding_state(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_clickup_onboarding_state() RETURNS jsonb
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'vault'
    AS $$
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


--
-- Name: FUNCTION get_clickup_onboarding_state(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.get_clickup_onboarding_state() IS 'ADR-054 Block 6 / ADR-064: returns {mcp_ids:[...], rest_ids:[...]} for the onboarding-coverage monitor. Reads user_data_and_config (renamed from user_clickup_credentials in migration 047). Returns ids only, never token values. SECURITY DEFINER; EXECUTE only service_role.';


--
-- Name: get_clickup_rest_token(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_clickup_rest_token(p_user_id text) RETURNS text
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'vault'
    AS $$
  select decrypted_secret from vault.decrypted_secrets where name = 'clickup_rest_token_' || p_user_id limit 1;
$$;


--
-- Name: FUNCTION get_clickup_rest_token(p_user_id text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.get_clickup_rest_token(p_user_id text) IS 'ADR-054 Block 4: returns the decrypted per-user ClickUp classic REST OAuth token from Supabase Vault for as-U REST extraction (GET /api/v2/task/{id} as the caller). SECURITY DEFINER; EXECUTE only service_role (not a PostgREST RPC). Null if the user has no stored REST token.';


--
-- Name: get_image_mcp_bearer(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_image_mcp_bearer() RETURNS text
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'vault'
    AS $$
  select decrypted_secret from vault.decrypted_secrets where name = 'image_mcp_bearer_token' limit 1;
$$;


--
-- Name: FUNCTION get_image_mcp_bearer(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.get_image_mcp_bearer() IS 'ADR-055: returns the decrypted image_mcp_bearer_token Vault secret (the image MCP endpoint''s service bearer). SECURITY DEFINER; EXECUTE granted only to service_role (revoked from anon/authenticated -> not a public PostgREST RPC). Mirrors get_anthropic_key() (034).';


--
-- Name: get_litellm_image_key(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_litellm_image_key() RETURNS text
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'vault'
    AS $$
  select decrypted_secret from vault.decrypted_secrets where name = 'litellm_image_key' limit 1;
$$;


--
-- Name: FUNCTION get_litellm_image_key(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.get_litellm_image_key() IS 'ADR-051: returns the decrypted litellm_image_key Vault secret for the parallel image batch (Generate Images Parallel v1). SECURITY DEFINER; EXECUTE granted only to service_role (revoked from anon/authenticated -> not a public PostgREST RPC).';


--
-- Name: get_spend_status(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_spend_status(p_user_id text) RETURNS TABLE(user_spend numeric, user_limit numeric, user_ratio numeric, user_blocked boolean, user_warn boolean, company_spend numeric, company_limit numeric, company_ratio numeric, company_blocked boolean, company_warn boolean, blocked boolean, warn boolean, block_reason text, warn_reason text, enabled boolean)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  with day as (
    select date_trunc('day', now() at time zone 'Europe/Warsaw') at time zone 'Europe/Warsaw' as start_ts
  ),
  cfg as (
    select
      coalesce((select value::numeric from config where key = 'spend.company_daily_limit_pln'), 100)          as company_limit,
      coalesce((select value::numeric from config where key = 'spend.user_daily_limit_pln_default'), 40)       as user_default,
      coalesce((select value::numeric from config where key = 'spend.user_warn_pct'), 60) / 100.0             as user_warn_pct,
      coalesce((select value::numeric from config where key = 'spend.company_warn_pct'), 70) / 100.0          as company_warn_pct,
      coalesce(lower((select value from config where key = 'spend.enabled')), 'true') <> 'false'              as enabled
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
    (l.enabled and s.user_spend    >= l.user_limit)                         as user_blocked,
    (l.enabled and s.user_spend    >= l.user_limit    * l.user_warn_pct)    as user_warn,
    s.company_spend,
    l.company_limit,
    case when l.company_limit > 0 then round(s.company_spend / l.company_limit, 4) else 0 end as company_ratio,
    (l.enabled and s.company_spend >= l.company_limit)                      as company_blocked,
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


--
-- Name: FUNCTION get_spend_status(p_user_id text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.get_spend_status(p_user_id text) IS 'ADR-064: single source of the daily spend math for caller p_user_id. Returns one row with per-user and company spend (SUM(cost_pln) over today''s Europe/Warsaw calendar day), the limits, ratios, and block/warn flags. blocked = spend >= limit (soft cap). warn = spend >= warn_pct * limit. spend.enabled=false forces all flags false. SECURITY DEFINER; EXECUTE only service_role.';


--
-- Name: prune_agent_input_file_map(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.prune_agent_input_file_map() RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_deleted integer;
begin
  delete from public.agent_input_file_map where created_at < now() - interval '24 hours';
  get diagnostics v_deleted = row_count;
  insert into public.agent_input_file_map_prune_runs(deleted_count, note)
  values (v_deleted,
    case when v_deleted = 0 then 'nothing to prune (no rows older than 24h)'
         else format('pruned %s row(s) older than 24h', v_deleted) end);
end;
$$;


--
-- Name: FUNCTION prune_agent_input_file_map(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.prune_agent_input_file_map() IS 'ADR-055 Block 5.2: delete agent_input_file_map rows older than 24h (signed URLs only need to outlive a session); logs each run to agent_input_file_map_prune_runs. Hourly pg_cron => real lifetime <=~25h.';


--
-- Name: purge_agent_output_images(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.purge_agent_output_images() RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'extensions', 'net', 'vault'
    AS $$
declare
  v_key        text;
  v_base       text     := 'https://hkeslnosxibeuesxndnz.supabase.co';
  v_bucket     text     := 'agent-output-images';
  v_max_age    interval := interval '24 hours';
  v_batch      integer  := 200;
  v_obj        record;
  v_req        bigint;
  v_ids        bigint[] := '{}';
  v_candidates integer  := 0;
  v_dispatched integer  := 0;
begin
  v_key := (select decrypted_secret from vault.decrypted_secrets
            where name = 'service_role_key' limit 1);

  if v_key is null then
    insert into public.storage_purge_runs(bucket, candidate_count, dispatched_count, note)
    values (v_bucket, null, 0,
      'SKIPPED: vault secret service_role_key missing - cannot call Storage API.');
    return;
  end if;

  for v_obj in
    select name from storage.objects
    where bucket_id = v_bucket
      and created_at < now() - v_max_age
    order by created_at
    limit v_batch
  loop
    v_candidates := v_candidates + 1;
    select net.http_delete(
      url     := v_base || '/storage/v1/object/' || v_bucket || '/' || v_obj.name,
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || v_key,
        'apikey',        v_key
      )
    ) into v_req;
    v_ids        := v_ids || v_req;
    v_dispatched := v_dispatched + 1;
  end loop;

  insert into public.storage_purge_runs(bucket, candidate_count, dispatched_count, request_ids, note)
  values (v_bucket, v_candidates, v_dispatched, v_ids,
    case when v_candidates = 0        then 'nothing to purge (no objects older than 24h)'
         when v_candidates >= v_batch then 'batch cap hit - backlog drains over subsequent hourly runs'
         else format('dispatched %s Storage DELETE(s); HTTP result is ASYNC - confirm via net._http_response', v_dispatched)
    end);
end;
$$;


--
-- Name: FUNCTION purge_agent_output_images(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.purge_agent_output_images() IS 'ADR-053/055 Block 6: delete >24h objects from the agent-output-images delivery-bytes carrier bucket via Storage REST (frees bytes, not just the row). Hourly pg_cron => real lifetime <=~25h. Reads the service_role key from Vault; logs each run to storage_purge_runs (shared with the zip purge, separated by the bucket column).';


--
-- Name: purge_zip_inner_images(boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.purge_zip_inner_images(p_force boolean DEFAULT false) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'extensions', 'net', 'vault'
    AS $$
declare
  v_key        text;
  v_base       text     := 'https://hkeslnosxibeuesxndnz.supabase.co';
  v_bucket     text     := 'zip-inner-images';
  v_max_age    interval := interval '12 hours';
  v_batch      integer  := 200;
  v_obj        record;
  v_req        bigint;
  v_ids        bigint[] := '{}';
  v_candidates integer  := 0;
  v_dispatched integer  := 0;
begin
  if not p_force
     and extract(hour from (now() at time zone 'Europe/Warsaw'))::int <> 5 then
    return;
  end if;

  v_key := (select decrypted_secret from vault.decrypted_secrets
            where name = 'service_role_key' limit 1);

  if v_key is null then
    insert into public.storage_purge_runs(bucket, candidate_count, dispatched_count, note)
    values (v_bucket, null, 0,
      'SKIPPED: vault secret service_role_key missing — cannot call Storage API. Watchdog will catch stale buildup.');
    return;
  end if;

  for v_obj in
    select name from storage.objects
    where bucket_id = v_bucket
      and created_at < now() - v_max_age
    order by created_at
    limit v_batch
  loop
    v_candidates := v_candidates + 1;
    select net.http_delete(
      url     := v_base || '/storage/v1/object/' || v_bucket || '/' || v_obj.name,
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || v_key,
        'apikey',        v_key
      )
    ) into v_req;
    v_ids        := v_ids || v_req;
    v_dispatched := v_dispatched + 1;
  end loop;

  insert into public.storage_purge_runs(bucket, candidate_count, dispatched_count, request_ids, note)
  values (v_bucket, v_candidates, v_dispatched, v_ids,
    case when v_candidates = 0 then 'nothing to purge (no objects older than 12h)'
         else format('dispatched %s Storage DELETE(s); HTTP result is ASYNC — confirm via net._http_response (status 200) or the purge watchdog, NOT this row', v_dispatched)
    end);
end;
$$;


--
-- Name: FUNCTION purge_zip_inner_images(p_force boolean); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.purge_zip_inner_images(p_force boolean) IS 'ADR-048 Block 4 (rev 2026-06-15): delete >12h objects from zip-inner-images via Storage REST (frees bytes, not just the row). Runs once daily at 05:00 Europe/Warsaw via pg_cron (in-function DST-aware hour gate; p_force bypasses for manual runs). Reads the service_role/secret key from Vault; logs each run to storage_purge_runs.';


--
-- Name: set_clickup_rest_token(text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_clickup_rest_token(p_user_id text, p_token text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'vault'
    AS $$
declare
  v_name  text := 'clickup_rest_token_' || p_user_id;
  v_descr text := 'ClickUp classic REST OAuth token for user ' || p_user_id || ' (ADR-054 Block 4 as-U extraction)';
  v_id    uuid;
begin
  select id into v_id from vault.secrets where name = v_name limit 1;
  if v_id is null then
    perform vault.create_secret(p_token, v_name, v_descr);
  else
    perform vault.update_secret(v_id, p_token, v_name, v_descr);
  end if;
end;
$$;


--
-- Name: FUNCTION set_clickup_rest_token(p_user_id text, p_token text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.set_clickup_rest_token(p_user_id text, p_token text) IS 'ADR-054 Block 1: create-or-update the per-user ClickUp classic REST OAuth token in Supabase Vault (secret clickup_rest_token_<user_id>), written by the onboarding webhook. SECURITY DEFINER; EXECUTE only service_role. Idempotent; tokens dont expire so changes only on onboard/revoke.';


--
-- Name: set_waiter_sessions_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_waiter_sessions_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
begin
  new.updated_at := now();
  return new;
end;
$$;


--
-- Name: validate_queue_config(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.validate_queue_config() RETURNS trigger
    LANGUAGE plpgsql
    AS $_$
declare
  k text := new.key;
  v text := new.value;
  n  bigint;
  j  jsonb;
  e  jsonb;
begin
  if k = 'queue.enabled' then
    if v not in ('true','false') then
      raise exception 'config %: must be true or false (got %)', k, v;
    end if;
    return new;
  end if;

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

  return new;
end;
$_$;


--
-- Name: validate_session_waiter_config(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.validate_session_waiter_config() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $_$
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
  return new;
end;
$_$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: agent_chat_dedup; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_chat_dedup (
    message_id text NOT NULL,
    channel_id text,
    first_seen_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE agent_chat_dedup; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.agent_chat_dedup IS 'ADR-066 Block 2: Chat-surface idempotency. One row per ClickUp chat message id, claimed atomically (INSERT ... ON CONFLICT DO NOTHING) by the Chat Poll Producer before enqueue, so an overlapping poll or a partial cursor advance never double-enqueues a message. Analogue of agent_webhook_dedup for Chat. Prunable.';


--
-- Name: agent_input_file_map; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_input_file_map (
    file_id text NOT NULL,
    url text NOT NULL,
    mime text,
    source_ref text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE agent_input_file_map; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.agent_input_file_map IS 'ADR-055 Block 5.2: global file_id -> {url,mime,source_ref} map, written by Upload Input Images (v1) after each Files-API upload, read by the image MCP tool handler to resolve generate_image reference_file_ids -> signed URLs WITHOUT session context (the MCP host surfaces none; Anthropic input files are not downloadable). 24h TTL prune (signed URLs only need to outlive a session). RLS enabled, no policy: API roles denied; the pipeline''s direct Postgres role bypasses RLS (mirrors 007).';


--
-- Name: agent_input_file_map_prune_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_input_file_map_prune_runs (
    id bigint NOT NULL,
    ran_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_count integer DEFAULT 0 NOT NULL,
    note text
);


--
-- Name: TABLE agent_input_file_map_prune_runs; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.agent_input_file_map_prune_runs IS 'ADR-055 Block 5.2: audit log of the agent_input_file_map 24h TTL prune (one row per run). Synchronous DELETE so deleted_count is authoritative (unlike the async zip purge).';


--
-- Name: agent_input_file_map_prune_runs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.agent_input_file_map_prune_runs ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.agent_input_file_map_prune_runs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: agent_proposal_evaluations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_proposal_evaluations (
    id bigint NOT NULL,
    agent_proposal_id bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    commenter_user_id text NOT NULL,
    rating boolean,
    comment_text text,
    CONSTRAINT agent_proposal_evaluations_check CHECK (((rating IS NOT NULL) OR (comment_text IS NOT NULL)))
);


--
-- Name: agent_proposal_evaluations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.agent_proposal_evaluations_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: agent_proposal_evaluations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.agent_proposal_evaluations_id_seq OWNED BY public.agent_proposal_evaluations.id;


--
-- Name: agent_proposals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_proposals (
    id bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    proposer_type text,
    proposal_tier text DEFAULT 'artifact'::text NOT NULL,
    source_agent_run_id bigint,
    source_proposal_id bigint,
    change_summary text NOT NULL,
    change_description text,
    change_category text,
    clickup_task_id text,
    initial_draft_reference text,
    final_output_reference text,
    artifact_urls text[],
    proposal_summary text NOT NULL,
    proposal_details text,
    affected_process_type text,
    proposed_change_type text,
    CONSTRAINT agent_proposals_proposal_tier_check CHECK ((proposal_tier = ANY (ARRAY['artifact'::text, 'meta'::text]))),
    CONSTRAINT agent_proposals_proposed_change_type_check CHECK ((proposed_change_type = ANY (ARRAY['prompt'::text, 'template'::text, 'process'::text, 'config'::text, 'rule'::text]))),
    CONSTRAINT agent_proposals_proposer_type_check CHECK ((proposer_type = ANY (ARRAY['weekly_org'::text, 'per_task'::text])))
);


--
-- Name: agent_proposals_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.agent_proposals_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: agent_proposals_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.agent_proposals_id_seq OWNED BY public.agent_proposals.id;


--
-- Name: agent_routing; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_routing (
    impact text NOT NULL,
    tier_label text NOT NULL,
    model_id text NOT NULL,
    agent_name text NOT NULL,
    agent_id text,
    agent_version integer,
    rules_sha256 text,
    conventions_version integer,
    synced_at timestamp with time zone,
    active boolean DEFAULT true NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE agent_routing; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.agent_routing IS 'ADR-053: impact -> Managed Agent (agent_id) for the managed lane, plus sync provenance (rules hash, conventions version, version, synced_at). model_routing (002) is untouched and serves the bare failover lane. Edited as data; agent_id/version/sha filled by Sync Agent Definitions (v1).';


--
-- Name: agent_run_evaluations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_run_evaluations (
    id bigint NOT NULL,
    agent_run_id bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    commenter_user_id text NOT NULL,
    rating boolean,
    comment_text text,
    CONSTRAINT agent_run_evaluations_check CHECK (((rating IS NOT NULL) OR (comment_text IS NOT NULL)))
);


--
-- Name: agent_run_evaluations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.agent_run_evaluations_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: agent_run_evaluations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.agent_run_evaluations_id_seq OWNED BY public.agent_run_evaluations.id;


--
-- Name: agent_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_runs (
    id bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    clickup_task_id text,
    caller_user_id text,
    process_type text,
    triggered_by text NOT NULL,
    invocation_type text,
    queue_priority integer,
    queue_wait_ms integer,
    retry_attempt integer DEFAULT 0,
    model_used text,
    impact text,
    duration_ms integer,
    cost_pln numeric(10,4),
    input_tokens integer,
    output_tokens integer,
    status text,
    error_details text,
    subject_key text,
    clickup_comment_id text,
    drive_file_id text,
    run_payload_bytes bigint,
    n8n_execution_id text,
    clickup_attachment_ids jsonb,
    CONSTRAINT agent_runs_impact_check CHECK (((impact IS NULL) OR (impact = ANY (ARRAY['Niski'::text, 'Średni'::text, 'Wysoki'::text, 'Krytycznie ważne'::text, 'n/d - zadanie nie jest dla AI'::text])))),
    CONSTRAINT agent_runs_invocation_type_check CHECK ((invocation_type = ANY (ARRAY['autonomous'::text, 'explicit'::text, 'conversation_reply'::text]))),
    CONSTRAINT agent_runs_status_check CHECK ((status = ANY (ARRAY['completed'::text, 'in_progress'::text, 'failed'::text, 'error'::text]))),
    CONSTRAINT agent_runs_triggered_by_check CHECK ((triggered_by = ANY (ARRAY['webhook_status_change'::text, 'webhook_field_change'::text, 'due_date_daily'::text, 'gmail_incoming'::text, 'gmail_sent_analysis'::text, 'weekly_proposer'::text, 'per_task_proposer'::text, 'explicit_mention'::text, 'explicit_command'::text, 'conversation_reply'::text, 'reset_restart'::text, 'search_step'::text, 'image_gen'::text, 'image_mcp'::text])))
);


--
-- Name: COLUMN agent_runs.subject_key; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.agent_runs.subject_key IS 'ADR-044: channel-natural counterparty id from envelope metadata, never content. Nullable; populated only by PD-capable channels (email) once wired. Erasure hub key.';


--
-- Name: COLUMN agent_runs.clickup_comment_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.agent_runs.clickup_comment_id IS 'ADR-044: id of the ClickUp comment this run posted (post-reply). For erasure via CU API.';


--
-- Name: COLUMN agent_runs.drive_file_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.agent_runs.drive_file_id IS 'ADR-044: reserved for a Drive file id; no workflow writes it yet.';


--
-- Name: COLUMN agent_runs.run_payload_bytes; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.agent_runs.run_payload_bytes IS 'Observability: UTF-8 byte size of the delivered payload (rendered comment + any image base64) for this execution. Proxy and lower bound for n8n execution-data weight (true ~= this x nodes traversed). Written once per execution on the final answer row, for text and image runs alike. Null if the run failed before delivery.';


--
-- Name: COLUMN agent_runs.n8n_execution_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.agent_runs.n8n_execution_id IS 'Observability: n8n execution id for this run; lets you backfill exact execution-data size and jump run->execution. Nullable.';


--
-- Name: COLUMN agent_runs.clickup_attachment_ids; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.agent_runs.clickup_attachment_ids IS 'ADR-044/ADR-053 Block 7: jsonb array of ClickUp attachment ids created by this run (office-doc task attachments + inline image-comment attachments), recorded by Post Reply (v1) Record Artifact for erasure-readiness. Null/[] for runs that attach nothing.';


--
-- Name: agent_runs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.agent_runs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: agent_runs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.agent_runs_id_seq OWNED BY public.agent_runs.id;


--
-- Name: agent_webhook_dedup; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_webhook_dedup (
    triggering_comment_id text NOT NULL,
    first_seen_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE agent_webhook_dedup; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.agent_webhook_dedup IS 'ADR-029: webhook idempotency. One row per ClickUp triggering comment id, claimed atomically (INSERT ... ON CONFLICT DO NOTHING) by CU Webhook Producer before the spine runs, so at-least-once / double-delivered webhooks run once. Prunable: rows older than a few days are safe to delete (dedup window is seconds).';


--
-- Name: chat_poll_cursor; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.chat_poll_cursor (
    channel_id text NOT NULL,
    last_seen_ms bigint DEFAULT 0 NOT NULL,
    last_message_id text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE chat_poll_cursor; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.chat_poll_cursor IS 'ADR-066 Block 2: per-channel high-water mark for the Chat poll producer. last_seen_ms = the max ClickUp chat message date (ms epoch) seen on this channel; each poll keeps only messages with date > last_seen_ms and advances the mark. A new channel (no row) starts at 0 -> the first poll would treat all history as new, so the producer SEEDS a new channel to the newest message WITHOUT enqueuing on the first sighting (cold-start guard).';


--
-- Name: clickup_oauth_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.clickup_oauth_state (
    state text DEFAULT (gen_random_uuid())::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    phase text DEFAULT 'classic'::text NOT NULL,
    code_verifier text,
    mcp_client_id text,
    clickup_user_id text,
    clickup_username text,
    clickup_email text,
    CONSTRAINT clickup_oauth_state_phase_chk CHECK ((phase = ANY (ARRAY['classic'::text, 'mcp'::text])))
);


--
-- Name: TABLE clickup_oauth_state; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.clickup_oauth_state IS 'ADR-054 Block 1: single-use, short-lived CSRF state for the chained ClickUp OAuth onboarding flow. phase=classic rows (default) carry only state+created_at (no PII, no token). phase=mcp rows additionally carry the PKCE code_verifier, the DCR public client_id, and the consenting users transient identity (user_id/username/email) so the mcp callback can mint + place the discovery token without re-identifying via REST (the MCP token is 401 on REST). No token is ever stored. INSERTed at each redirect, DELETEd atomically at the matching callback within 15 min. RLS enabled, no policy.';


--
-- Name: config; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.config (
    key text NOT NULL,
    value text NOT NULL
);


--
-- Name: conversation_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.conversation_sessions (
    id bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    last_turn_at timestamp with time zone DEFAULT now(),
    clickup_task_id text NOT NULL,
    comment_root_id text NOT NULL,
    caller_user_id text NOT NULL,
    base_context jsonb,
    approved_outputs jsonb[],
    turn_count integer DEFAULT 0,
    is_active boolean DEFAULT true,
    expired_at timestamp with time zone,
    expiry_reason text
);


--
-- Name: conversation_sessions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.conversation_sessions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: conversation_sessions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.conversation_sessions_id_seq OWNED BY public.conversation_sessions.id;


--
-- Name: email_sends; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.email_sends (
    id bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    gmail_message_id text,
    gmail_thread_id text,
    triggered_by_user_id text,
    related_clickup_task_id text,
    to_addresses text[],
    cc_addresses text[],
    subject text,
    body_preview text,
    agent_run_id bigint,
    was_human_edited boolean,
    status text,
    CONSTRAINT email_sends_status_check CHECK ((status = ANY (ARRAY['draft_created'::text, 'sent'::text, 'discarded'::text])))
);


--
-- Name: email_sends_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.email_sends_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: email_sends_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.email_sends_id_seq OWNED BY public.email_sends.id;


--
-- Name: fx_rates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.fx_rates (
    rate_date date NOT NULL,
    base text DEFAULT 'USD'::text NOT NULL,
    quote text DEFAULT 'PLN'::text NOT NULL,
    rate numeric NOT NULL,
    source text DEFAULT 'NBP-A'::text NOT NULL,
    table_no text,
    fetched_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: image_gen_params; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.image_gen_params (
    impact text NOT NULL,
    max_images integer NOT NULL,
    resolution text NOT NULL
);


--
-- Name: model_routing; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.model_routing (
    impact text NOT NULL,
    litellm_model text NOT NULL,
    provider text DEFAULT 'bedrock-eu'::text NOT NULL,
    temperature numeric DEFAULT 0.7,
    max_tokens integer DEFAULT 4000 NOT NULL,
    priority integer DEFAULT 5 NOT NULL,
    nudge text,
    price_in_usd_per_1k numeric DEFAULT 0 NOT NULL,
    price_out_usd_per_1k numeric DEFAULT 0 NOT NULL,
    active boolean DEFAULT true NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    modality text DEFAULT 'text'::text NOT NULL,
    fallback_price_per_unit numeric(10,6)
);


--
-- Name: TABLE model_routing; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.model_routing IS 'Composite (impact, modality) -> model-call config + USD token prices. PD-blind global routing: capability + modality only (no personal_data / EU-residency axis). text = Claude direct; image = gemini-image (Nano Banana/Pro) + OpenAI gpt-image-2 (Block 8); multimodal_input = Gemini (flash for n/d/Niski/Średni, pro for Wysoki/Krytycznie). ADR-013/023/024/030/036/042/043.';


--
-- Name: research_parameters; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.research_parameters (
    impact text NOT NULL,
    max_research_rounds integer DEFAULT 3 NOT NULL,
    tavily_max_results integer DEFAULT 5 NOT NULL,
    active boolean DEFAULT true NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE research_parameters; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.research_parameters IS 'Per-impact effort knobs for the web-search agentic loop (Model Turn v1): max recursion rounds + Tavily max_results. Keyed by impact only — effort scales with importance, not GDPR routing. ADR-035.';


--
-- Name: schema_migrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schema_migrations (
    version text NOT NULL,
    applied_at timestamp with time zone DEFAULT now()
);


--
-- Name: storage_purge_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.storage_purge_runs (
    id bigint NOT NULL,
    ran_at timestamp with time zone DEFAULT now() NOT NULL,
    bucket text NOT NULL,
    candidate_count integer,
    dispatched_count integer DEFAULT 0 NOT NULL,
    request_ids bigint[] DEFAULT '{}'::bigint[] NOT NULL,
    note text
);


--
-- Name: TABLE storage_purge_runs; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.storage_purge_runs IS 'ADR-048 Block 4: audit log of the zip-inner-images 24h pg_cron purge (one row per run).';


--
-- Name: storage_purge_runs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.storage_purge_runs ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.storage_purge_runs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: user_data_and_config; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_data_and_config (
    clickup_user_id text NOT NULL,
    clickup_username text,
    clickup_email text,
    vault_id text NOT NULL,
    vault_credential_ids jsonb DEFAULT '{}'::jsonb NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    consented_at timestamp with time zone DEFAULT now() NOT NULL,
    refreshed_at timestamp with time zone,
    revoked_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    daily_spend_limit_pln numeric DEFAULT 40 NOT NULL,
    CONSTRAINT user_clickup_credentials_status_check CHECK ((status = ANY (ARRAY['active'::text, 'revoked'::text, 'expired'::text])))
);


--
-- Name: TABLE user_data_and_config; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.user_data_and_config IS 'ADR-054 Block 1 + migration 046: per-user data + config, keyed by clickup_user_id (= caller_user_id, the ClickUp member id). Renamed from user_clickup_credentials (migration 039) when its purpose was broadened from "ClickUp credential mapping" to "the single per-user data/config table". Holds: the per-user Anthropic Vault id + credential ids for permission-scoped ClickUp retrieval (the token value is never stored here - write-only in the Vault), and daily_spend_limit_pln (per-user daily spend cap). Tokens do not expire (no refresh); lifecycle = onboard + revoke. RLS enabled, no policy: API roles denied, the pipeline''s Postgres role bypasses.';


--
-- Name: COLUMN user_data_and_config.daily_spend_limit_pln; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.user_data_and_config.daily_spend_limit_pln IS 'ADR-064: this user''s daily agent-spend cap in PLN. Default 40. Falls back to config spend.user_daily_limit_pln_default when null is ever introduced.';


--
-- Name: waiter_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.waiter_sessions (
    session_id text NOT NULL,
    clickup_task_id text,
    triggering_comment_id text,
    caller_user_id text,
    agent_id text,
    model_id text,
    surface text,
    surface_ref text,
    impact text,
    status text DEFAULT 'handed_off'::text NOT NULL,
    outcome text,
    handed_off_at timestamp with time zone DEFAULT now() NOT NULL,
    last_event_at timestamp with time zone,
    finished_at timestamp with time zone,
    deadline_at timestamp with time zone,
    carry_state jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT waiter_sessions_status_check CHECK ((status = ANY (ARRAY['handed_off'::text, 'running'::text, 'delivered'::text, 'finished'::text, 'failed'::text, 'reconciled'::text])))
);


--
-- Name: TABLE waiter_sessions; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.waiter_sessions IS 'ADR-066: durable record of managed-agent sessions handed from the orchestrator to the session-waiter service. status + handed_off_at are the proactive dead-mans signal; carry_state feeds the Block-7 finish callback; session_id is the finish-half idempotency key. No credential is stored here (A6).';


--
-- Name: agent_proposal_evaluations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_proposal_evaluations ALTER COLUMN id SET DEFAULT nextval('public.agent_proposal_evaluations_id_seq'::regclass);


--
-- Name: agent_proposals id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_proposals ALTER COLUMN id SET DEFAULT nextval('public.agent_proposals_id_seq'::regclass);


--
-- Name: agent_run_evaluations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_run_evaluations ALTER COLUMN id SET DEFAULT nextval('public.agent_run_evaluations_id_seq'::regclass);


--
-- Name: agent_runs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_runs ALTER COLUMN id SET DEFAULT nextval('public.agent_runs_id_seq'::regclass);


--
-- Name: conversation_sessions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversation_sessions ALTER COLUMN id SET DEFAULT nextval('public.conversation_sessions_id_seq'::regclass);


--
-- Name: email_sends id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_sends ALTER COLUMN id SET DEFAULT nextval('public.email_sends_id_seq'::regclass);


--
-- Name: agent_chat_dedup agent_chat_dedup_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_chat_dedup
    ADD CONSTRAINT agent_chat_dedup_pkey PRIMARY KEY (message_id);


--
-- Name: agent_input_file_map agent_input_file_map_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_input_file_map
    ADD CONSTRAINT agent_input_file_map_pkey PRIMARY KEY (file_id);


--
-- Name: agent_input_file_map_prune_runs agent_input_file_map_prune_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_input_file_map_prune_runs
    ADD CONSTRAINT agent_input_file_map_prune_runs_pkey PRIMARY KEY (id);


--
-- Name: agent_proposal_evaluations agent_proposal_evaluations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_proposal_evaluations
    ADD CONSTRAINT agent_proposal_evaluations_pkey PRIMARY KEY (id);


--
-- Name: agent_proposals agent_proposals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_proposals
    ADD CONSTRAINT agent_proposals_pkey PRIMARY KEY (id);


--
-- Name: agent_routing agent_routing_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_routing
    ADD CONSTRAINT agent_routing_pkey PRIMARY KEY (impact);


--
-- Name: agent_run_evaluations agent_run_evaluations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_run_evaluations
    ADD CONSTRAINT agent_run_evaluations_pkey PRIMARY KEY (id);


--
-- Name: agent_runs agent_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_runs
    ADD CONSTRAINT agent_runs_pkey PRIMARY KEY (id);


--
-- Name: agent_webhook_dedup agent_webhook_dedup_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_webhook_dedup
    ADD CONSTRAINT agent_webhook_dedup_pkey PRIMARY KEY (triggering_comment_id);


--
-- Name: chat_poll_cursor chat_poll_cursor_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_poll_cursor
    ADD CONSTRAINT chat_poll_cursor_pkey PRIMARY KEY (channel_id);


--
-- Name: clickup_oauth_state clickup_oauth_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.clickup_oauth_state
    ADD CONSTRAINT clickup_oauth_state_pkey PRIMARY KEY (state);


--
-- Name: config config_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.config
    ADD CONSTRAINT config_pkey PRIMARY KEY (key);


--
-- Name: conversation_sessions conversation_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversation_sessions
    ADD CONSTRAINT conversation_sessions_pkey PRIMARY KEY (id);


--
-- Name: email_sends email_sends_gmail_message_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_sends
    ADD CONSTRAINT email_sends_gmail_message_id_key UNIQUE (gmail_message_id);


--
-- Name: email_sends email_sends_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_sends
    ADD CONSTRAINT email_sends_pkey PRIMARY KEY (id);


--
-- Name: fx_rates fx_rates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fx_rates
    ADD CONSTRAINT fx_rates_pkey PRIMARY KEY (rate_date, base, quote);


--
-- Name: image_gen_params image_gen_params_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.image_gen_params
    ADD CONSTRAINT image_gen_params_pkey PRIMARY KEY (impact);


--
-- Name: model_routing model_routing_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.model_routing
    ADD CONSTRAINT model_routing_pkey PRIMARY KEY (impact, modality);


--
-- Name: research_parameters research_parameters_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.research_parameters
    ADD CONSTRAINT research_parameters_pkey PRIMARY KEY (impact);


--
-- Name: schema_migrations schema_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schema_migrations
    ADD CONSTRAINT schema_migrations_pkey PRIMARY KEY (version);


--
-- Name: storage_purge_runs storage_purge_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.storage_purge_runs
    ADD CONSTRAINT storage_purge_runs_pkey PRIMARY KEY (id);


--
-- Name: user_data_and_config user_clickup_credentials_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_data_and_config
    ADD CONSTRAINT user_clickup_credentials_pkey PRIMARY KEY (clickup_user_id);


--
-- Name: waiter_sessions waiter_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.waiter_sessions
    ADD CONSTRAINT waiter_sessions_pkey PRIMARY KEY (session_id);


--
-- Name: idx_emails_task; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_emails_task ON public.email_sends USING btree (related_clickup_task_id);


--
-- Name: idx_emails_thread; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_emails_thread ON public.email_sends USING btree (gmail_thread_id);


--
-- Name: idx_emails_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_emails_user ON public.email_sends USING btree (triggered_by_user_id, created_at DESC);


--
-- Name: idx_prop_evals_proposal; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_prop_evals_proposal ON public.agent_proposal_evaluations USING btree (agent_proposal_id, created_at);


--
-- Name: idx_prop_evals_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_prop_evals_user ON public.agent_proposal_evaluations USING btree (commenter_user_id, created_at DESC);


--
-- Name: idx_proposals_category; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_proposals_category ON public.agent_proposals USING btree (change_category, created_at DESC);


--
-- Name: idx_proposals_process; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_proposals_process ON public.agent_proposals USING btree (affected_process_type, created_at DESC);


--
-- Name: idx_proposals_source_proposal; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_proposals_source_proposal ON public.agent_proposals USING btree (source_proposal_id);


--
-- Name: idx_proposals_source_run; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_proposals_source_run ON public.agent_proposals USING btree (source_agent_run_id);


--
-- Name: idx_proposals_tier; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_proposals_tier ON public.agent_proposals USING btree (proposal_tier, created_at DESC);


--
-- Name: idx_proposals_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_proposals_type ON public.agent_proposals USING btree (proposed_change_type, created_at DESC);


--
-- Name: idx_run_evals_run; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_run_evals_run ON public.agent_run_evaluations USING btree (agent_run_id, created_at);


--
-- Name: idx_run_evals_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_run_evals_user ON public.agent_run_evaluations USING btree (commenter_user_id, created_at DESC);


--
-- Name: idx_runs_caller; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_runs_caller ON public.agent_runs USING btree (caller_user_id, created_at DESC);


--
-- Name: idx_runs_invocation_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_runs_invocation_type ON public.agent_runs USING btree (invocation_type, created_at DESC);


--
-- Name: idx_runs_process_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_runs_process_type ON public.agent_runs USING btree (process_type, created_at DESC);


--
-- Name: idx_runs_subject_key; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_runs_subject_key ON public.agent_runs USING btree (subject_key) WHERE (subject_key IS NOT NULL);


--
-- Name: idx_runs_task; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_runs_task ON public.agent_runs USING btree (clickup_task_id, created_at DESC);


--
-- Name: idx_runs_triggered_by; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_runs_triggered_by ON public.agent_runs USING btree (triggered_by, created_at DESC);


--
-- Name: idx_sessions_active; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_sessions_active ON public.conversation_sessions USING btree (clickup_task_id, comment_root_id, caller_user_id) WHERE (is_active = true);


--
-- Name: idx_sessions_last_turn; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sessions_last_turn ON public.conversation_sessions USING btree (last_turn_at) WHERE (is_active = true);


--
-- Name: idx_waiter_sessions_status_handed_off; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_waiter_sessions_status_handed_off ON public.waiter_sessions USING btree (status, handed_off_at);


--
-- Name: config trg_validate_queue_config; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_validate_queue_config BEFORE INSERT OR UPDATE ON public.config FOR EACH ROW WHEN ((new.key ~~ 'queue.%'::text)) EXECUTE FUNCTION public.validate_queue_config();


--
-- Name: config trg_validate_session_waiter_config; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_validate_session_waiter_config BEFORE INSERT OR UPDATE ON public.config FOR EACH ROW WHEN ((new.key ~~ 'session_waiter.%'::text)) EXECUTE FUNCTION public.validate_session_waiter_config();


--
-- Name: waiter_sessions trg_waiter_sessions_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_waiter_sessions_updated_at BEFORE UPDATE ON public.waiter_sessions FOR EACH ROW EXECUTE FUNCTION public.set_waiter_sessions_updated_at();


--
-- Name: agent_proposal_evaluations agent_proposal_evaluations_agent_proposal_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_proposal_evaluations
    ADD CONSTRAINT agent_proposal_evaluations_agent_proposal_id_fkey FOREIGN KEY (agent_proposal_id) REFERENCES public.agent_proposals(id) ON DELETE CASCADE;


--
-- Name: agent_proposals agent_proposals_source_agent_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_proposals
    ADD CONSTRAINT agent_proposals_source_agent_run_id_fkey FOREIGN KEY (source_agent_run_id) REFERENCES public.agent_runs(id);


--
-- Name: agent_proposals agent_proposals_source_proposal_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_proposals
    ADD CONSTRAINT agent_proposals_source_proposal_id_fkey FOREIGN KEY (source_proposal_id) REFERENCES public.agent_proposals(id);


--
-- Name: agent_run_evaluations agent_run_evaluations_agent_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_run_evaluations
    ADD CONSTRAINT agent_run_evaluations_agent_run_id_fkey FOREIGN KEY (agent_run_id) REFERENCES public.agent_runs(id) ON DELETE CASCADE;


--
-- Name: email_sends email_sends_agent_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_sends
    ADD CONSTRAINT email_sends_agent_run_id_fkey FOREIGN KEY (agent_run_id) REFERENCES public.agent_runs(id);


--
-- Name: agent_chat_dedup; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.agent_chat_dedup ENABLE ROW LEVEL SECURITY;

--
-- Name: agent_input_file_map; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.agent_input_file_map ENABLE ROW LEVEL SECURITY;

--
-- Name: agent_input_file_map_prune_runs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.agent_input_file_map_prune_runs ENABLE ROW LEVEL SECURITY;

--
-- Name: agent_proposal_evaluations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.agent_proposal_evaluations ENABLE ROW LEVEL SECURITY;

--
-- Name: agent_proposals; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.agent_proposals ENABLE ROW LEVEL SECURITY;

--
-- Name: agent_routing; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.agent_routing ENABLE ROW LEVEL SECURITY;

--
-- Name: agent_run_evaluations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.agent_run_evaluations ENABLE ROW LEVEL SECURITY;

--
-- Name: agent_runs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.agent_runs ENABLE ROW LEVEL SECURITY;

--
-- Name: agent_webhook_dedup; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.agent_webhook_dedup ENABLE ROW LEVEL SECURITY;

--
-- Name: chat_poll_cursor; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.chat_poll_cursor ENABLE ROW LEVEL SECURITY;

--
-- Name: clickup_oauth_state; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.clickup_oauth_state ENABLE ROW LEVEL SECURITY;

--
-- Name: config; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.config ENABLE ROW LEVEL SECURITY;

--
-- Name: conversation_sessions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.conversation_sessions ENABLE ROW LEVEL SECURITY;

--
-- Name: email_sends; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.email_sends ENABLE ROW LEVEL SECURITY;

--
-- Name: fx_rates; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.fx_rates ENABLE ROW LEVEL SECURITY;

--
-- Name: image_gen_params; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.image_gen_params ENABLE ROW LEVEL SECURITY;

--
-- Name: model_routing; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.model_routing ENABLE ROW LEVEL SECURITY;

--
-- Name: research_parameters; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.research_parameters ENABLE ROW LEVEL SECURITY;

--
-- Name: schema_migrations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.schema_migrations ENABLE ROW LEVEL SECURITY;

--
-- Name: storage_purge_runs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.storage_purge_runs ENABLE ROW LEVEL SECURITY;

--
-- Name: user_data_and_config; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.user_data_and_config ENABLE ROW LEVEL SECURITY;

--
-- Name: waiter_sessions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.waiter_sessions ENABLE ROW LEVEL SECURITY;

--
-- Name: SCHEMA public; Type: ACL; Schema: -; Owner: -
--

GRANT USAGE ON SCHEMA public TO postgres;
GRANT USAGE ON SCHEMA public TO anon;
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT USAGE ON SCHEMA public TO service_role;


--
-- Name: FUNCTION check_stuck_waiter_sessions(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.check_stuck_waiter_sessions() FROM PUBLIC;
GRANT ALL ON FUNCTION public.check_stuck_waiter_sessions() TO service_role;


--
-- Name: FUNCTION get_anthropic_key(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.get_anthropic_key() FROM PUBLIC;
GRANT ALL ON FUNCTION public.get_anthropic_key() TO service_role;


--
-- Name: FUNCTION get_clickup_oauth_app(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.get_clickup_oauth_app() FROM PUBLIC;
GRANT ALL ON FUNCTION public.get_clickup_oauth_app() TO service_role;


--
-- Name: FUNCTION get_clickup_onboarding_state(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.get_clickup_onboarding_state() FROM PUBLIC;
GRANT ALL ON FUNCTION public.get_clickup_onboarding_state() TO service_role;


--
-- Name: FUNCTION get_clickup_rest_token(p_user_id text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.get_clickup_rest_token(p_user_id text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.get_clickup_rest_token(p_user_id text) TO service_role;


--
-- Name: FUNCTION get_image_mcp_bearer(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.get_image_mcp_bearer() FROM PUBLIC;
GRANT ALL ON FUNCTION public.get_image_mcp_bearer() TO service_role;


--
-- Name: FUNCTION get_litellm_image_key(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.get_litellm_image_key() FROM PUBLIC;
GRANT ALL ON FUNCTION public.get_litellm_image_key() TO service_role;


--
-- Name: FUNCTION get_spend_status(p_user_id text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.get_spend_status(p_user_id text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.get_spend_status(p_user_id text) TO service_role;


--
-- Name: FUNCTION prune_agent_input_file_map(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.prune_agent_input_file_map() TO anon;
GRANT ALL ON FUNCTION public.prune_agent_input_file_map() TO authenticated;
GRANT ALL ON FUNCTION public.prune_agent_input_file_map() TO service_role;


--
-- Name: FUNCTION purge_agent_output_images(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.purge_agent_output_images() TO anon;
GRANT ALL ON FUNCTION public.purge_agent_output_images() TO authenticated;
GRANT ALL ON FUNCTION public.purge_agent_output_images() TO service_role;


--
-- Name: FUNCTION purge_zip_inner_images(p_force boolean); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.purge_zip_inner_images(p_force boolean) TO anon;
GRANT ALL ON FUNCTION public.purge_zip_inner_images(p_force boolean) TO authenticated;
GRANT ALL ON FUNCTION public.purge_zip_inner_images(p_force boolean) TO service_role;


--
-- Name: FUNCTION set_clickup_rest_token(p_user_id text, p_token text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.set_clickup_rest_token(p_user_id text, p_token text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.set_clickup_rest_token(p_user_id text, p_token text) TO service_role;


--
-- Name: FUNCTION set_waiter_sessions_updated_at(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.set_waiter_sessions_updated_at() TO anon;
GRANT ALL ON FUNCTION public.set_waiter_sessions_updated_at() TO authenticated;
GRANT ALL ON FUNCTION public.set_waiter_sessions_updated_at() TO service_role;


--
-- Name: FUNCTION validate_queue_config(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.validate_queue_config() TO anon;
GRANT ALL ON FUNCTION public.validate_queue_config() TO authenticated;
GRANT ALL ON FUNCTION public.validate_queue_config() TO service_role;


--
-- Name: FUNCTION validate_session_waiter_config(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.validate_session_waiter_config() TO anon;
GRANT ALL ON FUNCTION public.validate_session_waiter_config() TO authenticated;
GRANT ALL ON FUNCTION public.validate_session_waiter_config() TO service_role;


--
-- Name: TABLE agent_chat_dedup; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.agent_chat_dedup TO anon;
GRANT ALL ON TABLE public.agent_chat_dedup TO authenticated;
GRANT ALL ON TABLE public.agent_chat_dedup TO service_role;


--
-- Name: TABLE agent_input_file_map; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.agent_input_file_map TO anon;
GRANT ALL ON TABLE public.agent_input_file_map TO authenticated;
GRANT ALL ON TABLE public.agent_input_file_map TO service_role;


--
-- Name: TABLE agent_input_file_map_prune_runs; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.agent_input_file_map_prune_runs TO anon;
GRANT ALL ON TABLE public.agent_input_file_map_prune_runs TO authenticated;
GRANT ALL ON TABLE public.agent_input_file_map_prune_runs TO service_role;


--
-- Name: SEQUENCE agent_input_file_map_prune_runs_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.agent_input_file_map_prune_runs_id_seq TO anon;
GRANT ALL ON SEQUENCE public.agent_input_file_map_prune_runs_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.agent_input_file_map_prune_runs_id_seq TO service_role;


--
-- Name: TABLE agent_proposal_evaluations; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.agent_proposal_evaluations TO anon;
GRANT ALL ON TABLE public.agent_proposal_evaluations TO authenticated;
GRANT ALL ON TABLE public.agent_proposal_evaluations TO service_role;


--
-- Name: SEQUENCE agent_proposal_evaluations_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.agent_proposal_evaluations_id_seq TO anon;
GRANT ALL ON SEQUENCE public.agent_proposal_evaluations_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.agent_proposal_evaluations_id_seq TO service_role;


--
-- Name: TABLE agent_proposals; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.agent_proposals TO anon;
GRANT ALL ON TABLE public.agent_proposals TO authenticated;
GRANT ALL ON TABLE public.agent_proposals TO service_role;


--
-- Name: SEQUENCE agent_proposals_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.agent_proposals_id_seq TO anon;
GRANT ALL ON SEQUENCE public.agent_proposals_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.agent_proposals_id_seq TO service_role;


--
-- Name: TABLE agent_routing; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.agent_routing TO anon;
GRANT ALL ON TABLE public.agent_routing TO authenticated;
GRANT ALL ON TABLE public.agent_routing TO service_role;


--
-- Name: TABLE agent_run_evaluations; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.agent_run_evaluations TO anon;
GRANT ALL ON TABLE public.agent_run_evaluations TO authenticated;
GRANT ALL ON TABLE public.agent_run_evaluations TO service_role;


--
-- Name: SEQUENCE agent_run_evaluations_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.agent_run_evaluations_id_seq TO anon;
GRANT ALL ON SEQUENCE public.agent_run_evaluations_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.agent_run_evaluations_id_seq TO service_role;


--
-- Name: TABLE agent_runs; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.agent_runs TO anon;
GRANT ALL ON TABLE public.agent_runs TO authenticated;
GRANT ALL ON TABLE public.agent_runs TO service_role;


--
-- Name: SEQUENCE agent_runs_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.agent_runs_id_seq TO anon;
GRANT ALL ON SEQUENCE public.agent_runs_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.agent_runs_id_seq TO service_role;


--
-- Name: TABLE agent_webhook_dedup; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.agent_webhook_dedup TO anon;
GRANT ALL ON TABLE public.agent_webhook_dedup TO authenticated;
GRANT ALL ON TABLE public.agent_webhook_dedup TO service_role;


--
-- Name: TABLE chat_poll_cursor; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.chat_poll_cursor TO anon;
GRANT ALL ON TABLE public.chat_poll_cursor TO authenticated;
GRANT ALL ON TABLE public.chat_poll_cursor TO service_role;


--
-- Name: TABLE clickup_oauth_state; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.clickup_oauth_state TO anon;
GRANT ALL ON TABLE public.clickup_oauth_state TO authenticated;
GRANT ALL ON TABLE public.clickup_oauth_state TO service_role;


--
-- Name: TABLE config; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.config TO anon;
GRANT ALL ON TABLE public.config TO authenticated;
GRANT ALL ON TABLE public.config TO service_role;


--
-- Name: TABLE conversation_sessions; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.conversation_sessions TO anon;
GRANT ALL ON TABLE public.conversation_sessions TO authenticated;
GRANT ALL ON TABLE public.conversation_sessions TO service_role;


--
-- Name: SEQUENCE conversation_sessions_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.conversation_sessions_id_seq TO anon;
GRANT ALL ON SEQUENCE public.conversation_sessions_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.conversation_sessions_id_seq TO service_role;


--
-- Name: TABLE email_sends; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.email_sends TO anon;
GRANT ALL ON TABLE public.email_sends TO authenticated;
GRANT ALL ON TABLE public.email_sends TO service_role;


--
-- Name: SEQUENCE email_sends_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.email_sends_id_seq TO anon;
GRANT ALL ON SEQUENCE public.email_sends_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.email_sends_id_seq TO service_role;


--
-- Name: TABLE fx_rates; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.fx_rates TO anon;
GRANT ALL ON TABLE public.fx_rates TO authenticated;
GRANT ALL ON TABLE public.fx_rates TO service_role;


--
-- Name: TABLE image_gen_params; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.image_gen_params TO anon;
GRANT ALL ON TABLE public.image_gen_params TO authenticated;
GRANT ALL ON TABLE public.image_gen_params TO service_role;


--
-- Name: TABLE model_routing; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.model_routing TO anon;
GRANT ALL ON TABLE public.model_routing TO authenticated;
GRANT ALL ON TABLE public.model_routing TO service_role;


--
-- Name: TABLE research_parameters; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.research_parameters TO anon;
GRANT ALL ON TABLE public.research_parameters TO authenticated;
GRANT ALL ON TABLE public.research_parameters TO service_role;


--
-- Name: TABLE schema_migrations; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.schema_migrations TO anon;
GRANT ALL ON TABLE public.schema_migrations TO authenticated;
GRANT ALL ON TABLE public.schema_migrations TO service_role;


--
-- Name: TABLE storage_purge_runs; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.storage_purge_runs TO anon;
GRANT ALL ON TABLE public.storage_purge_runs TO authenticated;
GRANT ALL ON TABLE public.storage_purge_runs TO service_role;


--
-- Name: SEQUENCE storage_purge_runs_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.storage_purge_runs_id_seq TO anon;
GRANT ALL ON SEQUENCE public.storage_purge_runs_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.storage_purge_runs_id_seq TO service_role;


--
-- Name: TABLE user_data_and_config; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.user_data_and_config TO anon;
GRANT ALL ON TABLE public.user_data_and_config TO authenticated;
GRANT ALL ON TABLE public.user_data_and_config TO service_role;


--
-- Name: TABLE waiter_sessions; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.waiter_sessions TO anon;
GRANT ALL ON TABLE public.waiter_sessions TO authenticated;
GRANT ALL ON TABLE public.waiter_sessions TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON SEQUENCES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON SEQUENCES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON SEQUENCES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON SEQUENCES TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR FUNCTIONS; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR FUNCTIONS; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON FUNCTIONS TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON FUNCTIONS TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON FUNCTIONS TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON TABLES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON TABLES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON TABLES TO service_role;


--
-- PostgreSQL database dump complete
--

\unrestrict AtCspjl3zGBiEOINv1Q32VD7VLfa83XYnCDXI5WNsQ03iIg0lDBCSxX4Sfln42H

