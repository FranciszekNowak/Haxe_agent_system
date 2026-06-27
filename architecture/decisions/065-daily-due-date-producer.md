# ADR-065: Daily Due-Date Autonomous Producer

Date: 2026-06-27
Status: **Accepted — built + verified live end-to-end (2026-06-27); workflow INACTIVE pending operator
activation.** Both workflows (`due-date-producer.json` `Ubwr6fRmStFwwJfP`, `due-date-producer-freshness-monitor.json`
`q98HgAuUlqxg1CF4`) deploy, validate (0 errors), and are drift-clean.

## Verification (2026-06-27, against the live system via a temporary Gate allowlist on disposable tasks)

- **Enqueue path (primary):** a qualifying disposable task (due today Warsaw, 1 assignee, `Czy dla
  AI=Tak`, open, impact Niski) was fetched (response carried `custom_fields`/`assignees`/`status`),
  passed the gate (found:25 → candidates:1), enqueued (`invocation_type=due_date`, jobId
  `…:due_date:<bucket>`, priority 8, deduped:false). The consumer ran the spine → `agent_runs` row
  `triggered_by=due_date_daily`, `invocation_type=autonomous`, `caller=<assignee>`, status completed,
  model `claude-haiku-4-5` — and a **new top-level comment** (`@`-mention the assignee) was posted.
- **Dedup:** re-running with the task already actioned today → `already_actioned:1, enqueued:0`, no run.
- **Synchronous fallback:** forcing `/enqueue` to fail (dead port) on a fresh task → the
  `due-date-producer/enqueue` WARN fired AND the inline spine still ran (`due_date_daily`/`autonomous`,
  top-level comment) — never silently dropped.
- **Negative gates (live):** wrong-day (Warsaw TZ), not-for-AI, and zero-assignee tasks were each
  rejected with the correct counter; the two-assignee case is covered by the same `assignees.length !==
  1` predicate that rejected zero (a ClickUp quirk left the 2-assignee test task with 1 assignee, so it
  was not exercised directly — noted honestly). Closed/done is enforced by `include_closed=false` + the
  `status.type` check (not exercised live).
- **Summary + heartbeat:** the per-night `Post Alert (v1)` INFO carries the full counts; `config.due_date_producer.last_run_at` is stamped every run (verified non-zero counts after fixing a bug where the heartbeat Postgres node clobbered the summary item — the summary item is now fanned out to a side branch).
- **Freshness monitor:** fresh heartbeat → no alert (dead-end branch); forced-stale (threshold lowered
  to 0h) → the `due-date-producer/freshness` WARN fired. Restored to 26h.
- **Blast-radius dry run** (no allowlist, dispatch disabled): of 30 tasks in the ±48h window, 25 are
  wrong-day and 0 genuine tasks qualified today — i.e. no storm risk on activation.
- All checks: **0 CRITICAL**. The only WARNs were the intentional fault-injection ones above and the
  pre-existing `agent-orchestrator/render` `no-deliver-output` text-fallback (a known Haiku
  `deliver_output` protocol issue, orthogonal to this ADR). Test `agent_runs` rows + all 6 disposable
  tasks were deleted afterward.

## Context

The agent has only ever run on a human **pull**: an `@`-mention or `~command` fires
`CU Webhook Producer (v1)`, which enqueues the orchestrator (ADR-029, ADR-056). The core model
(`current.md` §1/§3) and the planned-workflow design (§15.10) have always specified a second,
**autonomous push** trigger: a nightly scan that drafts work on tasks the team flagged for AI, so
overnight drafts are ready by morning. This is the Phase-3 "Daily Due-Date Producer."

## Decision

Build `Daily Due-Date Producer (v1)` (`n8n/workflows/due-date-producer.json`): a daily 00:00
Europe/Warsaw cron (plus a Form-Trigger manual harness) that scans ClickUp and fires **one** autonomous
agent run per qualifying task. A task qualifies iff ALL hold:

1. due date is **today** in **Europe/Warsaw**,
2. **exactly one** assignee,
3. `[AI] Czy zadanie dla AI = Tak`,
4. **no `agent_runs` row already exists for that task today** (Europe/Warsaw; any trigger counts),
5. the task is **not** closed/done.

