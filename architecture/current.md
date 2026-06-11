# Haxe Agents — Architecture (current)

Version: v22
Last updated: 2026-06-10
Supersedes: v21

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

3. **AWS Bedrock (eu-central-1) + Anthropic direct + Vertex AI (global)** — model inference via LiteLLM
   gateway. Routed by `(impact, personal_data, modality)`: `personal_data=false` → Anthropic direct;
   `personal_data=true` + `modality='text'` → Bedrock EU; `personal_data=true` + `modality='multimodal_input'`
   → Vertex AI Gemini (global endpoint, DPA+SCCs). See ADR-030, ADR-038, ADR-039.

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
│  LAYER 3: LiteLLM Gateway → Anthropic / Bedrock EU / Vertex AI │
│  PD=false → Anthropic direct (Haiku/Sonnet/Opus/Fable 5)       │
│  PD=true + text → Bedrock EU (Haiku/Sonnet/Opus)               │
│  PD=true + multimodal_input → Vertex AI Gemini (global)        │
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

- **Sensitivity-gated multi-provider routing (routing LIVE, classifier deferred).** Model
  invocation is centralized behind `Invoke Model (v1)`; routing is data-driven via
  `model_routing (impact, personal_data)` composite PK (ADR-030). `personal_data=false`
  → Anthropic direct; `personal_data=true` (GDPR) → Bedrock EU. The sensitivity
  classifier seam exists: `PD Verifier (v1)` always returns `false` until the Phase 3
  classifier (regex rules + optional Haiku call) replaces it — no pipeline changes
  needed. Fail-safe preserved: DB-down falls back to `haxe-sonnet-4-6-direct` + WARN.
  See ADR-031 for the PD Verifier contract.

- **Multimodal I/O (input + image-gen pipelines LIVE, ADR-036/038).** Image attachments from ClickUp tasks
  pass as vision content blocks to the model; Docling extracts text from non-image files (PDF/DOCX/XLSX)
  into the prompt. `personal_data=false` tasks use Anthropic direct aliases (vision-native, no routing
  change). `personal_data=true` + images routes to Vertex AI Gemini (`modality='multimodal_input'`,
  ADR-038/039). Image generation live via LiteLLM Stability/Vertex AI/DALL-E 3 tiers (ADR-036).
  ClickUp attachment upload deferred.

---

## 4. The learning system

Two parallel feedback systems with identical machinery, different subject:

### 4.1 Artifacts (Tier 0)
- `agent_runs` — one row per agent execution (context, trigger, model, cost, status).
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

> **Block 1 — repo↔live re-sync + targeted fixes (2026-06-11, ADR-040/041).** The repo
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
> (so the migrations stay the source of truth, not a forward-note); Block 3's routing migration (now 016)
> must preserve `temperature = NULL` for that row. The `personal_data`/EU apparatus removal itself is
> still pending (Blocks 2–3).

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
- **Phase 2** — the spine. **IN PROGRESS (core path COMPLETE)** — the generic read→route→infer→post-back pipeline (thin `Agent Orchestrator (v1)` → Stage A `Assemble Context and Build Prompt` → B `Execute LLM Call` → C `Post Reply`; ADR-036), signature-verified @-mention triggering (`CU Webhook Producer (v1)`, ADR-029), thread-aware replies via `conversation_sessions`, and the `PD Verifier (v1)` seam + `Search (v1)` + Layer-B caller-scoped reads (ADR-031) are all live and verified end-to-end. See *Phase 2 status* below and §15. Remaining: selective `linked_doc_leaves`; autonomous status/due-date triggers (Phase 3).
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
  - `n8n-worker` (n8nio/n8n:2.22.5) — queue consumer; concurrency 5.
  - `litellm` (ghcr.io/berriai/litellm, v1.87.0 pinned by digest) — **deployed + active** (ADR-024/030).
    Internal-only LLM gateway (127.0.0.1:4000): signs Bedrock, returns exact token usage + USD cost header,
    multi-provider. **IS the production model-call path** (§15). Six versioned aliases: three Anthropic direct
    (`haxe-haiku/sonnet/opus-*-direct`) + three Bedrock EU (`*-bedrock`) + two Gemini EU (`haxe-gemini-flash-eu`,
    `haxe-gemini-pro-eu`). `ANTHROPIC_API_KEY` in `.env` and passed through via `docker-compose.yml`; confirmed
    working 2026-06-08. Config in committed `n8n/litellm-config.yaml`; credentials in `.env` (never committed).
    Native Bedrock node retained in n8n **disabled** as fallback. Gemini EU aliases added (ADR-038):
    `haxe-gemini-flash-eu` (`vertex_ai/gemini-3.5-flash`) and `haxe-gemini-pro-eu`
    (`vertex_ai/gemini-3.1-pro-preview`), both `vertex_location: global` (ADR-039). Auth: ADC via
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
  composes `Context Gather (v1)` → `PD Verifier (v1)` (stub) → `Search (v1)` → `Build Prompt`; B runs
  `Invoke Model (v1)`; C posts the thread-aware draft and owns the ClickUp side-effects. (The earlier
  monolithic 26-node `agent-spine.json` was decomposed in place — `a8XKaijkMFNBpRBa` is now the
  orchestrator.)
