# Haxe Agents — Architecture (current)

Version: v23
Last updated: 2026-06-18
Supersedes: v22

This is the canonical description of the system being built. When it diverges
from what is actually implemented, that is a bug to fix immediately. Reasoning
behind individual decisions lives in `decisions/` (ADRs); this document
describes the system as it currently stands, not the history of how we got here.

---

## 1. Purpose

An internal, recursively self-improving multi-agent system for Haxe (legal
entity Skalus Sp. z o.o.). It automates routine knowledge work for a ~5-person
team — drafting product descriptions, supplier/customer email drafts, analysing
operational data — and improves its own processes over time by learning from how
humans edit and rate its output.

Design horizon: a system whose structure holds at 10 → 100 → 1000 people,
operating near economic optimality at every scale, self-reinforcing with minimal
senior-management intervention.

---

## 2. The five layers

1. **ClickUp** — source of truth for all operational knowledge. Process
   templates, agent personas, brand voice, rules, and the tasks the agents act
   on all live here. Humans work where they already work.

2. **n8n (self-hosted) + Redis** — orchestration and queue. Runs on an EU VPS
   (Cyberfolks, Poznań). n8n in queue mode: a main process handles webhooks, the
   UI, and scheduling; worker processes pull jobs from Redis and execute
   workflows. Redis provides rate-limiting, decoupling, priority, and retries.

3. **Anthropic Managed Agents (global)** — the live orchestration lane since 2026-06-22 (ADR-053,
   cutover Block 9). A hosted agent runtime — Anthropic-operated sandbox, tool loop, code execution,
   in-harness **web search**, and office-document **Skills** (docx/xlsx/pptx/pdf), with the **Files API**
   for input/output files. One lane, selected by **impact only**: a small set of agent definitions
   sharing `system`/tools/skills and differing only in model tier — Niski→Haiku, Średni→Sonnet,
   Wysoki→Opus, Krytycznie ważne→Opus (repointed from Fable 5, which is gated on the Managed Agents beta —
   ADR-053 amendment; reversible). Routing lives in the `agent_routing` table (impact → agent_id).
   **Residency dropped** (ADR-053): global Anthropic endpoint for all tasks incl. PII; basis is lawful
   processing (DPA/SCCs/DPF), not residency. **Image generation** runs via a self-hosted **MCP server**
   that wraps the existing n8n image lane (Vertex gemini-image + OpenAI gpt-image-2 — ADR-055). The
   **bare LiteLLM lane** (`(impact, modality)` PD-blind routing — Anthropic direct / Vertex Gemini, ADR-043)
   is **retained as the dormant outage failover** (text + image; web research retired), selected by the
   `config.agent_lane` flag (`managed` | `bare`, default `managed`; an unreadable flag fails safe to
   `bare` + WARN). ADR-054 (per-user permission-scoped ClickUp retrieval within the lane) is accepted and
   in progress — Block 1 scaffold (per-user credential store + onboarding) landed, not yet wired into
   sessions. See ADR-053/054/055, and the live summary after §3.

4. **Supabase (eu-west-1, Ireland)** — application database. Operational logs, threaded
   human feedback, process-change proposals, conversation session cache, email
   audit. (n8n's own internal database is a separate Postgres container on the
   VPS — not Supabase.)

5. **Personal layer** — Claude Max for the operator (Franciszek). Claude Code for
   execution/file work; chat for strategy. See §9.

```
┌────────────────────────────────────────────────────────────────┐
│  LAYER 1: ClickUp — Source of Truth for Everything Operational │
│  • Process templates, agent personas, brand voice, rules       │
│  • Custom fields for agent control (Czy dla AI, Ważność, …)   │
│  • Comments as conversation channel                            │
└────────────────────────────────────────────────────────────────┘
                              ↕
┌────────────────────────────────────────────────────────────────┐
│  LAYER 2: n8n + Redis on EU VPS — Orchestration + Queue        │
│  n8n main: webhooks, daily crons, session cleanup              │
│  n8n workers: queue consumers (10 concurrent executions)       │
│  Redis: priority queues, rate-limit tokens, retry schedule     │
└────────────────────────────────────────────────────────────────┘
                              ↕
┌────────────────────────────────────────────────────────────────┐
│  LAYER 3: Anthropic Managed Agents (global) — LIVE LANE        │
│  hosted runtime: sandbox, tool loop, web search, Skills, Files │
│  one lane, by impact: Haiku/Sonnet/Opus (Krytyczne→Opus)      │
│  image gen → self-hosted MCP → Vertex/OpenAI (ADR-055)        │
│  bare LiteLLM (impact,modality) = dormant failover (agent_lane)│
└────────────────────────────────────────────────────────────────┘
                              ↕
┌────────────────────────────────────────────────────────────────┐
│  LAYER 4: Supabase (eu-central-1) — Logs + Sessions + Learning │
│  agent_runs, agent_run_evaluations                             │
│  agent_proposals, agent_proposal_evaluations                   │
│  conversation_sessions, email_sends, schema_migrations         │
└────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────┐
│  LAYER 5: Personal (parallel)                                  │
│  Claude Max: strategy / design / research                      │
│  Claude Code: execution / file work / commands                 │
└────────────────────────────────────────────────────────────────┘
```

---

## Core model — one generic pipeline (no per-process agents)

There is exactly ONE agent mechanism, built once in n8n. No per-process, per-task, or per-stage agents. Innate behaviour, identical for every process and person:

