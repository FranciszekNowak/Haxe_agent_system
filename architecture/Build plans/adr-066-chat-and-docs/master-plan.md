# Plan: Land ADR-066 (operating from ClickUp Chat and Docs) + build the Chat/Doc surfaces

## Context

The agent today only reaches **task** comments: a ClickUp task-comment webhook triggers it, and it
delivers a threaded task-comment reply. It cannot be invoked from **Chat** or **Docs**. A draft ADR
(`C:\Users\fn\Downloads\061-operating-from-chat-and-docs.md`) decides how to fix this: make invocation
**mention-driven and surface-agnostic** — an @-mention of the bot user on any surface is the trigger.
Ingestion is **surface-disjoint**: the existing webhook fast-path handles Tasks and Chat (both fire
ClickUp webhooks), and a **once-a-minute mentions poll, pre-gated to Doc-surface mentions only**, handles
Docs (which fire no webhook). The job carries a `surface` + `surface_ref`; per-surface read and delivery
adapters branch on it; delivery is always a **threaded reply under the invoking comment/message** and
never an in-place Doc edit (ADR-050).

Two things prompted this plan. First, the draft must be **placed in the repo as an ADR** — but its claimed
number (061) is already taken by `061-dynamic-context-loading.md`, so it is renumbered to **ADR-066** and
one stale cross-reference is repointed. Second, the draft's build sequence (Blocks 0–4) must be **grounded
in the real workflows and the queue-consumer service** so it is executable, not just sketched.

Decisions locked with the operator: renumber to **ADR-066**; repoint "References: ADR-060 (floor-vs-tail
context)" → **ADR-061 (dynamic context loading)**; produce the **full build sequence** (Blocks 0–4).

## Block status

| Block | Scope | Status |
|-------|-------|--------|
| Part 1 | Land ADR-066 + master plan | **DONE** (commit `effdb99`) |
| Block 0 | Capability gates G1–G5 | **DONE** (commit `f25c072`). Resolved: Chat reachable but **poll-only** (no webhook event, no automation); Doc surface dropped. See `block-0-findings.md` + ADR-066 amendment 2026-06-29. |
| Block 1 | Surface dimension (`task` \| `chat`) on job + spine | **DONE** — `surface`/`surface_ref` carrier in queue-consumer (deployed) + ingress + orchestrator; task path verified unchanged end-to-end (exec 5424, threaded reply, 0 alerts). current.md §15.10 carries the contract note. |
| Block 2 | Chat **poll** producer + read + threaded-reply delivery | **IN PROGRESS** — foundation landed (migration 049: cursor + dedup tables + config, applied & verified); design locked; endpoints confirmed. Workflow build + live test remain. See "Block 2 build progress" below. |
| ~~Block 3~~ | ~~Doc path~~ | **REMOVED** — Docs route through Task/Chat (no notifications/Doc-comments API); no new build needed (agent already reads Docs via the ADR-054 MCP). |
| Block 4 | Scope + idempotency test, write-backs | Pending; scope = Chat surface only. |

> **Block 0 outcome + decisions (2026-06-29).** ClickUp has no notifications/mentions API and no
> Doc-comments API. (1) **Doc surface dropped** — Doc work is a Task/Chat mention that references the
> Doc; the agent reads it via the MCP and replies on the reachable surface (operator decision). (2)
> **Chat has no webhook and no automation → it is a poll producer**, not a webhook fast-path: poll the
> channels the bot is a member of every 60s, filter the bot @-mention, enqueue (operator decisions:
> member-channels scope, 60s interval). Chat is therefore **not** near-instant — latency ≈ poll interval.
> `surface` enum is `task | chat`. See the ADR-066 amendment for the superseded consequences.

---

## Part 1 — Land the ADR (do first)

**File to create:** `architecture/decisions/066-operating-from-chat-and-docs.md`
(naming matches the convention: `NNN-kebab-case-title.md`, e.g. `065-daily-due-date-producer.md`.)

Copy the draft body verbatim **except** these edits:
1. **Title line:** `# ADR-066: Operating from ClickUp Chat and Docs (mention-driven trigger and per-surface delivery)`.
2. **Status:** `Status: Accepted` (operator is committing it). Keep `Date: 2026-06-23`, add `(accepted 2026-06-29)` to match the ADR-061/ADR-056 dated-acceptance style.
3. **References line:** change `ADR-060 (floor-vs-tail context)` → `ADR-061 (dynamic context loading)`.
4. **Body self-references:** any "ADR-061" that means *this* ADR becomes "ADR-066". (The body refers to
   itself only in the title; double-check there are no inline "this ADR (061)" mentions before saving.)
