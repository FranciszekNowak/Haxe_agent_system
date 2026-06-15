# ADR-050: Interplay between Google Workspace native AI and the custom agent system

**Status:** Przyjęta / Accepted (with named follow-ups and revisit triggers)
**Date:** 2026-06-15
**Related:** ADR-049 (file storage and access architecture), ADR-043 (GDPR posture), ADR-035 (sole `agent_runs` writer and cost owner), the `comment_native` delivery pattern

## Context

Having adopted Google Workspace as the file and mail layer (ADR-049), the open question is how Google's native AI (Workspace Gemini, Gems, NotebookLM, the Docs/Sheets/Gmail side-panel assistants) should relate to the custom n8n agent system: which work moves onto Google tools, which stays in the agent, and whether to buy a higher tier to close the gaps.

One technical constraint sets the whole boundary. Workspace Gemini grounds only in Workspace data the signed-in user can access, it cannot read ClickUp (not a Google property), it automatically respects Drive per-user permissions because it grounds as the user, and Workspace data is not used to train the models. The custom agent, by contrast, is the only component that spans ClickUp plus Drive plus external sources and models, runs unattended on event triggers, and carries the governance (model-tier routing, cost logging per ADR-035, never-invent enforcement, deterministic delivery).

## Decision

### 1. Two complementary layers, not competitors

Native Gemini is the horizontal, in-app, human-in-the-loop assistance layer over Workspace content. It is adopted fully, because it is bundled into Business Standard at no marginal cost. The custom agent is the vertical, orchestrated, cross-system, unattended, governed automation layer, and continues to be built. They occupy different axes and neither replaces the other.

### 2. The boundary is Gemini's grounding scope

Anything that needs ClickUp awareness, cross-system reach, unattended execution, or domain-and-governance fidelity belongs to the agent. Anything that is a human improving their own in-app work over Workspace content uses native Gemini and is not built. A workflow that is both is split at the boundary: the agent assembles across systems and lands a Workspace artifact, and native Gemini finishes it in place with the human.

### 3. Process state stays in ClickUp; authoring happens in Google

Workflow and process tracking is not moved onto Google tools; ClickUp remains the single source of truth. Document and spreadsheet authoring happens in Google apps with native AI, and the resulting artifacts follow the ADR-049 lifecycle.

### 4. Domain logic in Gemini is a derived projection, never an authority

Rules pushed into Gems (email rules, brand rules) are read-only copies of canonical rules that live in ClickUp and the agent configuration; they are refreshed when the canonical changes and never become a second authority. Brand-critical, unattended, or cross-system generation goes through the agent, which holds the canonical rules at full GRACE fidelity. Everyday, human-reviewed convenience drafting may use Gems, and that is safe only because the heavy fidelity is already applied upstream by the agent, leaving the human's Gems work as light refinement.

### 5. Email split

