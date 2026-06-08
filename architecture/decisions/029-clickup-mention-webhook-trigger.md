# ADR-029: ClickUp @-mention webhook trigger (automatic runs) + agent→agent loop guard

Date: 2026-06-08
Status: Accepted (built + verified live: a `@Agent Haxe` mention on `869dhad2q` ran the
spine end-to-end — `triggered_by=explicit_mention`, caller resolved to the mentioner,
rules loaded, draft posted).

## Context
Through Increment 1 the spine could only be started by hand (the Form Trigger). The
core model (`current.md`) calls for **automatic** runs: a human (or another agent)
@-mentions the agent on a ClickUp task, and the agent picks the work up. ClickUp emits a
`taskCommentPosted` webhook; we need a thin producer that decides "is this a real
mention of the agent?" and, if so, starts `Agent Spine (v1)` with the right caller/reviewer
attribution — without coupling the spine to ClickUp's webhook retry window.

## Decision
A dedicated **`CU Webhook Producer (v1)`** workflow (id `eS66Sk6fweQ0EOPa`) is the
production entry point; the spine gains a second trigger (`When Called`,
`executeWorkflowTrigger`) that the producer invokes. The Form Trigger stays as the manual
test harness. Flow:

`CU Webhook` (POST `/webhook/cu-comment`, `responseMode: onReceived` → instant 200, decoupled
from ClickUp's retry window) → `Get Comments` (the webhook payload doesn't reliably carry the
mention tags, so we re-fetch the task's comments) → `Detect Mention` (pure shaping) →
`If Mentioned` → **loop guard** → `Run Agent Spine`.

- **Mention detection.** Newest comment is "for the agent" iff it contains a `tag` block
  with `user.id = 99811284` (Agent Haxe). The **caller/reviewer = the comment author** (the
  mentioner). This matches "we mention each other, we don't assign" (ADR-027): the resulting
  draft @-mentions whoever called.
- **Reviewer rule (ADR-027) holds.** On the mention path the reviewer is unambiguous — the
  mentioner — so the assignee→creator fallback isn't needed here.
- **Webhook scope + secret.** The webhook is registered against the `Lista testy AI` list
  only (blast-radius containment for the MVP). The signing secret lives in n8n / ClickUp,
  **never in the repo** (signature verification is a known TODO — see Consequences).
- **Attribution.** The producer passes `triggered_by=explicit_mention`,
  `invocation_type=explicit`, plus `taskId`, `reviewer_user_id`, `caller_username` into the
  spine, which logs them on `agent_runs`.

### Agent→agent chaining + loop guard (operator decision 2026-06-08)
The original `Detect Mention` ignored any comment **authored by the agent** — a hard
loop-break. The operator wants to relax this so an agent can deliberately mention the agent
(agent A commits an artifact, then points another agent at it). We removed the
`author != agent` skip, with two reasons it is safe:

1. **Normal human-initiated runs never loop.** The agent's auto-draft @-mentions the *human*
   reviewer, not the agent, so the producer's "is the agent tagged?" test fails on the draft →
   no re-trigger. (Verified: the post-back drafts produced `matched:false`.)
2. **The only loop is a real agent→agent chain** (caller = agent → draft mentions the agent →
   re-triggers). To bound it we added a **circuit breaker**: before running, `Recent Runs`
   counts `agent_runs` for the task in the last 10 minutes; `Under Limit?` allows the run only
   if `< 8`, else routes to `Alert Loop Breaker` (WARN via the Post Alert seam, ADR-025).
   `Recent Runs` is `onError: continueRegularOutput` so a DB hiccup degrades to "allowed"
   rather than blocking legitimate work.

This honors the CLAUDE.md reliability rule (a feature that could silently run away gets an
error/over-limit path that posts a note), at a worst-case bounded cost of ~8 runs (~2–3 PLN)
before a runaway chain is cut.

## Consequences
- The agent now runs **automatically** on a real ClickUp mention, attributed to the
  mentioner — verified live on `869dhad2q`.
- Agent→agent chaining is enabled but **bounded** (≤ 8 runs / task / 10 min). The threshold
  is a deliberate, tunable guess; revisit if real chains need more depth, or replace the
  count-based breaker with explicit chain-depth metadata once the artifact-handoff pattern
  is designed properly.
- **Known gap — signature verification.** The producer does not yet verify ClickUp's
  `X-Signature`. Until it does, the webhook trusts any caller who knows the URL. Acceptable
  for the MVP (obscure path, list-scoped, low blast radius); must be closed before the agent
  acts on anything sensitive. Tracked as the next hardening step.
- The breaker also caps accidental human storms (8+ mentions on one task in 10 min) — an
  acceptable edge.

Related: ADR-027 (post-back draft + reviewer rule + mention-not-assign), ADR-026 (capability
containment — deterministic nodes only), ADR-025 (alert seam), ADR-015 (one generic
pipeline), ADR-024 (`agent_runs` / cost), ADR-004 (Docs v3 rules loading).
