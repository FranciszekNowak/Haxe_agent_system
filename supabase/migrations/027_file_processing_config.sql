-- 027_file_processing_config.sql
-- Block 1 (ADR-048): global, DB-tunable limits for zip unpacking. Stored as keys in the
-- existing key/value `config` table (same shape as image_count_ceiling, migration 026), NOT a
-- new table — unification default (CLAUDE.md). GLOBAL, not impact-keyed: a low-impact task can
-- legitimately carry many/large files, so file limits have nothing to do with task priority.
-- The reader's `Lookup File Processing Config` node reads these; enforcement (the zip guards)
-- lands in ADR-048 Block 3. Append-only (CLAUDE.md).
--
-- Value note: zip_max_total_uncompressed_mb=500 is correct only if n8n-nodes-base.compression
-- decompresses to the filesystem (expected under binaryMode: separate, covered by the ADR-046
-- storage watchdog). If the build-time gate (ADR-048 Step 0.B) shows it buffers the whole
-- archive in memory, re-seed 250 via the same on-conflict upsert in a later migration.

insert into config (key, value) values
  ('zip_max_entries',               '50'),
  ('zip_max_file_mb',               '25'),
  ('zip_max_total_uncompressed_mb', '500')
  on conflict (key) do update set value = excluded.value;
