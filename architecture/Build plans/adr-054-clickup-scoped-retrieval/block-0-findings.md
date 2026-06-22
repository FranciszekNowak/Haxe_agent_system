# ADR-054 Block 0 — Capability-gate findings (the low-level ClickUp-scoping spec)

**Status: DONE 2026-06-22.** The linchpin question — *does a registerable hosted ClickUp MCP exist, and can
per-user OAuth tokens in the Anthropic Vault scope it to the triggering user?* — is answered **YES at the
mechanism level**, with **three concrete reshapes** the build must absorb (static-bearer not auto-refresh;
read-only toolset; the as-U extraction tool is load-bearing, not optional). The core design (stock ClickUp
MCP + per-user token in the Vault, selected per session) **holds**. The end-to-end *live* ClickUp scoping +
cross-department negative test could **not** run in this block and is correctly sequenced into Block 1's tail
/ Block 5 — see "Live-proof sequencing" below for why (it is a constraint, not a gap in the plan).

## Provenance (what was established, and how)

- **Proven live this block (our `ANTHROPIC_API_KEY`):** Managed Agents beta is reachable —
  `GET /v1/agents` → 200 and `GET /v1/vaults` → 200 with `anthropic-beta: managed-agents-2026-04-01`. No new
  key needed.
- **Documented (authoritative ClickUp + Anthropic docs):** the ClickUp hosted-MCP URL, its OAuth-only auth,
  the no-expiry/no-refresh/no-scopes token model, the MCP tool surface, and the Vault credential
  shape/keying/lifecycle. Sourced from developer.clickup.com (connect-an-ai-assistant, authentication, faq,
  mcp-tools) and the Anthropic Managed Agents Vault reference.
- **Corroborated live (this workstation's claude.ai ClickUp connector):** the ClickUp MCP is real and
  functional under OAuth, and the live `clickup_get_task` schema matches the docs (its `include` enum is
  exactly `custom_fields, checklists, dependencies, linked_tasks, watchers, subtasks, description` — note the
  absence of `attachments`).
- **Repo seams mapped** (throwaway Explore pass) — see "Repo hook points" below.
- **Proven live this block (vault CRUD):** `scripts/ma-spike-clickup-vault.py` ran against our org
  (throwaway vault + creds, all deleted afterward — no orphans). Results: `mcp_oauth` credential **accepted**
  (HTTP 200); secrets are **write-only** (GET returns `client_id`/`token_endpoint`/`token_endpoint_auth.type`
  but **not** `access_token`/`refresh_token`/`client_secret`); **in-place token rotation works** (HTTP 200,
  `updated_at`/`expires_at` advance); **keys are immutable** (sending `mcp_server_url` in an update →
  **HTTP 400 "unknown field"**); **unique key enforced** (duplicate `mcp_server_url` → **HTTP 409**);
  `static_bearer` baseline 200. → directly closes (b) and (g) with live evidence.

## (a) Hosted, registerable ClickUp MCP — **YES**

- **`https://mcp.clickup.com/mcp`** — ClickUp-operated, public beta, available on all plans. Registers directly
  as an Anthropic `mcp_servers` entry `{type:"url", name:"clickup", url:"https://mcp.clickup.com/mcp"}` (the
  same shape the image MCP uses). Single JSON-RPC-over-HTTP endpoint; transport is almost certainly Streamable
  HTTP (ClickUp's own pages don't name it, but the single-`/mcp`-endpoint pattern + secondary sources point
  there — immaterial to us, the harness handles transport).
- Distinct from community self-hosted servers (`@taazkareem/clickup-mcp-server` et al.), which run in our infra
  and take a `pk_` token — **not** what ADR-054 wants. Only the ClickUp-hosted URL gives per-user OAuth.
- → **Block 3:** `Sync Agent Definitions (v1)` adds this `mcp_servers` entry + a paired `mcp_toolset` on all
  four tier agents, mirroring the `haxe_image` entry.

## (b) Vault credential type — **static_bearer (not auto-refresh), because of (e)** — *proven live*

The Vault supports `mcp_oauth` (OAuth with an auto-refresh block — **accepted live**, HTTP 200),
`static_bearer`, and `environment_variable` (reference confirmed; secrets are write-only — verified live). **But ClickUp OAuth tokens do not expire and ClickUp issues no refresh token (see (e)),
so there is nothing to auto-refresh.** The clean fit is a **`static_bearer`** credential holding the user's
OAuth access token, keyed by `mcp_server_url = https://mcp.clickup.com/mcp`:

```
POST /v1/vaults/{vid}/credentials
{ "display_name":"clickup <user> (U)",
  "auth":{ "type":"static_bearer",
           "mcp_server_url":"https://mcp.clickup.com/mcp",
           "token":"<U's ClickUp OAuth access token>" } }
```

`static_bearer` is already proven live (ADR-053). This **removes** the Vault-auto-refresh dependency the plan
listed as an open risk, and **deletes the refresh dead-man's-switch** from Blocks 1/4 (there is no refresh to
monitor). Keep `mcp_oauth` as a *defensive fallback only if ClickUp later adds expiry* (their docs hedge
"subject to change") — and even then, with no refresh token we'd populate access-token-only and re-mint on
expiry, not auto-refresh.

