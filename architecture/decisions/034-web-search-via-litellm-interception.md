# ADR-034: Web search via LiteLLM interception (Tavily), uniform across routes

Date: 2026-06-09
Status: Accepted. Not yet deployed — gated on a `TAVILY_API_KEY` in the VPS `.env`
and a signed Tavily DPA (see Consequences).

## Context

Agents can only reason over what's already in the prompt (rules docs, task comments,
internal `Search (v1)` results — ADR-031). They have no access to current/public web
information: prices, vendor specs, current events, anything past the model's training
cutoff. We want web search in the pipeline.

Three facts shaped the design:

1. **Web search is a server-side *tool*, not a prompt.** You declare a `web_search`
   tool in the request; the model decides when to search; the search runs server-side
   and the model returns a final answer with citations — in a single response. This
   keeps the single-shot `Invoke Model` seam single-shot (ADR-013/022): no agentic
   tool loop is built in n8n.

2. **Anthropic's *native* web search does not run on Amazon Bedrock** (confirmed by
   Anthropic docs + AWS). Our `personal_data=true` tasks route to **Bedrock EU** for
   GDPR (ADR-002/024/030). So native search can't serve the GDPR route, and forcing
   those tasks onto the Anthropic-direct (US) endpoint would export the entire
   personal-data payload out of the EU — unacceptable.

3. **LiteLLM 1.87.0 ships a `websearch_interception` callback.** For providers listed
   in `enabled_providers`, LiteLLM detects the model's `web_search` tool-call, executes
   it server-side via a configured `search_tools` backend, and runs a follow-up call to
   synthesise the answer. This works on Bedrock (and every provider), independent of
   Anthropic's native tool. (Verified against the installed handler source, not docs.)

A hybrid (native on direct, interception on Bedrock) was considered and **rejected in
favour of uniform interception** — see Decision.

The remaining question was the search vendor. EU-residency-first was considered
(Linkup / self-hosted SearXNG). It was **relaxed to Tavily + DPA** because: under
interception the search vendor never sees the inference payload (that stays on Bedrock
EU) — only the **model-generated query string** reaches it. With no personal data in
the query there is no personal-data transfer; and because the *model* writes the query
(query hygiene is only soft-enforceable), a signed DPA/SCCs backstops the rare slip,
making it lawful processing rather than an unlawful transfer.

## Decision

1. **Enable `websearch_interception` uniformly.** `enabled_providers:
   ["bedrock","anthropic"]` — both tiers are intercepted. We do **not** use Anthropic's
   native web search. Rationale: one code path, one cost model, one response shape for
   the n8n parser, one vendor relationship/DPA, and no dependency on the Anthropic
   Console web-search toggle. The cost is comparable and we forgo only native dynamic
   filtering.

2. **Tavily is the search backend.** Single `search_tools` entry
   (`search_provider: tavily`, `api_key: os.environ/TAVILY_API_KEY`). Purpose-built for
   LLM/agent search (clean, token-efficient results).

3. **GDPR posture is unchanged by this ADR.** Inference + the personal-data payload for
   `personal_data=true` still stay on Bedrock EU (ADR-024/030). Only the model-generated
   query string egresses to Tavily (US). Query hygiene — no personal data in queries —
   is a **soft** control via the Global Agent Rules doc (the model writes the query);
   the **Tavily DPA/SCCs** is the hard backstop.

4. **Capability classification (reconciles with ADR-026).** `web_search` is a
   **read-only** capability, executed by deterministic infra (LiteLLM), returning
   public information. The model cannot choose the vendor, cannot reach Haxe/ClickUp
   state, and cannot mutate anything. It adds a *read* tool, never a *write* tool — the
   "drafts, never finalize / edits nothing" guarantee of ADR-026 holds. It does,
   however, supersede ADR-026's literal "the model stays tool-less" wording in a bounded
   way (see the dated update appended to ADR-026).

5. **Citations are surfaced to end users** in the posted ClickUp comment (a `Źródła`
   section), per Anthropic's citation-display guidance.

## Consequences

- **One uniform path** for search across both routes — simplest to build, test, and
  operate for a 5-person team. The n8n response parser handles a single result shape.
- **Forgone:** Anthropic's native dynamic filtering (a quality edge on complex
  research). Accepted.
- **Commercial-confidentiality concentration (accepted):** Tavily sees 100% of agent
  research queries (not just the Bedrock route's). This is a confidentiality, not a
  GDPR-personal-data, consideration. One DPA covers it.
- **New silent-degradation mode (must be covered — CLAUDE.md / ADR-025):** the web
  search tool returns HTTP 200 with an *embedded* error block
  (`too_many_requests`, `unavailable`, `max_uses_exceeded`, …) — the model then answers
  *without* search, lowering quality with no crash. An in-flow check fires a **WARN**
  via `Post Alert (v1)` when an error block is present. The reactive `Error Handler (v1)`
  layer covers thrown errors.
- **Cost:** Tavily per-search (~$5–8/1k) plus the search-result tokens fed back into the
  follow-up call. Capture web-search request counts in cost accounting so search-heavy
  runs don't under-report (`[AI] Koszt akcji [PLN]`).
- **Deployment (ADR-033 discipline):** `litellm-config.yaml` change takes effect only
  after `infrastructure/scripts/deploy-infra.bat` **and** `docker compose up -d litellm`
  (a `restart` does NOT reload config). Requires `TAVILY_API_KEY` in the VPS `.env`
  first. After recreation, verify `docker exec litellm env | grep TAVILY` and check
  `docker compose logs litellm` (a LiteLLM 429 can mask an upstream/config error).
- **Blocking pre-reqs before enabling:** (a) a Tavily account + API key in `.env`;
  (b) a signed Tavily DPA.

## Known limitation — single-round interception loop (LiteLLM 1.87.0)

LiteLLM 1.87.0's `websearch_interception` runs **one** search round + one synthesis
follow-up; its config exposes only `enabled_providers` and `search_tool_name` (no
loop-depth knob). When the model chains a *second* round of searches (common for
open-ended research — verified live on a "masażery" product query with Sonnet), the
response comes back `stop_reason: "tool_use"` with unexecuted `litellm_web_search`
calls and **no final text** → an empty answer.

Mitigations:
- **Safety (done):** the `Compute Cost` parser never emits an empty completion — on
  this case it surfaces a Polish note + the sources found and sets
  `web_search_error_code: "agentic_loop_incomplete"`, which fires the standard WARN
  (verified live: task `869dgrx41` got a non-empty comment; the Alerts task got the
  WARN).
- **Quality (recommended next):** steer the model in the Global Agent Rules doc to
  perform all needed searches in a single turn and then answer (avoid chaining
  rounds), and/or upgrade LiteLLM if a later release adds multi-round interception.

Single-round searches and non-search calls are unaffected (they end with a text
block and synthesize normally).

Related: ADR-013/022 (the tool-less invocation seam this extends), ADR-024/030
(LiteLLM gateway + provider routing this rides on), ADR-026 (capability containment —
bounded exception, see its dated update), ADR-025 (alerting seam for the degradation
WARN), ADR-031 (`Search (v1)` — internal search, complementary to web search),
ADR-033 (VPS deploy discipline).
