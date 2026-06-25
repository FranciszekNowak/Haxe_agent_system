# ADR-060: Dynamic context loading via progressive disclosure

Status: Proposed (flip to Accepted on commit)
Date: 2026-06-23
Supersedes (in part): ADR-053 decision detail 4 (read-input "pre-assemble work-ready content"), which becomes "pre-load the bounded floor, expose the unbounded tail as tools"
Depends on: ADR-053 (Managed Agents lane), ADR-054 (per-user-scoped retrieval executor and tokens), ADR-035 (cost logging)
References: ADR-048 (input file handling: unzip, Docling extraction), ADR-055 (tool-as-MCP / client-side tool patterns)
Touches: `current.md` §15 (Agent Spine, Stage A context assembly), the read-input workflow

## Decision (verdict first)

Stop front-loading task context. Pre-load only the **bounded floor** (triggering comment, title, description, impact, current checklist step) deterministically, and expose the **unbounded tail** (comment history, parent chain, attachment bytes) as **per-user-scoped tools** the agent pulls on demand, metadata-first. The system prompt becomes **additive by impact tier**, stacked as supersets and placed in the cached static prefix. Trivial tasks stay a single model call with a low-thousands floor; heavy tasks pay tool round-trips only for the material the request actually implicates.

## Context

The current spine pre-assembles maximal context: full system prompt, full unpacked attachments, the full comment thread (observed at 30+ comments), and the full parent tree. A bare model call required this, because it cannot ask for more mid-run, so the spine loads everything defensively. The result: a trivial request ("2+2") posted on a heavy task exceeds 100,000 input tokens, confirmed in real executions.

The root cause is running the bare-call input model on the managed-agents harness. An agent can pull what it needs mid-reasoning, so defensive pre-assembly is now pure waste. This ADR is the migration (ADR-053) finally paying off on the input side, the mirror of what it already did for output.

Two facts shape the fix:

1. **The system prompt is not the problem.** It is identical per call and cached at roughly a tenth of the input rate, so it is the cheapest part of the request. The blow-up is the **dynamic, uncacheable** material: comments, attachment bytes, parent tree, which differ per task. So token savings come from pruning the dynamic tail, not from shrinking the prompt.
2. **The split is floor versus tail, not "everything becomes a tool."** Some context is needed on nearly every task and is small and bounded (the floor); making the agent call a tool for it is a wasted round-trip that adds the latency we are cutting. The unbounded, usually-irrelevant material is the tail, and only the tail becomes pull-on-demand.

## Decision detail

1. **Pre-load the bounded floor deterministically.** The spine pre-assembles only: the triggering comment (the immediate request), task title and description, impact tier, and the current checklist step. This is small, always relevant, and keeps trivial tasks to a single model call with no tool round-trips. The read-input workflow (ADR-048: fetch, unzip, Docling) still runs, but its output feeds the tail tools, not the prompt (see §4).

2. **Expose the tail as per-user-scoped tools, metadata-first.** Three readers become tools, each routed through the ADR-054 per-user executor so pulled context is permission-correct by construction:
   - `list_attachments(task_id)` → names, sizes, mime types. Cheap index, no bytes.
   - `get_attachment(ref)` → the extracted content of one attachment (Docling output from the read-input layer, by ref).
   - `get_comments(task_id, limit?, since?)` → comments, paginated; a cheap `comment_summary(task_id)` returns count and last-N preview without the full thread.
   - `get_parent_chain(task_id, depth?)` → ancestor titles/descriptions, depth-bounded.
   The first level the agent sees is a cheap index ("30 comments; attachments: noven-brief.pdf 2.3 MB, sku-list.xlsx 80 KB"), so it pulls only the specific items the request implicates, rather than the spine deciding via n8n heuristics.

3. **Additive system prompt by impact tier, in the cached prefix.** Rules stack as strict supersets: base, then +medium, then +high, so a high-impact task carries all three layers with the tier stated in-context ("this task is of high importance"). The impact is also echoed in the triggering user message. Placement rule (load-bearing for caching): the tier declaration and rule layers sit in the **static prefix above any dynamic context**, so the cache prefix is stable per tier (four cacheable variants). Interleaving the impact line between dynamic chunks breaks the cache boundary and re-bills the prefix at full rate. This layering is for correctness and clarity (right rules per tier, impact in-context), **not** for token savings.

4. **Read-input feeds the tail tools, not the prompt.** ADR-048's deterministic extraction (unzip, Docling) still runs deterministically and cheaply, but its product is addressed by ref and served through `get_attachment`, so attachment bytes never enter the prompt unless the agent pulls them. The `agent_input_file_map` style ref→content addressing (ADR-055) is the access path.

## Rejected alternatives

