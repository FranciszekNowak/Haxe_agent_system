# ADR-042: Gemini thinking level + output-token tiers

## Context

Our Gemini routes (`haxe-gemini-flash-eu` → `vertex_ai/gemini-3.5-flash`, `haxe-gemini-pro-eu`
→ `vertex_ai/gemini-3.1-pro-preview`) are **reasoning models**. Two facts (researched against
Google Vertex AI + LiteLLM docs, 2026-06-11) make their token budgeting different from Claude:

1. **Thinking tokens are billed and counted as OUTPUT tokens**, and they count against the
   request's `max_tokens` (`maxOutputTokens`). A 4,000-token thinking pass + 500-token answer =
   4,500 output tokens.
2. **Gemini 3 Flash defaults to `thinkingLevel = high`.** Gemini 3.x replaced the numeric
   `thinking_budget` with `thinking_level` (`minimal`/`low`/`medium`/`high`); LiteLLM maps OpenAI's
   `reasoning_effort` onto it.

Consequence observed on task 869dm1z8y: with default (high) thinking, gemini-flash burned
**3.8k–7.7k reasoning tokens** of the request's `max_tokens`. At the 8k cap it hit
`finish_reason=length` with `content: null` — an **empty completion, no reply**. (The earlier 4000
cap failed the same way.) `max_tokens` is the OUTPUT cap only; it does **not** limit input/context
(that is the 1M-token context window) — so the fix is not "raise the cap to hundreds of thousands".

Model ceilings: Gemini 3 Flash = 1M in / **64k out**; 3.1 Pro output settable to 32k/64k.

## Decision

**Bound thinking per model via `reasoning_effort` in `litellm_params`** (a per-call default applied
by the gateway; our requests don't send it):

- `haxe-gemini-flash-eu` → `reasoning_effort: low` — flash serves the lower tiers
  (`n/d`/`Niski`/`Średni`); low thinking keeps the reasoning pass small so the output cap is real,
  and is faster.
- `haxe-gemini-pro-eu` → `reasoning_effort: high` — pro serves the high tiers
  (`Wysoki`/`Krytycznie ważne`); their 32k output cap leaves ample room for deep thinking + answer.

**Output `max_tokens` by impact tier (migration 020):** Niski 8k, Średni 16k, Wysoki + Krytycznie
ważne 32k; `n/d` and `__default__` 8k. All ≤ the 64k model ceiling. Applies to every provider
(Claude/Bedrock/Gemini); for Claude/Bedrock `max_tokens` is pure output (they have no thinking-token
overlap).

## Consequences

- Verified live: gemini-flash at `reasoning_effort: low` dropped reasoning 7,679 → 2,560 tokens,
  `finish_reason=stop`, full 803-token answer within the 8k cap, reply posted in-thread.
- `reasoning_effort` is a **per-model** default, not per-tier. The flash↔lower-tiers and
  pro↔higher-tiers mapping makes this a reasonable proxy; finer per-tier thinking control would need
  a per-request `reasoning_effort` (a `model_routing` column + Resolve Routing wiring) — not done.
- Thinking level is a **soft allowance, not a hard guarantee** (Google's wording; reasoning can
  overshoot). The output tiers give headroom; the Invoke Model 0-row/empty-completion guards
  (ADR-041 + the orchestrator's `If LLM Succeeded?` CRITICAL) catch any residual truncation loudly.
- Deployment: `litellm-config.yaml` is mounted into the `litellm` container; applied via
  `scp` + `docker compose up -d litellm` (deployment.md). The stale in-file comment claiming
  "gemini-3.x not yet available in EU regions" predates this and is left untouched to keep repo==VPS;
  it should be refreshed on the next config deploy.

## Date

2026-06-11
