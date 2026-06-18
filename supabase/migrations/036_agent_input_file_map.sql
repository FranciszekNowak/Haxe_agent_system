-- 036_agent_input_file_map.sql
-- ADR-055 Block 5.2: image generation via a self-hosted MCP server.
--
-- Three additive pieces for the image MCP path (append-only, CLAUDE.md):
--
-- 1) agent_input_file_map — a GLOBAL, session-context-free mapping
--    file_id -> {url, mime, source_ref}. Written by Upload Input Images (v1)
--    (Block 3) after each successful Files-API upload; read by the image MCP tool
--    handler to resolve a generate_image call's reference_file_ids -> the original
--    signed URLs (Generate Images Parallel needs URLs, ADR-052 reference_urls[]).
--    The MCP host (n8n MCP Server Trigger) does NOT surface session/correlation
--    context to the tool (Block 5.1 finding), and Anthropic input files are not
--    downloadable (Block 0), so resolving references via OUR own signed URL through
--    this table is required — it needs no session id (ADR-055 §4, a robustness
--    property). Signed URLs only live as long as a session (≤ the 840s soft-deadline);
--    rows are pruned on a 24h TTL (piece 3) to bound storage of signed URLs that can
--    point at personal-data images (GDPR data-minimisation).
--
-- 2) get_image_mcp_bearer() — SECURITY DEFINER getter for the fixed service bearer
--    token that authenticates the image MCP endpoint (ADR-055 §5: image generation
--    is identity-neutral, so a single service token is correct — no per-user scope).
--    Mirrors get_anthropic_key() (034). In Block 5.2 the n8n MCP Server Trigger
--    validates the token via its own n8n credential; this getter is the rotation
--    record and the source Block 5.3 reads to mirror the token into the Anthropic
--    Vault attached to the agents' mcp_servers entry. The token VALUE is NOT seeded
--    here (never commit a credential) — see the one-time seed note below.
--
-- 3) A 24h TTL prune (pg_cron) for agent_input_file_map + an audit log, mirroring the
--    storage_purge_runs / pg_cron pattern (029/030). Synchronous DELETE, so unlike the
--    zip purge (async pg_net) the row count IS authoritative; cron.job_run_details
--    additionally records firing/success.
--
-- Plus: extend agent_runs.triggered_by to accept 'image_mcp' — the per-image cost rows
-- written by Generate Images Parallel (behind the MCP handler) carry no real trigger
-- context (the harness passes none), so they are tagged 'image_mcp' for honest,
-- separable cost attribution rather than borrowing a misleading enum like
-- 'explicit_mention'.

-- ---------------------------------------------------------------------------
-- triggered_by: add 'image_mcp' (append-only; supersedes the prior constraint =
-- 009's list widened by 023's 'image_gen'; both are preserved here)
-- ---------------------------------------------------------------------------
alter table agent_runs drop constraint agent_runs_triggered_by_check;

alter table agent_runs add constraint agent_runs_triggered_by_check
  check (triggered_by = any (array[
    'webhook_status_change',
    'webhook_field_change',
    'due_date_daily',
    'gmail_incoming',
    'gmail_sent_analysis',
    'weekly_proposer',
    'per_task_proposer',
    'explicit_mention',
    'explicit_command',
    'conversation_reply',
    'reset_restart',
    'search_step',
    'image_gen',
    'image_mcp'
  ]));

-- ---------------------------------------------------------------------------
-- 1) agent_input_file_map
-- ---------------------------------------------------------------------------
create table if not exists public.agent_input_file_map (
  file_id     text primary key,            -- Anthropic Files-API id ('file_…') returned by Upload Input Images (v1)
  url         text not null,               -- the original signed source URL (ClickUp pre-signed or Supabase-signed)
  mime        text,                        -- image mime (image/jpeg, image/png, …)
  source_ref  text,                        -- provenance (ClickUp attachment id / zip-inner key / order index)
  created_at  timestamptz not null default now()
);

comment on table public.agent_input_file_map is
  'ADR-055 Block 5.2: global file_id -> {url,mime,source_ref} map, written by Upload Input Images (v1) after each Files-API upload, read by the image MCP tool handler to resolve generate_image reference_file_ids -> signed URLs WITHOUT session context (the MCP host surfaces none; Anthropic input files are not downloadable). 24h TTL prune (signed URLs only need to outlive a session). RLS enabled, no policy: API roles denied; the pipeline''s direct Postgres role bypasses RLS (mirrors 007).';

-- Signed URLs can point at personal-data images, so this table is locked down harder
-- than agent_routing (which has no RLS): RLS ON with NO policy denies all PostgREST
-- (anon/authenticated) access while the pipeline's direct Postgres role bypasses it.
alter table public.agent_input_file_map enable row level security;

-- ---------------------------------------------------------------------------
-- 2) get_image_mcp_bearer() — Vault getter for the MCP service bearer token
-- ---------------------------------------------------------------------------
-- Seed the token VALUE once, out of band (NOT in a committed migration), e.g.:
--   select vault.create_secret('<RANDOM_BEARER_TOKEN>', 'image_mcp_bearer_token',
--     'Bearer token authenticating the self-hosted image MCP endpoint (ADR-055)');
-- Rotate by updating that secret + the n8n MCP-trigger credential + (Block 5.3) the
-- Anthropic Vault entry attached to the agents' mcp_servers.
create or replace function public.get_image_mcp_bearer()
returns text
language sql
security definer
set search_path = public, vault
as $$
  select decrypted_secret from vault.decrypted_secrets where name = 'image_mcp_bearer_token' limit 1;
$$;

revoke all on function public.get_image_mcp_bearer() from public;
revoke all on function public.get_image_mcp_bearer() from anon;
revoke all on function public.get_image_mcp_bearer() from authenticated;
grant execute on function public.get_image_mcp_bearer() to service_role;

comment on function public.get_image_mcp_bearer() is
  'ADR-055: returns the decrypted image_mcp_bearer_token Vault secret (the image MCP endpoint''s service bearer). SECURITY DEFINER; EXECUTE granted only to service_role (revoked from anon/authenticated -> not a public PostgREST RPC). Mirrors get_anthropic_key() (034).';

-- ---------------------------------------------------------------------------
-- 3) 24h TTL prune + audit log + pg_cron
-- ---------------------------------------------------------------------------
create extension if not exists pg_cron;

create table if not exists public.agent_input_file_map_prune_runs (
  id            bigint generated always as identity primary key,
  ran_at        timestamptz not null default now(),
  deleted_count integer not null default 0,
  note          text
);
comment on table public.agent_input_file_map_prune_runs is
  'ADR-055 Block 5.2: audit log of the agent_input_file_map 24h TTL prune (one row per run). Synchronous DELETE so deleted_count is authoritative (unlike the async zip purge).';

alter table public.agent_input_file_map_prune_runs enable row level security;

create or replace function public.prune_agent_input_file_map()
returns void
language plpgsql
security definer
set search_path = public
as $$
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

comment on function public.prune_agent_input_file_map() is
  'ADR-055 Block 5.2: delete agent_input_file_map rows older than 24h (signed URLs only need to outlive a session); logs each run to agent_input_file_map_prune_runs. Hourly pg_cron => real lifetime <=~25h.';

-- Hourly. Idempotent: drop any prior definition first so a re-apply doesn't stack jobs.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'prune-agent-input-file-map') then
    perform cron.unschedule('prune-agent-input-file-map');
  end if;
end $$;

select cron.schedule(
  'prune-agent-input-file-map',
  '0 * * * *',
  $cron$ select public.prune_agent_input_file_map(); $cron$
);
