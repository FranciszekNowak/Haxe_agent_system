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

## Nginx reverse proxy (host-level)

`agents.skalus.com` terminates at a **host-level nginx** (not a container; managed by Certbot),
config at `/etc/nginx/conf.d/agents.conf`, proxying `location /` → `http://localhost:5678`
(n8n-main, loopback-bound). Not in the repo / not scp-deployed — edit on the VPS directly.

- **Proxy timeouts (2026-06-11):** `proxy_read_timeout 300s; proxy_send_timeout 300s;` in the
  `location /` block (raised from nginx's 60s default). The default 504'd **synchronous** long
  runs — n8n UI "Execute workflow" and Form-trigger test harness — at 60s even though the run
  finished server-side. The **production agent path is unaffected either way**: the ClickUp
  webhook uses `responseMode: onReceived` (instant 200, async spine), so it never holds the
  connection. Purely a UI/testing quality-of-life setting.
- **Edit + reload:** `sudo nano /etc/nginx/conf.d/agents.conf` → `sudo nginx -t` (must pass) →
  `sudo systemctl reload nginx` (or `sudo nginx -s reload`). Reload is graceful (no dropped conns).
  Back up first (`sudo cp agents.conf agents.conf.bak.$(date +%F-%H%M%S)`); roll back by restoring
  the backup if `nginx -t` fails.

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

## Docling extraction service (ADR-036)

Added in migration 012. Converts documents and images to markdown for the multimodal input
pipeline. Runs inside the `n8n-internal` network; n8n reaches it at `http://docling:5001`.

### RAM requirement

Docling's layout models need **≥ 4 GB free RAM** to load. The VPS has 8 GB total. If the
container OOM-kills on start, check `docker stats` — the other containers (n8n + postgres +
redis + litellm) use roughly 2–3 GB combined at idle. Docling gets the rest.

### First deploy

```bash
# From local machine: push the updated docker-compose.yml
scp n8n/docker-compose.yml franciszek@185.25.149.174:/opt/haxe-agents/docker-compose.yml

# On VPS: start the service
cd /opt/haxe-agents && docker compose up -d docling

# Watch logs until models finish loading (~60–90 s)
docker compose logs docling -f

# Verify the endpoint is up
curl -sf http://localhost:5001/health && echo "OK"

# Smoke-test a real file (from the sample files in the repo)
# Note: /v1/convert/file is the multipart endpoint (field name "files"); /v1/convert/source expects JSON.
# image_export_mode=placeholder is REQUIRED for the readers — the default ("embedded") inlines page
# images as base64 data URIs and bloats the payload (one PDF: 242 KB vs ~1.3 KB clean text).
curl -X POST http://localhost:5001/v1/convert/file \
  -F "files=@test.docx" \
  -F "to_formats=md" \
  -F "image_export_mode=placeholder" \
  -H "Accept: application/json"
# Response JSON: { status, errors[], processing_time, document:{ md_content, html_content,
# text_content, json_content, doctags_content } }. Readers read document.md_content.
```

### Pin the image digest after first deploy (ADR-011)

Once the container is running correctly:
```bash
docker inspect docling --format '{{.Image}}'
```
Copy the digest and replace the `image:` line in `n8n/docker-compose.yml` with a pinned
digest reference (same pattern as the LiteLLM entry).

### Healthcheck

The service registers healthy once `GET /health` returns 200. The `start_period: 90s`
gives it time to load layout models before Docker marks it unhealthy.

### Status: verified live (2026-06-10, Block 1)

Running and `healthy`; the container's resolved digest matches the pin in `n8n/docker-compose.yml`
(`sha256:c7ba482f…`) — no drift. `GET /health` → 200; ~1.9 GB RSS idle with ≥4 GB free, no OOM.
Convert verified on the committed fixtures: `HBG Sharp.docx`, `Karta Techniczna…HX705.pdf`, and
`Wzorcowa specyfikacja.xlsx` (260 pipe-table rows → tables survive). Endpoint surface (from the
container's own OpenAPI at `/openapi.json`): `/health`, `/ready`, `/v1/convert/file`
(+ `/async`), `/v1/convert/source`, `/v1/chunk/*`, `/v1/result/{task_id}`, `/version`.

---

## Zip extraction service (ADR-058)

A small Node service that unpacks zip attachments **off** the n8n worker (the in-workflow
adm-zip `Decompress` OOM-killed the worker on a >500 MB zip and cascaded to every co-running
execution — 2026-06-24 07:30 CRITICAL). It streams the zip to disk, walks it entry-by-entry,
uploads each entry to the `zip-inner-images` Supabase bucket, and returns a manifest. Runs on
`n8n-internal`; n8n reaches it at `http://zip-extractor:8080`.

### Source ↔ deploy layout

Authored in the repo at `services/zip-extractor/`. On the VPS the source lives **flat** at
`/opt/haxe-agents/zip-extractor/` (sibling of `docker-compose.yml`), so the compose
`build: context: ./zip-extractor` resolves there — same convention as `./litellm-config.yaml`.

### Required `.env` keys

```
SUPABASE_URL=https://hkeslnosxibeuesxndnz.supabase.co
SUPABASE_SERVICE_KEY=<service_role key>   # private-bucket upload bypasses RLS — server-side only
```

The `service_role` key bypasses Supabase row-level security; it must never leave the server
(it also lives in n8n's encrypted `supabaseApi` credential for the same reason).

### First deploy

```
# 1. get the source onto the VPS (scp services/zip-extractor/* or git pull)
#    -> /opt/haxe-agents/zip-extractor/   (do NOT copy node_modules; the build runs npm install)
# 2. add the two SUPABASE_* keys to /opt/haxe-agents/.env
# 3. ensure the zip-extractor service block is in docker-compose.yml (mastered in n8n/docker-compose.yml)
cd /opt/haxe-agents && docker compose up -d --build zip-extractor
docker compose logs zip-extractor          # expect: "zip-extractor listening on :8080"
docker inspect zip-extractor --format '{{.State.Health.Status}}'   # expect: healthy
# reachability from the worker:
docker exec n8n-worker node -e "fetch('http://zip-extractor:8080/health').then(r=>r.json()).then(console.log)"
```

### Memory note (important)

`mem_limit: 512m`, and the service stays well under it because it streams to disk and holds only
one entry (≤ per-file cap) at a time. **Do NOT mount `/tmp` as tmpfs** — tmpfs is RAM-backed and
would reintroduce the exact OOM this service removes. Leave `/tmp` on the disk-backed overlay.

### Status: verified live (2026-06-24, ADR-058 Block 1)

Built, running, `healthy`, reachable from `n8n-worker` by service name. Real Supabase round-trip
confirmed (upload + 6 h signed URL + object re-downloaded at exact byte size). Memory bound proven:
a 176 KB archive inflating to 180 MB uncompressed processed at ~184 MiB / 512 MiB peak RSS, flat in
archive size. Not yet wired into the reader (that is ADR-058 Block 2).

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

## Storage dead-man's-switch (ADR-046)

Host-level watchdog for VPS disk + n8n execution DB, external to n8n (a watcher must not share the
fate of the watched). Repo-mastered: `infrastructure/scripts/disk-watchdog.sh` +
`infrastructure/systemd/disk-watchdog.{service,timer}`. It POSTs breaches to the
`Storage Watchdog Intake (v1)` n8n webhook (header-auth) → Post Alert → ClickUp Alerts task.

Deploy / re-deploy after editing the script or units:

```bash
# from repo root
scp infrastructure/scripts/disk-watchdog.sh infrastructure/systemd/disk-watchdog.service \
    infrastructure/systemd/disk-watchdog.timer franciszek@185.25.149.174:/tmp/
ssh franciszek@185.25.149.174 '
  cp /tmp/disk-watchdog.sh /opt/haxe-agents/disk-watchdog.sh && sed -i "s/\r$//" /opt/haxe-agents/disk-watchdog.sh && chmod 755 /opt/haxe-agents/disk-watchdog.sh
  sudo cp /tmp/disk-watchdog.service /tmp/disk-watchdog.timer /etc/systemd/system/ && sudo sed -i "s/\r$//" /etc/systemd/system/disk-watchdog.{service,timer}
  sudo systemctl daemon-reload && sudo systemctl enable --now disk-watchdog.timer'
```

Secrets are NOT committed — `/opt/haxe-agents/watchdog.env` (chmod 600) holds:

```
WATCHDOG_URL=https://agents.skalus.com/webhook/<intake-path>
WATCHDOG_KEY=<value of the "Storage Watchdog Header Auth" httpHeaderAuth credential, header X-Watchdog-Key>
# optional overrides: WARN_PCT (default 60), CRIT_PCT (default 75), N8N_DB_WARN_GB (default 5)
```

If the webhook secret is rotated, update both the n8n `Storage Watchdog Header Auth` credential and
`watchdog.env`. Check it: `tail /opt/haxe-agents/watchdog.log`; force a test with
`sudo env WARN_PCT=0 /opt/haxe-agents/disk-watchdog.sh` (expect a WARN on the Alerts task). The n8n
intake workflow is `n8n/workflows/storage-watchdog-intake.json`.

## Queue-consumer heartbeat dead-man's-switch (ADR-056 Block 5)

Host-level watchdog for the `queue-consumer` container, external to it (same independence principle as
the disk-watchdog). The consumer SETs a Redis key `haxeq:consumer:heartbeat` with TTL =
`queue.heartbeat_stale_s` (default **300 s**, refreshed every ~⅓-TTL ≈ 100 s); if the consumer dies the
key expires. Repo-mastered: `infrastructure/scripts/consumer-heartbeat-watchdog.sh` +
`infrastructure/systemd/consumer-heartbeat.{service,timer}` (**5-min cadence** — the per-tick `docker
exec redis-cli` is the real cost, not the trivial Redis SET; ≈5–10 min detection). It **reuses the same
`watchdog.env` and the `Storage Watchdog Intake (v1)` webhook** as the disk-watchdog — no new secret —
and POSTs CRITICAL `queue-consumer/heartbeat` on a breach (two cases: Redis unreachable, or key absent =
consumer dead/hung). Paired with the in-n8n `Queue Depth Monitor (v1)` 5-min cron (`M48svwpdhDg8l6An`),
which reads the consumer's `GET /metrics`.

Deploy / re-deploy after editing the script or units:

```bash
# from repo root
scp infrastructure/scripts/consumer-heartbeat-watchdog.sh \
    infrastructure/systemd/consumer-heartbeat.service \
    infrastructure/systemd/consumer-heartbeat.timer franciszek@185.25.149.174:/tmp/
ssh franciszek@185.25.149.174 '
  sed -i "s/\r$//" /tmp/consumer-heartbeat-watchdog.sh /tmp/consumer-heartbeat.service /tmp/consumer-heartbeat.timer
  cp /tmp/consumer-heartbeat-watchdog.sh /opt/haxe-agents/consumer-heartbeat-watchdog.sh && chmod 755 /opt/haxe-agents/consumer-heartbeat-watchdog.sh
  sudo cp /tmp/consumer-heartbeat.service /tmp/consumer-heartbeat.timer /etc/systemd/system/
  sudo systemctl daemon-reload && sudo systemctl enable --now consumer-heartbeat.timer'
```

Check it: `tail /opt/haxe-agents/consumer-heartbeat.log` (an `OK heartbeat=<iso>` line each minute). On a
breach the oneshot exits non-zero (systemd marks it failed) *after* delivering the alert — the `ALERTED`
log line is the success signal, not the exit code. To force the consumer-dead case for a test: `docker
stop queue-consumer`, wait `heartbeat_stale_s` for the key to expire, `sudo systemctl start
consumer-heartbeat.service` (expect a CRITICAL on the Alerts task), then `docker start queue-consumer`.