- **Model layer — DONE.** Self-hosted LiteLLM gateway, data-driven routing on `(impact,
  personal_data)` — `false` → Anthropic direct, `true` → Bedrock EU (ADR-030) — exact USD ×
  daily NBP FX → `cost_pln`, logged to `agent_runs` and summed into `[AI] Koszt akcji [PLN]`.
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
now realized as a **thin `Agent Orchestrator (v1)`** that calls three stage subworkflows in
sequence — **A `Assemble Context and Build Prompt (v1)` → B `Execute LLM Call (v1)` → C `Post Reply
(v1)`** — each with its own execution log and a shared status-reset + alert on failure. This
decomposition (commit `ff14622`, ADR-036) replaced the earlier monolithic `Agent Spine (v1)` and is
the canonical form going forward.

| Workflow | Role | State |
|---|---|---|
| **`Agent Orchestrator (v1)`** (was "Agent Spine"/"Main Orchestrator", id `a8XKaijkMFNBpRBa`) | Thin orchestrator: set status → A → B → C + shared Reset+Alert | **LIVE** |
| **`Assemble Context and Build Prompt (v1)`** (Stage A) | Context Gather + PD Verifier + Search + Build Prompt | **LIVE** |
| **`Execute LLM Call (v1)`** (Stage B) | Invoke Model → drafted reply + cost | **LIVE** |
| **`Post Reply (v1)`** (Stage C) | Post draft comment, cost field, status flip (owns CU side-effects) | **LIVE** |
| **`Context Gather (v1)`** | Assemble labelled task context (task + ancestor chain + fields) | **LIVE** |
| **`Invoke Model (v1)`** | Centralized model-call seam: route → LiteLLM → exact PLN cost → log | **LIVE** |
| **`Search (v1)`** | Comment + external-artifact retrieval, Layer-B scoped | **LIVE** |
| **`PD Verifier (v1)`** | Sensitivity-classifier seam (stub → Phase 3 classifier) | **LIVE (stub)** |
| **`CU Webhook Producer (v1)`** | Comment-webhook trigger → verify → detect mention → call spine | **LIVE (@-mention)** |
| **`Post Alert (v1)`** | Centralized alert seam → ClickUp Alerts task | **LIVE** |
| **`Error Handler (v1)`** | Global `errorWorkflow`: throws → CRITICAL + status rollback | **LIVE** |
| **`FX Rates Daily (v1)`** + **`FX Freshness Monitor (v1)`** | Daily NBP USD/PLN upsert + staleness WARN | **LIVE** |
| **`Read Input (v1)`** (id `zgGpONulGMohQQqI`) | Unified multimodal input reader (Blocks 2+3, ADR-036 "Input readers unified"), pure/branch-free: self-fetches `{ clickup_task_id }` → `Classify Attachment` (Switch) → **image** = URL passthrough (skips Docling) / **extractable** = Docling → `Merge` → `{ blocks(text+image, ordered), clickup_task_id, warnings }`. Reader owns ordering; Stage A (Block 5) fires `warnings` via `Post Alert (v1)`. Router + visual reader retired | **LIVE (Phase 2, input)** |
| Daily Due-Date Producer | 00:00 cron: enqueue due-today/yesterday `Czy dla AI=Tak` tasks | **Planned (Phase 3)** |
| Gmail Email Workflow | Incoming mail → Gmail draft; sent-folder post-send analysis | **Planned (Phase 3)** |
| Weekly Org Proposer | Mon 09:00 cron: synthesize evaluations → org proposals | **Planned (Phase 4)** |
| Session Cleanup | Hourly cron: expire idle `conversation_sessions` | **Planned** |

