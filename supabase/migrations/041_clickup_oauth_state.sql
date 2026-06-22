-- 041_clickup_oauth_state.sql
-- ADR-054 Block 1: short-lived CSRF state for the hosted ClickUp OAuth onboarding flow
-- (n8n "ClickUp OAuth Onboarding (v1)", redirect_uri https://agents.haxe.ai/webhook/clickup-oauth-callback).
--
-- The OAuth authorization-code flow needs a `state` value that is issued when the user starts consent and
-- verified when ClickUp redirects back, to defend against CSRF / forged callbacks. We store it rather than
-- sign it because the existing house pattern for a transient webhook claim is exactly this — a tiny table
-- claimed/consumed atomically (cf. agent_webhook_dedup, ADR-029) — and it is more inspectable than a Crypto
-- node HMAC dance for a 5-person, rare onboarding event.
--
-- Lifecycle: the /clickup-oauth-start endpoint INSERTs a row (state defaults to a random uuid) and redirects
-- the browser to ClickUp with that state; the /clickup-oauth-callback endpoint DELETEs the row matching the
-- returned state within a 15-minute freshness window (single-use). Rows older than the window are inert and
-- safe to prune at any time (this is operational state, not data — like agent_webhook_dedup, it carries no
-- PII and no token).
--
-- RLS: ENABLED, no policy (mirror agent_input_file_map/036): the anon/authenticated PostgREST roles get
-- nothing; the pipeline's privileged Postgres role bypasses RLS. Append-only migration (CLAUDE.md).

create table if not exists clickup_oauth_state (
  state       text primary key default gen_random_uuid()::text,
  created_at  timestamptz not null default now()
);

comment on table clickup_oauth_state is
  'ADR-054 Block 1: single-use, short-lived CSRF state for the hosted ClickUp OAuth onboarding flow. INSERTed by /clickup-oauth-start, DELETEd by /clickup-oauth-callback within 15 min. No PII, no token; prunable. RLS enabled, no policy.';

alter table clickup_oauth_state enable row level security;
