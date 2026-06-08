# Haxe Agents — Architecture (current)

Version: v15
Last updated: 2026-06-03
Supersedes: v14

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

3. **AWS Bedrock (eu-central-1)** — Claude inference. Haiku / Sonnet / Opus
   routed by importance (Ważność). EU region for GDPR.

4. **Supabase (eu-central-1)** — application database. Operational logs, threaded
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
│  LAYER 3: AWS Bedrock (eu-central-1) — Claude Inference        │
│  Haiku (Low) / Sonnet (Medium) / Opus (High + proposer)        │
│  Single-prompt draft+critique+synthesis per call               │
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

- **Sensitivity-gated multi-provider routing.** Model invocation is centralized
  behind one "invoke model" sub-workflow; model/provider selection is a discrete
  step taking (importance, sensitivity, task_type). Routing mappings will be
  stored as data in Supabase. A hybrid PII/PI classification step (deterministic
  rules for emails/phones/addresses + lightweight model for non-allowlist names)
  will set sensitivity. Fail-safe: when uncertain/unavailable, default to
  Bedrock-EU (asymmetric risk — a missed PII routed off-EU is a GDPR breach; an
  over-flagged clean task is merely suboptimal). Today everything routes to
  Bedrock-EU. Do not build the classifier or add providers before Phase 2 seams exist.

- **Multimodal I/O.** File references (URLs / ClickUp attachment IDs) are
  first-class through the pipeline; each skill declares its formats; non-text
  outputs stored as attachments. Build the generic file-passing pipe when first
  needed; add specific format adapters per-workflow on demand, never speculatively.

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

Supabase (eu-central-1). Seven live tables, plus two added by migrations 002/003
(decided in ADR-024, **applied 2026-06-03**). Authoritative DDL: `supabase/migrations/`.

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
  'conversation_reply', 'reset_restart'
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
- **Phase 1** — ClickUp foundation. **IN PROGRESS** — research complete (NPD process mapped; observations doc), core model + KM-maintenance confirmed. Pending: custom fields (`Czy dla AI` / `Ważność` / `Typ procesu` — user-created, Polish, global); GLOBAL agent-rules doc; per-person agent-preferences docs.
- **Phase 2** — the spine. **IN PROGRESS** — the read→route→infer half is built and tested end-to-end (`Agent Spine (v1)` composing `Context Gather (v1)` → `Invoke Model (v1)` with importance→model routing; see §15). Remaining: post-back to ClickUp (comment + reviewer @-mention, never auto-finalize), then first real test on the product-description task.
- **Phase 3** — email + due-date triggering + queue tuning.
- **Phase 4** — learning loop (proposers).
- **Phase 5** — team rollout.

Target: 7–9 weeks to v1.

---

## Infrastructure status (Phase 0 — COMPLETE)

- **VPS**: Cyberfolks vroot_SPRINT, AlmaLinux 10, 185.25.149.174 (KVM, 4 vCPU / 8 GB / 100 GB, hostname vps57524999).
- **Access**: key-based SSH (ed25519). Separate keypair per machine — home and office desktops each have their own key installed for `franciszek` (private keys passphrase-free, for non-interactive automation). Non-root sudo user `franciszek` (wheel + docker + NOPASSWD sudoers); root reserved for exceptions. firewalld: ssh/http/https open. See ADR-010.
- **Password auth: DISABLED.** Both workstations (home + office) have key-based SSH access; with both keyed, password authentication was turned off (`PasswordAuthentication no`) as the final hardening step. Access is now key-only.
- **Docker stack**: `/opt/haxe-agents/`, four containers on private bridge network `n8n-internal`, queue mode. Image versions pinned. See ADR-011.
  - `n8n-postgres` (postgres:16) — n8n's internal DB; named volume; healthcheck-gated.
  - `n8n-redis` (redis:7-alpine) — queue backing; AOF persistence enabled; named volume.
  - `n8n-main` (n8nio/n8n:2.22.5) — UI, webhooks, scheduler; binds to 127.0.0.1:5678 only.
  - `n8n-worker` (n8nio/n8n:2.22.5) — queue consumer; concurrency 5.
  - `litellm` (ghcr.io/berriai/litellm, v1.87.0 pinned by digest) — **deployed + verified 2026-06-03** (ADR-024). Internal-only
    LLM gateway (127.0.0.1:4000): signs Bedrock, returns exact token usage + USD cost header, enables prompt
    caching + multi-provider. Becomes the production model-call path (rewire pending, see §15); native Bedrock node = fallback.
    Config in committed `n8n/litellm-config.yaml`; AWS keys + master key from `.env`.