### 15.2 `Agent Orchestrator (v1)` + Stages A/B/C — the generic engine

`n8n/workflows/agent-orchestrator.json`, n8n id `a8XKaijkMFNBpRBa`, **11 nodes** (thin). Entry is
either a Form Trigger (`taskId`, manual testing) or a `When Called` Execute-Workflow trigger (from
the webhook producer). It sets status **W trakcie** on a **parallel fire-and-forget side-branch off
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
  id `GGTBvFBgGSNbtUR6`, 13 nodes): `Context Gather (v1)` → `PD Verifier (v1)` → Workspace Search →
  Decide Research → Load Agent Rules → **`Read Input (v1)`** → `Build Prompt`. Returns the prompt payload +
  assembled context, plus **`image_blocks_json`** (input image refs for the vision model, non-PD) and
  `input_warnings_*`. Folds attachment **text** into the prompt and fires the reader's `warnings` via
  `Post Alert (v1)` on a reconverging side branch (`Return Context` stays the sole terminal). Multimodal
  input (ADR-036/038 Block 5): images present → `modality='multimodal_input'` set on the context payload →
  routing returns Gemini EU alias for PD=true tasks (ADR-038 supersedes former "PD guard drops images"
  stance); Anthropic direct handles vision for PD=false tasks unchanged.
- **Stage B — `Execute LLM Call (v1)`** (`n8n/workflows/execute-llm-call.json`, id `9qdJA4xnAGbxqkt9`,
  8 nodes): `Invoke Model (v1)` → drafted reply + cost; forwards `image_blocks_json` to Invoke Model.
  **Return path linearized** (`Call Invoke Model → Sum Task Cost → Update CU Cost Field → Return LLM
  Result`, the sole terminal) so the sub-workflow deterministically returns `completion` — fixed a
  return-determinism bug where the parallel cost-sync branch's empty output could be returned instead,
  silently dropping the draft (ADR-036 Block 5).
- **Stage C — `Post Reply (v1)`** (`n8n/workflows/post-reply.json`, id `t17moGs7Vxo5ZcFv`, 9 nodes):
  posts the thread-aware draft comment, writes the cost field, flips status **W trakcie → Zakończono**.
  C owns every ClickUp side-effect (comment, cost, status, and — once multimodal lands, ADR-036 —
  image upload + temp cleanup).

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

### 15.4 `Invoke Model (v1)` — routing + exact cost

`n8n/workflows/invoke-model.json`, n8n id `XcOIVdZnVCCWNPeb`. The ADR-013 model-call seam,
running on the self-hosted **LiteLLM gateway** (`litellm` container, `127.0.0.1:4000`, v1.87.0
pinned by digest; ADR-024/030). Typed Execute-Workflow contract (`prompt` / `impact` /
`personal_data` / `task_type`). Node chain:

`Lookup Routing` (Supabase `model_routing`, composite PK `(impact, personal_data)`,
`__default__` fail-safe row, DB-error tolerant) → `Resolve Routing` (in-code Sonnet last-resort
+ deliberation-nudge prepend) → `Call LiteLLM` (HTTP, header-auth credential, full response) →
`Get FX Rate` → `Compute Cost` → `Insert agent_runs` → `Shape Output` (single terminal,
returns `{ completion, model, provider }`). The native AWS Bedrock node + `Basic LLM Chain` are
**retained disabled** as a fallback path (a generic AWS credential + HTTP Request cannot sign
Bedrock — only the native node can; ADR-021).

