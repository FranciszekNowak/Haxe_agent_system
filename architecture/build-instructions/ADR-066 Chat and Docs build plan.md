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

### Block 1 — Surface dimension on the job + spine
- **queue-consumer (`app.mjs`):** allow `task_id` to be **null when `surface ∈ {chat, doc}`** (keep it
  required for `surface` absent/`task`). When `task_id` is null, derive the explicit jobId from the surface
  id instead: `c:${channel_id}:${comment_id}` (chat) / `d:${doc_id}:${page_id}:${comment_id}` (doc). Carry
  `surface` + `surface_ref` through to the spine. Recommended: pass `surface`/`surface_ref` **inside
  `payload`** (the opaque field) so the consumer's priority logic is untouched and the contract validator
  only changes for the task_id nullability — the consumer needs surface only to forward it, not to prioritize.
  (Add a top-of-file note that this realises the ADR-066 `surface` dimension; the ADR's "add to job contract"
  is satisfied by the payload carrier.)
- **Spine (`agent-orchestrator.json` + `spine-http-ingress.json`):** add `surface` + `surface_ref` inputs
  (default `surface=task`, `surface_ref.task_id=taskId` for the existing path). Make the read and delivery
  calls branch on `surface` (task branch = today's behaviour, unchanged).
- **DoD:** an existing **task** @-mention still runs end-to-end unchanged (drive it via
  `test-subworkflow.mjs` against the orchestrator's `When Called` with the producer's exact inputs;
  verify with `inspect-execution.mjs`; confirm no new alerts via `alerts-since.mjs`). Re-export touched
  workflows and run `check-workflow-drift.mjs`.

### Block 2 — Chat path (webhook fast-path)
- **Producer:** new `n8n/workflows/cu-chat-producer.json` — Chat automation ("Message is posted",
  conditioned on bot mention) → webhook → (HMAC verify if the Chat automation signs; else the bot-mention
  condition is the gate) → Detect bot mention → dedup claim on message id → Read Queue Flag → Build Enqueue
  Job (`surface=chat`, `surface_ref={channel_id, comment_id}`, `invocation_type=explicit_mention`,
  `caller_user_id` = mentioning user) → `/enqueue`, with synchronous fallback mirroring the task producer.
- **Read adapter:** in the spine's Stage A, a Chat branch that reads the thread/message via the Chat API,
  scoped to the invoker (ADR-054).
- **Delivery adapter:** in `post-reply.json`, a Chat branch that posts a **threaded reply under the invoking
  message** (`surface_ref.comment_id`), routed by `surface`. Reuse the existing `Classify Alert` →
  `Post Alert (v1)` seam for failures.
- **DoD:** a real Chat mention of the bot produces a scoped **threaded reply under the invoking message**;
  execution clean in `inspect-execution.mjs`; no unexplained alerts. Delete any test rows/tasks after.

### Block 3 — Doc path (mentions poll, Doc-gated)
- **Producer:** new `n8n/workflows/cu-doc-mentions-poll.json` — cron at `queue.doc_poll_interval_s`
  (default 60; add the config key alongside the other `queue.*` keys, append-only migration) → poll the
  bot's unanswered-mentions feed → **filter to Doc-surface mentions only** (drop Task/Chat at the source per
  G2) → for each: Build Enqueue Job (`surface=doc`, `surface_ref={doc_id, page_id, comment_id}`,
  `invocation_type=explicit_mention`, `caller_user_id` = mentioning user) → `/enqueue`. Pair it with a
  **freshness dead-man's-switch** monitor (mirror `due-date-producer-freshness-monitor.json`) so a stalled
  poll WARNs instead of failing silently. Guard the poll to **drop the Alerts task / its own telemetry**
  before enqueue (alert-inside-watched-scope loop rule).
- **Read adapter:** Doc branch reads page text + the invoking comment via the **ADR-054 per-user MCP**
  (reuse, don't rebuild), scoped to the invoker.
- **Delivery adapter:** Doc branch posts a **threaded reply under the invoking Doc comment** (G3 endpoint);
  **never edits the Doc body in place** (ADR-050; in-place editing is the deferred R3 capability).
- **DoD:** a Doc-comment mention produces a threaded reply under that comment, scoped to the invoker, no
  in-place edit; a Task or Chat mention appearing in the same poll batch is **dropped at the gate and never
  enqueued** (verify via consumer logs / queue state).

### Block 4 — Scope + idempotency test, and write-backs
- The poll gate drops Task/Chat mentions (verify they never enqueue). A Doc mention processes **exactly
  once** (idempotency on the surface id, the rare-edge guard). A Marketing user's mention in a Doc **cannot
  surface Purchasing data** (reuse the ADR-054 Block 5 cross-department negative matrix). Explicit mentions
  land in the **high-priority band**. The 60s interval bounds Doc latency.
- **Write-backs (mandatory before final commit):** reconcile `current.md` **§15.10** (producers now include
  the **Chat webhook producer** and the **Doc-only mentions poll** + its freshness monitor); flip the ADR-066
  status table / block-status; codify the new `queue.doc_poll_interval_s` migration; re-export every touched
  workflow with `export-workflows.mjs` and confirm `check-workflow-drift.mjs` is clean.
- **DoD:** gate holds, scope holds, priority holds, drift-check clean.

---

## Silent-failure coverage (state in each block summary)
- **Stalled Doc poll** → freshness dead-man's-switch monitor (Block 3), WARN.
- **Poll alert-loop** → drop own telemetry/Alerts task before enqueue (Block 3 guard).
- **Chat/Doc reply post failure** → `onError: continueErrorOutput` → `Post Alert (v1)` WARN, main path still
  returns (mirror `post-reply.json`'s existing reply-failed branch).
- **Webhook backstop tradeoff (accepted):** gating the poll to Docs removes its old role as a Task/Chat
  webhook backstop; Task/Chat reliability now rests on ClickUp's ~75-min webhook retry (ADR-066 Consequences).
- **schema[] trap:** if any new surface adapter is wired as a `toolWorkflow`/MCP node, hand-maintain
  `workflowInputs.schema[]` and never let `export-workflows.mjs` overwrite it (CLAUDE.md gotcha).

## Verification (end-to-end, per Definition of Done)
For each surface block: (1) trigger the real flow — @-mention the bot on a Chat message / Doc comment (or
drive the spine via `test-subworkflow.mjs` with the producer's exact inputs); (2) inspect the execution
node-by-node with `scripts/inspect-execution.mjs <execId>`; (3) scan `scripts/alerts-since.mjs <minutes>`
for any WARN/CRITICAL and treat any as failure until explained. Delete test `agent_runs` rows and disposable
test ClickUp tasks afterward (no delete-attachment API). Final gate: `node scripts/check-workflow-drift.mjs`
reports no drift, and `current.md` §15.10 reflects the two new producers.
