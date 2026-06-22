# ADR-054 Block 1 — OAuth app + per-user token storage (findings + status)

**Status: BUILT + ONBOARDING PROVEN, BUT BLOCKED ON A CONFIRMED RESHAPE (2026-06-22).** The credential
store, getters, hosted onboarding webhook, and the end-to-end onboarding of the first user all work (see
below). **However, the positive MCP-acceptance test failed and surfaced a token-type reshape that blocks the
whole approach as currently designed** — see the next section. Do not proceed to Blocks 2–5 until the
token-acquisition path is corrected.

## ⚠️ RESHAPE (2026-06-22) — the hosted ClickUp MCP rejects our OAuth-app token

The positive acceptance test (`scripts/ma-spike-clickup-mcp.py`: a throwaway agent + the ClickUp MCP +
Franciszek's vault attached) **failed at MCP initialize** with
`mcp_authentication_failed_error: "MCP server 'clickup' initialize failed: server rejected the static bearer
token — verify the credential value"` (retries exhausted). The model then **hallucinated** a tool call and
fabricated Space names — a reminder that a silent MCP-auth failure degrades to confident fabrication, not an
obvious error.

The stored token is **valid** — it fetched Franciszek's real `/user` record during onboarding. So a token
that works on ClickUp **REST** is rejected by ClickUp's **MCP**. Confirmed root cause via the MCP's published
OAuth metadata (`https://mcp.clickup.com/.well-known/oauth-authorization-server` +
`/.well-known/oauth-protected-resource`): **the hosted MCP is its OWN OAuth 2.1 authorization server**
implementing the MCP Authorization spec (`mcp_authorization_spec_version: 2025-06-18`):
- `authorization_endpoint: https://mcp.clickup.com/oauth/authorize`,
  `token_endpoint: https://mcp.clickup.com/oauth/token`,
  `registration_endpoint: https://mcp.clickup.com/oauth/register` (Dynamic Client Registration),
- PKCE `S256`, **public client** (`token_endpoint_auth_methods: ["none"]`), grant `authorization_code`
  **only** (no `refresh_token` grant advertised),
- `scopes_supported: ["read","write"]` → **a read-only scope DOES exist at the MCP layer** (revises Block-0
  Reshape 2), `resource_server_origin: https://api.clickup.com`.

This is **separate** from ClickUp's classic API OAuth (`app.clickup.com/api` +
`api.clickup.com/api/v2/oauth/token`) that the registered app and the onboarding webhook use. The MCP only
accepts tokens **its own** OAuth server minted.

**What still holds:** the per-user vault + `static_bearer` + `vault_ids` injection mechanics (proven end to
end — the harness DID inject the credential and attempt the MCP connect); the credential lifecycle; and the
as-U **REST** extraction planned for Block 4 (our app token is the *correct* token there — REST is where it
works). **What is invalidated:** the onboarding flow's *token acquisition* (it mints a classic-API token the
MCP rejects), and Block-0's inference that an OAuth-app token would be honored by the hosted MCP.

**Options (decision pending — see the session handoff):**
1. **Re-point onboarding at the MCP's OAuth server** (`mcp.clickup.com/oauth/*`: DCR → PKCE authorize →
   token, `scope=read`), store that MCP-issued token in the per-user vault (everything downstream unchanged).
   Keeps the hosted commodity MCP; gains a real read-only scope. Risks: no refresh grant (expiry/re-consent
   cadence unknown); must re-confirm the harness accepts an MCP-OAuth-issued bearer.
2. **Use harness-native MCP OAuth** if Managed Agents can itself drive the MCP Authorization-spec flow
   (DCR + per-user consent) — least custom build, but unproven that the Vault/harness supports interactive
   per-user MCP consent for unattended multi-user.
