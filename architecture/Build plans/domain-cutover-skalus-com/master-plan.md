# Master plan — hard cutover `agents.haxe.ai` → `agents.haxe.pl`

Status: DRAFT (not started)
Date opened: 2026-07-03
Owner: Franciszek
Supersedes on completion: ADR-012 (a new ADR is written in Block 5)

## Goal

Move every live and repo reference from `agents.haxe.ai` to `agents.haxe.pl`, then
**decommission `agents.haxe.ai` entirely** (DNS, TLS cert, nginx block). The old domain
will no longer be maintained.

## Why this is not a find/replace

Four things break on cutover and **none of them are in the repo** — they are external
registrations that must be changed by hand, in the right order:

1. **TLS cert** — Let's Encrypt currently holds a cert for `agents.haxe.ai` only. `.pl`
   needs its own cert (certbot), issued *before* traffic moves.
2. **ClickUp webhook endpoint(s)** — registered *inside ClickUp* (team `761759`) pointing at
   `https://agents.haxe.ai/webhook/...`. n8n's `WEBHOOK_URL` does **not** rewrite these; they
   must be updated via ClickUp's webhook API (`PUT`, which preserves the HMAC secret).
   **ClickUp auto-deletes a webhook after ~100 consecutive failures** → repoint before `.ai` dies.
3. **ClickUp OAuth app redirect URI** — registered in ClickUp's app settings as
   `https://agents.haxe.ai/webhook/clickup-oauth-callback`. Onboarding breaks until changed.
4. **MCP endpoint URL Anthropic calls** — `https://agents.haxe.ai/mcp/haxe-image-gen`, emitted
   at runtime by our session-builder workflow. Fixed by editing the n8n workflows (Block 4c).

## Sequencing principle

`agents.haxe.pl` is a new subdomain in a **separate DNS zone** (the `haxe.pl` storefront
domain), so we can stand it up fully **alongside** the live `.ai` service, cut every
registration over while both work, verify end-to-end, and only then tear `.ai` down. "Hard
cutover" here means *`.ai` is removed at the end* — not that we break it before `.pl` is proven.

🔴 = **OPERATOR ACTION** (Franciszek, outside the repo — registrar, VPS, ClickUp, local machines).
Everything else is repo work Claude can do.

---

## Block status

| Block | Title | Status |
|------|-------|--------|
| 0 | Verify assumptions + inventory external registrations | ✅ (findings below) |
| 1 | DNS: create `agents.skalus.com` A record | ✅ resolves on 8.8.8.8 + 1.1.1.1 |
| 2 | TLS + nginx on VPS (dual-serve) | ✅ cert to 2026-10-01; both domains 200 |
| 3 | n8n env: `WEBHOOK_URL` / `N8N_EDITOR_BASE_URL` → `.com` | ✅ verified in n8n-main printenv |
| 4a | ClickUp webhook endpoint → `.com` | ✅ PUT done; ⏳ pending live @-mention verify |
| 4b | ClickUp OAuth app redirect URI → `.com` | ☐ (operator, ClickUp UI) |
| 4c | n8n workflow strings (sync-defs, health-monitor, onboarding) + re-run sync | ✅ sync re-run verified (Anthropic stores `.com`); health verified; onboarding edited (verify on next real onboard) |
| 4d | VPS `watchdog.env` URL → `.com` | ✅ |
| 5 | Repo + tooling + local env + new ADR | 🔶 repo/docs/workflows/ADR done; local `setx` (operator) + commit pending |
| 6 | Decommission `agents.haxe.ai` | ☐ (gated on: 4b confirmed + `.ai` nginx access log quiet) |

