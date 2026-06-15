-- 033_image_concurrency_cap_5.sql
-- ADR-051: raise the parallel image-generation concurrency cap from 4 to 5.
--
-- Why: routine requests are frequently for 5-10 images in one run. At cap=4 a 5-image run
-- needs two waves; 5 lets the common "five images" case complete in a single wave. Memory is
-- not the constraint at 1024x1024 (~1.2 MB base64/image; even 20 images stay well under the
-- worker's Node heap); the binding limit on raising this further is the OpenAI image endpoint's
-- rate limit (429s) -- see the Block 6 open issue in the master plan. 5 is a deliberate, modest
-- step that keeps simultaneous gpt-image-2 calls well below typical provider limits.
--
-- Supersedes the value set in migration 031 (4). Append-only (CLAUDE.md); same key/value config row.

insert into config (key, value) values ('image_concurrency_cap', '5')
  on conflict (key) do update set value = excluded.value;