- **Public endpoint**: `https://agents.haxe.ai` — Nginx reverse proxy + Let's Encrypt TLS (certbot, auto-renewing, 90-day). HTTP → HTTPS redirect active. See ADR-012.
- **Build control plane**: Claude Code drives n8n programmatically via the `n8n-mcp` server over the public REST API (`https://agents.haxe.ai/api/v1`). Config in committed `.mcp.json`; the n8n API key is supplied from the machine env var `N8N_API_KEY` (setx; expiry 2026-08-31) and never committed. Windows launch must wrap npx in `cmd /c`. See ADR-018 and ADR-017.
- **AWS**: account 000500193947 (tax reg. Skalus). Root MFA via passkey. IAM user `haxe-agents-bedrock`. Billing alert 50 USD/mo. Region eu-central-1.
- **Supabase**: provisioned eu-central-1; schema migration 001 applied.
- **Secrets**: all in 1Password (Cyberfolks account / Solus / root / franciszek / n8n encryption key / UI creds — separately labeled); `.env` on VPS only, never committed. `N8N_ENCRYPTION_KEY` rotated after initial deploy.
- **Next**: Phase 1 — ClickUp foundation (Agent System Space, custom fields, first personas).

### Credential architecture

```
YOUR LAPTOP                         THE VPS (185.25.149.174)
-----------                         ------------------------
SSH private key  ──key auth──────►  franciszek account (NOPASSWD sudo)
(no passphrase)                       │
                                      ├─ /opt/haxe-agents/
                                      │    ├─ docker-compose.yml  (also in git repo)
                                      │    ├─ .env                (VPS ONLY, never git)
                                      │    └─ .env.example        (also in git repo)
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

## 12. Design principles

Nine principles in priority order. Every architectural decision traces back to one.

1. **Process knowledge in ClickUp.** All operational knowledge — process templates, stage instructions, step checklists, agent personas, brand voice — lives in ClickUp Docs and task descriptions. Team members edit it directly without git knowledge.

2. **Agents as ClickUp guest users with caller-scoped permissions.** Each agent has a CU account with broad base permissions. At runtime, the agent's effective scope is constrained to exactly the calling user's permissions.

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
rights) — see ADR-004 (2026-06-02 update). Runtime scope is meant to narrow to the
calling user's permissions (see §3, ADR-004), but **caller-scoping (Layers A/B) is not
built yet**.

> **Least-privilege model (ADR-026).** The durable control is *capability containment*:
> the LLM holds no credentials and no tools (`Invoke Model` is pure prompt→completion),
> so the agent can only do what deterministic, version-controlled n8n nodes are wired to
> do — default **read + draft-comment only**. The Member token is over-privileged
> (defense-in-depth gap): it is the one identity used for all ClickUp I/O. **Custom-field
> writes are permitted** (resolved 2026-06-08) but **only via deterministic nodes/code,
> never a capability exposed to the LLM** — the Agent-Spine `[AI] Koszt akcji [PLN]` write
> (a fixed `SUM(agent_runs.cost_pln)` set-field call) satisfies this. A dedicated
> Space-scoped telemetry token is optional future hardening (ADR-026).

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

Six workflows plus an error handler:

1. **Main Orchestrator** (worker-consumed) — the core AI execution engine. Receives a queued job; resolves caller scope; checks `Czy dla AI` (autonomous) or skips check (explicit); checks `Status agenta`; runs idempotency check; selects model from Ważność; calls Bedrock with single comprehensive prompt + cached session context; applies deterministic Formatter; updates `conversation_session`; posts result to CU task as comment with cost/model/trigger metadata; logs to `agent_runs`.

2. **CU Webhook Producer** — receives ClickUp webhooks, classifies invocation type (`autonomous` / `explicit` / `conversation_reply`), determines priority from Ważność (+1 boost for explicit), enqueues to Redis, returns 200 OK immediately (<200 ms).

3. **Daily Due-Date Producer** — cron at 00:00. Queries CU for tasks due today or yesterday with `Czy dla AI = Tak` and status ≠ closed. For each: checks `agent_runs` idempotency (completed run in last 24h?), determines caller (assignee → creator → skip + log), enqueues with staggered 5 s delays. Logs batch summary to GM Reports. By 8 AM all overnight drafts are ready.

4. **Gmail Email Workflow** — watches for incoming email; enqueues email orchestration job (priority 5). Worker reads email, calls Claude with caller-scoped context, creates Gmail Draft. Sent folder watcher (every 15 min) enqueues post-send analysis at priority 10.

5. **Weekly Org Proposer** — cron Monday 09:00, priority 10. Runs after morning rush. Synthesises recent `agent_run_evaluations` across all processes; posts structured proposals to Process Improvements task.

6. **Session Cleanup** — cron hourly. Expires `conversation_sessions` inactive for > 24h.

**Error Handler** — n8n Error Trigger + dead letter subscriber. Captures failures with full context (workflow, trigger source, retry history, final error), posts to Agent Errors task, updates `agent_run` status to `error`, rolls back any mid-update session state. Slack alert on critical failures (queue backed up, Redis down).

**Build status (2026-06-03):** none of the six production workflows are built yet,
but the read→route→infer spine exists end-to-end as three tested, composable pieces
— the context-assembly front end, the centralized model-invocation seam (with
importance→model routing live), and an `Agent Spine` that wires them — agent Doc
access is proven, and Bedrock inference from n8n is proven. The build control plane is operational
(Claude Code → n8n MCP; see ADR-018). `Context Gather (v1)`
(`n8n/workflows/context-gather.json`, n8n id `qgM37HdQj78Rn090`) reads a ClickUp
task and assembles the labelled context object (`current_task`, ordered
`ancestor_chain`, stub `linked_doc_leaves`, `truncated_at_depth`) — a Form Trigger
(`taskId`) → a bounded unroll of native ClickUp `Task→Get` fetches gated by IF nodes
→ a pure Code shaping node. Verified live on `Lista testy AI`: a 3-level subtask
returned an ordered ancestor chain, a root task returned `[]`, markdown descriptions
flow through (`includeMarkdownDescription`). Read-only; left inactive between tests.
See ADR-020 for the shape and ADR-019 for the node/credential discipline
(authenticated I/O in credential-aware nodes; Code nodes only shape data).

Two front-end dependencies were verified live (2026-06-03) with throwaway n8n
harnesses (`Doc Access Test`, `Invoke Model smoke test`):
- **Agent Doc access — resolved.** The agent `clickUpApi` token reads ClickUp Docs
  via the **Docs v3 API** (`GET /api/v3/workspaces/{ws}/docs/{doc_id}/pages`, 200,
  full content) — config docs and leaf docs alike. Embedded doc links in a task's
  `markdown_description` arrive as parseable `[Label](…/docs/{doc_id}/{page_id})`
  URLs, so `linked_doc_leaves` resolves by: regex-extract IDs from
  `markdown_description` → Docs v3 GET → flatten. The earlier "no access" was a
  task-node link-rendering / pre-grant artifact. See ADR-004 (2026-06-03 update).
- **Bedrock inference — resolved.** A Claude completion was returned from n8n via
  the native AWS Bedrock node and the EU inference profile
  `eu.anthropic.claude-sonnet-4-6`. The generic AWS credential + HTTP Request path
  cannot sign Bedrock; see ADR-021.

The centralized **`Invoke Model (v1)`** sub-workflow (`n8n/workflows/invoke-model.json`,
n8n id `XcOIVdZnVCCWNPeb`) is built and tested — the ADR-013 invocation seam:
Execute Workflow Trigger (typed contract `prompt`/`importance`/`sensitivity`/`task_type`)
→ a `Select Model` Code node (the discrete selection step, now holding the routing
table) → `Basic LLM Chain` driven by the native AWS Bedrock node whose profile,
`temperature`, and `maxTokensToSample` are all set by expression from the selection
step → a `Shape Output` Set node returning `{ completion, model, provider }`. See
ADR-022 for the shape.

The **importance → model routing** is implemented (ADR-023), resolving the
importance axis of the previously-pending mapping: `Niski`→Haiku 4.5,
`Średni`→Sonnet 4.6, `Wysoki`→Opus 4.5, `Krytycznie ważne`→Opus 4.5 at temp 0.2 /
16k tokens with a prepended deliberation nudge; `n/d`/empty/unknown→Sonnet
(ADR-013 fail-safe). All profiles are EU-resident (GDPR) and were verified
invokable live (2026-06-03). **Caveat:** Opus 4.6/4.7/4.8 exist in eu-central-1 but
are not granted to the account, so Opus tiers use 4.5 until access is requested on
the Bedrock Model-access page (then bump one constant). "Max effort" is approximated
via temperature + max-tokens + the nudge — the native node exposes no
reasoning-budget parameter. The **sensitivity** axis remains deferred (no classifier
yet). Verified per-tier via a throwaway harness (`Niski`→Haiku, `Krytycznie
ważne`→Opus+nudge); harness since deleted.

These two pieces are composed by **`Agent Spine (v1)`** (`n8n/workflows/agent-spine.json`,
n8n id `a8XKaijkMFNBpRBa`): Form Trigger (`taskId`) → `Context Gather (v1)` (now also
callable via an Execute Workflow Trigger; it additionally resolves the importance
custom field to its label) → a `Build Prompt` Code node (stub assembler: context →
one prompt string) → `Invoke Model (v1)`. Verified live end-to-end on `Lista testy
AI` task `869dhad2q`: context + 4-level ancestor chain gathered, importance unset →
Sonnet fail-safe, a high-quality Polish work product returned. All workflows left
inactive between tests. (Observation: ClickUp task descriptions in the test data
repeat the same guideline block several times, bloating the prompt — a KM
data-quality signal for the future gap-detection layer, not a pipeline defect.)

**Infrastructure for the LiteLLM re-platform is LIVE (2026-06-03; ADR-024/025).** The
model-call layer is being moved onto a self-hosted LiteLLM gateway + Supabase routing
+ exact cost. Done and verified this session:
- **Supabase Postgres credential** works (n8n cred id `EjK3iACTbSNRDhVz`; SSL=require +
  Ignore-SSL-Issues). **Migrations 002 (`model_routing`, seeded) + 003 (`fx_rates`) applied.**
- **LiteLLM gateway deployed** (`litellm` container, `127.0.0.1:4000`, v1.87.0 pinned by
  digest). Smoke-tested through all three aliases (`haxe-haiku`/`sonnet`/`opus`): each
  returns a completion with **exact `usage`** and an **`x-litellm-response-cost`** USD
  header. Cost model = that USD figure × the daily NBP USD/PLN rate (→ `fx_rates`).
- **Monitoring core LIVE** (ADR-025): `Post Alert (v1)` (id `YSCdHlmdf3p9XEUx`) →
  ClickUp Alerts task `869dj2z2c`; global `Error Handler (v1)` (id `81eplXMD1v5ONhzs`)
  set as `errorWorkflow` on Invoke Model / Agent Spine / Context Gather. Proven by a
  real failure raising a CRITICAL alert.

**Phase C — COMPLETE (2026-06-08; ADR-024/025/026).** The spine now runs fully on the
LiteLLM gateway + Supabase routing + exact PLN cost, with proactive monitoring:
- **FX cron** `FX Rates Daily (v1)` (id `b7A3y6bXwOj1G3XR`, active): Schedule 06:00 +
  manual harness → NBP `rates/a/usd` → upsert `fx_rates`. Seeded (USD/PLN 3.6392,
  2026-06-05). **FX freshness monitor** `FX Freshness Monitor (v1)` (id `XTP16Hb5aMe2Mp5Z`,
  active): daily check → WARN if latest rate >4 days old (tolerates NBP weekend/holiday
  gaps; verified quiet at age 3).
- **`Invoke Model (v1)` rewired** (id `XcOIVdZnVCCWNPeb`): `Lookup Routing` (Supabase
  `model_routing`, `__default__` fail-safe, DB-error tolerant) → `Resolve Routing`
  (in-code Sonnet last-resort + nudge prepend) → `Call LiteLLM` (HTTP, header-auth
  credential, full response) → `Get FX Rate` → `Compute Cost` → `Insert agent_runs` →
  `Shape Output` (single terminal). Native Bedrock node + chain retained **disabled** as
  fallback. Renames `importance→impact`, `sensitivity→personal_data` (bool, fail-safe
  true) across Invoke Model / Context Gather output / Build Prompt / Agent Spine.
- **Cost:** `x-litellm-response-cost` USD header × latest `fx_rates.rate` = `cost_pln`;
  fallback to `model_routing` USD prices → `cost_missing` WARN. Logged to `agent_runs`
  (live cols: `model_used`, `importance`, `input/output_tokens`, `cost_pln`, …; no
  `provider` col; `triggered_by` NOT NULL → test path logs `explicit_command`/`explicit`).
- **CU cost field** (Agent Spine): `[AI] Koszt akcji [PLN]` = `SUM(agent_runs.cost_pln)`
  for the task (idempotent, drift-free). ⚠ Uses the edit-capable agent Member token —
  flagged for the ADR-026 identity split.
- **Proactive alerts** (ADR-025) all via `Post Alert`: routing-default-used, cost-missing,
  agent_runs-insert-failed (non-blocking side branches), FX-freshness, cost-sync-failed.
- **Verified end-to-end** on test task `869dhad2q`: Sonnet (default), 4640/1197 tokens,
  usd 0.0350625 × 3.6392 = `cost_pln` 0.127599, `agent_runs` row written, CU field set;
  routing matrix correct for all five tiers (haiku/sonnet/opus + critical nudge/16k).

**Failure paths fault-injected & proven (2026-06-08):** LiteLLM unreachable → CRITICAL via
Error Handler; routing-default-used (real tier downgraded) → WARN + run completes;
cost-missing → fallback cost + WARN; agent_runs-insert-failed → WARN + completion still
returned. All non-blocking.

Remaining backlog: set `N8N_EDITOR_BASE_URL=https://agents.haxe.ai` (clickable
alert links); back-fill `001_initial_schema.sql` from live; tidy test-noise alerts/rows
(`869dj2z2c` comments + `FAULT-TEST` agent_runs rows); optional ADR-026 telemetry-token
split (defense-in-depth hardening).

Then (next phase): post the completion back to ClickUp (material in parent, draft as
comment, @-mention reviewer; never auto-finalize — ADR-026); `linked_doc_leaves` resolution
(Docs v3, selectively — only the current step's leaf, not all, to avoid context
pollution); replace `Build Prompt` with the real assembler (GLOBAL agent-rules doc +
person preferences, per the core model).

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
