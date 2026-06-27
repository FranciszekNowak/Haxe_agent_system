# Block 0 findings — ADR-065 capability gates

Date: 2026-06-27. All gates resolved against the live system; no migration required.

## G1 — ClickUp field ids (from live task `869dhad2q`, `get_task include:custom_fields`)
- `[AI] Czy zadanie dla AI` = **`088d66e2-6095-4604-b70d-e50ebb085ae2`** (`drop_down`).
  Options: `Nie` = `820216c3-7478-4d29-beea-f7c7c11f8fd6` (orderindex 0); **`Tak` =
  `c409b519-7ef3-49e8-8170-260c992b2553` (orderindex 1)**. On the sample task the stored `value` was
  the integer `1` (the orderindex), not the option id — so the gate must match the field value against
  **either the option id OR the orderindex** (same trick as the mention producer's impact resolver).
- `[AI] Wpływ zadania na wynik firmy` = `55c7ff79-1857-41e6-87b4-bd46678e1470`; option map identical
  to `cu-webhook-producer.json` `Build Enqueue Job` (Niski/Średni/Wysoki/Krytycznie ważne ids).
- `[AI] Status agenta` = `30130652-01c2-451b-954a-c36a455790fe` (already used by the spine).
- Team id = **`761759`** (from ADR-029). Alerts task = `869dj2z2c`.

## G2 — queue-consumer supports `due_date` natively (`services/queue-consumer/app.mjs`)
- `INVOCATION_TYPES` includes `'due_date'` (line 116) → `/enqueue` accepts it.
- `computePriority('due_date', impact)` = `(not explicit → 4) + IMPACT_RANK` = **5–8** (always behind
  the 1–4 explicit band). ✔ requirement "autonomous lands behind interactive".
- `TRIGGERED_BY['due_date'] = 'due_date_daily'` (passes `agent_runs.triggered_by` CHECK).
- `SPINE_INVOCATION['due_date'] = 'autonomous'` (passes `agent_runs.invocation_type` CHECK).
- `/enqueue` required, non-empty: `task_id, caller_user_id, impact, invocation_type, enqueued_at,
  payload`. `impact` MUST be one of the 4 real tiers (default to `Średni` when absent/`n/d`/unreadable).
- **Autonomous dedup is a 24h time bucket** (`deriveJobId` non-explicit branch) and the pre-trigger
  idempotency only matches a **completed `due_date_daily`** run in the last `dedup_window_h`
  (`findCompletedRun`). Neither covers a human @-mention / image_gen row earlier today ⇒ the operator's
  "**any** action today" rule must be enforced in the **producer** (batched `agent_runs` query). The
  consumer bucket dedup is a secondary net only.

## G3 — agent_runs CHECKs already permit the values (`001_initial_schema.sql:20-26`)
- `triggered_by` array includes `'due_date_daily'`; `invocation_type` array includes `'autonomous'`.
  **No migration needed.** Live `agent_runs` rows confirm `caller_user_id` is the numeric ClickUp id as
  text (e.g. `2521617`), `created_at` is UTC `timestamptz`, and multiple rows per task/day are normal
  (session + per-image) → the dedup is an existence check, trigger-agnostic.

## G4 — Supabase config + Warsaw-day expression
- `config.queue.enabled = 'true'` (enqueue is the live primary path); `config.agent_lane = 'managed'`.
- `due_date_producer.last_run_at` does **not** exist yet → the producer creates it (heartbeat).
- `date_trunc('day', now() at time zone 'Europe/Warsaw') at time zone 'Europe/Warsaw'` →
  `2026-06-26 22:00:00+00` at test time (UTC+2 DST) — correct Warsaw midnight as `timestamptz`. This is
  the exact `created_at` lower bound for the dedup query.

## G5 — caller identity needs only `reviewer_user_id`
`assemble-context-and-build-prompt.json:101` sets `caller_user_id = reviewer_user_id || '2521617'`.
Passing the single assignee as `reviewer_user_id` therefore yields ADR-054 per-user ClickUp scoping AND
ADR-064 per-user spend gating (`agent-orchestrator.json:888` gates on `reviewer_user_id`) with no extra
wiring. `caller_username` is informational (logged).

## G6 — "as already coded": top-level comment on autonomous
`post-reply.json:64` — `triggering_comment_id` set → in-thread reply; empty → new top-level comment
("Post Draft Comment"). The producer passes empty comment id/text ⇒ a fresh top-level comment. No work.

## Residuals to confirm in Block 2 (not blockers)
- The ClickUp `/team/{id}/task` response shape (custom_fields/assignees/status present; pagination via
  `last_page`) — confirmed by the first live Form-harness run.
- A real due-today task's stored `due_date` ms landing inside the Warsaw-day in-memory gate (the
  date-only storage-time convention) — confirmed by a disposable task with due=today.
