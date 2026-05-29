# ADR-008: No application-tracking columns on proposals

Date: 2026-05-28
Status: Accepted

## Context
Proposals originally tracked implementation (`applied`, `applied_at`,
`applied_to_artifact`). Setting these reliably requires manual marking after
editing an artifact.

## Decision
Remove these columns. Whether an accepted change was implemented is not tracked
in the database.

## Rationale
- Implementing a change (e.g. editing a persona file) leaves no queryable trace,
  so the field could only be populated by an easily-forgotten manual step.
- An unmaintained status field is worse than none: it looks authoritative but
  lies.
- Non-implementation of good changes is a people/culture problem, and it surfaces
  naturally as the same patterns recurring in artifact evaluations.

## Consequences
- No built-in "implementation backlog" query. Accepted by the operator on the
  assumption that the team implements accepted changes as a matter of culture.
- Reversible: if reliable tracking becomes possible (e.g. git-hook detection of
  artifact changes), reintroduce in a later migration.
