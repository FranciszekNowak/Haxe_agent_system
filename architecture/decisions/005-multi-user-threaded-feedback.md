# ADR-005: Multi-user threaded feedback over single-rater fields

Date: 2026-05-28
Status: Accepted

## Context
Initial schema stored feedback on an agent output as single columns on
`agent_runs` (`human_rating`, `human_assessment`, one rater). Real evaluation is
multi-person and evolves: one person approves, another objects, they discuss,
positions shift.

## Decision
Move feedback into a dedicated append-only table (`agent_run_evaluations`), and
mirror the same structure for proposals (`agent_proposal_evaluations`). Each row
is one timestamped contribution carrying an optional boolean rating and/or a
comment. No UNIQUE constraint on (run, user): the same person appears in
multiple rows over time, preserving the full history. "Current stance" is derived
as the most recent row per user via `DISTINCT ON ... ORDER BY created_at DESC`.

## Alternatives considered
- Single-rater columns (original): cannot represent disagreement; loses history.
- Separate comment table + separate reactions table: duplicates structure; forces
  every comment row to carry a redundant boolean or a cross-table join to know a
  commenter's stance at the moment they spoke.
- JSONB array of comments: not cleanly queryable across rows; no per-row indexing.

## Consequences
- Disagreement and its evolution are first-class, queryable data.
- Two evaluation tables share one shape → consistent mental model and queries.
- "Current stance" is a derivation, not a stored value (consistent with ADR-006).
