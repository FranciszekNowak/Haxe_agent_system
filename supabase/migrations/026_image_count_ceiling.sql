-- 026_image_count_ceiling.sql
-- Block 11 (ADR-036): replace the per-impact image-COUNT cap with a single,
-- tier-agnostic global safety ceiling.
--
-- Why: image_gen_params.max_images (migrations 012/013) capped the number of
-- images per comment by impact tier (Niski=2 … Krytycznie=8). That conflates
-- *priority* with *content-need*: a low-priority catalogue task can legitimately
-- need many low-quality thumbnails. Impact should drive image MODEL QUALITY and
-- RESOLUTION (still does, via model_routing + image_gen_params.resolution), but
-- NOT how many images the content calls for.
--
-- This migration adds ONE global ceiling (20) to the existing key/value `config`
-- table. The image-resolver (Image Resolver v1) reads it purely as a runaway
-- guard against a malformed/hallucinated block list firing dozens of costly image
-- calls; when exceeded it drops the excess, inserts a placeholder note, and WARNs
-- (multimodal/image-count-ceiling). image_gen_params.max_images is left in place
-- but is no longer read by the resolver (dead for count purposes; resolution stays
-- live). Append-only (CLAUDE.md).

insert into config (key, value) values ('image_count_ceiling', '20')
  on conflict (key) do update set value = excluded.value;
