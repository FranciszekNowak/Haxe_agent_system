-- 030_zip_purge_daily_5am_12h.sql
-- ADR-048 Block 4 revision (operator request, 2026-06-15): change the zip-inner-images
-- purge from "hourly, >24h" (migration 029) to "ONCE DAILY at 05:00 Europe/Warsaw,
-- deleting objects older than 12 hours". Append-only (CLAUDE.md): supersedes 029's
-- function body + schedule; does not edit 029.
--
-- WHY a 12h floor: it must comfortably exceed an agent run's lifetime (the reader uploads
-- the zip-inner image, the provider fetches it minutes later in the invoke-model step), so
-- the purge can never delete an attachment that an in-flight run still needs. 12h is a large
-- safety margin — no run lasts hours — which is the operator's stated intent ("don't delete
-- an attachment mid-run just because somebody was doing something at 5 AM").
--
-- RETENTION CONSEQUENCE (documented + operator-accepted): once-daily + a 12h floor means a
-- file created in the evening/overnight is younger than 12h at 05:00 and waits for the NEXT
-- day's run, so real lifetime is up to ~36h (NOT 24h). A single daily run cannot guarantee
-- <=24h with any non-zero floor — that is a scheduling math constraint, not a tuning gap. The
-- GDPR record (compliance/gdpr-processing-decisions.md §6) and current.md are updated from
-- "24h" to "purged daily ~05:00 Warsaw, <=~36h". Still a tight, documented data-minimization
-- posture (24h was our own target, not a legal line). To restore a <=24h guarantee, run more
-- than once per day (e.g. '0 */6 * * *') instead.
--
-- TIMEZONE/DST: pg_cron schedules in UTC (db TimeZone = UTC) and has no per-job timezone.
-- 05:00 Warsaw = 03:00 UTC in summer (CEST) and 04:00 UTC in winter (CET). To hit 05:00 LOCAL
-- year-round, the job fires at BOTH 03:00 and 04:00 UTC and the function gates on the
-- Europe/Warsaw local hour = 5, so exactly one of the two fires acts each day. A manual /
-- verification call passes p_force => true to bypass the gate.

-- 029 created a 0-arg function; replace it with a (boolean) overload. Drop first to avoid an
-- ambiguous 0-arg call resolution.
drop function if exists public.purge_zip_inner_images();

create or replace function public.purge_zip_inner_images(p_force boolean default false)
returns void
language plpgsql
security definer
set search_path = public, extensions, net, vault
as $$
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
  -- Act only at 05:00 Europe/Warsaw (DST-aware) unless explicitly forced (manual run).
  if not p_force
     and extract(hour from (now() at time zone 'Europe/Warsaw'))::int <> 5 then
    return;
  end if;

  v_key := (select decrypted_secret from vault.decrypted_secrets
            where name = 'service_role_key' limit 1);

  -- Missing secret = observable, not silent. Row records the skip; the watchdog catches
  -- the stale buildup that follows. (Accepts a legacy service_role JWT or a new sb_secret_
  -- key; both bypass RLS, and the key goes in both apikey + Authorization Bearer, which
  -- Supabase permits for secret keys only when the two header values are identical.)
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
    -- DELETE /storage/v1/object/{bucket}/{key} routes through the storage service, which
    -- removes BOTH the S3 bytes and the storage.objects row. Keys are URL-safe, no encoding.
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

  -- NOTE: pg_net is async, so this row records what was DISPATCHED, not the HTTP outcome.
  -- Success/failure of each DELETE lands in net._http_response (keyed by request_ids); the
  -- purge watchdog is the authoritative "is it actually working" signal.
  insert into public.storage_purge_runs(bucket, candidate_count, dispatched_count, request_ids, note)
  values (v_bucket, v_candidates, v_dispatched, v_ids,
    case when v_candidates = 0 then 'nothing to purge (no objects older than 12h)'
         else format('dispatched %s Storage DELETE(s); HTTP result is ASYNC — confirm via net._http_response (status 200) or the purge watchdog, NOT this row', v_dispatched)
    end);
end;
$$;

comment on function public.purge_zip_inner_images(boolean) is
  'ADR-048 Block 4 (rev 2026-06-15): delete >12h objects from zip-inner-images via Storage REST (frees bytes, not just the row). Runs once daily at 05:00 Europe/Warsaw via pg_cron (in-function DST-aware hour gate; p_force bypasses for manual runs). Reads the service_role/secret key from Vault; logs each run to storage_purge_runs.';

-- Reschedule: fire at 03:00 and 04:00 UTC; the in-function Warsaw-hour gate makes exactly
-- one of them act at 05:00 local, summer or winter. Idempotent.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'purge-zip-inner-images') then
    perform cron.unschedule('purge-zip-inner-images');
  end if;
end $$;

select cron.schedule(
  'purge-zip-inner-images',
  '0 3,4 * * *',
  $cron$ select public.purge_zip_inner_images(); $cron$
);