3. **Self-host a thin ClickUp MCP** that accepts our per-user *REST* OAuth token (already proven to work) and
   proxies to ClickUp REST as U. Full control + reuses the image-MCP hosting pattern; but it is a custom
   build, against the "consume the commodity hosted MCP" preference.

**RESOLUTION (2026-06-22) — Option 1 confirmed viable; Option 2 ruled out.** The Managed Agents vault docs
confirm Anthropic never drives the MCP consent (you obtain + store the token; it only injects/refreshes), so
**Option 2 is out**. The probe `scripts/ma-spike-clickup-mcp-oauth.mjs` then drove the MCP's own OAuth end to
end (DCR `200` → PKCE authorize → token), and the resulting token was **accepted by the MCP**
(`mcp_oauth_validate` → **`valid`**). Key facts:
- **Durability:** `expires_in: 315360000` (**10 years**) → effectively non-expiring → store as
  **`static_bearer`**, no refresh machinery (Franciszek's "no expiry" intuition holds).
- **Scope:** requested `scope=read`, ClickUp returned `read write` — it grants full regardless, so **read-only
  stays enforced by the `mcp_toolset` allowlist (Block 3)**, not by the OAuth scope (Block-0 Reshape 2 stands).
- **DCR shape:** minimal RFC 7591 body (`redirect_uris`, `token_endpoint_auth_method:none`, grant/response
  types) `200`s; adding `client_name`/`scope` `400`s.

**Decision: Option 1 — rework onboarding to ClickUp's MCP OAuth endpoints** (`mcp.clickup.com/oauth/*`,
DCR + PKCE, public client), storing the MCP token as a per-user `static_bearer` keyed to `mcp.clickup.com/mcp`.
Everything downstream (per-user vault, `vault_ids` injection, session binding) is unchanged.

**Sub-question ANSWERED (2026-06-22): the MCP-OAuth token is `HTTP 401` on ClickUp REST** (`GET
/api/v2/user` → 401, identity null). So the MCP token serves the **hosted MCP only**; user identity (for the
mapping row) and Block-4 attachment extraction (REST-based) need the **classic REST OAuth token**. This forks
the design:
- **Option 1 (keep hosted MCP for discovery):** two tokens per user — the MCP-OAuth token (discovery) **and**
  the classic REST token (identity + extraction) — and therefore **two consents** at onboarding (two separate
  OAuth servers). Onboarding must be reworked to add the MCP-OAuth flow on top of the classic flow.
- **Option 3 (self-host one thin ClickUp MCP on the REST token):** **one** token, **one** consent. Discovery
  (~6 read tools) and Block-4 extraction both ride the classic REST token through a self-hosted MCP we
  control (read-only by construction). **Bonus: the onboarding webhook already built mints exactly this REST
  token + identity — so it needs no rework**, only re-keying the credential to our MCP's URL.

**Key realization:** we self-host an MCP-protocol endpoint for **extraction regardless** (Block-0: the hosted
MCP returns no attachment content), so Option 3's discovery tools are incremental on a build we already owe,
and it reuses the onboarding we built. The hosted-MCP "commodity" benefit (Option 1) shrinks to "ClickUp
maintains ~50 tools we mostly don't need," at the cost of a second token + second consent. **Recommendation
shifted to Option 3** (pending operator confirmation). **Bearer-forwarding probe (2026-06-22) — FAILED.** `scripts/ma-spike-bearer-forward.py` + a throwaway n8n
MCP Server Trigger (`auth=none`) → Code Tool: the harness called the tool fine (`agent.mcp_tool_use` →
`agent.mcp_tool_result`, so injection + connection work), but the tool could **not** read the incoming
request — `$('MCP Server Trigger')` errors ("hasn't been executed"), `$json.headers` null, the SENTINEL
bearer absent. **n8n's MCP Server Trigger accepts/validates the injected bearer but does NOT surface it to the
workflow.** So a self-hosted **n8n** MCP cannot act as U — pure-n8n Variant A is dead (the earlier "doubtful"
is now proven).

