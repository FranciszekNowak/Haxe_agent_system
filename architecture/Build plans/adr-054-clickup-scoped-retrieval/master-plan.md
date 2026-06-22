# Master plan — ADR-054: Permission-scoped ClickUp context retrieval (Managed Agents)

> **This is the durable, cross-desktop source of truth** (the `~/.claude` plan file does not travel between
> machines). Run the house block-by-block routine: read this file top to bottom, do the first not-done
> block, write back to `architecture/current.md` + ADR-054, update the status table, commit, emit a handoff,
> `/clear`, repeat. Decision record: `architecture/decisions/054-permission-scoped-context-retrieval.md`.

## Context (why)

ADR-054 (Accepted, not yet built) makes the managed agent gather workspace context **under the triggering
user's identity, enforced by n8n at the executor — never trusted to the agent**. Per ADR-049 the
departmental boundary (e.g. Marketing cannot read Purchasing) is a real boundary, not advisory. Today the
managed lane reads ClickUp through a **single Member bot token** (`QRrgf6hteyGWSJyv`) on every task
regardless of who triggered it, and the only thing keeping the open-ended workspace search inside the
caller's permissions is a **software membership filter** (`workspace-search`'s `Check Space Member`) — which
is exactly the post-hoc filtering ADR-054 R3 rejects. A prompt-injected or simply over-broad bot can surface
another department's data. The fix: scope is enforced by the **credential** (the API acting as user U), so
the agent cannot exceed U's permissions, even under prompt injection.

This plan is **scoped to ClickUp only** (operator decision, 2026-06-22). Google (Drive + Gmail) is deferred
to a later follow-up ADR. It is written against the **live** repo state confirmed by exploration (the
ADR-053 managed lane, the Vault/`vault_ids` seam, the read-input + workspace-search pre-gather, the
`agent_routing`/`config` tables, the Supabase-Vault getter pattern), not against the ADR alone.

### Decisions locked with the operator (2026-06-22)

