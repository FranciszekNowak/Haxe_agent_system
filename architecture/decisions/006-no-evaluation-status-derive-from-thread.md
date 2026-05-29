# ADR-006: No evaluation_status column — derive acceptance from the thread

Date: 2026-05-28
Status: Accepted

## Context
Proposals (`agent_proposals`) originally carried an evaluation lifecycle
(`evaluation_status`, `evaluated_at`, `evaluated_by_user_id`). But the evaluation
*is* the threaded feedback in `agent_proposal_evaluations`. A separate status
column would duplicate that and risk drifting out of sync with the actual
discussion.

## Decision
Remove the evaluation lifecycle columns. Whether a proposal is
accepted/rejected/contested is derived by the GM agent from the evaluation
thread at analysis time. The GM agent records its synthesized verdict as a row
in `agent_proposal_evaluations` with `commenter_user_id = 'gm_agent'` — its
decision becomes the most authoritative entry in the same thread it analyses.

## Rationale
- Don't store what you can derive from references on demand.
- A human-maintained status column drifts; the thread is the ground truth.
- gm_agent verdicts living in the thread enable recursive self-reflection: the
  GM agent can later analyse whether its own past calls held up (see ADR-007).
- A ClickUp custom field is unsuitable: one task spawns multiple agent threads,
  so a task-level field would conflate distinct evaluations.

## Consequences
- "Show me pending proposals" requires the GM agent to interpret threads rather
  than filter a column. Acceptable at this volume.
