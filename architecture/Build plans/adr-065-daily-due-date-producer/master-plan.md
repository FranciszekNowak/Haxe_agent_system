# Master plan — ADR-065: Daily Due-Date Autonomous Producer

> **Durable, cross-desktop source of truth** (the `~/.claude` plan file does not travel between
> machines). Run the house block-by-block routine: read this file top to bottom, do the first
> not-done block, write back to `architecture/current.md` + ADR-065 (+ a `block-N-findings.md`
> alongside this file), update the status table, commit, emit a handoff, `/clear`, repeat.
> Decision record: `architecture/decisions/065-daily-due-date-producer.md`.

## Context (why)

The agent only runs on a human **pull** today (`@`-mention / `~command` → `CU Webhook Producer (v1)`
→ enqueue). The architecture has always specified an autonomous **push**: a nightly scan that drafts
work on tasks the team marked for AI, so drafts are ready by morning (`current.md` core model §1/§3;
§15.10 "Daily Due-Date Producer — Planned (Phase 3)"). This builds it.

**Trigger rule (operator spec, confirmed 2026-06-27):** fire one autonomous run for a task iff ALL —
1. due date is **today** in **Europe/Warsaw**,
2. **exactly one** assignee,
3. `[AI] Czy zadanie dla AI = Tak`,
4. **no `agent_runs` row** for that task already exists **today** (Europe/Warsaw) — any trigger counts,
5. task **not** closed/done.

Caller = the single assignee (no creator fallback). Output posts as a **new top-level comment**
(already handled by `Post Reply (v1)` when `triggering_comment_id` is empty).

## Decisions locked (Block 0, 2026-06-27)

1. **Enqueue, don't call the spine inline.** A batch of due-today tasks is exactly the midnight
   burst ADR-056 paces against the Managed-Agents cap. Mirror the mention producer's dispatch
   (`Read Queue Flag` → `Queue Enabled?` → `Build Enqueue Job` → `Enqueue Job` → sync fallback).
2. **The "any action today" dedup lives in the PRODUCER**, not the consumer. The queue-consumer's
   own idempotency only matches a *completed* `due_date_daily` run in a 24h bucket
   (`services/queue-consumer/app.mjs` `findCompletedRun`) — it would NOT see a human @-mention or an
   image_gen row earlier today. The operator rule ("any action") is a batched `agent_runs` query in
   the producer. The consumer's bucket dedup remains a secondary net.