> Block 4c verification 2026-07-03: sync manual run (exec 8149) took the update branch for all 3
> agents; `Upsert Agent` response from Anthropic shows `mcp_servers[0].url =
> https://agents.skalus.com/mcp/haxe-image-gen`, `conventions_version=17`. Image MCP endpoint
> returned a valid MCP `initialize` (200) on `.com` via direct pg_net probe. Mention path verified
> earlier (exec 8125, HMAC valid, enqueued, 0 alerts).
>
> Block 5 done: 21 repo files flipped (scripts/.mcp.json/.env.example/infra-comments/living-docs, via
> subagent — 36 occurrences), 3 workflow JSON copies written back to match live, `nginx-agents.conf`
> reference rewritten to skalus-only final state, **ADR-070** created (supersedes ADR-012; ADR-012
> status updated). Intentionally left on old domain (documented in ADR-070): migration 041,
> Build-plans findings, ADR-012/017/018/025 bodies, and the one `haxe-image-mcp.json` doc note (schema[]
> hazard). Still pending: operator `setx N8N_API_URL` on both desktops; the commit; the dir rename
> (`domain-cutover-haxe-pl` → skalus) at commit time.

> Progress note 2026-07-03: target domain is **`agents.skalus.com`** (not the earlier `-haxe-pl`
> working title — rename this dir/file in Block 5). Blocks 1–3 + 4a executed live via SSH/API and
> verified. `.ai` stays fully dual-served until Block 6, so remaining 4b–4d workflow/registration
> edits are not time-critical — they only must complete + verify BEFORE the Block 6 decommission.

---

## Block 0 — Verify assumptions + inventory (no changes)

Everything downstream assumes these; confirm before touching anything.

- 🔴 **`.ai` decommission timeline.** Is the `haxe.ai` domain being *let lapse* on a date, or
  just retired by us on our own schedule? If it has a hard expiry, **all blocks must finish
  before it** (otherwise the webhook self-deletes and TLS renewal fails). Write the date here.
- 🔴 **DNS zone access.** Confirm you can edit the **`haxe.pl`** DNS zone (this is your
  storefront domain — possibly a different registrar/host than `haxe.ai`).
- 🔴 **VPS IP unchanged.** Confirm the target is still `185.25.149.174` (ADR-012).
- **Inventory ALL ClickUp webhooks** (not just `cu-comment` — ADR-029 mentions Phase-3
  status/field-change webhooks too):
  `GET https://api.clickup.com/api/v2/team/761759/webhook` → list every `id` + `endpoint`
  currently on `agents.haxe.ai`. Record them; each gets repointed in Block 4a.
- **Inventory the VPS watchdog crons.** `disk-watchdog.sh` and `consumer-heartbeat-watchdog.sh`
  carry `WATCHDOG_URL=https://agents.haxe.ai/webhook/...`; confirm whether they read it from
  env or a hardcoded copy deployed on the VPS (both must change in Block 4/5).
- **Confirm what emits the Anthropic MCP URL.** Grep-confirmed emitters: the image session
  builder (`mcp_servers` url) + `image-mcp-health-monitor.json` (probe url) + `haxe-image-mcp.json`.

**Definition of Done:** the `.ai` timeline is written down; DNS-zone + VPS access confirmed;
a complete list of ClickUp webhook ids/endpoints and VPS watchdog URLs is recorded in this file.

#### Block 0 — findings recorded 2026-07-03 (target domain: `agents.skalus.com`)

Read-only inventory done autonomously; the three 🔴 confirmations + the ClickUp webhook list
are still outstanding (see "still open" below).

- **VPS live env values** (`franciszek@185.25.149.174`, confirmed via SSH):
  - `/opt/haxe-agents/.env` lines **6** (`WEBHOOK_URL`) and **11** (`N8N_EDITOR_BASE_URL`) → both
    `https://agents.haxe.ai`. These are the Block 3 edit targets.
  - `/opt/haxe-agents/watchdog.env` line **1**:
    `WATCHDOG_URL=https://agents.haxe.ai/webhook/storage-watchdog-7e06358ac257ad20` — the **single
    live watchdog URL** and the Block 4d edit target. The `.sh` scripts only mention it in comments.
  - Stale backups `/opt/haxe-agents/.env.bak` + `.env.bak-adr056` also hold the old URL — harmless,
    leave them.
- **Anthropic MCP URL source (gap resolved):** the URL Anthropic calls
  (`https://agents.haxe.ai/mcp/haxe-image-gen`) is **not** hardcoded in the session builder —
  `execute-agent-session.json` only passes `vault_ids` + `environment_id` to Anthropic. The
  `mcp_servers[].url` is carried in **`sync-agent-definitions.json`**, which pushes the agent
  definition up to Anthropic's managed-agent config. **Consequence for Block 4c:** editing that
  workflow is not enough — you must **re-run the sync** afterward so Anthropic's stored definition
  picks up `agents.skalus.com`; until then Anthropic keeps calling the old endpoint from cached config.
