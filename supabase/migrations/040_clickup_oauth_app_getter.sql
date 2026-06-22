-- 040_clickup_oauth_app_getter.sql
-- ADR-054 Block 1: SECURITY DEFINER getter exposing the ClickUp OAuth app credentials
-- (client_id + client_secret) from Supabase Vault to the pipeline's Postgres role, so the
-- onboarding/consent flow can perform the OAuth code->token exchange
-- (POST https://api.clickup.com/api/v2/oauth/token, which requires client_id + client_secret + code).
-- Exact mirror of get_anthropic_key() (migration 034) / get_litellm_image_key() (032), but returns
-- BOTH values as one jsonb object (one round-trip; the exchange needs both together).
--
-- client_id is only semi-secret, but both live in the Vault so there is a SINGLE source of truth for
-- the app credentials (not a copy scattered in someone's local env), and so a future n8n-hosted
-- onboarding webhook can read them the same way every other secret is read on this CE (Code nodes
-- can't use n8n credentials; $env/$vars are unavailable — CLAUDE.md).
--
-- The secret VALUES are NOT seeded by this migration (never commit a credential). Seed them ONCE,
-- after Franciszek registers the OAuth app, with:
--   select vault.create_secret('<CLICKUP_CLIENT_ID>',     'clickup_oauth_client_id',
--          'ClickUp OAuth app client_id (ADR-054)');
--   select vault.create_secret('<CLICKUP_CLIENT_SECRET>', 'clickup_oauth_client_secret',
--          'ClickUp OAuth app client_secret (ADR-054)');
-- Rotate by updating those secrets; nothing else changes.
--
-- Locked down: EXECUTE revoked from public/anon/authenticated (NOT a PostgREST RPC), granted only to
-- service_role (the privileged backend role the pipeline connects as; owner postgres executes
-- inherently). Append-only (CLAUDE.md).

create or replace function public.get_clickup_oauth_app()
returns jsonb
language sql
security definer
set search_path = public, vault
as $$
  select jsonb_build_object(
    'client_id',     (select decrypted_secret from vault.decrypted_secrets where name = 'clickup_oauth_client_id'     limit 1),
    'client_secret', (select decrypted_secret from vault.decrypted_secrets where name = 'clickup_oauth_client_secret' limit 1)
  );
$$;

revoke all on function public.get_clickup_oauth_app() from public;
revoke all on function public.get_clickup_oauth_app() from anon;
revoke all on function public.get_clickup_oauth_app() from authenticated;
grant execute on function public.get_clickup_oauth_app() to service_role;

comment on function public.get_clickup_oauth_app() is
  'ADR-054: returns {client_id, client_secret} of the ClickUp OAuth app from the Vault for the onboarding code->token exchange. SECURITY DEFINER; EXECUTE granted only to service_role (revoked from anon/authenticated -> not a public PostgREST RPC).';
