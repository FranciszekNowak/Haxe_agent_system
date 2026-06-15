-- 031_image_concurrency_cap.sql
-- ADR-051: parallel image generation. Add a global, tunable max-concurrency cap for the
-- in-execution Promise.all image-generation batch (Generate Images Parallel v1).
--
-- Why: a single agent run can request several generated images. Today they run strictly
-- sequentially (Image Resolver's Call Invoke Model, mode:each), so N gpt-image-2 images take
-- ~N x 176 s. ADR-051 fires them concurrently from one Code node. This cap bounds how many
-- are in flight at once -- a SELF-IMPOSED limit to protect provider rate limits, the box, and
-- cost. It is independent of n8n worker concurrency (Promise.all runs inside one execution, so
-- the worker limit does not bound it). The separate config.image_count_ceiling (migration 026)
-- still bounds the TOTAL number of images (runaway guard); this bounds SIMULTANEOUS calls.
--
-- Default 4. Append-only (CLAUDE.md); reuses the existing key/value `config` table.

insert into config (key, value) values ('image_concurrency_cap', '4')
  on conflict (key) do update set value = excluded.value;
