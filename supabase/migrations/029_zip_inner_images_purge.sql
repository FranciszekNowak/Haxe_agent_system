-- 029_zip_inner_images_purge.sql
-- ADR-048 Block 4: GDPR 24h retention enforcement for the private EU bucket
-- `zip-inner-images` (haxe-agent-prod / eu-west-1). Supabase has no native object
-- lifecycle, so a DB-native pg_cron job purges objects older than 24h via the Storage
-- REST API. It must NOT use a bare `delete from storage.objects`: that removes only the
-- metadata row and ORPHANS the underlying S3 bytes — the personal data (a zip may carry
-- photos of people) would survive, defeating the retention commitment. The Storage REST
-- DELETE goes through the storage service, which removes BOTH the bytes and the row.
-- DB-native (not an n8n schedule) per ADR-048 Decision 5 and the event-driven-n8n
-- principle. Append-only (CLAUDE.md).
--
-- SCHEDULE NOTE (deliberate deviation from the ADR's literal "daily" wording):
-- this runs HOURLY, not daily. A *daily* purge of ">24h" objects yields up to ~48h
-- worst-case lifetime (an object created just after a run waits ~a day to become
-- eligible, then ~another day until the next run actually deletes it). That breaks the
-- "24h retention" the GDPR record (compliance/gdpr-processing-decisions.md §6) commits
-- to. Hourly + ">24h" caps real lifetime at ~25h, making the 24h statement honest. Cost
-- is trivial: a no-op run is a single indexed COUNT over a small bucket. To revert to
-- daily, change the cron expression at the bottom to '0 3 * * *'.
--
-- SECRET (not stored here — never commit secrets, CLAUDE.md): the Storage REST call
-- needs a service_role-class key (bypasses RLS on the private bucket). The function
-- reads it from Supabase Vault by name 'service_role_key'. One-time operator step, run
-- out of band (NOT in a committed migration), e.g. from the SQL editor:
--   select vault.create_secret('<SERVICE_ROLE_KEY>', 'service_role_key',
--     'Storage purge: service_role key for DELETE /storage/v1/object on zip-inner-images');
-- If the secret is absent the function does NOT crash and does NOT silently no-op: it
-- writes a SKIPPED row to storage_purge_runs, and the independent n8n freshness watchdog
-- ("Zip Image Purge Watchdog (v1)") alerts on the resulting stale buildup.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Observability log: one row per purge invocation. Lets the operator and the
-- Definition-of-Done check see the job is firing and what it dispatched, without
-- decoding cron.job_run_details alone. Per-call HTTP outcomes land in net._http_response
-- keyed by the request_ids recorded here.
create table if not exists public.storage_purge_runs (
  id               bigint generated always as identity primary key,
  ran_at           timestamptz not null default now(),
  bucket           text        not null,
  candidate_count  integer,                         -- stale objects found (null = could not run)
  dispatched_count integer     not null default 0,  -- Storage DELETE calls fired this run
  request_ids      bigint[]    not null default '{}', -- pg_net ids -> net._http_response
  note             text
);
comment on table public.storage_purge_runs is
  'ADR-048 Block 4: audit log of the zip-inner-images 24h pg_cron purge (one row per run).';

create or replace function public.purge_zip_inner_images()
returns void
language plpgsql
security definer
set search_path = public, extensions, net, vault
as $$
declare
  v_key        text;
  v_base       text     := 'https://hkeslnosxibeuesxndnz.supabase.co';
  v_bucket     text     := 'zip-inner-images';
  v_max_age    interval := interval '24 hours';
  v_batch      integer  := 200;            -- bound per-run work on the shared 8 GB box
  v_obj        record;
  v_req        bigint;
  v_ids        bigint[] := '{}';
  v_candidates integer  := 0;
  v_dispatched integer  := 0;
begin
  v_key := (select decrypted_secret from vault.decrypted_secrets
            where name = 'service_role_key' limit 1);

  -- Missing secret = observable, not silent. Row records the skip; the watchdog
  -- will catch the stale buildup that follows.
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
    -- DELETE /storage/v1/object/{bucket}/{key} routes through the storage service,
    -- which deletes BOTH the S3 bytes and the storage.objects row (the point: free the
    -- bytes, not orphan them). Object keys are <task_id>/<sanitized att_id> — URL-safe
    -- [A-Za-z0-9._-] segments joined by '/', so no percent-encoding is needed.
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
    case when v_candidates = 0       then 'nothing to purge'
         when v_candidates >= v_batch then 'batch cap hit — backlog drains over subsequent hourly runs'
         else 'ok' end);
end;
$$;

comment on function public.purge_zip_inner_images() is
  'ADR-048 Block 4: delete >24h objects from the zip-inner-images bucket via Storage REST (frees bytes, not just the row). Reads the service_role key from Vault; logs each run to storage_purge_runs.';

-- Hourly schedule (see SCHEDULE NOTE). Idempotent: drop any prior definition first so a
-- re-apply does not stack duplicate jobs.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'purge-zip-inner-images') then
    perform cron.unschedule('purge-zip-inner-images');
  end if;
end $$;

select cron.schedule(
  'purge-zip-inner-images',
  '0 * * * *',
  $cron$ select public.purge_zip_inner_images(); $cron$
);
