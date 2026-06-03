# ADR-023: Importance→model routing (v1) — concrete tiers, verified EU profiles, "max effort" approximation

Date: 2026-06-03
Status: Accepted

## Context
ADR-013 and ADR-021 deferred the actual `importance → model` mapping as a pending
operator decision. The operator has now made it. This ADR records the concrete v1
routing and the empirical facts that constrain it. It resolves the "pending
mapping" flagged in ADR-021/ADR-013 for the **importance axis** (the sensitivity
axis remains deferred — no classifier yet).

## Decision

### The mapping (importance → model, temperature, max tokens)
Implemented in the `Select Model` step of `Invoke Model (v1)` (now a Code node — a
pure-shaping routing table; see ADR-022 update). All profiles are **EU-resident**
(`eu.` prefix) for GDPR (ADR-002).

| `[AI] Wpływ zadania na wynik firmy` | Model | EU inference profile ID | temp | maxTokens |
|---|---|---|---|---|
| `Niski` | Haiku 4.5 | `eu.anthropic.claude-haiku-4-5-20251001-v1:0` | 0.7 | 4000 |
| `Średni` | Sonnet 4.6 | `eu.anthropic.claude-sonnet-4-6` | 0.7 | 4000 |
| `Wysoki` | Opus 4.5 | `eu.anthropic.claude-opus-4-5-20251101-v1:0` | 0.5 | 8000 |
| `Krytycznie ważne` | Opus 4.5 | (same) | 0.2 | 16000 + nudge |
| `n/d` / empty / unknown | Sonnet 4.6 | `eu.anthropic.claude-sonnet-4-6` | 0.7 | 4000 |

The last row is the ADR-013 asymmetric fail-safe: anything not positively matched
routes to Sonnet on Bedrock-EU (compliant, capable), never off-EU and never failing.

### Model access is verified, not assumed
The exact profile IDs and **account access** were established empirically
(2026-06-03) by listing `bedrock.eu-central-1` inference profiles (the control
plane *does* sign with the generic AWS credential — only the `bedrock-runtime`
data plane does not; cf. ADR-021) and smoke-testing each:
- `eu.anthropic.claude-haiku-4-5` (no date suffix) → **invalid identifier**. The
  valid Haiku profile carries the `-20251001-v1:0` suffix. Bare-name guessing fails;
  Sonnet 4.6 is unusual in having a bare `eu.anthropic.claude-sonnet-4-6` id.
- Haiku 4.5, Sonnet 4.6, **Opus 4.5** → return completions (access granted).
- **Opus 4.6 / 4.7 / 4.8 exist in eu-central-1 but are NOT granted to account
  000500193947** ("…is not available for this account"). Hence Opus tiers use 4.5
  today. To upgrade: request access to a newer Opus on the Bedrock **Model access**
  page, smoke-test it, then bump the `OPUS` constant in `Select Model` (one line).

### "Max effort" for `Krytycznie ważne` = approximation, by node limitation
The operator asked for "Opus max effort." The native n8n AWS Bedrock Chat Model
node exposes only `temperature` and `maxTokensToSample` — **no reasoning-effort /
extended-thinking budget**. So "max effort" is approximated as: lowest temperature
(0.2, precision/determinism), large output budget (16000), and a prepended
**deliberation nudge** ("reason step by step, consider edge cases, verify before
answering, prioritise precision over brevity, do not rush; respond in the task's
language"). A true thinking budget would need a newer node version or a raw Converse
call with `additionalModelRequestFields` — but ADR-021 showed the raw HTTP/SigV4
path can't sign `bedrock-runtime`. Revisit if/when the node gains a thinking option.

### Routing key is the resolved Polish label
`Context Gather (v1)` resolves the importance custom field
(`55c7ff79-1857-41e6-87b4-bd46678e1470`, `new_drop_down` → value is the option
UUID) to its **label** via the field's own `type_config.options`, with a hardcoded
UUID→label fallback. The routing table switches on that label. (When routing
becomes the ADR-013 Supabase lookup, the key can move to the stable UUID.)

## Consequences
- Verified live (2026-06-03) via the Invoke Model harness: `Niski`→Haiku (temp 0.7,
  4000), `Krytycznie ważne`→Opus 4.5 (temp 0.2, 16000, nudge prepended), both
  returning completions; `Średni`/`Wysoki`/default are trivial switch branches over
  already-verified models. Per-tier `temperature`/`maxTokens` flow into the Bedrock
  node by expression from `Select Model`.
- The nudge is in **English** (operational/system instruction; the model still
  answers in the task's language). Flip to Polish if preferred — one constant.
- Cost/latency: `Krytycznie ważne` at 16000 max tokens on Opus is deliberately the
  most expensive path; that is the intent. The fail-safe Sonnet path is the cheap
  default for un-triaged work.
- This is a hardcoded table, the ADR-013 endpoint is a data-driven Supabase lookup;
  the seam (one node) is unchanged, so that migration stays single-place.

Related: ADR-013 (centralized invocation, routing-as-data, fail-safe), ADR-021
(native Bedrock node, EU profiles, control-plane vs data-plane signing), ADR-022
(Invoke Model shape), ADR-002 (Bedrock-EU only), ADR-020 (Context Gather).
