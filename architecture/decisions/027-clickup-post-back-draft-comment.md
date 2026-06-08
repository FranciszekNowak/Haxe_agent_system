# ADR-027: Post agent output back to ClickUp as a draft comment

Date: 2026-06-08
Status: Accepted (Increment 1 built + verified live on `Lista testy AI` task `869dhad2q`).

## Context
The spine read context → routed → invoked the model → logged cost, but produced **nothing
the team could see** on the task (only a Supabase `agent_runs` row + the `[AI] Koszt akcji`
field). Core-model step 5 (`current.md` §87–97) requires: *"Post output back to ClickUp —
draft as comment, @-mention reviewer. Never auto-finalize."* This is the change that turns
the spine into something that delivers visible value, and it pays off immediately even on
the manual (form) trigger.

## Decision
Add a deterministic **`Post Draft Comment`** node to `Agent Spine (v1)` (after
`Call Invoke Model`, fanned out alongside the cost-sync): a ClickUp `comment / create` on the
task whose body is the model completion + a footer (`model`, `cost_pln`, "do weryfikacji —
nie finalizuje zadania"). The comment is **assigned to the reviewer** (`additionalFields.assignee`)
so they're notified.

- **Never finalize.** The node only posts a comment — it never sets task status nor the
  `[AI] Finalny, zaakceptowany efekt` field. Acceptance stays a human action.
- **Capability containment (ADR-026).** This is a fixed, version-controlled node; the LLM
  has no part in deciding to write — it only produced text.
- **Reviewer rule (operator decision 2026-06-08):** *manual* run → the person who triggered
  it (an optional `reviewer_user_id` form field; default = operator `2521617`). *Automatic*
  run (Increment 2) → task **assignee → creator**. `Context Gather` now surfaces
  `assignee_user_id`/`creator_user_id` so the automatic path is data-ready.
- **Output shape.** `Build Prompt` instructs a soft structure (§13.1, Polish):
  **Wyniki / Pytania do zlecającego / Decyzje i kompromisy / --- / Sugestie do procesu** —
  the model may reason freely but returns in this shape. Interim until the real
  GLOBAL-agent-rules assembler (core-model step 3).
- **Non-blocking (CLAUDE.md reliability rule).** `onError: continueErrorOutput` →
  `Post Alert` WARN (`agent-spine/post-back`); the run still returns the completion.

## Consequences
- The agent now leaves a reviewable draft on the task, attributed to **"Agent Haxe"**
  (`agent@haxe.com`) and assigned to the reviewer — verified: a structured Polish work
  product (with a ready-to-send RFQ template, a decision table, clarifying questions, and
  process suggestions) was posted to `869dhad2q`, `resolved:false`, nothing finalized.
- **Assignment ≈ notification, not a literal inline @-mention.** Assigning the comment puts
  it in the reviewer's ClickUp inbox and notifies them — functionally "this is for you." A
  true inline `@name` tag needs the richer comment-block payload (HTTP to the v2 comment
  endpoint) and is deferred as a nicety.
- The `Build Prompt` structure is a stopgap; it will be subsumed by the GLOBAL agent-rules +
  person-preferences assembler (Increment 3).

Related: ADR-015 (one generic pipeline / core model), ADR-026 (capability containment —
deterministic writes, never LLM-exposed), ADR-020 (Context Gather shape), ADR-024 (cost),
ADR-013 (centralized invocation). Next: Increment 2 (CU webhook trigger → automatic runs,
where the assignee→creator reviewer rule applies).
