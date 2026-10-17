# Decommission of the agent stack — 2026-10-17

The agent system is no longer in use. On 2026-10-17 everything it ran on was removed
except what other projects depend on. This file records what was kept, what was removed,
where the data went, and how to roll back. The pre-removal state is in
`vps-snapshot-2026-10-13.md` and under the tag `pre-vps-removal-2026-10-13`.

## What was kept, and for whom

| Kept | Why |
|---|---|
| Containers `n8n-main`, `n8n-worker`, `n8n-postgres`, `n8n-redis` (queue mode), compose project `haxe-agents`, its three volumes and the `haxe-agents_n8n-internal` network | haxe-flow-metrics runs its eight `Flow:` workflows here. `formularz-reklamacje-Allegro` plans to use the same instance. |
| `n8n/docker-compose.yml`, trimmed to the four n8n services. The service definitions are byte-identical, so the containers were not recreated. | The n8n core |
| `/opt/haxe-agents/.env`, trimmed to seven keys: `POSTGRES_PASSWORD`, `N8N_ENCRYPTION_KEY`, `GENERIC_TIMEZONE`, `TZ`, `N8N_WORKER_CONCURRENCY`, `WEBHOOK_URL`, `N8N_EDITOR_BASE_URL` | The n8n core |
| `/etc/nginx/conf.d/agents.conf` and the `agents.skalus.com` certificate | The flow-metrics `cu-status` webhook and the n8n API |
| Workflows: the eight `Flow: *`, `Post Alert (v1)`, `Error Handler (v1)`, `Storage Watchdog Intake (v1)` | flow-metrics, and the disk watchdog, which alerts through Post Alert |
| Credentials: `Flow Supabase Writer`, `Flow ClickUp`, `ClickUp Flow Webhook HMAC`, `Flow SMTP (zenbox)`, `ClickUp account` (used by Post Alert), `Storage Watchdog Header Auth` | Same |
| `disk-watchdog.{service,timer}`, `/opt/haxe-agents/disk-watchdog.sh`, `watchdog.env`, `watchdog.log` | Disk alerting for the whole host, all stacks |
| ClickUp webhook `0b040039-…` on `/webhook/cu-status` | flow-metrics |
| Supabase project `hkeslnosxibeuesxndnz`: the `flow` schema (55 objects, unchanged), roles `flow_writer` and `flow_reader`, all extensions | flow-metrics and its Grafana |

Not touched, because they are separate projects that only share the host: `/opt/haxe-flow`
(Grafana), `/opt/book-notes-mcp`, `/var/www/reklamacje-skalus`, their nginx files, certbot.

## What was removed

- **Containers and images:** `litellm`, `docling`, `zip-extractor`, `queue-consumer` and
  `session-waiter`, and their images. Root-disk use went from 23 GB to 7.5 GB.
- **n8n:** the 57 other workflows, including the `_TMP test-subworkflow` copies, and six
  credentials: `AWS (IAM) account`, `ClickUp Webhook HMAC`, `Image MCP bearer (ADR-055)`,
  `LiteLLM master key`, `Postgres / supabase connection`, `Supabase account`. Deleted
  directly in the n8n database, because no API key was available, and followed by a
  restart of `n8n-main` and `n8n-worker`. Afterwards all 11 remaining workflows were
  active and both webhooks were registered.
- **Database:** the `litellm` database inside n8n-postgres.
- **Watchdog:** `consumer-heartbeat.{service,timer}`, its script and its log.
- **Files in `/opt/haxe-agents`:** `queue-consumer/`, `session-waiter/`, `zip-extractor/`,
  `litellm-config.yaml*`, `vertex-key.json`, every `docker-compose.yml.bak*`, `.env.bak*`
  and `watchdog.env.bak*`, and the `agents.conf.bak*` files in `/etc/nginx/conf.d/`.
- **Supabase `public`:** all 22 tables, including `user_data_and_config`, the renamed
  `user_clickup_credentials`; all 15 functions; the cron jobs
  `prune-agent-input-file-map`, `purge-agent-output-images` and `purge-zip-inner-images`;
  all 12 vault secrets; and the empty buckets `agent-output-images` and `zip-inner-images`.
  The drop ran without `cascade`, after a check that nothing in `flow` depends on `public`.

## Still open

- ~~ClickUp webhook `66208c81-2e08-4183-925b-3ce56242e504` on `/webhook/cu-comment`~~:
  **deleted on 2026-10-17** with the operator's approval. No webhooks remain under the
  agent token. The flow-metrics `cu-status` webhook is unaffected.
- **`Post Alert (v1)` has failed every run since at least 2026-10-10** with "Authorization
  failed - please check your credentials". The `ClickUp account` token itself still
  authenticates against the ClickUp API, so the cause is somewhere else. Until this is
  fixed, alerts from flow-metrics and the disk watchdog do not reach ClickUp. This was
  found during the decommission and predates it.
- **Keys to revoke at their providers**, since nothing uses them any more:
  - [ ] Anthropic: the API key, plus the managed-agents vaults and agents
  - [ ] OpenAI API key
  - [ ] Gemini API key
  - [ ] Google Cloud: the service account behind `vertex-key.json` (project `VERTEX_PROJECT`)
  - [ ] Tavily API key
  - [ ] Stability API key, if one was ever issued
  - [ ] AWS: the IAM access key used for Bedrock
  - [ ] ClickUp: the OAuth app (client id and secret), and the six per-user REST tokens it issued
  - [ ] Supabase `service_role` key: rotate only after checking that nothing in flow-metrics uses it

## Where the data went

- **Repo**, branch `chore/vps-snapshot-before-removal`:
  - every live workflow at removal time, in `n8n/workflows/archive/live-2026-10-17/`
  - the old VPS config variants and logs, in `infrastructure/vps-archive-2026-10-17/`
  - the Supabase `public` schema and cron job definitions, in `supabase/archive/`
- **This machine**, under `C:\Users\franc\Backups\haxe-agents-2026-10-17\`, never committed:
  - `db/`: `pg_dump -Fc` of the `n8n` and `litellm` databases
  - `n8n/`: all 12 credentials, still encrypted. The key is in `secrets/.env`.
  - `supabase/`: a full `pg_dump -Fc` of `public`, schema and data
  - `secrets/`: the old `.env` and its three backups, `watchdog.env`, `vertex-key.json`, and
    the decrypted Supabase admin connection

  Each dump was checked with `pg_restore --list`, and the checksums matched the VPS copies.
  Move the secrets into 1Password. The vault secret values were not exported; they are
  the keys on the revocation list above.

## Rollback

1. `git checkout pre-vps-removal-2026-10-13 -- n8n/docker-compose.yml n8n/litellm-config.yaml services/`
   and copy the files to `/opt/haxe-agents/`, as in `vps-snapshot-2026-10-13.md`.
2. Restore `.env` and `vertex-key.json` from the local backup, then run `docker compose up -d --build`.
3. Create the `litellm` database again and `pg_restore` it. Restore the workflows with
   `n8n import:workflow`, from `n8n/workflows/archive/live-2026-10-17/`. Restore the
   credentials with `n8n import:credentials`, from the encrypted backup.
4. Supabase: `pg_restore` the `public` dump. Then recreate the buckets, the cron jobs (from
   `supabase/archive/cron-jobs-2026-10-17.json`) and the vault secrets, which needs new keys.
