# Block 0 findings — ADR-066 capability gates (Chat & Docs surfaces)

Date: 2026-06-29. Gates resolved against the live ClickUp workspace (MCP probes) and ClickUp's
authoritative developer index (`developer.clickup.com/llms.txt`, the webhook-events reference, and the
public-API feedback board). **Headline: the Chat surface is buildable; the Doc surface is NOT buildable
as ADR-066 specifies — the API it depends on does not exist.** This is the load-bearing failure G2 was
written to catch.

## Gate results at a glance

| Gate | Surface | Result | Evidence |
|------|---------|--------|----------|
| G1 | Chat trigger | **PARTIAL** — mechanism exists, needs operator UI/plan check | No chat webhook event; must use a Chat **Automation** ("Message is posted" → Automation webhook action) |
| G2 | Doc trigger (mentions feed) | **FAIL** | No notifications/inbox/mentions API exists at all; the named fallback (poll doc comments) also has no API |
| G3 | Doc delivery (comment reply) | **FAIL** | No Doc-comments API exists — cannot read or create a comment on a Doc/Doc page |
| G4 | Chat read + threaded reply | **PASS** | Live probe: messages, replies, `parent_message_id` send all work |
| G5 | Invoker identity | **PASS** (Chat) | Chat messages carry `user_id`; Doc moot (path blocked) |

## G4 — Chat read + threaded reply (PASS)

Confirmed live against the workspace:
- `clickup_get_chat_channels` returns channels with ids (e.g. Marketing `q7wz-8952`, Sprzedaż
  `q7wz-15172`, Zakupy `q7wz-8232`) — DMs and CHANNELs, public and private.
- `clickup_get_chat_channel_messages(q7wz-8952)` returns messages shaped
  `{ id, content, user_id, date, type, has_replies }`. Threads exist (`has_replies:true`) and are
  fetchable via `clickup_get_chat_message_replies(message_id)`.
- `clickup_send_chat_message` takes **`parent_message_id`** → a message sent with it is a **threaded
  reply** under that message. This is exactly the ADR's "threaded reply under the invoking message".
- A dedicated **"Retrieve message tagged users"** endpoint exists
  (`developer.clickup.com/reference/getchatmessagetaggedusers`) — the reliable way to detect a bot
  @-mention in a Chat message (the message `content` renders mentions as plain `@Name` text, so parsing
  text is unreliable; use the tagged-users endpoint or the automation condition instead).

## G5 — Invoker identity (PASS for Chat)

Chat messages carry `user_id` (live examples: `2521617`, `2604220`) → the @-mentioning user is known,
so ADR-054 per-user scoping binds cleanly on the Chat surface. Doc invoker identity is moot because the
Doc path is blocked (below).

## G1 — Chat trigger (PARTIAL — mechanism confirmed, operator must verify plan + condition)

- **There is no chat-message webhook event.** ClickUp's webhook catalog is task/list/folder/space/goal
  only: `taskCreated, taskUpdated, taskDeleted, taskPriorityUpdated, taskStatusUpdated,
  taskAssigneeUpdated, taskDueDateUpdated, taskTagUpdated, taskMoved, taskCommentPosted,
  taskCommentUpdated, taskTimeEstimateUpdated, taskTimeTrackedUpdated, list*, folder*, space*, goal*,
  keyResult*`. No `chat*`, no `doc*`. So a plain HMAC webhook (the task-producer pattern) **cannot**
  trigger on Chat. The ADR's read of reality holds.
- **Chat is triggerable only via a Chat Automation.** ClickUp Automations can fire a "webhook" action;
  the Chat trigger is "Message is posted". This is the path the Chat producer must use.
- **Still to verify (operator, in the ClickUp UI — not API-inspectable):**
  1. The workspace plan exposes the Automation **webhook action** (it is plan-gated on some tiers).
  2. The "Message is posted" trigger can be **conditioned on a bot @-mention** (or we accept it fires on
     every channel message and gate the bot-mention in the producer via the tagged-users endpoint).
  3. The exact webhook payload fields (channel id, message/comment id, text, author user id) — capture a
     real firing before wiring `Build Enqueue Job`.

