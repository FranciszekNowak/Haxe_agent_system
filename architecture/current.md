# Haxe Agents — Architecture (current)

Version: v8
Last updated: 2026-05-30
Supersedes: v7

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

## 3. Invocation model

The agent is a single logical entity with multiple effective personalities,
selected per process type via prompt/persona, not via separate accounts.

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

## 5. Database

Supabase (eu-central-1). Seven tables. Authoritative DDL: `supabase/migrations/001_initial_schema.sql`.

- `agent_runs`, `agent_run_evaluations`
- `agent_proposals`, `agent_proposal_evaluations`
- `conversation_sessions` (mutable working state; expired, not deleted, after 24h idle)
- `email_sends` (Gmail audit)
- `schema_migrations`

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

Each skill is a folder under `skills/` with a SKILL.md, examples, and gotchas.
Adding a skill = new persona file + SKILL.md + an entry in the orchestrator's
persona-dispatch map. Adding an agent is mostly content work, not code.

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
- **Claude Code (Opus):** execution, file/repo work, running commands.
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

current.md is updated via targeted diffs, not full-file rewrites, to avoid silently dropping accumulated detail.

---

## 11. Build phases

- **Phase 0** — infrastructure (git, AWS, 1Password, Supabase, VPS, Redis, n8n queue mode). ~80% done; blocked on VPS payment.
- **Phase 1** — ClickUp foundation (Agent System Space, custom fields, first personas).
- **Phase 2** — NPD agent: main workflow, caller scoping, sessions, queue integration.
- **Phase 3** — email + due-date triggering + queue tuning.
- **Phase 4** — learning loop (proposers).
- **Phase 5** — team rollout.

Target: 7–9 weeks to v1.

---

## Infrastructure status (Phase 0)

- **VPS**: Cyberfolks vroot_SPRINT, AlmaLinux 10, 185.25.149.174 (KVM, 4 vCPU / 8 GB / 100 GB, hostname vps57524999).
- **Access**: key-based SSH (ed25519). Non-root sudo user `franciszek` (wheel + docker groups); root reserved for exceptions. firewalld open on ssh/http/https. **Password auth left ON** until the office machine is keyed, then disabled. See ADR-0010.
- **AWS**: account 000500193947 (tax registration corrected to Skalus). Root MFA via passkey. IAM user `haxe-agents-bedrock`. Billing alert 50 USD/mo. Region eu-central-1.
- **Supabase**: provisioned eu-central-1; schema migration 001 applied.
- **Secrets**: all in 1Password; four distinct VPS-related credentials labeled separately. `.env` never committed.
- **Next**: Docker stack (n8n main/worker + postgres + redis) via docker-compose, built in Claude Code.

### Credential architecture

```
YOUR LAPTOP                         THE VPS (185.25.149.174)
-----------                         ------------------------
SSH private key  ──key auth──────►  franciszek account
                                      │
                                      ├─ /opt/haxe-agents/
                                      │    ├─ docker-compose.yml  (also in git repo)
                                      │    ├─ .env                (VPS ONLY, never git)
                                      │    └─ .env.example        (also in git repo)
                                      │
                                      ├─ Docker containers (private network):
                                      │    ├─ n8n-main    listens 127.0.0.1:5678  (private)
                                      │    ├─ n8n-worker  (no public port)
                                      │    ├─ n8n-postgres  port 5432, internal only
                                      │    │    └─ stores n8n workflows + ENCRYPTED Tier-3 creds
                                      │    └─ n8n-redis     port 6379, internal only
                                      │
                                      └─ (later) Nginx  listens 0.0.0.0:443  (public, TLS)
                                                          └─ forwards to n8n localhost:5678

1PASSWORD (off-server source of truth):
  - SSH passwords (Tier 1)
  - N8N_ENCRYPTION_KEY, Postgres pw, n8n UI login (Tier 2)
  - Bedrock / Supabase / ClickUp / Gmail keys (Tier 3)

GIT REPO (no secrets ever):
  - docker-compose.yml, .env.example, architecture docs
```

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

**Tasks:**
- `Process Improvements` — landing zone for org-level proposals
- `Agent Errors` — error notifications from n8n
- `GM Weekly Reports` — operator review notes

### 13.2 Workspace custom fields

| Field | Type | Values | Purpose |
|---|---|---|---|
| `Czy dla AI` | Dropdown | Tak / Nie | Gates autonomous agent behavior |
| `Ważność` | Dropdown | Low / Medium / High | Routes model tier + queue priority |
| `Finalny efekt` | Long text | (treść) | Quality signal — populated only on approval |
| `Status agenta` | Dropdown | Active / Reset / Paused | Reset triggers session expiry + restart |
| `Typ procesu` | Dropdown | NPD / Onboarding / Email / Marketing / … | Process identifier for persona dispatch |
| `Koszt akcji` | Number | (PLN) | Aggregated cost per task |

`Czy dla AI` gates autonomous behavior only. Explicit invocations (@-mention,
`~command`) always work regardless of this field.

### 13.3 Agent CU account

Single base account `agent@haxe.com`, added to all Spaces as Guest with
comment-write-only permission. Runtime scope is the calling user's permissions
(see §3, ADR-004).

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
5. Add skill entry to orchestrator persona-dispatch map if a new `~command` is needed.

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
