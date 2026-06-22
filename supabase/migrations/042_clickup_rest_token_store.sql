-- 042_clickup_rest_token_store.sql
-- ADR-054 Block 1 FINISH (Option A): per-user ClickUp *classic REST* OAuth token store + getter.
--
-- WHY THIS EXISTS (the two-token split). Option A (master plan "ARCHITECTURE LOCKED") uses TWO different
-- ClickUp OAuth tokens per user, from TWO different OAuth servers, because three live probes proved they are
-- not interchangeable:
--   * DISCOVERY rides ClickUp's hosted MCP (mcp.clickup.com/mcp), which is its OWN OAuth 2.1 server and only
--     accepts a token its own flow minted. That MCP-OAuth token is stored in the user's Anthropic Vault as a
--     static_bearer (the harness injects it per session) — NOT here.
--   * EXTRACTION (Block 4: turn a task's file attachments into text/vision) is REST-only — the hosted MCP
--     returns no attachment metadata or content (Block-0 finding f). It runs ClickUp REST `GET /api/v2/task/{id}`
--     AS the user, which needs the user's CLASSIC REST OAuth token. That token is 401 on the MCP and the MCP
--     token is 401 on REST (probe), so the REST token cannot live in the Anthropic Vault usefully and n8n
--     cannot read a token back out of the Anthropic Vault anyway (proxied, by design). It lives HERE.
--
-- The onboarding webhook mints the classic REST token (it already does, to identify the user via GET /user) and
-- now also persists it via set_clickup_rest_token() so Block 4's client-side extraction tool can read it back
-- by caller_user_id. The session loop (NOT via vault_ids) looks it up with get_clickup_rest_token().
--
-- STORAGE = Supabase Vault (vault.secrets, encrypted at rest), one secret per user named
-- 'clickup_rest_token_<clickup_user_id>'. Per-user secrets (not one shared JSON blob) so revoke deletes exactly
-- one secret by name. This is the deliberate "second authoritative token store" Option A accepts; because
-- ClickUp tokens DO NOT EXPIRE (Block-0 reshape 1), it only ever changes on onboard / revoke — there is no
-- refresh cadence to drift, so NO token-sync dead-man's-switch is required (the heavy Variant-B fear is retired).
--
-- Both functions mirror the house getter pattern (get_anthropic_key / migration 034): SECURITY DEFINER,
-- search_path pinned to public+vault, EXECUTE revoked from public/anon/authenticated and granted ONLY to
-- service_role (the privileged backend role the pipeline connects as; owner postgres executes inherently).
-- Append-only (CLAUDE.md). The token VALUE is never returned to any API role and never logged.

-- Writer: create-or-update the per-user REST token secret. Idempotent (re-onboard overwrites in place).
create or replace function public.set_clickup_rest_token(p_user_id text, p_token text)
returns void
language plpgsql
security definer
set search_path = public, vault
as $$
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

revoke all on function public.set_clickup_rest_token(text, text) from public;
revoke all on function public.set_clickup_rest_token(text, text) from anon;
revoke all on function public.set_clickup_rest_token(text, text) from authenticated;
grant execute on function public.set_clickup_rest_token(text, text) to service_role;

comment on function public.set_clickup_rest_token(text, text) is
  'ADR-054 Block 1: create-or-update the per-user ClickUp classic REST OAuth token in Supabase Vault (secret clickup_rest_token_<user_id>), written by the onboarding webhook. SECURITY DEFINER; EXECUTE only service_role. Idempotent; tokens don''t expire so changes only on onboard/revoke.';

-- Reader: return the decrypted REST token for Block 4's as-U extraction (looked up by caller_user_id).
create or replace function public.get_clickup_rest_token(p_user_id text)
returns text
language sql
security definer
set search_path = public, vault
as $$
  select decrypted_secret from vault.decrypted_secrets where name = 'clickup_rest_token_' || p_user_id limit 1;
$$;

revoke all on function public.get_clickup_rest_token(text) from public;
revoke all on function public.get_clickup_rest_token(text) from anon;
revoke all on function public.get_clickup_rest_token(text) from authenticated;
grant execute on function public.get_clickup_rest_token(text) to service_role;

comment on function public.get_clickup_rest_token(text) is
  'ADR-054 Block 4: returns the decrypted per-user ClickUp classic REST OAuth token from Supabase Vault for as-U REST extraction (GET /api/v2/task/{id} as the caller). SECURITY DEFINER; EXECUTE only service_role (not a PostgREST RPC). Null if the user has no stored REST token.';
