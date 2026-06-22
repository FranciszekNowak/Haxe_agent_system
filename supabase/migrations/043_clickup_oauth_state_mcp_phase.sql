-- 043_clickup_oauth_state_mcp_phase.sql
-- ADR-054 Block 1 FINISH (Option A): extend clickup_oauth_state to carry the SECOND (MCP-OAuth) consent.
--
-- Onboarding now chains TWO browser consents in one flow (two separate ClickUp OAuth servers):
--   PHASE 'classic'  -> app.clickup.com/api  -> classic REST token (identity + Block-4 extraction, stored in
--                       Supabase Vault via 042). This is the existing flow; its state rows default to phase
--                       'classic' and use only (state, created_at), unchanged.
--   PHASE 'mcp'      -> mcp.clickup.com/oauth/* (DCR + PKCE, public client) -> MCP-OAuth token (discovery,
--                       stored as a static_bearer in the user's Anthropic Vault).
--
-- The MCP phase is a PKCE authorization-code flow, so the code_verifier minted before the /oauth/authorize
-- redirect must survive until the /clickup-mcp-callback token exchange. The dynamically-registered public
-- client_id (DCR, per onboarding) must survive too. And because the MCP-OAuth token is 401 on ClickUp REST
-- (probe) it CANNOT re-identify the user, so the consenting user's identity (resolved by the classic phase's
-- REST GET /user) is carried forward on the mcp-phase state row and read back at the mcp callback to key the
-- Anthropic Vault + mapping row.
--
-- PROPERTY CHANGE vs migration 041: 041 stated "no PII, no token". That still holds for classic-phase rows.
-- An mcp-phase row now carries transient identity (clickup_user_id + username + email) for < 15 min, single-use,
-- deleted atomically at the callback. It still carries NO token (the REST token is already in Supabase Vault;
-- the MCP token does not exist until after this row is consumed). code_verifier is a PKCE secret, but it is
-- useless without the matching authorization code delivered to our own registered redirect_uri, and the row is
-- single-use + short-lived. RLS stays enabled, no policy (API roles denied; the pipeline's Postgres role
-- bypasses). Append-only migration (CLAUDE.md): additive columns + a phase check, no rewrite of 041.

alter table clickup_oauth_state
  add column if not exists phase            text not null default 'classic',
  add column if not exists code_verifier    text,
  add column if not exists mcp_client_id    text,
  add column if not exists clickup_user_id  text,
  add column if not exists clickup_username text,
  add column if not exists clickup_email    text;

-- Guard the two known phases (defensive; the classic mint omits phase and defaults correctly).
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'clickup_oauth_state_phase_chk') then
    alter table clickup_oauth_state
      add constraint clickup_oauth_state_phase_chk check (phase in ('classic','mcp'));
  end if;
end $$;

comment on table clickup_oauth_state is
  'ADR-054 Block 1: single-use, short-lived CSRF state for the chained ClickUp OAuth onboarding flow. phase=classic rows (default) carry only state+created_at (no PII, no token). phase=mcp rows additionally carry the PKCE code_verifier, the DCR public client_id, and the consenting user''s transient identity (user_id/username/email) so the mcp callback can mint + place the discovery token without re-identifying via REST (the MCP token is 401 on REST). No token is ever stored. INSERTed at each redirect, DELETEd atomically at the matching callback within 15 min. RLS enabled, no policy.';
