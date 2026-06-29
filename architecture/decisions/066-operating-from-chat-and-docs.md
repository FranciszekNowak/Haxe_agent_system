# ADR-066: Operating from ClickUp Chat and Docs (mention-driven trigger and per-surface delivery)

Note: renumbered from a draft "ADR-061"; 061 was taken by dynamic-context-loading.

Status: Accepted
Date: 2026-06-23 (accepted 2026-06-29)
Depends on: ADR-056 (queue and job contract), ADR-054 (per-user-scoped reads; the MCP already returns Doc-page text), ADR-050 (deliver as a new comment, never an in-place edit of human content), ADR-035 (cost logging)
References: ADR-053 (spine), ADR-061 (dynamic context loading)
Touches: `current.md` §15.10 (producers), the job contract

## Decision (verdict first)

Make invocation **mention-driven and surface-agnostic**. A ClickUp bot user is @-mentioned on any surface (task, Chat message, Doc comment); that mention is the trigger. Ingestion is **surface-disjoint**: the **webhook fast-path** handles Tasks and Chat (both fire ClickUp webhooks), and a **once-a-minute mentions poll gated to Doc-surface mentions only** handles Docs (which fire no webhook). The job carries a `surface` and `surface_ref` so the spine is surface-agnostic, and a **per-surface delivery adapter** posts a **threaded reply under the invoking comment/message on every surface** (Chat, Doc, task). Reads reuse ADR-054. Delivery never edits a Doc in place.

## Context

The agent reaches tasks (task webhook in, task comment out) but not Chat or Docs. The verified ClickUp reality:

- **Chat is triggerable, but only via a Chat automation.** "Message is posted" is the sole Chat trigger, exposing Channel ID and Comment ID. A task webhook does not fire on Chat, which is why the wired webhook was silent.
- **Docs are not triggerable.** There is no doc event in the webhook catalog (taskCommentPosted exists, no doc equivalent), confirmed by a standing open feature request. So no webhook can fire from a Doc; this is structural.
- **Reads are already solved.** ADR-054's per-user MCP returns Doc-page text, comments, and custom-field values, so gathering Doc and Chat context is not the gap. The gap is the **trigger** (no doc event) and the **delivery** (where output lands on each surface).

The unifying observation: an @-mention of a bot user generates a notification regardless of surface (task, Chat, Doc comment). Polling the bot's mentions feed is therefore an event substitute that works where no webhook exists, and it unifies all three surfaces under one invocation model.

## Decision detail

1. **Bot user + mention as the invocation.** The agent owns a ClickUp bot user. Being @-mentioned is the universal "do this" signal. This replaces surface-specific trigger semantics with one model the user already understands (mention the person you want to act).

2. **Surface-disjoint ingestion (pre-gated, not dedup-reliant).** Each surface has exactly one primary path, so the queue is never filled with mentions that fire twice by design.
   - **Webhook fast-path (Tasks + Chat).** The existing task webhook covers Tasks; a Chat automation ("Message is posted" conditioned on a bot mention) covers Chat, calling `/enqueue` with Channel ID and Comment ID. Near-instant.
   - **Mentions poll (Docs only).** A once-a-minute poll of the bot's unanswered-mentions feed is **filtered to Doc-surface mentions before enqueue** (see G2), so Task and Chat mentions, already handled by the webhook, are dropped at the source rather than enqueued and deduped. The interval is `queue.doc_poll_interval_s`, default 60, config-tunable per ADR-056.
   The routing is: `webhook → proceed` (Tasks, Chat); `poll → keep if Doc → proceed` (Docs). Dedup on the mention/message id (ADR-056) is retained only as a last-resort idempotency guard for edge cases (a webhook retry, a poll-then-webhook race), not as the primary deduplication path, which is now the surface gate itself.

3. **Surface dimension on the job contract.** Add `surface` (`task` | `chat` | `doc`) and `surface_ref` (the ids needed to read and reply: `channel_id`+`comment_id` for chat, `doc_id`+`page_id`+`comment_id` for doc, `task_id` for task). The spine stays surface-agnostic; only the read and delivery adapters branch on `surface`.

