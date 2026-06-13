# ADR-047: Unified model fallback via shared primitives (one seam, one tier rule)

Status: Accepted and fully landed 2026-06-13. Block A (research path) and Block B
(Invoke Model adopts the seam for both modalities) both landed and verified live on
2026-06-13 — see "Implementation status".
Date: 2026-06-13
Deciders: Franciszek (operator), with design review

## Context

`research-the-web` (workflow `BdZ9Chhqs691Ljlk`) threw CRITICAL intermittently. Root cause
(live executions 1868, 1910, 2026-06-13): it calls LiteLLM with the model resolved for the
task's impact tier, and for `Krytycznie ważne` that is `haxe-fable-5-direct`, which
intermittently 404s ("Claude Fable 5 is not available. Please use Opus 4.8"). Research had no
fallback, unlike `Invoke Model (v1)` (ADR-037). Research is the one routed call-site that goes
around Invoke Model, which is why it lacked the fallback Invoke Model already had.

We considered making Invoke Model the single chokepoint for every model call. Grounding that
against the live `invoke-model.json` ruled it out: Invoke Model posts to `/v1/chat/completions`
(OpenAI shape) and builds a single-prompt `messages` array, while research's tool loop runs on
`/v1/messages` (Anthropic content blocks, `tool_use`/`tool_result`). Routing research through
that path would mean changing the wire format and bypassing the body build, normalization, and
its hardcoded Opus retry. So the reusable **primitives**, not the workflow, are what unify.

A `fallback_model` column on `model_routing` was considered and rejected: the impact tiering
already encodes capability order, so a column duplicates it and drifts. The fallback is derived.

### Correction to the original draft (grounded against live workflows)

The original draft claimed research "bypassed Invoke Model" and that this change "closes a
cost-attribution gap." That is **false**: live `research-the-web` already prices every round and
every Tavily call into `agent_runs` via the shared `Log Model Run (v1)` (`ztSIUkp9ytbG1xpE`,
ADR-035), flushed at its leaf turn. There was no gap. The only logging change actually needed was
to record the **served** model (the seam may serve the fallback), not the static input model.

## Decision

### 1. Fallback is "one tier below within the same modality", derived from the impact ordering.
The universal fallback for any model is the model at the next lower impact tier, ordered by
`REAL_TIERS = ['Niski','Średni','Wysoki','Krytycznie ważne']` (capability ascending), **within the
same `modality`**. At the floor (`Niski`) there is no lower tier and so no fallback. No new column.
Capability order is not price (Fable is cheaper than Opus yet more capable), so the ordering comes
from the tiering, not cost.

### 2. The step-down is implemented once, shared: `Resolve Lower Tier (v1)`.
New sub-workflow (`GNO6ZsIcSpvYUJDq`). Inputs `impact` + `modality` (default `text`); reads the
active `model_routing` rows for that modality, orders by `REAL_TIERS`, and returns the row one
tier below as `{ impact, litellm_model, max_tokens, temperature }`, or `{ floor: true }` at
`Niski`/unknown. Sole owner of the step-down.