Interactive personal drafting uses personal Gems (zero build, human-invoked, the person's rules live in the Gem). Triggered or context-rich drafting, such as an incoming customer email that should auto-draft a reply using ClickUp order data, goes through the agent, which generates the draft and appends it via the Gmail API drafts endpoint for human review.

### 6. Agent file delivery and the artifact round-trip

a. The agent creates and delivers files. It does not edit human-authored files in place (deferred as over-engineering, see R5).

b. For deliverable types that are routinely edited, the agent writes the file into the target user's own My Drive temp area by impersonating that user (the file is user-owned and auto-scoped, reusing ADR-049 domain-wide delegation), converting on upload to a native Google Doc or Sheet so it opens ready for Gems. Deliverables where exact layout matters more than editability are left as `.docx` or `.xlsx`.

c. The agent posts the as-generated binary into the ClickUp comment as the permanent record, with the Drive link beneath it as the editable working copy. The two copies have distinct roles, record versus working copy, so keeping both is justified rather than redundant.

d. **Round-trip rule (firm).** When the human finishes polishing in Drive, they always convert the cloud file back to an on-disk binary and post it to ClickUp as the final. ClickUp always holds the canonical final, not just the agent's draft. The reasons are that the agent must be fed the final result and a raw binary is far easier for it to consume than a cloud link, and that the conversion is about three clicks for the human. Corollary, and the load-bearing part: the agent always consumes binaries from ClickUp, never cloud links. This keeps the agent's input contract simple and stable.

e. The Drive temp copy is disposable, because both the permanent record and the final live in ClickUp. No automated cleanup is built; users manage their own My Drive temp area, with at most a light periodic sweep, and never a fixed-timer auto-delete that could wipe an in-progress edit.

f. For final or read-only outputs, a plain ClickUp attachment is the whole delivery and the Drive editing lane is not built.

### 7. No shadow automation

Native AI for human-in-the-loop assistance is encouraged. Anything unattended, or anything that makes a business decision, stays in the governed agent system and is never built as an ad-hoc Gem or Workspace Studio flow. This keeps governance (routing, cost, never-invent, audit) from fragmenting into ungoverned AI scattered across the suite.

## Rejected alternatives

**R1. Buy Gemini Enterprise for ClickUp connectors and cross-system human search.** Rejected for now. List pricing of roughly 21 USD (Business), 30 USD (Standard), or 50 USD (Plus) per user per month, plus a metered compute uplift and an annual commit, on top of the Workspace seats, is disproportionate for five people. It overlaps a capability the agent already has, since the agent reads ClickUp natively and Drive by impersonation, and it does not replace the governed orchestration. The cheaper path to the same human benefit is to expose the existing agent behind a simple chat surface and use Gems for Drive-only questions. Revisit triggers: meaningful team growth plus a frequent, painful need for ad-hoc human cross-system search.

**R2. Migrate production orchestration onto Gemini Enterprise no-code agents.** Rejected. It would trade multi-provider model routing, cost governance, never-invent enforcement, and deterministic delivery for Google lock-in plus per-seat and compute pricing, giving less control at higher cost.

**R3. Move process or workflow state onto Google tools (Projects, Sheets, etc.).** Rejected. It fragments the single source of truth in ClickUp and violates the one-authority principle.

**R4. Make native Gemini-in-Docs enforce brand rules directly from the ClickUp brand book.** Impossible, because Gemini cannot read ClickUp, and rejected as a goal. Brand fidelity stays upstream in the agent, with an optional derived Gem for in-document convenience.

**R5. Have the agent edit human-authored cloud files in place.** Deferred as over-engineering. Create-and-deliver captures the value; in-place read-modify-write of Google Docs and Sheets is high build for niche value, and is revisited only if a concrete recurring need names itself.

**R6. Deliver editable artifacts as a Drive link only, or keep the final only in Drive.** Rejected. The agent must consume the final as a binary, and ClickUp must hold the canonical record and final; a link-only final would force the agent to dereference cloud files and would split the source of truth.

**R7. Per-user temp folders as Shared Drive folders with per-user ACLs.** Rejected. It reintroduces per-user folder ACL management; the user's own My Drive via impersonation provides ownership and scoping for free.

**R8. Auto-delete the Drive temp area on a fixed timer.** Rejected. It risks wiping in-progress edits; disposability is a property to lean on, not a deletion schedule to enforce.

## Consequences

Positive:

- A free, mature human-productivity layer is adopted at zero marginal cost, while the differentiating orchestration layer is preserved.
- One clear boundary and a one-line routing rule (human-improving-own-in-app-work uses native Gemini; unattended, cross-system, or domain-and-governance work uses the agent; split at the boundary when both).
- ClickUp remains the single canonical record and final, and the agent's input is always a clean binary, never a cloud link, which simplifies and stabilizes the agent's input contract.
- No second permission authority and no second rules authority; Gems hold disposable, derived copies.
- No enterprise spend, and governance is preserved by the no-shadow-automation rule.

Costs and limits, accepted knowingly:

- Humans perform a small manual round-trip (cloud to binary to ClickUp, about three clicks) on edited deliverables.
- Gems carry a sync obligation for any projected rules, and native Gemini brand fidelity is lower than the agent's, so brand-critical work must stay with the agent.
- Convert-on-upload can shift complex formatting, so `.docx` or `.xlsx` is preserved where layout is the point.
- Restricting Gemini's reach into sensitive data requires Enterprise DLP and IRM (out of scope at Business Standard per ADR-049 R9), so the control surface is the Drive ACL structure itself.

## Open questions and follow-ups

1. Pilot a brand or email Gem and measure whether human-reviewed convenience drafting is good enough, or whether more should route through the agent.
2. Define which deliverable types count as routinely edited (and get the Drive editing lane) versus final or read-only (plain ClickUp attachment).
3. Confirm convert-on-upload fidelity per deliverable type, marking where docx-to-Google-Docs is acceptable and where the Office format must be preserved.
4. Revisit Gemini Enterprise only on the named growth and frequent-cross-system-search triggers.

---

*Pre-commit checks: confirm 050 is the next free ADR number in `architecture/decisions/` before committing. This records the interplay decisions; the concrete per-user My Drive temp layout and the agent's upload/convert implementation are a build-time artifact referenced from here, not part of this ADR.*
