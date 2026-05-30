# ADR-011: n8n Docker stack — queue mode, pinned image, secret strategy

Date: 2026-05-30
Status: Accepted

## Context
Phase 0 required deploying the n8n orchestration layer on the VPS. Key
constraints: GDPR (EU VPS only), queue mode mandatory for the architecture,
no secrets in the git repo, reproducible deploys across potential future VPS
migrations.

## Decision

Deploy four containers via Docker Compose under `/opt/haxe-agents/`:

| Container | Image | Role |
|---|---|---|
| `n8n-postgres` | postgres:16 | n8n's internal DB (workflows, execution history, encrypted credentials) |
| `n8n-redis` | redis:7-alpine | Queue backing (Bull queues); AOF persistence enabled |
| `n8n-main` | n8nio/n8n:2.22.5 | UI, webhook receiver, scheduler — does NOT execute workflows |
| `n8n-worker` | n8nio/n8n:2.22.5 | Queue consumer; executes workflows; concurrency 5 |

All four on a private bridge network (`n8n-internal`). Containers address
each other by service name. `n8n-main` exposes port 5678 on `127.0.0.1`
only — never on `0.0.0.0`. Named volumes for postgres and redis data.
Healthcheck-gated `depends_on` prevents n8n from starting before its
dependencies are ready.

**Image version pinned to `2.22.5`** (current stable at deploy time) rather
than `latest`. Rationale: `latest` provides no security benefit if you never
pull, and exposes the stack to silent breaking changes on any future
`docker compose pull`. Upgrades are a deliberate act: bump the version tag in
`docker-compose.yml`, commit, pull on VPS.

**Secret strategy — three-tier:**
- Tier 1 (SSH): key on trusted machines only.
- Tier 2 (stack secrets): `POSTGRES_PASSWORD` and `N8N_ENCRYPTION_KEY`
  generated with `openssl rand` on the VPS, stored in
  `/opt/haxe-agents/.env` (never committed). Backed up in 1Password.
  `N8N_ENCRYPTION_KEY` was rotated immediately after initial deploy because
  the initial value was exposed in a tool output during setup.
- Tier 3 (integration keys): Bedrock, Supabase, ClickUp, Gmail — entered
  via the n8n UI and stored encrypted in `n8n-postgres` using the
  `N8N_ENCRYPTION_KEY`. Never in `.env`.

## Consequences
- Reproducible deploys: same image hash on any future re-provision.
- Deliberate upgrade path: no surprise major version jumps.
- Credential isolation: losing the VPS does not expose Tier-3 keys if
  `N8N_ENCRYPTION_KEY` is kept only in 1Password and the postgres volume is
  not compromised.
- `N8N_ENCRYPTION_KEY` rotation after credentials are stored in n8n requires
  a decrypt-re-encrypt migration. Rotate only before first credential entry
  (as done here) or with the migration procedure.
- Worker concurrency starts at 5; scale by adding worker containers or
  increasing `N8N_WORKER_CONCURRENCY` in `.env`.
