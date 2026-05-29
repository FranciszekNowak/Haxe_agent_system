# ADR-009: Constrain fields only where automation depends on them

Date: 2026-05-28
Status: Accepted

## Context
Several categorical fields exist (`proposed_change_type`, `change_category`,
`status`, `triggered_by`, `importance`). Question: which get CHECK constraints?

## Decision
- CHECK-constrain fields whose exact values drive workflow branching:
  `proposed_change_type` (prompt/template/process/config/rule), `triggered_by`,
  `invocation_type`, `status`, `importance`, `proposal_tier`.
- Leave free-form fields whose values are only read for semantic meaning:
  `change_category` (the GM agent clusters slight variations like
  'tone_shift'/'tone_adjustment' semantically at analysis time).

Also retained the `failed` vs `error` distinction in `agent_runs.status`
(failed = known business-logic failure / config issue; error = unhandled
exception / bug) and the `explicit_mention` vs `explicit_command` distinction in
`triggered_by`.

## Rationale
- Constraints prevent bad data where a typo would break automation.
- Free-form avoids false precision and premature taxonomy where an LLM reads the
  value anyway.

## Consequences
- Clear rule for future schema fields: does automation switch on the exact value?
  If yes, constrain; if only meaning matters, leave free.
