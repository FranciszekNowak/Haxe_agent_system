-- 039_user_clickup_credentials.sql
-- ADR-054 Block 1: per-user ClickUp credential mapping for permission-scoped context retrieval.
--
-- The managed lane reads ClickUp through a single Member bot token today (cred QRrgf6hteyGWSJyv),
-- so the only thing keeping open-ended discovery inside the caller's permissions is a software
-- membership filter (workspace-search's Check Space Member) — the post-hoc filtering ADR-054 R3
-- rejects. ADR-054 moves enforcement onto the CREDENTIAL: each team member's own ClickUp OAuth
-- access token is stored as a static_bearer credential in a PER-USER Anthropic Vault, and a session
-- attaches only the triggering user's vault, so every scoped ClickUp call is bounded by what that
-- human can see. This table maps the ClickUp user to that vault.
--
-- WHY ONE VAULT PER USER (not a shared vault): an Anthropic Vault credential is keyed by
-- mcp_server_url, and two credentials with the same mcp_server_url in one vault return HTTP 409
-- (Block-0 finding, proven live in ma-spike-clickup-vault.py). Every user's ClickUp credential keys
-- to the same URL (https://mcp.clickup.com/mcp), so they cannot coexist in one vault — each user
-- gets a vault of their own. Block 2 builds vault_ids = [image_mcp_vault_id, <this user's vault_id>].
--
-- WHY ONE vault_id COLUMN (the master plan named clickup_mcp_vault_id + readinput_mcp_vault_id):
-- both per-user credentials (the scoped ClickUp MCP now; the read-input MCP added in Block 4 under
-- Variant A) key to DIFFERENT mcp_server_urls, so they live in the SAME per-user vault with no 409.
-- The plan's two vault columns therefore collapse to one vault_id (documented divergence, unification
-- rule: one path unless divergence is justified — here there is no reason for two vaults). The per-URL
-- credential ids are recorded in vault_credential_ids so revoke can delete each by id.
--
-- TOKEN MODEL (Block-0 reshape 1): ClickUp OAuth access tokens DO NOT EXPIRE, issue NO refresh token,
-- and carry NO granular scopes. So there is no refresh cadence and no rotation: the only lifecycle
-- transitions are ONBOARD (insert row + create credential) and REVOKE/RE-CONSENT (flip status, delete
-- + re-create credential). refreshed_at and the 'expired' status are kept for forward-compat ONLY
-- (ClickUp's docs hedge "subject to change") and are inert under today's non-expiring tokens — there
-- is deliberately no refresh dead-man's-switch (nothing to monitor). The token VALUE itself never
-- lives here; it is write-only in the Anthropic Vault.
--
-- clickup_user_id IS the caller_user_id the pipeline already carries (the ClickUp member id the
-- CU Webhook Producer puts on every run), so Block 2 resolves
--   select vault_id, vault_credential_ids from user_clickup_credentials
--   where clickup_user_id = <caller_user_id> and status = 'active';
--
-- RLS: ENABLED with NO policy (mirrors agent_input_file_map / migration 036, and 007). This row
-- carries an email + a credential mapping, so the anon/authenticated PostgREST roles must be denied;
-- the pipeline connects with the privileged Postgres role, which bypasses RLS. (Deliberately NOT the
-- agent_routing pattern, which left RLS off and is flagged critical by the Supabase advisor.)
-- Append-only (CLAUDE.md).

create table if not exists user_clickup_credentials (
  clickup_user_id       text primary key,                          -- = caller_user_id (ClickUp member id)
  clickup_username      text,
  clickup_email         text,
  vault_id              text not null,                             -- per-user Anthropic Vault holding this user's scoped MCP credential(s)
  vault_credential_ids  jsonb not null default '{}'::jsonb,        -- { "<mcp_server_url>": "<credential_id>" } — for targeted revoke
  status                text not null default 'active'
                          check (status in ('active','revoked','expired')),
  consented_at          timestamptz not null default now(),
  refreshed_at          timestamptz,                               -- inert: ClickUp tokens don't expire (Block-0); kept for forward-compat
  revoked_at            timestamptz,
  updated_at            timestamptz not null default now()
);

comment on table user_clickup_credentials is
  'ADR-054 Block 1: clickup_user_id (= caller_user_id) -> per-user Anthropic Vault holding that user''s ClickUp OAuth access token as a static_bearer credential keyed to https://mcp.clickup.com/mcp (and, from Block 4, the read-input MCP). Enforces departmental scope on the credential, not the agent. Tokens don''t expire (no refresh); lifecycle = onboard + revoke only. The token value is never stored here (write-only in the Vault). RLS enabled, no policy: API roles denied, the pipeline''s Postgres role bypasses.';

alter table user_clickup_credentials enable row level security;