## G2 — Doc trigger via mentions feed (FAIL — no API)

- **ClickUp has no public notifications / inbox / mentions API.** It is absent from `llms.txt` and the
  public-API feedback board records it as *not on the roadmap*
  (`feedback.clickup.com/public-api/p/inbox-and-reminders-via-api`). The bot's "unanswered-mentions
  feed" the ADR proposes to poll **does not exist as an endpoint**.
- **The ADR's named fallback (command-marker poll of a watched Doc set) only half-survives.** Doc *page
  body* text is readable (Docs v3 page read, already used by ADR-054), so a marker placed in the doc
  **body** could be polled. But a marker in a doc **comment** cannot — there is no Doc-comments API
  (G3). So the fallback degrades from "comment mention" to "body marker".

## G3 — Doc delivery via comment reply (FAIL — no API)

- **There is no Doc-comments API.** `llms.txt` lists task comments, list comments, and chat-view
  comments — but **nothing for Docs or Doc pages**, neither read nor create. Threaded reply
  (`POST /api/v2/comment/{comment_id}/reply`) exists **only for task/list/chat-view comment ids**, not
  Doc comments. The MCP likewise exposes Doc *page* tools (`get/list/create/update_document_page`) but
  **no Doc-comment tool**.
- Consequence: "reply as a threaded comment under the invoking Doc comment" — the ADR's Doc delivery —
  **is not implementable on the current public API**. The only API-feasible Doc deliveries are: (a)
  **in-place page edit** via `update_document_page`/`create_document_page` (this is ADR-066's **R3**,
  rejected as default per ADR-050), or (b) **redirect output to a task/chat** instead of the Doc.

## Net conclusion (Block 0 DoD)

Block 0's DoD was "every trigger and delivery surface confirmed reachable for the bot user, or its
fallback chosen (G2)."

- **Chat: reachable.** Read, threaded reply, and invoker identity confirmed (G4/G5). Trigger mechanism
  confirmed (Chat Automation), pending an operator UI check of plan + mention-condition (G1). **Blocks 1
  and 2 (surface dimension + Chat path) can proceed.**
- **Doc: NOT reachable, and the named fallback is not reachable either.** In-Doc comment-based
  invocation and delivery are impossible on ClickUp's current public API (no notifications API, no
  Doc-comments API). **Block 3 (Doc path) is BLOCKED pending an operator decision**, and ADR-066's Doc
  decision needs an amendment to reflect API reality.

## Options for the Doc surface (for the operator's decision — recorded, not chosen)

1. **Defer Docs (recommended interim).** Build Chat now (the genuinely reachable new surface). Hold the
   Doc path until ClickUp ships a notifications and/or Doc-comments API (the standing feature requests),
   at which point Block 3 becomes a real webhook/poll fast-path. Lowest risk, no rejected-pattern debt.
2. **Body-marker + in-place-edit Doc path.** Poll a watched Doc set's **body** for a command marker
   (readable today) and deliver by **appending a delimited response block to the page** (R3 / in-place
   edit). API-feasible now, but adopts the exact pattern ADR-050 and ADR-066-R3 reject as default;
   would need an ADR amendment justifying the exception and a no-overwrite-of-human-content guard.
3. **Route Doc work through Task/Chat.** Treat "I want the agent on this Doc" as a Task or Chat mention
   that references the Doc; the agent reads the Doc via the ADR-054 MCP and replies on the reachable
   surface. Uses only confirmed surfaces; not "in-Doc", but no rejected-pattern debt.
4. **R2 — bridge through ClickUp's native AI surface.** Reintroduces the native-agent dependency the
   system avoids; deferred unless a latency-sensitive in-Doc workflow demands it.
