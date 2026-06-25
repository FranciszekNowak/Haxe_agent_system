# Master plan — ADR-061: Dynamic context loading via progressive disclosure

> **This is the durable, cross-desktop source of truth** (the `~/.claude` plan file does not travel
> between machines). Run the house block-by-block routine: read this file top to bottom, do the first
> not-done block, write back to `architecture/current.md` + ADR-061, update the status table, commit,
> emit a handoff, `/clear`, repeat. Decision record:
> `architecture/decisions/061-dynamic-context-loading.md`.

## Context (why)

A trivial request ("2+2") posted on a heavy ClickUp task currently exceeds **100,000 input tokens**,
confirmed in real executions. The cause is a single legacy holdover: **Stage A
(`assemble-context-and-build-prompt.json`) still pre-assembles everything** — the full 30+ comment
thread, the full parent chain, and all unpacked attachment text — because that is how the old bare
model call worked (it could not ask for more mid-run, so the spine loaded defensively).

ADR-053 (Managed Agents) and ADR-054 (per-user-scoped ClickUp retrieval) already removed that
constraint: the agent can pull what it needs mid-reasoning. **ADR-054 already built ADR-061's
"Block 2" infrastructure for *discovery*** — the hosted ClickUp MCP exposes 14 read tools
(`clickup_get_task`, `clickup_get_task_comments`, `clickup_get_threaded_comments`,
`clickup_get_document_pages`, …) and `extract_clickup_task` pulls attachment bytes, all per-user
scoped. So ADR-061 is **much smaller than its four-block text implies**: the real work is to
**stop pre-loading the tail and re-steer the agent to pull it**, plus close one regression gap.

**Intended outcome:** trivial-task floor drops from 100k+ to low thousands (and latency with it);
heavy tasks pay tool round-trips only for the material the request actually implicates.

This plan is written against the **live** repo state confirmed by exploration (the ADR-053 managed
lane, the ADR-054 scoped-MCP + `extract_clickup_task` seam, the three Stage-A pre-gather
sub-workflows, the `agent_routing`/`config` tables), not against the ADR alone.

## Decisions locked with the operator (2026-06-25)

1. **Triggering-task tail = bot-token tools, not per-user scoping.** The triggering task carries no
   permission risk that scoping would mitigate (the caller @-mentioned the agent there → has access;
   the bot Member has access; the data is byte-identical). Per-user scoping earns its keep only for
   open-ended discovery of *other* tasks. Bot-token wins on reliability (no external
   `mcp.clickup.com` dependency or per-user-token validity in the core path), latency (fewer hops, no
   remote MCP), maintenance (reuses the three existing pre-gather sub-workflows; one path for all
   users), and marginally cost. **Seam: triggering task → deterministic bot-token readers; other
   tasks → per-user scoped MCP (already live).** This matches ADR-054 master-plan decision #2, which
   already kept the triggering-task pre-gather on the bot token for the same reason.
2. **Block 3 (tier-additive cached system prefix) is DEFERRED** to a follow-up ADR. It is explicitly
   *not* for token savings (the ADR says so); the entire token win is in Block 1. It also needs 4
   tier-specific agent `system` variants, an unconfirmed harness cache-semantics gate, and reconciling
   a rules-doc duplication (Stage A loads CU doc `q7wz-16892` into the prompt while
   `Sync Agent Definitions` bakes `q7wz-44812` into `system`). Out of scope here.
3. **Attachments are lazy / on-pull.** `list_attachments` returns ClickUp's native metadata
   (name/size/mime) for free — no extraction. `get_attachment(ref)` runs Read Input for that ONE
   attachment on demand. Pays Docling/zip cost only for attachments the request implicates.
4. **Floor = global rules + personal prefs + triggering comment + task title + task description +
   impact line.** No separate "current checklist step" parsing — the description already carries the
   checklist; the agent reads the step from it. All users will be onboarded, so per-user discovery is
   universally available.

## Key files

- **Stage A:** `n8n/workflows/assemble-context-and-build-prompt.json` (id `GGTBvFBgGSNbtUR6`) — the
  `Build Prompt` Code node and the `Call Assemble Task Context` / `Call Read Input` steps are what
  shrink.
- **Reused tail sources (wrapped as tools, not rebuilt):**
  `n8n/workflows/assemble-task-context.json` (id `eL3fJuRMpzVRuVUT`, comments + threaded replies),
  `n8n/workflows/assemble-parent-context.json` (id `qgM37HdQj78Rn090`, ancestor chain + impact),
  `n8n/workflows/read-input.json` (id `zgGpONulGMohQQqI`, Docling/zip extraction),
  `n8n/workflows/upload-input-images.json` (id `2VkZN5UeqVk6MDLW`, Files-API for vision).
