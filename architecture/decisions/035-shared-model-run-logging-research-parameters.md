# ADR-035: Web research as a context step, generic Invoke Model, shared cost-owning logger

## Context

The web-search loop (ADR-034) was first wired so that **`Invoke Model` called `Model
Turn`** (the recursive search loop) as its engine. That conflated two concerns:

1. **No generic model call remained.** Every task — even pure internal ones — ran through
   the recursive loop. `Invoke Model`, the swappable generic seam (ADR-013/022,
   `prompt → completion`), carried research orchestration it should not.
2. **Research *was* the deliverable.** The loop's synthesized text was the posted answer,
   so when the loop capped out (`max_rounds_reached`) the whole task failed with no answer
   (seen live on task `869dgrx49`: empty `impact` → default depth → capped → no result).
3. Research (Tavily) cost was either invisible or coupled to `Model Turn` returning correct
   aggregates; any direct caller logged nothing.

## Decision

Web research becomes a **context-gathering step the agent spine orchestrates**, a sibling
of Context Gather and Workspace Search — not the answer producer. Three workflows, each
calling one shared logger.

1. **`Log Model Run (v1)`** (`ztSIUkp9ytbG1xpE`) — the **sole `agent_runs` writer AND the
   sole owner of cost math**. Inputs: a batch of normalized call records
   (`clickup_task_id, caller_user_id, process_type, triggered_by, invocation_type,
   model_used, impact, input_tokens, output_tokens, usd_cost`) plus optional
   `price_in_usd_per_1k`/`price_out_usd_per_1k`. It fetches FX once (`executeOnce`), computes
   `cost_pln = usd·fx` — falling back to `tokens·table_price` when `usd_cost` is absent —
   inserts one row per record, and **returns `{ logged, cost_pln_total, cost_missing }`** so
   callers surface cost without recomputing. Insert uses `onError: continueErrorOutput`; a
   failed insert fires a `WARN` via `Post Alert (v1)`. No FX/PLN math lives anywhere else.

2. **`Invoke Model (v1)`** (`XcOIVdZnVCCWNPeb`) — reverted to its pre-web-search shape
   (`/v1/chat/completions`, single call) with three deltas: a new optional `model_override`
   input (honored in `Resolve Routing`, skipping routing-table dependence); `Compute Cost`
   reduced to a pure **`Parse Response`** (text/tokens/usd-header/`routing_default_used`, no
   FX/PLN); and its own `Insert`/`Get FX` replaced by a call to `Log Model Run`, reading back
   `cost_pln_total`/`cost_missing` for the footer + the `Check Degradation` WARN. It logs
   exactly one row — its own generic call.

3. **`Research the web (v1)`** (`BdZ9Chhqs691Ljlk`, renamed from `Model Turn`) — the recursive
   agentic web-search loop, unchanged internally except: the `web_search` tool is always
   offered; it receives run-context (`clickup_task_id`, `caller_user_id`, `process_type`,
   `triggered_by`, `invocation_type`, `impact`) threaded through the recursion; and at the
   terminal turn it **self-logs its `calls[]` ledger** (one `research_round` row per reasoning
   round + one `model_used='tavily'` row per search, search cost from the `/v1/search`
   `x-litellm-response-cost` header) via `Log Model Run`, then returns **findings + sources**
   (not a deliverable).

4. **`Agent Spine (v1)`** (`a8XKaijkMFNBpRBa`) — after Workspace Search, a cheap **Haiku gate**
   (`Invoke Model` with `model_override`) answers TAK/NIE on whether the task needs current web
   info. TAK → resolve research routing (`model_routing` by `impact, personal_data`) +
   `research_parameters` by `impact` → `Call Research the web` → findings injected into
   `Build Prompt` (`# Wyniki researchu w sieci`) and rendered as a `## Źródła` section in the
   comment. NIE → straight to the answer. The generic `Invoke Model` then produces the
   deliverable from the full context. `Sum Task Cost` aggregates all `agent_runs` rows (gate +
   research + answer) — no double-count.

5. **Personal data does NOT gate research.** `personal_data=true` only routes the *inference*
   (gate, research loop, final answer) to **Bedrock-EU aliases** (GDPR, ADR-024). Research
   still runs; only the model-written query — which carries no PII (soft hygiene in the Global
   Agent Rules, backstopped by the Tavily DPA) — egresses to Tavily. This is exactly why Tavily
   was chosen over Bedrock-native search (ADR-034); this ADR reinforces, not supersedes, it.

6. **`research_parameters`** (migration `011`, keyed by `impact`): `max_research_rounds` +
   `tavily_max_results`. Seeded Niski(2,5) · Średni(3,5) · Wysoki(5,8) · Krytycznie ważne(8,10)
   · `n/d…`(1,3) · `__default__`(3,5). No `agent_runs` migration — `model_used='tavily'`
   discriminates search rows; existing `triggered_by`/`impact` CHECKs cover all logged values.

## Consequences

- **Research and the deliverable are decoupled.** A capped/failed research step degrades to
  partial findings + a WARN; the separate generic answer call still runs. Verified live (task
  `869dmarca`): gate→TAK, 3 research rounds + 3 Tavily searches self-logged, then a distinct
  answer row — and a generic NIE task (`869dgrx49`) logged only gate + answer, no research.
- **One writer, one cost path.** Every model/search call is logged with `cost_pln` computed in
  one place; Tavily cost is captured exactly (≈0.0295 PLN/search live). `Sum Task Cost` totals
  correctly with no double-count (example total 0.3319 PLN across 9 rows).
- **Provenance restored.** Web sources render as a `## Źródła` section in the ClickUp comment.
- **More `agent_runs` rows per research task** (one per round + per search + gate + answer).
- **Cost of the gate:** one cheap Haiku call on every @-mention (latency-first; the spine, not
  a self-gating agent, decides — so the heavier research loop only runs when needed).

## Also fixed here (separate bug)

`cu-webhook-producer.json → Detect Mention` set `triggering_comment_id` from
`h.comment.parent`, which ClickUp populates with the **task id** for top-level comments — so
in-thread replies targeted a task, not a comment, and failed (`agent-spine/thread-reply` WARN
seen live). Now uses `h.comment.id`.

## Date

2026-06-09
