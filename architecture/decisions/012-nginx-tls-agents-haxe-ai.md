# ADR-012: Nginx reverse proxy + TLS termination at agents.haxe.ai

Date: 2026-05-30
Status: Accepted

## Context
n8n binds to `127.0.0.1:5678` — intentionally not exposed to the public
interface. ClickUp webhooks require a publicly reachable HTTPS endpoint.
n8n does not handle TLS natively. A domain and a TLS-terminating reverse
proxy are needed.

Two domain options were considered:
- `agents.haxe.pl` — the main commercial domain (Polish market).
- `agents.haxe.ai` — owned by the same company; thematically appropriate
  for an AI agent system; keeps agent infrastructure visually distinct from
  the business-facing domain.

## Decision

**Nginx** on the VPS as the reverse proxy, listening on `0.0.0.0:443`.
Forwards to `http://localhost:5678`. SSE-compatible configuration:
`proxy_buffering off` and `chunked_transfer_encoding on` (required for
n8n's real-time UI updates over Server-Sent Events).

**Let's Encrypt** certificate via `certbot --nginx`. HTTP-01 challenge.
Auto-renewal configured by certbot (systemd timer). Certificate expires
2026-08-28; renews automatically before expiry. No certificate cost.

**Domain: `agents.haxe.ai`**. A record: `185.25.149.174`, TTL 300.
Rationale: `.ai` TLD fits the project's nature; `.pl` is the commercial
storefront and should not host internal infrastructure. Webhook traffic
from ClickUp goes directly to the VPS IP — haxe.pl's hosting servers
experience zero additional load regardless of subdomain choice.

**`WEBHOOK_URL=https://agents.haxe.ai`** set in `/opt/haxe-agents/.env`
so n8n constructs correct webhook URLs in its UI and in workflow trigger
nodes.

## Consequences
- ClickUp webhooks can reach n8n at `https://agents.haxe.ai/webhook/<id>`.
- TLS certificate renews automatically; no manual cert management.
- HTTP requests to `agents.haxe.ai` redirect to HTTPS (301).
- Adding more public-facing services later (e.g., a status page) means
  adding server blocks to `/etc/nginx/conf.d/` — Nginx is already the
  ingress point.
- The live Nginx config at `/etc/nginx/conf.d/agents.conf` is managed
  partly by certbot (TLS blocks). Do not hand-edit the certbot-managed
  sections. Reference copy committed at `n8n/nginx-agents.conf` in the repo.
