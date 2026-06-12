-- 025_agent_runs_payload_bytes.sql
-- Block 10 (ADR-036, Option A in-memory base64 delivery): per-execution data-weight observability.
-- The base64-in-memory delivery pivot (Execute Command + file-delete are unavailable on this n8n
-- instance, so disk staging/cleanup is impossible) makes image bytes ride through n8n execution data.
-- These columns let us watch that weight per run. Append-only (CLAUDE.md); additive, nullable; no PK/
-- column changes; PD-blind (no personal_data / eu_only — dropped in 021).
--
-- run_payload_bytes: UTF-8 byte size of the delivered payload (rendered comment + any image base64),
--   computed once per execution in Stage C (Finalize Comment) and written on the SAME final answer row
--   that Record Artifact (Block 4) already targets — for text AND image runs alike. It is a PROXY and a
--   LOWER BOUND for the true n8n execution-data row (true ~= this x nodes the payload traverses), not the
--   literal stored figure. Null if the run failed before delivery.
-- n8n_execution_id: the n8n execution id for this run — enables an exact execution-data-size backfill
--   later and run->execution debugging. Nullable.

alter table agent_runs
  add column if not exists run_payload_bytes bigint,
  add column if not exists n8n_execution_id  text;

comment on column agent_runs.run_payload_bytes is
  'Observability: UTF-8 byte size of the delivered payload (rendered comment + any image base64) for this execution. Proxy and lower bound for n8n execution-data weight (true ~= this x nodes traversed). Written once per execution on the final answer row, for text and image runs alike. Null if the run failed before delivery.';
comment on column agent_runs.n8n_execution_id is
  'Observability: n8n execution id for this run; lets you backfill exact execution-data size and jump run->execution. Nullable.';
