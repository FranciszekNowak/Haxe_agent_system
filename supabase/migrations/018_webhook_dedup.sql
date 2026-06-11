-- 018: ClickUp webhook idempotency / dedup (2026-06-11).
--
-- ClickUp delivers the comment webhook more than once (observed: two deliveries
-- ~45 ms apart for a single @-mention -> two CU Webhook Producer runs -> two full
-- agent runs on the same comment, doubling model spend and risking double-posts).
-- The producer's existing Recent Runs / Under Limit? guard is a loop-breaker (>=8
-- runs/10 min), not a deduper: near-simultaneous duplicates both query agent_runs
-- before either has logged a run, so neither sees the other. ClickUp delivery is
-- at-least-once, so this is correct-by-design to defend against, not a one-off.
--
-- Fix: an atomic claim keyed on the triggering comment id. The producer does
-- INSERT ... ON CONFLICT DO NOTHING; the unique PK serializes the two concurrent
-- inserts so exactly one wins and proceeds. Independent of the reserved
-- 016_global_model_routing / 017_agent_runs_erasure_ready migrations (Blocks 3-4
-- of the multimodal plan); numbered 018 to leave those slots untouched.

create table if not exists agent_webhook_dedup (
  triggering_comment_id text primary key,
  first_seen_at         timestamptz not null default now()
);

comment on table agent_webhook_dedup is
  'ADR-029: webhook idempotency. One row per ClickUp triggering comment id, '
  'claimed atomically (INSERT ... ON CONFLICT DO NOTHING) by CU Webhook Producer '
  'before the spine runs, so at-least-once / double-delivered webhooks run once. '
  'Prunable: rows older than a few days are safe to delete (dedup window is seconds).';
