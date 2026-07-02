-- 050_session_waiter_budget_raise.sql
-- Follow-up to ADR-066 / ADR-054 (2026-07-02): raise the async session cap and keep the freshness
-- invariant intact. Append-only (CLAUDE.md).
--
-- WHY: the 840 s soft deadline was a SYNCHRONOUS-path artefact — that loop runs inside a single n8n
-- Code node which n8n's task runner kills at ~900 s, so 840 s kept it just under the kill. The ADR-066
-- async waiter runs the session loop in a standalone service that is NOT bound by n8n's node lifetime,
-- so that constraint no longer applies. Migration 049 already seeded the waiter budget at 45 min
-- (2_700_000 ms); the operator asked to remove the artificial cap. We raise it to a generous 90-minute
-- backstop rather than truly unbounded, because the non-delivery dead-man's-switch and cost/runaway
-- protection still need a ceiling (a wedged session otherwise ties up the waiter and bills indefinitely),
-- and managed sessions have their own server-side max lifetime.
--
-- COUPLING (the load-bearing part): session_waiter.stuck_after_minutes is the freshness monitor's
-- threshold and MUST EXCEED the longest legit run, or a healthy long task false-alarms as "stuck"
-- (migration 049 comment). Raising the budget to 90 min forces the stuck threshold above 90; we set it
-- to 100 min. The validation trigger (049) caps stuck_after_minutes at 1440 and requires
-- absolute_budget_ms >= 60000, both satisfied here.
--
-- The synchronous fallback's own 840 s deadline (execute-agent-session "Build Initial State") is LEFT
-- as-is on purpose: that path really is bounded by the n8n node kill, so its cap is correct.

insert into config (key, value) values
  ('session_waiter.absolute_budget_ms',  '5400000'),   -- 90 min (was 45 min in 049)
  ('session_waiter.stuck_after_minutes', '100')         -- must exceed the 90-min budget (freshness invariant)
  on conflict (key) do update set value = excluded.value;
