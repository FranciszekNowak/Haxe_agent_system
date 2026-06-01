# ADR-016: KM maintenance — human-only edits; AI proposes, monitors, nudges

Date: 2026-06-01
Status: Accepted (monitoring/learning layer DEFERRED until the pipeline is proven)

## Context
A chief goal of the agent system is to monitor and help maintain the quality and
scope of the internal knowledge-management (KM) system: the docs cascade (paste-ready
leaves + "Why" toggles), the templates (checklist-in-description + doc-links +
self-links), and the rules. This aligns with stated company philosophy — docs as the
compounding core, "leave docs better than you found them," "conclusions immediately
to checklists," "work ON the process beats work IN the process." Key question: should
the agent system edit KM docs directly (closed write-back)?

## Decision
**AI never edits the KM system. Humans are the sole writers. The agent system is
proposer + monitor + nudger only.**

Rationale for human-only edits:
1. The human writing/curating (even copy-pasting a proposal) creates psychological
   ownership — people stay in charge.
2. It introduces deliberate friction and judgment — the scarce resource (with AI the
   bottleneck is curation/selection, not speed).
3. It prevents doc bloat.

**Maintenance loop:**
1. *Exercise* — every generic-pipeline run consumes leaves/checklists; heavy human
   correction ⟺ a deficient leaf. Usage continuously tests the KM system.
2. *Propose* — runs (and/or an evaluator/GM agent) emit learning proposals into
   Supabase `agent_proposals`: Tier 1 (artifact fixes), Tier 2 (notes on
   checklist/leaf/system), Tier 3 (notes on notes). Surfaced to humans.
3. *Curate + implement* — the human reviews, judges, and edits the leaf themselves.
4. *Measure implementation* — an informational logs column records whether a
   doc/description edit occurred within ~20–60 min of a human accepting a proposal,
   and (conditionally) whether the edit corresponds to that accepted proposal. The
   correspondence check uses a lightweight model comparing the edit/diff to the
   proposal IF the ClickUp API exposes the description/doc diffs the UI shows; if
   obtaining diffs would require local caching, fall back to timestamp-only
   (edit-happened-in-window) to avoid disproportionate overhead.
5. *Nudge* — the evaluator/GM agent surfaces accepted-but-unimplemented proposals
   (and gap-audit findings). Closes the loop socially, not mechanically.

**Gap-detection (accepted):** a periodic KM-audit pass crawls docs/templates for
structural holes — contested/judgment rules missing a "Why" toggle, checklist steps
with dead/empty links (link-rot is confirmed present), processes without templates,
stale leaves. It proposes, never fixes.

**Why-toggles are a guardrail, not just hygiene:** documenting WHY a contested rule
exists lets the system and humans respect Chesterton's fence and reason about edge
cases. Required on any contested / judgment-dependent rule.

## Explicitly abandoned
- AI write-back / AI editing of docs (rejected — human-only).
- Self-sufficiency as a separate probe (intrinsic to the single-input architecture;
  see generic-pipeline ADR).
- Compounding measurement by correlation (leaf-change → outcome-change): abandoned
  for lack of statistical significance at Haxe's volume.

## Consequences
- The KM system improves only as fast as humans implement accepted proposals; the
  implementation-gap measurement + nudging keeps that honest without surrendering
  human ownership.
- This whole layer is DEFERRED until the generic pipeline (spine) is proven
  end-to-end. The ClickUp-diff-availability probe is part of building this layer,
  not before.