### Net architecture after probes 1–3 (decision pending)

The probes establish: the hosted ClickUp MCP needs **its own** OAuth token (works, 10y) and can't extract
attachments; the MCP token is 401 on REST; and n8n can't read an injected bearer. Extraction therefore
**must** run where n8n knows the caller — the **client-side tool loop** (the session loop knows
`caller_user_id`, reads U's REST token from a store, calls ClickUp REST as U) — *not* a self-hosted MCP.
Three coherent end-states remain:
- **A — Hosted MCP discovery + client-side extraction.** Discovery via ClickUp's hosted MCP (per-user
  MCP-OAuth token, in-harness, fast); extraction client-side (REST token from a Supabase mirror keyed by
  `caller_user_id`). **Two tokens, two consents** at onboarding; richest discovery tools (ClickUp-maintained).
- **B — Client-side everything, one REST token.** Both discovery *and* extraction are agent-driven
  client-side tools; n8n reads the one classic REST token (the onboarding already built) from a Supabase
  mirror by `caller_user_id` and calls ClickUp REST as U. **One token, one consent**; reuses the retained
  client-side loop (ADR-053/055) and the onboarding webhook as-is; we implement a few discovery REST tools;
  discovery pays client-side pause latency (acceptable for async task automation).
- **C — Custom (non-n8n) MCP server.** A small self-hosted service that reads the injected bearer and proxies
  ClickUp REST as U (discovery + extraction in-harness, one token). Cleanest agent model, but a real
  build/host/maintain of an MCP server.

**Leaning B** (simplest onboarding — one token/consent/store, reuses the retained loop and the onboarding
already built; extraction is client-side regardless; the only loss vs A is ClickUp's pre-built tool surface
and some discovery latency). Operator decision required before building.

The "Operator-gated remainder" below (onboard 2 users + negative smoke) resumes **after** the onboarding rework
(no point onboarding users on the old, MCP-rejected token type).

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
- **Migration 041 — `clickup_oauth_state`** (applied + verified). Single-use, short-lived CSRF state for the
  hosted consent flow; INSERTed at start, deleted at callback within a 15-minute window. No PII, no token;
  prunable; RLS enabled, no policy.
- **`ClickUp OAuth Onboarding (v1)`** — the **primary, self-serve consent flow** (live n8n workflow
  `FKfVEyB62swT2FFN`, exported to `n8n/workflows/clickup-onboarding.json`, drift-clean). Two GET webhooks in
  one workflow: **`/webhook/clickup-oauth-start`** (mint CSRF state + read `client_id` → 302 to ClickUp
  consent) and **`/webhook/clickup-oauth-callback`** (consume+verify state → exchange code→token → `GET
  /user` → create a per-user Anthropic Vault + `static_bearer` credential keyed to `mcp.clickup.com/mcp` →
  insert the `user_clickup_credentials` row → show a "Połączono ✓" page). Onboarding is then "send the person
  the start link; they approve as themselves; done" — no script, no Node, no key on their machine, and the
  identity is correct by construction (each person consents in their own browser). Built with normal nodes
  (no Code nodes); every external call (exchange, user, vault, credential→rollback, insert) routes failures
  to **`Post Alert (v1)`** (CRITICAL) + a user-facing failure page; `errorWorkflow` set for throws;
  `saveDataSuccessExecution:"none"` so the OAuth token is **not** persisted in execution data on success.
- **`scripts/onboard-clickup-user.mjs`** — retained as a **dev/CLI fallback** (localhost-loopback variant of
  the same logic) for debugging or onboarding without the webhook; not the primary path.

### Live wiring verification (what was provable without the OAuth app)