## (c)/(d) Per-user scoping + the negative — **enforced by ClickUp; verify empirically**

- ClickUp enforces the **token's own user** permissions on every call; an OAuth token sees only what that human
  can see. A single `GET task` on a fully-inaccessible task returns **403** (community-sourced; official docs
  state access is enforced but don't pin the code); list/search endpoints **filter out** inaccessible items
  rather than erroring. Private Spaces/Folders/Lists are real, access-gated boundaries.
- The **MCP-specific** per-user guarantee is **inferred** from ClickUp's general OAuth model, not stated
  outright in the MCP docs. → **Must be proven empirically with two real cross-department accounts** — this is
  exactly Block 5's mandatory gate, and a minimal version should be pulled into Block 1's tail (see sequencing).
- Enforcement lives in the **credential**, not the agent → injection-resistant, as ADR-054 requires.

## (e) ClickUp OAuth app flow — **OAuth 2.1 + PKCE; no expiry, no refresh, no scopes**

- **MCP is OAuth-only and rejects personal `pk_` tokens** — verbatim: *"you cannot authenticate using your own
  API keys… We only support OAuth… OAuth 2.1 with PKCE."* The existing Member bot token (n8n cred
  `QRrgf6hteyGWSJyv`) **cannot** drive the MCP. A per-user OAuth 2.1 + PKCE flow is **mandatory**.
- **Authorize:** `https://app.clickup.com/api?client_id=…&redirect_uri=…[&state=…]` (ClickUp's in-app consent
  screen — not an `/oauth/authorize` path; user picks which Workspace(s) to authorize).
- **Token exchange:** `POST https://api.clickup.com/api/v2/oauth/token` with `client_id, client_secret, code`.
- **No token expiry, no refresh token** ("access token currently does not expire… subject to change"; a
  refresh-token feature request was closed "not on roadmap"). **No granular scopes** — there is no `scope`
  param; authorization is whole-Workspace, bounded by the user's own permissions (no read-only option).
- Only a Workspace owner/admin (Franciszek) can create the OAuth app.
- → **Block 1:** register the app; store `client_id`/`client_secret` as Supabase Vault secrets behind a
  `SECURITY DEFINER` getter (mirror `get_anthropic_key()` / migration 034); build a small PKCE
  consent + code-exchange flow (n8n webhook or onboarding script); write the per-user access token into a
  `static_bearer` Vault credential + a `user_clickup_credentials` mapping row. **Drop** the
  refresh/token-sync machinery the plan budgeted.

## (f) MCP tool surface — discovery only; **no attachment metadata, no extracted content**

~50 tools (officially listed at developer.clickup.com/docs/mcp-tools; the live server carries a few extra —
chat, reminders, merge). Groups: Search · Task CRUD + Set-Custom-Fields · Bulk · **Attach File (write only)** ·
Comments (get/threaded/create) · Tags · Dependencies · Move/Add-to-List · Time tracking · Workspace hierarchy ·
Members/Assignees · Chat · **Docs (get/create/update document pages)** · Time-in-status.

Against the ADR-054 boundary checklist:

| Returned by the MCP? | |
|---|---|
| Task **descriptions** | ✅ `clickup_get_task` with `include:["description"]` (summary ~10k-char truncation) |
| **Comments** | ✅ `get_task_comments` / `get_threaded_comments` |
| **Custom-field values** | ✅ `include:["custom_fields"]` (+ `get_custom_fields` for defs) |
| ClickUp-native **Doc page text** | ✅ `get_document_pages` (md/plain) |
| **Attachment metadata** (name/id/url) | ❌ **not a first-class MCP return** — `attachments` is *not* an `include` option and there is *no read-attachment tool* (only the *write* `Attach File`) |
| Extracted/OCR'd doc text, vision images | ❌ (matches the assumption) |

