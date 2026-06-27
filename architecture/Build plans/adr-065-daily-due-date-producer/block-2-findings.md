# Block 2 findings — ADR-065 E2E verification, freshness monitor, write-backs

Date: 2026-06-27. Verified live via a **temporary `Gate Tasks` allowlist** (live-only n8n MCP patch,
reverted after) so real workspace tasks were never actioned. All disposable tasks + test `agent_runs`
rows were deleted afterward.

## What was verified (see ADR-065 "Verification" for the full list)
- **Fetch shape:** the ClickUp `/team/761759/task` response carries `custom_fields`, `assignees`,
  `status` (object with `.type`) per task — one paginated call covers the whole gate (no per-task fetch).
- **Enqueue path:** found:25 → candidates:1 → enqueued (jobId `…:due_date:<bucket>`, priority 8) →
  consumer ran spine → `agent_runs` `due_date_daily`/`autonomous`/caller=assignee, **top-level comment**
  @-mentioning the assignee.
- **Dedup:** second run → `already_actioned:1, enqueued:0`.
- **Sync fallback:** `/enqueue` forced to fail → `due-date-producer/enqueue` WARN + inline spine ran.
- **Negative gates:** wrong-day (Warsaw), not-for-AI, zero-assignee each rejected with the right counter.
- **Freshness monitor:** fresh → no alert; forced-stale (0h threshold) → `due-date-producer/freshness` WARN.
- **Blast radius:** dry run (no allowlist, dispatch disabled) → 0 genuine tasks qualify today.

## Bug found + fixed during verification
The summary message posted **all-zero counts** while the run actually enqueued a task. Cause: `Stamp
Heartbeat` (a Postgres node) sat **between** the summary item and `Build Summary Message` and replaced
the item, dropping `counts`. Fix: fan the summary item from `Route Kind` out to `Stamp Heartbeat` (a
terminal side-branch) **and** `Build Summary Message` in parallel, so the counts reach the message
intact. Re-verified: summary now shows real counts (found:25, candidates:1, enqueued:1, …).

## Known/accepted residuals
- The two-assignee rejection wasn't exercised directly (ClickUp left the test task with 1 assignee); it
  is covered by the same `assignees.length !== 1` predicate that rejected zero. Closed/done relies on
  `include_closed=false` + the `status.type` check (not exercised live).
- The `agent-orchestrator/render` `no-deliver-output` WARN seen on spine runs is a **pre-existing**
  Haiku `deliver_output` protocol issue (current.md ADR-063 amendment), orthogonal to ADR-065.
- ClickUp single-page fetch (`page=0`): if `last_page=false`, the summary escalates to WARN
  (truncation). For a 5-person team this is far below the 100/page limit.

## Activation (operator-gated)
Both workflows are **INACTIVE**. To go live, activate `Ubwr6fRmStFwwJfP` (producer) **and**
`q98HgAuUlqxg1CF4` (freshness monitor) together — activating the producer alone leaves the monitor off;
activating the monitor while the producer is off would (correctly) WARN that the producer isn't running.