- **ClickUp webhook ownership (critical for Block 4a):** `GET /api/v2/team/761759/webhook` executed
  in-DB via `pg_net` using a vault OAuth token returned **200 with an empty `webhooks` array**. All
  7 vault `clickup_rest_token_<user>` secrets belong to the **same OAuth app**
  (`clickup_oauth_client_id`), and ClickUp scopes webhook listing to the creating app — so the
  cu-comment webhook is registered under the **agent's personal ClickUp API token** (an n8n
  credential, not in the vault). **Block 4a requires that personal token** to run the `PUT`; the
  vault tokens cannot see or repoint it.
- **Supabase project:** `haxe-agent-prod` = `hkeslnosxibeuesxndnz` (EU-west-1). `pg_net` available.

**Resolved 2026-07-03:**
- `.ai` retirement timeline: **cutover to complete today** (same-day). The ≥24h soak in Block 6 is
  replaced by a thorough post-flip end-to-end verification; keep the `.ai` nginx block + cert alive
  as rollback insurance until the end-of-day decommission once checks pass.
- DNS zone control + VPS IP (`185.25.149.174`): confirmed by operator.
- **ClickUp webhook inventory — exactly ONE webhook** (from `GET /team/761759/webhook`):
  - `id`: `66208c81-2e08-4183-925b-3ce56242e504`
  - `endpoint`: `https://agents.haxe.ai/webhook/cu-comment` → repoint to
    `https://agents.skalus.com/webhook/cu-comment` in Block 4a via `PUT /api/v2/webhook/{id}`.
  - `events`: `["taskCommentPosted"]`; scope: all null = **team/workspace-wide**; `userid` 99811284
    (agent); `health.status` active, `fail_count` 0.
  - The creating personal token (`pk_99811284_…`) was exposed in the GET output's `client_id`
    field → **rotate it as the final step today**, after the repoint + cutover verification.

---

## Block 1 — DNS: create `agents.haxe.pl` A record

🔴 **OPERATOR** — in the **haxe.pl** DNS zone:
- Add **one A record**: host `agents`, type `A`, value `185.25.149.174`, **TTL 300**
  (low, so a rollback propagates fast). No AAAA (the `.ai` setup had none).
- Do **not** touch the `haxe.ai` zone yet — `agents.haxe.ai` must keep resolving.

**Verify (Claude can do this):** `nslookup agents.haxe.pl` returns `185.25.149.174` from the
operator's machine. Do not proceed to Block 2 until it resolves (certbot's HTTP-01 challenge
needs the name pointing at the VPS).

**Definition of Done:** `agents.haxe.pl` resolves to `185.25.149.174`; `agents.haxe.ai` still resolves.

---

## Block 2 — TLS + nginx on VPS (dual-serve)

🔴 **OPERATOR (on the VPS, `franciszek@185.25.149.174`)** — Claude can draft/verify, but issuing
a cert and reloading nginx are state changes to confirm live:
- Issue the cert + add a server block for the new name:
  `sudo certbot --nginx -d agents.haxe.pl`
- Certbot adds the 443 block and the HTTP→HTTPS redirect, but **not** the SSE proxy settings.
  Edit the new `server_name agents.haxe.pl` block in `/etc/nginx/conf.d/agents.conf` to mirror
  the `.ai` block: `location /` → `proxy_pass http://localhost:5678`, `proxy_buffering off`,
  `chunked_transfer_encoding on`, and the `Upgrade`/`Connection`/`Host`/`X-Forwarded-*` headers.
- `sudo nginx -t && sudo systemctl reload nginx`.
- Keep the existing `agents.haxe.ai` server block **in place** (dual-serve).

**Verify:** `curl -I https://agents.haxe.pl/` returns n8n's response (302/200), valid TLS chain;
`https://agents.haxe.ai/` still works.

**Definition of Done:** both hostnames terminate TLS and reach n8n; nginx config test passes.

