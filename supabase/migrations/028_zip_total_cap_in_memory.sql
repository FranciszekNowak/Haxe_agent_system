-- 028_zip_total_cap_in_memory.sql
-- Block 3 (ADR-048), gate B outcome. The build-time gate on n8n-nodes-base.compression
-- (typeVersion 1.1) resolved: its `decompress` operation uses adm-zip, which loads the whole
-- archive and extracts every entry into in-memory Buffers BEFORE n8n persists them to the
-- binaryMode:separate filesystem store. So the decompress step is an in-memory operation, not a
-- streamed-to-disk one. Per ADR-048 Decision 4, the total-uncompressed guard must therefore sit
-- at ~250 MB (not 500) to stay clear of OOM on the shared 8 GB box.
--
-- Note: this guard is enforced downstream in the reader's `Explode Zip Entries` node — it bounds
-- what is handed onward to Docling and Supabase (the expensive amplification), but it cannot
-- prevent the decompress-time memory spike itself (that spike is inherent to adm-zip and is
-- accepted, backstopped by the ADR-046 storage watchdog). 250 MB keeps that transient spike
-- survivable. Append-only (CLAUDE.md): re-seed via the same on-conflict upsert as migration 027.

insert into config (key, value) values
  ('zip_max_total_uncompressed_mb', '250')
  on conflict (key) do update set value = excluded.value;
