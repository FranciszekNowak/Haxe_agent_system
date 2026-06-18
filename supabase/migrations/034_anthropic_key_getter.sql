-- 034_anthropic_key_getter.sql
-- ADR-053 Block 1: SECURITY DEFINER getter exposing ONLY the anthropic_api_key Vault secret to the
-- pipeline's Postgres role, so the Managed Agents lane (Execute Agent Session v1, the image-tool
-- handler, the auth monitor) can read the raw Anthropic API key via a credentialed Postgres node.
-- The agentic lane calls api.anthropic.com directly (the Agents/Sessions/Files surface is Anthropic-
-- native, not OpenAI-compatible, so LiteLLM cannot proxy it — Block 0 finding), and n8n Code nodes
-- can't use n8n credentials, while $env/$vars are unavailable on this self-hosted community edition
-- (CLAUDE.md). A credentialed Postgres read of a Vault secret is how a workflow obtains a secret here.
-- Exact mirror of get_litellm_image_key() (migration 032, ADR-051).
--
-- The secret VALUE is NOT seeded by this migration (never commit a credential). Seed it once with:
--   select vault.create_secret('<ANTHROPIC_API_KEY>', 'anthropic_api_key',
--          'Anthropic API key for the Managed Agents lane (ADR-053)');
-- (the same raw key already in the VPS .env as ANTHROPIC_API_KEY, which Block 0 confirmed has
-- Managed Agents beta access). Rotate by updating that secret; nothing else changes.
--
-- Locked down: EXECUTE revoked from public/anon/authenticated (NOT a PostgREST RPC), granted only to
-- service_role (the privileged backend role the pipeline connects as; owner postgres executes
-- inherently). Append-only (CLAUDE.md).

create or replace function public.get_anthropic_key()
returns text
language sql
security definer
set search_path = public, vault
as $$
  select decrypted_secret from vault.decrypted_secrets where name = 'anthropic_api_key' limit 1;
$$;

revoke all on function public.get_anthropic_key() from public;
revoke all on function public.get_anthropic_key() from anon;
revoke all on function public.get_anthropic_key() from authenticated;
grant execute on function public.get_anthropic_key() to service_role;

comment on function public.get_anthropic_key() is
  'ADR-053: returns the decrypted anthropic_api_key Vault secret for the Managed Agents lane (direct api.anthropic.com calls). SECURITY DEFINER; EXECUTE granted only to service_role (revoked from anon/authenticated -> not a public PostgREST RPC).';