3. **Due-today is gated IN-MEMORY by Warsaw calendar date**, not by trusting ClickUp's date-only
   due-date storage time. Server-side fetch uses a widened due window (±24h); a Code node keeps only
   tasks whose `due_date` formats to today's date under `Intl.DateTimeFormat('en-CA',{timeZone:
   'Europe/Warsaw'})`. DST-safe, storage-convention-agnostic.
4. **Batch summary + heartbeat route through `Post Alert (v1)` at INFO**, not a new "GM Reports"
   path. No dedicated nightly digest task exists (only the weekly-proposer's "GM Weekly Reports");
   the unification rule says reuse the established alert seam. A per-night INFO summary doubles as the
   liveness signal; a `config` heartbeat key (`due_date_producer.last_run_at`) backs the dead-man's
   switch. (Deviation from §15.10's "GM Reports" wording — recorded in the ADR.)
5. **No migration.** `triggered_by='due_date_daily'` and `invocation_type='autonomous'` already pass
   the `agent_runs` CHECKs; dedup reuses existing columns.

## Verified facts (block-0-findings.md)

- ClickUp: `[AI] Czy zadanie dla AI` = `088d66e2-6095-4604-b70d-e50ebb085ae2`, `Tak` option
  `c409b519-7ef3-49e8-8170-260c992b2553` (orderindex 1; stored value may be id OR orderindex — match
  both). `[AI] Wpływ` = `55c7ff79-1857-41e6-87b4-bd46678e1470` (option map = mention producer's). Team
  `761759`. Alerts task `869dj2z2c`.
- Queue-consumer contract: `invocation_type='due_date'` accepted → priority 5–8; maps to
  `triggered_by='due_date_daily'` + spine `invocation_type='autonomous'`. `impact` MUST be one of the
  4 real tiers (default `Średni`); `caller_user_id` MUST be non-empty.
- Supabase: `queue.enabled='true'`, `agent_lane='managed'`. Warsaw-day-start SQL verified.
- Caller identity: `assemble-context-and-build-prompt.json:101` derives `caller_user_id` from
  `reviewer_user_id` → passing the assignee as `reviewer_user_id` gives ADR-054 scope + ADR-064 spend
  gating for free.

## Files

**Create:** `n8n/workflows/due-date-producer.json` (Block 1);
`n8n/workflows/due-date-producer-freshness-monitor.json` (Block 2).
**Modify:** `architecture/current.md` (Block 2: §3, §15.10 status, §15.x workflow table); ADR-065.
**No** migration. **No** edits to existing workflows (the consumer + ingress already support `due_date`).

## Block status

| Block | Title | Status |
|---|---|---|
| 0 | Capability gates + ADR/plan | ✅ Done (2026-06-27) |
| 1 | Build the producer workflow | ✅ Done (2026-06-27) — `due-date-producer.json` (`Ubwr6fRmStFwwJfP`), 17 nodes, validates (0 errors), drift-clean, **inactive** pending Block 2 |
| 2 | E2E verification + freshness monitor + write-backs | ✅ Done (2026-06-27) — verified live (enqueue/dedup/sync-fallback/summary/heartbeat + negative gates + freshness fresh/stale); fixed a heartbeat-clobbers-summary bug; freshness monitor `q98HgAuUlqxg1CF4` built. Both workflows **INACTIVE pending operator activation** |

## Block 1 — Build the producer workflow
- Triggers: `Schedule Trigger` daily 01:00 Europe/Warsaw + `Form Trigger` manual harness (mirror
  `fx-rates-daily.json`).
- `Compute Window` (Code): Warsaw today date + widened unix-ms window (start−24h, end+24h).
- `Fetch Due Tasks` (HTTP GET `/api/v2/team/761759/task`, `due_date_gt`/`due_date_lt`,
  `include_closed=false`, `subtasks=true`, paginated). `clickUpApi` predefined cred.
- `Gate Tasks` (Code): keep iff Warsaw-date==today AND assignees.length===1 AND `Czy dla AI`==Tak
  (match id or orderindex) AND status not done/closed. Emit per-task `{taskId, assigneeId,
  assigneeUsername, impact}` + a counters object for the summary. Drop telemetry task `869dj2z2c`.
- `Dedup` (Postgres): `select distinct clickup_task_id from agent_runs where clickup_task_id = any($1)
  and created_at >= (date_trunc('day', now() at time zone 'Europe/Warsaw') at time zone
  'Europe/Warsaw')`; `onError:continueRegularOutput` (fail-open). Filter out matched ids.
- Dispatch per surviving task: mirror mention producer — `Read Queue Flag` → `Queue Enabled?` →
  `Build Enqueue Job` (invocation_type `due_date`, caller_user_id=assignee, impact default `Średni`,
  payload: reviewer_user_id=assignee, caller_username, triggered_by `due_date_daily`, invocation_type
  `autonomous`, empty comment id/text) → `Enqueue Job` (`onError:continueErrorOutput` → sync fallback
  `Run Agent Spine` + `Alert Enqueue Failed` WARN).
- `Post Batch Summary` (INFO via `Post Alert (v1)`): found / enqueued / skipped-by-reason.
- `Stamp Heartbeat` (Postgres upsert `config` key `due_date_producer.last_run_at = now()`).
- `errorWorkflow` = global Error Handler (`81eplXMD1v5ONhzs`). Validate; export; drift-check.
- **DoD:** workflow validates; exported; `check-workflow-drift.mjs` clean.

## Block 2 — E2E verification, freshness monitor, write-backs
- Drive via the Form harness on disposable tasks: one qualifying (→ exactly one run, top-level
  comment), negatives (0/2 assignees, `Nie`, closed, already-actioned-today). Run once with
  `queue.enabled=true` and once false (sync fallback). Confirm via `inspect-execution.mjs`; scan
  `alerts-since.mjs` (zero unexplained WARN/CRITICAL). Verify a real due-today task's stored ms lands
  in the Warsaw-day in-memory gate. Clean up test `agent_runs` rows + disposable tasks.
- `Due-Date Producer Freshness Monitor (v1)`: daily cron; WARN via `Post Alert (v1)` if
  `due_date_producer.last_run_at` is stale > 26h.
- Write-backs: `current.md` (§3, §15.10 → Built, workflow table), ADR-065 (Accepted + verified),
  status table; commit.
- **DoD:** all paths verified live; monitor live; docs reconciled; drift-check clean.

## Verification (how)
- `node scripts/test-subworkflow.mjs` isn't needed (Form harness drives it); use the Form Trigger.
- `node scripts/inspect-execution.mjs <execId>` per run; `node scripts/alerts-since.mjs <min>` for the
  Alerts channel; `node scripts/check-workflow-drift.mjs` after export.
