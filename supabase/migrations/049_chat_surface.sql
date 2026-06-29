-- 049_chat_surface.sql
-- ADR-066 Block 2: the ClickUp Chat surface (poll producer + per-surface spine adapters).
--
-- Chat fires NO ClickUp webhook and exposes NO automation we can use (Block 0 findings G1), so the
-- Chat trigger is a once-a-minute POLL of the channels the bot is a member of (get_chat_channels as
-- the bot only returns channels the bot's token can see — membership IS the token scope). The poll
-- keeps only messages that (a) are newer than a per-channel last-seen cursor and (b) @-mention the
-- bot (via the message tagged-users endpoint, not text parsing), then enqueues each once.
--
-- Two idempotency layers, both append-only state here (mirrors the task webhook producer's
-- cursor-free dedup + the consumer's message-keyed jobId):
--   * chat_poll_cursor  — per-channel high-water mark (max message `date` ms seen). Each poll keeps
--     only messages strictly newer than the cursor and advances it, so a message is scanned once and
--     the bot's OWN replies (always newest) advance the mark without re-triggering.
--   * agent_chat_dedup  — atomic per-message claim (INSERT ... ON CONFLICT DO NOTHING), the exact
--     analogue of agent_webhook_dedup for the task surface. Belt-and-braces against an overlapping
--     poll or a cursor-advance that failed mid-run: a message enqueues at most once.
--
-- config:
--   * chat.poll_interval_s         — documented poll cadence (default 60). The n8n Schedule Trigger
--     interval is static in the node; this key is the source-of-truth value the producer node mirrors
--     and the freshness monitor reasons about. (No queue.* trigger here — these keys are chat.%.)
--   * chat_poll_producer.last_run_at — liveness heartbeat the producer stamps every run; the Chat Poll
--     Freshness Monitor dead-man's-switch WARNs if it goes stale. Seeded to now() so the monitor does
--     not false-alarm in the window between this migration and the producer's first run.
--
-- Append-only migration (CLAUDE.md). No validation trigger: chat.% keys are read by n8n nodes with
-- their own fail-safe defaults, not by the consumer's typed reader, so the queue.% trigger's strict
-- bounds do not apply.

create table if not exists chat_poll_cursor (
  channel_id      text primary key,
  last_seen_ms    bigint not null default 0,
  last_message_id text,
  updated_at      timestamptz not null default now()
);

comment on table chat_poll_cursor is
  'ADR-066 Block 2: per-channel high-water mark for the Chat poll producer. last_seen_ms = the max '
  'ClickUp chat message `date` (ms epoch) seen on this channel; each poll keeps only messages with '
  'date > last_seen_ms and advances the mark. A new channel (no row) starts at 0 -> the first poll '
  'would treat all history as new, so the producer SEEDS a new channel to the newest message WITHOUT '
  'enqueuing on the first sighting (cold-start guard, see cu-chat-poll.json).';

create table if not exists agent_chat_dedup (
  message_id    text primary key,
  channel_id    text,
  first_seen_at timestamptz not null default now()
);

comment on table agent_chat_dedup is
  'ADR-066 Block 2: Chat-surface idempotency. One row per ClickUp chat message id, claimed atomically '
  '(INSERT ... ON CONFLICT DO NOTHING) by the Chat Poll Producer before enqueue, so an overlapping '
  'poll or a partial cursor advance never double-enqueues a message. Analogue of agent_webhook_dedup '
  'for Chat. Prunable: rows older than a few days are safe to delete (dedup window is one poll cycle).';

insert into config (key, value) values
  ('chat.poll_interval_s',           '60'),
  ('chat_poll_producer.last_run_at', now()::text)
  on conflict (key) do update set value = excluded.value;
