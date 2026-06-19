# ADR-053 Block 6 — output adapter + session cost + the image bytes carrier: build + live-DoD findings

**Status: DONE 2026-06-19.** The managed lane can now turn an agent session's structured output into a
ClickUp-deliverable reply, with the MCP-produced image bytes carried through our own storage, and bills
exactly one priced session row. Proven live against the production Anthropic Managed Agents API + our live
n8n. The managed lane stays **dormant** (not wired into the orchestrator until Block 8, not default until
Block 9) — these are the pieces Block 8 will wire between `Execute Agent Session (v1)` and `Post Reply (v1)`.

## What was built (three parts)

### 1) The image-bytes delivery carrier (resolves the gap 5.2/5.3 carried forward)

Files-API uploads are `purpose=agent` → **not downloadable** (Block 0), and on the MCP image path the
produced base64 is consumed inside our endpoint and **never returns to n8n** — the harness/agent gets only
the `file_id`. So Block 6 had no way to fetch a produced image's bytes for ClickUp. **Resolution: a
self-owned Supabase Storage carrier.**

- **New private bucket `agent-output-images`** (created directly; `storage.buckets` is not migration-managed).
- **`Image Tool Handler (v1)`** (`vpGswBj2kR2D85hl`) now, after the Files-API upload, **also persists each
  produced image's bytes to `agent-output-images/<file_id>`** (the key is the Files-API `file_id`).
  New nodes: `Has Carrier Bytes?` (gate on a real file_id + b64) → `Convert Carrier File` (b64→binary) →
  `Upload Output Image to Storage` (Supabase Storage REST `POST /object/{bucket}/{file_id}`, x-upsert, the
  existing `supabaseApi` cred `54fKsl6xiVi9NhV1`, the same seam `read-input.json` uses) → `Build Stored OK`
  / `Build Carrier Dropped`. **Fail-soft:** a convert/upload failure still emits the OK entry (the image
  exists in the Files API and the agent embeds its file_id) but marks `carrier_failed` so `Aggregate` fires
  an `image-tool/carrier-write-failed` WARN — delivery-will-fail is surfaced, not silent. Because the carrier
  write is in the **shared** handler, BOTH lanes (the dormant client-side path and the MCP path) populate it,
  so the output adapter resolves images **one way regardless of lane**.
- **Migration 037** (`037_agent_output_images_purge.sql`): a 24h pg_cron purge for the bucket via the Storage
  REST DELETE (frees bytes, not just the row), mirroring the zip-inner purge (029/030) and reusing the shared
  `storage_purge_runs` audit table + the existing `service_role_key` Vault secret. Hourly + ">24h" ⇒ real
  object lifetime ≤~25h (agent-produced images may carry personal data → short retention, GDPR
  data-minimisation; the bytes only need to outlive one orchestrator run, which delivers minutes after
  generation).

### 2) The output adapter — `Render Agent Output (v1)` (`vPbbN4UQj0LAAtiV`, active)

A new sub-workflow that turns the session's block-array (`output_message`, a fenced ```json array — the same
structured block protocol decision #4 locked) into the **`Post Reply (v1)` contract** `{rendered_delta,
image_manifest}` — so Post Reply is **unchanged**:
- `Parse Blocks` strips the ```json fence, parses the array, and splits it into an ordered assembly (text +
  image placeholders `gen_N`) and the list of produced images to fetch (only image blocks whose `ref` is a
  Files-API `file_id`). A non-array payload → one text block + a WARN (never a hard fail). A non-file_id image
  ref → WARN + rendered as `[Obraz niedostępny]`.
- `Has Images?` → (true) `Split Out Images` → `Download Image Bytes` (Supabase Storage GET from the carrier,
  `supabaseApi` cred, `responseFormat=file`) → `Extract B64` → `Aggregate Manifest`; (false / text-only) →
  `Build Empty Manifest`. Both converge at `Merge Manifest` → `Assemble`.