The OAuth happy path (exchange → vault → credential → success) needs the registered app + seeded secrets, so
it is operator-gated. Everything around it was exercised live against the deployed workflow:
- **`GET /webhook/clickup-oauth-start`** → `HTTP 302` with
  `Location: https://app.clickup.com/api?client_id=&redirect_uri=…clickup-oauth-callback&state=<uuid>` —
  confirms the start webhook, the Vault-getter read (`client_id` empty as expected pre-seed), the CSRF-state
  mint, and the redirect construction.
- **`GET /webhook/clickup-oauth-callback?state=bogus&code=fake`** → `HTTP 400` + the Polish "link expired"
  HTML page — confirms the callback webhook query parsing, the consume-state query (unknown state →
  `valid=false`), the `State Valid?` false branch, and the HTML responder.
- Test state rows cleaned up afterward; workflow validates (`valid:true`, 0 errors) and is drift-clean.

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

1. **Register the ClickUp OAuth app** (Franciszek, Workspace owner/admin). Redirect URL (must match exactly):
   **`https://agents.haxe.ai/webhook/clickup-oauth-callback`**. Output needed: `client_id`, `client_secret`.
2. **Seed the secrets** into the Vault (one-time), then `get_clickup_oauth_app()` returns them:
   `select vault.create_secret('<id>','clickup_oauth_client_id',...);` and `...'<secret>','clickup_oauth_client_secret',...`.
3. **Onboard two cross-department users** (one Marketing, one Purchasing): each opens the self-serve link
   **`https://agents.haxe.ai/webhook/clickup-oauth-start`** in their own browser (logged in as themselves) and
   approves → each gets a live per-user Vault + credential + a `user_clickup_credentials` row.
4. **Minimal negative smoke** (pulled forward per Block-0): the Marketing user's token **cannot** retrieve a
   Purchasing-only task via the scoped MCP (de-risks the *inferred* per-user MCP guarantee before Block 5's
   exhaustive gate).

## Block-1 Definition of Done (tracking)

- [x] `user_clickup_credentials` migration applied (table live, RLS enabled).
- [x] App-secret getter applied (callable; returns nulls until seeded).
- [x] CSRF-state table (migration 041) applied.
- [x] Hosted onboarding workflow built, validated, deployed, drift-clean; start (302) + callback-reject (400)
      paths verified live; local-loopback script retained as a fallback.
- [x] OAuth app registered; secrets seeded — `get_clickup_oauth_app()` returns both values (2026-06-22).
- [x] **Full happy path proven end-to-end** by onboarding the first real user (Franciszek, clickup_user_id
      2521617) through the hosted flow: consent → exchange → `GET /user` → per-user Vault
      `vlt_011CcJFTSejGJnjA4tEBcM7o` → `static_bearer` credential `vcrd_01JmuSP6peYBrnUuvvhvd1Vv` keyed to
      `mcp.clickup.com/mcp` → `user_clickup_credentials` row (status active). Alerts channel clean (0/0).
- [x] Reading back the credential proves it is the right user's — `GET /v1/vaults/{vid}/credentials` returns
      `static_bearer` / `mcp.clickup.com/mcp` / `display_name "clickup Franciszek Nowak (U)"`, **no token**
      (write-only).
- [ ] **≥2 cross-department users onboarded** — 1 of 2 done (Franciszek). The 2nd must be a *limited-permission*
      user; the negative smoke needs a Marketing user + a Purchasing-only task, and the CEO account sees
      everything so it cannot serve the negative subject. — operator-gated
- [ ] Minimal 2-user negative smoke passes (Marketing token cannot read a Purchasing-only task via the MCP). — operator-gated

> **Security note (2026-06-22):** during credential read-back, a malformed SSH/curl quoting attempt caused the
> production `ANTHROPIC_API_KEY` to be echoed in plaintext into the working session output (not written to any
> file or committed). Recommend rotating the Anthropic key (update `/opt/haxe-agents/.env` + the Supabase
> Vault `anthropic_api_key` secret + restart the managed-lane containers). The corrected read-back (space-free
> headers) succeeded without echoing the key.