- **R1. Pure pull (everything is a tool, nothing pre-loaded).** Rejected: forces a tool round-trip for the triggering comment and title on every task, adding latency to the trivial case this ADR exists to make fast. The floor must be pre-loaded.
- **R2. n8n heuristics decide what to load (smarter pre-assembly, still deterministic).** Rejected: the spine cannot know which of 30 comments or 4 attachments the request implicates without the model's judgment; hand-rolled relevance heuristics are brittle and re-create the over-fetch. The agent deciding from a cheap index is both simpler and more accurate.
- **R3. Shrink the system prompt to save tokens.** Rejected as the lever: the prompt is cached and cheap; pruning it chases the wrong cost. Done only incidentally via the additive tiering, which is for correctness.
- **R4. Summarize the comment thread up front and inject the summary.** Rejected as the default: it pre-pays a summarization call on every task including the ones that need no comments, and lossy summaries hide the detail a heavy task needs. `comment_summary` as a pulled metadata tool achieves the same on demand.
- **R5. Load attachment bytes, not refs, into the tail tool result.** Rejected: defeats metadata-first. `list_attachments` returns the index; `get_attachment` returns content only for the chosen ref.

## Consequences

- **Trivial-task floor drops from 100k-plus to low thousands** (floor + cached prefix), and latency on trivial tasks improves: no giant prompt to process, no heavy pre-assembly. This is the primary win.
- **Heavy tasks trade tokens for latency.** A task that genuinely needs history, parents, and three attachments now pays sequential tool round-trips (seconds each at managed-agent latency) it used to get in one payload. Accepted for an async system, and it falls only on the context-heavy tasks that were the expensive ones anyway. The floor-versus-tail split keeps light tasks single-call.
- **Pulled context is permission-correct by construction**, because the tail tools route through the ADR-054 per-user executor, which the pre-assembly model made harder.
- **Caching discipline is now load-bearing.** The static prefix (tier-additive rules) must sit above all dynamic context, or the per-tier cache breaks and the prefix re-bills at full rate. This is a build-time invariant, not a runtime knob.
- **Token cost per call becomes variable and request-driven**, which the ADR-035 cost rows already capture per run; expect heavy-task token counts to rise slightly (round-trip context) while the fleet average drops sharply (trivial tasks no longer carry the tail).
- **Managed-lane rules currency now depends entirely on the sync + freshness loop (new, Block 1).** Block 1 drops the per-run global-rules fold on the managed lane because `Sync Agent Definitions (v1)` already bakes the same `q7wz-44812` page verbatim into the cached agent `system`. Removing the per-run copy removes the fresh-every-run safety net: if the scheduled sync stalls and the rules doc is edited, the managed lane runs slightly-stale rules until the next sync. This is bounded by the **`Agent Rules Freshness Check (v1)`**, which WARNs on either doc↔`system` hash drift or a sync that hasn't run in >24h — so the failure is loud, not silent. The bare failover lane is unaffected (it keeps the per-run fold). Verified before cutting: freshness check (exec 3819) reported `ok=3, stale=0, no_provenance=0` with the agents' baked sha equal to the live doc sha.

## Capability gates (Block 0)

- **G1.** Confirm the harness re-caches the static prefix across the tool round-trips within a session (so multi-pull heavy tasks still benefit from prefix caching, not just the first turn).
- **G2.** Confirm `get_attachment` can resolve Docling-extracted content by ref through the ADR-055 `agent_input_file_map` path within a session's signed-URL lifetime.
- **G3.** Measure the floor token count on a representative heavy task to confirm it lands in low thousands, and the per-round-trip latency to size the heavy-task cost.

## Build sequence (blocks)

- **Block 0 — Gates.** Resolve G1 to G3. DoD: prefix-caching-across-tool-calls confirmed, ref resolution confirmed, floor size and round-trip latency measured.
- **Block 1 — Floor assembler.** Reduce Stage A to the bounded floor (triggering comment, title, description, impact, current step). DoD: a trivial task on a heavy parent produces a low-thousands prompt and a correct answer with zero tail tools called.
- **Block 2 — Tail readers as tools.** `list_attachments`, `get_attachment`, `get_comments` + `comment_summary`, `get_parent_chain`, all through the ADR-054 per-user executor, metadata-first. DoD: each returns correctly and is permission-scoped to the triggering user; cross-department negative check passes.
- **Block 3 — Additive cached prefix.** Tier-stacked rule layers (base/+medium/+high) with impact in-context and echoed in the user message, placed in the static prefix above dynamic context. DoD: four tiers produce four stable cacheable prefixes; cache-hit confirmed across tool round-trips; impact stated correctly per tier.
- **Block 4 — End-to-end + scope-test.** The 100k case rerun: small floor, agent sees the cheap index, pulls only the implicated comment(s) and attachment(s); a trivial task calls no tail tools; a genuinely heavy task pulls the right tail and stays correct. DoD: trivial-task floor confirmed low-thousands, heavy-task pulls correct and permission-scoped, `current.md` §15 reconciled (Stage A = floor + tail tools), drift-clean.