- **Provider routing (ADR-030/038):** Three legs via `(personal_data, modality)`:
  - `personal_data=false` → **Anthropic direct**: `haxe-haiku-4-5-direct`, `haxe-sonnet-4-6-direct`,
    `haxe-opus-4-8-direct`, `haxe-fable-5-direct`. Auth: `ANTHROPIC_API_KEY`. All Claude 4.x aliases
    are vision-capable; non-GDPR `multimodal_input` tasks route here with no alias change.
  - `personal_data=true`, `modality='text'` → **Bedrock EU**: `haxe-haiku-4-5-bedrock`,
    `haxe-sonnet-4-6-bedrock`, `haxe-opus-4-5-bedrock`. Auth: AWS IAM (eu-central-1). Bedrock Fable 5
    pending model-access grant; Krytycznie ważne GDPR text path uses Opus 4.5 until then.
  - `personal_data=true`, `modality='multimodal_input'` → **Vertex AI Gemini (global)**:
    `haxe-gemini-flash-eu` (`vertex_ai/gemini-3.5-flash`), `haxe-gemini-pro-eu`
    (`vertex_ai/gemini-3.1-pro-preview`). Auth: ADC via `/secrets/vertex-key.json`. GDPR basis:
    Vertex AI DPA+SCCs (ADR-039). `Parse Response` detects Gemini aliases → sets provider to
    `'litellm/vertex-eu'`. ⚠ Gemini 3.x uses **thinking tokens** billed on top of text: ~65
    reasoning + 1 text tokens per one-word reply (Flash), ~133 + 1 (Pro). Real task cost will
    significantly exceed text-token count alone.
  `agent_runs.model_used` stores the versioned model ID from the LiteLLM response body. Migrations 008
  (routing composite PK) and 013 (multimodal image tiers) applied; migration 014 (`gemini_multimodal_routing`)
  pending rename + application.
- **Impact → tier (ADR-023):** `Niski`→Haiku 4.5, `Średni`→Sonnet 4.6, `Wysoki`→Opus,
  `Krytycznie ważne`→Opus at temp 0.2 / 16k tokens with a prepended deliberation nudge;
  `n/d`/empty/unknown→Sonnet (fail-safe). "Max effort" is approximated via temperature +
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
  `-direct` Claude aliases are vision-capable, so no routing/`modality` change. `Call LiteLLM` and
  `Fallback to Opus` both send these messages. ⚠ A provider-unprocessable image (e.g. 1×1 px) currently
  400s the whole call → graceful text-only fallback is deferred to Block 6.

See ADR-022 (shape), ADR-023 (routing), ADR-024 (LiteLLM/cost), ADR-030 (multi-provider).

### 15.5 `Search (v1)` + `PD Verifier (v1)`

Two sub-workflows sit between Context Gather and Build Prompt (ADR-031).

- **`PD Verifier (v1)`** (id `hzwmak7UBpuHaiTO`) — stub returning `personal_data: false`. The
  seam for the Phase 3 sensitivity classifier (regex rules + optional Haiku call); replacing
  the stub requires no changes to Agent Spine or Search.
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

- **Reviewer** = the **mentioner** (webhook path) / the manual triggerer (operator default,
  optional `reviewer_user_id` form field). The automatic assignee→creator rule is data-ready
  (Context Gather returns assignee/creator) and applies when the autonomous triggers land.
- **Thread-aware (`conversation_sessions`):** `Check Session` (Postgres) looks up an active row
  for `(clickup_task_id, caller_user_id)`. If found, the reply nests in the thread via `POST
  /api/v2/comment/{comment_root_id}/reply` (on failure → new top-level comment + WARN); if not,
  a new top-level comment is posted and its returned ID anchors the thread as `comment_root_id`
  (`Upsert Session New`). Both paths upsert via `ON CONFLICT (clickup_task_id, comment_root_id,
  caller_user_id) WHERE is_active = true`; upsert failure → WARN side branch, run continues.

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
  gated by `Czy dla AI = Tak`); the **Gmail Email Workflow**; the sensitivity classifier behind
  `PD Verifier (v1)`.
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
