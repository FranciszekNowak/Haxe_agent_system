# ADR-041: Data subject erasure and retention posture

Status: Accepted. Builds on ADR-040 (global model routing, PD-blind pipeline). Does not change model routing or the multimodal reading path.
Date: 2026-06-10

## Context

ADR-040 removed personal-data routing and made the pipeline PD-blind (migration 021). Two controller-side duties remain that do not depend on model location and are not satisfied by routing: the ability to erase a data subject's data on request (Art 17), and bounded, purposeful retention (Art 5(1)(e)). This ADR sets the minimal, proportionate mechanisms for both, scoped to our actual data: low-sensitivity operational data (customer service, B2B contacts) and employee wage and address data. None of it is special-category (Art 9) data.

We are mid-build on multimodality (Docling to agent spine; image and PDF reading works). Nothing here changes that path.

## Decision

### Erasure: one key on the hub

- `agent_runs` is the erasure hub. Every store that can hold personal data either references `agent_runs` by foreign key, or has its external artifacts (ClickUp comment ids, Drive file ids) recorded on the `agent_runs` row.
- Add a nullable, indexed `subject_key` column to `agent_runs`. The key is the channel-natural counterparty identifier taken from envelope metadata, never from content: the counterparty email for the email channel (Gmail and ClickUp-CRM-composed mail). Non-email channels leave it null for now.
- The pipeline stays PD-blind. `subject_key` is provenance from the channel, not a content classification.
- Identity resolution happens at erasure time: match `agent_runs` against any identifier the requester provides. We do not unify identities at ingestion.
- Erasure is manual via a documented runbook: query `agent_runs` by subject_key, cascade-delete linked rows, delete recorded external artifacts via API, write an erasure log entry as evidence (the one thing kept after deletion is proof it happened).

### What we deliberately do not build

- No body-text PII classifier and no cross-table forensic deletion of incidental mentions. Disproportionate under the Art 17 reasonable-effort standard for low-sensitivity data. The residual is bounded by retention.
- No PD logic in the learning corpus. The corpus holds generalized learnings, not raw identifiable personal data. If erasure ever requires it, traverse from `agent_runs` to the linked learning rows and delete manually.

### Retention

- Operational low-sensitivity data (customer service, B2B): long retention is defensible under a documented purpose (operations, the learning system, continuity). No fixed deletion cadence is required. A periodic review ("do we still need records this old") is the backstop so the store is not literally immortal.
- Employee wage and address data: retained per the statutory employment-records period (Poland, roughly ten years post-employment; confirm the exact figure). Lawful basis is legal obligation (Art 6(1)(c)) plus legitimate interest for cost analysis. Erasure is overridden during the statutory period (Art 17(3)(b)). This is employment-records governance that exists independent of the agent; ClickUp is one more location a copy lives.
- The permanent learning store stays free of raw identifiable personal data, so storage limitation does not touch it.
- Optional future: pseudonymize the historical wage series past the statutory period to keep analytical value without indefinite raw-identity retention. Not now.

### Scope and timing

Email is not wired yet, so subject_key population and the erasure runbook activate with the email channel. Now we only make the schema ready (the nullable column, the hub references) at zero behavioral risk, and we write the documentation.

## Consequences

- Add `subject_key` (nullable, indexed) to `agent_runs` (migration 022). Zero behavioral change; nothing reads or writes it yet.
- Ensure `agent_runs` records the external artifact ids it creates (ClickUp comment ids, Drive file ids — `clickup_comment_id` / `drive_file_id` added in migration 022). Confirm, do not yet enforce, that every PD-capable store links back to `agent_runs`.
- No retention deletion job is built now. The retention posture is documented and reviewed.
- The GDPR processing-decisions document records the bases and merits as the accountability record (Art 5(2)).

## Relationship to other ADRs

Builds on ADR-040. Does not alter model routing, the Docling reading path, the agent spine, or context gathering.
