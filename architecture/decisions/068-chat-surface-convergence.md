# ADR-068: ClickUp Chat surface convergence (task XOR chat, one spine)

Date: 2026-06-30
Status: **Accepted — live in production, retroactively codified.** The feature was built **live** (n8n UI)
across `Agent Orchestrator (v1)` (`a8XKaijkMFNBpRBa`), `Post Reply (v1)` (`t17moGs7Vxo5ZcFv`),
`Spine HTTP Ingress (v1)`, and a new chat Stage-A reader (`Assemble Chat Context`, `BppZsqTi46Bz5dsG`)
without an ADR or a repo write-back. This ADR records what shipped (reconstructed from the live graph) and
was written when the drift was discovered and written back on 2026-06-30. Chat delivery is **text/markdown
only** in the shipped state (image/doc delivery to chat deferred).

> **Numbering note.** The live node `notes` originally labelled this work "ADR-066 surface convergence."
> That number collides with **ADR-066 (external session waiter)** and **ADR-067 (downloadable generated-image
> bytes)**, both reserved by the active session-waiter master plan. This work was renumbered to **ADR-068**;
> the live node notes and the repo workflow JSON were updated to match (2026-06-30). If you find a stray
> "ADR-066 surface convergence" reference, it predates this renumber.

## Context

The agent had a single delivery surface: a **ClickUp task**. Invocation came from a task `@`-mention or a
`~command` (CU Webhook Producer → spine), Stage A assembled context from the task, and the answer was posted
as a task comment with the task's `[AI] Status agenta` / `[AI] Koszt akcji` custom fields updated.

ClickUp also has a **Chat** surface (channels + threaded messages). To let the team invoke the agent from a
chat message and get the answer back in-thread, the pipeline needed a second surface — without forking the
spine. The orchestrator, the managed/bare lane logic, the session executor, the cost/limit machinery, and
the output renderer are all surface-independent and must stay single-path (the repo's unification default:
one workflow, one contract, divergence is the exception). Only two things genuinely differ by surface:
**where context is read from** (task vs chat message/channel) and **where/how the answer is delivered**
(task comment + task-field writes vs a threaded chat reply).

## Decision

Introduce a `surface` discriminator (`task` — default/blank — XOR `chat`) plus a `surface_ref` payload
(for chat: `{channel_id, message_id}`, carried as a JSON string through the `convertFieldsToString` ingress)
and converge both surfaces onto the existing spine at two seams only:

1. **Stage-A read (orchestrator front).** A `Surface = chat?` IF routes to either `Call Assemble Task
   Context` (existing reader) or `Call Assemble Chat Context` (new reader `BppZsqTi46Bz5dsG`, which returns
   the **same contract** as the task reader). Both feed a **Merge** node deliberately named
   `Call Assemble Context`, so every downstream `$('Call Assemble Context')` reference stays
   surface-agnostic and the rest of the spine is untouched. On the task/blank/Form path the router also
   fires `Set Status W trakcie` (the task-field write is task-surface only).

2. **Delivery (Post Reply front).** A `Surface = chat?` IF at the head of `Post Reply (v1)` routes chat
   runs to `Build Chat Markdown` → `Post Chat Reply`. `Build Chat Markdown` reconstructs the answer as
   markdown (prefer the managed session's `output_message`; when the agent delivered via `deliver_output`
   with empty text — ADR-063 — rebuild from `output_blocks` text mds) and appends the attribution/cost
   footer. `Post Chat Reply` POSTs a threaded reply under the invoking message
   (`POST /v3/workspaces/761759/chat/messages/{message_id}/replies`, `content_format: text/md`, bot token),
   then **dead-ends** — no task status flip and no artifact record, both of which are task-bound. A failure
   fires `Alert Chat Reply Failed` (WARN via Post Alert (v1)); the main path still returns.

Supporting wiring: `When Called` (orchestrator) and `Post Reply (v1)` gain `surface`/`surface_ref` inputs;
`Resume After Gate` (the spend gate's item-restore) restores them; `Skip Cost If Chat?` bypasses the
task-bound `[AI] Koszt akcji` cumulative-field write on the chat surface (the per-execution image-cost SUM
still runs); `Spine HTTP Ingress (v1)` threads `surface`/`surface_ref` from the webhook body into the
orchestrator call. The managed and bare lanes, the session executor, render-agent-output, spend gate, and
image-cost accounting are all unchanged.

## Consequences

- **One spine, two surfaces.** A future spine change is made once and serves both surfaces; the only
  surface-specific code is the two routers + the chat reader + the chat delivery node. No forked
  orchestrator.
- **Chat delivery is text/markdown only.** Inline images, office-doc attachments, and the inline-attachment
  comment op are task-surface features; chat replies carry markdown (plus the attribution footer) only.
  Image/doc delivery to chat is deferred.
- **Task-bound side effects are correctly skipped on chat.** No `[AI] Status agenta` / `[AI] Koszt akcji`
  field writes and no `agent_runs` comment-id artifact record for chat runs (those reference a task that a
  chat run does not have). Cost is still **logged** to `agent_runs` and shown in the chat footer; only the
  task custom-field write is skipped.
- **Reliability.** A failed chat post is a WARN (never a thrown error) on a side branch, mirroring the task
  delivery's fail-soft posture; the run still returns its result.
- **Reconstruction caveat.** Because this shipped without a contemporaneous ADR, the rationale above is
  reconstructed from the live graph and node notes; the surface contract and behaviour are accurate as of
  the 2026-06-30 write-back, but any unstated original design intent is not captured here.
- **Drift lesson.** This feature ran in production for an unknown period with no repo artifact — exactly the
  bidirectional drift the write-back mandate exists to prevent. Surfaced only by `check-workflow-drift.mjs`
  while starting unrelated work (ADR-066 Block 1). The mandate stands: write live changes back in the same
  session.

## Follow-ups (not in the shipped state)

- Chat image/doc delivery (parity with the task surface) if needed.
- A dedicated end-to-end verification record for the chat surface (the shipped feature predates the
  Definition-of-Done discipline being applied to it).
