# ADR-007: Recursive learning via self-referencing proposals

Date: 2026-05-28
Status: Accepted

## Context
The system should improve not only its artifacts but its own improvement process
— the GM agent analysing proposals, and eventually analysing its own past
analyses.

## Decision
`agent_proposals` is self-referencing. A `proposal_tier` field (`artifact` /
`meta`) records the kind of analysis. Tier-1 (`artifact`) proposals set
`source_agent_run_id`; Tier-2+ (`meta`) proposals set `source_proposal_id`
(self-reference). Depth is unbounded — a meta-proposal may cite a meta-proposal.
All tiers live in the same two tables (`agent_proposals` +
`agent_proposal_evaluations`).

For broad synthesis spanning many sources, both FKs are null and the analysed
set is described in `change_description`; `proposal_tier` still records the kind.
A many-to-many `proposal_sources` junction table was deferred (over-engineering
at current volume).

## Rationale
- Self-referencing FK is the standard pattern for unbounded hierarchy.
- Explicit `proposal_tier` disambiguates the both-FKs-null broad-synthesis case.
- Schema permits infinite depth; the *workflow* gates activation (Tier-2 monthly/
  quarterly, Tier-3 rare/human-triggered) to avoid navel-gazing.

## Consequences
- Recursive self-improvement is expressible with no extra tables.
- Discipline required in the workflow layer to not over-run deep analysis.
