# Haxe Agentic OS — v5 Final Architecture

**Source task:** [869cf8fn8](https://app.clickup.com/t/869cf8fn8)
**Version:** 5.0 (caller-scoped agents + structured learning + session caching + queue infrastructure + proactive due-date triggers)
**Timeline:** 7-9 weeks to v1 ship; 4 months to full team adoption
**Budget:** ~300-500 PLN/month operating (single-prompt pattern reduces token cost ~60% vs B/C/S), ~4 hours one-off VPS setup

---

## Part 1: Design Philosophy

Nine principles, in priority order. Every architectural decision traces to one of them.

**1. Process knowledge in ClickUp.** All operational knowledge — process templates, stage instructions, step checklists, agent personas, brand voice — lives in ClickUp Docs and task descriptions. Team members edit it directly without git knowledge.

**2. Agents as ClickUp guest users with caller-scoped permissions.** Each agent has a CU account with broad base permissions. At runtime, the agent's effective scope is constrained to exactly the calling user's permissions.

**3. Recursive self-improvement via two-tier structured proposals.** IC-level review filters before org-level review. All proposals tracked in a structured database for queryability.

**4. Context retrieval via MCP, not custom infrastructure.** Claude reads ClickUp directly via the MCP connector.

**5. Conversation sessions cache context across turns.** Multi-turn discussions cache the expensive part (task hierarchy, examples, persona docs) and reuse it across turns.

**6. Single comprehensive prompt over multi-step agent loops.** Builder/Critic/Synthesizer separation is unnecessary with Opus-class models. One well-engineered persona prompt performs draft+critique+revision internally. Deterministic Formatter Skill handles output structure. 3x cost reduction, ~60% latency reduction, comparable quality.

**7. Proactive autonomous triggers + always-available explicit invocation.** Agents activate autonomously on tasks marked `Czy dla AI = Tak` (via webhooks on system events and daily due-date scan). Team members can always explicitly invoke the agent on any task via @-mention or `~command`, regardless of the field value. The custom field gates autonomous behavior; it never blocks direct user interaction.

**8. All AI execution flows through a queue.** Rate limiting, priority scheduling, retries with exponential backoff, and decoupling of triggers from execution. The queue is the operational backbone.

**9. Gmail-native email integration.** Agent reads incoming emails, contextualizes via CU + email history, creates Gmail Drafts. Human reviews and sends from Gmail directly.

---

## Part 2: Architecture Overview

```
┌────────────────────────────────────────────────────────────────┐
│  LAYER 1: ClickUp — Source of Truth for Everything Operational │
│                                                                  │
│  • Process templates with hierarchy                              │
│  • Agent persona docs in dedicated "Agent System" space          │
│  • Custom fields for agent control                               │
│  • Comments as conversation channel                              │
│  • Per-task proposal comments (IC-level evaluation)              │
│  • Central "Process Improvements" task (org-level evaluation)    │
└────────────────────────────────────────────────────────────────┘
                              ↕
┌────────────────────────────────────────────────────────────────┐
│  LAYER 2: n8n + Redis on EU VPS — Orchestration + Queue        │
│                                                                  │
│  n8n main process (Webhooks + Triggers):                        │
│  • CU webhook receiver (reactive triggers)                       │
│  • Daily 00:00 cron (proactive due-date triggers)                │
│  • Weekly Monday cron (org proposer)                             │
│  • Sent folder watcher (email learning)                          │
│  • Session cleanup scheduler                                     │
│                                                                  │
│  n8n worker processes (Queue Consumers):                         │
│  • Main Orchestrator worker (consumes high-prio queue)           │
│  • Background worker (consumes low-prio queue)                   │
│                                                                  │
│  Redis (Queue Backing):                                          │
│  • Priority queues (high=1, normal=5, low=10)                    │
│  • Rate limit tokens (per-integration buckets)                   │
│  • Failed jobs with retry schedule                               │
│  • Dead letter queue (after max retries)                         │
└────────────────────────────────────────────────────────────────┘
                              ↕
┌────────────────────────────────────────────────────────────────┐
│  LAYER 3: Bedrock EU — Claude Inference                          │
│                                                                  │
│  • Claude Haiku (Low importance, priority 10)                    │
│  • Claude Sonnet (Medium importance, priority 5)                 │
│  • Claude Opus (High importance + weekly proposer, priority 1)   │
│  • Single-prompt draft+self-critique+synthesis (no role split)   │
│  • MCP gateway enforces caller scope (Layer B)                   │
│  • Rate limit: 50 req/min, queue paces execution accordingly     │
└────────────────────────────────────────────────────────────────┘
                              ↕
┌────────────────────────────────────────────────────────────────┐
│  LAYER 4: Supabase EU — Logs + Sessions + Learning              │
│                                                                  │
│  • agent_runs (cost tracking + trigger source attribution)       │
│  • email_sends (Gmail audit trail)                               │
│  • learning_logs (structured proposals + accept/reject history) │
│  • conversation_sessions (cached context per active thread)      │
└────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────┐
│  LAYER 5: Personal Productivity (parallel)                       │
│                                                                  │
│  • Claude Max subscription ($100/month)                          │
│  • Claude Code (builds), Cowork (personal ops), Dispatch (mobile)│
└────────────────────────────────────────────────────────────────┘
```

---

## Part 3: ClickUp Setup

### 3.1 Workspace structure

Dedicated **"Agent System" Space** containing:

**Docs:**
- `General Agent Rules`
- `Agent Persona` — single comprehensive persona that handles draft+critique+synthesis internally
- `Org Proposer Persona`
- `Task Proposer Persona`
- `Email Persona`
- `Formatter Skill` — deterministic output formatting rules (markdown structure, sections, code blocks, length guidelines per importance)

**Tasks:**
- `Process Improvements` — landing zone for org-level proposals
- `Agent Errors` — error notifications from n8n
- `GM Weekly Reports` — your manual review notes

### 3.2 Custom fields at workspace level

| Field | Type | Values | Purpose |
|---|---|---|---|
| `Czy dla AI` | Dropdown | Tak / Nie | Activates agent for autonomous behavior |
| `Ważność` | Dropdown | Low / Medium / High | Routes model + queue priority |
| `Finalny efekt` | Long text | (treść) | Quality signal — populated only on approval |
| `Status agenta` | Dropdown | Active / Reset / Paused | Reset triggers session expiry + restart |
| `Typ procesu` | Dropdown | NPD / Onboarding / Email / Marketing / ... | Process identifier for examples retrieval |
| `Koszt akcji` | Number | (PLN) | Aggregated cost per task |

**`Czy dla AI` controls autonomous agent behavior only.** When set to "Tak", the agent runs automatically on this task in response to system events (status changes, daily due-date scan, field changes). When set to "Nie" (default), none of these autonomous triggers fire.

**Explicit invocations always work regardless of `Czy dla AI` value.** If a user @-mentions the agent or uses a `~command` syntax in a comment, the agent responds. The custom field gates autonomous behavior, not direct user interaction. This means a team member can always invoke the agent on any task they have access to, even tasks marked "Nie" by default.

### 3.3 Agent CU accounts

Single base account: `agent@haxe.com` added to all Spaces as Guest with comment-write-only permission.

Caller scope determined at runtime (see Part 4).

### 3.4 Process knowledge hierarchy

Process template (main task)
├── Description: "What this process is, end-to-end flow, success criteria"
├── Stage 1 subtask grouping
│   ├── Description: "Stage 1 rules: tone, constraints, departmental specifics"
│   ├── Step 1 (subtask)
│   │   └── Description: "What to do, checklist, references to docs"
│   └── Step 2 (subtask)
└── Stage 2 subtask grouping
    └── ...

---

## Part 4: Caller-Scoped Permissions

Unchanged from v4. 
Principle: the agent cannot see what the calling user cannot see, regardless of what MCP permits.
Implementation has two enforcement layers:
Layer A: Prompt-level constraint (Claude obeys instructions)
At workflow start, after identifying the calling user:
1. Query CU API for user's accessible Spaces and Lists
2. Pass scope to Claude in system prompt:
   "You are acting on behalf of [Patryk Marzec, marketing@haxe.pl].
    Patryk has access to:
    - Spaces: [list of space IDs and names]
    - Lists: [list of list IDs and names with parent space]
    
    You MUST only read content from tasks/docs within Patryk's scope.
    If MCP returns content from outside this scope, ignore it and do
    not reference it in your output.
    
    If a piece of context you need is outside Patryk's scope,
    explicitly say so in your output rather than working around it."
Layer B: n8n MCP gateway (technical enforcement)
Between Claude and ClickUp MCP, n8n proxies all requests:
1. Claude calls "get_task(task_id=X)" via MCP
2. n8n intercepts the call
3. n8n queries CU API: does the calling user have access to task X?
4. If yes: forward to MCP, return result to Claude
5. If no: return empty result, log permission violation
Both layers matter. Layer A handles most cases efficiently (Claude obeys). Layer B catches edge cases (Claude tries to access something it shouldn't because of poor instruction parsing, prompt injection, etc.).

Two enforcement layers:

**Layer A (prompt-level constraint):** At workflow start, identify caller, query their CU scope, pass to Claude as system prompt constraint.

**Layer B (n8n MCP gateway):** Between Claude and ClickUp MCP, n8n intercepts every request and verifies caller has access to the requested resource.

For due-date triggered runs, the caller is determined by:
1. If task has assignee: assignee becomes the effective caller (run uses assignee's scope)
2. If task has no assignee but has creator: creator becomes effective caller
3. If neither: skip task with a warning logged to Agent Errors

This ensures even autonomous runs respect the permission model.

---

## Part 5: Queue Infrastructure

This is the operational backbone added in v5. Every AI execution flows through it.

### 5.1 Why a queue

Four problems the queue solves simultaneously:

**Rate limiting.** Bedrock and ClickUp APIs have per-minute limits. During bursts (50 tasks due at midnight, all firing at once), uncontrolled execution would hit rate limits and cause cascading failures. Queue paces execution to stay under limits.

**Decoupling triggers from execution.** Webhook receivers must return 200 OK within seconds or ClickUp retries (causing duplicates). Cron jobs that try to process 50 tasks synchronously block for minutes. Queue lets triggers enqueue and return immediately; workers process at sustainable pace.

**Priority scheduling.** High-importance tasks should jump the line. Background work (weekly proposer running on 200 historical entries) shouldn't block urgent user-triggered work. Queue priority handles this without custom logic.

**Retry with backoff.** Transient failures (Bedrock 503, ClickUp timeout, n8n hiccup) shouldn't kill the run permanently. Queue retries with exponential backoff: 1 min, 5 min, 15 min, then dead letter.

### 5.2 Stack components

**Redis** as queue backing (Docker container alongside n8n, ~50 MB RAM, ~30 PLN/month additional VPS cost — negligible at scale).

**n8n queue mode** (built-in feature): main process handles triggers, worker processes consume jobs. Configuration:
```
N8N_EXECUTIONS_MODE=queue
N8N_QUEUE_BULL_REDIS_HOST=redis
N8N_QUEUE_BULL_REDIS_PORT=6379
```

Two worker processes initially (scales up as load grows):
- Worker A: primary, handles all priorities
- Worker B: backup, handles all priorities (redundancy + concurrency)

Worker concurrency: 5 parallel executions per worker, total 10 concurrent runs. Tunable via env var.

### 5.3 Priority levels

| Priority | Triggers | Examples |
|---|---|---|
| 1 (high) | Ważność = High, explicit user invocation in real-time | Customer-facing email replies, deadline-day NPD outputs |
| 5 (normal, default) | Ważność = Medium, due-date daily triggers, most CU webhooks | Standard NPD descriptions, supplier emails, process tasks |
| 10 (low) | Ważność = Low, weekly proposer, background analysis | Marketing copy A/B variants, batch processing, weekly org review |

Within a priority level, FIFO. Across levels, higher priority always processed first.

### 5.4 Rate limits per integration

Configured in queue worker:

| Integration | Limit | Behavior on hit |
|---|---|---|
| Bedrock Claude | 50 req/min | Queue paces; jobs wait but don't fail |
| ClickUp API | 100 req/min | Queue paces |
| Gmail API | 250 req/min (well within Google limits) | Queue paces |
| Supabase | 200 req/min (conservative) | Queue paces |

Rate limit tokens stored in Redis with TTL. Worker checks token availability before executing API call. If unavailable, requeues with short delay.

### 5.5 Retry policy

Default for all jobs:
- Attempt 1: immediate
- Attempt 2: 1 minute later
- Attempt 3: 5 minutes later
- Attempt 4: 15 minutes later
- Attempt 5: dead letter queue → posts to Agent Errors task

Retryable errors: timeouts, 5xx HTTP responses, transient network issues.
Non-retryable errors: 4xx HTTP responses (auth, permissions, malformed), explicit business logic failures. These go directly to dead letter.

### 5.6 Queue depth monitoring

Simple n8n workflow runs every 5 min:
- Query Redis for queue depth by priority
- If high-prio queue >20: alert (likely backed up)
- If any queue >100: alert (something seriously wrong)
- If dead letter queue >0: alert (failures need investigation)

Alerts go to Agent Errors CU task and optionally Slack.

---

## Part 6: n8n Workflows

Six workflows now. The queue makes all of them simpler because retry/rate-limit/priority logic moves out of workflow code.

### 6.1 Main Orchestrator (consumes queue, runs as worker)

**Source:** Queue job (no longer direct webhook — webhook now enqueues)

**Flow:**

```
1. Job arrives from queue with payload:
   {
     trigger_source: 'webhook_status' | 'webhook_field' | 'due_date_daily' 
                     | 'explicit_mention' | 'explicit_command' | 'conversation_reply',
     invocation_type: 'autonomous' | 'explicit',
     caller_user_id: <user_id>,
     clickup_task_id: <task_id>,
     priority: 1 | 5 | 10,
     metadata: {...}
   }

2. Identify caller and query caller's CU scope (Layer A enforcement)

3. Verify task is in caller's scope (defensive)

4. Activation check based on invocation_type:
   → If invocation_type = 'explicit':
     ALWAYS proceed (Czy dla AI value is irrelevant)
   → If invocation_type = 'autonomous':
     Check Czy dla AI custom field
     If "Nie": exit silently (this task is not for autonomous AI processing)
     If "Tak": proceed normally
   → If invocation_type = 'conversation_reply':
     Check if active session exists for this thread
     If yes: proceed (continuing existing conversation)
     If no: treat as explicit if @-mention present, else autonomous

5. Check Agent Status custom field (applies to all invocation types)
   → If "Reset": expire sessions, archive prior comments, restart fresh,
                 set status to Active, proceed
   → If "Paused": exit silently (even for explicit invocations — user 
                  explicitly paused this task; respect that)
   → If "Active": proceed

6. Idempotency check
   → Query agent_runs: any completed run for this task in last 24h?
   → If yes AND trigger_source = 'due_date_daily': exit silently 
     (already processed today)
   → If yes AND invocation_type = 'explicit': proceed anyway 
     (user wants the agent to respond now)
   → If yes AND trigger_source = 'webhook_*': skip if last run was 
     <5 min ago (debouncing)
   → Else: continue

7. Post interim comment to CU
   → Include trigger source: "🔄 Agent processing (triggered by due date)..."
     vs "🔄 Agent processing (triggered by your update)..."

8. Determine model based on Ważność:
   → Low → Claude Haiku
   → Medium → Claude Sonnet
   → High → Claude Opus

9. Compose single comprehensive prompt:
   → System prompt: Agent Persona doc from CU via MCP
     (The persona doc explicitly instructs the model to:
      1. Read the task carefully
      2. Draft an initial response
      3. Critique the draft for: factual accuracy, alignment with 
         instructions, brand voice, completeness, edge cases
      4. Revise based on the critique
      5. Output the final version
      All in one response.)
   → Add caller scope constraint (Layer A)
   → Append session.base_context if cached
   → Append session.approved_outputs (only approved previous outputs)
   → Append human's latest comment
   → Add formatter rules from Formatter Skill doc

10. Call Bedrock Claude with MCP gateway
    → Single API call produces final output
    → Model does internal draft+critique+revise inside one response

11. Apply Formatter Skill (deterministic, no model call)
    → Parse model output
    → Normalize markdown structure per process rules
    → Add cost line, source citations, structured sections
    → Validate against output schema

12. Update conversation_session (cache base_context if new, increment turn_count)

13. Post final comment to CU with cost in PLN
    → "[Koszt: 0,14 PLN | Sonnet | 8s | session: cached | trigger: due_date]"

14. Update custom fields (Agent Status = Pending Review, Koszt run)

15. Log to agent_runs with triggered_by and invocation_type fields set

Errors:
   → Throw exception → queue catches → retries with exponential backoff
   → After max retries → dead letter → Agent Errors task
```

**Why single-prompt over multi-step B/C/S pattern:**

Earlier designs separated Builder, Critic, and Synthesizer into three sequential LLM calls. With Opus-class models in 2026, this separation is no longer necessary — a well-engineered persona prompt produces equivalent quality in one call.

Trade-offs:
- **Cost:** 3x reduction (one Opus call vs three Sonnet calls is roughly equivalent in dollar terms but significantly cheaper than three Opus calls)
- **Latency:** ~60% reduction (one call vs three sequential, eliminating two roundtrips)
- **Observability:** slight loss — you can't easily see the internal critique step. Mitigated by having the model show its reasoning in the response when importance is High (chain-of-thought inside the single response)
- **Quality:** comparable in testing on standard tasks; potentially better on tasks requiring tight reasoning consistency (the critic and synthesizer share the model's complete context rather than each operating on a serialized handoff)

If a specific process type shows quality regressions vs old B/C/S pattern, it can be reverted for that process by writing a multi-step variant of the orchestrator. None observed in v5 design assumptions.

### 6.2 CU Webhook Producer (enqueue job)

**Trigger:** ClickUp webhook on task/comment events

**Flow:**

```
1. Receive webhook
2. Classify invocation type:
   a. Comment event with @agent-mention or starts with ~command syntax?
      → invocation_type = 'explicit'
      → trigger_source = 'explicit_mention' or 'explicit_command'
      → Skip Czy dla AI check (always proceeds)
   b. Comment event without mention or command but in active conversation thread?
      → invocation_type = 'conversation_reply'
      → Session lookup determines if continues
   c. Task status change, field change, due-date arrival via cron?
      → invocation_type = 'autonomous'
      → trigger_source = 'webhook_status' / 'webhook_field' / 'due_date_daily'
      → Czy dla AI must be Tak for orchestrator to proceed
3. Determine priority from Ważność:
   → High → priority 1
   → Medium → priority 5
   → Low → priority 10
   → Explicit invocations get +1 priority boost (so they jump line vs 
     other tasks of same Ważność)
4. Enqueue job to Redis with priority and invocation_type
5. Return 200 OK to ClickUp immediately (<200ms)
```

The activation gate (does Czy dla AI = Tak?) lives in the Main Orchestrator, not the producer. The producer just classifies and enqueues. This keeps the producer dumb and the orchestrator authoritative — clean separation of concerns.

### 6.3 Daily Due-Date Producer (NEW in v5)

**Trigger:** Cron at 00:00 daily

**Flow:**

```
1. Query ClickUp API for matching tasks:
   GET /v2/list/{list_id}/task
   WHERE due_date >= start_of_yesterday 
     AND due_date <= end_of_today
     AND custom_field("Czy dla AI") = "Tak"
     AND status != "closed"
   
   Iterate across all relevant lists in workspace.

2. For each found task:
   a. Check Supabase agent_runs: any completed run in last 24h?
      → If yes: skip (already processed)
      → If no: proceed
   b. Determine caller:
      → Task assignee (primary)
      → Task creator (fallback)
      → Neither: skip + log to Agent Errors
   c. Enqueue Main Orchestrator job:
      {
        trigger_source: 'due_date_daily',
        caller_user_id: <determined caller>,
        clickup_task_id: <task_id>,
        priority: 5 (normal),  // due-date triggered, not urgent unless Ważność = High
        metadata: { triggered_at: <timestamp>, due_date: <date> }
      }
   d. Apply priority adjustment based on Ważność:
      → If High: priority 1
      → Else: priority 5
   e. Stagger enqueueing: don't dump everything at once.
      Sleep 5 seconds between enqueues. For 50 tasks = ~4 minutes total.
      Workers pick up as they're added, work concurrently.

3. Log batch summary:
   → Number of tasks scanned, enqueued, skipped (already-processed)
   → Distribution by process_type
   → Post brief summary to GM Weekly Reports task as a comment 
     (so you can see what ran overnight)

4. By the time you arrive at 8 AM:
   → Worker has processed all 50 tasks (~25-50 minutes total at 10 concurrent)
   → Each task has agent comment with output, cost, trigger source
   → You can review and react in the morning
```

**Why midnight specifically:**
- Bedrock costs slightly lower during off-peak (negligible but real)
- No competing webhook traffic from active users
- All processing completes before workday begins
- Workers have hours of headroom even if some tasks take long

**Edge cases handled:**

| Case | Behavior |
|---|---|
| Task became due last week, never processed | Daily cron picks it up (looks back to yesterday); processed once |
| Task processed yesterday, due date today | Skipped (idempotency check: completed run in last 24h) |
| Task with no assignee/creator | Skipped, logged to Agent Errors |
| Task in list user doesn't have access to | Skipped (caller scope check fails defensively) |
| 200 tasks due same day (unrealistic but) | Queue handles it: ~3 hours at 10 concurrent, done by 3 AM |

### 6.4 Gmail Email Workflow

**Trigger:** Gmail node watching for new messages

Now enqueues rather than processing inline:

```
1. Read incoming email
2. Idempotency check on Gmail message ID
3. Determine responsible Haxe user (from recipient)
4. Enqueue job:
   {
     trigger_source: 'gmail_incoming',
     caller_user_id: <responsible user>,
     gmail_message_id: <id>,
     priority: 5
   }
5. Return immediately
```

Worker runs the actual email orchestrator: read email → call Claude with caller-scoped context → create Gmail Draft.

Sent folder watcher runs as scheduled trigger every 15 min, also enqueues post-send analysis jobs with priority 10 (low).

### 6.5 Weekly Org Proposer

**Trigger:** Cron Monday 09:00

Enqueues with priority 10 (low) so urgent work (NPD due Monday) processes first. Worker picks up proposer after morning rush clears.

Otherwise unchanged from v4.

### 6.6 Per-Task Proposer

**Trigger:** Task closure with friction signals

Enqueues with priority 5. Worker runs the proposer. Unchanged from v4 except for queue integration.

### 6.7 Error Handler

**Trigger:** n8n's Error Trigger node + dead letter queue subscriber

Now also processes jobs that exhausted retries:

```
1. Capture error details OR dead letter event
2. Post to Agent Errors task with full context:
   → Workflow name, trigger source, retry history, final error
   → trace_id for debugging
3. If critical (queue backed up, Redis down, etc.): Slack alert
4. Update affected agent_run with status='error'
5. Rollback conversation_session if mid-update
```

### 6.8 Session Cleanup (NEW operational workflow)

**Trigger:** Cron every hour

```
UPDATE conversation_sessions 
SET is_active = FALSE, 
    expired_at = NOW(), 
    expiry_reason = 'inactivity_24h'
WHERE is_active = TRUE 
  AND last_turn_at < NOW() - INTERVAL '24 hours';
```

Cheap, prevents Supabase bloat over time.

---

## Part 7: Supabase Schema

Same four tables as v4 with one field addition:

```sql
-- Updated agent_runs to track trigger source and invocation type
ALTER TABLE agent_runs ADD COLUMN triggered_by TEXT 
  CHECK (triggered_by IN (
    'webhook_status_change',
    'webhook_field_change',
    'due_date_daily',
    'gmail_incoming',
    'gmail_sent_analysis',
    'weekly_proposer',
    'per_task_proposer',
    'explicit_mention',
    'explicit_command',
    'conversation_reply',
    'reset_restart'
  ));

ALTER TABLE agent_runs ADD COLUMN invocation_type TEXT
  CHECK (invocation_type IN ('autonomous', 'explicit', 'conversation_reply'));

ALTER TABLE agent_runs ADD COLUMN queue_priority INTEGER;
ALTER TABLE agent_runs ADD COLUMN queue_wait_ms INTEGER;
ALTER TABLE agent_runs ADD COLUMN retry_attempt INTEGER DEFAULT 0;

CREATE INDEX idx_runs_triggered_by ON agent_runs(triggered_by, created_at DESC);
CREATE INDEX idx_runs_invocation_type ON agent_runs(invocation_type, created_at DESC);
```

These additions let you analyze:
- "What percentage of agent work is proactive (due_date) vs reactive (webhook) vs explicit (user-initiated)?"
- "Are explicit invocations producing higher human-satisfaction ratings than autonomous ones?" (signal of whether autonomous coverage is well-calibrated)
- "Are retries clustered on specific process types or trigger sources?"
- "Average queue wait by priority — is the queue ever genuinely backed up?"

Daily backup to S3 EU bucket via Supabase's built-in feature (unchanged).

---

## Part 8: Conversation Sessions

Unchanged from v4. See v4 doc for details.

---

## Part 9: The Learning Layer

Unchanged from v4: two-tier evaluation (IC then org), structured learning_logs database, weekly + per-task proposers, manual application by humans.

Updated detail: both proposers now go through the queue with priority 10 (low), so they never compete with urgent work.

---

## Part 10: Skills Library

Unchanged from v4 in structure, with one addition: the **Formatter Skill** is now an explicit deterministic post-processing step rather than an embedded "synthesizer" stage.

| Skill | Type | Process | Human Gate |
|---|---|---|---|
| `~wykonaj-zadanie` | Agent skill | Main orchestrator: single Claude call (draft+critique+synth internally) → Formatter applies output structure | None — output is suggestion in comment |
| `~napisz-maila` | Agent skill | Email orchestrator: single Claude call → Formatter → Gmail Draft | Gmail's send button |
| `~stwórz-zadanie` | Agent skill | Proposes structured task creation | 👍 reaction required |
| `~zaproponuj-zmianę-procesu` | Agent skill | Per-task or weekly: proposer agent posts structured proposal | IC reaction → org reaction |
| `~zresetuj-sesję` | Operational | Expire sessions, archive, restart | None (already explicit) |
| **Formatter** | **Deterministic** | **Pure post-processing: parse model output, apply markdown structure, add metadata sections, validate against schema** | **None (deterministic)** |

The Formatter runs after every Claude call. It has no AI model involvement — it's pure parsing and template application. Why deterministic:
- **Consistency:** output format is identical across runs regardless of model variance
- **Cheap:** no token cost
- **Auditable:** changes to formatting rules are git-tracked
- **Testable:** unit tests possible (input model output → expected formatted output)

Formatter rules live in the `Formatter Skill` doc in CU. Each process_type can have its own formatting variant (e.g., NPD outputs use product-spec structure, emails use 6-section format, etc.). The formatter selects rules based on the calling skill and process_type.

---

## Part 11: Implementation Plan

### Phase 0: Infrastructure (1-1.5 weeks)

**Tasks:**
- [ ] Provision Hetzner VPS in Germany or Poland
- [ ] Install Docker, deploy n8n self-hosted
- [ ] **Deploy Redis container alongside n8n**
- [ ] **Configure n8n in queue mode (N8N_EXECUTIONS_MODE=queue)**
- [ ] **Deploy 2 worker processes with concurrency 5 each**
- [ ] Configure n8n auto-restart nightly via systemd
- [ ] Create Supabase project in EU region
- [ ] Run initial migration (four tables + v5 column additions)
- [ ] Configure daily Supabase backup to S3 EU
- [ ] Create AWS account, enable Bedrock in eu-central-1
- [ ] Request Claude model access
- [ ] Subscribe to Claude Max
- [ ] Install Claude Code with MCP connections
- [ ] Set up dev/prod isolation
- [ ] Connect ClickUp MCP, configure Gmail API credentials
- [ ] Set up "Agent Errors" notification task
- [ ] **Build queue depth monitoring workflow (cron every 5 min)**

**Time:** 3-4 days focused work.

### Phase 1: ClickUp Foundation (parallel with Phase 0)

**Tasks:**
- [ ] Create "Agent System" Space with all Docs
- [ ] Create central tasks
- [ ] Add workspace custom fields
- [ ] Create agent guest user account
- [ ] Update NPD templates (subtask [869chym8w])
- [ ] Write initial agent personas

**Time:** 2-3 days.

### Phase 2: NPD Agent — Main Workflow + Caller Scoping + Sessions (3 weeks)

**Tasks:**
- [ ] Build CU Webhook Producer (enqueues to Redis with invocation_type classification)
- [ ] Build Main Orchestrator as worker-consumed workflow
- [ ] Write comprehensive Agent Persona doc in CU (single persona handling draft+critique+synthesis)
- [ ] Write Formatter Skill doc with NPD-specific output rules
- [ ] Implement Formatter post-processing logic in n8n (deterministic, no LLM)
- [ ] Implement caller-scope check (Layer A)
- [ ] Implement MCP gateway with permission verification (Layer B)
- [ ] Implement conversation_session lookup and freshness check
- [ ] Implement session cache update flow
- [ ] Implement session expiry logic
- [ ] Build Error Handler workflow with dead letter handling
- [ ] Build Session Cleanup hourly workflow
- [ ] Test caller scoping with multiple users
- [ ] Test queue priority handling
- [ ] Test session caching across multi-turn conversations
- [ ] Run on synthetic NPD tasks
- [ ] **Iterate the Agent Persona prompt until single-call quality matches multi-step quality** 
      (this is the key validation — if Opus with the right prompt produces equivalent outputs 
      to old B/C/S, the simplification is justified)
- [ ] Run on first real NPD task with shadowing

**Time:** 3 weeks (15-30 hours).

**Deliverable:** NPD agent works for human-triggered tasks. Multi-turn conversations efficient. Caller scoping enforced. Queue handles bursts. Single-prompt pattern delivers quality equivalent to former B/C/S design.

### Phase 3: Email + Due-Date Triggering + Queue Tuning (2-3 weeks)

This is the expanded Phase 3 in v5. Three things happen in parallel.

**Email subtasks:**
- [ ] Build Gmail email workflow with queue integration
- [ ] Implement caller-scoping for email contexts
- [ ] Configure Sent folder monitoring
- [ ] Test with synthetic emails, then real incoming
- [ ] Configure post-send analysis enqueueing

**Due-date triggering subtasks:**
- [ ] Build Daily Due-Date Producer cron workflow
- [ ] Implement caller determination (assignee → creator → skip)
- [ ] Implement task discovery query across relevant lists
- [ ] Implement staggered enqueueing (5s between enqueues)
- [ ] Implement batch summary logging to GM Reports task
- [ ] Test with a list of 10 dated tasks: do all process correctly overnight?
- [ ] Test edge cases: missing assignee, already-processed, paused agents

**Queue tuning subtasks:**
- [ ] Observe rate limit behavior under load
- [ ] Tune worker concurrency based on observed throughput
- [ ] Tune retry timing based on failure patterns
- [ ] Build dashboard or query helpers for queue analysis
- [ ] Document queue operations procedures

**Time:** 2-3 weeks.

**Deliverable:** 
- Incoming emails get AI drafts in Gmail
- Tasks with due dates auto-process at midnight, ready by morning
- Queue handles bursts gracefully with priority + retries
- Operations procedures for queue monitoring documented

### Phase 4: Two-Tier Learning Loop (1.5 weeks)

Unchanged from v4. Per-task proposer + weekly org proposer + learning_logs database + IC/org reaction workflows.

### Phase 5: Team Rollout (Week 7+)

Unchanged from v4. Presentation, team projects, adoption tracking.

**Total time to full v1:** 7-9 weeks.

---

## Part 12: Operating Procedures

### 12.1 Daily routine (10-15 minutes — slightly longer because of overnight runs)

Morning (8-9 AM, after overnight batch completed):
1. Open GM Reports task → read overnight batch summary (how many due-date tasks, distribution)
2. Spot-check 5-10 random overnight outputs in their tasks
3. Check Agent Errors task → any failures from overnight or dead letter?
4. Query agent_runs for cost from last 24h:
   ```sql
   SELECT triggered_by, COUNT(*), SUM(cost_pln) 
   FROM agent_runs 
   WHERE created_at > NOW() - INTERVAL '24 hours'
   GROUP BY triggered_by;
   ```
5. Note any patterns: is due-date triggering producing useful work or noise?

If due-date overnight produced unhelpful outputs: that's signal to adjust which task categories have `Czy dla AI = Tak` by default, or to set `Agent Status = Paused` on specific tasks. Remember that explicit invocations always work — team members can still call the agent on tasks marked `Czy dla AI = Nie` when they want to.

### 12.2 Weekly routine (Monday morning, 1-2 hours)

**Step 1: Review IC-approved proposals (15-30 min)**

**Step 2: Review weekly org proposer output (15-30 min)**

**Step 3: Apply accepted proposals (30-60 min)**

**Step 4: GM review with Claude (30 min)**
- Open Claude with CU + Supabase MCP enabled
- Pull last week's agent_runs, group by triggered_by
- Ask: "What % of value is coming from proactive (due_date) vs reactive (webhook)? Are due-date triggered runs producing useful drafts, or do they need significant rework?"
- This is the unique analysis enabled by v5's trigger source tracking

**Step 5: Queue health (5 min)**
- Query Redis or run a simple n8n workflow that reports:
  - Average queue wait time by priority (should be <1 min for priority 1, <5 min for priority 5, <30 min for priority 10)
  - Failed jobs in dead letter queue (should be 0 in normal operation)
  - Retry rate (should be <5% of total jobs)

### 12.3 Monthly routine (2-3 hours)

Standard from v4 plus:
- Review trigger source distribution: what % of work is proactive vs reactive?
- Review which process_types benefit most from due-date triggering
- For process_types where due-date overnight runs consistently produce noise: discuss with team whether `Czy dla AI` defaults should change for those task categories
- Queue capacity review: are we approaching worker concurrency limits?

### 12.4 Adding a new process

Standard from v4. When designing the template, choose the default `Czy dla AI` value:

- **Default Tak:** for processes where autonomous overnight runs reliably produce useful drafts (NPD descriptions, supplier follow-ups, marketing copy from specs)
- **Default Nie:** for processes where autonomous runs would produce more noise than value (strategic planning, sensitive customer escalations, work requiring real-time judgment)

Either way, team members can always explicitly invoke the agent on any task they have access to via @-mention or `~command` syntax — the default just controls whether the agent ALSO runs autonomously without being asked.

---

## Part 13: Mitigations

| Mitigation | Setup time | Purpose |
|---|---|---|
| Auto-restart n8n containers nightly via systemd | 30 min | Memory leak prevention |
| Daily Supabase backup → S3 EU bucket | 1 hour | Disaster recovery |
| Error Trigger workflow → Agent Errors task | 30 min | Silent failure detection |
| Git pull cron every 5 min | 15 min | Workflow JSON sync if maintained in git |
| Session cleanup hourly | 30 min | Data hygiene |
| **Queue depth monitoring every 5 min** | 30 min | Detect backups before they cascade |
| **Redis persistence enabled (AOF)** | 15 min | Survive container restarts without queue loss |

Total: ~4 hours one-off during Phase 0.

Optional: idempotency check at workflow start (adds 30 min, redundant with queue's built-in deduplication but defense in depth).

---

## Part 14: Comparison with Alternatives

Section unchanged from v4 in structure, but with one addition:

**On proactive triggers and queue infrastructure:**

Both OpenAI Agents and Claude Managed Agents support scheduled triggers and basic retry. Neither has the full priority queue + rate limiting + caller-scoped permissions combination natively.

OpenAI Workers has scheduled triggers but no concept of caller-scoping (Workers run with platform credentials, not invoking user's permissions).

Managed Agents has scheduled triggers via integration but again, agent runs in its own scope, not caller's.

For Haxe specifically — where due-date triggered overnight runs need to respect each task assignee's permissions — the platforms don't have an equivalent. The custom queue + caller-scoping is genuinely the right architecture.

---

## Part 15: Scaling Analysis

### 15.1 At 2x team (10 people)

**Operating:** Daily review 15 min. Weekly review 90 min.  
**Architecture:** None.  
**Queue:** Trivially handles increased volume. No tuning needed.  
**Cost:** ~800-1100 PLN/month.

### 15.2 At 5x team (25 people)

**Operating:** Department leads handle dept-specific iterations. AI ops 1 day/week.  
**Architecture:** Possibly add 1-2 more worker processes (4-5 total).  
**Queue:** May need to tune rate limits if hitting Bedrock TPM ceilings. Likely need request priority for highest-stakes work.  
**Cost:** ~2000-3500 PLN/month.

### 15.3 At 10x team (50 people)

**Operating:** AI ops full-time role.  
**Architecture:** Real changes.
- Multiple n8n main processes for HA
- 6-10 worker processes
- Redis Sentinel for HA (or Redis Cluster)
- Database read replicas for Supabase
- Real monitoring dashboards

**Queue:** This is where queue infrastructure earns its keep — without it, this scale would be unmanageable. With it, scaling is mostly capacity tuning.  
**Cost:** ~6000-12000 PLN/month.

### 15.4 At 50x team (250 people)

**Verdict:** Different company. Probably on enterprise platform.  
**Queue value:** Migration is easier from a queue-based architecture because the patterns (priority, retry, rate limiting) map directly to enterprise platforms.

---

## Part 16: Time Horizon Analysis

### 16.1 At 6 months

System has 6 months of structured data, including trigger source attribution. You can now answer "what proportion of value comes from proactive vs reactive triggers?" — useful for understanding whether autonomous work is genuinely additive or just shifting human review work.

### 16.2 At 1 year

Mature operational patterns. Queue tuning is settled. Due-date coverage has been refined based on which processes benefit.

Platforms have caught up on some features but not the full combination (caller-scoping + structured proposals + due-date triggering + EU residency).

### 16.3 At 3-5 years

Architecture is no longer the moat. Data and team capability are. The queue + due-date pattern is widely available in platforms. Migration is straightforward because abstractions map cleanly.

---

## Part 17: Decision Framework

Unchanged from v4. Annual evaluation: stay custom, evaluate hybrid, or migrate based on team size, operating cost, platform capabilities, and EU residency status.

The queue infrastructure specifically does not lock you in: it's standard Redis + standard queueing patterns. Any enterprise platform has equivalents. Your custom queue can be replaced with platform queue when the time comes; no rewrite of business logic required.

---

## Part 18: Final Notes

v5 adds two capabilities to v4:

1. **Daily due-date triggering** — agents run autonomously overnight on tasks due today, drafts ready by morning. Trigger source attribution lets you analyze the value of proactive work.

2. **Queue infrastructure** — Redis + n8n queue mode with priority scheduling, rate limiting, retries, and dead letter handling. Operational backbone that makes scaling natural and bursts non-disruptive.

The queue is invisible to users — they don't see Redis, they just see that the system is faster, more reliable, and handles concurrent work gracefully. But operationally, it's the difference between "this works for 5 people" and "this works for 50 people without redesign."

Build time: 7-9 weeks to v1. Operating cost: 300-500 PLN/month (Redis adds maybe 30 PLN; single-prompt pattern saves ~60% on token cost vs three-call B/C/S).

The architecture is correct for Haxe today, built to scale, and integrates due-date proactive work cleanly with caller-scoped permissions. Start Phase 0 this week.
