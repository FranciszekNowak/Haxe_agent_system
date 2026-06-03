# ADR-024: LiteLLM gateway, Supabase-driven routing, and exact usage/cost tracking

Date: 2026-06-03
Status: Accepted (rollout in progress)

## Context
Three forces converged:
1. **Exact cost is impossible on the native path.** The n8n native AWS Bedrock Chat
   Model node (ADR-021) and the Basic LLM Chain swallow token usage — the chain
   outputs only `{ text }`, the sub-node outputs nothing referenceable, and usage
   appears nowhere in the execution record. A raw Converse HTTP call that *would*
   return `usage` is blocked by the SigV4 signing mismatch (ADR-021).
2. **Routing should be data, not code.** ADR-013 (seam #3) calls for the
   `(impact[, sensitivity]) -> model` mapping to live in Supabase, not an n8n node.
   ADR-023 implemented it as a temporary in-n8n Code-node table.
3. ADR-013/ADR-021 already name a **self-hosted gateway (LiteLLM)** as the intended
   final form of the centralized invocation seam.

The operator chose to adopt the gateway now rather than ship estimated cost or a
community node.

## Decision
1. **Adopt a self-hosted LiteLLM gateway** as the production model-call path — a new
   internal-only container in the VPS stack (`n8n/docker-compose.yml`, service
   `litellm`, on `n8n-internal`, bound to `127.0.0.1:4000`, never public). It signs
   Bedrock itself and returns OpenAI-normalized responses **including exact `usage`**.
   Config: `n8n/litellm-config.yaml` (committed, no secrets); AWS creds + master key
   from the VPS `.env` (`.env.example` updated). EU profiles only (ADR-002).
2. **n8n calls LiteLLM over plain HTTP**, replacing the Basic LLM Chain + native
   Bedrock sub-node in the production path. This is *more* inspectable (a visible URL
   + JSON body) and ADR-019-compliant (HTTP Request is a credential-aware node;
   auth = the LiteLLM master key). The native node is **retained as a documented
   fallback**, not deleted.
3. **Routing moves to Supabase** (`model_routing` table, migration `002`). The
   selection step becomes a credential-aware Postgres lookup keyed on the impact
   label, with a `__default__` row as the data-driven fail-safe and an in-code
   last-resort default if the DB itself is unreachable (preserves ADR-013 fail-safe
   even on Supabase outage). The table stores the LiteLLM alias, temperature,
   max_tokens, priority, optional nudge, and PLN token prices.
4. **Exact usage, USD prices × daily NBP FX = PLN cost.** Token counts come from
   LiteLLM's `usage` (exact). Per-model **USD** prices live in `model_routing`
   (Bedrock bills in USD; these change rarely, so operator-maintained config). The
   only daily-changing factor — the **USD/PLN rate** — is auto-imported each day from
   the **NBP (Narodowy Bank Polski) Web API** (table A average rate, free/no-key, and
   the official rate Polish accounting uses:
   `https://api.nbp.pl/api/exchangerates/rates/a/usd/?format=json`, `rates[0].mid`)
   into an `fx_rates` table (migration `003`) by a small daily n8n cron. Then
   `cost_pln = (in_tokens/1000·usd_in + out_tokens/1000·usd_out) × latest_fx`. Each
   run is logged to `agent_runs` (model, provider, tokens, cost_pln, trigger,
   status, …). Seeded USD prices are best-effort list prices and must be verified
   against current AWS Bedrock eu-central-1 pricing before cost is trusted.
5. **Field renames** for clarity/consistency (operator request):
   `importance -> impact` (matches the ClickUp field "Wpływ zadania na wynik firmy"),
   `sensitivity -> personal_data` (boolean; fail-safe default `true` = treat as
   personal data until the deferred classifier exists).

## Consequences
- **Native Bedrock node demoted to fallback.** ADR-021's node is no longer the
  production caller; it stays as a break-glass path. ADR-023's in-n8n routing table
  is superseded by the Supabase `model_routing` table (the ADR-023 *mapping* still
  stands; only its location moves).
- **New critical-path dependency.** If LiteLLM is down, inference stops. Mitigated by
  `restart: unless-stopped` + healthcheck + the retained native-node fallback.
- **Capability unlocked:** prompt caching (principle #5) and multi-provider routing
  become config changes in one place (the gateway), not n8n rework.
- **Secret spread (accepted):** the Bedrock IAM user's keys now also live in the VPS
  `.env` for LiteLLM (in addition to n8n's encrypted store). The IAM user is
  Bedrock-scoped, bounding blast radius.
- **Verify-on-deploy (per ADR-021/023 discipline):** the `bedrock/<eu-profile>`
  model-string format, the healthcheck command, the LiteLLM image version pin, and
  exact `usage` in the response must each be smoke-tested on first deploy before this
  is trusted.
- **Repo gap surfaced:** `001_initial_schema.sql` was applied to Supabase but never
  committed (only `.gitkeep`). It must be back-filled from the live schema so the
  migrations directory reflects reality before `002` is meaningful.

## Rollout (sequenced; operator-gated steps marked ⚑)
1. ⚑ Create a **Postgres credential** in n8n pointing at Supabase (Session pooler, SSL).
2. ⚑ Add LiteLLM secrets to the VPS `/opt/haxe-agents/.env` (master key + Bedrock IAM keys).
3. ⚑ Deploy: sync repo to VPS, pin the LiteLLM image version, `docker compose up -d litellm`; smoke-test `/health` and one completion (confirm `usage` present + EU profile string valid).
4. Back-fill `001_initial_schema.sql` (dump live schema via the new credential) + apply `002_model_routing.sql` + `003_fx_rates.sql`.
5. Build the daily **FX cron** workflow (n8n schedule → HTTP GET NBP → upsert `fx_rates`). Verify USD/PLN lands.
6. Rewire `Invoke Model (v1)`: Supabase routing lookup → HTTP Request to LiteLLM → capture exact usage → compute `cost_pln` (USD price × latest FX) → log `agent_runs`; renames (`impact`, `personal_data`) throughout. Retire the chain/native node to fallback.
7. Verify per-tier end-to-end; re-export workflows; update `current.md` (§5, §11, §15) and ADR-023; commit.

Related: ADR-013 (centralized invocation, routing-as-data, gateway), ADR-021
(native node — now fallback), ADR-023 (the mapping — now in Supabase), ADR-011
(Docker stack + Tier-3 secrets), ADR-019 (credential-aware nodes), ADR-002 (Bedrock-EU).
