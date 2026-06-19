-- 037_agent_output_images_purge.sql
-- ADR-053/ADR-055 Block 6: 24h retention purge for the private bucket
-- `agent-output-images`. This bucket is the delivery-bytes CARRIER for images the
-- agent produces: Files-API uploads are purpose=agent (NOT downloadable, Block 0) and
-- on the MCP image path the produced bytes never return to n8n (Block 5.2/5.3), so
-- `Image Tool Handler (v1)` also persists each produced image's bytes here keyed by its
-- Files-API file_id, and `Render Agent Output (v1)` fetches them back for ClickUp
-- delivery. The bytes only need to outlive a single orchestrator run (the output adapter
-- delivers minutes after generation), so a 24h TTL is a generous safety margin while
-- keeping agent-produced images (which may contain personal data) short-lived for GDPR
-- data-minimisation. Append-only (CLAUDE.md): a new function + cron; does NOT touch the
-- zip-inner purge (029/030).
--
-- Mirrors the zip-inner purge mechanics exactly: Supabase has no native object
-- lifecycle, so a DB-native pg_cron job DELETEs >24h objects via the Storage REST API.
-- It must NOT use a bare `delete from storage.objects` (that orphans the underlying S3
-- bytes); the Storage REST DELETE routes through the storage service and removes BOTH
-- the bytes and the row. Reuses the shared `storage_purge_runs` audit table (the
-- `bucket` column separates the two purges) and the same `service_role_key` Vault secret
-- (one-time operator seed, already present for the zip purge — see 029). If the secret
-- is absent the function records a SKIPPED row rather than crashing or silently no-op'ing.
--
-- SCHEDULE: HOURLY + ">24h" caps real object lifetime at ~25h, making "24h retention"
-- honest (a daily run would allow ~48h worst case). Trivial cost: a no-op run is one
-- indexed COUNT over a small bucket.

create extension if not exists pg_cron;
create extension if not exists pg_net;

create or replace function public.purge_agent_output_images()
returns void
language plpgsql
security definer
set search_path = public, extensions, net, vault
as $$
declare
  v_key        text;
  v_base       text     := 'https://hkeslnosxibeuesxndnz.supabase.co';
  v_bucket     text     := 'agent-output-images';
  v_max_age    interval := interval '24 hours';
  v_batch      integer  := 200;            -- bound per-run work on the shared box
  v_obj        record;
  v_req        bigint;
  v_ids        bigint[] := '{}';
  v_candidates integer  := 0;
  v_dispatched integer  := 0;
begin
  v_key := (select decrypted_secret from vault.decrypted_secrets
            where name = 'service_role_key' limit 1);

  -- Missing secret = observable, not silent. Row records the skip; the existing
  -- Zip Image Purge Watchdog pattern / a stale buildup is the catch.
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
    -- DELETE /storage/v1/object/{bucket}/{key} routes through the storage service, which
    -- removes BOTH the S3 bytes and the storage.objects row. Keys are Files-API file_ids
    -- (URL-safe [A-Za-z0-9_]) so no percent-encoding is needed.
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

  -- pg_net is async: this records what was DISPATCHED, not the HTTP outcome (that lands
  -- in net._http_response keyed by request_ids).
  insert into public.storage_purge_runs(bucket, candidate_count, dispatched_count, request_ids, note)
  values (v_bucket, v_candidates, v_dispatched, v_ids,
    case when v_candidates = 0        then 'nothing to purge (no objects older than 24h)'
         when v_candidates >= v_batch then 'batch cap hit - backlog drains over subsequent hourly runs'
         else format('dispatched %s Storage DELETE(s); HTTP result is ASYNC - confirm via net._http_response', v_dispatched)
    end);
end;
$$;

comment on function public.purge_agent_output_images() is
  'ADR-053/055 Block 6: delete >24h objects from the agent-output-images delivery-bytes carrier bucket via Storage REST (frees bytes, not just the row). Hourly pg_cron => real lifetime <=~25h. Reads the service_role key from Vault; logs each run to storage_purge_runs (shared with the zip purge, separated by the bucket column).';

-- Hourly. Idempotent: drop any prior definition first so a re-apply does not stack jobs.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'purge-agent-output-images') then
    perform cron.unschedule('purge-agent-output-images');
  end if;
end $$;

select cron.schedule(
  'purge-agent-output-images',
  '0 * * * *',
  $cron$ select public.purge_agent_output_images(); $cron$
);
