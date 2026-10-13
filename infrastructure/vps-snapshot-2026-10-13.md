# VPS snapshot — 2026-10-13 (before the agent stack was cut down)

Recorded just before the agent system was taken off the VPS (`185.25.149.174`). It
holds what is needed to rebuild `/opt/haxe-agents/` from this repo. It also records what
the repo cannot hold.

## Verified identical to the repo at this commit

| Live on the VPS | Repo master | How checked |
|---|---|---|
| `/opt/haxe-agents/docker-compose.yml` | `n8n/docker-compose.yml` | byte diff, line endings ignored |
| `/opt/haxe-agents/litellm-config.yaml` | `n8n/litellm-config.yaml` | byte diff |
| `/opt/haxe-agents/{queue-consumer,session-waiter,zip-extractor}/` | `services/<name>/` | the repo is a superset (adds tests, snippets and README updates) |
| `/opt/haxe-agents/{disk-watchdog,consumer-heartbeat-watchdog}.sh` | `infrastructure/scripts/` | the repo is ahead; it only updated comments to name `agents.skalus.com` |
| `/etc/systemd/system/{disk-watchdog,consumer-heartbeat}.{service,timer}` | `infrastructure/systemd/` | byte diff |
| `/etc/nginx/conf.d/agents.conf` | `n8n/nginx-agents.conf` | same apart from the reference comments |
| 51 live n8n workflows | `n8n/workflows/*.json` | `check-workflow-drift.mjs`, run against a CLI export (`n8n export:workflow --all`) |

Two workflows had been edited live and never written back: `Execute Agent Session (v1)`
and `Session Waiter Finish (v1)` (the ADR-069 amendment of 2026-07-20, which falls back to
OOXML MIME types). Both were re-exported from live in this commit.

Four workflows existed only in live n8n. They are now saved in `n8n/workflows/archive/`:
`Research the web (v1)` and `Decide Research and Deliver (v1)`, which were retired from the
repo in 6b54e97 but were still active live, plus the throwaway workflows `Doc Access Test (agent token)` and
`Invoke Model (Bedrock smoke test)`. The five `_TMP test-subworkflow …` copies were not
saved, because `scripts/test-subworkflow.mjs` regenerates them.

## Not in git, by design

- **Secrets.** These are `/opt/haxe-agents/.env`, `watchdog.env` and `vertex-key.json`,
  and they belong in 1Password. Key names in `.env`: `POSTGRES_PASSWORD`, `N8N_ENCRYPTION_KEY`,
  `GENERIC_TIMEZONE`, `TZ`, `N8N_WORKER_CONCURRENCY`, `WEBHOOK_URL`, `LITELLM_MASTER_KEY`,
  `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION_NAME`, `N8N_EDITOR_BASE_URL`,
  `ANTHROPIC_API_KEY`, `TAVILY_API_KEY`, `GOOGLE_APPLICATION_CREDENTIALS_JSON`,
  `GEMINI_API_KEY`, `VERTEX_PROJECT`, `OPENAI_API_KEY`, `LITELLM_SALT_KEY`, `SUPABASE_URL`,
  `SUPABASE_SERVICE_KEY`, `ALERT_INTAKE_KEY`. Key names in `watchdog.env`: `WATCHDOG_URL`, `WATCHDOG_KEY`.
- **n8n state.** This is the `haxe-agents_n8n-postgres-data` volume (about 305 MB): credentials,
  encrypted with `N8N_ENCRYPTION_KEY`, the n8n owner account, and the last seven days of
  executions. The workflows themselves are in the repo.
- **Supabase** (`hkeslnosxibeuesxndnz`). This is not on the VPS and is unaffected.

## Who else depends on this stack

`haxe-flow-metrics` runs its eight `Flow: *` workflows **inside this n8n instance**. Their
closure over sub-workflows and error workflows reaches into this repo at exactly two points:
`Post Alert (v1)` (`YSCdHlmdf3p9XEUx`, credential `ClickUp account`) and `Error Handler (v1)`
(`81eplXMD1v5ONhzs`). They also need n8n-main, n8n-worker, n8n-postgres and n8n-redis, which run in
queue mode, plus the `agents.skalus.com` vhost and certificate. The ClickUp status webhook and
the n8n API both go through that vhost.

Nothing depends on LiteLLM, Docling, zip-extractor, queue-consumer, session-waiter or either
watchdog timer outside this repo. `book-notes-mcp` (`/opt/book-notes-mcp`) and `reklamacje`
(PHP-FPM, `/var/www/reklamacje-skalus`) share only the host, its nginx and certbot.