---

## Block 3 — n8n env: point webhook/editor base URL at `.pl`

🔴 **OPERATOR (on the VPS)** — in `/opt/haxe-agents/.env`:
- `WEBHOOK_URL=https://agents.haxe.pl`
- `N8N_EDITOR_BASE_URL=https://agents.haxe.pl`
- `docker compose up -d` to recreate `n8n-main` + `n8n-worker` (per the ADR-012 update note,
  these must be in the compose `environment:` block — they already are; recreate picks up the change).

**Verify:** `docker exec n8n-main printenv | grep -E 'WEBHOOK_URL|N8N_EDITOR_BASE_URL'` shows `.pl`.
The n8n UI now *displays* `.pl` webhook URLs. (This does **not** change what ClickUp calls — that's
Block 4a.) Alert links in ClickUp will now be `.pl` (ADR-025).

**Definition of Done:** both n8n containers report the `.pl` base URLs; n8n still serves the UI.

---

## Block 4 — Repoint external registrations + n8n workflow strings

The actual cutover. Do 4a–4d in order; verify each.

### 4a — ClickUp webhook endpoint(s) → `.pl`  🔴 OPERATOR (or Claude via API with a token)
For **each** webhook id found in Block 0, `PUT` the new endpoint (preserves the id + HMAC secret,
so no credential rotation):
```
PUT https://api.clickup.com/api/v2/webhook/{webhook_id}
{ "endpoint": "https://agents.haxe.pl/webhook/cu-comment", "status": "active" }
```
Do **not** delete+recreate (that rotates the secret and forces a `crypto` credential update).
**Verify (Definition of Done gate):** @-mention `@Agent Haxe` on a real ClickUp test task →
confirm the producer runs (`inspect-execution.mjs`), the draft posts, and `Signature Valid?`
passes on the `.pl` delivery. Check the Alerts channel (`alerts-since.mjs`) is clean.

### 4b — ClickUp OAuth app redirect URI → `.pl`  🔴 OPERATOR (ClickUp app settings)
In the ClickUp OAuth app settings, change the redirect URL from
`https://agents.haxe.ai/webhook/clickup-oauth-callback` to the `.pl` equivalent.
**Verify:** run the self-serve onboarding link (`https://agents.haxe.pl/webhook/clickup-oauth-start`)
end-to-end as yourself; confirm the classic-REST token round-trip completes and a token lands in
the Supabase Vault. (Note: the MCP-DCR leg was already blocked by ClickUp allowlisting per
ADR-054 block-1 findings — that gap is unchanged by this migration.)

### 4c — n8n workflow JSON strings → `.pl`  (Claude, edit in UI + re-export)
Edit in the n8n UI (never hand-edit exported JSON), then re-export with `export-workflows.mjs`.
**Guard:** `haxe-image-mcp.json` and any `toolWorkflow`/MCP node carry a hidden
`workflowInputs.schema[]` that the exporter strips — prefer n8n-MCP `partial_update`/UI over a PUT,
and hand-preserve `schema[]` in the repo file (see CLAUDE.md n8n notes / ADR-057).
- `clickup-onboarding.json` — 7 hardcoded URLs (oauth-start/callback, mcp-callback, DCR redirect_uris).
- `image-mcp-health-monitor.json` — probe URL + alert `details` string.
- `haxe-image-mcp.json` — endpoint/path references.
- `sync-agent-definitions.json` — the matched URL.
- The **image session builder** workflow that emits `mcp_servers[].url` (confirm exact workflow
  in Block 0) → `https://agents.haxe.pl/mcp/haxe-image-gen`.
**Verify:** run an image-generating agent task end-to-end (the MCP call must resolve to `.pl`);
confirm the health monitor's next probe hits `.pl` and reports healthy.

### 4d — VPS watchdog cron URLs → `.pl`  🔴 OPERATOR (on the VPS)
Update `WATCHDOG_URL` in the deployed `disk-watchdog.sh` / `consumer-heartbeat-watchdog.sh`
(and/or their env) to `https://agents.haxe.pl/webhook/...`.
**Verify:** next watchdog fire lands on the `.pl` webhook (check n8n execution + Alerts clean).

