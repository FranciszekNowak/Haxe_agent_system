# ADR-041: Guard the 0-row routing path in Invoke Model

## Context

`Invoke Model (v1)` selects a model with `Lookup Routing` (Postgres) against `model_routing`,
keyed on `(impact, personal_data, modality)` with an `impact='__default__'` fallback in the same
query. The node has `onError: continueErrorOutput` so a **DB error** routes to `Resolve Routing`
(which carries a hard-coded safety-net model). But a **0-row result is a query success with zero
items**, not an error — so `onError` does not catch it. With 0 items, `Resolve Routing` never runs
(n8n's "a 0-item node silently nulls the chain" behaviour), the whole sub-workflow returns 0 items,
and the caller (`Execute LLM Call` → `Agent Orchestrator`) nulls too. Result: **no completion, no
reply, and no alert** — a fully silent failure.

This bit task `869dm1z8y` (2026-06-11): a "n/d - zadanie nie jest dla AI" task carrying an image
attachment resolved to `modality=multimodal_input`, for which that impact tier had no routing row
(see migration 019). `Lookup Routing` returned 0 rows → silent no-reply.

## Decision

Two complementary guards in `Invoke Model (v1)`:

1. **`alwaysOutputData: true` on `Lookup Routing`.** A 0-row result now emits one (empty) item, so
   `Resolve Routing` always runs and applies its existing safety-net model (`haxe-sonnet-4-6-direct`)
   instead of the chain nulling. The run still produces a completion and a reply.
2. **Explicit `routing_row_missing` flag + CRITICAL alert.** `Resolve Routing` sets
   `routing_row_missing = true` whenever it fell back because no row was found (and there was no
   model override). A new `Routing Missing?` IF fires **`Alert Routing Missing` (CRITICAL,
   `source: invoke-model/routing`)** via `Post Alert (v1)`, naming the missing
   impact×modality×personal_data combo and the safety-net model used. It is loud-but-non-blocking:
   the run still replies via the fallback.

**Topology:** the alert reconverges to `Check Degradation` (it is not a dead-end), so `Shape Output`
remains the **sole leaf** and the sub-workflow return stays deterministic — the same return-path
discipline as ADR-040. Two `$json.cost_missing` reads (in `Check Degradation` and `Alert
Degradation`) were switched to the explicit `$('Call Log Model Run').first().json.cost_missing` ref
because a node was inserted into that chain.

## Consequences

- A `model_routing` gap can no longer silently drop a reply: the run falls back to a working model
  **and** raises a CRITICAL naming the exact missing combo, so the table can be filled in.
- The safety-net model is `haxe-sonnet-4-6-direct` (text/vision capable). For a genuinely unroutable
  multimodal+PD task this is **not** EU-only — acceptable as a last resort that also screams CRITICAL,
  but the real fix is always to add the routing row (as migration 019 did for the n/d tier).
- Verified live: with the n/d multimodal row present the guard stays quiet (`routing_row_missing=false`);
  the silent-null path is closed.
- Related: migration 019 (the missing n/d multimodal row + Gemini Flash `max_tokens=12000` because a
  reasoning model's `max_tokens` caps reasoning+output and 4000 truncated to an empty completion).

## Date

2026-06-11
