# Deployment Runbook

VPS: `franciszek@185.25.149.174` | Stack: `/opt/haxe-agents/`

All `docker compose` commands run from `/opt/haxe-agents/`. Files live flat in that
directory: `docker-compose.yml`, `litellm-config.yaml`, `.env`.

Note: the git repo stores these files under `n8n/` (`n8n/docker-compose.yml`,
`n8n/litellm-config.yaml`, `n8n/.env.example`). On the VPS they live flat in
`/opt/haxe-agents/` — no subdirectory. When a config file changes in the repo, deploy it
via `scp` (see "Deploying a file change" below). Past incident: `docker-compose.yml` on
the VPS was never updated after ADR-030 added `ANTHROPIC_API_KEY` to the litellm env block
— the key was in `.env` the whole time but the container never received it.

---

## Container management — critical distinctions

### `restart` vs `up -d` (read this first)

These are NOT equivalent:

| Command | What it does | When to use |
|---|---|---|
| `docker compose restart litellm` | Restarts container with **same env vars it had when first created** — does NOT re-read `.env` | Clearing in-memory state only (e.g., LiteLLM in-memory cooldown) |
| `docker compose up -d litellm` | **Recreates** the container, re-evaluating `${...}` from current `.env` | After any `.env` or `docker-compose.yml` change |

Common failure mode: adding a secret to `.env` then running `restart` — the container still has no key.

---

## Useful commands

```bash
cd /opt/haxe-agents

docker compose ps                          # all container statuses
docker compose config | grep ANTHROPIC    # verify variable substitution before recreating
docker compose logs litellm --tail 100     # model call errors (most useful)
docker compose logs n8n-worker --tail 100  # workflow execution errors
docker exec litellm env | grep ANTHROPIC  # what the running container actually has
docker compose up -d litellm              # recreate litellm (after .env or docker-compose.yml change)
docker compose up -d                       # recreate all containers
```

---

## LiteLLM troubleshooting

LiteLLM is the single gateway for all model calls. When it fails, Agent Spine's error path
fires: `Reset Status on Failure` clears the ClickUp `[AI] Status agenta` field, then
`Alert Invoke Model Failed` posts a CRITICAL alert.

### Step 1: get logs

```bash
docker compose logs litellm --tail 100
```

### Step 2: interpret

| Error in logs | Root cause | Fix |
|---|---|---|
| `AuthenticationError` / `401` | `ANTHROPIC_API_KEY` empty, missing, or `change_me` | See ANTHROPIC_API_KEY checklist below |
| `model not found` / `404` | LiteLLM alias not in `litellm-config.yaml` | Verify `model_routing.litellm_model` values match aliases in config |
| No LiteLLM log for the failing call | n8n can't reach the container | `docker compose ps` — confirm `litellm` is `healthy` |
| `429` — "no deployments available" | LiteLLM cooldown — can mean **any** upstream error (401, 429, 500). Check logs for the real cause. If Anthropic console shows $0 spend, the key never reached Anthropic → auth/config failure, not rate limit | See ANTHROPIC_API_KEY checklist; only use `restart` if logs confirm actual Anthropic 429 |

### ANTHROPIC_API_KEY checklist

Required for all `personal_data=false` routes (Anthropic direct, ADR-030). Passed to the
container via `docker-compose.yml` line `ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY}`.

Full diagnostic sequence:

```bash
cd /opt/haxe-agents

# 1. Is the key in .env?
grep ANTHROPIC .env

# 2. Does docker-compose.yml have the passthrough line?
grep ANTHROPIC docker-compose.yml

# 3. Is docker compose resolving it correctly?
docker compose config | grep -A1 ANTHROPIC

# 4. What does the running container actually have?
docker exec litellm env | grep ANTHROPIC
```

Step 3 is the definitive test. If it shows an empty value, the `.env` isn't being loaded
(wrong location or variable name mismatch). If it shows the key correctly but step 4 is
empty, `docker compose up -d litellm` is needed to recreate the container.

If step 2 returns nothing: the `docker-compose.yml` on the VPS is stale (predates ADR-030).
Fix by re-deploying it from the repo:

```bash
# From your local machine:
scp n8n/docker-compose.yml franciszek@185.25.149.174:/opt/haxe-agents/docker-compose.yml
scp n8n/litellm-config.yaml franciszek@185.25.149.174:/opt/haxe-agents/litellm-config.yaml
# Then on VPS:
cd /opt/haxe-agents && docker compose up -d litellm
```

---

## Initial deployment

```bash
# 1. SSH to VPS
ssh franciszek@185.25.149.174

# 2. Create /opt/haxe-agents/ and place files from repo
mkdir -p /opt/haxe-agents
# scp from local: docker-compose.yml, litellm-config.yaml

# 3. Create .env — lives flat in /opt/haxe-agents/ next to docker-compose.yml
cp .env.example .env   # .env.example is in the same directory after scp
nano .env              # replace every change_me value; source real keys from 1Password

# 4. Start stack
docker compose up -d

# 5. Verify
docker compose ps                      # all containers: healthy
docker compose logs litellm --tail 20  # should end with "Started server on port 4000"
docker compose config | grep ANTHROPIC # should show the actual key value
```

---

## Deploying a file change from the repo

The VPS is not a git-managed directory. After committing a change locally, push the
affected file via scp:

```bash
# Update docker-compose.yml
scp n8n/docker-compose.yml franciszek@185.25.149.174:/opt/haxe-agents/docker-compose.yml

# Update LiteLLM config
scp n8n/litellm-config.yaml franciszek@185.25.149.174:/opt/haxe-agents/litellm-config.yaml

# Then recreate the affected container on VPS
ssh franciszek@185.25.149.174 "cd /opt/haxe-agents && docker compose up -d litellm"
```

---

## Applying migrations

Migrations live in `supabase/migrations/` (append-only). Apply via Supabase MCP from the
operator desktop (Claude Code) or via Supabase dashboard SQL editor. Never modify existing
migration files — always add a new one with the next sequential number.

---

## Updating n8n workflows

Workflows are deployed via Claude Code's n8n MCP (REST API), not by restarting containers.
After verifying a workflow change in the n8n UI, export the JSON and commit it to
`n8n/workflows/<workflow>.json`.