- **Tool loop:** `n8n/workflows/execute-agent-session.json` (id `Rtb1cZbmUqmfGD98`) — add tool-routing
  branches beside the existing `Is extract_clickup_task?` branch.
- **Tool/steering registration:** `n8n/workflows/sync-agent-definitions.json` (currently CONV=8) —
  add the new tools + steering, bump CONV, re-sync the 3 routed agents (Haiku/Sonnet/Opus).
- **Pattern to mirror:** `extract_clickup_task` (custom tool → `clickup-extract-tool-handler.json`,
  id `y985MgyA5lCxOFCH`) is the exact template for a client-side tool that returns a
  `user.custom_tool_result` content array.
- **Cost/alerts:** `Log Model Run (v1)` (sole `agent_runs` writer), `Post Alert (v1)` seam (ADR-025).
- **ADR:** `architecture/decisions/061-dynamic-context-loading.md` (note: line-1 title says
  "ADR-060" — typo, fix in write-back). Doc to reconcile: `architecture/current.md` §15.2 + §15.5.

## Block status

| # | Block | State |
|---|---|---|
| 0 | Capability gates: prove lazy single-attachment extraction works mid-session (G2); measure floor size + one round-trip latency (G3) | ⬜ not started |
| 1 | Floor assembler — shrink Stage A's prompt string to the floor; lane-aware guard (managed → floor, bare → full) | ⬜ not started |
| 2 | Triggering-task tail readers as bot-token custom tools (`get_task_comments`, `get_parent_chain`, `list_attachments`, lazy `get_attachment`) via one `Triggering Task Tail Handler (v1)`; register + steer (CONV→9) | ⬜ not started |
| 3 | End-to-end + scope test (the 100k case rerun); write-backs (current.md §15, flip ADR Accepted, fix title typo, record deferred additive-prefix follow-up) | ⬜ not started |

Each block ends with: write-back to `current.md` + ADR-061, status-table update, commit, handoff.
Live verification (not "looks right") per Definition of Done; all alerts through `Post Alert (v1)`;
never read or post-watch the Alerts task `869dj2z2c`; migrations append-only; exported workflow JSON
re-exported after any live change, never hand-edited (preserve curated node `notes` + any
`toolWorkflow` `schema[]` the exporter strips).

## The blocks

### Block 0 — Capability gates

Resolve before cutting Stage A. (G1's tier-cache gate is deferred with Block 3.)

- **G2 — lazy single-attachment extraction works mid-session.** Confirm `Read Input (v1)` can be
  driven for **one** attachment id (filter/param) and return its text + (for images) a Files-API
  `file_id` vision block, returned as a `user.custom_tool_result` inside the 840s poll loop. Largely
  de-risked: `extract_clickup_task` already proves a custom tool can extract a task's attachments
  mid-session; this narrows it to a single attachment on the **bot** token.
- **G3 — floor size + round-trip latency.** Measure the floor token count on a representative heavy
  task (target: low thousands) and the wall-clock of one tail tool round-trip (to size heavy-task
  cost).

**DoD:** single-attachment bot-token extraction returns correct content mid-session; floor size and
per-round-trip latency measured and recorded in `block-0-findings.md`.

### Block 1 — Floor assembler

Reduce the prompt string `Build Prompt` emits to the **floor only**: global rules + personal prefs +
triggering comment + `current_task.name` + `current_task.description` + an impact line. **Stop
injecting** `task_comments`, the ancestor-chain bodies, `additional_context`, attachment text blocks,
and upfront `image_blocks_json`.

- **Keep** the metadata fields Build Prompt already returns (impact, `clickup_task_id`,
  `caller_user_id`/`reviewer_user_id`, `triggering_comment_id`, assignee/creator for the autonomous
  rule, `process_type`) — only the prompt **string** shrinks, not the payload contract.
- **Keep** `Call Assemble Parent Context` running (it resolves the impact custom field + assignee/
  creator that routing and the autonomous-caller rule need) — just don't fold the ancestor **bodies**
  into the prompt.
- **Lane-awareness (shared-workflow guard).** Stage A is shared by both lanes and the bare (dormant)
  lane cannot pull tools. Gate the tail assembly on lane: read `config.agent_lane` early in Stage A;
  **managed → floor only**, **bare → keep today's full assembly** (so the emergency failover keeps its
  current behavior). One IF, reversible, documented as an ADR-061 consequence — not a silent
  half-cutover.

**DoD:** a trivial task on a heavy parent produces a low-thousands prompt and a correct answer with
**zero** tail tools called; the bare-lane path still receives full context; `Context OK?` guard and
the existing CRITICAL/WARN seams still fire correctly.

### Block 2 — Triggering-task tail readers as bot-token tools

Expose the triggering task's tail as **client-side custom tools** (mirroring `extract_clickup_task`),
routed in the `Execute Agent Session` poll loop, all on the **bot** token and scoped to the
triggering `clickup_task_id` (n8n-supplied; the agent cannot widen the scope):

