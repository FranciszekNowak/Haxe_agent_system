# ADR-020: Context-Gather workflow shape — native ClickUp node, Form Trigger, bounded parent-walk

Date: 2026-06-02
Status: Accepted

## Context
The first concrete workflow — `Context Gather (v1)` (n8n id `qgM37HdQj78Rn090`,
exported to `n8n/workflows/context-gather.json`) — reads a ClickUp task and
assembles one labelled context object (`current_task`, ordered `ancestor_chain`,
stub `linked_doc_leaves`, `truncated_at_depth`). Building it forced several
concrete choices on top of the principles in ADR-015 (one generic pipeline) and
ADR-019 (auth in credential-aware nodes, Code only shapes).

## Decision

### Native ClickUp node (Task → Get), not the generic HTTP Request node
Both are credential-aware "normal" nodes and both satisfy ADR-019. The native
ClickUp node was chosen because it is more visually inspectable (resource/
operation/Task-ID, no raw URL), it is **not** subject to the
`allowedHttpRequestDomains` gate that the generic HTTP Request node imposes when
reusing a predefined credential, and it has built-in `custom_task_ids` / `team_id`
handling. (The initial build used HTTP Request, per the source prompt's raw-API
wording; it was switched after confirming the native node returns the same raw
task object including `parent` / `top_level_parent`.)

### `includeMarkdownDescription: true` on every fetch
The native node omits `markdown_description` by default (returns only plain
`description` / `text_content`). Enabling the node's `includeMarkdownDescription`
option restores the markdown (checkboxes, bullets, @-mentions, doc links) that the
later LLM step wants. The Code node prefers `markdown_description`, falling back to
`description` then `text_content`.

### Form Trigger, not Manual Trigger
The source prompt asked for "a trigger that accepts a ClickUp task ID". A Manual
Trigger takes no input and cannot be fired by the n8n MCP test tool; a Form Trigger
exposes a `taskId` field, accepts the ID, and is MCP-testable
(`n8n_test_workflow` → form). It requires the workflow to be **active** to fire,
so testing activates → runs → deactivates. This trigger is a test/standalone
harness; when this becomes the Main Orchestrator's context step, the trigger is
replaced by the queue/webhook input.

### Bounded unroll for the parent-walk (operator-selected)
A fixed, linear `Fetch L0 → IF(has parent?) → Fetch L1 → … → Fetch L5` chain (cap
6), with each IF's false branch and the deepest fetch converging on the Code node.
Chosen over an unbounded back-edge loop (fragile to hand-build — the HTTP/native
fetch cannot retain input state across iterations) and over a recursive
sub-workflow (extra workflow to maintain). The Code node gathers each executed
fetch by name via guarded references and emits `truncated_at_depth` if the deepest
fetched task still has a parent (no silent capping). Cost: a fixed depth ceiling
(comfortable for ClickUp's shallow subtask chains) and repeated nodes.

## Consequences
- Verified live (2026-06-02) on `Lista testy AI`: a 3-level subtask produced an
  ordered `ancestor_chain`; a root task produced `ancestor_chain: []`; markdown
  descriptions flow through. Read-only throughout.
- Depth beyond 6 would be silently impossible were it not for the
  `truncated_at_depth` flag; raise the cap (more nodes) if real chains approach it.
- The native-node markdown surfaced "You do not have access to this Doc" for
  embedded Doc links — see ADR-004 update (agent Member lacks Doc access).
- Next increments (still read-only until each is inspected): the LLM call, then
  post-back to ClickUp; plus `linked_doc_leaves` resolution once Doc access is
  sorted.

Related: ADR-015 (one generic pipeline), ADR-019 (node/credential discipline),
ADR-018 (built via the n8n MCP control plane), ADR-004 update (agent identity).
