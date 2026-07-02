# ADR-054: Permission-scoped context retrieval within Managed Agents

Status: Accepted
Date: 2026-06-16
Depends on: ADR-053 (Managed Agents switch), ADR-049 (per-user permission fidelity, audience tiers, DWD design)
References: ADR-035 (cost logging)
Beta surface: Anthropic Managed Agents Vault (OAuth auto-refresh, `vault_ids` per session, credentials proxied outside the sandbox)

> **Build status (BUILT + cutover landed 2026-06-24; consequences reconciled below in "Block 5 + Block 6
> outcome").** Built **ClickUp-only**; Google (Drive + Gmail) DWD is **deferred to a follow-up ADR**. Two Block-0 reshapes
> override the mechanism described below: (1) ClickUp OAuth tokens **do not expire and issue no refresh
> token**, so the per-user credential is a **`static_bearer`** holding the access token — **not** the
> "OAuth auto-refresh" credential the Beta-surface line and §2 describe, and there is no refresh machinery;
> (2) the as-U **REST `GET task` extraction is load-bearing**, not optional, because the hosted ClickUp MCP
> returns no attachment metadata/content. **Block 1 BUILT + live-verified (not yet wired into sessions):** the
> per-user credential store (`user_clickup_credentials`, migration 039; one Anthropic Vault per user), the
> OAuth app-secret getter (`get_clickup_oauth_app()`, migration 040), a CSRF-state table extended for the
> second consent (migrations 041 + 043: PKCE verifier / DCR client_id / carried identity for the MCP phase),
> the classic-REST-token store + getter in Supabase Vault (`set_clickup_rest_token()` /
> `get_clickup_rest_token()`, migration 042), and a self-serve hosted consent flow that **chains both consents
> in one link** (n8n `ClickUp OAuth Onboarding (v1)`, `FKfVEyB62swT2FFN`: `/webhook/clickup-oauth-start` →
> classic consent → `/webhook/clickup-oauth-callback` exchanges the code, identifies the user via REST
> `GET /user`, stores the REST token in Supabase Vault, then runs DCR + PKCE and 302s to the hosted-MCP
> consent → `/webhook/clickup-mcp-callback` mints the MCP-OAuth token, creates the per-user Anthropic Vault +
> `static_bearer` credential, and upserts the mapping row); a local-loopback script
> (`scripts/onboard-clickup-user.mjs`) is a dev fallback. **Operator-gated remainder:** re-key Franciszek
> through the new flow, onboard 1 Marketing + 1 Purchasing user, run the cross-department negative smoke. **Reshape (2026-06-22):** the
> hosted ClickUp MCP authenticates only with tokens from its OWN OAuth server (MCP Authorization spec,
> `mcp.clickup.com/oauth/*`, DCR + PKCE, public client), **not** our classic OAuth-app token — proven by
> probe. **Option A (locked 2026-06-22):** discovery rides the hosted MCP, scoped per user by a **MCP-OAuth** token
> (DCR + PKCE; accepted, ~10y, `static_bearer` in the Anthropic Vault; read-only via the toolset allowlist since
> `scope=read` is ignored). The MCP-OAuth token is **401 on ClickUp REST**, and n8n cannot read an injected
> bearer (probe), so **extraction is a client-side tool on the retained agent loop** — the session loop reads
> the user's **classic REST** token from **Supabase Vault** by `caller_user_id` and runs `read-input` as U; it
> is **not** a self-hosted MCP. Two tokens (MCP-OAuth in the Vault, REST in Supabase), two consents per user.
> See the master plan's "ARCHITECTURE LOCKED — Option A". See
> `architecture/Build plans/adr-054-clickup-scoped-retrieval/`
> (`master-plan.md`, `block-0-findings.md`, `block-1-findings.md`).
>
> **Block 2 DONE + live-verified (2026-06-23):** `Execute Agent Session (v1)` binds the triggering caller's
> per-user ClickUp MCP-OAuth Vault id into the session `vault_ids` (resolved in `Resolve Agent` by
> `caller_user_id`, carried in `Build Setup`, attached in `Create Session`); un-onboarded users degrade
> (no scoped tools) + one consolidated `clickup-scope-degraded` WARN. **Block 3a DONE + live-verified
> (2026-06-23):** the hosted ClickUp MCP (`mcp.clickup.com/mcp`, `{type:"url"}`) + a paired READ-ONLY
> `mcp_toolset` allowlist (14 read/discovery tools, each with its own `always_allow` — the API defaults
> `default_config` to `always_ask`, so per-tool `always_allow` is load-bearing; default disabled blocks every
> write tool) + Polish discovery steering are registered on the **3 routed tier agents** (Haiku/Sonnet/Opus)
> via `Sync Agent Definitions (v1)` at `CONV=5`. Note: the "4 tier agents" of earlier planning is now **3
> distinct model agents** — the critical tier (`Krytycznie ważne`) routes to **Opus**, not the **orphan**
> `Haxe Agent — Fable` (un-routed since the critical tier moved off Fable; flagged for cleanup, harmless).
> The managed-lane Poll Round now treats a ClickUp MCP `mcp_authentication_failed_error` as **NON-fatal** (the
> run degrades and completes, it does not `terminate`); a mid-run WARN fires **only** for onboarded users whose
> scope genuinely failed (`clickup_scope==='scoped'`), suppressed for un-onboarded (Block 2 already WARNed —
> operator decision 2026-06-23). A `ClickUp MCP Health Monitor (v1)` dead-man's-switch probes the hosted
> endpoint every 6h (`mcp.clickup.com/.well-known/oauth-authorization-server`; 2xx healthy, else CRITICAL via
> `Post Alert (v1)`). **Live proof:** an onboarded run (Franciszek) performed in-harness scoped discovery —
> the agent called `clickup_get_workspace_hierarchy` and returned his real Spaces, `status:completed`, 0
> warnings; an un-onboarded run completed cleanly (`outcome:done`, not terminated) with exactly one WARN;
> Alerts channel 0 CRITICAL / 1 expected WARN. **Block 3b DONE + live-verified (2026-06-23):** the open-ended
> search-as-bot path + the `Check Space Member` / `Layer B Filter` software membership gate (the R3 violation)
> are removed from `Assemble Task Context (v1)` (36→12 nodes); it now fetches only the triggering task's own comments
> + threaded replies and returns the unchanged contract with `additional_context` always empty. Open-ended
> discovery is now exclusively the agent's in-harness scoped ClickUp MCP. See the Block 3b outcome section below.
> **Block 4 DONE + live-verified (2026-06-23):** the as-U REST extraction tool on the retained loop — the agent
> pulls a discovered task's attachment content (document text + images) under the caller's own permissions via a
> client-side custom tool (`ClickUp Extract Tool Handler (v1)`), out-of-scope ids returning access-denied.
> **Block 5 DONE (scope-correctness gate passed, 2026-06-24)** and **Block 6 DONE (cutover landed, 2026-06-24)**
> — see the "Block 5 + Block 6 outcome" section at the end of this ADR.

## Decision (verdict first)

The managed agent gathers context from ClickUp, Gmail, and Drive under the triggering user's identity, enforced by n8n at the executor level, never by the agent. Google uses domain-wide delegation through a custom tool; ClickUp uses per-user OAuth tokens held in the Vault and selected per session. Task-bound context is pre-gathered deterministically; only open-ended discovery runs as live scoped tools. Scope is enforced by the credential, so a prompt-injected agent cannot exceed the user's permissions.

## Context

The agent needs live context from ClickUp, Gmail, and Drive during reasoning. Per ADR-049, per-user permission fidelity is required: the departmental boundary (for example Marketing cannot read Purchasing) is a real boundary, not advisory. So any data retrieved for a task triggered by user U must be limited to what U may see, and only that may surface in U's deliverable.

The trap: MCP authenticates as the identity of the credential in the Vault, which is fixed, not the triggering user. A single bot or service credential would expose everything that credential can see, on every task, regardless of who triggered it. Off-the-shelf MCP therefore does not provide per-user scoping. The reason a personal ChatGPT ClickUp connector works is that it is authenticated as that one user; the multi-user unattended automation has no logged-in user and must inject the right identity per task.

The Vault helps: it stores OAuth credentials with auto-refresh and static bearer tokens, attaches to sessions via `vault_ids`, and keeps credentials outside the sandbox, proxied, so generated code cannot exfiltrate them.

Key observation that frames the design: holding per-user identity at retrieval is the same engineering whether the search is driven by the agent or by n8n, because credentials must live outside the agent either way. So the agent-versus-n8n choice is about retrieval quality, not permission cost, and the agent wins on open-ended discovery because deciding what to search is judgment.

## Decision detail

1. Identity enforced at the executor, not by the agent. The agent never holds a token and never selects the identity. n8n binds each session to its triggering user U at session creation, and every retrieval on that session runs as U. Because the binding is set by n8n (which knows whose task it is) and not passed by the agent, it is unspoofable, and scope is enforced by the credential rather than by the agent's behavior.

2. Mechanism by system.
   - Google: domain-wide delegation. One service account, admin-granted impersonation, can act as any user with no per-user consent. The stock Drive and Gmail MCP do not perform DWD, so this is a custom client-side tool: n8n, knowing U, makes the impersonated API call as U and returns scoped results. Future-proof, because new users are covered automatically through the directory.
   - ClickUp: per-user OAuth tokens (no DWD equivalent). Each user consents once; the token is stored as a Vault credential with auto-refresh; at session creation n8n attaches U's `vault_id`; the stock ClickUp MCP then runs authenticated as U for the whole session. No custom handler required.

3. Session-to-user binding is the enforcement point. At session creation n8n attaches U's `vault_id` and tags the session's tool-executor context with U. This is roughly one day of work and is the linchpin of correctness.

4. Hybrid retrieval split.
   - Task-bound context (the task's own attachments, comments, linked items): pre-gathered deterministically in n8n under U's identity, reusing the read-input layer (ADR-053). Mechanical, cheap, mostly already built.
   - Open-ended discovery (find related material across the workspace): live tools the agent calls, scoped to U (stock ClickUp MCP via the per-session Vault credential; custom Google DWD tool). The agent's judgment drives the search; the executor and Vault enforce scope. This is the only surface that needs live per-user MCP, which keeps the hard surface small.

5. Credentials never enter the sandbox. ClickUp tokens live in the Vault (proxied, outside the sandbox). The Google DWD service-account key lives in n8n or a secrets manager and is never exposed to the agent. The agent receives only scoped results.

6. Scope-correctness testing is the acceptance gate. Before production, explicitly verify that a task triggered by a user of one department cannot retrieve another department's data through any path, including open-ended search. A mis-mapped credential fails silently, and this boundary is the entire point, so this gate is mandatory.

## Rejected alternatives

- R1. Single bot or service identity for the agent's MCP. Exposes everything that identity can see to every task, re-opening the ADR-049 departmental boundary. Acceptable only if that boundary is downgraded to advisory, which is not the decision.
- R2. Run the entire research lane in n8n with no agent live tools. The per-user credential machinery is identical (n8n holds the credentials either way), so it costs the same on permissions, but n8n must decide what to search via fixed heuristics, which is weaker than agent-driven iterative search for open-ended discovery. Pure-n8n pays the same for a worse result. Deterministic task-bound pre-gather is kept as the complement, not the whole.
- R3. Service account plus post-hoc permission filtering. Re-implements the permission system in application code; fragile and error-prone. The boundary must come from the API acting as U, not from our filter.
- R4. Per-user OAuth for Google instead of DWD. Rejected as the default: DWD avoids per-user consent and covers staff changes automatically. Per-user Google OAuth is the lower-build v1 shortcut if DWD setup is delayed, but it does not scale as cleanly.
- R5. Pass the triggering user-id to a hosted MCP for it to scope. A user-id passed by the agent is spoofable; binding identity at the n8n executor is not.

## Consequences

- Per-user fidelity is preserved, and scope enforcement is injection-resistant because it lives in the credential, not the agent. The agent still gets intelligent, scoped, open-ended search; the deterministic bulk is handled cheaply.
- Reuses two existing patterns: the image-tool session-stream listener (ADR-053) and the read-input pre-gather (ADR-048, ADR-053).
- Effort: roughly one to two focused weeks. The distribution: the ClickUp OAuth plumbing (app registration, per-user consent, Vault wiring) and the Google DWD tool (admin setup, impersonation handler) are a few days each; the session-to-user binding is about a day; scope-correctness testing is several days and is the acceptance gate.
- Ongoing: new ClickUp users need a one-time OAuth consent; DWD covers new Google users automatically. ClickUp token refresh is handled by the Vault; revocation is handled by us.
- The Google DWD tool is the one piece of genuinely custom code in the context layer; everything else composes the Vault, the stock ClickUp MCP, and existing n8n patterns.

## Block 0 capability-gate outcome (2026-06-22)

The ClickUp-only build (operator-scoped 2026-06-22; Google deferred) ran its capability-gate spike. Full spec: `architecture/Build plans/adr-054-clickup-scoped-retrieval/block-0-findings.md`. The core decision **holds** — ClickUp operates a registerable hosted MCP (`https://mcp.clickup.com/mcp`) and a per-user OAuth token in the Anthropic Vault scopes it to the triggering user via `vault_ids`. Three reshapes refine, but do not overturn, the design:

1. **Credential type is `static_bearer`, not Vault auto-refresh.** ClickUp OAuth tokens do not expire, issue no refresh token, and carry no granular scopes — so there is nothing to auto-refresh. This simplifies the lifecycle (onboard + revoke only) and removes the refresh dead-man's-switch this ADR's "ClickUp token refresh is handled by the Vault" line anticipated; revocation remains ours.
2. **The discovery MCP must be locked read-only in software.** With no read-only OAuth scope, the `mcp_toolset` allowlists read/discovery tools and disables every write tool.
3. **The as-U extraction (decision detail §4) is load-bearing, not optional.** The hosted MCP returns descriptions, comments, custom-field values, and Doc-page text but **not** attachment metadata or extracted content — so reaching any attachment requires the as-U REST `GET task` (Option 2), re-validated as the user at fetch time.

One sequencing consequence: the MCP rejects ClickUp personal (`pk_`) tokens, and the workspace is greenfield (no OAuth app yet), so the live cross-department scope-correctness test (the §6 acceptance gate) cannot run until the OAuth 2.1 + PKCE app exists. A minimal two-user negative smoke is pulled into the OAuth-app block's tail; the exhaustive gate remains.

## Block 1 build outcome (2026-06-22) — two-token chained onboarding, live-verified

Three live probes during Block 1 forced the locked Option A two-token model and reshaped the onboarding flow (scripts under `scripts/ma-spike-*`; full record in `block-1-findings.md`):

1. The hosted MCP **rejects our classic OAuth-app token** — it is its own OAuth 2.1 server (`mcp.clickup.com/oauth/*`, DCR + PKCE, public client).
2. A token minted via that MCP-OAuth flow **is accepted** by the MCP and lives ~10 years (store as `static_bearer`, no refresh) — but is **HTTP 401 on ClickUp REST**.
3. n8n's MCP Server Trigger **cannot read** a harness-injected per-user bearer (validate-and-discard), so a self-hosted n8n MCP cannot act as the user.

Net: **two tokens, two consents per user.** Discovery rides the hosted MCP via the **MCP-OAuth token** in the per-user Anthropic Vault (harness-injected per session). Extraction (Block 4) is a **client-side tool on the retained loop** reading the user's **classic REST token from Supabase Vault** by `caller_user_id` — *not* a self-hosted MCP. The onboarding webhook now **chains both consents in one link** (classic → store REST token in Supabase → DCR + PKCE → hosted-MCP consent → mint + place the discovery token). PKCE `code_challenge` is computed with the native **Crypto node** (Code-node crypto is sandbox-blocked on this instance): SHA256→base64, converted to base64url by plain string ops. Migrations 042 (REST-token store/getter) and 043 (MCP-phase state columns) added; non-token paths (start 302, both callback rejects) live-verified; the happy path is operator-gated (real browser consent). Reshape 2 (read-only by the `mcp_toolset` allowlist) **stands** — the MCP-OAuth flow ignores `scope=read` and grants `read write`.

## Block 2 build outcome (2026-06-23) — session-to-user binding, live-verified

The enforcement point is now wired. `Execute Agent Session (v1)` (`Rtb1cZbmUqmfGD98`) binds the triggering user's ClickUp scope onto the session by attaching that user's per-user Anthropic Vault to `vault_ids`, set by n8n from `caller_user_id` only — the agent never supplies the identity, so it is unspoofable even under prompt injection (the property §3/R3 requires). Three surgical edits to existing nodes (no new nodes, no topology change):

1. **`Resolve Agent`** — the tier-routing query gains a correlated subquery `(select vault_id from public.user_clickup_credentials where clickup_user_id = $2 and status = 'active' limit 1) as clickup_mcp_vault_id`, with `$2 = caller_user_id`. Returns the user's vault id, or `null` when un-onboarded. (`clickup_user_id` is the `caller_user_id` the pipeline already carries — migration 039.)
2. **`Build Setup`** — carries `clickup_mcp_vault_id` and a `clickup_scope` flag (`scoped`|`degraded`); when the vault is absent it appends one `managed-agents/clickup-scope-degraded` WARN to the run's `warnings_json`, which the existing `Classify Alert → Post Alert (v1)` seam consolidates into a single per-session alert.
3. **`Create Session`** — `vault_ids` extended from `[image_mcp_vault_id]` to `[image_mcp_vault_id, clickup_mcp_vault_id].filter(Boolean)`, each conditional/fail-soft.

**Degrade, not break** (decision #5): an un-onboarded caller's session is created with only the image vault and still runs on deterministic pre-gather; the run returns a result and fires exactly one WARN telling the operator to onboard that user. **Verified live** by driving the workflow both ways: the onboarded caller (Franciszek, `caller_user_id` 2521617) produced a session whose `vault_ids` read back as `[image_vault, his_vault]`; an un-onboarded caller produced an image-vault-only session, `clickup_scope: 'degraded'`, and exactly one consolidated WARN on the Alerts channel; both sessions created and completed. Confirmed in passing that attaching a ClickUp vault whose hosted MCP is **not yet registered** on the agent does **not** error at `sessions.create` — so the binding (Block 2) safely precedes MCP registration (Block 3); the attached vault is inert until Block 3 wires the discovery MCP. No new silent-failure surface: the only new failure mode (un-onboarded user) is the loud WARN; a resolve-query error already degrades via `onError: continueRegularOutput`.

## Block 3b build outcome (2026-06-23) — software filter retired (R3 closed for discovery), live-verified

With scoped discovery proven live (Block 3a), the open-ended **search-as-bot** path and the **`Check Space Member` / `Layer B Filter`** software membership gate were removed from `Assemble Task Context (v1)` (`eL3fJuRMpzVRuVUT`). This closes the **R3 violation** on the discovery surface: post-hoc filtering of bot-retrieved candidates was exactly the "service account plus application-code permission filtering" R3 rejects. Scope now comes from the API acting as U — the agent's own per-user-scoped ClickUp MCP — not from our filter.

What was removed (the sub-workflow went **36 → 12 nodes**): the Haiku query-extraction sub-call (`triggered_by=search_step`), the ClickUp task search + dedup, the `Space Loop` → `Check Space Member` → `Layer B Filter` membership gate (`GET /space/{id}/member` per candidate space, fail-closed), the up-to-5 accessible-artifact read-back, and the selective-condense Haiku pass.

What was kept (task-bound, U's own task — no leak): the `Fetch Task Comments` (last 30 comments) + the threaded-reply sub-branch (`Pick Threads` → `Has Threads?` → `Expand Threads` → `Fetch Replies` → `Collect Replies`), with their two best-effort WARN side-branches. `Build Output` is now the single linear terminal leaf (keeps the sub-workflow-return-determinism rule) and emits the **unchanged** `{task_comments, additional_context, sources_used, sources_filtered_out}` contract with `additional_context` always `''`, `sources_used: []`, `sources_filtered_out: 0` — so `Assemble Context and Build Prompt (v1)` (and any other caller) does not break; it simply omits the now-empty "Dodatkowy kontekst" section and keeps `workspace_search_ok: true`.

**Lane consequence (recorded honestly).** Stage A (`Assemble Context`) is **shared** by both the bare `Agent Orchestrator` spine and the managed `Execute Agent Session` lane, so retiring the bot-driven open-ended search removes that `additional_context` enrichment for **both**. The replacement — agent-driven, credential-scoped discovery via the hosted ClickUp MCP — currently exists **only on the managed lane** (Block 3a). The bare lane therefore no longer receives open-ended semantic enrichment; it retains the triggering task's own comments plus the deterministic Assemble Parent Context / Read Input pre-gather. This is consistent with the locked decision that the managed lane is the path forward (ADR-053); the bare lane's reduction is a loss of enrichment, **not** a loosening of scope (it gets strictly less, never more, and never another department's data).

**Verified live** (Definition of Done): drove `Assemble Task Context (v1)` directly on a disposable `Lista testy AI` task carrying one top-level comment + one threaded reply — it returned both (reply interleaved, `↳`-prefixed, `is_reply:true`) with `additional_context` empty and the contract intact, every node on the expected branch, no search/Layer-B nodes left; drove the full Stage A (`Assemble Context and Build Prompt (v1)`) on the same task — `workspace_search_ok: true`, the comments present in the built prompt, no "Dodatkowy kontekst" section, `input_warnings_count: 0`; Alerts channel **0 CRITICAL / 0 WARN**; drift-check clean; disposable task deleted. Migration `009`'s `search_step` `triggered_by` value is now unused but left in place (append-only, harmless).

## Block 5 + Block 6 outcome (2026-06-24) — scope gate passed, cutover landed

**Block 5 — scope-correctness acceptance gate (the mandatory §6 gate): PASSED.** The cross-department negative matrix ran across **both** enforcement paths with two real cross-department users — Patryk Marzec (Marketing, `2604220`, sees 3 Spaces, no Purchasing) and Beniamin Gawlik (Purchasing, `8722303`, sees `Zakupy, Kosztowcy, Produkcja` `2224232`). The positive control holds (Beniamin's token returns the Purchasing data, so a "denied" for Patryk is a true negative). Results: **discovery** — an agent driven as Patryk cannot reach Purchasing data; the hosted MCP returns only his 3 Spaces (enforcement is on the credential, not the model). **Extraction** — `ClickUp Extract Tool Handler (v1)` driven as Patryk (his real REST token) on an out-of-scope Purchasing task id returns `status: denied` + a `managed-agents/extract-access-denied` audit WARN. **Mis-map fails loud** — Patryk's row re-pointed at a bogus `vault_id` → `sessions.create` HTTP 400 `invalid vault_id` → the `Create Session` CRITICAL path, no session created; because Block 3b retired the bot path there is **no broad fallback to silently fall to**, so "silently broad" is architecturally precluded, not merely tested. The mis-map mutation was reverted in-session and re-verified. Framing recorded in `block-5-findings.md`: the guarantee is the **credential**, not the model's guardrails (the injection-refusal test is defense-in-depth only). Added a permission-denied audit WARN to the extract handler. Known residuals (documented, non-blocking): a valid-but-wrong vault mapping is undetectable by design (mitigated by atomic onboarding + the REST onboarder's `GET /user` identity self-check); a corrupt source raster still terminates the session (pre-existing, shared with the input-image path).

**Block 6 — cutover, ops, write-backs: DONE.**

- **Cutover is documentation/ops, not a switch.** The per-user-scoped path has been the live default for the managed lane since Block 3a; there was never a feature flag gating it, so "cutover" is the reconciliation recorded here and in `current.md` — not a flip.
- **Onboarding (operator-gated — each needs a browser OAuth consent).** As of cutover, 3 of 5 members are onboarded for discovery (Franciszek/CEO, Patryk, Beniamin); REST/extraction tokens exist for 2 (Franciszek, Patryk; Beniamin is discovery-only / half-onboarded). The remaining members onboard via `scripts/onboard-clickup-mcp-user.mjs` (discovery → per-user Anthropic Vault) then `scripts/onboard-clickup-rest-token.mjs` (extraction → Supabase Vault), one consent each. Un-onboarded callers degrade loudly (Block 2/3a), so partial coverage is safe, not silent.
- **Rollback — the plan's "config flag → bot-only" target is moot.** Block 3b deleted the open-ended search-as-bot path, so there is nothing bot-broad to revert to. Incident rollback uses two **existing** levers: (1) the whole-lane switch `config.agent_lane='bare'` — reverts to the LiteLLM gateway lane, which carries no managed-lane scoped tools at all (fast/nuclear, but also drops images/Skills/web-search); (2) a targeted re-run of `Sync Agent Definitions (v1)` with ClickUp removed (CONV bump) → every managed user degrades to the proven deterministic-pre-gather floor. **No dedicated scoping flag was built** (operator decision 2026-06-24): a new code path is unjustified for a 5-person system already covered by two proven levers, and it would violate "as little custom build as possible."
- **Revoke ops (runbook, no script built — operator decision 2026-06-24).** Revoke a user = delete their Anthropic Vault credential + vault (discovery), delete the Supabase Vault secret `clickup_rest_token_<clickup_user_id>` (extraction), and flip the `user_clickup_credentials` row to `status='revoked'` (set `revoked_at`). The next session for that user then takes the degrade path (image-vault-only) and fires the one consolidated `clickup-scope-degraded` WARN — the same proven Block-2 behaviour, so revocation needs no new code to be observable. **No token refresh machinery exists or is needed** (Block 0: both ClickUp token types are effectively non-expiring — ~10y MCP-OAuth, non-expiring classic REST).
- **Silent-failure modes — what is covered and what is knowingly not.** Covered: a down hosted ClickUp MCP (`ClickUp MCP Health Monitor (v1)`, 6h dead-man's-switch); an un-onboarded user who triggers the agent (per-session degrade WARN, Block 2/3a); a scoping failure for an onboarded user (mid-run WARN, Block 3a); an extraction access-denial (audit WARN, Block 5); and — added 2026-06-24 at operator request — a **proactive onboarding-coverage** dead-man's-switch, `ClickUp Onboarding Coverage Monitor (v1)` (`0hj3LDSEe1R3JJ5w`). It runs weekly (Mon 08:00 Europe/Warsaw) and WARNs for any **full member** (role_key owner/admin/member; guests + limited_member excluded) **active in the last 30 days** (ClickUp `last_active`) who is **missing either** per-user token (MCP discovery and/or REST extraction), naming the missing token(s); the agent bot account is hard-excluded. Onboarding state comes from `get_clickup_onboarding_state()` (migration 044, SECURITY DEFINER, returns ids only — never token values). **Signal caveat:** `last_active` is "any ClickUp activity," not comment-posting specifically — ClickUp has no per-user comment-history API short of the Enterprise audit log, so a passive reader can be flagged; an exact comment-activity signal would require taping `taskCommentPosted` into a table (the CU Webhook Producer already receives every such event), deferred as a future upgrade with a ~30-day cold start. Verified live on the first run: it flagged exactly the 7 real gaps (6 fully-dark full members + Beniamin, who has MCP but no REST → "brak REST (extraction)"), 0 CRITICAL. **Knowingly not built** (operator decision 2026-06-24): the revoke script and the rollback scoping flag.
- **GDPR record updated** (`compliance/gdpr-processing-decisions.md`): ClickUp is now accessed under **per-user OAuth** (the departmental boundary enforced by the credential), with the discovery MCP-OAuth token held in the **Anthropic Vault** and the classic REST token in **Supabase Vault**; no new sub-processor (same Anthropic + Supabase already recorded).
- **Google explicitly deferred** to a follow-up ADR (Drive + Gmail per-user scoping out of scope; the retained client-side loop stays in place for that future tool).

**Net consequence vs the original Decision.** The decision's ClickUp mechanism ("one per-user OAuth token in the Vault with auto-refresh, stock MCP scoped by it") became **two non-expiring tokens, two consents, two stores** (MCP-OAuth in the Anthropic Vault for discovery; classic REST in Supabase Vault for as-U extraction) — because the hosted MCP is its own OAuth server, its token is 401 on REST, and n8n cannot read a harness-injected bearer (Block-1 probes). The §3 enforcement point (n8n binds the session to U at creation; the agent never holds or selects identity) is realized exactly as written. The §6 acceptance gate passed. R1/R3/R5 are all closed for ClickUp: no single bot identity for discovery (R1), no post-hoc application-code filtering (R3 — the `Check Space Member` filter is retired), no agent-supplied identity (R5).

## Amendment (2026-07-02) — silent ClickUp-MCP connection failure + detection hardening

**Incident.** On 2026-07-01 a real task (session `sthr_01MobK7caazrGk7zpiKTeQSg`, Opus, caller Franciszek) needed
to read a linked ClickUp Doc. Every `clickup_*` call was denied by the harness (`agent.tool_result`:
"Permission to use clickup_… has been denied"); the agent lost all scoped discovery/doc reading, worked around
it, and the run hit its deadline delivering nothing — twice (two retries in the same window).

**Root cause (confirmed).** Not config and not the vault: the deployed agent's ClickUp `mcp_toolset` carries
`always_allow` on all 14 read tools (verified against the live agent JSON), the session had both vaults attached
(image + the caller's ClickUp vault), and the credential row was active. The `clickup` **MCP server simply failed
to CONNECT in that session** (image MCP connected fine — 4 `mcp_tool_use`; ClickUp produced zero and its calls came
through as `custom_tool_use` → harness denial). Two direct probe sessions and a full real async-pipeline run
afterwards all connected ClickUp fine (17 Spaces returned), so the failure was **transient** (a ClickUp-MCP
connection hiccup at that time), not a standing misconfiguration. The incident ran the *synchronous* path (no
`waiter_sessions` row), which is why it deadlined at 840 s.

**Why it was invisible (the real defect).** No alert fired. (1) The waiter only recognised
`mcp_authentication_failed_error` for ClickUp; a silent no-connect emits no such event, so nothing WARNed.
(2) The health monitor only GET-pinged the OAuth well-known URL, which returns 2xx even during this failure.

**Fixes shipped.**
- **Waiter denial WARN** (`services/session-waiter/app.mjs`, `analyze()` + `driveSession`): detects any
  `agent.tool_result` "Permission to use clickup_… has been denied" and raises one consolidated
  `managed-agents/clickup-tool-denied` **WARN** through the finish callback → `Post Alert (v1)` (side-channel; the
  run still returns its degraded result). Verified: the detection matches all three incident-denied tools and
  nothing on healthy output.
- **Real health probe** (`ClickUp MCP Health Monitor (v1)`, `hrtNkFFL4iMVn9J9`): replaced the well-known ping with
  a genuine probe session (cheap Haiku agent + Franciszek's ClickUp vault) that calls
  `clickup_get_workspace_hierarchy` in-harness; CRITICAL on denial / client-tool routing / session error;
  inconclusive (agent never attempted it) does **not** alarm. Verified live: `healthy:true` in 6 s, probe session
  cleaned up.

The caller-scoped REST fallback for doc/search tools (so a future MCP outage degrades to deterministic reads
instead of nothing) remains the documented future block, still scoped OUT here.
