# ADR-054 Block 1 — OAuth app + per-user token storage (findings + status)

**Status: SCAFFOLD COMPLETE, OPERATOR-GATED REMAINDER PENDING (2026-06-22).** Everything that does not
require the live OAuth app is built, applied, and verified. The remainder — register the OAuth app, seed
its secrets, onboard two cross-department users, run the negative smoke — is gated on a Workspace
owner/admin action only Franciszek can take (Block-0 finding (e): app creation is owner/admin-only), and is
written up under "Operator-gated remainder" below.

## What was built and verified live this block

- **Migration 039 — `user_clickup_credentials`** (applied to `haxe-agent-prod` `hkeslnosxibeuesxndnz`, verified:
  10 columns present, RLS enabled). Maps `clickup_user_id` (= the `caller_user_id` the pipeline already
  carries) → a **per-user Anthropic Vault** (`vault_id`) + a per-MCP-URL credential map
  (`vault_credential_ids`) + `status` (active/revoked/expired). RLS **enabled, no policy** (mirrors
  `agent_input_file_map`/036, not `agent_routing`'s RLS-off which the Supabase advisor flags critical) —
  because this row carries an email + a credential mapping, the anon/authenticated PostgREST roles must be
  denied; the pipeline's privileged Postgres role bypasses RLS.
- **Migration 040 — `get_clickup_oauth_app()`** (applied + verified: callable, returns
  `{client_id:null, client_secret:null}` today because the secrets are not seeded yet). `SECURITY DEFINER`,
  `EXECUTE` granted only to `service_role`. Returns both app credentials as one jsonb (the token exchange
  needs both together). Exact mirror of `get_anthropic_key()` (034).
- **`scripts/onboard-clickup-user.mjs`** (Node, syntax-checked). The consent path: localhost-callback
  authorization-code flow → ClickUp token exchange → `GET /user` → create a per-user Anthropic Vault +
  `static_bearer` credential keyed to `https://mcp.clickup.com/mcp` → record the `user_clickup_credentials`
  row (via Supabase REST if `SUPABASE_*` set, else it prints the INSERT SQL). The access token is **never
  printed or written to disk** (write-only in the Vault). Guards against re-onboarding an existing user
  (would orphan a vault) and rolls back the vault if credential creation fails.

### Design decisions locked here (with rationale)

- **One Anthropic Vault per user** (not a shared vault). A Vault credential is keyed by `mcp_server_url`, and
  two credentials with the same URL in one vault return **HTTP 409** (Block-0, proven live in
  `ma-spike-clickup-vault.py`). Every user's ClickUp credential keys to the same `mcp.clickup.com/mcp`, so
  they cannot coexist in one vault — each user gets their own. **This per-user vault is the scoping
  mechanism:** Block 2 attaches `vault_ids = [image_mcp_vault_id, <this user's vault_id>]`, so a session sees
  only the triggering user's ClickUp credential, and the harness injects U's token on every ClickUp MCP call.
- **One `vault_id` column, not the plan's two** (`clickup_mcp_vault_id` + `readinput_mcp_vault_id`). Both
  per-user credentials (the scoped ClickUp MCP now; the read-input MCP added in Block 4 under Variant A) key
  to **different** `mcp_server_url`s, so they live in the **same** per-user vault with no 409. The plan's two
  vault columns therefore collapse to one (documented divergence under the unification rule — there is no
  reason for two vaults). Per-URL credential ids are kept in `vault_credential_ids` so revoke can delete each
  by id.
- **Confidential-client OAuth, not code-challenge PKCE.** We hold `client_secret` and ClickUp's token
  endpoint authenticates the exchange with it (Block-0 documented exchange = `client_id+client_secret+code`).
  `state` covers CSRF on the loopback redirect. The "PKCE" label in ClickUp's MCP docs describes how an
  interactive MCP client (claude.ai) connects, not how our registered app issues a token. This is the
  OAuth 2.1 confidential-client authorization-code flow and is at least as secure for a server-side onboarder.
- **No refresh machinery** (Block-0 reshape 1 honored). ClickUp tokens don't expire / no refresh token, so
  `refreshed_at` and the `expired` status are inert forward-compat only, and there is deliberately **no
  refresh dead-man's-switch**. Lifecycle = onboard + revoke only.

## n8n MCP Server Trigger probe (Variant A vs B) — **provisional: leans against bare-n8n Variant A; definitive probe deferred to Block 4**

The open Block-0 item (h): can n8n's **MCP Server Trigger** *expose* an incoming per-user bearer (U's ClickUp
token) to the workflow, so a self-hosted read-input MCP could forward it to ClickUp REST as U (Variant A) —
versus only *validate against a fixed secret* the way the image MCP does?