5. Add one editorial line under the header: `Note: renumbered from a draft "ADR-061"; 061 was taken by dynamic-context-loading.`

**No decisions index to update** — ADRs are discovered by directory listing; there is no separate index file
(confirmed: recent ADRs 065/063/062 were added without an index touch).

**current.md §15.10 reconciliation is deferred to Block 4's DoD** (the ADR's own sequence puts the
producers-section write-back there, after the poll producer actually exists). Landing the ADR alone does not
yet change the running system, so §15.10 is not edited in Part 1.

**Commit** Part 1 on its own: `docs(adr-066): operating from ClickUp Chat and Docs (renumbered from draft 061)`.

---

## Part 2 — Build sequence (grounded)

Run as the project's standard block-by-block routine against this plan. Each block ends with a write-back
(current.md / ADR status table) and its own commit. Key grounded facts the blocks depend on:

- **Enqueue contract** (`services/queue-consumer/app.mjs:64`): `POST http://queue-consumer:8080/enqueue`
  `{ task_id, caller_user_id, impact, invocation_type, enqueued_at, payload, idempotency_key? }`.
  `task_id` is currently **required** and the explicit jobId is `${task_id}:${invocation_type}:c${dedup_comment_id}`
  (`app.mjs` ~line 711–757). `INVOCATION_TYPES` (`app.mjs:115`) **already contains `explicit_mention`** and
  `TRIGGERED_BY`/`SPINE_INVOCATION` (`app.mjs:128`,`:136`) already map it → no new invocation_type is needed;
  Chat/Doc mentions are `explicit_mention`.
- **Producer pattern:** `n8n/workflows/cu-webhook-producer.json` (webhook → HMAC verify → Detect Mention →
  dedup claim → Read Queue Flag → Build Enqueue Job → Enqueue Job, with synchronous `Run Agent Spine` fallback).
  `n8n/workflows/due-date-producer.json` is the cron-producer template.
- **Spine:** `agent-orchestrator.json` `When Called` inputs are `taskId, reviewer_user_id, caller_username,
  triggered_by, invocation_type, triggering_comment_id, triggering_comment_text`. Read happens in
  `assemble-context-and-build-prompt.json`; delivery in `post-reply.json` (replies to
  `/api/v2/comment/{triggering_comment_id}/reply`, top-level fallback `/api/v2/task/{taskId}/comment`).
- **Scoped reads (ADR-054):** per-user MCP returns Doc-page text/comments; `execute-agent-session.json`
  binds `caller_user_id` → that user's vault. Reuse, don't rebuild.
- **Test tooling:** `scripts/test-subworkflow.mjs`, `scripts/inspect-execution.mjs`, `scripts/alerts-since.mjs`,
  `scripts/check-workflow-drift.mjs`, `scripts/export-workflows.mjs` (all confirmed present).

### Block 0 — Capability gates (verify before building)
Resolve G1–G5 against the **live** ClickUp API for the bot user, recording findings in a
`block-0-findings.md` (mirror the ADR-056/065 gate-findings habit):
- **G1 Chat automation payload** — confirm "Message is posted" Chat automation can be conditioned on a bot
  mention and exposes channel_id, comment/message_id, message text, author user id.
- **G2 (load-bearing) mentions feed** — confirm the bot's unanswered-mentions feed is pollable, includes
  **Doc-comment** mentions, **and exposes the parent surface** so the poll can pre-gate to Docs only. If the
  surface discriminator is absent → choose the fallback (command-marker poll of a watched Doc set) now.
- **G3 Doc threaded reply** — confirm reply-to-Doc-comment-by-id endpoint exists and the bot can post it.
- **G4 Chat read + threaded reply** — confirm the Chat API reads a thread/message and posts a threaded reply
  under a given message as the bot.
- **G5 invoker identity** — confirm the @-mentioning user id is present in both ingestion payloads (ADR-054 scoping).
- **DoD:** every trigger/delivery surface confirmed reachable for the bot user, or its fallback chosen (G2).
  If a gate fails, stop and surface it before building dependent blocks.

