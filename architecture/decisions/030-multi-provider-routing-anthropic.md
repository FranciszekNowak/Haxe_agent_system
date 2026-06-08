# ADR-030: Multi-provider model routing — Anthropic direct as non-GDPR default

## Context

The `Invoke Model (v1)` sub-workflow previously routed all inference to AWS Bedrock
EU (eu-central-1). Bedrock's Anthropic model catalogue in the EU region lags
Anthropic's direct API: the highest available tier was Opus 4.5 (released Nov 2025),
while Anthropic direct offers Opus 4.8. This quality gap was measurable in
production output.

Additionally, two bugs were found in the codebase during this change:
- `Build Prompt` hardcoded `personal_data: true`, causing every run to be treated as
  GDPR-sensitive — routing ALL tiers through Bedrock and defeating the routing table.
- `Resolve Routing` had inverted logic for the `personal_data` default, defaulting
  to `true` (GDPR) instead of `false`.

## Decision

1. **Default is Anthropic direct API** (`personal_data=false`). Explicit tasks default
   to non-GDPR routing and get the latest available models (Haiku 4.5, Sonnet 4.6,
   Opus 4.8).

2. **GDPR path is Bedrock EU** (`personal_data=true`). When a task contains personal
   data, routing stays within AWS eu-central-1. Best Bedrock EU option for
   Wysoki/Critical is Opus 4.5 (the most capable GDPR-safe model available).

3. **Routing is data-driven** via a composite primary key `(impact, personal_data)` on
   `model_routing`. No in-code provider logic — the correct model alias is returned
   by the DB query based on both axes.

4. **`personal_data` defaults to `false`** throughout the pipeline until the Phase 3
   sensitivity classifier is built. This means all explicit invocations use Anthropic
   direct unless overridden. The PD Verifier seam (Inc 4, planned) will classify tasks
   and set `personal_data=true` when appropriate.

5. **Versioned LiteLLM aliases**: six aliases replace the previous three. Alias names
   encode provider and model version (e.g., `haxe-opus-4-8-direct`). This makes
   `agent_runs.model_used` unambiguous — it stores the actual model ID from the
   LiteLLM response body (e.g., `claude-opus-4-8`), not the alias.

6. **`ANTHROPIC_API_KEY`** is added to the litellm container via `docker-compose.yml`
   environment passthrough from the VPS `.env`. Store in 1Password.

## Consequences

- Production Wysoki/Krytycznie ważne tasks now use Opus 4.8 (vs. 4.5 previously) for
  measurably better output quality on non-GDPR tasks.
- Any task with personal data must explicitly set `personal_data=true` (or wait for
  the Phase 3 sensitivity classifier) to route through Bedrock EU.
- The ANTHROPIC_API_KEY must be added to the VPS `.env` before the updated LiteLLM
  container is restarted. Until then, direct-routing calls fail and the Error Handler
  fires CRITICAL.
- `agent_runs.model_used` now stores the full versioned model ID (e.g., `claude-opus-4-8`
  or `bedrock/eu.anthropic.claude-haiku-4-5-20251001-v1:0`), improving cost analysis
  and auditability.

## Date

2026-06-08