**Block Definition of Done:** a real mention, a real onboarding round-trip, a real image task, and
the watchdogs all run through `agents.haxe.pl` with no WARN/CRITICAL alerts; `agents.haxe.ai` is
now unused by any external caller.

---

## Block 5 — Repo + tooling + local env + new ADR  (Claude, except 🔴 local setx)

Pure string/doc changes — no live impact, fully reversible. Do after `.pl` is proven so the repo
never claims a cutover that isn't live yet.
- **`.mcp.json`** — `N8N_API_URL` → `https://agents.haxe.pl`.
- **`scripts/*.mjs`** — flip the `N8N_API_URL` default in: `usage-audit`, `test-subworkflow`,
  `test-image-delivery`, `inspect-execution`, `import-workflow`, `export-workflows`,
  `check-workflow-drift`, `alerts-since`, `mcp-call`, plus `onboard-clickup-rest-token.mjs`,
  `onboard-clickup-mcp-user.mjs`, and the `ma-spike-*.py` URLs (spike scripts — update or note as dead).
- **`infrastructure/scripts/*watchdog.sh`** — the `WATCHDOG_URL` header/default comments.
- **`n8n/nginx-agents.conf`** — rename/replace with the `.pl` reference copy (post-Block-6 state:
  only the `.pl` server block).
- **`n8n/.env.example`** — `WEBHOOK_URL` / `N8N_EDITOR_BASE_URL` → `.pl`.
- **Docs:** `architecture/current.md` (public endpoint, MCP URLs, diagram line, env note),
  `infrastructure/deployment.md`, `docs/drift-check.md`, and the ADR references (025/017/018).
- 🔴 **OPERATOR — local machines (both desktops):** `setx N8N_API_URL "https://agents.haxe.pl/api/v1"`
  in a new shell; the machine env overrides the script defaults, so the repo change alone is not enough.
- **New ADR** superseding ADR-012: `NNN-domain-cutover-agents-haxe-pl.md` — context (`.ai` retired),
  decision (`.pl`, hard cutover, `.ai` decommissioned), consequences. **Do NOT edit ADR-012's body/title**
  (it was true when made) — mark it superseded. **Do NOT edit** `supabase/migrations/041_*.sql` (append-only;
  the `.ai` URL there is a historical comment) or any `architecture/Build plans/*/block-*-findings.md`
  (point-in-time records).

**Verify:** `node scripts/check-workflow-drift.mjs` passes against `.pl`; grep for
`agents\.haxe\.ai` shows only the intentionally-frozen historical files (migration 041, build-plan
findings, ADR-012 as superseded).

**Definition of Done:** repo, tooling, and both local machines all reference `.pl`; new ADR committed;
drift-check green.

---

## Block 6 — Decommission `agents.haxe.ai`

Only after every prior block's verification passed and the system has run clean on `.pl` for a
sensible soak (at least a full day of real traffic + one watchdog/cron cycle).

🔴 **OPERATOR (VPS):**
- Remove the `agents.haxe.ai` server blocks from `/etc/nginx/conf.d/agents.conf`; `nginx -t && reload`.
- `sudo certbot delete --cert-name agents.haxe.ai` (stops renewal attempts on the dead name).
🔴 **OPERATOR (haxe.ai DNS zone):**
- Remove the `agents.haxe.ai` A record (or let the zone/domain lapse per the Block-0 timeline).

**Verify:** `curl -I https://agents.haxe.ai/` fails to resolve/connect; `agents.haxe.pl` fully
carries mentions, onboarding, image tasks, watchdogs; Alerts channel clean for 24h.

**Definition of Done:** `agents.haxe.ai` is unreachable and unreferenced by any live caller;
`agents.haxe.pl` is the sole production endpoint; new ADR reflects the completed state.

---

## Rollback

Before Block 6, rollback is trivial because `.ai` is still fully live: revert the ClickUp webhook
`PUT` (4a) and OAuth redirect (4b) back to `.ai`, revert the n8n env (Block 3), and `.ai` resumes.
After Block 6, rollback means re-issuing the `.ai` cert + re-adding DNS — avoid by not starting
Block 6 until the soak is clean.
