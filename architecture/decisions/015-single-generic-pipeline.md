# ADR-015: One generic agent pipeline — no per-process agents

Date: 2026-06-01
Status: Accepted

## Context
The system was at risk of being conceived as a collection of per-task / per-process /
per-stage agents, each with its own persona and instructions. That implies large
per-process engineering overhead and does not scale. The intended design is the
opposite: a single generic mechanism whose task-specific behaviour comes entirely
from ClickUp data, not code.

## Decision
There is exactly ONE agent mechanism — "the generic pipeline" — built once in n8n.
There are no per-process, per-task, or per-stage agents, ever.

**Innate behaviour (identical for every process and person):**
1. Trigger — autonomous (ClickUp status/field webhooks + the daily due-date scan,
   gated by `Czy dla AI`) or explicit pull (@-mention / ~command on a ClickUp task).
   Both modes are retained; the Phase 2 spine exercises the pull path first and
   autonomous triggering follows immediately (Phase 3).
2. Read ClickUp via the universal structural conventions: task description = the
   checklist of steps; linked doc leaves = detailed / paste-ready guidance; parent
   chain = context (materials live in the parent; spec files in the parent's
   description; verification requested in the dedicated verification subtask).
3. Read two configuration inputs, also data (not code):
   - the GLOBAL agent-rules doc (universal rules: red-team; quality-first; never
     invent specs; self-critique against the task's leaf checklist; structural
     conventions; brand non-negotiables);
   - the invoking PERSON's agent-preferences doc (personal working prefs — forms of
     address, "consult my private vault" hooks, etc.).
4. Assemble → invoke model (routed by importance/sensitivity via the centralized
   model-invocation sub-workflow; see routing ADR).
5. Post output back to ClickUp per conventions (material in parent; draft as a
   comment; @-mention the reviewer). Never auto-finalize.

**All task-specific behaviour is DATA in ClickUp** (checklist-in-description + doc
leaves). n8n holds only the generic procedure and the universal conventions.
**Adding a capability = authoring a ClickUp checklist + leaf — not writing an agent.
Zero code change.** A named `~command` is data in the same spirit: n8n keeps a
command registry (`command_name` → ClickUp prompt-doc link/ID, plus optional
metadata) and loads the command's prompt from its ClickUp doc at runtime — adding a
command is one registry row + a CU doc, still no n8n code.

## Consequences
- Scales to every process/person and to 10→100→1000 people with no per-process
  engineering — satisfies the org-design requirement (near-optimal at every scale,
  minimal senior intervention).
- KM self-sufficiency is enforced INTRINSICALLY: the model receives only what ClickUp
  provides, so a deficient leaf yields bad output and the human correction localizes
  the deficiency. A separate self-sufficiency probe is therefore unnecessary
  (explicitly abandoned).
- Genericity DEPENDS on structural discipline: the generic "read the task" procedure
  works only because ClickUp structure is consistent (checklist in description,
  materials in parent, leaves linked, Why-toggles present). Gap-detection (see
  KM-maintenance ADR) is therefore load-bearing — it protects genericity, not a
  side feature.
- There is no "first agent" in the per-process sense. The first build milestone is
  the generic pipeline working end-to-end on its first task (the product-description
  task), with all product-description specifics living in ClickUp.