The run is attributed to the single assignee (caller = assignee; no creator fallback — divergence from
§3's "assignee → creator → skip" default, justified below). Output posts as a **new top-level comment**
(already handled by `Post Reply (v1)` when `triggering_comment_id` is empty).

### Key design choices

- **Enqueue, not inline.** The producer adopts the ADR-056 `/enqueue` contract
  (`invocation_type='due_date'`), mirroring the mention producer's dispatch subgraph
  (`Read Queue Flag` → `Queue Enabled?` → `Build Enqueue Job` → `Enqueue Job` → synchronous fallback +
  WARN). A batch of due-today tasks is precisely the midnight burst BullMQ exists to pace against the
  Managed-Agents concurrency cap; firing N inline orchestrator runs would risk 429/529 storms. The
  consumer ranks `due_date` jobs in priority band 5–8, always behind interactive `@`-mentions (1–4).

- **"Any action today" dedup lives in the producer.** A single batched query —
  `select distinct clickup_task_id from agent_runs where clickup_task_id = any($ids) and created_at >=
  <Warsaw day start>` — drops tasks the agent already acted on today, regardless of trigger. The
  queue-consumer's own idempotency only matches a *completed* `due_date_daily` run inside a 24h bucket,
  so it would not see a human `@`-mention or an `image_gen` row earlier today; the operator's
  "any action" rule therefore must be (and is) enforced producer-side. The consumer bucket remains a
  secondary net (e.g. a double cron run).

- **Due-today gated in-memory by Warsaw calendar date.** ClickUp's date-only due-date storage time is
  ambiguous, so the server-side fetch uses a **widened** unix-ms window (±24h) and a Code node keeps only
  tasks whose `due_date` formats to today's date under
  `Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Warsaw'})`. DST-safe and convention-agnostic. (The
  operator chose Europe/Warsaw over the literally-specified "UTC day" so "today" matches the team's
  calendar; the dedup window uses the same Warsaw boundary for consistency.)

- **Exactly-one-assignee, no creator fallback.** The operator narrowed §3's
  "assignee → creator → skip" to a hard "exactly one assignee, else skip." Rationale: an autonomous
  draft is attributed to, spend-gated against, and permission-scoped to **one** human; zero or multiple
  assignees make that attribution ambiguous, and a creator fallback would draft on tasks nobody is
  actively assigned to (noise). Caller identity needs only `reviewer_user_id` = the assignee id
  (`assemble-context-and-build-prompt.json:101`), which gives ADR-054 scoping + ADR-064 spend gating
  for free.

- **Skip closed/done.** Operator-confirmed red-team addition (not in the bare spec): drafting on
  already-finished work is noise.

- **Batch summary + heartbeat via the existing alert seam.** Each night the producer posts an INFO
  through `Post Alert (v1)` (found / enqueued / skipped-by-reason) and stamps a `config` heartbeat
  (`due_date_producer.last_run_at`). §15.10 said "batch summary to GM Reports," but no nightly digest
  task exists (only the weekly-proposer's "GM Weekly Reports"); per the unification rule we reuse the
  established seam rather than build a parallel path. A dedicated digest can come with the Phase-4
  weekly proposer.

## Consequences

- The agent now produces overnight drafts autonomously on team-flagged tasks — the long-planned
  proactive lane, closing the pull-only gap.
- **No migration.** `triggered_by='due_date_daily'` and `invocation_type='autonomous'` already pass the
  `agent_runs` CHECKs; dedup reuses existing columns. The consumer + ingress already support `due_date`,
  so **no existing workflow changes** — the producer is purely additive.
- **Silent-failure coverage** (CLAUDE.md): a stopped cron → `Due-Date Producer Freshness Monitor (v1)`
  dead-man's switch (WARN if the heartbeat is stale > 26h); consumer down / enqueue non-200 → per-task
  synchronous fallback + WARN (mirrors the mention producer); ClickUp fetch throw → reactive Error
  Handler CRITICAL (`errorWorkflow`); one task erroring → side-branch alert, batch continues; DB dedup
  blip → `onError:continueRegularOutput` fail-open (worst case one extra run, caught by the consumer
  bucket); self-trigger loop → telemetry-task guard + the gate (telemetry tasks aren't `Czy dla AI`);
  un-onboarded assignee → degrades + WARN downstream (ADR-054).
- **Cost exposure is bounded by the gate + ADR-064.** Each qualifying task fires at most once/day, and
  every run passes the per-user + company spend gate at orchestrator entry.
- **Trade-off accepted:** a task whose only assignee is un-onboarded for per-user scoping still runs
  (degraded to deterministic pre-gather + WARN), rather than being skipped — keeping the proactive lane
  useful during onboarding rollout.

Related: ADR-029 (mention producer / enqueue dispatch template), ADR-056 (BullMQ queue + `/enqueue`
contract + Spine HTTP Ingress), ADR-054 (per-user scoping via `reviewer_user_id`), ADR-064 (spend
gate), ADR-027 (post-back top-level comment), ADR-025 (alert seam), ADR-015 (one generic pipeline).
