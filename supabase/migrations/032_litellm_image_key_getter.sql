-- 032_litellm_image_key_getter.sql
-- ADR-051: SECURITY DEFINER getter exposing ONLY the litellm_image_key Vault secret to the
-- pipeline's Postgres role, so the parallel image batch (Generate Images Parallel v1) can read it
-- via a credentialed Postgres node. Code nodes can't use n8n credentials, and $env/$vars are
-- unavailable on this self-hosted community edition (CLAUDE.md), so a credentialed Postgres read
-- of a Vault secret is how a workflow obtains a secret here. Mirrors the zip-purge function's
-- vault.decrypted_secrets read (migrations 029/030, ADR-046/048).
--
-- Locked down: EXECUTE is revoked from public/anon/authenticated so this is NOT reachable as a
-- PostgREST RPC by the API roles, and granted only to service_role (the privileged backend role
-- the pipeline connects as; the owner postgres can execute inherently). Append-only (CLAUDE.md).

create or replace function public.get_litellm_image_key()
returns text
language sql
security definer
set search_path = public, vault
as $$
  select decrypted_secret from vault.decrypted_secrets where name = 'litellm_image_key' limit 1;
$$;

revoke all on function public.get_litellm_image_key() from public;
revoke all on function public.get_litellm_image_key() from anon;
revoke all on function public.get_litellm_image_key() from authenticated;
grant execute on function public.get_litellm_image_key() to service_role;

comment on function public.get_litellm_image_key() is
  'ADR-051: returns the decrypted litellm_image_key Vault secret for the parallel image batch (Generate Images Parallel v1). SECURITY DEFINER; EXECUTE granted only to service_role (revoked from anon/authenticated -> not a public PostgREST RPC).';
