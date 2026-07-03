# ADR-070: Hard cutover of the public endpoint from agents.haxe.ai to agents.skalus.com

Date: 2026-07-03
Status: Accepted (supersedes ADR-012)

## Context

ADR-012 established `agents.haxe.ai` as the public HTTPS endpoint for the n8n stack
(Nginx + Let's Encrypt on the VPS). That domain is being retired and will no longer be
maintained, so every live and repo reference had to move to **`agents.skalus.com`** — a
subdomain of the company's own `skalus.com` — and `agents.haxe.ai` had to be fully
decommissioned (DNS record, TLS certificate, Nginx server blocks).

The move was not a find/replace. Four load-bearing dependencies live outside the repo and
break on cutover unless re-registered, and they had to be sequenced so the old domain kept
serving until the new one was proven:

1. **TLS** — Let's Encrypt held a cert for `agents.haxe.ai` only; the new name needed its own.
2. **ClickUp webhook endpoint** — one workspace-wide webhook (`taskCommentPosted`, id
   `66208c81-…`, team `761759`) is registered *inside ClickUp* and is not rewritten by n8n's
   `WEBHOOK_URL`. It was created under the agent's personal API token, so only that token can
   update it. ClickUp auto-deletes a webhook after ~100 consecutive delivery failures, so it
   had to be repointed *before* the old domain stopped resolving.
3. **ClickUp OAuth app redirect URI** — registered in the ClickUp app settings (UI-only).
4. **Anthropic managed-agent MCP URL** — the image MCP endpoint the harness calls is stored
   in each agent definition on Anthropic's side, emitted by `Sync Agent Definitions (v1)`.
   Changing it required editing that workflow's `mcp_servers` URL **and bumping the `CONV`
   version** so the sync's update-vs-skip logic actually re-pushed the definition (otherwise
   the change would no-op and Anthropic would keep calling the old endpoint).

## Decision

**Hard cutover to `agents.skalus.com`, executed as a stand-up-alongside-then-decommission
sequence** (the old domain stayed live until the new one was verified end-to-end, then was
torn down — "hard" refers to the old domain being removed permanently, not to a big-bang
switch):

- **DNS** — one `A` record `agents.skalus.com` → `185.25.149.174`, TTL 300, in the
  `skalus.com` zone. The `haxe.ai` zone was left untouched until decommission.
- **TLS + Nginx** — a separate Let's Encrypt cert issued via `certbot --nginx -d
  agents.skalus.com`; a new server block mirroring the old one (SSE settings
  `proxy_buffering off` + `chunked_transfer_encoding on`, which certbot does not add itself).
- **n8n** — `WEBHOOK_URL` and `N8N_EDITOR_BASE_URL` in `/opt/haxe-agents/.env` set to the new
  domain; containers recreated.
- **ClickUp webhook** — endpoint updated via `PUT /api/v2/webhook/{id}` (preserves the HMAC
  secret; not delete+recreate, which would rotate it).
- **ClickUp OAuth app** — redirect URI changed in the ClickUp app settings.
- **Workflows** — `Image MCP Health Monitor`, `Sync Agent Definitions` (+ `CONV` bump + a
  manual re-run), and `ClickUp OAuth Onboarding` (four redirect URIs) repointed via n8n-MCP
  surgical field patches; the repo copies written back to match.
- **Watchdog** — `/opt/haxe-agents/watchdog.env` `WATCHDOG_URL` repointed.
- **Repo/tooling** — the `N8N_API_URL` default across `scripts/*.mjs`, `.mcp.json`,
  `n8n/.env.example`, the Nginx reference copy, and the living docs
  (`architecture/current.md`, `infrastructure/deployment.md`, `docs/drift-check.md`) flipped.
- **Decommission** — the `agents.haxe.ai` Nginx blocks removed, its cert deleted
  (`certbot delete`), and its DNS record removed.

## Consequences

- The public endpoint is now `https://agents.skalus.com`; `agents.haxe.ai` no longer resolves
  or serves. `Skalus Sp. z o.o.` is the operating company, so the domain also matches the
  business identity used in agent output.
- Each cutover step was verified against real behaviour before proceeding: a live signed
  ClickUp @-mention ran the producer end-to-end on the new domain (HMAC valid, job enqueued);
  the image MCP endpoint returned a valid MCP `initialize` on the new domain; the agent-sync
  `Upsert Agent` response confirmed Anthropic now stores the `agents.skalus.com` MCP URL.
- **Intentionally-frozen references remain** and are correct to leave as historical record:
  `supabase/migrations/041_*.sql` (append-only), everything under
  `architecture/Build plans/` (point-in-time findings), and the bodies of ADR-012/017/018/025
  (point-in-time decisions; ADR-012's status is marked superseded here). One documentation
  `note` in `n8n/workflows/haxe-image-mcp.json` was left on the old domain in both repo and
  live because that workflow carries the fragile `toolWorkflow` `schema[]` array that a full
  PUT/export strips (CLAUDE.md / ADR-057); a cosmetic note is not worth that risk.
- The agent's personal ClickUp API token was exposed during the webhook inventory (ClickUp
  echoes it in the `client_id` field of the webhook object) and must be rotated as a
  follow-up.

## Related

Supersedes ADR-012 (Nginx + TLS at agents.haxe.ai). See also ADR-025 (alert links use
`N8N_EDITOR_BASE_URL`), ADR-018/017 (n8n API endpoint), ADR-029 (ClickUp @-mention webhook),
ADR-053/055 (managed agents + self-hosted image MCP), ADR-054 (ClickUp onboarding).
