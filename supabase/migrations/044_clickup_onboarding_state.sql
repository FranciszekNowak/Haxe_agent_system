-- 044_clickup_onboarding_state.sql
-- ADR-054 Block 6: onboarding-coverage read for the ClickUp Onboarding Coverage Monitor (v1).
--
-- WHY THIS EXISTS. Block 6 adds a proactive dead-man's-switch that WARNs when an ACTIVE, FULL ClickUp
-- member (not a guest) is missing EITHER per-user ClickUp token, so a person is never silently left
-- un-scoped (the per-session degrade WARN only fires once they actually trigger the agent). The monitor
-- must know, per ClickUp user id, whether they currently have (a) an active MCP-OAuth DISCOVERY credential
-- and (b) a classic REST EXTRACTION token. Those two facts live in two different stores:
--   * MCP discovery  -> a row in public.user_clickup_credentials (status = 'active'); the Anthropic Vault
--                       holds the actual token, n8n only needs the id set.
--   * REST extraction -> a Supabase Vault secret named 'clickup_rest_token_<clickup_user_id>' (migration 042).
-- vault.secrets is not readable by the pipeline's API role, so a SECURITY DEFINER getter is required, exactly
-- as for get_clickup_rest_token. This function returns ONLY the id sets (which users have which token) and
-- NEVER any token value, so it is safe to surface in an alert.
--
-- Mirrors the house getter pattern (migration 042 / 034): SECURITY DEFINER, search_path pinned to public+vault,
-- EXECUTE revoked from public/anon/authenticated and granted ONLY to service_role (the role the pipeline
-- connects as; owner postgres executes inherently). Append-only (CLAUDE.md).

create or replace function public.get_clickup_onboarding_state()
returns jsonb
language sql
security definer
set search_path = public, vault
as $$
  select jsonb_build_object(
    'mcp_ids',  coalesce(
                  (select jsonb_agg(clickup_user_id)
                     from public.user_clickup_credentials
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
  'ADR-054 Block 6: returns {mcp_ids:[clickup_user_id...], rest_ids:[clickup_user_id...]} for the onboarding-coverage monitor - which users have an active MCP discovery credential (user_clickup_credentials) and which have a classic REST token (vault secret clickup_rest_token_<id>). Returns ids only, never token values. SECURITY DEFINER; EXECUTE only service_role.';