1. **ClickUp only.** Google retrieval (DWD or per-user OAuth) is out of scope and deferred to a follow-up.
   Consequence: the client-side custom-tool pause/resume loop in `Execute Agent Session (v1)` (retained by
   ADR-055 to service a future Google DWD tool) stays **dormant** for ClickUp scoping itself, which rides on
   `mcp_servers` + per-session `vault_ids`. (It may be *re-used* for the extraction tool if Block 0 picks
   the client-side token-sourcing variant — see decision #7.)

2. **Per-user scoping covers open-ended discovery + on-demand extraction, not the deterministic
   triggering-task pre-gather.** The Stage-A pre-gather of the **triggering** task stays on the bot token
   (`read-input (v1)` in its existing mode + `context-gather (v1)`) — U triggered on that task, so U already
   has access and the bot returns equivalent data, no leak. Per-user credential scoping is applied to (a)
   the **open-ended** related-task discovery that today runs as the bot under a software filter, and (b) the
   **agent-callable extraction** of discovered tasks (decision #7), which runs `read-input (v1)` in a new
   **as-U** mode. Smallest blast radius onto the surface that actually leaks.

3. **Block 0 is a capability-gate spike** (mirrors ADR-053 Block 0). The "stock ClickUp MCP + per-user OAuth
   token in the Anthropic Vault" mechanism (ADR-054 §2) is **unproven**: we have proven the Vault +
   `vault_ids` mechanics only with a `static_bearer` for our own image MCP. Block 0 proves the ClickUp
   primitives live (or reshapes the plan) before any production wiring.

4. **Open-ended discovery is an agent-driven live MCP tool, not n8n-driven.** Per ADR-054 §4, deciding what
   to search is judgment → the agent calls the scoped ClickUp MCP in-harness; the executor + Vault enforce
   scope. The pre-injected `additional_context` (related tasks) that `workspace-search` produces today is
   replaced by the agent's own scoped discovery; the agent `system` is updated to steer it.

5. **Degrade, don't break, for un-onboarded users.** A triggering user with no ClickUp token yet → the
   session is created **without** the scoped ClickUp tools (discovery + extraction simply absent); the run
   proceeds on deterministic task-bound pre-gather + a WARN telling the operator to onboard that user. The
   main path still returns a result.

6. **Scope-correctness testing is the mandatory acceptance gate** (ADR-054 §6, R-block). A mis-mapped
   credential fails silently and this boundary is the entire point, so the cross-department negative test —
   across **both** the discovery and the extraction paths — gates cutover.

7. **Inspect-then-extract, with extraction run as U (Option 2 — the hardened choice).** The scoped ClickUp
   MCP returns descriptions, comments, **custom-field values**, and attachment **metadata** (name/id/URL)
   under U's scope — it does **not** Docling-extract documents or build vision blocks. So the agent first
   *inspects* discovered tasks via the MCP, then, for any task it judges useful, calls a **per-user-scoped
   extraction tool that runs `read-input (v1)` with U's identity on the task fetch**. Because the fetch is
   re-validated **as U at extraction time**, ClickUp denies any task U cannot see — so the tool can safely
   take a **task id**: a prompt-injected "extract task xyz" for an out-of-scope task returns access-denied,
   not its contents. This realizes ADR-054 §4 ("task-bound context pre-gathered under U's identity, reusing
   the read-input layer") and keeps enforcement on the **credential**, never the agent. Chosen over the
   cheaper reference-only variant because that one only checks authority at discovery time and then trusts
   the attachment reference it was handed (a residual hole if a live pre-signed URL for an out-of-scope task
   is ever injected into context); as-U re-validation closes that. Latency cost ≈ one `GET task` round-trip
   (sub-second, immaterial vs Docling + model time); end-user friction is zero. The cost is operational and
   is the **token-sourcing sub-decision** (#8).

8. **Token-sourcing for read-input-as-U is a Block-0 sub-decision, preferring no second token store.**
   n8n cannot read U's token out of the Anthropic Vault (proxied, outside the sandbox — the Vault's whole
   point), so running read-input as U needs U's token reachable by the extractor. Two variants, decided in
   Block 0:
   - **Variant A (preferred) — extraction as a self-hosted MCP tool.** Expose read-input behind its own
     self-hosted MCP endpoint (reusing the image-MCP hosting pattern, ADR-055). Register a **second Vault
     credential per user keyed to that endpoint, holding U's ClickUp token**; the harness injects it per
     call, our handler forwards it to ClickUp, and n8n **never persists** it. No Supabase token mirror, no
     sync split-brain. Depends on the harness forwarding the bearer to our endpoint in a usable way — a
     Block-0 unknown. The dormant client-side loop stays dormant.
   - **Variant B (fallback) — extraction as a custom client-side tool** on the retained loop; n8n reads U's
     token from a **Supabase Vault mirror** of the per-user token. Works without the harness-forwarding
     assumption, but adds a second authoritative token store → every refresh/revoke must update both, and a
     partial update is a silent split-brain → needs a **token-sync dead-man's-switch**.

### Gaps / unknowns the spike (Block 0) must close

- Does ClickUp publish a **hosted, registerable** MCP server (a URL for `mcp_servers`) and what is its auth
  shape? If not, the design reshapes to a custom ClickUp tool on the retained loop (the loop's fallback use).
- Does the **Anthropic Vault support an `oauth` credential type** (auto-refresh), or only `static_bearer`?
  If static-only, store the access token and refresh it ourselves, or use ClickUp **personal API tokens**.
- Does a **ClickUp OAuth app** in the Haxe workspace issue per-user tokens the hosted MCP honors, and what
  scopes/consent/token-exchange/refresh flow does it need?
- **Negative-scope primitive:** with user A's credential, does a tool call for a task only B can see return
  access-denied/empty (boundary from the API), not A-sees-it-anyway?
- **MCP tool surface:** which tools the hosted ClickUp MCP exposes and exactly what each returns — confirm
  descriptions/comments/custom-field values/attachment metadata, and confirm it does **not** return
  extracted document text or vision images (this pins the boundary between MCP discovery and the as-U
  extraction tool).
- **Credential lifecycle:** can a Vault credential token be **updated in place**, or does rotation/refresh
  require **create-new + re-point** the mapping row? Decides the refresh path.
- **read-input-as-U token sourcing (decision #8):** does the harness forward a Vault bearer to our
  self-hosted read-input MCP endpoint in a way the handler can use as U's ClickUp token (Variant A)? If not,
  fall back to Variant B (Supabase mirror + sync guard).

> **Block 0 resolution (2026-06-22 — see `block-0-findings.md`):**
> - **Hosted MCP:** ✅ `https://mcp.clickup.com/mcp` (ClickUp-operated, public beta) — registerable as a stock
>   `mcp_servers` `{type:"url"}` entry.
> - **Vault credential type:** use **`static_bearer`** (already proven, ADR-053), **not** `mcp_oauth`/auto-refresh.
>   ClickUp OAuth tokens **do not expire, issue no refresh token, and have no granular scopes** → no refresh to
>   wire. **Drop** the refresh dead-man's-switch (Blocks 1/4) and the "Vault oauth credential" assumption below.
> - **Read-only:** no read-only scope exists → the `mcp_toolset` must **allowlist read/discovery tools and disable
>   every write tool** in software (new Block 3 item).
> - **Tool surface / extraction:** the MCP returns descriptions/comments/custom-fields/Doc-pages but **no
>   attachment metadata and no extracted content** → the as-U **REST** `GET task` extraction (Block 4) is
>   **required** (Option 2 confirmed), not optional. Hook: swap `read-input` `r-get-task`'s credential to U's
>   OAuth bearer (`Authorization: Bearer <token>`) in as-U mode.
> - **Token-sourcing (#8):** prefer **Variant A** — two `static_bearer` creds holding the *same* non-expiring
>   token (one keyed to `mcp.clickup.com/mcp`, one to our read-input MCP), **no Supabase mirror, no sync**.
>   The one open item: whether n8n's MCP Server Trigger can *expose* the injected per-user bearer to the workflow
>   (vs. validate-against-fixed like the image MCP) — a ~1h probe in Block 1/4. **Variant B** is now a *light*
>   fallback (non-expiring token → mirror changes only on onboard/revoke, no churn).
> - **Negative test:** the MCP **rejects `pk_` tokens** and we are greenfield → the **live** scoping+negative
>   test cannot run until Block 1's OAuth app exists. Pull a **minimal 2-user negative smoke into Block 1's tail**;
>   Block 5 stays the exhaustive gate.
> - **OAuth flow:** OAuth **2.1 + PKCE**; authorize at `app.clickup.com/api?client_id=…&redirect_uri=…`,
>   exchange at `POST api.clickup.com/api/v2/oauth/token` (`client_id,client_secret,code`); whole-Workspace
>   consent, owner/admin-only app creation.

## ⭐ ARCHITECTURE LOCKED — Option A (2026-06-22) — READ THIS FIRST; supersedes "Target architecture" + "The blocks" below where they conflict

Three live probes during Block 1 reshaped the design. This section is **authoritative**.

**What the probes settled (scripts preserved under `scripts/`):**
1. `ma-spike-clickup-mcp.py` — the hosted ClickUp MCP (`mcp.clickup.com/mcp`) **rejects** our classic OAuth-app
   token. It is its OWN OAuth 2.1 server (MCP Authorization spec 2025-06-18; `mcp.clickup.com/oauth/{authorize,token,register}`, DCR + PKCE, public client).
2. `ma-spike-clickup-mcp-oauth.mjs` — a token minted via that MCP OAuth flow **is accepted** by the MCP
   (`mcp_oauth_validate` → valid) and lives **~10 years** (`expires_in 315360000` → store as `static_bearer`,
   no refresh). BUT it is **HTTP 401 on ClickUp REST**, and `scope=read` is ignored (returns `read write`).
3. `ma-spike-bearer-forward.py` — n8n's MCP Server Trigger **cannot read** an injected per-user bearer
   (validate-and-discard), so a self-hosted **n8n** MCP cannot act as the user.

**Final design (Option A — buy commodity discovery, build only the custom extraction):**
- **Discovery = ClickUp's hosted MCP**, in-harness, scoped per user by a **MCP-OAuth token** (one per user, in
  the **Anthropic Vault**, harness-injected). Zero discovery-tool maintenance; grows with ClickUp. Read-only
  enforced by the `mcp_toolset` allowlist (no read-only OAuth scope exists).
- **Extraction = a client-side tool on the RETAINED agent loop** (NOT a self-hosted MCP). When the agent calls
  it, the session pauses to `Execute Agent Session`, which knows `caller_user_id`, reads that user's **classic
  REST OAuth token** from **Supabase Vault**, and runs the existing `read-input` pipeline (attachment fetch +
  Docling + vision) **as U**. This is the only place that can act as U for REST (n8n can't read the injected
  bearer; the hosted MCP returns no attachment content). "Extraction" = turning a task's file attachments into
  text/vision; "discovery" = finding/reading task text — different problems.
- **Two tokens per user (irreducible):** (1) MCP-OAuth token → Anthropic Vault (discovery); (2) classic REST
  OAuth token → Supabase Vault (identity at onboarding + extraction). Two different ClickUp OAuth servers, each
  rejects the other's endpoint → **two consents** at onboarding (one-time, chained in one onboarding flow).
  Both tokens are effectively non-expiring → no refresh machinery.
- **Session binding:** at `sessions.create`, attach the user's MCP-OAuth Vault credential via `vault_ids`
  (discovery scope). The REST token is looked up by the session loop from Supabase by `caller_user_id` (NOT via
  `vault_ids`).

**Already done in Block 1 (keep):** migrations 039/040/041 (applied); the hosted onboarding webhook
`ClickUp OAuth Onboarding (v1)` (`FKfVEyB62swT2FFN`) does the **classic REST flow** and is verified end-to-end
(Franciszek onboarded; alerts clean). ⚠️ His existing Vault credential `vcrd_01JmuSP6peYBrnUuvvhvd1Vv` (vault
`vlt_011CcJFTSejGJnjA4tEBcM7o`) holds the REST token keyed to `mcp.clickup.com/mcp` — **wrong placement**: the
REST token belongs in Supabase (extraction), and his Vault should instead hold a freshly-minted MCP-OAuth token.
Re-key during the Block-1 finish. ⚠️ The Anthropic API key was exposed in-session twice — **rotate it** (Console
+ Supabase Vault `anthropic_api_key` + VPS `.env`) if not already done.

**Revised block sequence (supersedes the table + "The blocks" below):**
- **Block 1 (FINISH):** ✅ **(a) + (b) BUILT + live-verified 2026-06-22; (c)–(e) operator-gated.**
  (a) the chained **MCP-OAuth flow** was added to the onboarding webhook (DCR + PKCE vs `mcp.clickup.com/oauth/*`,
  public client; minimal RFC-7591 register body) → stores the MCP token as a `static_bearer` in the user's
  Anthropic Vault keyed to `mcp.clickup.com/mcp`; (b) the REST token is stored in **Supabase Vault** via
  `set_clickup_rest_token()` + getter `get_clickup_rest_token(clickup_user_id)` (migration 042; state-table
  MCP-phase columns = migration 043). Webhook deployed (31 nodes, valid), re-exported drift-clean; non-token
  paths verified live (start 302 with real client_id, both callback rejects 400); PKCE `code_challenge` via the
  native Crypto node (SHA256→base64→base64url by string ops). **Still operator-gated:** (c) re-key Franciszek's
  credential (clear his row + old mis-keyed Anthropic vault, then re-onboard via the link); (d) onboard **1
  Marketing + 1 Purchasing** user (both tokens each); (e) **minimal negative smoke** — the Marketing user's
  **MCP-OAuth** token cannot see a Purchasing-only task via the hosted MCP (reuse `ma-spike-clickup-mcp.py`
  with a real MCP token + that user's vault). **DoD (remaining):** 2 cross-dept users with both tokens stored;
  negative smoke passes; alerts clean; Anthropic key rotation confirmed.
- **Block 2:** session-to-user binding — `Execute Agent Session` resolves `caller_user_id` → the user's
  MCP-OAuth Vault id, adds it to `vault_ids` (alongside `image_mcp_vault_id`); degrade + WARN if un-onboarded.
- **Block 3:** register the hosted ClickUp MCP on the 4 tier agents via `Sync Agent Definitions` + a **read-only
  `mcp_toolset` allowlist** (disable every write tool) + steer the shared `system` for open-ended discovery;
  retire the `Check Space Member` software filter in `workspace-search`; add a ClickUp MCP health dead-man's-switch.
- **Block 4:** client-side **extraction** tool on the retained loop — reads the REST token from Supabase by
  `caller_user_id`, runs `read-input` as U on a task id (out-of-scope id → access-denied); steer inspect-then-
  extract; a token-presence guard (WARN if a user has one token but not the other).
- **Block 5:** scope-correctness gate — cross-department negative matrix across discovery (hosted MCP) **and**
  extraction (client-side); mis-mapped credential fails loud. Gates cutover.
- **Block 6:** cutover, onboard the team, revoke/refresh ops (revoke = delete both tokens + flip row), rollback
  flag, write-backs (`current.md` + ADR-054 → landed), GDPR record (per-user OAuth; MCP token in Anthropic
  Vault, REST token in Supabase Vault).

**HANDOFF PROMPT for the next session (after `/clear`):**
> Read `architecture/Build plans/adr-054-clickup-scoped-retrieval/master-plan.md` in full (especially the
> "ARCHITECTURE LOCKED — Option A" section), then `block-0-findings.md` and `block-1-findings.md`. Option A is
> locked: discovery via ClickUp's hosted MCP (per-user MCP-OAuth token in the Anthropic Vault), extraction via
> a client-side tool on the retained loop (per-user classic REST token in Supabase Vault). **Block 1 code is
> BUILT + live-verified** (migrations 042/043; the onboarding webhook `ClickUp OAuth Onboarding (v1)` now chains
> both consents). **Two things gate Block-1 DoD, both operator actions:** (1) **onboarding** — re-key Franciszek
> (clear his `user_clickup_credentials` row + his REST secret + his old Anthropic vault `vlt_011CcJFTSejGJnjA4tEBcM7o`,
> then re-onboard via `https://agents.haxe.ai/webhook/clickup-oauth-start`), then onboard 1 Marketing + 1
> Purchasing user via the same link; (2) **Anthropic key rotation** confirmed. After the first real onboarding,
> **inspect that execution** (`node scripts/inspect-execution.mjs <execId>`) to confirm the PKCE/MCP token
> exchange succeeded (it 400s if the `code_challenge`/`code_verifier` mismatch — the one unproven path), then run
> the **cross-department negative smoke** (reuse `scripts/ma-spike-clickup-mcp.py` with the Marketing user's real
> MCP-OAuth token + a Purchasing-only task) to close Block 1. **Then start Block 2** (session-to-user binding in
> `Execute Agent Session (v1)`: resolve `caller_user_id` → the user's MCP-OAuth Vault id, add it to `vault_ids`,
> degrade + WARN if un-onboarded). Write back per block, commit, verify live per Definition of Done, route alerts
> through `Post Alert (v1)`.

## Target architecture (under ADR-054, ClickUp-only) — ⚠️ superseded above (extraction is client-side, not a self-hosted MCP; discovery needs a separate MCP-OAuth token)

- **Per-user ClickUp credentials.** A ClickUp OAuth app (or personal-token scheme, per Block 0); each team
  member's token stored as an Anthropic **Vault credential**; a new Supabase table maps
  `clickup_user_id → anthropic_vault_id(s)`. Client secret / app credentials in Supabase Vault via the
  `SECURITY DEFINER` getter pattern (migrations 032/034/036 precedent).
- **Session-to-user binding (the enforcement point).** At `sessions.create`, `Execute Agent Session (v1)`
  resolves the triggering `caller_user_id` → that user's credential(s) and adds them to `vault_ids`
  (alongside the existing `image_mcp_vault_id`). Under Variant A there are **two** per-user credentials
  (the scoped ClickUp MCP + the read-input MCP), both attached. Binding is set by n8n (which knows whose
  task it is), never passed by the agent → unspoofable.
- **Scoped ClickUp MCP (discovery).** `Sync Agent Definitions (v1)` registers the ClickUp MCP
  `mcp_servers` entry + paired `mcp_toolset` (`always_allow`) on all four tier agents. Per session, U's
  Vault credential scopes every ClickUp call to U. The agent uses it for open-ended discovery (find related
  tasks/docs the caller may see), driven by its own judgment.
- **Scoped extraction tool (read-input-as-U).** `read-input (v1)` gains an **as-U mode**: its ClickUp task
  fetch uses U's credential instead of the bot token (the rest of the pipeline — attachment fetch via
  pre-signed URLs, zip handling, Docling, Files-API image upload — is unchanged). Exposed to the agent as a
  tool keyed on a **task id**; ClickUp denies out-of-scope ids, so it is safe by construction. Hosted per
  Block-0's Variant A (self-hosted MCP, token injected per-call) or Variant B (custom tool on the retained
  loop, token from a Supabase mirror).
- **What the agent sees from discovery.** Inspect related tasks via the scoped MCP (descriptions, comments,
  custom-field values, attachment references — all only what U may see), then pull **full extracted content**
  (docs via Docling, images as vision) on demand for any of those tasks via the as-U extraction tool. The
  triggering task still gets full deterministic `read-input` in Stage A on the bot token.
- **Credential operations (all data, no code).** App secret rotation → update the Supabase Vault secret
  (getter reads by name). Per-user add → consent flow creates the Vault credential(s) + the
  `user_clickup_credentials` row. Revoke → flip row status + delete credential(s) (+ purge the Supabase
  mirror under Variant B). Refresh → re-write the token (exact mechanism — in-place vs create-new + re-point,
  one store vs two — fixed in Block 0).
- **Failover / degrade.** No per-user token → session without the scoped ClickUp tools + WARN; deterministic
  pre-gather still serves the run. A `config` flag can disable per-user scoping (revert to bot-only) for
  incident rollback.

### Internal contracts (shared references for the lane)

**Session-binding contract** (extends the `sessions.create` build in `Execute Agent Session (v1)`):
- in (already flows): `caller_user_id`, `impact`, `clickup_task_id`, trigger metadata.
- new resolution: `caller_user_id → { clickup_mcp_vault_id, readinput_mcp_vault_id? } | null` from
  `user_clickup_credentials`.
- `vault_ids` = `[image_mcp_vault_id?, clickup_mcp_vault_id?, readinput_mcp_vault_id?]` (each conditional,
  fail-soft — mirrors the existing `image_mcp_vault_id ? {vault_ids:[…]} : {}` pattern).

**Scoped extraction tool contract** (`read-input (v1)` as U):
- tool input: `{ clickup_task_id }`.
- behavior: `GET task` with **U's** ClickUp credential (out-of-scope id → access-denied/empty) → existing
  read-input attachment/zip/Docling/Files-API pipeline → returns blocks (text + image `file_id`s) +
  `warnings[]`.
- identity: Variant A — harness injects U's token to the read-input MCP endpoint; Variant B — n8n reads U's
  token from the Supabase Vault mirror. Never the bot token in as-U mode.

**User-credential mapping** (new table, append-only + status):
- `user_clickup_credentials(clickup_user_id pk, clickup_username, clickup_mcp_vault_id, readinput_mcp_vault_id,
  vault_credential_ids, status active|revoked|expired, consented_at, refreshed_at)`.

## Block status

> ⚠️ **Rows 2–6 below predate the Option-A lock** — their wording (single token, as-U self-hosted read-input
> MCP, Variant A/B) is superseded by the revised block sequence in "ARCHITECTURE LOCKED — Option A" above.
> Net for the next session: discovery = hosted MCP (MCP-OAuth token, Vault); extraction = client-side tool
> (REST token, Supabase). Use the ARCHITECTURE LOCKED block list as the plan of record.

| # | Block | State |
|---|---|---|
| 0 | Capability gate: prove the stock ClickUp MCP is registerable + per-user OAuth token in the Anthropic Vault scopes it to U in-harness; prove the negative (A's token can't read B-only data); the MCP tool surface; the credential lifecycle; **and the read-input-as-U token-sourcing variant (A self-hosted MCP per-call injection vs B Supabase mirror)** — **or** a clear "reshape" finding | ✅ done 2026-06-22 — `block-0-findings.md`. Core design **holds** (hosted MCP `mcp.clickup.com/mcp` is registerable; per-user token in Vault scopes it). **3 reshapes:** (1) credential = **static_bearer** not auto-refresh (ClickUp tokens don't expire / no refresh token / no scopes → drop the refresh dead-man's-switch); (2) lock the `mcp_toolset` **read-only** in software (no read-only scope exists); (3) the as-U **REST** extraction is **load-bearing** (MCP returns no attachment metadata + no extracted content). Token-sourcing: prefer **Variant A** (two static_bearer creds, same non-expiring token, no mirror); B is a light fallback. **Live ClickUp scoping+negative is gated on Block 1's OAuth app** (MCP rejects `pk_`; greenfield) — pull a 2-user negative smoke into Block 1's tail. |
| 1 | ClickUp OAuth app + per-user token storage: app registration (secrets via Vault getter), consent/token-exchange/refresh flow, `user_clickup_credentials` table (migration), per-user Vault credential(s) per the Block-0 variant, onboard ≥2 test users in different departments | 🟩 **Option A FINISH BUILT + live-verified (2026-06-22); only operator-gated onboarding remains.** Migrations 042 (REST-token store/getter, Supabase Vault) + 043 (MCP-phase state columns) applied + round-trip-verified; the onboarding webhook reworked to **chain both consents** (classic REST → store REST token in Supabase → DCR + PKCE → hosted-MCP consent at `/webhook/clickup-mcp-callback` → mint the MCP-OAuth token + per-user Anthropic Vault `static_bearer` + upsert mapping row); PKCE via the native Crypto node; deployed (31 nodes, valid), re-exported drift-clean; start (302, real client_id), classic-callback-reject (400) and mcp-callback-reject (400) verified live; 0 onboarding alerts. **ALLOWLIST GATE (2026-06-22):** ClickUp's hosted MCP allowlists HTTPS redirect URIs — the self-serve webhook's MCP-DCR returns 400 "not allowlisted" (form submitted; the production webhook switches on unchanged once approved). The OAuth **loopback** path is un-gated, so interim onboarding uses **`scripts/onboard-clickup-mcp-user.mjs`** (loopback DCR+PKCE → per-user Anthropic Vault static_bearer + row). **DISCOVERY PROVEN LIVE:** Franciszek onboarded (vault `vlt_011CcJU6Q9MVqpds2D1VLmLH`); a throwaway agent with his vault called `clickup_get_workspace_hierarchy` and returned his real 17 Spaces (no auth error) — the linchpin positive test passes; rotated Anthropic key confirmed working. **OPERATOR-GATED REMAINDER (gates DoD):** onboard 1 Marketing + 1 Purchasing user (loopback), run the cross-department negative smoke (CEO sees all spaces → needs a limited user). — see the "ARCHITECTURE LOCKED — Option A" section above + `block-1-findings.md`. **Discovery** = hosted ClickUp MCP (per-user **MCP-OAuth** token in the Anthropic Vault; ~10y static_bearer; read-only via the toolset allowlist). **Extraction** = client-side tool on the retained loop (per-user **classic REST** token in **Supabase Vault**, read by the session loop by `caller_user_id`). **Two tokens, two consents** (irreducible). Driven by three probes: the MCP rejects our classic app token; the MCP-OAuth token works but is **401 on REST**; n8n **can't read** an injected bearer. **Block-1 FINISH:** add the MCP-OAuth flow to onboarding, store the REST token in Supabase + a `get_clickup_rest_token()` getter, re-key Franciszek's credential, onboard 1 Marketing + 1 Purchasing user, run the minimal negative smoke. Vault/`vault_ids` injection + first-user onboarding mechanics all proven. **Built + live:** migration 039 `user_clickup_credentials` (RLS-enabled, no-policy; one `vault_id` per user — the plan's two vault columns collapse to one because both per-user creds share a vault, no 409); migration 040 `get_clickup_oauth_app()` getter (callable, nulls until seeded); migration 041 `clickup_oauth_state` (CSRF). **Consent flow = a self-serve hosted n8n webhook** `ClickUp OAuth Onboarding (v1)` (`/webhook/clickup-oauth-start` → ClickUp consent → `/webhook/clickup-oauth-callback` exchanges code → per-user Vault + `static_bearer` cred keyed to `mcp.clickup.com/mcp` → mapping row; alerts via Post Alert; token not persisted on success), deployed + drift-clean; start (302) and callback-reject (400) paths verified live. `scripts/onboard-clickup-user.mjs` kept as a dev fallback. **No refresh machinery** (Block-0: tokens don't expire). **MCP-trigger probe:** provisional — bare-n8n Variant A **doubtful** (all auth modes validate-against-fixed; image MCP confirms); **definitive probe deferred to Block 4** (needs a real token, non-blocking for 1–3); Variant B is a cheap fallback. **PENDING (gates completion):** Franciszek registers the OAuth app (redirect `https://agents.haxe.ai/webhook/clickup-oauth-callback`) + seeds the 2 secrets → onboard 1 Marketing + 1 Purchasing user via the start link → minimal negative smoke. |
| 2 | Session-to-user binding: `Execute Agent Session (v1)` resolves `caller_user_id →` the user's vault credential(s) and adds them to `vault_ids`; degrade + WARN for un-onboarded users | ⬜ not started |
| 3 | Register the scoped ClickUp MCP (discovery) on the 4 agents (`Sync Agent Definitions`) + steer the `system`; retire the open-ended search-as-bot + `Check Space Member` software filter from Stage A; ClickUp MCP health dead-man's-switch | ⬜ not started |
| 4 | `read-input (v1)` as-U extraction tool: add an as-U fetch mode (U's credential on `GET task`), expose it to the agents (Variant A self-hosted read-input MCP, or Variant B custom tool on the retained loop), steer the agent to inspect-then-extract; health/sync guard per variant | ⬜ not started |
| 5 | Scope-correctness acceptance gate: cross-department negative test matrix across **both** discovery and extraction (Marketing-triggered task cannot retrieve Purchasing-only data via any path, incl. "extract task xyz"); mis-mapped credential fails loud | ⬜ not started |
| 6 | Cutover, ongoing ops (onboard all members, token refresh/revocation, health/sync), write-backs (current.md + ADR-054 → landed), GDPR record, note Google deferred | ⬜ not started |

Each block ends with: write-back to `current.md` + ADR-054, status-table update, commit, handoff. Live
verification (not "looks right") per Definition of Done; all alerts through `Post Alert (v1)`; never read or
post-watch the Alerts task `869dj2z2c`; migrations append-only; exported workflow JSON re-exported after any
live change, never hand-edited.

## The blocks

### Block 0 — Capability gate (the linchpin; everything is gated on it)
- **Do:** against the live beta with our Anthropic key + the `managed-agents-2026-04-01` beta header, and a
  ClickUp OAuth app (or one real user's ClickUp token), prove and record each primitive in isolation:
  (a) whether ClickUp offers a **hosted/remote MCP server** registerable via `mcp_servers` (URL + name) and
  its exact auth shape; (b) whether the **Anthropic Vault** accepts an `oauth` credential (auto-refresh) or
  only `static_bearer`; (c) create a Vault credential from **one real user's** token, attach via
  `vault_ids`, confirm the agent calls a ClickUp tool **in-harness, scoped to that user**; (d) the
  **negative** — with user A's credential a call for a task only B can see returns access-denied/empty;
  (e) the **OAuth app** scopes + consent + token-exchange + refresh flow; (f) the **MCP tool surface** —
  which tools and that they return descriptions/comments/custom-field values/attachment metadata but **not**
  extracted text or vision images; (g) the **credential lifecycle** — in-place token update vs create-new +
  re-point; (h) **read-input-as-U token sourcing** — does the harness forward a Vault bearer to a
  self-hosted read-input MCP endpoint usably (Variant A), or do we need the Supabase mirror (Variant B)?
  Reuse the spike-script pattern (`scripts/ma-spike-vault.py`, `scripts/ma-spike.py`).
- **DoD:** a written findings note (the missing low-level spec, saved under this plan's directory) capturing
  every shape above and **the chosen token-sourcing variant**, **or** a clear "no registerable hosted
  ClickUp MCP / Vault oauth unsupported" finding that reshapes Blocks 1–4 (custom ClickUp tool on the
  retained loop, or personal API tokens as `static_bearer`) before any production wiring. No production
  wiring; tear down the throwaway app/credential/session/endpoint.
- **Silent-failure modes:** none in production (spike only); the risk it retires is *building the whole
  ClickUp-scoping path on a wrong MCP/Vault/OAuth/token-sourcing assumption*. Confirm beta access + a usable
  ClickUp OAuth app first.

### Block 1 — ClickUp OAuth app + per-user token storage
- **Do:** register the ClickUp OAuth app in the Haxe workspace; store client id/secret as Supabase Vault
  secrets with a `SECURITY DEFINER` getter (mirror `get_anthropic_key()` / migration 034). Build the
  consent + token-exchange (+ refresh) flow — a small n8n webhook workflow or onboarding script — that, per
  consenting user, creates the per-user **Anthropic Vault credential(s)** (one for the ClickUp MCP; under
  Variant A also one keyed to the read-input MCP; under Variant B also a Supabase Vault token mirror) and
  records the mapping in a new **`user_clickup_credentials`** table (append-only migration). Onboard **≥2
  test users in different departments** (one Marketing, one Purchasing) for the Block-5 gate.
- **DoD:** each onboarded user has the live Vault credential(s) + a mapping row; a token can be refreshed (or
  the static-token scheme from Block 0 is in place); reading back the credential proves it is the right
  user's; under Variant B the mirror matches the Anthropic Vault copy.
- **Silent-failure modes:** token expiry/refresh failure silently breaking a user's scoping → a refresh
  health-check WARN (dead-man's-switch on `refreshed_at` staleness); a failed consent silently leaving no
  mapping → onboarding asserts the row + credential(s) exist, WARNs on miss; (Variant B) a mirror that
  drifts from the Anthropic Vault → a token-sync consistency check.

### Block 2 — Session-to-user binding (the enforcement point)
- **Do:** in `Execute Agent Session (v1)`, resolve the triggering `caller_user_id` → the user's vault
  credential(s) from `user_clickup_credentials` (extend the `Resolve Agent` query or add a step), and build
  `vault_ids` to include them conditionally alongside `image_mcp_vault_id` (extend the existing fail-soft
  `Build Setup` spread). For a user with **no** active credential → omit the ClickUp vaults (the scoped
  tools will be absent) and carry a `clickup_scope:'degraded'` flag → a consolidated WARN. Binding is set by
  n8n only.
- **DoD:** a session for an onboarded user carries that user's vault id(s) (verified by reading the session +
  a live scoped ClickUp read); a session for a non-onboarded user is created without the ClickUp vaults,
  proceeds on deterministic pre-gather, fires exactly one WARN; the agent never supplies the identity.
- **Silent-failure modes:** wrong/blank user silently scoping wrong → fail-safe to *no* ClickUp vault
  (degraded, never the bot's broad view through a tool) + WARN; a resolve query error → degrade + WARN,
  never a thrown session.

### Block 3 — Scoped ClickUp MCP discovery + retire the software filter
- **Do:** via `Sync Agent Definitions (v1)`, add the ClickUp MCP `mcp_servers` entry + paired `mcp_toolset`
  (`always_allow`, mirror the `haxe_image` entry) to the four tier agents, and update the shared `system`
  to steer the agent to use it for **open-ended related-context discovery** scoped to the caller (bump
  `CONV` to force the re-sync). In Stage A (`assemble-context` / `workspace-search`), **retire the
  open-ended search-as-bot path and the `Check Space Member` software filter** (ADR-054 R3) — keep the
  triggering task's own comments (task-bound, bot token). Add a **ClickUp MCP health dead-man's-switch**
  (mirror `Image MCP Health Monitor (v1)`: probe + WARN/CRITICAL via `Post Alert (v1)`).
- **DoD live:** an @-mention task by an onboarded user → the agent performs open-ended ClickUp discovery
  in-harness scoped to U, and a task the **bot** could see but **U cannot** is **not** returned; the software
  filter no longer gates discovery; the health check trips on a deliberately-down endpoint; alerts clean.
- **Silent-failure modes:** ClickUp MCP down → the health dead-man's-switch + the agent surfaces the tool
  error + WARN (never silent zero-context); partial sync (agents updated, MCP misconfigured) →
  `Sync Agent Definitions`' existing per-tier CRITICAL + a live discovery test.

### Block 4 — `read-input (v1)` as-U extraction tool (inspect-then-extract)
- **Do:** add an **as-U mode** to `read-input (v1)` — its `GET task` uses the caller's ClickUp credential
  instead of the bot token (everything else unchanged); the existing Stage-A pre-gather keeps calling it in
  bot mode. Expose it to the agents as a **task-id-keyed extraction tool** per the Block-0 variant — Variant
  A: a self-hosted **read-input MCP** (reuse the image-MCP hosting pattern; the harness injects U's token
  per call); Variant B: a **custom client-side tool** on the retained loop (n8n reads U's token from the
  Supabase mirror). Update the agent `system` to inspect via the MCP, then call the extraction tool by id
  for tasks it judges useful. Add the per-variant guard: Variant A → an endpoint health check; Variant B →
  the token-sync dead-man's-switch.
- **DoD live:** for a task **U can see**, the agent extracts a discovered task's attachment content (doc text
  / image) end-to-end; for a task **only another department can see**, an explicit "extract task xyz"
  prompt returns **access-denied/empty**, not its contents (re-validated as U at fetch); the tool never runs
  as the bot in as-U mode; alerts clean. Verified live with the two cross-department test users.
- **Silent-failure modes:** extraction failure must **fail-soft** (return a tool result describing the
  failure + WARN, never throw into the session — reuse read-input's existing `warnings[]`); an as-U fetch
  silently falling back to the bot token → an explicit assertion that the credential is present, else
  access-denied + WARN (never bot-broad); (Variant A) harness fails to forward the token → the tool sees no
  credential → access-denied + WARN, not a silent bot read.

### Block 5 — Scope-correctness acceptance gate (mandatory)
- **Do:** with the two cross-department test users + disposable tasks (a Purchasing-only task the Marketing
  user cannot see), run the full @-mention flow as the Marketing user and **prove no Purchasing data is
  retrievable through any path**: task-bound pre-gather (only ever touches the triggering task, which is
  U's), open-ended discovery via the scoped MCP (Purchasing-only task not returned), and the as-U extraction
  tool (an explicit "extract task xyz" for the Purchasing-only id returns access-denied). Deliberately
  mis-map one user's vault → confirm it fails **loud** (degrade + WARN / access-denied), not silently broad.
  Record the matrix as a findings note.
- **DoD:** a documented test matrix showing the departmental boundary holds end-to-end across discovery
  **and** extraction, and that a mis-mapped/absent credential degrades loudly. This block gates cutover.
- **Silent-failure modes:** the entire point — a silent cross-department leak. Covered by the negative tests
  being explicit pass/fail gates (one per path), not afterthoughts; a mis-map surfacing as a WARN, not a
  quiet success.

### Block 6 — Cutover, ongoing ops, write-backs, GDPR
- **Do:** onboard the rest of the team; confirm token refresh + a revocation path (revoke → `status` flip +
  credential(s)/mirror purge → next session degrades + WARN). Confirm the rollback (`config` flag →
  bot-only). Write back: `architecture/current.md` (the managed lane now retrieves ClickUp per-user-scoped
  for discovery + extraction; the software filter is retired) and ADR-054 consequences → landed (note Google
  explicitly deferred to a follow-up ADR). Update `compliance/gdpr-processing-decisions.md` (ClickUp accessed
  under per-user OAuth; per-user tokens held in the Anthropic Vault, and under Variant B mirrored in Supabase
  Vault; confirm processing basis). Final commit.
- **DoD:** all members onboarded; the Block-5 boundary holds with real users; the degrade/rollback paths
  verified; the Alerts channel clean (or every WARN explained); docs reconciled.
- **Silent-failure modes:** a user silently un-onboarded still running (degraded) unnoticed → an onboarding
  coverage check (members without an active credential) WARNs; a doc claiming per-user-scoped while a path
  still uses the bot for discovery/extraction → the Block-5 matrix + a drift check gate the flip.

## Critical files / components

- `n8n/workflows/execute-agent-session.json` — `vault_ids` build (`Build Setup`) + `caller_user_id →`
  vault credential(s) resolution (Block 2); the dormant client-side loop is reused only if Block 0 picks
  Variant B.
- `n8n/workflows/sync-agent-definitions.json` — add the ClickUp MCP `mcp_servers`/`mcp_toolset` entry + the
  discovery + inspect-then-extract `system` steering; bump `CONV` (Blocks 3–4).
- `n8n/workflows/read-input.json` — add the **as-U fetch mode** (caller credential on `GET task`); existing
  bot-mode Stage-A pre-gather unchanged (Block 4).
- `n8n/workflows/assemble-context-and-build-prompt.json` + `n8n/workflows/workspace-search.json` — retire the
  open-ended search-as-bot + `Check Space Member` software filter; keep task-bound reads (Block 3).
- **New:** the ClickUp OAuth consent/onboarding workflow-or-script; a ClickUp MCP health monitor (mirror
  `Image MCP Health Monitor (v1)`); (Variant A) a self-hosted **read-input MCP** server; (Variant B) a
  token-sync dead-man's-switch.
- Migrations (append-only): `user_clickup_credentials` table + a ClickUp OAuth app-secret getter (Block 1),
  a `config` rollback flag if used.
- Reused unchanged: the Vault create/credential/`vault_ids` mechanics (proven via `ma-spike-vault.py` + the
  image MCP), the image-MCP hosting pattern (for Variant A read-input MCP), the `SECURITY DEFINER` getter
  pattern (migrations 032/034/036), `agent_routing`/`config`, the Member bot token `QRrgf6hteyGWSJyv` (stays
  for task-bound Stage-A pre-gather).

## Open risks the plan stays alert to

- **Block 0 may invalidate the "stock ClickUp MCP + Vault OAuth" assumption** → Blocks 1–4 reshape toward a
  custom ClickUp tool on the retained loop, or per-user personal API tokens as `static_bearer` (flagged
  loudly if hit). The one place that could force more custom build.
- **read-input-as-U token sourcing** — Variant A depends on the harness forwarding a Vault bearer to our
  self-hosted endpoint usably (Block-0 gate). If it fails, Variant B's Supabase mirror adds a second
  authoritative token store and a sync split-brain failure mode (the MCP works but extraction fails, or vice
  versa) → guarded by the token-sync dead-man's-switch.
- **A new always-on ClickUp MCP (and, Variant A, read-input MCP) dependency** is a new operational/failure
  surface → the Block-3/Block-4 health dead-man's-switches.
- **Per-user token lifecycle** (consent, refresh, revocation across one or two stores) is ongoing toil →
  onboarding + refresh + coverage checks; a missing token degrades loudly, never silently bot-broad.
- **Behavior change:** open-ended discovery moves from pre-injected `additional_context` to agent-driven
  search + on-demand extraction — quality depends on the `system` steering; verified in the Block-5 matrix.
- **Google deferred:** Drive + Gmail per-user scoping is explicitly out of scope; the retained client-side
  loop stays in place for that future follow-up.

## Verification (how each block and the whole is proven)

- Per block: `node scripts/test-subworkflow.mjs <id> --file ./input.json` to drive `When Called`
  sub-workflows (build the input JSON with Node, never hand-escaped); `node scripts/inspect-execution.mjs
  <execId>` for the per-node view; `node scripts/alerts-since.mjs <minutes>` to scan the Alerts channel;
  `node scripts/check-workflow-drift.mjs` after any live change; delete test `agent_runs` rows + disposable
  ClickUp test tasks afterward.
- Block 0: a throwaway spike script (`scripts/ma-spike-*.py` family) proving the ClickUp MCP/Vault/OAuth +
  read-input-as-U token-sourcing shapes live; no production wiring.
- Block 5 (the gate) + whole-system: @-mention the agent as two real cross-department users on disposable
  `Lista testy AI` tasks; confirm the caller's own task context is served, that open-ended discovery returns
  only what the caller may see, that the as-U extraction tool returns access-denied for a cross-department
  "extract task xyz", that an un-onboarded user degrades + WARNs, and that the Alerts channel is clean.