> **Post-Block-0 revision (2026-06-29):** Blocks 1–4 below are rewritten to the verified reality — Chat
> is a **poll** producer (no webhook/automation), the Doc surface is dropped, and `surface ∈ {task | chat}`.

### Block 1 — Surface dimension on the job + spine
- **queue-consumer (`app.mjs`):** allow `task_id` to be **null when `surface = chat`** (keep it required
  for `surface` absent/`task`). When `task_id` is null, derive the explicit jobId from the surface id:
  `c:${channel_id}:${message_id}`. Carry `surface` + `surface_ref` through to the spine **inside `payload`**
  (the opaque field) so the consumer's priority logic and contract validator change only for the task_id
  nullability — the consumer needs surface only to forward it, not to prioritize. (Top-of-file note: this
  realises the ADR-066 `surface` dimension via the payload carrier.)
- **Spine (`agent-orchestrator.json` + `spine-http-ingress.json`):** add `surface` + `surface_ref` inputs
  (default `surface=task`, `surface_ref.task_id=taskId` for the existing path). Make the read and delivery
  calls branch on `surface` (task branch = today's behaviour, unchanged).
- **DoD:** an existing **task** @-mention still runs end-to-end unchanged (drive it via
  `test-subworkflow.mjs` against the orchestrator's `When Called` with the producer's exact inputs;
  verify with `inspect-execution.mjs`; confirm no new alerts via `alerts-since.mjs`). Re-export touched
  workflows and run `check-workflow-drift.mjs`.

### Block 2 — Chat path (poll producer)
- **Producer:** new `n8n/workflows/cu-chat-poll.json` — cron at `chat.poll_interval_s` (default 60; add
  the config key via append-only migration alongside the other producer config) → list the channels the
  **bot is a member of** (`get_chat_channels` as the bot) → for each channel, fetch recent messages
  (`get_chat_channel_messages`) and keep only those **newer than a per-channel last-seen cursor** (persist
  the cursor in `config`/a small table; advance it each run) → keep messages that **@-mention the bot**
  (via the message tagged-users endpoint, not text parsing) → dedup claim on `message_id` → Read Queue Flag
  → Build Enqueue Job (`surface=chat`, `surface_ref={channel_id, message_id}`,
  `invocation_type=explicit_mention`, `caller_user_id` = author `user_id`) → `/enqueue`. Pair it with a
  **freshness dead-man's-switch** monitor (mirror `due-date-producer-freshness-monitor.json`) so a stalled
  poll WARNs. Guard against re-enqueuing the bot's **own** reply messages (skip messages authored by the bot).
- **Read adapter:** in the spine's Stage A, a Chat branch that reads the thread/message via the Chat API,
  scoped to the invoker (ADR-054). A Chat request that references a Doc reads the Doc via the same MCP —
  this is the "Doc-via-Chat" path that replaces the dropped Doc surface.
- **Delivery adapter:** in `post-reply.json`, a Chat branch that posts a **threaded reply under the invoking
  message** (`parent_message_id = surface_ref.message_id`), routed by `surface`. Reuse the existing
  `Classify Alert` → `Post Alert (v1)` seam for failures.
- **DoD:** a real Chat mention of the bot produces a scoped **threaded reply under the invoking message**
  within ~1 poll interval; the bot's own reply does **not** re-trigger; execution clean in
  `inspect-execution.mjs`; no unexplained alerts. Delete any test rows/messages after.

#### Block 2 build progress (continuation record — 2026-06-29)

Grounding + foundation done; the workflow build + live test remain. **Build the producer as ONE
complete, tested unit and activate its 60s cron ONLY after the end-to-end DoD passes** — a half-built
active poll producer would self-misfire / flood alerts in production.

**DONE & verified**
- **Migration 049 applied** (`049_chat_surface.sql`): `chat_poll_cursor` (`channel_id` PK,
  `last_seen_ms` bigint, `last_message_id`, `updated_at`), `agent_chat_dedup` (`message_id` PK,
  `channel_id`, `first_seen_at`), config `chat.poll_interval_s='60'` + `chat_poll_producer.last_run_at`
  (seeded `now()` so the freshness monitor doesn't false-alarm pre-first-run).
- **queue-consumer is already chat-aware** (Block 1): validates `payload.surface_ref.channel_id`+
  `message_id`, jobId `c:<channel>:<message>`, forwards `surface`/`surface_ref`. No consumer change needed.

**Design locked (operator, 2026-06-29)**
- **Separate `assemble-chat-context` sub-workflow** for the chat read path; the orchestrator routes
  Stage A on `surface` BEFORE the read, so the proven task Stage A (`Assemble Context`, verified exec
  5424) stays byte-for-byte untouched. The chat reader returns the SAME contract shape `Build Prompt`
  returns (`prompt`, `clickup_task_id:''`, `impact`, `caller_user_id`, `reviewer_user_id`,
  `process_type:''`, `triggering_comment_id:''`, `image_blocks_json:'[]'`, `web_sources:'[]'`, …) so
  everything downstream (Context OK? → lane → Execute Agent Session → Render → Post Reply) works
  unchanged. Chat floor = global rules + caller personal rules + triggering message + thread replies;
  the agent pulls anything else via its in-harness scoped ClickUp MCP (the "Doc-via-Chat" path).

**Confirmed facts (don't re-derive)**
- Bot user id (`AGENT_ID`) = **99811284**; bot ClickUp Member token = n8n credential **`QRrgf6hteyGWSJyv`**
  ("ClickUp account") — used for ALL bot-side calls. The poll lists channels *as the bot* (its token
  only sees channels it's a member of — membership = token scope; there is no per-channel member flag).
- Workspace/team id = **761759**. ClickUp v3 Chat endpoints (all bot-token):
  - list channels: `GET /api/v3/workspaces/761759/chat/channels` (paginated, `next_cursor`)
  - channel messages: `GET /api/v3/workspaces/761759/chat/channels/{channel_id}/messages?limit=50`
    — **newest-first**; message = `{id, content, user_id, date(ms int), type, has_replies}`. `content`
    renders mentions as plain `@Name` text (unreliable — DON'T parse it).
  - **tagged users** (the mention test): `GET /api/v3/workspaces/761759/chat/messages/{message_id}/tagged_users`
    — **response shape undocumented; verify the user-id field name live** and match `99811284`. Filter
    code must read the id defensively (array of objects vs `{data:[…]}`).
  - threaded reply (delivery): `POST /api/v3/workspaces/761759/chat/messages/{message_id}/replies`
    body `{type:"message", content:<markdown>, content_format:"text/md"}` → 201.
- `agent_runs.clickup_task_id` is **nullable** → a chat run logs cleanly with no task.

**Remaining artifacts + surface-gating (the actual build)**
1. `n8n/workflows/assemble-chat-context.json` (NEW) — chat Stage A reader (rules + message + thread).
2. `n8n/workflows/cu-chat-poll.json` (NEW) — Schedule(60s)+Form harness → Read Queue Flag → list bot
   channels → per channel fetch first page → keep `date > chat_poll_cursor.last_seen_ms` → drop
   bot-authored (`user_id == 99811284`) → tagged-users gate (bot mentioned) → `agent_chat_dedup` claim →
   Build Enqueue Job (`task_id:null`, `impact:'Średni'`, `invocation_type:'explicit_mention'`,
   `payload.surface:'chat'`, `surface_ref:{channel_id,message_id}`, `caller_user_id:user_id`) → `/enqueue`
   → advance cursor → stamp `chat_poll_producer.last_run_at`. **Cold-start guard:** a channel with no
   cursor row seeds to its newest message WITHOUT enqueuing (don't replay history).
3. `n8n/workflows/cu-chat-poll-freshness-monitor.json` (NEW) — dead-man's-switch on
   `chat_poll_producer.last_run_at` (stale threshold ~10 min, i.e. 10× interval; tighter than due-date's
   26h) → WARN via Post Alert (v1). Mirror `due-date-producer-freshness-monitor.json`.
4. `agent-orchestrator.json` (EDIT) — route Stage A on `surface` (task→`Call Assemble Context`,
   chat→`Call Assemble Chat Context`); **gate `Set Status W trakcie` and `Call Write Cost Field` to
   `surface=task`** (both write a task field — skip for chat). Thread `surface`/`surface_ref` to the
   chat reader + to Post Reply. (Surface already carried on `When Called`/`Resume After Gate`, Block 1.)
5. `post-reply.json` (EDIT) — add `surface`+`surface_ref` inputs; at the top, `IF surface=chat` →
   post `completion` (markdown) to the `/replies` endpoint (channel from `surface_ref`), then dead-end
   (skip `Set Status Zakończono` + `Record Artifact` — task-bound). Task branch unchanged. Reuse the
   `Classify/Post Alert (v1)` seam for a chat-reply failure (`onError:continueErrorOutput`).
   **Scope note (honest):** chat delivery is **text/markdown only** in Block 2; inline chat images use a
   different mechanism than the task comment ops-array and are deferred (state this in the summary).

**Verify (DoD, autonomous):** drive the spine via `test-subworkflow.mjs` on the orchestrator `When Called`
with chat inputs (`surface:'chat'`, `surface_ref` JSON **string** — the ingress passes it stringified, so
the chat reader + delivery must `JSON.parse` it), then a REAL @-bot chat message in a test channel end-to-end;
`inspect-execution.mjs` node-by-node; `alerts-since.mjs`; confirm the bot's own reply does NOT re-trigger;
delete test `agent_runs` rows + test messages; re-export touched workflows + `check-workflow-drift.mjs` clean.

### ~~Block 3 — Doc path~~ (REMOVED)
Dropped per the Block 0 finding + operator decision: ClickUp has no notifications API and no Doc-comments
API, so an in-Doc mention trigger and a Doc-comment reply cannot be built. **Doc work routes through
Task/Chat** — a mention referencing the Doc; the agent reads the Doc via the ADR-054 MCP (already returns
Doc-page text) and replies on the reachable surface. No new build. (Original Doc-path text retained below,
struck through, for the record.)

<details><summary>Original Block 3 (not built)</summary>

- **DoD (original, not built):** a Doc-comment mention produces a threaded reply under that comment, scoped
  to the invoker, no in-place edit.

</details>

### Block 4 — Scope + idempotency test, and write-backs
- A Chat mention processes **exactly once** (idempotency on `message_id` + the per-channel last-seen cursor;
  the bot's own replies are skipped, no self-trigger loop). A Marketing user's Chat mention **cannot surface
  Purchasing data** (reuse the ADR-054 Block 5 cross-department negative matrix, on the Chat surface).
  Explicit mentions land in the **high-priority band**. The 60s interval bounds Chat latency.
- **Write-backs (mandatory before final commit):** reconcile `current.md` **§15.10** (producers now include
  the **Chat poll producer** + its freshness monitor; note Docs route through Task/Chat, no Doc producer);
  flip this block-status table; codify the new `chat.poll_interval_s` migration; re-export every touched
  workflow with `export-workflows.mjs` and confirm `check-workflow-drift.mjs` is clean.
- **DoD:** idempotency holds (no re-fire, no self-loop), scope holds, priority holds, drift-check clean.

---

## Silent-failure coverage (state in each block summary)
- **Stalled Chat poll** → freshness dead-man's-switch monitor (Block 2), WARN.
- **Self-trigger loop** → skip messages authored by the bot; advance the per-channel last-seen cursor each
  run so a message is never re-enqueued (Block 2 guard).
- **Chat reply post failure** → `onError: continueErrorOutput` → `Post Alert (v1)` WARN, main path still
  returns (mirror `post-reply.json`'s existing reply-failed branch).
- **Chat trigger reliability:** there is no webhook retry to lean on (Chat is poll-only) — the cursor +
  dedup mean a transient poll failure is recovered on the next interval rather than dropping the message.
- **schema[] trap:** if any new surface adapter is wired as a `toolWorkflow`/MCP node, hand-maintain
  `workflowInputs.schema[]` and never let `export-workflows.mjs` overwrite it (CLAUDE.md gotcha).

## Verification (end-to-end, per Definition of Done)
For each surface block: (1) trigger the real flow — @-mention the bot on a Chat message / Doc comment (or
drive the spine via `test-subworkflow.mjs` with the producer's exact inputs); (2) inspect the execution
node-by-node with `scripts/inspect-execution.mjs <execId>`; (3) scan `scripts/alerts-since.mjs <minutes>`
for any WARN/CRITICAL and treat any as failure until explained. Delete test `agent_runs` rows and disposable
test ClickUp tasks afterward (no delete-attachment API). Final gate: `node scripts/check-workflow-drift.mjs`
reports no drift, and `current.md` §15.10 reflects the two new producers.
