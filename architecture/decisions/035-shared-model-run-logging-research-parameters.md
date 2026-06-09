# ADR-035: Shared model-run logging seam + per-impact research parameters

## Context

After the web-search agentic loop went live (ADR-034), research runs were
**under-logged**. The flow is `agent-spine → Invoke Model (v1) → Model Turn (v1)`,
where Model Turn makes the actual LiteLLM calls (`/v1/messages` per reasoning round,
`/v1/search` per query). Only `Invoke Model` wrote `agent_runs`, and it wrote **one
aggregate row** per invocation from the totals Model Turn returned.

Consequences observed on live data (task `869dgrx41`, row id 43): the row captured
only the Claude token cost; the **Tavily search calls were logged nowhere**, so search
cost was invisible and total research spend was under-reported. There was no per-call
granularity, and the single insert was fragilely coupled to Model Turn returning correct
aggregates — any future direct caller (e.g. image generation) or a direct Model Turn
invocation logged nothing.

Two options were weighed:

- **Option A — Model Turn calls Invoke Model; add Tavily as a `model_routing` entry.**
  Rejected: (1) **circular dependency** (Invoke Model already calls Model Turn);
  (2) **contract change** — Invoke Model is `prompt → completion`, but the loop needs
  `messages[] + tools[] → content-blocks`, changing the seam for every caller;
  (3) **chat ≠ search** — `/v1/messages` and `/v1/search` have different shapes, and
  `model_routing` rows are chat-shaped (model + temperature + token prices), a poor fit
  for a per-request search tool.
- **Option B — extract a shared "Log Model Run" subworkflow** used by the layer that
  already holds run-context. Chosen.

Impact-scaled research effort (more rounds for higher-impact tasks) was a separate need;
the operator chose a dedicated `research_parameters` table rather than overloading
`model_routing`, because research effort scales with **impact only**, not with the
GDPR `(impact, personal_data)` routing key.

## Decision

1. **`Log Model Run (v1)`** (`ztSIUkp9ytbG1xpE`) is the **sole writer** of `agent_runs`.
   It accepts a batch of normalized call records (`clickup_task_id, caller_user_id,
   process_type, triggered_by, invocation_type, model_used, impact, input_tokens,
   output_tokens, usd_cost`), fetches the USD→PLN rate once (`executeOnce`), computes
   `cost_pln` per record, and inserts one `agent_runs` row per record. Insert uses
   `onError: continueErrorOutput`; a failed insert fires a `WARN` via `Post Alert (v1)`
   (the insert-fail alert moved here from Invoke Model).

2. **`Model Turn (v1)`** returns a per-call **`calls[]` ledger** alongside its existing
   outputs: one `{call_type:'research_round', model_used:<alias>, …}` per reasoning round
   and one `{call_type:'web_search', model_used:'tavily', usd_cost:<from /v1/search cost
   header>}` per search. `/v1/search` emits `x-litellm-response-cost` (≈ $0.008/search),
   so search cost is captured **exactly**, not estimated. Model Turn also now takes
   `max_depth` and `tavily_max_results` from the caller and an `enable_web_search` flag
   (defaults true) that gates whether the `web_search` tool is offered.

3. **`Invoke Model (v1)`** looks up `research_parameters` by impact, passes
   `max_depth = max_research_rounds`, `tavily_max_results`, and `enable_web_search` to
   Model Turn, then **loops Model Turn's `calls[]`** through `Log Model Run` (one row per
   call). It no longer inserts `agent_runs` itself — the per-call rows are authoritative,
   so `agent-spine`'s `Sum Task Cost` aggregates them with **no double-count**. Invoke
   Model still computes the per-invocation aggregate for the comment footer / cost field
   and keeps the `Check Degradation → Alert Degradation` WARN
   (`routing_default_used` / `cost_missing` / `web_search_error`).

   **Logging is driven from Invoke Model looping the ledger, not from Model Turn calling
   the logger mid-recursion** — this keeps run-context out of the recursive workflow and
   centralizes logging where the context already lives. `Log Model Run` remains the
   shared seam any future direct caller (image, etc.) reuses.

4. **`Search (v1)`** passes `enable_web_search=false` on its two Invoke Model calls
   (query-extraction, condense) so those steps cannot wander into web search; they keep
   `triggered_by='search_step'` and log via the same shared seam.

5. **`research_parameters`** table (migration `011`, keyed by `impact`):
   `max_research_rounds` + `tavily_max_results`. Seeded Niski(2,5) · Średni(3,5) ·
   Wysoki(5,8) · Krytycznie ważne(8,10) · `n/d…`(1,3) · `__default__`(3,5). RLS enabled
   with no policies (pipeline uses the direct Postgres role, per migration 007 / ADR-028).
   **No `agent_runs` migration**: search rows use `model_used='tavily'` (no CHECK on
   `model_used`) as the discriminator; round rows use the Claude alias; existing
   `triggered_by`/`impact` CHECKs already cover all logged values. A `call_type` column
   on `agent_runs` was considered and deferred.

## Consequences

- **Search cost is now visible and exact.** Verified live: a Średni research run logged
  4 `research_round` rows (sonnet, 0.3317 PLN) + 9 `web_search` rows (tavily, 0.2655 PLN)
  = 0.5972 PLN total — the ~0.27 PLN of Tavily cost that was previously invisible is now
  captured per call.
- **One shared writer** for every model run (text, research, future image); per-call
  granularity; logging decoupled from Model Turn's return contract.
- **Research effort scales with impact** via `research_parameters` (Wysoki up to 5 rounds,
  Niski up to 2), tunable in-table without touching workflows.
- **More n8n executions / `agent_runs` rows per research run** (one row per round + per
  search instead of one aggregate). `Sum Task Cost` still yields the correct per-task
  total. A research run that caps out (`max_rounds_reached`) returns the fallback note +
  sources and fires the existing `web_search_error` WARN — unchanged by this ADR.
- A subtle n8n gotcha was hit and fixed: the `Execute Workflow` node passes **all** input
  items to the sub-workflow in a single call (it does not loop per item by default), so
  `Log Model Run` must process the **batch** (`Compute PLN` maps all items; the Postgres
  insert runs once per item) rather than reading `.first()`.

## Date

2026-06-09