**What I could establish without a live token (a real per-user token does not exist until onboarding):**

- The node (`@n8n/n8n-nodes-langchain.mcpTrigger`, typeVersion 2) offers exactly three auth modes:
  `none`, `bearerAuth`, `headerAuth`. **Both `bearerAuth` and `headerAuth` validate the incoming credential
  against a *fixed* n8n credential** — confirmed in `haxe-image-mcp.json` (`authentication: "bearerAuth"` +
  an `httpBearerAuth` credential). That is the validate-and-discard pattern.
- Per-user tokens are each different, so they **cannot** be validated against one fixed credential →
  `bearerAuth`/`headerAuth` are out for Variant A. The only remaining mode is `authentication: "none"`, which
  would require **reading the raw incoming `Authorization` header inside the workflow**. Nothing in our entire
  workflow set reads `$json.headers`/the raw header (grep clean), and the MCP Server Trigger dispatches to
  connected tool sub-nodes with the **tool-call arguments**, not the HTTP request envelope — so whether the
  raw bearer is reachable downstream is undocumented and unproven.

**Provisional conclusion:** Variant A *through the bare n8n MCP Server Trigger* is **doubtful**. If Variant A
is wanted it most likely needs a **thin non-n8n shim** at the read-input MCP URL (read the bearer → call the
existing n8n read-input sub-workflow with `task_id` + token), reusing the image-MCP host (nginx/TLS) but with
custom auth handling — exactly the "same host, different auth handling" caveat Block-0 flagged.

**Why not a live probe now:** a faithful probe needs (1) the full MCP Streamable-HTTP/SSE handshake against a
throwaway MCP Server Trigger and (2) a **real per-user ClickUp bearer** to see whether scoping/forwarding
actually works — and the bearer does not exist until the OAuth app onboards a user. Hand-rolling the MCP
handshake also risks the n8n Insights write-error loop the house rules warn against. So the **definitive
probe is correctly sequenced into Block 4**, where a real token exists and the read-input-MCP endpoint is
actually being built. This is **non-blocking for Blocks 1–3** (they ride on `mcp_servers` + per-session
`vault_ids`, which Block 0 already proved).

**Fallback is cheap regardless:** Variant B (custom client-side tool on the retained loop; n8n reads U's token
from a Supabase Vault mirror) is now low-cost — with non-expiring tokens the mirror only changes on
onboard/revoke, so there is no refresh cadence to drift (Block-0 already retired the heavy sync fear).

## Operator-gated remainder (PENDING — blocks Block-1 completion)

1. **Register the ClickUp OAuth app** (Franciszek, Workspace owner/admin). See the handoff for the exact
   field values. Output needed: `client_id`, `client_secret`. Redirect URL: `http://localhost:8723/callback`.
2. **Seed the secrets** into the Vault (one-time), then `get_clickup_oauth_app()` returns them:
   `select vault.create_secret('<id>','clickup_oauth_client_id',...);` and `...'<secret>','clickup_oauth_client_secret',...`.
3. **Onboard two cross-department users** (one Marketing, one Purchasing) via `onboard-clickup-user.mjs` →
   each gets a live per-user Vault + credential + a `user_clickup_credentials` row.
4. **Minimal negative smoke** (pulled forward per Block-0): the Marketing user's token **cannot** retrieve a
   Purchasing-only task via the scoped MCP (de-risks the *inferred* per-user MCP guarantee before Block 5's
   exhaustive gate).

## Block-1 Definition of Done (tracking)

- [x] `user_clickup_credentials` migration applied (table live, RLS enabled).
- [x] App-secret getter applied (callable; returns nulls until seeded).
- [x] Onboarding consent/exchange script built + syntax-checked.
- [ ] OAuth app registered; secrets seeded (`get_clickup_oauth_app()` returns real values). — operator-gated
- [ ] ≥2 cross-department users onboarded (live Vault credential + mapping row each). — operator-gated
- [ ] Reading back a credential proves it is the right user's. — operator-gated
- [ ] Minimal 2-user negative smoke passes (Marketing token cannot read a Purchasing-only task via the MCP). — operator-gated