**This sharpens the inspect-then-extract split and makes the as-U extraction tool load-bearing, not just a
Docling step:** the MCP cannot even enumerate a task's attachments. To reach attachment content the pipeline
**must** go to ClickUp **REST** `GET /api/v2/task/{id}` (which *does* return the `attachments[]` array with
metadata + a download URL) **with U's OAuth bearer**, then run the existing Docling/Files-API pipeline. So
ADR-054's Option 2 (extraction re-validated as U) is not the "hardened nice-to-have" the plan framed — it is
**required** for any attachment-bearing related task. → **Block 3** steers the agent to use the MCP for
descriptions/comments/custom-fields discovery; **Block 4** provides the as-U REST extraction.

- **Read-only is a software requirement now** (no read-only scope exists). The `mcp_toolset` must allowlist
  only discovery/read tools and **disable every write tool** (Create/Update/Delete Task, Set Custom Fields,
  Create Comment, Attach File, Bulk, Move, Tags, Time tracking). Use the toolset's
  `default_config:{enabled:false}` + per-tool `configs:[{name,enabled:true}]` allowlist (empirically supported
  on `mcp_toolset`). → **new Block 3 acceptance item.**

## (g) Credential lifecycle — keys immutable; in-place secret update; revoke = delete + re-point — *proven live*

- Secret values + `display_name` are updatable in place (`POST /v1/vaults/{vid}/credentials/{cid}` → 200,
  verified live); the **keys are immutable** — sending `mcp_server_url` in an update body returns
  **400 "unknown field"** (verified live), so to change a key you **create-new + re-point** the mapping row
  (delete the old). Max 20 creds/vault; duplicate `mcp_server_url` in one vault → **409** (verified live).
- **For us this is nearly a non-event:** ClickUp tokens don't expire, so there is no rotation cadence. The only
  lifecycle transitions are **onboard** (create credential + mapping row) and **revoke/re-consent** (delete the
  credential, flip the row's `status`, re-point on re-consent). → **Blocks 1/6:** model revocation as
  delete-credential + status flip; no in-place token churn, no refresh health-check.

## (h) read-input-as-U token sourcing — **Variant A preferred; Variant B is now a light fallback**

The extractor (n8n) needs U's ClickUp token to call REST `GET task` as U. n8n cannot read U's token out of the
Anthropic Vault (proxied, by design). Two variants:

- **Variant A (preferred) — extraction as a self-hosted read-input MCP, harness injects U's token per call.**
  The harness forwarding a Vault bearer to *our* self-hosted endpoint is **already proven** (the image MCP:
  `agents.haxe.ai/mcp/haxe-image-gen` receives `Authorization: Bearer <token>` injected from the session's
  vault). Because **ClickUp tokens don't expire**, the *same* token value can sit in **two** `static_bearer`
  credentials — one keyed to `mcp.clickup.com/mcp` (discovery), one keyed to our read-input MCP URL
  (extraction) — with **zero sync/refresh concern**. No Supabase mirror, no split-brain.
  - **Residual unknown (the one real open item):** our read-input MCP endpoint must **read** the incoming
    per-user bearer (U's ClickUp token) and forward it to ClickUp REST — it must **not** validate it against a
    *fixed* secret the way the image MCP's n8n **MCP Server Trigger `bearerAuth`** does (that trigger expects
    one fixed token and would reject per-user tokens). So "reuse the image-MCP hosting pattern" is only
    half-true: **same nginx/TLS/n8n host, different auth handling.** Whether n8n's MCP Server Trigger can
    *expose* the incoming Authorization header to the workflow (vs. validate-and-discard) is untested. Resolve
    with a ~1-hour n8n probe early in Block 1/4. If it can't, Variant A needs a thin non-n8n handler (read the
    bearer → call n8n read-input with the task id + token) — or fall back to B.
- **Variant B (fallback) — custom client-side tool on the retained loop; n8n reads U's token from a Supabase
  Vault mirror.** The plan feared a "sync split-brain + token-sync dead-man's-switch." **That fear is largely
  retired:** with non-expiring tokens the mirror only changes on **onboard/revoke** (deliberate, rare events) —
  there is no refresh cadence to drift. B is now an acceptable, low-cost fallback, not a heavy one.
- **Decision:** prefer **A**; pin it with the n8n header-exposure probe in Block 1/4; fall back to **B** without
  meaningful penalty if the probe fails. **Not a blocker for Blocks 1–3.**

