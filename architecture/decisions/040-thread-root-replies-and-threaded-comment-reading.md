# ADR-040: Reply to the thread root, and read threaded comment replies into context

## Context

Two defects surfaced when a caller @-mentioned the agent **inside an existing comment
thread** (i.e. as a reply under a previous comment) rather than in a fresh top-level
comment, on task `869dm1z8y`:

1. **Replies landed in new threads.** `Post Reply (v1)` posts the draft via
   `POST /api/v2/comment/{triggering_comment_id}/reply`. The producer was passing the
   **triggering comment's own id**. When that comment is itself a threaded reply, ClickUp
   rejects the call with `400 — "Unsupported Entity"` because **ClickUp threads are
   single-level: you cannot reply to a reply.** The node's `onError` fallback then posts a
   **new top-level comment**, so every answer to an in-thread mention "started a new thread"
   instead of landing under the caller's message. Confirmed in execution 1245 (Post Reply
   errored, fell back to `Post Draft Comment`).

2. **Context omitted comment replies.** `Workspace Search (v1) → Fetch Task Comments`
   reads `GET /task/{id}/comment`, which returns **top-level comments only** (each with a
   `reply_count`), and `Build Output` took the top 30. Threaded replies — including the
   caller's own follow-up instructions and a detailed `wydania` list posted as replies —
   were never fetched, so the model worked blind. In the broken run the agent answered
   *"nie mam dostępu do szczegółowej listy wydań"* and asked blocking questions for data
   that was sitting in the thread.

Webhook-payload shape (the basis for the fix): for a top-level comment,
`comment.parent` is the **task id**; for a reply, `comment.parent` is the **top-level
(repliable) comment id**. Because threading is single-level, a reply's parent is always a
valid reply target.

## Decision

**Reply to the thread root.** `CU Webhook Producer (v1) → Detect Mention` now computes
`reply_to_comment_id = (comment.parent && comment.parent !== task_id) ? comment.parent :
comment.id`. `Run Agent Spine` feeds this value into the downstream `triggering_comment_id`
channel (which `Post Reply` already uses as the reply target), so the answer nests under the
caller's thread. The comment's **own** id stays as `triggering_comment_id` and remains the
**webhook-dedup key** (`Claim Comment`, ADR-029) — collapsing it to the parent would
de-duplicate distinct mentions made in the same thread. No downstream workflow changed
(deliberately avoiding the `Execute LLM Call` return path, ADR-036).

**Read threaded replies into context.** `Workspace Search (v1)` gains a guarded per-thread
fetch between `Fetch Task Comments` and `Build Search Prompt`:
`Pick Threads` (top-30 comments with `reply_count > 0`) → `Has Threads?` (routes around the
fetch when none, avoiding a 0-item stall) → `Expand Threads` → `Fetch Replies`
(`GET /comment/{id}/reply`, one call per thread, `onError: continueRegularOutput`) →
`Collect Replies` (aligns inputs to outputs by index → `replies_by_parent`). `Build Output`
interleaves each top-level comment with its replies (chronological, author prefixed `↳`,
`is_reply: true`). Reply fetching is **best-effort** — a failed thread yields no replies for
that parent, matching the existing best-effort `Fetch Task Comments` (no extra alert).

## Consequences

- In-thread mentions are answered **in the same thread**; the `Unsupported Entity` →
  new-top-level-comment failure mode is gone. The fallback still exists for genuine reply
  failures. Verified live: execution 1286 posted `90120227321117` with
  `comment-parent → comment 90120227309889` (a true nested reply, no fallback), and the
  thread now shows the caller's message + the agent's answer.
- The model now sees the full conversation: in the rerun it produced a real filtered
  `wydania` table citing releases `869cufwge`/`869brhveg` instead of asking for data already
  in the thread.
- `triggering_comment_id` travelling to the spine is now the **reply target (thread root)**,
  not strictly the triggering comment; the producer keeps the own-id as the dedup key. The
  caller's actual message text is unchanged (`triggering_comment_text`).
- Workspace Search adds up to ~30 extra ClickUp GETs per run (one per threaded comment).
  Acceptable for the context-quality gain; capped by the top-30 slice.
- `Agent Orchestrator (v1)`'s manual **Form Trigger** gained two optional fields
  (`triggering_comment_id`, `triggering_comment_text`) so the spine can be exercised with
  thread context without a signed webhook. Production (webhook) path is unaffected.
- Silent-failure coverage: the per-thread fetch is best-effort by design (no alert), like
  `Fetch Task Comments`; `Collect Replies` tracks a `reply_fetch_errors` count for future
  surfacing if needed.

## Update 2026-06-11 — WARN alerts on comments/replies fetch failure

Added explicit WARN alerts (via `Post Alert (v1)`) for the two fetch failure modes that were
previously silent: `Comments Fetch Failed?` (no `comments` array from `Fetch Task Comments`) →
`Alert Comments Failed` (`source: search/fetch-comments`), and `Reply Fetch Failed?`
(`reply_fetch_errors > 0` from `Collect Replies`) → `Alert Replies Failed`
(`source: search/fetch-replies`), both `onError: continueRegularOutput`.

**Return-path trap (re-learned):** the first attempt wired these as dead-end side branches off
`Fetch Task Comments` / `Collect Replies`. That added extra **leaf nodes**, and because
`Workspace Search` is an `executeWorkflow` sub-workflow, its return became non-deterministic —
n8n returned an IF node's empty `main[0]` (the alert branch, empty on the happy path) instead of
`Final Output`, so `Call Workspace Search` got **0 items** and the "0-item nulls the chain" trap
emptied the whole context (run aborted at `Context OK?` → CRITICAL, no reply). Fix: the alert IFs
**reconverge inline** — `Comments Fetch Failed?` (both branches) → `Pick Threads`;
`Reply Fetch Failed?` (both branches) → `Build Search Prompt`; alert nodes flow onward, never
dead-end — so `Final Output` stays the **sole leaf** and the return is deterministic. Confirms the
CLAUDE.md rule: a sub-workflow's return path must be a single branch-free terminal; side-effects
either reconverge into the main line or move to the caller.

## Date

2026-06-11
