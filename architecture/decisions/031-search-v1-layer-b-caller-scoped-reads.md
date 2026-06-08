# ADR-031: Search (v1) — Task Comments, Semantic Search, and Layer B Caller-Scoped Reads

## Context

The agent had no mechanism to read task comments (only task descriptions via the ancestor
chain), could not search for documents or tasks referenced by name in the triggering
comment, and had no runtime enforcement of Layer B caller-scoped reads (designed in
ADR-004, described in ADR-026, but not implemented). A seam was also needed for the
Phase 3 personal-data sensitivity classifier so it could plug into model routing without
changing the rest of the pipeline.

## Decision

**`PD Verifier (v1)` seam (stub).** A 2-node sub-workflow always returning
`personal_data: false`. Interface contract: accepts `current_task` (object) +
`triggering_comment_text` (string); returns `{ personal_data: boolean }`. Agent Spine
reads this value and passes it to both `Invoke Model (v1)` (routing axis) and
`Search (v1)` (future GDPR-gating of search results). The stub is the seam —
replacing it with a real classifier (deterministic regex rules + optional Haiku call)
requires no changes to Agent Spine or Search.

**`Search (v1)` sub-workflow** (22 nodes, called after PD Verifier):

1. **Always:** fetch last 30 task comments via `GET /api/v2/task/{id}/comment`.
2. **If triggering comment contains external references:** call `Invoke Model (v1)` at
   `impact=Niski, triggered_by=search_step` to extract a JSON list of search queries
   (`{queries: string[], reason: string}`). Logged as a Haiku-priced `agent_runs` sub-row.
   Skip steps 3–6 if `queries` is empty.
3. Execute `GET /team/{id}/task?search={q}` + doc search per query via SplitInBatches.
4. **Layer B filter (fail-closed):** for each unique `space_id` in candidate artifacts,
   call `GET /api/v2/space/{id}/member` and check if `caller_user_id` is in the member
   list. Exclude artifacts from spaces where the caller is not a member. Log filtered-out
   count as INFO if > 0.
5. Read up to 5 accessible artifacts (tasks or docs).
6. If total content exceeds ~4000 tokens: call `Invoke Model (v1)` at `impact=Niski,
   triggered_by=search_step` to condense. Second Haiku sub-run.

Returns to Agent Spine: `task_comments`, `additional_context`, `sources_used`,
`sources_filtered_out`.

**Order-based space_id matching in Layer B.** The HTTP Request node overwrites `$json`
with the membership response, losing the `space_id` from the input item. Solution:
SplitInBatches preserves item order, so the Layer B Filter Code node reads
`$('Expand Spaces').all()[i].json.space_id` alongside `membershipItems[i].json.members`
— no need to carry space_id through the HTTP call.

**`triggered_by='search_step'`** for Haiku sub-calls within Search. Requires migration
`009_triggered_by_search_step.sql` to add this value to the `agent_runs.triggered_by`
CHECK constraint before Search runs in production.

**Agent Spine orchestration order:**
```
Context Gather (v1)
  → PD Verifier (v1)   [outputs personal_data boolean]
  → Search (v1)        [receives personal_data; outputs task_comments + additional_context]
  → Build Prompt       [injects comments and search results before task context]
  → Invoke Model (v1)  [receives personal_data for routing]
```

## Consequences

**Positive:**
- Agent now acts on task comment context, not just task description.
- Layer B is enforced at the search boundary, fail-closed: a membership API failure
  for a given space excludes that space's artifacts rather than leaking them.
- PD Verifier seam decouples the Phase 3 classifier from model routing and search logic.
- Triggered comment + task comments together mean the agent understands both what was
  asked and what the recent conversation context is.

**Negative / trade-offs:**
- `search_step` must be present in `agent_runs.triggered_by` CHECK before Search runs
  in production; missing migration = constraint violation on the first sub-run INSERT.
- Space membership API adds ~100 ms per unique space in a search result; acceptable
  on the explicit-mention path, may be revisited if autonomous triggers add volume.
- PD Verifier stub means all traffic routes via Anthropic direct (not Bedrock EU) until
  Phase 3 classifier is built. A task with real personal data processed before Phase 3
  would route to Anthropic (outside EU). Accept: the system does not yet handle PII tasks;
  this gap closes in Phase 3.

## Date

2026-06-08

---

> **Update 2026-06-08** — Three inaccuracies corrected to match the live implementation:
>
> 1. **Search trigger (step 2):** The ADR states "If triggering comment contains external
>    references." The implementation always runs query extraction — it uses task name +
>    description (up to 1200 chars) as the primary input, supplemented by the triggering
>    comment when present. The `Has Triggering Text` gate that bypassed extraction for
>    autonomous triggers (empty `triggering_comment_text`) has been removed. The model
>    returns `queries: []` when nothing warrants a search, which is the correct empty-path
>    signal.
>
> 2. **Artifact cap (step 5):** Changed from "up to 5 accessible artifacts" to **up to 8**.
>    The original implementation cap was 3 (a code discrepancy with the ADR); it is now
>    explicitly 8 in `Layer B Filter`.
>
> 3. **Condense trigger (step 6):** The ADR states "If total content exceeds ~4000 tokens."
>    The live `Has Condense Content` node fires whenever `additional_context` is non-empty
>    (i.e., whenever any artifact was retrieved). The condense prompt is quality-based and
>    selective — it instructs the model to keep technical specs and exact requirements
>    verbatim while summarising repetitive or low-value content. No token count is checked.