## Repo hook points (confirmed)

- **ClickUp token today:** n8n credential **`QRrgf6hteyGWSJyv`** ("ClickUp account", `clickUpApi` Bearer) —
  identity-agnostic bot. Used by `read-input.json` node **`r-get-task`** (`GET /api/v2/task/{id}`) and
  `workspace-search.json` node **`s-check-member`** (`GET /space/{id}/member`, the post-hoc filter to retire).
- **As-U hook:** `read-input.json` `r-get-task` is the single node whose credential swaps from the bot to U's
  OAuth bearer in as-U mode (REST presentation: `Authorization: Bearer <token>`). Everything downstream
  (Explode→Classify→Fetch-binary→Docling→Files-API) is unchanged.
- **vault_ids spread:** `execute-agent-session.json` `Build Setup` —
  `$json.image_mcp_vault_id ? { vault_ids:[$json.image_mcp_vault_id] } : {}`. Extend to spread the per-user
  clickup vault id(s) conditionally (Block 2). `Resolve Agent` SQL already pulls `image_mcp_vault_id` from
  `config`; add the `caller_user_id → user_clickup_credentials` resolution.
- **Image-MCP hosting (Variant-A reference):** `agents.haxe.ai/mcp/haxe-image-gen`, host nginx →
  `localhost:5678`, n8n MCP Server Trigger with `bearerAuth` (cred `mTlnNTCynGhQtYMO`). ADR-012.
- **Greenfield:** no OAuth app / per-user token scheme exists yet (no `oauth`/`client_secret`/`refresh_token`
  in migrations). Block 1 builds it.

## Live-proof sequencing (why the negative test isn't in Block 0)

Block 0 was scoped to "prove the shapes live with throwaway resources or surface a reshape." The **shape**
questions are answered (registerable hosted MCP: yes; per-user token in the Vault scoping it: yes via
static_bearer + `vault_ids`; tool surface and boundary semantics: documented + corroborated on the live MCP).
The **end-to-end live scoping + cross-department negative** test is **blocked by a real constraint, not an
oversight**: the MCP **rejects `pk_` tokens**, and we are **greenfield** (no OAuth app, no per-user tokens yet),
so there is no valid OAuth token to register and scope in-harness until Block 1 stands up the OAuth app and
onboards a user. **Recommendation:** pull a **minimal two-account negative smoke** (Marketing user cannot see a
Purchasing-only task via the scoped MCP) into the **tail of Block 1**, the moment two OAuth users exist — to
de-risk the *inferred* MCP per-user guarantee as early as possible. Block 5 remains the formal, exhaustive gate
across both discovery and extraction.

## Net effect on the master plan

- **Core design holds** — stock ClickUp MCP (`mcp.clickup.com/mcp`) + per-user OAuth token in the Vault,
  selected per session via `vault_ids`. No move to a custom ClickUp tool for *discovery*.
- **Reshape 1 — credential type:** use **`static_bearer`** (already proven), not Vault auto-refresh. **Delete**
  the refresh dead-man's-switch and the "Vault oauth credential" assumption from Blocks 1/4/6. Lifecycle =
  onboard + revoke only (no rotation cadence).
- **Reshape 2 — read-only by construction:** ClickUp OAuth has no scopes, so lock the `mcp_toolset` to a
  read/discovery **allowlist** and disable every write tool. New Block 3 acceptance item.
- **Reshape 3 — extraction is load-bearing:** the MCP returns no attachment metadata and no extracted content,
  so the as-U **REST** `GET task` extraction (Block 4) is *required* for any attachment-bearing related task,
  not an optional hardening. Option 2 confirmed.
- **Token-sourcing (h):** prefer **Variant A** (two `static_bearer` creds, same non-expiring token, no mirror);
  the one open item is whether n8n's MCP Server Trigger can expose the incoming bearer (probe in Block 1/4);
  **Variant B** is a light, acceptable fallback (no refresh churn).
- **Sequencing:** Block 1 = OAuth 2.1 + PKCE app + onboarding + 2 cross-dept users + a minimal negative smoke;
  Block 5 stays the exhaustive gate.
- **Unchanged:** task-bound Stage-A pre-gather stays on the bot token (`QRrgf6hteyGWSJyv`); the
  `Check Space Member` software filter is retired in Block 3; `static_bearer`/`vault_ids` mechanics and the
  image-MCP hosting pattern are reused.