4. **Per-surface read adapter.** Chat: read the thread/message via the Chat API. Doc: read the page text and the comment via the ADR-054 MCP. Task: unchanged. All scoped to the @-mentioning user per ADR-054 (the invoker's identity binds the session; reads return only what that user may see).

5. **Per-surface delivery adapter, always in-thread.** Reply as a **threaded reply to the invoking comment/message**, on every surface, the way task comments already work: a Chat reply threaded under the invoking Chat message, a Doc reply threaded under the invoking Doc comment, a task threaded reply under the invoking task comment. The reply always attaches to the `comment_id` in `surface_ref`, never as a new top-level comment or message. Per ADR-050, the agent posts a reply and **never edits the Doc body in place** by default. Appending a response block to a Doc, or editing it, is a separate, gated capability (R3), not the default delivery.

6. **Permission scoping (ADR-054 carries over).** The invoker is known from the mention payload, so the session binds to them and reads are credential-scoped. A Chat channel or Doc visible to many does not widen the agent's reach beyond the invoker's permissions.

## Job contract delta (extends ADR-056)

```jsonc
{
  // ...existing ADR-056 fields (task_id may be null for chat/doc)...
  "surface": "task|chat|doc",
  "surface_ref": {
    "channel_id": "string?",   // chat
    "comment_id": "string?",   // chat or doc comment that mentioned the bot
    "doc_id": "string?",       // doc
    "page_id": "string?",      // doc
    "task_id": "string?"       // task
  },
  "invocation_type": "explicit_mention",   // chat/doc mentions are explicit by nature
  "caller_user_id": "string"               // the @-mentioning user (ADR-054 scoping)
}
```

Chat and Doc mentions are `explicit_mention`, so they inherit the high-priority band from ADR-056's amendment (a human is waiting), with impact as the secondary sort.

## Rejected / deferred alternatives

- **R1. Wait for ClickUp to ship Doc webhooks.** It is a standing open feature request with no commitment. Do not block on it. The mentions poll works now. Revisit trigger: ClickUp ships a `docCommentPosted` or doc event, at which point the poll becomes a webhook fast-path for Docs too.
- **R2. Bridge through ClickUp's native AI surface** (a Super Agent or AI Field invoked inside the Doc that calls the agent). Deferred: it reintroduces the ClickUp-native-agent dependency the system deliberately avoids, and it only matters if poll latency proves unacceptable for in-Doc work. Revisit trigger: a frequent, latency-sensitive in-Doc workflow that minutes-scale polling cannot serve.
- **R3. Deliver Doc output by editing the Doc in place.** Rejected as the default (ADR-050: create-and-deliver, do not edit human content in place). In-place Doc editing is a separate gated capability built only if a concrete recurring need names itself.
- **R4. Reuse the task webhook for Chat/Docs.** Rejected: confirmed it does not fire (wrong automation family for Chat, no event for Docs). This was the observed failure.
- **R5. Poll all Docs for body changes.** Rejected: there is no cheap changed-since for Doc bodies, and it scans irrelevant content. The mentions feed is the cheap, targeted signal; poll that, not the corpus.

## Capability gates (Block 0)

- **G1.** Confirm the Chat-automation webhook payload contents (channel_id, comment_id, message text, author/user id) and that it can be conditioned on a bot mention.
- **G2.** Confirm the mentions/notifications feed for a bot user is pollable, includes Doc-comment mentions, **and exposes the parent surface so the poll can gate to Doc-surface mentions only**. This is load-bearing: without a surface discriminator the pre-gate is impossible and you regress to enqueue-then-dedup for every task and chat mention. If Doc-comment mentions are absent, fall back to a command-marker poll of a watched Doc set.
- **G3.** Confirm the Doc-comment **threaded-reply** endpoint exists (reply to a Doc comment by id) and that a bot user can post it.
- **G4.** Confirm the Chat API can read a thread/message and **post a threaded reply** under a given message for the bot user.
- **G5.** Confirm the invoker identity is present in both ingestion payloads (for ADR-054 scoping).

## Build sequence (blocks)

- **Block 0 — Gates.** Resolve G1 to G5. DoD: every trigger and delivery surface confirmed reachable for the bot user, or its fallback chosen (G2).
- **Block 1 — Surface dimension.** Add `surface` + `surface_ref` to the job contract and make the spine read/deliver adapters branch on it; tasks unchanged. DoD: a task job still works end-to-end with the new fields.
- **Block 2 — Chat path.** Chat-automation webhook → `/enqueue`; Chat read adapter; Chat threaded-reply delivery. DoD: a Chat mention of the bot produces a scoped **threaded reply under the invoking message**.
- **Block 3 — Doc path.** Mentions poll **filtered to Doc-surface mentions** → `/enqueue`; Doc read via ADR-054 MCP; Doc threaded-reply delivery. DoD: a Doc-comment mention produces a **threaded reply under the invoking Doc comment**, scoped to the invoker, with no in-place edit; a Task or Chat mention appearing in the same poll batch is dropped at the gate and never enqueued.
- **Block 4 — Scope + idempotency test.** The poll gate drops Task/Chat mentions (verify they never enqueue); a Doc mention processes exactly once; a Marketing user's mention in a Doc cannot surface Purchasing data; explicit mentions land in the high-priority band; the 60s interval bounds Doc latency. DoD: gate holds, scope holds, priority holds; `current.md` §15.10 reconciled (producers now include the chat webhook and the Doc-only mentions poll).

## Consequences

- **One invocation model across three surfaces** (mention the bot), so the user learns nothing new per surface, and the spine stays surface-agnostic behind two thin adapters.
- **Docs work despite having no webhook**, via the mentions poll, at poll-interval latency, which is acceptable for async and is the only option until ClickUp ships doc events.
- **Delivery respects ADR-050**: replies are new comments/messages, Doc bodies are not edited in place.
- **Accepted limit:** in-Doc invocation latency is the poll interval, not instant. If that ever bites, R2 (bridge through the native surface) is the escape, with the dependency cost recorded.
- **Sync interaction:** Chat is the sync surface, because the webhook trigger is near-instant; latency-sensitive back-and-forth should run in Chat, and sync-sensitive Doc work should route through Chat or accept up to 60s. Note that even on Chat the agent's reply still takes the full agentic processing time (cold-start, reasoning, tool round-trips), so sync suits lightweight exchanges while heavy work stays async. Explicit mentions already hold the high-priority band (ADR-056 amendment), so sync mentions jump the overnight batch.
- **Backstop tradeoff (accepted):** gating the poll to Docs removes its former role as a webhook backstop for Tasks and Chat. This is acceptable because ClickUp retries a failed webhook for ~75 minutes, so Task and Chat reliability comes from the webhook's own retry, not the poll. Dedup remains only as the rare-edge idempotency guard.
- **The mentions poll is a new always-on producer**; it rides the existing queue-depth and dead-man's-switch monitoring (ADR-056), so a stalled poll alerts rather than failing silently.