- `Assemble` (sole terminal): walks the assembly in order; **text → `mdToOps` (copied VERBATIM from
  `Image Resolver (v1)`'s `Assemble Output`** so the ClickUp ops format is identical — Post Reply consumes
  both lanes' `rendered_delta`; **kept-in-sync note in the code**); image → `{type:image_ref, placeholder_id}`
  when its bytes are in the manifest, else `[Obraz niedostępny]`. Returns `{rendered_delta,
  image_manifest:[{placeholder_id,b64,mime,caption,alt}], warnings, total_image_cost_pln:0, image_models:[],
  clickup_task_id}`. Returns `warnings[]` for the caller (orchestrator, Block 8) to fire via Post Alert —
  branch-free terminal, mirroring Image Resolver.

**Why not reuse Image Resolver directly:** the managed lane's "deliver already-produced bytes" maps onto Post
Reply's `image_manifest` + `{type:image_ref}` upload path, NOT onto Image Resolver's two image modes (embed an
existing *input* attachment, or *generate* new bytes via the batch). The genuinely shared piece (the
markdown→ops renderer + the manifest/image_ref convention) is reused; the image-resolution **source** differs
(produced file_id → carrier, vs draft-model generate/embed → batch/input-map), so forcing one workflow would
be the "coincidental duplication, different reasons" trap. `mdToOps` is duplicated (one accepted, documented
divergence — the alternative, a per-text-block sub-workflow call, is worse).

### 3) Session cost into `Log Model Run` (sole FX/PLN owner)

`Execute Agent Session (v1)`'s `Build Final Output` now computes the session `usd_cost` (was a NULL stub) from
the carried `session.usage` token tiers + runtime + web search; a fail-soft side-branch logs it.
- **Formula (Block 0 confirmed there is NO aggregate $ field):** `usd = input_tokens·p_in + output_tokens·p_out
  + cache_creation.ephemeral_5m·p_in·1.25 + cache_creation.ephemeral_1h·p_in·2.0 + cache_read·p_in·0.1
  + 0.08·duration_seconds/3600 (runtime) + web_search_count·$0.01 ($10/1k)`, all per-1M-token USD.
- **Price map (per 1M tok, USD; from the claude-api skill, 2026-06):** haiku-4-5 1/5, sonnet-4-6 3/15,
  opus-4-8 5/25, fable-5 10/50. An unknown model → floor-estimate at Opus 4.8 prices + a `cost-model-unknown`
  WARN (never a silent 0). A completed/partial session with zero usage → a `cost-usage-missing` WARN.
- **New node `Log Session Cost`** (executeWorkflow → `Log Model Run (v1)` `ztSIUkp9ytbG1xpE`) passes the
  pre-computed `usd_cost` (Log Model Run uses it verbatim — `price_in/out` left unset so its token-math
  fallback never fires) + `clickup_task_id`/`triggered_by`/`invocation_type`/`model_used`/`input/output_tokens`
  and **`cost_impact`** (impact mapped to a valid `agent_runs.impact` enum, else null — `__default__` would
  fail the CHECK). **No image cost here** — the per-image `image_mcp` rows are written independently by
  `Generate Images Parallel`'s own Log Model Run (no double-count). Wired as a side-branch off `Build Final
  Output` into `Merge Tail`, preserving the single branch-free terminal (Final Return re-reads Merge Final);
  `onError=continueRegularOutput` so a cost-log hiccup never breaks the session return.

## The reconciliation that Block 6 surfaced + fixed (CONV 2→3)

Live testing revealed the agent's image-OUTPUT protocol was a bare-lane leftover, **incoherent on the managed
lane**: the four agents' shared `system` told them "to make an image, emit `{type:image, mode:generate,
prompt}` — the system will call generate_image and insert the result." That is true on the BARE lane (Image
Resolver does the generation) but **false on the managed lane** (no downstream generator). On the first live
image task the agent *did* call the MCP tool (twice — carrier + cost rows present) yet its final block-array
referenced **neither produced file_id** — it emitted a fresh prompt-only `generate` block, which the adapter
cannot deliver. Operator decision (2026-06-19): **fix the agent protocol now, folded into Block 6** (keep
ADR-055's MCP design; don't unwind it to adapter-side generation).

Fix in `Sync Agent Definitions (v1)` `Build System` (`CONV` 2→3, re-synced via `force:true`, all four agents
re-versioned, `all_synced=true`): the managed-lane convention now states the agent **must CALL
`generate_image`** (it returns a `file_id`) and then **reference that exact `file_id`** in
`{type:image, mode:"generate", ref:"<file_id>", caption, alt}` — **no `prompt` in the output block** (a prompt
without a tool call does not create an image), and never a file_id the tool did not return this session.
`embed_input` is clarified as INPUT-attachment-only. The adapter keys on "is `ref` a Files-API file_id",
so it tolerates either `mode:generate` or `mode:embed_input` as long as the ref is a produced file_id.

## Live DoD (all pass)

- **End-to-end image task** via `Execute Agent Session (v1)` (`test-subworkflow.mjs`, image task,
  `impact=Niski`), AFTER the CONV=3 re-sync: `status:completed`, `outcome:done`, Haiku, 46s, `warnings:[]`.
  The agent **called generate_image via MCP and embedded the returned `file_011CcCLnKxzXUmVbq7PjGtnY`** as
  `{type:image, mode:"generate", ref:"file_011Cc…"}` (no prompt). Carrier holds that produced image
  (1,232,502-byte PNG). **Exactly one priced session `agent_runs` row** (`usd_cost` 0.021614 → 0.0801 PLN)
  **plus one `image_mcp` per-image row** (gemini-3-pro) — no double-count, no double-execution this run.
- **Output adapter** (`Render Agent Output (v1)` via `test-subworkflow.mjs`, fed that agent's real
  `output_message`): `warnings:[]`, `rendered_delta` = header/text ops then `{type:image_ref,
  placeholder_id:gen_0}` + italic caption, `image_manifest` = one entry whose **`b64` is 1,643,336 chars
  (= 1.23 MB × 4/3, PNG header `iVBORw0KGgo…`)** resolved from the carrier — i.e. an MCP-produced image
  resolves to deliverable bytes via the new carrier. Text-only path also verified (earlier iteration).
- **Cost surface verified independently:** a text/image session computes a correct non-zero `usd_cost` from
  the token tiers + runtime + web-search; `usd_cost_stub:false`.
- **Alert channel clean:** 0 WARN / 0 CRITICAL across the whole test window.
- Test `agent_runs` rows deleted; carrier test objects left for the 24h purge (doubles as a purge test);
  test sessions + `purpose=agent` Files-API images left per the Block 3/4 precedent (harmless; can't delete
  without exposing the key on the CLI).

## Findings (non-obvious; cost a cycle each)

1. **Binary is in filesystem mode on this instance** → in a Code node `item.binary.data.data` returns the
   storage marker string `"filesystem-v2"`, NOT the base64. Reading produced-image bytes requires
   `await this.helpers.getBinaryDataBuffer(itemIndex, 'data')` then `.toString('base64')` (run-once-for-all
   with pairedItem mapping back to the split metadata). The first adapter build silently produced a 13-char
   "b64" until caught.
2. **The agent's image-output behaviour was prompt-dependent / non-deterministic** before CONV=3 (5.3 saw
   `embed_input`+`ref`; Block 6 first saw a prompt-only `generate` block) — the root cause was the bare-lane
   convention in the shared `system`, not the model. The fix is a prompt change, with the usual
   Haiku-follows-instructions caveat; the live re-test confirmed it now references the produced file_id.
3. **`test-subworkflow.mjs` fired the session twice** on one run earlier (two top-level executions → two
   session rows + two image rows) — a known queue/flood artifact, NOT a cost double-log (each execution's
   `Build Final Output` runs once and logs exactly one row; the clean re-run produced exactly 1+1 rows).
4. **`agent_runs.impact` rejects `__default__`** (same trap as 5.2) → the session cost row passes a sanitized
   `cost_impact` (valid enum or null).

## Silent-failure modes covered

- **Carrier write fails (convert/Storage)** → the image still embeds but `image-tool/carrier-write-failed`
  WARN flags that delivery may fail (it would otherwise be a paid-for image that silently never reaches
  ClickUp).
- **Produced-image bytes missing at delivery** (carrier write failed earlier, or object purged) → the adapter
  GET errors to `Build Image Missing` → WARN + `[Obraz niedostępny]`, the rest of the message still posts.
- **Cost surface missing/zero** → unknown model floor-estimates at Opus 4.8 + WARN; zero-usage completed
  session → WARN; never a silent 0.
- **Cost-log insert fails** → `Log Model Run`'s own WARN + `onError=continueRegularOutput` so the session
  still returns.
- **Agent references a non-produced / non-file_id ref** → adapter WARN + `[Obraz niedostępny]`, never a
  broken post.
- **Carrier bucket unbounded growth / stale personal-data images** → migration 037 24h pg_cron purge.

## Net effect on the plan

- Block 6 DONE; the 5.2/5.3 image-bytes delivery gap is **resolved** (Supabase Storage carrier). **Block 7
  next** (Post Reply office-doc delivery). Office-doc OUTPUT files (skills/code-exec) **are** downloadable
  (Block 0), so Block 7's download path is separate from this image carrier.
- Block 8 wires `Execute Agent Session → Render Agent Output → Post Reply` and reconciles the comment footer
  (`total_image_cost_pln` is 0 from the adapter; managed-lane image cost lives in `agent_runs`, not the
  per-comment footer).
- **Input-image echo on the managed lane is NOT yet handled** (the adapter has no input-image map; an
  `embed_input` ref that is a ClickUp attachment, not a produced file_id, renders `[Obraz niedostępny]` + a
  WARN). Out of scope here; revisit if the agent needs to re-show input images.