### 3. The seam is a shape-aware-by-parameter mechanism: `Call Model with Fallback (v1)`.
New sub-workflow (`jBqu7znBIOMBF9HI`). Does only try-primary-then-fallback and reports which
served. It does **not** hardcode `body.choices`/`body.content`; instead the caller may pass an
optional `success_path` (a dot-path into the response body, e.g. `data.0.b64_json`) that must be
non-empty for success — empty `success_path` means "2xx + body". This lets one seam serve
research's `/v1/messages`, Invoke Model's `/v1/chat/completions`, and Invoke Model's
`/v1/images/generations` (where success is payload-gated, not status-gated — the "Docling
gotcha"). Inputs: `endpoint_url`, `request_body` (JSON string, primary model set), `fallback_model`,
`extra_headers` (JSON string), `success_path`. Returns `{ fell_back, model_used, body, headers }`.
A both-down failure (HTTP error **or** failed `success_path` on the fallback) throws, surfacing
exactly one CRITICAL from the caller. Internally it routes the primary's 2xx output through an
assessment node (so a 2xx-with-bad-payload still falls back), keeps a single branch-free `Return`
leaf, and never lets two incoming connections carry items into one Code node at once.

### 4. Unification is at the primitive level, not the workflow level.
The shared standalone sub-workflows are: the seam (fallback), `Resolve Lower Tier` (the tier rule),
and `Log Model Run` (cost, ADR-035). Research and Invoke Model keep their own request/response
shapes and get every unification benefit by calling those three directly. The clean invariant is
one fallback seam, one tier helper, one cost logger — not one model-call workflow.

### 5. Research routes through the seam at a lowered impact; keeps its existing cost logging.
- `decide-research-and-deliver` computes research models via the helper: research primary =
  `ResolveLowerTier(task_impact, text)` clamped to the floor (a `Niski` task researches on its own
  `Niski` row, via the existing task-tier lookup `Lookup Research Routing`); fallback =
  `ResolveLowerTier(research_primary.impact, text)` (empty at the floor). It passes the research
  model, its tier `max_tokens`/`temperature`, the `fallback_model`, and `acc_fell_back: false` to
  research. Research depth (Tavily results, rounds) stays keyed to the TASK impact.
- `research-the-web` builds its `/v1/messages` body and calls the seam directly
  (`endpoint_url = .../v1/messages`, `extra_headers = {"anthropic-version":"2023-06-01"}`,
  `success_path` empty), getting back the raw Anthropic response with `tool_use` intact.
- Research **keeps its existing leaf-based cost logging** (`Build Final → Emit Research Calls →
  Call Log Model Run`). The only change: `Parse Turn` records the seam's **served** `model_used` in
  the `research_round` ledger entry (so a fallback round is priced against the model that actually
  served). No per-round Log Model Run node was added (that would double-log).
- Research accumulates `acc_fell_back` across recursion; `decide-research` fires exactly one WARN
  per run (the `Research Fell Back?` IF, inline in the degradation path) naming the fallback model.

### 6. Invoke Model adopts the seam for BOTH modalities (supersedes the draft's "out of scope").
This is the operator's decision (2026-06-13), reversing the original draft's §6. `Invoke Model (v1)`
will route both its text path (`/v1/chat/completions`, `fallback_model = ResolveLowerTier(impact,
text)`) and its image path (`/v1/images/generations`, `fallback_model = ResolveLowerTier(impact,
image)`, `success_path = data.0.b64_json`) through the seam, so fallback always steps down within
the same modality. The image-unprocessable text-only retry (ADR-036 Block 6) is a *content
transform*, not a model swap, so it stays a downstream node reached via the text seam call's
both-down output. Image failure stays non-blocking (`success:false`, no CRITICAL); text both-down
routes to the text-only retry. This **amends ADR-037**: its hardcoded Opus fallback becomes the
top-tier special case of one-tier-below (only `Krytycznie ważne`/Fable still lands on Opus; lower
tiers step to the next-weaker tier).

### 7. Niski stays on Haiku (Gemini swap skipped).
The draft proposed swapping the `Niski` `text` row to a cheap Gemini alias (3.1 Flash-Lite / 3
Flash) for a cost win, gated on a format probe. The probe was run: Anthropic-format →
Gemini translation on `/v1/messages` **works** (well-formed Anthropic response). But the
recommended cheap aliases are **not provisioned in LiteLLM** (only `haxe-gemini-flash` =
gemini-3.5-flash, which the draft explicitly discourages on cost, and `haxe-gemini-pro`).
Provisioning a new alias is a `litellm-config.yaml` change + redeploy, beyond a data migration.
So the swap is **not taken**; `Niski` stays `haxe-haiku-4-5-direct`; no migration was created. A
future swap also needs to handle the Gemini-3.x thinking-budget gotcha (small `max_tokens` →
empty `content` with `stop_reason: max_tokens`).

### 8. Naming.
The generalized signal is `fell_back` and `model_used` (from the seam). `fell_back` is new in the
research path. The legacy `fell_back_to_opus` name exists only in Invoke Model and is renamed to
`fell_back` as part of Block B.

## Consequences

- The research CRITICAL is eliminated (research no longer runs flaky Fable; `Krytycznie ważne`
  research runs on Opus, one tier below) and every research call degrades gracefully via the
  one-tier-below fallback. Verified live: normal run on Opus (`fell_back=false`), forced fallback
  to Sonnet (`fell_back=true`, one WARN), both-down → one CRITICAL.
- One fallback mechanism (the seam), one tier rule (the helper), one cost writer (Log Model Run),
  reused by callers that keep their own shapes. No monolith, no mode flags.
- Research cost continues to be tracked (it always was), now attributed to the **served** model.
- The floor has no fallback: a `Niski`-model outage throws CRITICAL for research. Accepted.
  (Invoke Model keeps its `Retry Text-Only` Opus safety net, so its text floor degrades rather
  than CRITICALs — kept intentionally.)
- `REAL_TIERS` is now referenced in two Code nodes: the new `Resolve Lower Tier` (sole owner of the
  step-down) and Invoke Model's `Resolve Routing` (its own `__default__` guard). Accepted, bounded
  duplication (Invoke Model's copy is not the step-down owner).
- **Image top-tier fallback — resolved (operator, 2026-06-13): accept no top-tier image fallback.**
  `Wysoki` and `Krytycznie ważne` image both resolve to `openai/gpt-image-2`, so strict
  one-tier-below yields the same model at the top image tier (no real fallback). The operator chose
  to apply one-tier-below **uniformly** rather than add a per-modality floor-model special case: a
  top-tier image-model outage therefore produces `success:false` (image generation is non-blocking,
  never a CRITICAL), a mild, accepted regression vs today's hardcoded cross-provider
  `vertex_ai/gemini-2.5-flash-image` floor. Block B implements the seam with this rule (no floor
  concept in `Resolve Lower Tier`).

## Implementation status

- **Block A (landed, verified 2026-06-13):** `Resolve Lower Tier (v1)` and `Call Model with
  Fallback (v1)` built and tested; `decide-research-and-deliver` resolves via the helper and WARNs
  once on fallback; `research-the-web` calls the seam, records the served model, threads
  `fell_back`. Also fixed a **pre-existing** defect (present in pre-edit execs 1935, 1961):
  `Collect Research Results` returned empty `web_findings` because it is a multi-input
  "run once for all items" leaf where `$('Call Research the web').first()` failed to resolve; it now
  reads the research payload from its incoming item, so findings reach the caller.
- **Block B (landed, verified 2026-06-13):** `Invoke Model (v1)` now routes both modalities through
  the seam. Text: `Output Is Image?`(false) → `Resolve Lower Tier Text` → `Call Model Text` (seam,
  `/v1/chat/completions`, `success_path` empty); seam success → `Parse Response`, seam both-down throw
  → `Retry Text-Only` (Opus text-only safety net, kept). Image: `Output Is Image?`(true) → `Resolve
  Lower Tier Image` → `Lookup Fallback Image Prices` → `Call Model Image` (seam,
  `/v1/images/generations`, `success_path = data.0.b64_json`); seam success/both-down both → `Parse
  Image` (both-down → `succeeded:false`, non-blocking). The old `Call LiteLLM` + `Fallback to Opus`
  and `Call Image Gen` + `Fallback Image Gen` nodes were removed. `fell_back_to_opus` renamed to
  `fell_back` (Parse Response, Normalize Model Result, Check Degradation `d3`, Alert Degradation).
  Image cost layering keys the token-math/per-image-floor backups off the **served** model via the new
  `Lookup Fallback Image Prices` node (the live `x-litellm-response-cost` header stays authoritative);
  this avoided extending the Block A helper or hardcoding a drift-prone price map. Verified live across
  the ADR-036/037 surface: text normal (Średni→Sonnet, no alert); text forced fallback (Wysoki→Sonnet
  one-tier-below, Krytycznie ważne→Opus top-tier special case, one WARN each); text both-down no image
  → Retry Text-Only on Opus (one WARN); corrupt image both-down → image-unprocessable WARN, image
  dropped, text answer; image normal (gemini-3-pro-image-preview); image forced fallback
  (→gemini-2.5-flash-image, image_degraded, served-model prices applied); image both-down →
  `success:false`, **no CRITICAL**; served (fallback) model logged to `agent_runs`. Zero CRITICAL across
  the run. The Block A seam (`jBqu7znBIOMBF9HI`) and helper (`GNO6ZsIcSpvYUJDq`) were not modified.
  - **Not force-tested** (each exercises a path Block B did not change; could not be triggered without
    breaking infra/DB): a genuine non-image total failure CRITICAL (would need the Opus `Retry
    Text-Only` to also fail — unchanged, still no `onError` → throws → CRITICAL); the image 2xx-empty →
    `success_path` fallback (cannot make LiteLLM return a 2xx with no image; `success_path =
    data.0.b64_json` is wired and the predicate mechanism was proven in Block A); the routing-missing
    CRITICAL (needs a 0-row `model_routing` lookup; `Lookup Routing`/`Resolve Routing`/`Routing Missing?`
    are untouched). The image cost-header-missing WARN *did* fire live (on the failed-image test).

## References

ADR-037 (Fable→Opus fallback in Invoke Model — amended here), ADR-042 (impact tiers, `REAL_TIERS`),
ADR-036 (image path / Block 6 text-only retry — `Retry Text-Only` kept, now reached via the text seam's
both-down output), ADR-035 (Log Model Run, sole cost
writer), ADR-018 (build n8n via the MCP). Live evidence: executions 1868, 1910 (CRITICALs); 1935,
1961 (pre-existing empty-findings); Block A verification runs 1998 and the gold-price run
(2026-06-13).
