# ADR-033: VPS Deployment Model — Manual scp, Flat Layout, No Git

## Context

The VPS stack lives in `/opt/haxe-agents/`. It was set up manually during Phase 0 by
placing files directly in that directory. The directory is **not** a git repository. The
files on disk are:

```
/opt/haxe-agents/
  docker-compose.yml       ← canonical in repo at n8n/docker-compose.yml
  litellm-config.yaml      ← canonical in repo at n8n/litellm-config.yaml
  .env                     ← VPS-only, never committed
```

The git repo stores infra files under `n8n/`. On the VPS they live flat — no `n8n/`
subdirectory. This mismatch is intentional and permanent.

**Incident that forced this decision to be explicit (2026-06-08):**

ADR-030 added `ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY}` to the litellm service's
environment block in `docker-compose.yml`. The repo was updated. The VPS was not.
The key was present in `.env` the entire time; the container simply never received it
because the passthrough line was missing.

This caused ~8 hours of debugging because:

1. **LiteLLM's 429 masked the underlying 401.** LiteLLM's router puts a deployment on
   internal cooldown whenever the upstream returns any error — 401, 429, 500. On
   subsequent requests it returns HTTP 429 "no deployments available, try again in 5s."
   n8n surfaces this as a rate-limit error. The actual 401 is only visible in
   `docker compose logs litellm`. This caused repeated false diagnosis ("Anthropic rate
   limit from rapid test firing") when no request had ever reached Anthropic.

2. **The Anthropic console showing $0 spend was the correct signal — read too late.**
   $0 + "no activity" means the key never reached Anthropic. This should have immediately
   ruled out rate limiting and pointed to a pre-Anthropic failure.

3. **No deploy checklist existed.** When ADR-030 was implemented, there was no step that
   said "push docker-compose.yml to VPS." Config drifted silently.

4. **`docker compose restart` was attempted multiple times.** Restart clears LiteLLM's
   in-memory cooldown but does not re-read `.env` or pick up compose file changes. Each
   restart reproduced the same state: cooldown cleared → 401 on next attempt → cooldown
   reformed. Net effect: zero.

## Decision

**Accept the flat/manual VPS layout.** Mitigate config drift with three rules:

### Rule 1: Deploy script after every infra file change

`infrastructure/scripts/deploy-infra.bat` deploys `docker-compose.yml` and
`litellm-config.yaml` to the VPS in one command. It must be run after any change to
either file in the repo before the change takes effect in production.

### Rule 2: Mandatory container verification after recreation

After any `docker compose up -d <service>`, verify the container received its env vars:
```bash
docker exec litellm env | grep ANTHROPIC
```
Do not assume `up -d` propagated correctly. Confirm it.

### Rule 3: LiteLLM 429 triage — always check logs first

"429 from LiteLLM" means the router has no healthy deployment. The cause can be:
- Anthropic rate limit (genuine 429 upstream)
- Auth failure (401 upstream)
- Network or config error

**Always run `docker compose logs litellm --tail 50` before assuming rate limit.**
Cross-check with Anthropic console: if spend is $0, the request never reached Anthropic
and the cause is local (bad key, missing env var, stale config).

## Consequences

- Any change to `docker-compose.yml` or `litellm-config.yaml` in the repo requires
  running `deploy-infra.bat` to take effect on the VPS. This is a manual step with no
  automated enforcement — failure to run it causes config drift.
- The VPS flat layout diverges from the repo's `n8n/` subdirectory structure. Do not
  attempt `git clone` or `git pull` into `/opt/haxe-agents/`.
- Future upgrade path: a GitHub Actions workflow that deploys changed infra files on push
  to main. Justified once team > 1 person touches infra, or once incidents recur.

## Date

2026-06-08