1. Trigger — autonomous (ClickUp status/field webhooks + the daily due-date scan, gated by `Czy dla AI`) or explicit pull (@-mention / ~command on a ClickUp task). Both modes are retained; see §3 for the full invocation taxonomy and caller-scoping. (Build order: the Phase 2 spine exercises the pull path first; autonomous triggering follows immediately, Phase 3.)
2. Read ClickUp via universal conventions: task description = checklist of steps; linked doc leaves = detailed/paste-ready guidance; parent chain = context (materials in parent; spec in parent's description; verification in the verification subtask).
3. Read two config inputs (also data, not code): the GLOBAL agent-rules doc (red-team, quality-first, never-invent-specs, self-critique against the task's leaf checklist, conventions, brand non-negotiables) and the invoking PERSON's agent-preferences doc.
4. Assemble → invoke model (routed by importance/sensitivity via the centralized model-invocation sub-workflow).
5. Post output back to ClickUp (material in parent; draft as comment; @-mention reviewer). Never auto-finalize.

All task-specific behaviour is DATA in ClickUp (checklist-in-description + doc leaves); n8n holds only the generic procedure + conventions. A named ~command is data in the same spirit: n8n keeps a command registry (`command_name` → ClickUp prompt-doc link/ID, plus optional metadata) and loads the command's prompt from its ClickUp doc at runtime — never hardcoded in n8n. Adding a capability = authoring a ClickUp checklist + leaf (and, for a named command, one registry row), not writing an agent. This is what scales to every process/person and to 10→100→1000 people with no per-process engineering. KM self-sufficiency is enforced intrinsically (the model sees only ClickUp), and the pipeline's genericity DEPENDS on structural discipline — which is why gap-detection is load-bearing. See the generic-pipeline ADR (ADR-015).

---

## 3. Invocation model

The agent is one generic pipeline (see Core model above), not a set of per-process
personas. Process-specific behaviour comes from ClickUp data; a named `~command`
resolves its prompt from a ClickUp doc via the command registry rather than from a
hardcoded persona. The same single mechanism serves every process and person.

- **Autonomous** invocations (webhooks, daily due-date producer) run only when
  the task's `Czy dla AI` field = `Tak`.
- **Explicit** invocations always work regardless of `Czy dla AI`:
  - `@`-mention of the agent (natural language) → `explicit_mention`
  - `~command` syntax (specific skill) → `explicit_command`
- **Conversation replies** continue an existing session.

Permissions are caller-scoped at two layers: prompt-level (Layer A) and the n8n
MCP gateway (Layer B). An invocation runs with the narrowed permissions of its
effective caller.

Output generation uses a single comprehensive prompt with internal critique
(not a multi-call Builder/Critic/Synthesizer loop), followed by a deterministic
Formatter skill for output structure.

For **due-date triggered** autonomous runs, caller is determined as:
1. Task assignee (primary)
2. Task creator (fallback)
3. Neither present → skip, log to Agent Errors

---

## Extension seams (reserved now, implementation deferred)

Two future capabilities are designed-for but NOT built. Seams are preserved so
they slot in additively. See the corresponding ADRs.

> **Note (2026-06-22):** the bare-lane seams below (`Invoke Model (v1)`, `model_routing`, the fallback
> seam) are no longer the hot path — they now power the **dormant failover lane** selected by
> `config.agent_lane='bare'`. The live default is the Managed Agents lane (see "Managed Agents spine —
> LIVE" after this section). They remain LIVE in the sense that they still work when the lane is selected.

- **Multi-provider routing (failover lane; PD-blind).** Model invocation is centralized behind
  `Invoke Model (v1)`; routing is data-driven via `model_routing (impact, modality)` — capability +
  modality only, no `personal_data`/EU axis (ADR-043, migration 021). `modality='text'` → Anthropic
  direct; `modality='multimodal_input'` → Vertex AI Gemini (flash/pro by tier, ADR-042); `modality='image'`
  → image-gen tiers. The `PD Verifier (v1)` seam was removed in Block 2 and the `personal_data`/`eu_only`
  columns + Bedrock-EU rows were dropped in **Block 3** (migration 021); the table collapsed to one row per
  `(impact, modality)`. Fail-safe preserved: DB-down falls back to `haxe-sonnet-4-6-direct` + WARN.

- **Unified model fallback seam (ADR-047; research + Invoke Model both LIVE 2026-06-13).** Fallback for any model is the
  model **one impact tier below, within the same modality**, derived from `REAL_TIERS =
  ['Niski','Średni','Wysoki','Krytycznie ważne']` — no `fallback_model` column (it would duplicate the
  tiering). Two new shared sub-workflows: `Resolve Lower Tier (v1)` (`GNO6ZsIcSpvYUJDq`, sole owner of the
  step-down) and `Call Model with Fallback (v1)` (`jBqu7znBIOMBF9HI`, a shape-agnostic try-primary-then-fallback
  mechanism with an optional `success_path` payload predicate; returns `{fell_back, model_used, body, headers}`;
  both-down throws → one CRITICAL). **Research** (`research-the-web`) now calls the seam on `/v1/messages` with
  `fallback_model = ResolveLowerTier(task_impact)` (so `Krytycznie ważne` research runs on Opus, not flaky
  Fable — fixes the intermittent research CRITICAL of execs 1868/1910); `decide-research` resolves the two
  research models via the helper and WARNs once if a round fell back; research keeps its leaf-based cost
  logging (ADR-035) but now prices each round against the **served** model. Also fixed a pre-existing defect:
  `Collect Research Results` (a multi-input leaf) was dropping `web_findings`; it now reads the research payload
  from its incoming item, so findings reach the caller. `Niski` stays on Haiku (the cheap-Gemini swap in the
  ADR was not taken — alias not provisioned in LiteLLM). **Invoke Model (ADR-047 Block B, LIVE 2026-06-13):**
  `Invoke Model (v1)` now routes **both** paths through the seam. Text → `Resolve Lower Tier Text` →
  `Call Model Text` (seam, `/v1/chat/completions`, `success_path` empty); on both-down the seam throws and the
  existing `Retry Text-Only` (Opus, images stripped) catches it as the floor safety net. Image → `Resolve Lower
  Tier Image` → `Lookup Fallback Image Prices` → `Call Model Image` (seam, `/v1/images/generations`,
  `success_path = data.0.b64_json` so a 2xx-with-no-image triggers fallback); both-down → `success:false`
  (image stays non-blocking, never a CRITICAL). This **amends ADR-037**: its hardcoded Opus fallback is now the
  top-tier case of one-tier-below (only `Krytycznie ważne`/Fable still lands on Opus). `fell_back_to_opus` was
  renamed to `fell_back` throughout. Image cost layering keys the token-math/per-image-floor backups off the
  **served** model (`Lookup Fallback Image Prices`), with the live cost header still authoritative. Resolved open
  item: `Wysoki` and `Krytycznie ważne` image both resolve to `gpt-image-2`, so one-tier-below gives no real image
  fallback at the top tier — accepted (a top-tier image-model outage yields `success:false`, non-blocking).

- **Multimodal I/O (input + image-gen pipelines LIVE, ADR-036/038/040).** Image attachments from ClickUp
  tasks pass as vision content blocks to the model; Docling extracts text from non-image files
  (PDF/DOCX/XLSX) into the prompt — a PDF therefore routes as `modality='text'` → Claude. Image *input*
  (`modality='multimodal_input'`) routes to **Vertex AI Gemini** for all tasks (the active multimodal
  route — flash for n/d/Niski/Średni, pro for Wysoki/Krytycznie; ADR-043 operator decision + ADR-042).
  Image *generation* providers provisioned & verified live (Block 8, ADR-036, migration 023):
  Niski/__default__ → Vertex `gemini-2.5-flash-image` (Nano Banana), Średni → `gemini-3-pro-image-preview`
  (Nano Banana Pro), Wysoki/Krytycznie → OpenAI `gpt-image-2`. The generation *pipeline* (invoke-image-model,
  resolver, comment_native delivery) is Phase B / Blocks 9–12 — **LIVE** (Phase B / Blocks 9–12 COMPLETE, 2026-06-13): generation folded into `Invoke Model (v1)`,
  `Image Resolver (v1)` walks the drafting model's output-block list (text / `embed_input` / `generate`), and
  Stage C delivers in-memory base64 images inline in the ClickUp comment. Every task now emits the block
  contract (full unification, Block 12); `embed_input` lets the agent place existing attachments inline.

---

## Managed Agents spine — LIVE (ADR-053 / ADR-055; cutover Block 9, 2026-06-22)

The agent system runs all tasks through **Anthropic Managed Agents** as the single orchestration lane
(hosted sandbox, tool loop, code execution, in-harness web search, office-document Skills, Files API).
The orchestrator selects Stage B by the **`config.agent_lane`** flag (`managed` | `bare`, default
**`managed`**; an unreadable/invalid flag fails safe to `bare` + a WARN). The bare LiteLLM lane
(`Execute LLM Call (v1)` + `Image Resolver (v1)`) is retained as the **dormant outage failover** (text +
image only — web research is in-harness now).

**Routing — impact → agent** (`agent_routing` table): Niski→Haiku, Średni→Sonnet, Wysoki→Opus,
**Krytycznie ważne→Opus** (repointed from Fable 5, which is gated behind Anthropic's "Fable Mythos" beta
access — the provider error directs callers to Opus 4.8; reversible when access is granted — ADR-053
amendment). Tools and skills are universal; a mis-set impact degrades to a wrong tier, not a missing
capability.

**Stage B (managed):** `Execute Agent Session (v1)` (resolve tier agent + persistent environment, upload
input images to the Files API, create/send the session, poll to idle, service the client-side custom-tool
loop — retained for ADR-054's future Google tool, dormant for image — and compute the session USD cost) →
`Render Agent Output (v1)` (parse the agent's fenced block-array → `rendered_delta` + `image_manifest`,
fetching produced-image bytes from the `agent-output-images` carrier) → `Post Reply (v1)` (text + inline
images + office-doc attachments). **Image generation** runs via the self-hosted **image MCP server**
(ADR-055: `Haxe Image MCP (v1)` → `Image MCP Tool Handler (v1)` → `Image Tool Handler (v1)` → `Generate
Images Parallel (v1)`); the client-side `generate_image` custom tool is the documented rollback.

**Verified live across modalities** (Block 9): text, web research (in-harness, no n8n research workflows),
image generation (MCP → carrier → inline ClickUp image), image input / vision (Files API), and
office-document output (xlsx via a Skill → ClickUp attachment, attachment id recorded on `agent_runs`). One
session `agent_runs` cost row per run (plus per-image rows); `Log Model Run (v1)` keeps sole FX/PLN
ownership. The output adapter repairs models' common JSON defects (unescaped control characters **and**
unescaped double-quotes inside the block-array's string values — the latter via a structural lookahead)
before any plain-text fallback, and supports `embed_input` (re-embedding an image already attached to the
task) by resolving the agent's attachment ref against the input image refs into a `{type:attachment}` op
inline — no re-upload, mirroring the bare lane's `Image Resolver`.

**Reliability:** an auth dead-man's-switch (`Managed Agents Auth Monitor (v1)`), the CU-rules sync +
freshness dead-man's-switch (`Sync Agent Definitions (v1)` / `Agent Rules Freshness Check (v1)`), and the
image-MCP health monitor (`Image MCP Health Monitor (v1)`), all every 6h via `Post Alert (v1)`.

**ADR-054 — permission-scoped context retrieval (accepted; in progress — ClickUp-only, Block 1 scaffold
landed).** The direction: the managed agent gathers context **under the triggering user's identity, enforced
by n8n at the executor** (scope lives in the credential, never trusted to the agent). This build is **scoped
to ClickUp only** (operator decision 2026-06-22); Google (Drive + Gmail) is deferred to a follow-up ADR.
Each member's own ClickUp OAuth access token is held as a `static_bearer` credential in a **per-user**
Anthropic Vault (one vault per user — credentials are keyed by `mcp_server_url`, so same-URL creds can't
share a vault), and a session attaches only the triggering user's vault, scoping every ClickUp MCP call to
what that human can see. **Built so far (Block 1, not yet wired into sessions):** the credential store —
`user_clickup_credentials` (migration 039, RLS-enabled), the OAuth app-secret getter `get_clickup_oauth_app()`
(migration 040), and the consent/onboarding tool `scripts/onboard-clickup-user.mjs`. ClickUp OAuth tokens
don't expire (no refresh machinery). **Still bot-token-only in production** until session binding (Block 2),
scoped MCP discovery + retiring the `Check Space Member` software filter (Block 3), and the as-U REST
extraction tool (Block 4) land. Scope-correctness testing (Block 5) is its mandatory acceptance gate.

Per-block build history: `architecture/Build plans/adr-053-managed-agents/` (`master-plan.md` +
`block-*-findings.md`).

## 4. The learning system

Two parallel feedback systems with identical machinery, different subject:

### 4.1 Artifacts (Tier 0)
- `agent_runs` — one row per agent execution (context, trigger, model, cost, status).
  Also the **erasure hub** (ADR-044, migration 022): nullable `subject_key` (the
  channel-natural counterparty id, populated only once the email channel is wired),
  `clickup_comment_id` (the id of the comment the run posted — recorded live by
  Post-back's `Record Artifact`), and a reserved `drive_file_id`. Nothing reads
  `subject_key` yet; the schema is ready at zero behavioral cost.
  **Observability (migration 025, ADR-036 Block 10):** nullable `run_payload_bytes` (UTF-8 byte
  size of the delivered payload — rendered comment + any image base64 — written once per delivering
  run by `Record Artifact`, for text and image runs alike; a **proxy + lower bound** for n8n
  execution-data weight, true ≈ this × nodes traversed; null if the run failed before delivery) and
  `n8n_execution_id` (the run's n8n execution id, for exact-size backfill + run→execution debugging).
- `agent_run_evaluations` — append-only threaded human feedback on a given
  output. Each row = one timestamped contribution carrying an optional thumbs
  rating and/or comment. Same user may appear many times; current stance = their
  most recent row. The GM agent's verdicts appear here too (commenter
  `gm_agent`).

### 4.2 Proposals (Tier 1+)
- `agent_proposals` — structured process-change proposals. Self-referencing to
  support recursive tiers:
  - **Tier 1 (`artifact`)** — synthesizes `agent_run_evaluations`; sets
    `source_agent_run_id`.
  - **Tier 2+ (`meta`)** — synthesizes other proposals' evaluations; sets
    `source_proposal_id` (self-reference). Depth is unbounded.
  - Broad synthesis (many sources, no single parent) — both FKs null;
    `proposal_tier` still records the kind.
- `agent_proposal_evaluations` — append-only threaded human feedback on a
  proposal. Same shape as `agent_run_evaluations`.

### 4.3 What is NOT stored (derived instead)
- **Acceptance status** — there is no `evaluation_status` column. Whether a
  proposal was accepted/rejected/contested is derived by the GM agent from the
  evaluation thread at analysis time. The GM agent records its verdict as a
  `gm_agent` row in the thread, so its decision is part of the same record it
  analyses (enabling recursive self-reflection on its own past calls).
- **Application tracking** — there is no `applied` column. Implementing an
  accepted change leaves no trace in any thread and would require unreliable
  manual marking; an unmaintained status field misleads. Failure to implement
  surfaces naturally as recurring patterns in artifact evaluations (a culture
  signal, not a schema concern).

### 4.4 Activation policy
The schema permits unbounded recursion; the workflow gates it. Tier-1 proposing
runs on the weekly cadence (manual per-task proposing via `~zaproponuj-zmiane-procesu`
only). Meta-analysis (Tier 2) runs monthly/quarterly once enough Tier-1 volume
exists. Tier 3+ is rare and human-triggered. This avoids navel-gazing
("turtles all the way up").

---

## KM maintenance — human-only edits; AI proposes, monitors, nudges

A chief goal of the system is to monitor and maintain the quality and scope of the internal KM system (docs cascade with paste-ready leaves + Why-toggles; templates with checklist-in-description + doc-links + self-links; rules). AI never edits the KM system — humans are the sole writers; AI is proposer + monitor + nudger only (preserves ownership, deliberate friction, anti-bloat).

Loop: (1) exercise — every run consumes leaves; heavy correction ⟺ deficient leaf; (2) propose — runs/evaluator emit Tier-1/2/3 proposals into Supabase; (3) human curates + implements the leaf edit themselves; (4) measure implementation — a logs column records whether a doc/description edit occurred within ~20–60 min of acceptance, and (conditionally) whether it corresponds to the accepted proposal (lightweight-model diff-compare IF the ClickUp API exposes diffs; else timestamp-only); (5) nudge — the evaluator/GM agent surfaces accepted-but-unimplemented proposals + gap-audit findings. Gap-detection: a periodic KM-audit flags missing Why-toggles, dead/empty links, undocumented processes, stale leaves — proposes, never fixes. Why-toggles are a Chesterton's-fence guardrail, required on contested/judgment rules.

Abandoned: AI write-back to docs; self-sufficiency as a separate probe; compounding-by-correlation (insufficient n). This whole layer is DEFERRED until the generic pipeline is proven end-to-end. See ADR-016.

---

## 5. Database

Supabase (eu-west-1, Ireland). Seven live tables, plus two added by migrations 002/003
(decided in ADR-024, **applied 2026-06-03**). Authoritative DDL: `supabase/migrations/`.
Note: architecture originally specified eu-central-1 (Frankfurt); the live project is
eu-west-1 (Ireland). Both are EU/GDPR-compliant; this is a documentation correction, not
a data location change.

- `agent_runs`, `agent_run_evaluations`
- `agent_proposals`, `agent_proposal_evaluations`
- `conversation_sessions` (mutable working state; expired, not deleted, after 24h idle)
- `email_sends` (Gmail audit)
- `schema_migrations`
- `model_routing` (migration 002, ADR-024) — data-driven routing: impact → LiteLLM
  model alias + temperature + max_tokens + nudge + USD token prices; a `__default__`
  row is the fail-safe. Replaces the in-n8n routing table of ADR-023.
- `fx_rates` (migration 003, ADR-024) — daily USD/PLN from the NBP Web API (official
  Polish rate); `cost_pln = usd_cost × latest fx`. Token counts come exact from the
  LiteLLM gateway.

> Repo gap (ADR-024): `001_initial_schema.sql` is applied to the live DB but was
> never committed (only `.gitkeep`). It must be back-filled from the live schema so
> `supabase/migrations/` reflects reality.

> Migration `004_agent_runs_importance_check.sql` (2026-06-08, **applied**) realigns the
> `agent_runs.importance` CHECK from the stale English `Low/Medium/High` set to the live
> 5-level Polish taxonomy. Before it, a run on a real impact tier failed the `agent_runs`
> insert (run still returned + WARN, but cost wasn't logged) — found via fault injection;
> now fixed.

> Migrations `005` (rename `agent_runs.importance` → `impact`, **applied**) and `007`
> (enable RLS on all 9 tables, no policies, **applied** — ADR-028) landed 2026-06-08.
> RLS closes the PostgREST "Unrestricted" exposure; the pipeline's `postgres` role bypasses
> RLS so it's unaffected (verified). `agent_runs` now also populates `caller_user_id` and
> `process_type`.

> Migration `008_model_routing_composite.sql` (2026-06-08, **applied**) restructures
> `model_routing` to a composite PK `(impact, personal_data)` and seeds all 12 routing
> rows: 6 impact tiers × 2 `personal_data` values (`false` → Anthropic direct,
> `true` → Bedrock EU). Versioned aliases replace the old unversioned names (ADR-030).

> Migration `009_triggered_by_search_step.sql` (2026-06-08, **applied**) adds
> `search_step` to the `agent_runs.triggered_by` CHECK (ADR-031).

> Migration `010_model_routing_nullable_temperature.sql` (**applied**) allows NULL `temperature` for
> models that don't support the parameter. Sets `temperature=null` for `haxe-opus-4-8-direct`
> (Opus 4.8 deprecated the parameter 2026-06-08).

> Migration `011_research_parameters.sql` (**applied**, ADR-035) adds the `research_parameters` table
> keyed by `impact`: `max_research_rounds` and `tavily_max_results` knobs for the agentic web-search
> loop (Model Turn v1). Separate from `model_routing` — research effort scales with importance only,
> not GDPR routing.

> Migrations `012_multimodal_image_tiers.sql` then `013_image_tiers_match_clickup.sql` (**applied in that
> order**, ADR-036): extend `model_routing` with `modality`, `eu_only`, `fallback_price_per_unit` columns;
> add `image_gen_params` and `config` tables; seed image generation routes (Stability/Vertex AI/DALL-E 3
> tiers). Migration 013 promotes the PK to `(impact, personal_data, modality)`, rekeys image rows from
> English to Polish impact names (was `low/medium/high`, now matches ClickUp field values), and adds
> `Krytycznie ważne` and `__default__` image rows. Also adds `image_gen` to `agent_runs.triggered_by`.

> ⚠ **Migration naming conflict:** Two files share the `013_` prefix (`013_gemini_multimodal_routing.sql`
> and `013_image_tiers_match_clickup.sql`), produced in separate build sessions. The `013_image_tiers…`
> file is the one applied above. The `013_gemini_multimodal_routing.sql` file must be **renamed to
> `014_gemini_multimodal_routing.sql`** before application — see below.

> Migration `014_gemini_multimodal_routing.sql` (pending rename + application; ADR-038): drops the
> `(impact, modality)` partial unique index (`model_routing_impact_modality_key`) and recreates it as
> `model_routing_non_text_unique` on `(impact, modality, personal_data) WHERE modality != 'text'`; seeds
> 8 `multimodal_input` rows — 4 GDPR (Gemini EU, `personal_data=true`) + 4 non-GDPR (Anthropic direct,
> `personal_data=false`). Apply AFTER `013_image_tiers_match_clickup.sql`.

> **Block 1 — repo↔live re-sync + targeted fixes (2026-06-11, ADR-043/044).** The repo
> `n8n/workflows/*.json` were re-baselined against the running graph (ADR-038's multimodal deploy had
> never been exported). Drift was **bidirectional** — see `architecture/workflow-repo-live-reconciliation.md`
> for the per-workflow tracker (what is reconciled vs deferred to Block 2). Behaviour changes landed this
> block (not behaviour-neutral): **(1)** invoke-model fix-forward — multimodal request now built as a
> `messages` content-array in Resolve Routing and reused by the Opus fallback, so **images are preserved
> on fallback** (live previously dropped them); modality routing + a Gemini provider label retained.
> **(2)** execute-llm-call return path made a single branch-free terminal (`Return LLM Result` sole leaf;
> cost-sync funnels into it) — fixes a non-deterministic sub-workflow return that intermittently dropped
> the answer and posted no reply. **(3)** Data hotfix: `model_routing` `temperature` set NULL for the
> `Krytycznie ważne` × `multimodal_input` Fable 5 row (Fable 5 now rejects `temperature` → 400); the
> `text` row was already NULL. Codified as **migration `015_fable5_multimodal_temperature_null.sql`**
> (so the migrations stay the source of truth, not a forward-note); Block 3's routing migration (landed as
> `021`) preserved `temperature = NULL` for that row (the `text` Fable 5 row survives; the `multimodal_input`
> Fable 5 row was replaced by Gemini Pro). The `personal_data`/EU apparatus removal itself is
> still pending (Blocks 2–3).

> **Block 2 — strip PD plumbing, behaviour-neutral (2026-06-11, ADR-043).** The `PD Verifier (v1)`
> sub-workflow (`hzwmak7UBpuHaiTO`) was **deleted** (workflow + repo file), and `personal_data` is no
> longer threaded through context assembly, workspace search, or the research gate: removed from
> `assemble-context` (the `Call PD Verifier` node + rewire `Context Gather → Workspace Search`, the
> `personal_data` mappings to Search/Decide-Research, the `personal_data`/`pd_verifier_ok` outputs of
> `Build Prompt`, the `r4` rule + `pd_verifier=` token of the context-health check), `workspace-search`
> (input + both Invoke-Model mappings), `decide-research` (input, gate `model_override` and research
> fallback hard-set to the non-PD `-direct` aliases, gate mapping), `execute-llm-call` and
> `agent-orchestrator` (the `personal_data` passthrough). `fable-access-monitor`'s runbook SQL dropped
> `AND personal_data=false`. **Behaviour-neutral:** the PD verifier was a stub always returning `false`,
> and every surviving consumer that still sees `personal_data` (Invoke Model's `Lookup Routing`, decide-
> research's `Lookup Research Routing`) guards with `=== true`, so an absent value resolves to `false` =
> today's routing. **Deliberately left for Block 3:** the routing-row selection itself — `Invoke Model`
> and `Lookup Research Routing` still carry `personal_data = $2` in SQL (inert; resolves `false`), and the
> `model_routing` `personal_data`/`eu_only` columns + Gemini-EU rows remain. Verified end-to-end: a
> `multimodal_input` smoke task routed unchanged to `haxe-gemini-flash-eu`, vision intact, reply posted,
> no `personal_data`/`pd_verifier_ok` in the Build-Prompt output, no alerts. Re-exported all six edited
> workflows; `check-workflow-drift.mjs` reports all 17 match live (assemble-context + agent-orchestrator
> reconciled — they already carried the ADR-038 context-health/modality work).

> **Block 3 — routing cutover to PD-blind global (2026-06-11, ADR-043/042).** `model_routing` collapsed
> to one row per `(impact, modality)` via migration `021_global_model_routing.sql`: dropped the Bedrock-EU
> `text` rows and the Claude `multimodal_input` rows, **kept Gemini as the active multimodal route**
> (operator decision — this *inverts* ADR-043's original "keep Claude, Gemini stays dormant" line; see the
> ADR-043 Update note), renamed the Gemini aliases `-eu`→none (now global, not EU-pinned), re-keyed the PK
> `(impact, personal_data, modality)` → `(impact, modality)`, and dropped the `personal_data`/`eu_only`
> columns + the now-redundant `model_routing_non_text_unique` index. Result: 16 rows — 6 `text` (Claude
> direct), 5 `image` (gen tiers), 5 `multimodal_input` (Gemini flash×3 / pro×2 per ADR-042). Workflows made
> PD-blind: `Invoke Model` (`Lookup Routing` filter + queryReplacement, `Fallback to Opus`/`fbAlias` →
> literal `haxe-opus-4-8-direct`, provider/price logic, `When Called` input) and `decide-research`
> (`Lookup Research Routing`). LiteLLM deployed in **two passes** for a zero-gap cutover: (1) additive — new
> `haxe-gemini-flash`/`-pro` aliases added alongside the `-eu` ones; (2) after the migration repointed the
> rows — cleanup removing the `-eu` Gemini aliases + the three `*-bedrock` aliases. Verified: the live
> PD-blind query returns exactly one correct row per `(impact, modality)` across all tiers; an image smoke
> (task 869dm1z8y) routed to `haxe-gemini-flash`, vision correct, threaded reply posted, no degradation,
> zero alerts on the clean run. Bedrock EU is now unused (AWS creds in `.env` are dead — a deployment
> cleanup, intentionally not done here).

> **Block 4 — erasure schema readiness + artifact recording (2026-06-11, ADR-044).** Migration
> `022_agent_runs_erasure_ready.sql` adds three nullable `text` columns to `agent_runs` —
> `subject_key` (partial-indexed `where subject_key is not null`), `clickup_comment_id`,
> `drive_file_id` — making `agent_runs` the **erasure hub** at zero behavioral risk (nothing reads
> or writes `subject_key`/`drive_file_id`; the pipeline stays PD-blind). `Post Reply (v1)` gains a
> `Record Artifact` Postgres node on a **side branch off `Set Status Zakończono` success**: it writes
> the just-posted ClickUp comment id onto the task's latest `agent_runs` row (`order by id desc`),
> via a CTE that always returns one row (`target_id`, `updated 0/1`) so a 0-row write is detectable,
> not a silent drop → `Recorded?` IF fires a WARN (`post-reply/record-artifact`) on miss/error. The
> WARN posts to the Alerts task (disjoint from the answer task → no webhook loop) and never blocks
> reply/status. Referential audit (report-only, no FKs/cascades added): PD-capable stores either FK
> `agent_runs` (`email_sends.agent_run_id` **nullable, no cascade**; `agent_run_evaluations` **ON
> DELETE CASCADE**; `agent_proposals.source_agent_run_id` nullable; `agent_proposal_evaluations`
> transitive) or — `conversation_sessions` — link only by `clickup_task_id`/`comment_root_id` text
> (**no FK back**). Retention + lawful-basis posture is recorded in `compliance/gdpr-processing-decisions.md`.

> **Block 8 — image-gen providers refreshed (2026-06-12, ADR-036).** Migration
> `023_image_gen_block8_providers.sql` repoints the five `modality='image'` rows off the dated/dead seeds
> (SD3.5 / Imagen@006 / dall-e-3 — Imagen shutting down ~2026-06-24, dall-e-3 deprecated) to the live map:
> Niski/__default__ → `vertex_ai/gemini-2.5-flash-image`, Średni → `vertex_ai/gemini-3-pro-image-preview`,
> Wysoki/Krytycznie → `openai/gpt-image-2`; and sets a static `fallback_price_per_unit` floor per row
> (0.038703 / 0.134422 / 0.210805 USD, live-measured). PK/columns unchanged (no `personal_data`/`eu_only`).
> All three verified live through the LiteLLM gateway with accurate cost headers. The generation *pipeline*
> (Blocks 9–12) is still unbuilt — these rows have no caller yet.

> **Block 9 — image token prices filled (2026-06-12, ADR-036/045).** Migration `024_image_token_prices.sql`
> UPDATEs the five `modality='image'` rows' `price_out_usd_per_1k` (flash 0.030 / pro 0.120 / gpt-image-2
> 0.030 — each = Block 8's measured cost ÷ output tokens) + a small `price_in` backup, so the **shared cost
> path (Log Model Run) prices an image by token-math identically to text** when the live header is absent
> (header still primary; `fallback_price_per_unit` is the last-resort floor). PK/columns unchanged. This is
> the data half of Block 9, which folded image generation into `Invoke Model (v1)` as an output modality
> (see §15.4); the rows now have a caller. Migration 023's "Blocks 9–12 unbuilt / no caller" note is
> superseded for Block 9.

> **Block 10 — `agent_runs` payload-weight observability (2026-06-12, ADR-036).** Migration
> `025_agent_runs_payload_bytes.sql` adds two nullable columns to `agent_runs`: `run_payload_bytes`
> (bigint — UTF-8 byte size of the delivered payload, rendered comment + any image base64; a proxy +
> lower bound for n8n execution-data weight) and `n8n_execution_id` (text). Written once per delivering
> run by Post Reply's `Record Artifact` (no new writer). Additive, nullable; PK/columns otherwise
> unchanged; PD-blind. Supports the Block-10 in-memory base64 delivery pivot (see §15.6) — base64 rides
> n8n execution data, so per-run weight is now observable.

Principles: store facts, never derivations; constrain (CHECK) where downstream
automation depends on consistency, leave free-form where only semantic meaning
is needed; append-only threaded feedback with "current stance" derived via
`DISTINCT ON`.

`agent_runs` carries trigger attribution and queue tracking:

```sql
triggered_by TEXT CHECK (triggered_by IN (
  'webhook_status_change', 'webhook_field_change',
  'due_date_daily', 'gmail_incoming', 'gmail_sent_analysis',
  'weekly_proposer', 'per_task_proposer',
  'explicit_mention', 'explicit_command',
  'conversation_reply', 'reset_restart',
  'search_step'
)),
invocation_type TEXT CHECK (invocation_type IN (
  'autonomous', 'explicit', 'conversation_reply'
)),
queue_priority  INTEGER,
queue_wait_ms   INTEGER,
retry_attempt   INTEGER DEFAULT 0
```

These enable: what % of work is proactive (`due_date_daily`) vs reactive (webhook)
vs explicit? Do explicit invocations produce higher satisfaction ratings? Where
do retries cluster?

---

## 6. Email

Gmail-native. The agent creates Gmail **drafts**; a human reviews and sends. No
autonomous sending. `email_sends` records the audit trail (draft_created / sent /
discarded), linked to the originating `agent_run`.

---

## 7. Conversation sessions

Multi-turn agent conversations cache their base context (task hierarchy +
relevant CU content) in `conversation_sessions` to avoid recomputing it each
turn. At most one active session per (task, comment thread, caller), enforced by
a partial unique index. Sessions expire after 24h inactivity, on `~zresetuj-sesje`,
or on significant underlying data change.

---

## 8. Skills (invocable commands)

Each named `~command` maps to a ClickUp doc that holds its prompt; the prompt content
lives in CU Docs (version-controlled mirror under `skills/`), never hardcoded in n8n.
n8n holds a **command registry** — a table keyed by `command_name` → CU prompt-doc
link/ID, plus optional metadata — which the generic pipeline reads at runtime to load
the right prompt. Adding a command = author the CU doc + add one registry row: data,
not code (see ADR-015). There is no per-command agent and no hardcoded persona-dispatch.

| Skill | Type | Description | Human gate |
|---|---|---|---|
| `~wykonaj-zadanie` | Agent | Main orchestrator: single Claude call (draft+critique+synthesize internally) → Formatter applies output structure | None — output is suggestion in comment |
| `~napisz-maila` | Agent | Email orchestrator: single Claude call → Formatter → Gmail Draft | Gmail's send button |
| `~stwórz-zadanie` | Agent | Proposes structured task creation | 👍 reaction required |
| `~zaproponuj-zmianę-procesu` | Agent | Per-task or weekly: proposer posts structured proposal | IC reaction → org reaction |
| `~zresetuj-sesję` | Operational | Expire sessions, archive, restart | None (already explicit) |
| **Formatter** | **Deterministic** | Post-processing: parse model output, apply markdown structure, add metadata, validate schema | None |

The Formatter runs after every Claude call with no AI involvement — pure parsing
and template application. Rules live in the `Formatter Skill` doc in CU; each
`process_type` can have its own formatting variant (NPD uses product-spec
structure, emails use 6-section format, etc.).

---

## 9. Operator workflow (chat vs Claude Code)

- **Chat (Opus):** strategy, design deliberation, web research, decisions.
- **Claude Code (Opus):** execution, file/repo work, running commands. Also the
  **n8n builder** — it creates, validates, and deploys workflows directly via the
  n8n MCP server (REST API control plane), with the operator inspecting/correcting
  rather than doing the mechanical wiring. See ADR-018.
- Both read the repo; only the repo is durable. Decisions made in chat must be
  written back to this document + `decisions/` before they count as real (see §10).

---

## 10. Documentation discipline (write-back ritual)

High-bandwidth reasoning happens in chat, but chat context is ephemeral. To
prevent this document from drifting from reality:

After any significant chunk of design work, before moving on:
1. Update this `current.md` to reflect new decisions.
2. Write an ADR in `decisions/` for each significant decision (append-only;
   supersede, never edit, past ADRs).
3. Commit both. The repo — not the chat — is the source of truth.

Claude Code prompts are disposable execution instructions; they reference these
durable docs rather than re-explaining context.

current.md is updated via targeted diffs, not full-file rewrites, to avoid silently dropping accumulated detail. New ADRs are added as complete files.

---

## 11. Build phases

- **Phase 0** — infrastructure (git, AWS, 1Password, Supabase, VPS, Docker stack, Nginx + TLS). **COMPLETE** (infra hardened, password auth disabled, both machines keyed).
- **Phase 1** — ClickUp foundation. **IN PROGRESS** — see *Phase 1 status* below. The agent CU account, the six `[AI]` custom fields, and the global agent-rules + operator-preferences docs are live; research is complete (NPD process mapped; observations doc) and the core model + KM-maintenance design confirmed. Remaining: full Agent System Space build-out (process templates with checklist-in-description + doc leaves) and the rest of the team's preference docs.
- **Phase 2** — the spine. **IN PROGRESS (core path COMPLETE)** — the generic read→route→infer→post-back pipeline (thin `Agent Orchestrator (v1)` → Stage A `Assemble Context and Build Prompt` → B `Execute LLM Call` → C `Post Reply`; ADR-036), signature-verified @-mention triggering (`CU Webhook Producer (v1)`, ADR-029), thread-aware replies via `conversation_sessions`, and `Search (v1)` + Layer-B caller-scoped reads (ADR-031) are all live and verified end-to-end. See *Phase 2 status* below and §15. Remaining: selective `linked_doc_leaves`; autonomous status/due-date triggers (Phase 3).
- **Phase 3** — email + due-date triggering + queue tuning.
- **Phase 4** — learning loop (proposers).
- **Phase 5** — team rollout.

Target: 7–9 weeks to v1.

---

## Infrastructure status (Phase 0 — COMPLETE)

- **VPS**: Cyberfolks vroot_SPRINT, AlmaLinux 10, 185.25.149.174 (KVM, 4 vCPU / 8 GB / 100 GB, hostname vps57524999).
- **Access**: key-based SSH (ed25519). Separate keypair per machine — home and office desktops each have their own key installed for `franciszek` (private keys passphrase-free, for non-interactive automation). Non-root sudo user `franciszek` (wheel + docker + NOPASSWD sudoers); root reserved for exceptions. firewalld: ssh/http/https open. See ADR-010.
- **Password auth: DISABLED.** Both workstations (home + office) have key-based SSH access; with both keyed, password authentication was turned off (`PasswordAuthentication no`) as the final hardening step. Access is now key-only.
- **Docker stack**: `/opt/haxe-agents/`, six containers on private bridge network `n8n-internal`, queue mode. Image versions pinned. See ADR-011.
  - `n8n-postgres` (postgres:16) — n8n's internal DB; named volume; healthcheck-gated.
  - `n8n-redis` (redis:7-alpine) — queue backing; AOF persistence enabled; named volume.
  - `n8n-main` (n8nio/n8n:2.22.5) — UI, webhooks, scheduler; binds to 127.0.0.1:5678 only.
    Memory-capped `mem_limit: 1024m` + `NODE_OPTIONS=--max-old-space-size=768` (ADR-051 Block 6).
  - `n8n-worker` (n8nio/n8n:2.22.5) — queue consumer; concurrency 5.
    **Memory-capped** `mem_limit: 1024m` + `NODE_OPTIONS=--max-old-space-size=768` (ADR-051 Block 6).
    Image generation runs here (the parallel batch's base64 images ride execution data), and Node's
    default heap ceiling on this 8 GB box is ~2.2 GB — unbounded, two n8n processes could crowd Docling
    (which wants ≥4 GB when loaded) off the host. The heap ceiling sits *below* the cgroup limit so a
    runaway hits a JS-heap OOM (fails its own execution, container restarts) instead of the kernel
    OOM-killing Docling. Verified: a 5-image concurrent `gpt-image-2` batch peaked the worker at ~228 MiB
    (image heap is trivial); the cap is a safety valve against a pathological runaway, not a tight fit.
  - `litellm` (ghcr.io/berriai/litellm, v1.87.0 pinned by digest) — **deployed + active** (ADR-024/030).
    Internal-only LLM gateway (127.0.0.1:4000): signs Bedrock, returns exact token usage + USD cost header,
    multi-provider. **IS the production model-call path** (§15). Chat aliases (PD-blind — ADR-043, migration 021):
    four Anthropic direct (`haxe-haiku-4-5-direct`, `haxe-sonnet-4-6-direct`, `haxe-opus-4-8-direct`,
    `haxe-fable-5-direct`) + two Gemini global (`haxe-gemini-flash`, `haxe-gemini-pro`). The three Bedrock EU
    (`*-bedrock`) aliases were **removed in Block 3** (no routing row references them); the Gemini aliases were
    renamed from `-eu` (they run on the global endpoint, never EU-pinned). `ANTHROPIC_API_KEY` in `.env` and
    passed through via `docker-compose.yml`. Config in committed `n8n/litellm-config.yaml`; credentials in `.env`
    (never committed). **`litellm_settings.num_retries: 3` (ADR-051 Block 6):** the router retries retryable
    errors (429/500/timeout) with exponential backoff and respects upstream `Retry-After` before returning to
    n8n — so a transient OpenAI gpt-image-2 429 from a concurrent image burst is absorbed at the gateway and the
    image stays on its top-tier model instead of silently tier-downgrading; only a sustained overload that
    exhausts the retries reaches n8n's per-image fallback (loud, via `warnings[]`). Native Bedrock node retained in n8n **disabled** (legacy). Gemini (ADR-038/040):
    `haxe-gemini-flash` (`vertex_ai/gemini-3.5-flash`) and `haxe-gemini-pro`
    (`vertex_ai/gemini-3.1-pro-preview`), both `vertex_location: global` (ADR-039/042). Auth: ADC via
    `GOOGLE_APPLICATION_CREDENTIALS=/secrets/vertex-key.json`; the key file is mounted read-only from
    `/opt/haxe-agents/vertex-key.json` (service account `litellm-vertex@haxe-agent-system-499018.iam.gserviceaccount.com`,
    `roles/aiplatform.user`). `VERTEX_PROJECT=haxe-agent-system-499018` in VPS `.env`. Never commit
    `vertex-key.json` — source from 1Password.
  - `docling` (`quay.io/docling-project/docling-serve`, digest-pinned `sha256:c7ba482f…`) — **deployed +
    active** (ADR-036). Internal-only document extractor (127.0.0.1:5001, loopback). The single extractor for
    the multimodal input pipeline: converts docx/xlsx/csv/txt/pdf/pptx + images (OCR) → markdown with
    layout/tables via `POST /v1/convert/file`; `GET /health`. n8n reaches it at `http://docling:5001`. No
    provider fallback — a file that defeats it surfaces as `[BRAK: extraction_failed <file>]` + WARN, run
    continues. **Verified live 2026-06-10** on the HBG Sharp.docx / Karta Techniczna HX705.pdf / Wzorcowa
    specyfikacja.xlsx fixtures (markdown at `document.md_content`; xlsx → 260 pipe-table rows). ⚠ Default
    `image_export_mode=embedded` inlines page images as base64 (one PDF → 242 KB vs 1.3 KB in `placeholder`
    mode); the readers (Blocks 2–3) must pass `image_export_mode=placeholder`.
    > **Docling tuning (ADR-048 Block 5, 2026-06-15):** the reader now calls Docling with `do_ocr=false` +
    > `table_mode=fast` + `document_timeout=120` (measured: OCR off is 50–67 % faster and byte-identical on
    > digital PDFs; `fast` is byte-identical to `accurate` on real Haxe PDF/XLSX tables). Because OCR only
    > affects scanned/image-only PDFs, a **two-pass fallback** preserves them: an empty first pass re-runs that
    > one doc with `do_ocr=true` (`OCR Empty?` → `Restore Doc Binary` → `Docling OCR Retry`, converged through
    > `Merge OCR Result`). The service is pinned to a deliberate concurrency bound —
    > `DOCLING_SERVE_ENG_LOC_NUM_WORKERS=2` + `OMP_NUM_THREADS=2` (2 workers × 2 threads = the box's 4 cores, no
    > oversubscription; excess conversions queue server-side) in **both** the repo and VPS `docker-compose.yml`
    > so a multi-document zip burst can't saturate the box and an image bump can't silently revert it.
    > **Config drift incident (2026-06-08):** The VPS `docker-compose.yml` predated ADR-030 and lacked the
    > `ANTHROPIC_API_KEY` passthrough. LiteLLM's router surfaced the resulting 401 as a 429 cooldown, causing
    > ~8 h of misdiagnosis. Fixed by redeploying `docker-compose.yml` via scp. See ADR-033 for the deploy
    > model and mitigations.
- **Public endpoint**: `https://agents.haxe.ai` — Nginx reverse proxy + Let's Encrypt TLS (certbot, auto-renewing, 90-day). HTTP → HTTPS redirect active. See ADR-012.
- **Build control plane**: Claude Code drives infrastructure via two MCP servers in `.mcp.json`:
  - **`n8n-mcp`** (`n8n-mcp@2.56.0`) — n8n REST API (`https://agents.haxe.ai/api/v1`); key from `N8N_API_KEY` (setx; expiry 2026-08-31). See ADR-017/018.
  - **`@supabase/mcp-server-supabase`** — Supabase Management API; key from `SUPABASE_ACCESS_TOKEN` (setx, no expiry set). Enables direct SQL execution + migrations without the Supabase dashboard.
  Both servers use `cmd /c npx` wrapper (Windows shim requirement — CLAUDE.md).
- **AWS**: account 000500193947 (tax reg. Skalus). Root MFA via passkey. IAM user `haxe-agents-bedrock`. Billing alert 50 USD/mo. Region eu-central-1.
- **Supabase**: project `hkeslnosxibeuesxndnz`, eu-west-1 (Ireland). Migrations 001–009 applied. Schema managed via Supabase MCP from the operator desktop.
- **Secrets**: all in 1Password (Cyberfolks account / Solus / root / franciszek / n8n encryption key / UI creds — separately labeled); `.env` on VPS only, never committed. `N8N_ENCRYPTION_KEY` rotated after initial deploy. The **ClickUp webhook HMAC secret** lives in the n8n `crypto` credential "ClickUp Webhook HMAC".
- **VPS deployment model**: `/opt/haxe-agents/` is NOT a git repo. Infra files (`docker-compose.yml`,
  `litellm-config.yaml`) live flat there; canonical copies are in the repo under `n8n/`. After any
  change to either file in the repo, run `infrastructure/scripts/deploy-infra.bat` to push to VPS, then
  `docker compose up -d <service>` to recreate. **Never** `restart` to pick up env var changes —
  it does not re-read `.env`. See ADR-033.
- **Next**: Phase 1 — ClickUp foundation (Agent System Space, custom fields, first personas).

### Credential architecture

```
YOUR LAPTOP                         THE VPS (185.25.149.174)
-----------                         ------------------------
SSH private key  ──key auth──────►  franciszek account (NOPASSWD sudo)
(no passphrase)                       │
                                      ├─ /opt/haxe-agents/          ← flat; NOT a git repo (ADR-033)
                                      │    ├─ docker-compose.yml  (canonical: n8n/docker-compose.yml)
                                      │    ├─ litellm-config.yaml (canonical: n8n/litellm-config.yaml)
                                      │    ├─ vertex-key.json     (Vertex AI SA key — never committed; source: 1Password)
                                      │    └─ .env                (VPS ONLY, never git)
                                      │
                                      ├─ Docker containers (private bridge network):
                                      │    ├─ n8n-main    127.0.0.1:5678  (localhost only)
                                      │    ├─ n8n-worker  (no public port)
                                      │    ├─ n8n-postgres  port 5432, internal only
                                      │    │    └─ stores n8n workflows + ENCRYPTED Tier-3 creds
                                      │    └─ n8n-redis     port 6379, internal only
                                      │
                                      └─ Nginx  0.0.0.0:443  (public, TLS)
                                           ├─ agents.haxe.ai → localhost:5678
                                           └─ Let's Encrypt cert, auto-renewing via certbot

1PASSWORD (off-server source of truth):
  - SSH key (no passphrase — keep key only on trusted machines) (Tier 1)
  - N8N_ENCRYPTION_KEY, Postgres pw, n8n UI owner login (Tier 2)
  - Bedrock / Supabase / ClickUp / Gmail keys (Tier 3, entered in n8n UI)

OPERATOR DESKTOP (Windows, per machine):
  - n8n API key for Claude Code's build control plane — stored via setx in the
    user registry, read as ${N8N_API_KEY} by the n8n MCP server. Control-plane
    scope (full workflow read/write over the public API); expiry 2026-08-31.
    See ADR-017 / ADR-018.

GIT REPO (no secrets ever):
  - docker-compose.yml, .env.example, nginx-agents.conf, .mcp.json (key via
    env-var reference only), architecture docs
```
### Docker architecture
═══════════════════════════════════════════════════════════════════════════════
  THE VPS (one physical-ish machine, one Linux KERNEL, one real filesystem)
  AlmaLinux 10 @ 185.25.149.174
═══════════════════════════════════════════════════════════════════════════════

  REAL HOST FILESYSTEM (everything actually exists here)
  ├── /opt/haxe-agents/
  │     ├── docker-compose.yml        ← describes the structure below
  │     └── .env                      ← secrets, read at startup, injected as env vars
  │                                      (NOT a volume — in-memory only)
  ├── /var/lib/docker/volumes/        ← WHERE VOLUMES REALLY LIVE (persistent)
  │     ├── n8n-postgres-data/_data/  ──────────┐
  │     ├── n8n-redis-data/_data/     ────────┐ │
  │     └── n8n-main-data/_data/      ──────┐ │ │
  └── /home/franciszek/  /root/  ...        │ │ │   (invisible to containers)
                                            │ │ │
        the KERNEL presents each process    │ │ │  mounted
        a private VIEW via namespaces:      │ │ │  into
                                            │ │ │  containers
  ┌─────────────────────────────────────── │ │ │ ──────────────────────────────┐
  │ DOCKER private bridge network "n8n-internal"                                │
  │ (containers resolve each other by NAME, like DNS)                           │
  │                                            │ │ │                            │
  │  ┌──────────────────────┐                  │ │ │                            │
  │  │ n8n-main             │   port mapping:   │ │ │                            │
  │  │  image: n8nio/n8n    │   127.0.0.1:5678 ─┼─┼─┼──► reachable ONLY on host  │
  │  │  (pinned version)    │                  │ │ │     loopback (private);     │
  │  │  sees: /home/node/.n8n ◄────volume──────┘ │ │     SSH-tunnel to use it    │
  │  │  namespaces: own fs/net/PID                │ │                            │
  │  └──────────┬───────────┘                    │ │                            │
  │             │ enqueues jobs                   │ │                            │
  │             ▼                                 │ │                            │
  │  ┌──────────────────────┐                     │ │                           │
  │  │ n8n-redis            │                      │ │                           │
  │  │  image: redis (pin)  │                      │ │                           │
  │  │  port 6379           │   AOF persistence    │ │                           │
  │  │  (internal only)     │   /data ◄──volume────┘ │                           │
  │  └──────────┬───────────┘                        │                           │
  │             │ workers pull jobs                  │                           │
  │             ▼                                     │                           │
  │  ┌──────────────────────┐                         │                          │
  │  │ n8n-worker           │   no port mapping        │                          │
  │  │  image: n8nio/n8n    │   (nothing exposed)      │                          │
  │  │  executes workflows  │                          │                          │
  │  └──────────┬───────────┘                          │                          │
  │             │ reads/writes                          │                         │
  │             ▼                                        │                         │
  │  ┌──────────────────────┐                            │                         │
  │  │ n8n-postgres         │   n8n's INTERNAL db         │                        │
  │  │  image: postgres(pin)│   (workflows, exec history, │                        │
  │  │  port 5432           │    encrypted credentials)   │                        │
  │  │  (internal only)     │   /var/lib/postgresql/data ◄┘ volume                 │
  │  └──────────────────────┘                                                      │
  │                                                                                │
  │  startup order enforced by depends_on + healthchecks:                          │
  │    postgres healthy AND redis healthy  ──►  THEN n8n-main / n8n-worker start    │
  └────────────────────────────────────────────────────────────────────────────────┘

  cgroups (not drawn): cap each container's CPU / RAM share of the host's 8 GB.

  THREE KERNEL MECHANISMS AT WORK:
   • namespaces → each container sees its own filesystem/network/process world
   • volumes    → deliberate holes connecting a container path to persistent host storage
   • cgroups    → resource ceilings per container

---

## Phase 1 status (ClickUp foundation — IN PROGRESS)

The ClickUp substrate the generic pipeline reads from. State as of 2026-06-09:

- **Agent CU account — DONE.** `agent@haxe.com` is a ClickUp **Member** (only Members can mint
  the personal API token the pipeline needs); its token drives all ClickUp I/O and reads CU
  Docs via the Docs v3 API. Caller-scoping is enforced in software (Layer A prompt + Layer B
  Space-membership in `Search (v1)`), not by the account. See §13.3, ADR-004, ADR-026.
- **Workspace custom fields — DONE** (verified 2026-06-03). Six live `[AI] …` fields drive
  agent control: `Czy zadanie dla AI` (autonomous gate), `Wpływ zadania na wynik firmy`
  (5-level impact → model tier + queue priority), `Finalny, zaakceptowany efekt`
  (approval/quality signal), `Status agenta` (reset/lifecycle), `Typ procesu`, `Koszt akcji
  [PLN]`. Full set + values in §13.2.
- **GLOBAL agent-rules doc — DONE (working version).** Lives in CU Docs (`q7wz-16892`); loaded
  on every run so output follows firm rules + brand non-negotiables (core-model step 3). The
  content keeps evolving; the loading seam is live.
- **Per-person agent-preferences docs — PARTIAL.** The operator's prefs doc exists and is
  loaded live alongside the rules doc; docs for the rest of the team are authored as they
  onboard (Phase 5).
- **Agent System Space scaffolding — PARTIAL.** The alerting channel (Alerts task `869dj2z2c`)
  and a test surface (`Lista testy AI`, task `869dhad2q`) are live and exercised end-to-end.
  The full Space content in §13.1 — process templates with checklist-in-description +
  paste-ready doc leaves (starting with the mapped NPD process), the proposer/email persona
  docs, the Formatter Skill doc, and the landing-zone tasks (Process Improvements, Agent
  Errors, GM Weekly Reports) — is built out incrementally as each capability lands.

Research is complete (NPD process mapped; observations doc) and the core model + KM-maintenance
design confirmed (see *Core model* and *KM maintenance*). Remaining to close Phase 1: author
the canonical NPD process template in CU (checklist-in-description + doc leaves) so the pipeline
exercises a real structured process beyond the test list.

## Phase 2 status (the agent spine — core path COMPLETE)

The generic read→route→infer→post-back pipeline plus automatic @-mention triggering — built and
verified end-to-end on `869dhad2q`. Per-workflow detail, n8n IDs, and node names are in §15.
State as of 2026-06-10:

- **Core pipeline — DONE (decomposed).** A thin `Agent Orchestrator (v1)` (id `a8XKaijkMFNBpRBa`,
  8 nodes) sets status then calls three stage subworkflows in sequence — **A** `Assemble Context and
  Build Prompt (v1)` → **B** `Execute LLM Call (v1)` → **C** `Post Reply (v1)` — each with its own
  execution log and a shared **Reset Status + Alert** on any stage failure (ADR-032/036). Stage A
  composes `Context Gather (v1)` → `Search (v1)` → `Build Prompt`; B runs
  `Invoke Model (v1)`; C posts the thread-aware draft and owns the ClickUp side-effects. (The earlier
  monolithic 26-node `agent-spine.json` was decomposed in place — `a8XKaijkMFNBpRBa` is now the
  orchestrator.)
- **Model layer — DONE.** Self-hosted LiteLLM gateway, **PD-blind** data-driven routing on `(impact,
  modality)` — `text` → Anthropic direct, `multimodal_input` → Vertex Gemini, `image` → gemini-image + gpt-image-2 tiers (Block 8)
  (ADR-043, migration 021; image tiers refreshed in migration 023) — exact USD × daily NBP FX → `cost_pln`, logged to `agent_runs` and summed
  into `[AI] Koszt akcji [PLN]`.
- **Output — DONE.** Draft comment @-mentions the reviewer and renders full markdown (headings,
  lists, code, tables) via a deterministic markdown→Quill-Delta converter; soft
  Wyniki/Pytania/Decyzje/Sugestie structure. **Never finalizes** (no agent-done status, no
  `Finalny…` write); `[AI] Status agenta` flips W trakcie → Zakończono around the run.
- **Automatic triggering — DONE (@-mention).** `CU Webhook Producer (v1)` receives
  workspace-wide `taskCommentPosted`, **verifies the `X-Signature` HMAC**, detects the agent
  tag from the payload (zero extra API calls for non-mentions), and calls the spine with
  `explicit_mention`. Agent→agent chaining allowed, bounded by an 8-runs-per-10-min circuit
  breaker; caller/reviewer = the mentioner.
- **Conversation continuity — DONE.** Thread-aware replies via `conversation_sessions`.
- **Monitoring — DONE.** Reactive (`Error Handler (v1)` as `errorWorkflow` → CRITICAL) +
  proactive WARNs (routing-default, cost-missing, insert-failed, FX-freshness, bad-signature,
  loop-breaker) via `Post Alert (v1)`. Failure paths fault-injected and proven (ADR-025).

Remaining in Phase 2: selective `linked_doc_leaves` (only the current step's leaf). Deferred:
autonomous status/field-change + daily due-date triggers (Phase 3); the ADR-026 identity split
(read-only telemetry vs. edit-capable token).

---

## 12. Design principles

Nine principles in priority order. Every architectural decision traces back to one.

1. **Process knowledge in ClickUp.** All operational knowledge — process templates, stage instructions, step checklists, agent personas, brand voice — lives in ClickUp Docs and task descriptions. Team members edit it directly without git knowledge.

2. **Agents run as a ClickUp Member account, with caller-scoped permissions enforced in software.** The agent was intended as a least-privilege Guest, but ClickUp only lets **Members** generate the personal API token the pipeline needs — so `agent@haxe.com` is a Member with broad base permissions. Because the account itself is over-privileged, the agent's effective scope is constrained to the calling user's permissions at the application layers (prompt Layer A + the n8n MCP gateway Layer B), not by the CU account, and the LLM holds no write capability at all (ADR-026). See ADR-004.

3. **Recursive self-improvement via structured proposals.** All proposals tracked in a structured database. The GM agent analyses evaluations and records its verdicts in the same thread it analyses, enabling recursive self-reflection on its own past calls.

4. **Context retrieval via MCP, not custom infrastructure.** Claude reads ClickUp directly via the MCP connector — no sync jobs, no intermediate store.

5. **Conversation sessions cache context across turns.** Multi-turn discussions cache the expensive part (task hierarchy, examples, persona docs) and reuse it across turns.

6. **Single comprehensive prompt over multi-step agent loops.** Builder/Critic/Synthesizer separation is unnecessary with Opus-class models. One well-engineered persona prompt performs draft+critique+revision internally. Deterministic Formatter Skill handles output structure. ~3× cost reduction, ~60% latency reduction, comparable quality.

7. **Proactive autonomous triggers + always-available explicit invocation.** Agents activate autonomously on tasks marked `Czy dla AI = Tak` (webhooks + daily due-date scan). Team members can always explicitly invoke the agent on any task via @-mention or `~command`, regardless of the field value.

8. **All AI execution flows through a queue.** Rate limiting, priority scheduling, retries with exponential backoff, and decoupling of triggers from execution. The queue is the operational backbone.

9. **Gmail-native email integration.** Agent creates Gmail Drafts; human reviews and sends from Gmail directly. No autonomous sending.

---

## 13. ClickUp setup

### 13.1 "Agent System" Space

Dedicated Space containing:

**Docs:**
- `General Agent Rules`
- `Agent Persona` — comprehensive persona with draft+critique+synthesis instructions
- `Org Proposer Persona`, `Task Proposer Persona`, `Email Persona`
- `Formatter Skill` — deterministic output formatting rules per `process_type`
The format of the comment should be:
(1) Results,
(2) Questions to the user,
(3) Decisions made, tradeoffs taken, why the result is done the way it is done,
(4) [In a section marked separately, perhaps under a block of "---------": ] Suggested changes to the process, comments on the execution, etc.
NOTE TO FUTURE BUILDER SELF: The agent's thinking shouldn't be forced into this structure, but he should know from the start that he will eventually need to pass the output in this format (this will guide the reasoning while allowing it to explore the solutions non-linearly, not strictly following the steps)

**Tasks:**
- `Process Improvements` — landing zone for org-level proposals
- `Agent Errors` — error notifications from n8n
- `GM Weekly Reports` — operator review notes

### 13.2 Workspace custom fields

| Field (live name) | Type | Values | Purpose |
|---|---|---|---|
| `[AI] Czy zadanie dla AI` | Dropdown | Nie / Tak | Gates autonomous agent behavior |
| `[AI] Wpływ zadania na wynik firmy` | Dropdown | n/d - zadanie nie jest dla AI / Niski / Średni / Wysoki / Krytycznie ważne | Importance → routes model tier + queue priority (was `Ważność`) |
| `[AI] Finalny, zaakceptowany efekt` | Attachment | (plik) | Quality signal — populated only on approval |
| `[AI] Status agenta` | Dropdown | Zresetuj agenta / W trakcie / Zakończono / Nie rozpoczęto | `Zresetuj agenta` triggers session expiry + restart |
| `[AI] Typ procesu` | Dropdown | Nowy produkt / Nowy pracownik / Nowy kontraktor zewnętrzny | Process identifier |
| `[AI] Koszt akcji [PLN]` | Number | (PLN) | Aggregated cost per task |

> Live field set as built (verified 2026-06-03). The doc historically calls the
> importance field `Ważność`; it now has **five** levels (+ an `n/d` opt-out),
> not the old Low/Medium/High three. Consequently the model-tier and queue-priority
> mappings (§3, §14.3) and the routing selection step (ADR-013) must map five
> importance levels — and, per ADR-013/ADR-021, a **second axis: sensitivity
> (PII / personal data)** set by an earlier classifier node — to (provider, model,
> priority). That mapping is a pending design decision, not a default.

`[AI] Czy zadanie dla AI` gates autonomous behavior only. Explicit invocations
(@-mention, `~command`) always work regardless of this field.

### 13.3 Agent CU account

Single base account `agent@haxe.com`. Intended as a comment-write-only Guest, but
ClickUp won't let guests mint an API token, so it is a **Member** (broad edit/delete
rights) — see ADR-004 (2026-06-02 update). Runtime scope narrows to the calling user's
permissions (see §3, ADR-004). **Layer A** (prompt-level) is enforced by the persona
prompt system. **Layer B** (space-membership enforcement) is implemented in `Search (v1)`
(ADR-031): candidate artifacts from spaces where the caller is not a member are excluded
fail-closed (`GET /space/{id}/member` check; failure = exclude, not include).

> **Least-privilege model (ADR-026).** The durable control is *capability containment*:
> the LLM holds no credentials and no tools (`Invoke Model` is pure prompt→completion),
> so the agent can only do what deterministic, version-controlled n8n nodes are wired to
> do — default **read + draft-comment only**. The Member token is over-privileged
> (defense-in-depth gap): it is the one identity used for all ClickUp I/O. **Custom-field
> writes are permitted** (resolved 2026-06-08) but **only via deterministic nodes/code,
> never a capability exposed to the LLM** — the Agent-Spine `[AI] Koszt akcji [PLN]` write
> (a fixed `SUM(agent_runs.cost_pln)` set-field call) satisfies this. A separate
> telemetry identity was considered and decided against (ADR-026); the single agent
> token is used, scoped by Space membership.

### 13.4 Process knowledge hierarchy

```
Process template (main task)
├── Description: "What this process is, end-to-end flow, success criteria"
├── Stage 1 subtask grouping
│   ├── Description: "Stage rules: tone, constraints, departmental specifics"
│   ├── Step 1 (subtask)
│   │   └── Description: "What to do, checklist, references to docs"
│   └── Step 2 (subtask)
└── Stage 2 subtask grouping
    └── …
```

---

## 14. Queue infrastructure

### 14.1 Why a queue

Four problems solved simultaneously:

- **Rate limiting.** Bedrock and ClickUp APIs have per-minute limits. Uncontrolled bursts (50 tasks due at midnight) cause cascading failures. Queue paces execution.
- **Decoupling.** Webhooks must return 200 OK in seconds or ClickUp retries and creates duplicates. Queue lets triggers enqueue and return immediately; workers process at sustainable pace.
- **Priority scheduling.** High-importance work jumps the line. Background batch work (weekly proposer, analysis) never blocks urgent user-triggered work.
- **Retry with backoff.** Transient failures don't kill a run permanently.

### 14.2 Stack

Redis (Docker container alongside n8n, ~50 MB RAM) as queue backing. n8n queue mode:

```
N8N_EXECUTIONS_MODE=queue
N8N_QUEUE_BULL_REDIS_HOST=redis
N8N_QUEUE_BULL_REDIS_PORT=6379
```

Two worker processes initially, each with concurrency 5 → 10 concurrent runs total.
Scales by adding workers.

### 14.3 Priority levels

| Priority | Triggers | Examples |
|---|---|---|
| 1 (high) | Ważność = High, explicit user invocations | Customer-facing replies, deadline-day NPD |
| 5 (normal) | Ważność = Medium, due-date daily, most webhooks | Standard NPD, supplier emails |
| 10 (low) | Ważność = Low, weekly proposer, background analysis | Marketing copy, batch processing |

Explicit invocations get +1 priority boost vs same-Ważność background jobs.
Within a level: FIFO.

### 14.4 Rate limits per integration

| Integration | Limit | Behavior |
|---|---|---|
| Bedrock Claude | 50 req/min | Queue paces; jobs wait, don't fail |
| ClickUp API | 100 req/min | Queue paces |
| Gmail API | 250 req/min | Queue paces |
| Supabase | 200 req/min (conservative) | Queue paces |

Rate-limit tokens stored in Redis with TTL. Worker checks availability before
each API call; if unavailable, requeues with short delay.

### 14.5 Retry policy

| Attempt | Delay |
|---|---|
| 1 | Immediate |
| 2 | 1 minute |
| 3 | 5 minutes |
| 4 | 15 minutes |
| 5 (final) | Dead letter → posts to Agent Errors task |

Retryable: timeouts, 5xx responses, transient network issues.  
Non-retryable: 4xx responses, explicit business-logic failures → dead letter immediately.

### 14.6 Queue monitoring

n8n cron workflow every 5 min queries Redis queue depth. Alerts to Agent Errors task:
- High-prio queue > 20
- Any queue > 100
- Dead letter queue > 0

---

## 15. n8n workflows

The system is one generic pipeline (the **Agent Spine**, see *Core model*) plus supporting
crons and a global error handler. This section is the canonical state of what is built in
n8n. Names ending in `(v1)` are live n8n workflows (IDs given); they are **composed**, not
monolithic. Everything below was verified live on the `Lista testy AI` test task `869dhad2q`
unless noted. The build control plane is Claude Code → n8n MCP (ADR-018).

### 15.1 Workflow set and build state

The original design named the core engine a single **"Main Orchestrator"** worker workflow. It is
now realized as a **thin `Agent Orchestrator (v1)`** that runs **Stage A `Assemble Context and Build
Prompt (v1)`**, then **selects the Stage B lane by `config.agent_lane`** (ADR-053 Block 8), then **Stage C
`Post Reply (v1)`** — each with its own execution log and a shared status-reset + alert on failure. Since
the **2026-06-22 cutover (Block 9) the default is the managed lane**: Stage B = **`Execute Agent Session
(v1)` → `Render Agent Output (v1)`** (Anthropic Managed Agents). The earlier **bare** Stage B
(**`Execute LLM Call (v1)`**, the LiteLLM path, commit `ff14622`, ADR-036) is retained as the **dormant
failover** lane, selected by `config.agent_lane='bare'`. The monolithic `Agent Spine (v1)` it replaced is gone.

| Workflow | Role | State |
|---|---|---|
| **`Agent Orchestrator (v1)`** (was "Agent Spine"/"Main Orchestrator", id `a8XKaijkMFNBpRBa`) | Thin orchestrator: set status → A → **lane switch (`config.agent_lane`)** → B → C + shared Reset+Alert | **LIVE** |
| **`Assemble Context and Build Prompt (v1)`** (Stage A) | Context Gather + Search + Build Prompt (research call retired, Block 8) | **LIVE** |
| **`Execute Agent Session (v1)`** (id `Rtb1cZbmUqmfGD98`, Stage B — **managed**) | Anthropic Managed Agents session: resolve tier agent (`agent_routing`) + env → upload input images (Files API) → create/send → poll to idle → service custom-tool loop → session USD cost + enumerate produced docs | **LIVE — default Stage B** |
| **`Render Agent Output (v1)`** (id `vPbbN4UQj0LAAtiV`, managed) | Output adapter: parse the agent's fenced block-array → `rendered_delta` + `image_manifest` (produced-image bytes from the `agent-output-images` carrier); control-char JSON repair before fallback | **LIVE** |
| **`Execute LLM Call (v1)`** (id `9qdJA4xnAGbxqkt9`, Stage B — **bare failover**) | Invoke Model → drafted reply + cost (LiteLLM lane; selected by `config.agent_lane='bare'`) | **LIVE (dormant failover)** |
| **`Post Reply (v1)`** (Stage C) | Post draft comment, cost field, status flip, office-doc + image attachments (owns CU side-effects) | **LIVE** |
| **`Sync Agent Definitions (v1)`** (id `4K1w78hJ7JhsUwdN`) + **`Agent Rules Freshness Check (v1)`** (id `7lakbgmrH93ygiyZ`) | Bake CU global-rules into the four tier agents' `system` (idempotent create/version-update) + a freshness dead-man's-switch (stale rules → WARN/CRITICAL). Both every 6h | **LIVE** |
| **`Upload Input Images (v1)`** (id `2VkZN5UeqVk6MDLW`) | Fetch task/zip-inner image refs → Anthropic Files API (`purpose=agent`) → `{file_id→url}` map; upserts `agent_input_file_map` for MCP reference resolution | **LIVE** |
| **`Haxe Image MCP (v1)`** (id `c4vnNLb9usfHJWg3`) → **`Image MCP Tool Handler (v1)`** (id `zxY41zZWRbXon2Eq`) → **`Image Tool Handler (v1)`** (id `vpGswBj2kR2D85hl`) | Self-hosted image MCP (n8n MCP Server Trigger, bearer) the agents call in-harness for `generate_image` (ADR-055) → resolves references → `Generate Images Parallel (v1)` unchanged → Files-API upload + carrier persist + per-image cost. Client-side `generate_image` custom tool is the dormant rollback | **LIVE** |
| **`Managed Agents Auth Monitor (v1)`** (id `X3GEjMgmByZgDJnt`) + **`Image MCP Health Monitor (v1)`** (id `Er1JlLYAQLkIk7yB`) + **`Fable 5 Access Monitor (v1)`** (id `Moh1coo5pPmuSTmD`) | Dead-man's-switches: Anthropic auth probe (6h), image-MCP `initialize` probe (6h), bare-lane Fable reachability (daily) — all alert via `Post Alert (v1)` | **LIVE** |
| **`Context Gather (v1)`** | Assemble labelled task context (task + ancestor chain + fields) | **LIVE** |
| **`Invoke Model (v1)`** | Centralized model-call seam: route → LiteLLM → exact PLN cost → log. **Text + multimodal-INPUT only** since ADR-051 Block 5 (image generation moved to `Generate Images Parallel`) | **LIVE** |
| **`Generate Images Parallel (v1)`** (id `2keb6XVWq5PG0leK`, ADR-051) | Concurrent image-gen batch: `Promise.all` over a bounded pool (cap `config.image_concurrency_cap`=4) fires all of a run's `generate` images at once (wall-clock ≈ slowest single, not the sum); inline image-resolution (ADR-045) + per-image one-tier-below fallback; reuses `Log Model Run` for per-image cost; returns per-image results + `warnings[]`. Auth via the image-scoped LiteLLM key in Supabase Vault (`get_litellm_image_key()`). Cap raised 4→5 (migration 033). **Block 7 (2026-06-16): timeout is non-blocking** — `Fire Images Concurrently` carries an internal **840 s soft-deadline** (`Promise.race`) that returns partial results (un-generated images → `success:false` + an `image-batch/timeout-partial` WARN, never a CRITICAL) below the raised global **`N8N_RUNNERS_TASK_TIMEOUT=900 s`** (15 min, fits 2 `gpt-image-2` waves); per-call HTTP timeout 240→300 s clamped to remaining budget; a failed/not-generated image now bills **0** (`Explode Results` applies the floor only on success). | **LIVE — the sole image-gen path: `Image Resolver`'s generate branch calls it (Block 4), and `Invoke Model`'s dead image branch was deleted (Block 5, 2026-06-15)** |
| **`Search (v1)`** | Comment + external-artifact retrieval, Layer-B scoped | **LIVE** |
| **`CU Webhook Producer (v1)`** | Comment-webhook trigger → verify → detect mention → call spine | **LIVE (@-mention)** |
| **`Post Alert (v1)`** | Centralized alert seam → ClickUp Alerts task | **LIVE** |
| **`Error Handler (v1)`** | Global `errorWorkflow`: throws → CRITICAL + status rollback | **LIVE** |
| **`FX Rates Daily (v1)`** + **`FX Freshness Monitor (v1)`** | Daily NBP USD/PLN upsert + staleness WARN | **LIVE** |
| **`Storage Watchdog Intake (v1)`** (id `iMJrbyPD7UroQZ1W`) | Header-auth webhook → Post Alert; receives the host disk/DB dead-man's-switch (ADR-046) | **LIVE** |
| **`Read Input (v1)`** (id `zgGpONulGMohQQqI`) | Unified multimodal input reader (Blocks 2+3, ADR-036 "Input readers unified"), pure/branch-free: self-fetches `{ clickup_task_id }` → `Classify Attachment` (Switch) → **image** = URL passthrough (skips Docling) / **extractable** = Docling → `Merge` → `{ blocks(text+image, ordered), clickup_task_id, warnings }`. Reader owns ordering; Stage A (Block 5) fires `warnings` via `Post Alert (v1)`. Router + visual reader retired. **ADR-048 Block 1:** a `Lookup File Processing Config` Postgres node (global file limits `config.zip_max_entries`=50 / `zip_max_file_mb`=25 / `zip_max_total_uncompressed_mb`=250, migration 027 seeded 500, lowered to 250 by migration 028 after gate B; see Block 3) hangs off `Get Task` and converges through `Merge`; `Aggregate Blocks` filters it out (no `block` field), so the branch-free terminal is preserved. Block 1 only **surfaced** the limits; **Block 3 enforces them** (the zip guards in `Explode Zip Entries`). **ADR-048 Block 2:** a `Store Zip Image` step (`Zip Image Key` → `Upload Zip Image` → `Sign Zip Image URL` → `Compose Signed URL`) uploads each zip-inner image's **original bytes** to a **private EU Supabase bucket `zip-inner-images`** (project `haxe-agent-prod`, `eu-west-1`) and emits a **6h-TTL signed URL** as the block `ref` — never base64 (the OOM fix: heavy bytes never enter execution data). It is **only for zip-inner images**; loose images keep their ClickUp URL. **Build gate D passed (2026-06-15):** a Supabase signed URL is fetched and read by the provider through LiteLLM end-to-end (Gemini, 1089 image tokens, correct description). **ADR-048 Block 3 (zip unpacking, 2026-06-15):** a `Zip? Switch` after `Explode Attachments` routes a real `.zip` (ext/mime zip, not the no-attachment sentinel) into the zip branch and everything else to `Classify Attachment` unchanged. Zip branch: `Fetch Zip Binary` → `Stamp Zip Filename` (stamps `fileExtension=zip`/`mimeType` so `Decompress` never fails a valid archive for missing metadata — the compression node otherwise throws `File extension not found`, which `continueRegularOutput` would have silently degraded to a `zip_extraction_failed` drop) → `Decompress` (compression node; adm-zip, in-memory per gate B) → `Explode Zip Entries` (fan out each inner file; interleave `order = parentOrder + (i+1)/1000`; `att_id = <parentAttId>:<i>`; apply the global guards — junk silently skipped, nested-zip/oversize/too-many/over-total/corrupt → a pre-tagged `route:drop` item with a `multimodal/zip-*` warn_source). Inner files classify: **image** → the `Store Zip Image` step → `Build Zip Image Block` (same envelope as `Build Image Block`, ref = the Supabase signed URL; drop+warn if storage failed); **document** → a `Merge Extractable` (append) so **one** `Docling Convert` serves both loose and zip docs; **drop** → `Build Dropped Zip Block` (`[BRAK: <reason> <title>]` + warn). `Build Text Block` recovers per-item order/title source-agnostically (`Explode Zip Entries` first, else `Explode Attachments`). `Merge Branches` widened to 5 inputs (image, text, config, zip-image, zip-drop) and still converges into the branch-free `Aggregate Blocks`. **Verified end-to-end (2026-06-15):** a real ClickUp `.zip` (2 docs + 2 images + nested `inner.zip` + `.DS_Store`), run through the reader via the production `When Called` path, produced correctly interleaved blocks — docs as Docling markdown, images as fetchable Supabase signed URLs, the nested zip dropped+warned (`multimodal/zip-nested-skipped`), junk silently skipped. The 24h purge of bucket objects lands in Block 4; Docling tuning in Block 5. Loose image/document paths and `invoke-model.json` are unchanged | **LIVE (Phase 2, input)** |
| Daily Due-Date Producer | 00:00 cron: enqueue due-today/yesterday `Czy dla AI=Tak` tasks | **Planned (Phase 3)** |
| Gmail Email Workflow | Incoming mail → Gmail draft; sent-folder post-send analysis | **Planned (Phase 3)** |
| Weekly Org Proposer | Mon 09:00 cron: synthesize evaluations → org proposals | **Planned (Phase 4)** |
| Session Cleanup | Hourly cron: expire idle `conversation_sessions` | **Planned** |

### 15.2 `Agent Orchestrator (v1)` + Stages A/B/C — the generic engine

`n8n/workflows/agent-orchestrator.json`, n8n id `a8XKaijkMFNBpRBa` (thin; expanded in Block 8 with the
lane-resolution + managed-branch nodes). Entry is
either a Form Trigger (`taskId`, manual testing) or a `When Called` Execute-Workflow trigger (from
the webhook producer). After Stage A + the `Context OK?` guard, **`Read Agent Lane` → `Resolve Lane` →
`Lane = managed?`** routes Stage B: **true** → the managed chain (`Call Execute Agent Session` → `Session
OK?` → `Call Render Agent Output` → `Call Post Reply (Managed)`, passing `doc_attachments`/`session_id`
through to Post Reply's office-doc branch); **false** → the bare `Call Execute LLM`. An unreadable/invalid
flag fails safe to bare + `Alert Lane Unreadable` (WARN); an empty managed session → `Alert Session Empty`
(WARN, no empty post); adapter degradation → `Alert Render Warnings` (WARN) — all via `Post Alert (v1)`. It sets status **W trakcie** on a **parallel fire-and-forget side-branch off
the trigger itself** — so the requester sees "W trakcie" within ~1 s of webhook receipt, not after the
~30 s context build (repositioned 2026-06-11; a status-write failure routes to `Alert Status Failed`
and never blocks the run). In parallel it calls three stage subworkflows in sequence — each a
Call-Workflow node with its own execution log; any stage's `onError` routes to one shared **Reset
Status + Alert** path (ADR-032), replacing the earlier per-node alert sprawl. A **`Context OK?` guard**
sits between Stage A and Stage B: Stage A runs with `alwaysOutputData`, so if it returns no `prompt`
the run stops loudly at **`Alert Context Empty` (CRITICAL)** instead of silently skipping the model +
reply; likewise the `If LLM Succeeded?` false branch now fires **`Alert LLM Failed` (CRITICAL)** on an
empty completion (both added 2026-06-11 after a zero-attachment task silently produced no reply — see
ADR-036 Block-5 follow-up). The five Core-model steps are distributed across the stages:

- **Stage A — `Assemble Context and Build Prompt (v1)`** (`n8n/workflows/assemble-context-and-build-prompt.json`,
  id `GGTBvFBgGSNbtUR6`, 11 nodes): `Context Gather (v1)` → Workspace Search
  (now also fetches **threaded comment replies** — `GET /comment/{id}/reply` per top-30 comment with
  `reply_count>0` — and interleaves them under their parent in `task_comments`, ADR-040) →
  Load Agent Rules → **`Read Input (v1)`** → `Build Prompt` (the `Decide Research` web-research call was
  retired in ADR-053 Block 8 — web search is in-harness on the managed lane). Returns the prompt payload +
  assembled context, plus **`image_blocks_json`** (input image refs for the vision model, non-PD) and
  `input_warnings_*`. Folds attachment **text** into the prompt and fires the reader's `warnings` via
  `Post Alert (v1)` on a reconverging side branch (`Return Context` stays the sole terminal). Multimodal
  input (ADR-036/038/040 Block 5): images present → `modality='multimodal_input'` set on the context payload →
  routing returns the **Gemini** alias for all multimodal tasks (`haxe-gemini-flash`/`-pro` by tier; ADR-043
  made Gemini the active multimodal route, superseding both the former "PD guard drops images" stance and the
  Claude-direct vision path).
- **Stage B (managed, default) — `Execute Agent Session (v1)` → `Render Agent Output (v1)`** (ADR-053/055):
  resolve the tier agent from `agent_routing` (Niski→Haiku, Średni→Sonnet, Wysoki→Opus, Krytycznie ważne→Opus
  — Fable repointed) bound to the persistent environment; upload input images to the Files API; create + send
  the session; poll to idle (web search, code execution, Skills run in-harness; the client-side custom-tool
  loop is retained for ADR-054's future Google tool, dormant for image since it runs via the MCP server);
  compute the session USD cost; enumerate produced office-docs. `Render Agent Output (v1)` then turns the
  agent's block-array into the Post Reply contract (`rendered_delta` + `image_manifest`, fetching produced
  images from the carrier). Verified live across text / web-research / image-gen / vision / office-doc (Block 9).
- **Stage B (bare, dormant failover) — `Execute LLM Call (v1)`** (`n8n/workflows/execute-llm-call.json`, id `9qdJA4xnAGbxqkt9`,
  12 nodes): `Invoke Model (v1)` → drafted reply + cost; forwards `image_blocks_json` to Invoke Model.
  **Multimodal output (Block 12, 2026-06-13):** the drafting model now returns the **output-block list**, so
  Stage B runs `Call Invoke Model → Parse Output Blocks (tolerant JSON parse; un-parseable → single text block)
  → Call Image Resolver (znDqcfgXK6CNte20) → Sum Task Cost → Update CU Cost Field → [Has Warnings? → Alert
  Resolver Warnings] → Return LLM Result` (sole terminal). The resolver is called **before** the cost sum so
  per-`generate` `image_gen` rows are counted; `Return LLM Result` carries `rendered_delta` / `image_manifest` /
  `image_models` / `total_image_cost_pln` to Stage C; resolver `warnings[]` fire a WARN (`multimodal/resolver`)
  on a reconverging branch. A resolver throw propagates to the global Error Handler (CRITICAL, no partial post).
  The return path stays a single branch-free terminal (fixes the ADR-036 Block-5 return-determinism bug, where
  the parallel cost-sync branch's empty output could be returned instead, silently dropping the draft).
- **Stage C — `Post Reply (v1)`** (`n8n/workflows/post-reply.json`, id `t17moGs7Vxo5ZcFv`, 9 nodes):
  posts the thread-aware draft comment, writes the cost field, flips status **W trakcie → Zakończono**.
  C owns every ClickUp side-effect (comment, cost, status, and — once multimodal lands, ADR-036 —
  image upload + temp cleanup).

- **Input file handling v2 — `.zip` unpacking + zip-inner-image object storage (ADR-048; all blocks
  landed 2026-06-15).** `Read Input (v1)` now unpacks a `.zip` attachment
  instead of degrading it to `[BRAK]` (supersedes the ADR-036 `.zip`-unsupported note). After
  `Explode Attachments` a `Zip?` switch routes archives down a decompress branch
  (`Fetch Zip Binary → Stamp Zip Filename → Decompress → Explode Zip Entries`) that fans inner files out,
  interleaved at the parent zip's ordinal position; everything else (including the no-attachment sentinel)
  flows to `Classify Attachment` unchanged. Inner **images** are uploaded to a **private EU Supabase
  Storage bucket `zip-inner-images`** (`haxe-agent-prod` / `eu-west-1`) and referenced **only by a
  short-TTL signed URL** — the heavy bytes never enter execution data (the OOM fix; the rejected v1 inlined
  base64). Inner **documents** join the shared Docling path; junk is silently skipped; nested-zip / oversize /
  too-many / over-total degrade to `[BRAK]` blocks carrying `multimodal/zip-*` WARNs through `Post Alert (v1)`.
  **Loose images and loose documents are byte-for-byte unchanged** (loose images keep their ClickUp URL — no
  Supabase involvement), and **`invoke-model.json` is untouched**: a Supabase URL is a drop-in for the existing
  image ref. File limits live in the **global `file_processing_config`** keys (migration 027): `zip_max_entries`
  50, `zip_max_file_mb` 25, `zip_max_total_uncompressed_mb` **250** (migration 028 lowered it 500 → 250 because
  the compression node decompresses in-memory). **Retention (Block 4):** zip-inner images are purged by the
  **pg_cron job `purge-zip-inner-images`** (migrations 029 → 030) that deletes through the **Storage REST API so
  the bytes are freed, not orphaned** — a bare `delete from storage.objects` would drop the metadata row but
  leave the S3 object (and the personal data) behind. The job reads its key from **Supabase Vault** (a legacy
  `service_role` JWT or a new `sb_secret_…` key both work); a missing/invalid key writes a `SKIPPED` row to
  `storage_purge_runs` rather than silently no-op'ing. Schedule (operator decision, 2026-06-15): runs **once
  daily at 05:00 Europe/Warsaw**, deleting objects older than **12h** — the 12h floor guarantees an in-flight
  run's attachment is never deleted mid-process; pg_cron has no per-job timezone, so the job fires at 03:00 and
  04:00 UTC and an in-function `Europe/Warsaw` hour-gate makes exactly one fire act (DST-correct). Consequence:
  once-daily + a 12h floor lets evening/overnight files live up to **~36h** (documented in the GDPR record;
  ≤24h would need more than one run/day). A **dead-man's-switch independent of pg_cron** — the n8n
  **`Zip Image Purge Watchdog (v1)`** (`2L4W4OQ7Qmmnl1Z1`), every 6h — WARNs through `Post Alert (v1)` if any
  object exceeds **40h** (healthy ceiling ~36h; catches cron-stopped, function-errored, or Vault-key-missing/invalid
  alike). **Docling tuning (Block 5):** the shared Docling path runs `do_ocr=false` + `table_mode=fast` (measured
  byte-identical to the heavy defaults on real digital PDFs/XLSX, ~50–67 % faster), with a **two-pass OCR fallback**
  (`OCR Empty? → Restore Doc Binary → Docling OCR Retry`, converged via `Merge OCR Result`) so scanned/image-only
  PDFs still extract; `docling:5001` is pinned to a 2-worker × 2-thread concurrency bound (repo + VPS compose) so a
  multi-document zip burst can't saturate the box. See ADR-048.

- **`Build Prompt`** (Code, stub assembler) composes one prompt string from, in order: the
  **GLOBAL agent-rules doc + the caller's personal agent-preferences doc** (CU Docs v3,
  `q7wz-16892`; core-model step 3, so output follows firm rules + person style); the
  **triggering comment** ("Wiadomość wywołująca tę akcję", placed *before* task context so the
  agent acts on what was written, not a cold re-run of the task description); the **`Search
  (v1)`** context (comments + external artifacts); then the **task context** (task + ancestor
  chain). It emits a soft output structure — **Wyniki / Pytania / Decyzje / Sugestie**
  (§13.1) — as guidance, not a hard template.
- **Status lifecycle:** `[AI] Status agenta` flips **W trakcie → Zakończono** around the run —
  **W trakcie** is set immediately off the trigger (up-front feedback to the requester),
  **Zakończono** by Stage C on completion. The pipeline **never finalizes** — it never sets a done
  status on the task itself nor writes
  `[AI] Finalny, zaakceptowany efekt`.
- **Cost field:** writes `[AI] Koszt akcji [PLN]` = `SUM(agent_runs.cost_pln)` for the task
  (idempotent, drift-free). ⚠ This uses the edit-capable agent **Member** token via a fixed
  deterministic node (never an LLM-exposed capability, per ADR-026) — flagged for the ADR-026
  identity split.
- **Reliability:** post-back, cost-sync, and session-upsert failures fire a WARN on a side
  branch and **do not abort the run** (the completion is still returned). `Error Handler (v1)`
  is set as the `errorWorkflow` on the orchestrator and each stage subworkflow.

See ADR-027 (post-back) and ADR-015 (generic pipeline).

### 15.3 `Context Gather (v1)`

`n8n/workflows/context-gather.json`, n8n id `qgM37HdQj78Rn090`. Callable via Form Trigger
(`taskId`) or an Execute-Workflow trigger. Reads a ClickUp task and assembles a labelled
context object: `current_task`, ordered `ancestor_chain`, stub `linked_doc_leaves`,
`truncated_at_depth`. Shape = a bounded unroll of native ClickUp `Task→Get` fetches gated by
IF nodes → a pure Code shaping node (authenticated I/O in credential-aware nodes; Code only
shapes data — ADR-019). It also resolves the **impact** custom field to its label and returns
the task **assignee/creator** (data-ready for the autonomous caller = assignee→creator→skip
rule). Verified: a 3–4-level subtask returns an ordered ancestor chain; a root task returns
`[]`; `markdown_description` flows through (`includeMarkdownDescription`). Read-only. See
ADR-020 (shape).

**Agent Doc access (resolved, ADR-004 2026-06-03 update):** the agent `clickUpApi` token reads
CU Docs via the **Docs v3 API** (`GET /api/v3/workspaces/{ws}/docs/{doc_id}/pages`, full
content) — config docs and leaf docs alike. Embedded doc links arrive in a task's
`markdown_description` as parseable `[Label](…/docs/{doc_id}/{page_id})` URLs, so
`linked_doc_leaves` resolves by regex-extract → Docs v3 GET → flatten (the earlier "no access"
was a task-node link-rendering / pre-grant artifact).

> **Block 13 — model-inferred image resolution (DONE 2026-06-13, ADR-045).** Extraction surface = the
> drafting model emits an optional per-block `size:"WxH"` in the output-block contract (no new `[AI]` field,
> no inline command); Build Prompt instructs it to do so only when the user asks for a specific resolution,
> the resolver threads `size`→`requested_size`, and `Resolve Routing` validates against **gpt-image-2's real
> constraints** (edges ÷16, aspect 1:3–3:1, ≤3840 px edge, 655 360–8 294 400 px) — honoring a valid explicit
> size **exactly**, snapping to nearest-valid only on a real violation (+ an honest Polish note rendered inline
> + `invoke-model/size-snapped` WARN). Verified live: `1280x512` on Krytycznie → gpt-image-2 returned an exact
> 1280×512 (decoded), priced row, posted inline, no snap/WARN.
> **Gemini tiers + shape intent → model upgrade (Block 13b/c).** Vertex gemini image (Niski/Średni) can't honor
> `size` *or* `aspect` through the gateway (LiteLLM drops `imageConfig` → ~1:1 1K; a non-square probe returned
> 1024×1024). So whenever a request carries **shape intent — an explicit `size` OR a non-square `aspect`** — on a
> gemini tier, `Resolve Routing` **upgrades the image model to gpt-image-2** (which honors both), keeps the tier's
> low `image_quality` for cost, and informs the user inline + `invoke-model/resolution-adjusted` WARN. So explicit
> resolution **and** aspect are now honored on **every tier**. Verified: Niski 1280×512 → exact 1280×512 ($0.0024);
> Niski `16:9` with no pixels → 1104×624 widescreen ($0.0036) — not the square gemini would return. A 1:1/no-shape
> request correctly stays on the cheaper gemini default. An interim *reverse* design (reroute gpt→gemini) was built
> and **reversed** once probing proved gpt-image-2 is the resolution-flexible model. *Follow-up (optional, cost):* a
> native Vertex `generateContent` path would let the gemini tiers honor aspect directly, avoiding the gpt-image-2
> upgrade cost on low-tier shaped images.

### 15.4 `Invoke Model (v1)` — routing + exact cost

`n8n/workflows/invoke-model.json`, n8n id `XcOIVdZnVCCWNPeb`. The ADR-013 model-call seam,
running on the self-hosted **LiteLLM gateway** (`litellm` container, `127.0.0.1:4000`, v1.87.0
pinned by digest; ADR-024/030). **Text + multimodal-INPUT only** — since ADR-051 Block 5 (2026-06-15)
image OUTPUT generation lives solely in `Generate Images Parallel (v1)`, so this workflow's dead
`requested_modality_of_output='image'` branch (`Output Is Image?` fork, `Resolve Lower Tier Image` →
`Lookup Fallback Image Prices` → `Call Model Image` → `Parse Image`, and the `Image Degraded?` /
`Cost Header Missing?` image alerts) was deleted. Typed Execute-Workflow contract (`prompt` / `impact` /
`modality` / `task_type`; `image_blocks_json` for input image refs; the `requested_modality_of_output` /
`requested_size` / `aspect` inputs remain on the `When Called` node but are **inert** — no caller sends
`image` any more). Node chain:

`Lookup Routing` (Supabase `model_routing`, composite PK `(impact, modality)`, `__default__` fail-safe row,
DB-error tolerant) → `Resolve Routing` (in-code Sonnet last-resort + deliberation-nudge prepend; builds the
`messages` array — text plus any `image_url` input parts) → `Resolve Lower Tier Text` → `Call Model Text`
(the shared fallback seam `Call Model with Fallback (v1)`, `/v1/chat/completions`, `success_path` empty;
ADR-047 Block B — tries the routed model then one tier below) → `Parse Response`, with the seam's both-down
throw routed to `Retry Text-Only` (Opus text-only safety net, Block 6). → **`Normalize Model Result`**
(one uniform schema) → `Call Log Model Run` (the sole `agent_runs` writer + FX/PLN, ADR-035) → degradation
chain (`Image Unprocessable?` — the multimodal-INPUT degradation WARN, see below — then `Routing Missing?`
and `Check Degradation`, each WARN reconverging) → **`Shape Output`** (sole branch-free leaf; union return
`{ completion, output_modality:'text', model, provider, cost_pln, usd_cost, … }`; the vestigial image fields
`b64_json`/`size`/`degraded` are always null/empty/false now).
The native AWS Bedrock node + `Basic LLM Chain` are **retained disabled** as a fallback path (a generic AWS
credential + HTTP Request cannot sign Bedrock — only the native node can; ADR-021).

- **Provider routing (PD-blind — ADR-043/042):** one row per `(impact, modality)`, three legs by modality:
  - `modality='text'` → **Anthropic direct**: `haxe-haiku-4-5-direct`, `haxe-sonnet-4-6-direct`,
    `haxe-opus-4-8-direct`, `haxe-fable-5-direct`. Auth: `ANTHROPIC_API_KEY`. (A PDF/DOCX task is read as
    text via Docling, so it routes here, not to multimodal_input.)
  - `modality='multimodal_input'` → **Vertex AI Gemini (global)**: `haxe-gemini-flash`
    (`vertex_ai/gemini-3.5-flash`) for `n/d`/`Niski`/`Średni`, `haxe-gemini-pro`
    (`vertex_ai/gemini-3.1-pro-preview`) for `Wysoki`/`Krytycznie ważne` (ADR-042). This is the **active**
    multimodal route (operator decision, ADR-043). Auth: ADC via `/secrets/vertex-key.json`. Transfer
    basis: Vertex AI DPA+SCCs (ADR-043). `Parse Response` detects Gemini aliases → sets provider
    `'litellm/vertex'`. ⚠ Gemini 3.x uses **thinking tokens** billed on top of text: ~65 reasoning + 1 text
    tokens per one-word reply (Flash), ~133 + 1 (Pro); bounded per-model via `reasoning_effort` (ADR-042).
    Real task cost will exceed text-token count alone.
  - `modality='image'` → **image-generation tiers, now consumed by `Generate Images Parallel (v1)` (ADR-051),
    not Invoke Model.** The `model_routing` image rows stay the source of truth — Niski/__default__
    `vertex_ai/gemini-2.5-flash-image`, Średni `vertex_ai/gemini-3-pro-image-preview`, Wysoki/Krytycznie
    `openai/gpt-image-2` (ADR-036 Block 8, migration 023) — and the batch reads them per `(impact, modality)`,
    owning the `/v1/images/generations` HTTP call, per-image one-tier-below fallback, and cost (live header →
    token-math via migration 024's `price_out` — flash 0.030 / pro 0.120 / gpt-image-2 0.030 — → per-image
    `fallback_price_per_unit` floor). The old `invoke-model/image-degrade` and
    `invoke-model/image-cost-header-missing` alerts left with the deleted branch; the batch now surfaces these
    as per-image `warnings[]` that the resolver folds in (ADR-051 Blocks 3–4). gpt-image-2 high ≈ 176 s;
    gemini ≈ 5 s. `agent_runs.model_used` stores the versioned model ID from the LiteLLM response body.
    Migrations 008 (composite PK), 013 (image tiers), 014 (Gemini multimodal), 020 (max_tokens by tier),
    **021 — PD-blind collapse to `(impact, modality)`, Bedrock rows dropped, Gemini aliases renamed `-eu`→none**,
    **023 — image-gen tiers refreshed to gemini-image + gpt-image-2 (Block 8)**, **024 — image token prices for
    token-math**, **031/033 — `config.image_concurrency_cap` (=5)**, **032 — Vault image-key getter
    `get_litellm_image_key()`** — all applied.
- **Impact → tier (ADR-023):** `Niski`→Haiku 4.5, `Średni`→Sonnet 4.6, `Wysoki`→Opus,
  `Krytycznie ważne`→Opus at temp 0.2 / 16k tokens with a prepended deliberation nudge;
  `n/d`/empty/unknown→Sonnet (fail-safe).
- **0-row routing guard (ADR-041):** `Lookup Routing`'s `onError:continueErrorOutput` catches DB
  *errors* but **not** an empty result (0 rows is a success) — which previously let `Resolve Routing`
  skip on 0 items and silently null the whole chain (no reply, no alert). Now `Lookup Routing` has
  `alwaysOutputData:true` (so `Resolve Routing` always runs its safety-net) and a `routing_row_missing`
  flag fires **`Alert Routing Missing` (CRITICAL, `invoke-model/routing`)** naming the unmatched
  impact×modality combo — loud but non-blocking (it reconverges to `Check Degradation`;
  `Shape Output` stays the sole leaf). Migration 019 closed the specific gap that triggered it: the
  `n/d - zadanie nie jest dla AI` tier had no `multimodal_input` row, so a not-for-AI task *with an
  image* matched nothing. It now routes to `haxe-gemini-flash` (Gemini, the active multimodal route). The PK is
  `(impact, modality)` after migration 021.
- **`max_tokens` by tier (migration 020):** `max_tokens` is the **output/completion** cap only — it
  does **not** limit input/context (the context window does). Reasoning models (Gemini 3.x, Fable 5)
  count thinking tokens against it, which is why the former 4000 truncated gemini-flash to an empty
  completion. Re-baselined per impact tier: **Niski 8k, Średni 16k, Wysoki + Krytycznie ważne 32k**;
  `n/d` and `__default__` default to 8k; image-generation rows (`modality='image'`) untouched. NB the
  in-code last-resort fallback in `Resolve Routing` (no row matched / DB down) is still hard-coded to 4000.
- **Gemini thinking level (ADR-042):** Gemini 3.x are reasoning models whose **thinking tokens count as
  output** and against `max_tokens`, and Flash **defaults to `thinkingLevel=high`** — which burned
  3.8k–7.7k tokens and truncated the answer to empty at the 8k cap. Bounded via `reasoning_effort` in
  `litellm-config.yaml` `litellm_params`: **flash → `low`** (lower tiers), **pro → `high`** (higher
  tiers). LiteLLM maps `reasoning_effort` → `thinkingLevel`. Config is mounted into the `litellm`
  container; deploy via `scp` + `docker compose up -d litellm`.
  "Max effort" is approximated via temperature +
  max-tokens + the nudge (the native node exposes no reasoning-budget parameter). **Caveat:**
  newer Opus (4.6/4.7/4.8) is granted on Anthropic direct (`opus-4-8`) but **not** on the
  Bedrock account, so the Bedrock Opus tier uses 4.5 until access is requested on the Bedrock
  Model-access page (then bump one constant). All profiles are EU-resident.
- **Cost:** `x-litellm-response-cost` USD header × latest `fx_rates.rate` (daily NBP USD/PLN) =
  `cost_pln`; if the header is missing, fall back to `model_routing` USD prices and fire a
  `cost-missing` WARN. Token counts come exact from the gateway. Logged to `agent_runs` (live
  cols: `model_used`, `impact`, `input/output_tokens`, `cost_pln`, …; no `provider` col;
  `triggered_by` NOT NULL). Fail-safe: DB-down → `haxe-sonnet-4-6-direct` + WARN.
- **Multimodal input (ADR-036 Block 5):** `Resolve Routing` builds the `messages` array with content as
  **one shape — always an array**: `[{type:'text', text:prompt}]` plus `{type:'image_url', image_url:{url:
  <clickup_url>}}` parts when the caller passes `image_blocks_json` (input image refs from `Read Input
  (v1)`). LiteLLM fetches the URLs (no bytes cross workflow boundaries; ADR-036 reference-not-bytes). The
  routed multimodal model is **Gemini** (flash/pro by tier, ADR-042/043); the text seam (`Call Model Text`)
  sends the image-bearing messages with the primary model, and one-tier-below as the seam fallback.
- **Unprocessable-image robustness (ADR-036 Block 6, PD-blind per ADR-043) — DONE; reached via the seam
  (ADR-047 Block B).** A corrupt/1×1 input image (or a hypothetical non-vision routed model) 4xxs the whole
  request. A **final text-only safety net** closes it: `Call Model Text` (the seam tries the routed model
  **then one tier below**, both with images) →both-down throw→ **`Retry Text-Only`** (Opus, images
  **stripped** + a `[BRAK: obraz nieczytelny na bieżącym providerze]` marker). The chain discriminates by
  construction (no HTTP-status parsing): a transient error on a good image is recovered with the image (by the
  seam's fallback); a genuinely-bad image fails both image-bearing calls and is rescued text-only
  (`Parse Response` sets `image_unprocessable=true` when images were present, fires a
  WARN `multimodal/image-unprocessable`, the draft still posts); a real non-image failure fails all three →
  CRITICAL (not masked). `Retry Text-Only` success still flows through `Call Log Model Run` (one priced
  Opus row); the WARN reconverges into `Routing Missing?` so `Shape Output` stays the sole leaf. Decision:
  **whole-set drop** (all images dropped on a 4xx, not per-image isolation) and **no `vision_capable`
  column** (reactive 4xx catches the non-vision case too). Verified live on `869dhad2q` (3 junk+real
  images → Gemini/Opus 4xx → text-only Polish draft + one WARN, no CRITICAL, cost logged).

See ADR-022 (shape), ADR-023 (routing), ADR-024 (LiteLLM/cost), ADR-030 (multi-provider), ADR-036 (Block 6),
ADR-051 (image generation moved out to the parallel batch).

### 15.5 `Search (v1)`

`Search (v1)` sits between Context Gather and Build Prompt (ADR-031). (The former `PD Verifier (v1)`
seam — id `hzwmak7UBpuHaiTO`, a stub always returning `personal_data: false` — was **deleted in Block 2**,
ADR-043; the pipeline is PD-blind.)

- **`Search (v1)`** (id `eL3fJuRMpzVRuVUT`, 22 nodes) — always fetches the last **30 task
  comments**; if the triggering comment references external artifacts, extracts search queries
  via a Haiku sub-call (`triggered_by=search_step`, logged as an `agent_runs` sub-row), searches
  ClickUp tasks + docs, enforces **Layer B** fail-closed (`GET /space/{id}/member` per candidate
  space; caller not a member → excluded), reads up to **5** accessible artifacts, and condenses
  if > ~4000 tokens (second Haiku sub-run). Returns `task_comments`, `additional_context`,
  `sources_used`, `sources_filtered_out`; `Build Prompt` injects these before the task context.
  Requires migration `009` (`search_step` added to `agent_runs.triggered_by` CHECK) — apply
  before Search processes a triggering comment with external references.

### 15.6 Post-back — draft comment, rendering, thread-aware replies

Core-model step 5 (ADR-027 + update, ADR-028). The spine posts the model output as a ClickUp
**draft comment** that **@-mentions the reviewer** (real ClickUp tag) and **renders full
markdown** — headings, bold/italic/code, bullet/numbered lists, links, code blocks,
blockquotes, and **tables** — via a deterministic markdown→ClickUp-Quill-Delta converter
(`Build Comment`). A "do weryfikacji — nie finalizuje zadania" footer marks it non-final; the
post never sets status or `[AI] Finalny…`.

> Update 2026-06-12 (ADR-036 Block 11): the attribution footer now lives in **`Finalize Comment`**
> (the convergence of the text + image paths), not `Build Comment`, and names the model **per modality**
> with **aggregate** cost — text-only: `(model: X, koszt: …)`; multimodal: `(tekst: X, obraz: Y; koszt
> łączny: text+image …)`. It reads two new `Post Reply` inputs, `image_models` + `total_image_cost_pln`,
> from the resolver (below). `Build Comment` now renders only the body + web-sources (so web-sources
> precedes the footer on the text path). The reviewer @mention is also added to the image path
> (`Rewrite Delta`), reaching parity with the text path.

- **Reviewer** = the **mentioner** (webhook path) / the manual triggerer (operator default,
  optional `reviewer_user_id` form field). The automatic assignee→creator rule is data-ready
  (Context Gather returns assignee/creator) and applies when the autonomous triggers land.
- **Thread-aware (`conversation_sessions`):** `Check Session` (Postgres) looks up an active row
  for `(clickup_task_id, caller_user_id)`. If found, the reply nests in the thread via `POST
  /api/v2/comment/{comment_root_id}/reply` (on failure → new top-level comment + WARN); if not,
  a new top-level comment is posted and its returned ID anchors the thread as `comment_root_id`
  (`Upsert Session New`). Both paths upsert via `ON CONFLICT (clickup_task_id, comment_root_id,
  caller_user_id) WHERE is_active = true`; upsert failure → WARN side branch, run continues.

  > Update 2026-06-11 (supersedes, ADR-040): the **live** `Post Reply (v1)` does **not** use
  > `conversation_sessions`/`Check Session` (that mechanism above is aspirational / never deployed).
  > It nests via `POST /api/v2/comment/{triggering_comment_id}/reply`, where `triggering_comment_id`
  > is the **thread root** computed by the producer's `Detect Mention` as `reply_to_comment_id`
  > (§15.7) — replying to a reply is impossible (ClickUp threads are single-level → `Unsupported
  > Entity`), so the root is the only valid target. On reply failure → new top-level comment + WARN,
  > unchanged.

- **Artifact recording (ADR-044, migration 022; extended Block 10, migration 025):** after the status
  field is set, a `Record Artifact` Postgres node (side branch off `Set Status Zakończono` success) writes
  the posted comment id onto the task's latest `agent_runs.clickup_comment_id` — and, since Block 10, also
  `run_payload_bytes` + `n8n_execution_id` on the same row (no second `agent_runs` writer). Best-effort +
  observable: a 0-row write or DB error fires a `post-reply/record-artifact` WARN; reply and status still
  complete. Erasure-readiness + payload-observability plumbing — see the §4/§5 `agent_runs` notes.

- **Multimodal image delivery — in-memory base64, Option A (ADR-036 Block 10, 2026-06-12).** When the caller
  passes `image_manifest` (base64 entries `{placeholder_id,b64,mime,caption,alt}`) + `rendered_delta` (ops with
  `{type:'image_ref',placeholder_id}` placeholders), Stage C forks an image path off `Has Images?`:
  `Parse Manifest → To Binary (convertToFile, base64→binary) → Upload Attachment (multipart POST
  /task/{id}/attachment → {id,url}) → Aggregate Uploads → Rewrite Delta`, which replaces each placeholder with
  the **ClickUp inline-image op `{type:'attachment', attachment:{id,url}}`** — the *only* form that renders
  inline (a bare `{image:url}` op or markdown does not; proven by the Block-10 spike). Both paths converge at
  `Finalize Comment` (computes `run_payload_bytes` + appends the Polish `rozmiar danych przebiegu` footer), then
  the existing reply/draft post. **No disk, no temp, no shell, no shared volume** — the disk-temp design
  (spec §3.6) was impossible on this n8n (`Execute Command` + file-delete unavailable) and is superseded by
  in-memory base64 (matches Block 9's `b64_json` output). **Two invariants:** (1) **base64 never reaches the
  DB** — `Record Artifact`/`Log Model Run` get only scalar fields, never the manifest; (2) **execution pruning
  is required** (base64 rides n8n execution data) — currently n8n defaults (prune on, 336 h / 10 000). **Failure
  handling:** there is no delete-attachment API, so a post-failure after upload leaves the uploaded images as
  free-floating task attachments (persistence accepted — mockups are legitimate content) and fires a
  `post-reply/post-back` WARN listing the orphaned ids; per-image upload failure → `[obraz niedostępny]` +
  `post-reply/image-upload` WARN, the comment still posts. Verified live on `869dhad2q` (2 generated images
  rendered inline). The base64 manifest is the Stage-B→C contract Blocks 11/12 build on.

- **Multimodal assembler — `Image Resolver (v1)` (ADR-036 Block 11, 2026-06-12; n8n `znDqcfgXK6CNte20`).** The
  sub-workflow upstream of Stage C that *produces* the `image_manifest` + `rendered_delta` above from the drafting
  model's output-block list. Inputs: `output_blocks_json` (text / `embed_input` / `generate` blocks), `impact`,
  `input_image_refs_json` (from Read Input, for embed resolution), `clickup_task_id` + passthrough; it also forwards
  `model`/`cost_pln` (the text-run attribution) to the caller. Graph: `When Called → Lookup Image Config → Resolve
  & Explode Blocks → Classify Block (Switch: text/embed/generate/drop) → {text↦Merge | Resolve Embed | Build Batch
  Request → Call Generate Batch | Build Dropped Block} → Merge Branches → Assemble Output` (the sole branch-free
  terminal). It returns `{image_manifest, rendered_delta, total_image_cost_pln, image_models, warnings}`.
  `embed_input` resolves to an existing attachment → `{type:'attachment'}` op directly (no re-upload); text → same
  markdown→ops logic as `Build Comment`. **Generate is now a parallel batch (ADR-051, Block 4, 2026-06-15):** the
  generate branch collects ALL active generate blocks into one array (`Build Batch Request`) and calls `Generate
  Images Parallel (v1)` **once** (`Call Generate Batch`), which fires the N image calls concurrently (bounded by
  `config.image_concurrency_cap`); `Handle Gen Result` maps the batch results back to blocks **by `placeholder_id`**
  (the old per-image `Call Invoke Model` `mode=each` + `task_type` `block_meta::{…}` smuggling are gone) and folds
  each image's `warnings[]` into the resolver `warnings[]`. **Image count is governed by a single global safety
  ceiling** (`config.image_count_ceiling=20`, migration 026) — a runaway guard only, **not** a per-impact cap; the
  old per-impact `image_gen_params.max_images` is dead for counting (impact still drives model + resolution).
  `Lookup Image Config` reads both the ceiling and the concurrency cap in one row. Degradations (embed miss / gen
  failure / ceiling) become placeholder ops + a `warnings[]` entry (Block 12 routes these to Post Alert). Verified
  live (Block 4): a Krytycznie-ważne @-mention producing text + 2 generate rendered both `gpt-image-2` images inline
  in order with the correct per-modality footer cost (2.0332 PLN), the batch firing them concurrently (`max_in_flight=2`,
  158.7 s ≈ one image vs ~317 s sequential); the text + 2 generate + 1 embed interleave order was verified in
  isolation. **DONE (Block 12, 2026-06-13):**
  Stage B now auto-calls the resolver (the drafting model emits the block list — see §15.2/§15.4) and forwards
  its outputs into Post Reply; resolver `warnings[]` route to Post Alert. Stage C's prose `Build Comment` renderer
  was **retired** — every reply now renders through the resolver's `rendered_delta`; the `Has Images?` FALSE branch
  feeds a new `Pass Delta` node (rendered_delta + reviewer @mention, no upload) and the web-sources `Źródła` section
  moved into `Finalize Comment`. Verified live end-to-end: generate, text-only regression, Gemini-vision + embed,
  multi-image interleave, and a forced embed-miss degrade (WARN + `[Obraz niedostępny]`, comment still posts).

### 15.7 `CU Webhook Producer (v1)` — automatic triggering

n8n id `eS66Sk6fweQ0EOPa` (ADR-029 + updates). A **workspace-wide** (team-level, no
list/space/folder filter — employees can mention the agent from any task) `taskCommentPosted`
webhook, `responseMode: onReceived` → instant 200. Flow:

`Not Telemetry Task?` guard → signature verification → `Detect Mention` → call spine
(`triggered_by=explicit_mention`).

- **`Not Telemetry Task?`** drops webhooks for the Alerts task `869dj2z2c` *before* anything
  else — a WARN comment on that watched task would otherwise re-fire the webhook into an
  infinite loop (observed and fixed).
- **Signature verification:** webhook `rawBody:true` → native `Verify Signature` Crypto node
  computes `HMAC-SHA256(secret, rawBody)` → `Signature Valid?` (pass → proceed; fail → `Alert
  Bad Signature` WARN, no run). The secret lives in an n8n **`crypto` credential** ("ClickUp
  Webhook HMAC", id `NY5wM3VKKC1jZtQY`) — encrypted in n8n's DB, never in the repo (this
  instance blocks `require('crypto')` and `$env` in Code nodes, so a credential is the only
  repo-safe option). **Rotation:** if ClickUp regenerates the webhook secret, update the same
  credential's `hmacSecret` (no redeploy). Proven live: a genuine ClickUp-signed delivery passed
  the gate; a forged/unsigned POST was rejected with a WARN.
- **`Detect Mention`** reads the just-posted comment **from the webhook payload**
  (`body.history_items[].comment`) and matches the **Agent Haxe** tag (`99811284`). Because the
  webhook fires on *every* comment, a non-mention comment is dropped in-memory with **zero
  ClickUp API calls** (~12 ms; no `Get Comments`). It also extracts `triggering_comment_id` +
  `triggering_comment_text`, passed through to the spine and into `Build Prompt`. Caller/reviewer
  = the **mentioner**.
- **Thread-root reply target (ADR-040).** `Detect Mention` also computes **`reply_to_comment_id`**
  — the comment the spine should reply *into*. ClickUp threads are **single-level**, so replying to a
  comment that is itself a reply returns `Unsupported Entity` and `Post Reply` would fall back to a
  **new top-level comment** (answer lands in a new thread — the observed bug). For a reply,
  `comment.parent` is the top-level (repliable) comment; for a top-level comment it is the task id —
  so `reply_to_comment_id = parent ≠ taskId ? parent : own id`. `Run Agent Spine` feeds this into the
  downstream `triggering_comment_id` channel (the reply target), while the comment's **own** id stays
  the **webhook-dedup key** (`Claim Comment`, ADR-029) — they must differ so distinct mentions in one
  thread aren't de-duplicated.
- **Agent→agent chaining** is enabled (the `author != agent` skip was removed), bounded by a
  **circuit breaker**: `Recent Runs` counts `agent_runs` for the task in the last 10 min;
  `Under Limit?` blocks (+WARN via `Alert Loop Breaker`) at ≥ 8, preventing runaway self-mention
  loops.
- This path does **not** gate the autonomous `Czy dla AI = Tak` flow — that is a separate
  trigger (daily due-date cron + Phase-3 status/field-change webhooks), never mention-gated.
  Future guardrail: route by event/field first, then apply the right gate per route — never a
  single global "must be a mention" filter.
- **Private-space note:** the agent is a Member (reads all public spaces, suiting workspace-wide
  mentions); a mention in a private space the agent isn't a member of triggers but Context Gather
  403s → WARN.

The producer returns 200 immediately and invokes the spine via the `When Called` trigger
(synchronous); the explicit Redis producer/worker enqueue split (§14) lands with the Phase-3
autonomous producers.

### 15.8 Monitoring, alerting & FX (ADR-025)

- **`Post Alert (v1)`** (id `YSCdHlmdf3p9XEUx`) → ClickUp **Alerts task `869dj2z2c`** — the
  single seam every alert routes through (severity / source / message / details).
- **`Error Handler (v1)`** (id `81eplXMD1v5ONhzs`) — set as `errorWorkflow` on Invoke Model /
  Agent Spine / Context Gather (and the producer); throws surface as **CRITICAL** with status
  rollback. Proven by a real failure raising a CRITICAL alert.
- **Proactive WARNs** (non-blocking side branches), all via `Post Alert`: routing-default-used,
  cost-missing, agent_runs-insert-failed, cost-sync-failed, FX-freshness, bad-signature,
  loop-breaker.
- **FX:** `FX Rates Daily (v1)` (id `b7A3y6bXwOj1G3XR`, active) — Schedule 06:00 + manual
  harness → NBP `rates/a/usd` → upsert `fx_rates` (seeded USD/PLN 3.6392, 2026-06-05). `FX
  Freshness Monitor (v1)` (id `XTP16Hb5aMe2Mp5Z`, active) — daily WARN if the latest rate is
  > 4 days old (tolerates NBP weekend/holiday gaps; verified quiet at age 3).
- **Infra glue:** Supabase Postgres credential `EjK3iACTbSNRDhVz` (SSL=require +
  Ignore-SSL-Issues); migrations 002 (`model_routing`, seeded) + 003 (`fx_rates`) applied.
  `N8N_EDITOR_BASE_URL` and `WEBHOOK_URL` (both `https://agents.haxe.ai`) are wired into the VPS
  containers, so alert execution links are clickable and webhook/form URLs generate correctly.

### 15.9 Verification & fault injection

- **End-to-end (2026-06-08), test task `869dhad2q`:** mention → spine run → rules + prefs loaded
  → Sonnet (default, `personal_data=false`) → 4640/1197 tokens → usd 0.0350625 × 3.6392 =
  `cost_pln` **0.127599** → `agent_runs` row written → `[AI] Koszt akcji [PLN]` set → rendered
  Polish draft posted and @-mentioning the mentioner; nothing finalized. Routing matrix correct
  for all five impact tiers (haiku / sonnet / opus + critical nudge/16k).
- **Failure paths fault-injected & proven:** LiteLLM unreachable → CRITICAL via Error Handler;
  routing-default-used (real tier downgraded) → WARN + run completes; cost-missing → fallback
  cost + WARN; agent_runs-insert-failed → WARN + completion still returned. All non-blocking.
- **KM data-quality observation:** test-task descriptions repeat the same guideline block several
  times, bloating the prompt — a signal for the future gap-detection layer, not a pipeline
  defect.
- **Backlog:** tidy test-noise alert comments on `869dj2z2c` (no delete-comment API available).

### 15.10 Planned-workflow design (not yet built)

The canonical design intent for the workflows still to build:

- **Daily Due-Date Producer** — cron 00:00. Queries CU for tasks due today/yesterday with `Czy
  dla AI = Tak` and status ≠ closed. Per task: `agent_runs` idempotency (completed run in last
  24h?), caller = assignee → creator → skip + log, enqueue with staggered ~5 s delays; batch
  summary to GM Reports. Target: overnight drafts ready by 8 AM.
- **Gmail Email Workflow** — watches incoming mail → enqueues email-orchestration job
  (priority 5); worker reads the mail, calls Claude with caller-scoped context, creates a Gmail
  **draft**. Sent-folder watcher (every 15 min) enqueues post-send analysis at priority 10.
- **Weekly Org Proposer** — cron Monday 09:00, priority 10 (after the morning rush). Synthesizes
  recent `agent_run_evaluations` across processes → posts structured proposals to the Process
  Improvements task.
- **Session Cleanup** — hourly cron; expires `conversation_sessions` idle > 24 h.
- **Queue note:** producers will enqueue to Redis and return 200 OK in < 200 ms, priority from
  impact (+1 boost for explicit). The current webhook path calls the spine synchronously; the
  Redis producer/worker split per §14 is inserted as the autonomous producers land in Phase 3.

### 15.11 Remaining in / beyond Phase 2

- **In Phase 2:** selective `linked_doc_leaves` resolution (Docs v3) — only the **current step's
  leaf**, to avoid context pollution.
- **Phase 3:** autonomous **status/field-change webhooks + the daily due-date producer** (both
  gated by `Czy dla AI = Tak`); the **Gmail Email Workflow**. (The PD/sensitivity-classifier seam is
  retired — ADR-043 made the pipeline PD-blind; no classifier is planned.)
- **Phase 4:** the **Weekly Org Proposer** and the learning-loop proposers generally.
- **`Session Cleanup`** hourly cron.
- **ADR-026 identity split:** a read-only telemetry identity vs. the edit-capable agent token
  (the `[AI] Koszt akcji` write currently uses the Member token).

---

## 16. Operating procedures

### 16.1 Daily (10–15 min)

Morning, after overnight batch:

1. Open GM Reports task → read overnight batch summary (due-date task count, distribution by `process_type`).
2. Spot-check 5–10 overnight outputs in their tasks.
3. Check Agent Errors task → any failures or dead-letter items?
4. Query cost from last 24h:
   ```sql
   SELECT triggered_by, COUNT(*), SUM(cost_pln)
   FROM agent_runs
   WHERE created_at > NOW() - INTERVAL '24 hours'
   GROUP BY triggered_by;
   ```
5. Note patterns: is due-date triggering producing useful work or noise?

If overnight runs produce unhelpful outputs: adjust which `process_type` categories
have `Czy dla AI = Tak` by default, or set `Status agenta = Paused` on specific tasks.

### 16.2 Weekly (Monday, 1–2 hours)

1. **Review IC-approved proposals** (15–30 min).
2. **Review weekly org proposer output** (15–30 min).
3. **Apply accepted proposals** to persona / process docs in CU (30–60 min).
4. **GM review with Claude** (30 min) — pull last week's `agent_runs` grouped by `triggered_by`; analyse proactive vs reactive split; assess if due-date triggered runs need tuning.
5. **Queue health** (5 min):
   - Average wait by priority: target < 1 min (p1), < 5 min (p5), < 30 min (p10).
   - Dead letter count: target 0.
   - Retry rate: target < 5% of total jobs.

### 16.3 Monthly (2–3 hours)

- Review trigger-source distribution: what % of work is proactive vs reactive vs explicit?
- Review which `process_type` values benefit most from due-date triggering.
- For process_types where overnight runs consistently produce noise: adjust `Czy dla AI` defaults with the team.
- Queue capacity review: approaching worker concurrency limits?

### 16.4 Adding a new process

1. Create process template in CU with subtask hierarchy.
2. Write or adapt Agent Persona doc in Agent System Space.
3. Decide default `Czy dla AI`:
   - **Tak** — for processes where overnight autonomous runs reliably produce useful drafts.
   - **Nie** — for strategic, sensitive, or real-time judgment work. (Team can still explicitly invoke anytime.)
4. Add `process_type` variant to the Formatter Skill doc.
5. If a new `~command` is needed: author its prompt doc in CU and add a row to the command registry (`command_name` → CU doc).

---

## 17. Mitigations

| Mitigation | Setup time | Purpose |
|---|---|---|
| Auto-restart n8n containers nightly via systemd | 30 min | Memory leak prevention |
| Daily Supabase backup → S3 EU bucket | 1 hour | Disaster recovery |
| Error Trigger workflow → Agent Errors task | 30 min | Silent failure detection |
| Git pull cron every 5 min on VPS | 15 min | Workflow JSON sync |
| Session cleanup hourly | 30 min | Data hygiene, Supabase bloat prevention |
| Queue depth monitoring every 5 min | 30 min | Detect backups before they cascade |
| Storage dead-man's-switch (host systemd timer, every 6h) → Post Alert | done (ADR-046) | VPS disk + n8n execution-DB growth (base64 images) caught early, external to n8n |
| Redis persistence enabled (AOF) | 15 min | Survive container restarts without queue loss |

Total one-off setup: ~4 hours during Phase 0.

---

## 18. Scaling analysis

### 18.1 At 2× team (10 people)
- **Operating:** daily 15 min, weekly 90 min.
- **Architecture:** unchanged.
- **Queue:** handles increased volume without tuning.
- **Cost:** ~800–1,100 PLN/month.

### 18.2 At 5× team (25 people)
- **Operating:** department leads handle dept-specific iterations; AI ops ~1 day/week.
- **Architecture:** possibly 4–5 worker processes.
- **Queue:** may need rate-limit tuning if hitting Bedrock TPM ceilings.
- **Cost:** ~2,000–3,500 PLN/month.

### 18.3 At 10× team (50 people)
- **Operating:** AI ops full-time role.
- **Architecture:** multiple n8n main processes (HA), 6–10 workers, Redis Sentinel, Supabase read replicas, real monitoring dashboards.
- **Queue:** without it this scale would be unmanageable; with it, scaling is capacity tuning.
- **Cost:** ~6,000–12,000 PLN/month.

### 18.4 At 50× team (250 people)
- Different company, probably on an enterprise platform. Queue patterns (priority, retry, rate limiting) map directly to enterprise equivalents — migration is clean, no business logic rewrite.