- `get_task_comments` → reuse `Assemble Task Context (v1)` (comments + interleaved threaded replies).
  Optional `limit`/`since`. (Metadata-first `comment_summary` deliberately **not** built — for a
  5-person system a bounded comment fetch is cheap; revisit only if measurement shows over-pulling.)
- `get_parent_chain` → reuse `Assemble Parent Context (v1)`, depth-bounded titles/descriptions.
- `list_attachments` → ClickUp native attachment index (name/size/mime). **No extraction.**
- `get_attachment(attachment_id)` → run `Read Input (v1)` for that one attachment (Block-0
  single-attachment mode), reusing `Upload Input Images (v1)` for image vision; return text/vision as
  a `user.custom_tool_result`.

Implementation shape: **one** new handler sub-workflow `Triggering Task Tail Handler (v1)` with a
Switch on tool name → the right reused sub-workflow → shape the result (one workflow, one return
terminal — respects the branch-free sub-workflow-return rule). Add the matching routing branches in
`Execute Agent Session` beside `Is extract_clickup_task?`. Register the four tools + steering ("the
triggering task's own comments/parents/attachments are now pull-on-demand via these tools; use the
scoped `clickup_*` MCP for OTHER related tasks") on the 3 agents via `Sync Agent Definitions`
(bump CONV to 9).

**Reliability (mandatory, ADR-025 / CLAUDE.md):** every tail handler fires a `Post Alert (v1)` **WARN
on a side branch** on failure (Docling failure, bot-token read failure, empty-when-shouldn't-be) and
returns a structured error to the agent — never a silent empty. The handler sub-workflow sets
`Error Handler (v1)` as its `errorWorkflow`. **Knowingly uncovered:** the agent *choosing not* to pull
context it should is a quality risk no thrown error can detect — stated, not silently ignored.

**DoD:** each tool returns correctly for the triggering task on the bot token; a failed pull WARNs
without aborting the run; `extract_clickup_task` + the scoped `clickup_*` MCP still work for
other-task discovery; no cross-department leak (triggering-task tools are pinned to the supplied id).

### Block 3 — End-to-end + scope test (was ADR-061 Block 4)

Rerun the original 100k case and the heavy/trivial split:

1. **Trivial-on-heavy:** small floor, **zero** tail tools called, correct answer, low-thousands prompt
   (compare against the Block-0 G3 baseline).
2. **Heavy task:** agent sees the cheap `list_attachments`/comment count, pulls only the implicated
   comment(s) and attachment(s), stays correct; cost rows attribute correctly via `Log Model Run`.
3. **Other-task discovery** still permission-scoped per-user (onboarded user sees only their scope;
   cross-dept negative check still passes — unchanged from ADR-054 Block 5).
4. **Alerts clean** (`scripts/alerts-since.mjs`), executions inspected node-by-node
   (`scripts/inspect-execution.mjs`), drift-clean (`node scripts/check-workflow-drift.mjs`).

**DoD (+ write-backs):** trivial floor confirmed low-thousands; heavy pulls correct and scoped;
`architecture/current.md` §15.2 + §15.5 reconciled (Stage A = floor + lane guard; tail = bot-token
on-demand tools); ADR-061 flipped to **Accepted**, line-1 title typo fixed, Block 3-additive-prefix
recorded as a **deferred follow-up ADR**; per-block findings files in this dir; each block committed.

## Verification (how to test end-to-end)

Per CLAUDE.md Definition of Done — autonomously before handing back:

- **Drive the spine** via `scripts/test-subworkflow.mjs <orchestrator-When-Called-id> --file ./input.json`
  with the producer's exact inputs (`triggered_by=explicit_mention`, `invocation_type=explicit`, a real
  `reviewer_user_id`). Build `input.json` with Node (`JSON.stringify`), project-relative path — never a
  hand-escaped heredoc, never the Form Trigger over the API (both documented foot-guns).
- **Two probe tasks on a disposable ClickUp task:** (a) a trivial comment ("2+2") on a task loaded with
  30+ comments + a PDF + an XLSX → expect floor-only prompt, zero tail tools; (b) a request that needs
  a specific attachment → expect `list_attachments` then a single `get_attachment` pull.
- **Inspect** the execution node-by-node (`scripts/inspect-execution.mjs <execId>`) — confirm Stage A
  emitted the floor, the session called exactly the implicated tools, no silent fallback.
- **Scan alerts** (`scripts/alerts-since.mjs <minutes>`) — any WARN/CRITICAL is a failure until
  explained.
- **Check `agent_runs`** cost rows for the test runs, then **delete test rows + the disposable ClickUp
  task** afterward (ClickUp has no delete-attachment API → prefer a fresh disposable task).
- **Drift check** clean before each commit; re-export touched workflows via `export-workflows.mjs`.
