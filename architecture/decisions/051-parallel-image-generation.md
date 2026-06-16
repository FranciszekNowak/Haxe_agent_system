# ADR-051: Parallel image generation

**Status:** Accepted (all blocks done + verified, 2026-06-15 — master plan `parallel image generation`).
**Block 7 added 2026-06-16:** graceful task-runner-timeout handling (the batch timeout is now a non-blocking WARN, not a CRITICAL) — see below.
Block 1 done + verified: LiteLLM key management enabled (65 key-store tables, liveliness 200), image-scoped
key in Vault, `get_litellm_image_key()` getter live. **Auth spike PASS (2026-06-15):** the pipeline's
Postgres node (role `postgres`) reads the getter, and a Code-node `Promise.all` fired 2 concurrent
authenticated `gemini-2.5-flash-image` calls in 6.25s (≈ one call, not ~12s sequential), both
200 + b64.

**Block 3 done + verified (2026-06-15):** `Generate Images Parallel (v1)` built (id `2keb6XVWq5PG0leK`,
`n8n/workflows/generate-images-parallel.json`) and verified standalone via a throwaway
`Webhook → Set → Execute Workflow` caller (since deleted). Results: (A) 3-prompt Niski batch → 3 images,
`max_in_flight`=3, Fire step 24.5s ≈ one single gemini call (sequential would be ~72s), 3 `agent_runs`
rows at the real header cost (0.142 PLN each); (B) 6-prompt cap-4 batch → `max_in_flight`=4 (cap honored);
(C) one empty prompt → 2 successes + 1 failure carrying a `warnings[]` entry, execution `success`, **0
alerts** (image failures caught per-image, never CRITICAL); (D) shaped `1536x1024` request on Niski →
upgraded to `openai/gpt-image-2`, decoded PNG **exactly 1536×1024**, which also proved the image-scoped
Vault key authenticates to gpt-image-2 (Block 1's spike only proved gemini). **Known faithful-port
behaviour flagged:** a hard-failed image (no b64 after fallback) still logs an `agent_runs` row priced at
the per-image floor (mirrors `Invoke Model`'s `Normalize Model Result` both-down path); a 429 rate-limit
during testing surfaced this. Not a regression (the old path does the same); a one-line change in
`Explode Results` would bill 0 for failures if desired.

**Post-review cleanup (2026-06-15, same session):** an early draft re-derived the step-down ordering
inline (a duplicated tier array) and hardcoded the gpt upgrade prices. Both were removed: a
`Resolve Lower Tier Image` node now calls `Resolve Lower Tier (v1)` once (single owner of the
step-down), and the upgrade + fallback prices are read from the image-tier rows — so the only literals
left are the two irreducible DB-down last-resorts. Re-verified: Średni → step-down resolves to the
Niski gemini row with its DB prices; Niski + shaped → upgrades to gpt-image-2 at the correct DB price
`0.005` (the old inline `0.0003` quirk is gone) and decodes 1536×1024; 3-image concurrency and a clean
alert channel both intact.

**Block 4 done + verified (2026-06-15):** `Image Resolver (v1)` (`znDqcfgXK6CNte20`) rewired so its generate
branch calls the batch once instead of `Call Invoke Model` `mode=each`: `Build Batch Request` (collects all active
generate blocks into one `requests_json` array + `concurrency_cap` from `config.image_concurrency_cap`) → `Call
Generate Batch` → rewritten `Handle Gen Result` (maps results back by `placeholder_id`, no `task_type` smuggling;
folds per-image `warnings[]` into the resolver `warnings[]`, which `Assemble Output` aggregates so
`execute-llm-call`'s `Has Warnings?` seam fires the WARN). `Lookup Count Ceiling` became `Lookup Image Config`
(ceiling + cap in one row). `Merge Branches → Assemble Output` remains the sole branch-free terminal; the
`image_manifest`/`rendered_delta` contract to Stage C is unchanged. Pushed live + re-exported drift-clean. Verified
(A) in isolation — text + 2 generate + 1 embed → correct interleave order (text, gen_0, embed, gen_1), 2 `agent_runs`
rows, `max_in_flight=2`, no warnings — and (B) end-to-end via a real Krytycznie-ważne @-mention on `869dhad2q` → 2
`gpt-image-2` images rendered inline in order, footer cost 2.0332 PLN, batch concurrent (`max_in_flight=2`, **158.7 s
≈ one image vs ~317 s sequential**), 0 alerts from the image path.

**Block 5 done + verified (2026-06-15):** `Invoke Model (v1)`'s now-dead image-OUTPUT branch was deleted — the
`Output Is Image?` fork, `Resolve Lower Tier Image` → `Lookup Fallback Image Prices` → `Call Model Image` →
`Parse Image`, and the `Image Degraded?` / `Cost Header Missing?` image alerts (9 nodes, 27→18) — and
`Resolve Routing` + `Normalize Model Result` were simplified to text/multimodal-INPUT only (the
`aspectToSize`/`gptValid`/`snapGptValid` helpers and the gemini→gpt-image-2 upgrade now live only in the
batch). `Resolve Routing → Resolve Lower Tier Text` is the single path; the multimodal-INPUT
`Image Unprocessable?` WARN seam now reconverges straight into `Routing Missing?`; `Shape Output` remains the
sole branch-free leaf. Pushed live (`XcOIVdZnVCCWNPeb`), validated (0 errors), re-exported drift-clean.
Verified before/after with a text-only run (identical `completion`/cost, path shortened to drop the removed
nodes) and a multimodal-INPUT run (graceful degrade to the Opus text-only safety net, `success:true`, the
expected `multimodal/image-unprocessable` WARN firing through the rewired connection); 0 CRITICAL and nothing
from the deleted image-gen alerts. The batch is now the **sole** image-gen path — image-resolution logic and
the image HTTP/fallback live in exactly one place (by deletion, not a shared helper).

**Block 6 done + verified (2026-06-15) — memory hardening + 429 handling:**
- **Memory.** The n8n containers had no `mem_limit` and Node's default heap ceiling on this 8 GB box is
  ~2.2 GB, so two unbounded n8n processes could crowd Docling (≥4 GB when loaded) off the host. Set
  `mem_limit: 1024m` + `NODE_OPTIONS=--max-old-space-size=768` on **both** `n8n-main` and `n8n-worker`
  (`n8n/docker-compose.yml`); the heap ceiling sits below the cgroup limit so a runaway hits a JS-heap OOM
  (fails its own execution, container restarts) rather than the kernel OOM-killing Docling. Deployed per
  ADR-033 (`scp` + `docker compose up -d --force-recreate`, never `restart`). Verified: cgroup limit =
  1073741824 bytes and the effective heap ceiling dropped from 2240→~816 MB (Node reports young-gen on top
  of the 768 cap) on both; a 5-image concurrent `gpt-image-2` batch peaked the worker at **~228 MiB** —
  image base64 heap is trivial, so the cap is purely a safety valve against a pathological runaway, not a
  tight fit. (The literal "many large images while Docling loaded" worst case wasn't force-reproduced —
  Docling wasn't co-loaded — but the measured heap shows headroom of >4×.)
- **429 / rate limit (decision: Option 1, buy-before-build).** The concurrency cap bounds simultaneous
  in-flight calls but doesn't pace requests-per-minute, so a burst can hit the OpenAI gpt-image-2 rate limit
  (HTTP 429), which the batch's per-image fallback would treat like any failure and **tier-downgrade**
  (silent quality loss — exposed only at the Wysoki tier; Krytycznie already re-sends gpt-image-2). Chosen
  fix: **lean on LiteLLM's native retries** (`litellm_settings.num_retries: 3`, `n8n/litellm-config.yaml`) —
  the router retries 429/500/timeout with exponential backoff and respects upstream `Retry-After` *before*
  returning to n8n, so a transient 429 is absorbed at the gateway and the image stays on its routed top-tier
  model; only a sustained overload that exhausts the retries reaches n8n's fallback (still loud, via
  `warnings[]`). **Option 2 (batch-side 429-distinct retry) was deliberately NOT built** — the gateway now
  absorbs the transient case, so adding inline retry logic is build we can avoid until Option 1 proves
  insufficient (CLAUDE.md build-vs-buy gate). **Proactive `rpm` pacing was also not set** — it needs the
  account's real images/min limit, which we don't have; guessing one would throttle throughput. Verified:
  litellm rebooted clean with `num_retries: 3`, liveliness 200, and a 5-concurrent gpt-image-2 batch all
  returned 200 (no 429, no downgrade) — confirming the setting is live and non-disruptive. A real
  429-burst-induced retry was **not** force-tested (can't cheaply/reliably trigger OpenAI's rate limit, and
  the cap-5 batch can't exceed the limit in one wave); the mechanism is LiteLLM's documented router behaviour.
  The cap stays conservative at **5** until a real volume need justifies raising the OpenAI quota.

**Block 7 done + verified (2026-06-16) — graceful task-runner-timeout handling:**
- **Incident.** A 10-image `Wysoki` batch (`gpt-image-2`, exec 2415, task `869dp81xd`) ran the
  `Fire Images Concurrently` Code node for exactly **300.003 s** and was killed by n8n's task-runner
  timeout (`N8N_RUNNERS_TASK_TIMEOUT`, default **300 s**, internal-runner mode — confirmed by the
  `TaskBroker.handleTaskTimeout` stack and n8n's own error text). The thrown timeout hit the workflow's
  `errorWorkflow` and fired a **CRITICAL**, contradicting the non-blocking image contract (a failed image
  must be `success:false` + WARN, never CRITICAL; ADR-047 Block B / ADR-036). The text reply still posted
  (Image Resolver's `onError:continueRegularOutput`), but zero images generated and the operator was paged.
- **Why the Code node stays (no native rewrite).** n8n has **no native node that runs HTTP calls in
  parallel**: the HTTP Request node's "Batching" is a throttle (`Items per Batch` + `Batch Interval`),
  Split-in-Batches is a serial loop, and a node processes its items sequentially. True in-execution
  parallelism comes only from the Code-node `Promise.all` (re-confirmed against the node defs, 2026-06-16).
  A native fan-out would run images **serially** (sum-of-latencies, not max-of-wave) — slower for
  latency-heavy batches — so the fix hardens the existing Code node rather than replacing it.
- **C — raise the ceiling.** `N8N_RUNNERS_TASK_TIMEOUT: "900"` (15 min) on **both** `n8n-main` and
  `n8n-worker` (`n8n/docker-compose.yml`), sized to fit **2 full `gpt-image-2` waves** (~176 s/image,
  cap 5 = 10 images) incl. a fallback hop. GLOBAL (every Code-node task); the image batch is the only
  long-running Code node. Deployed `scp` + `docker compose up -d n8n-main n8n-worker` (recreate, not
  `restart`); verified `=900` in both running containers.
- **B — degrade gracefully below the ceiling.** `Fire Images Concurrently` now carries an internal
  **soft-deadline of 840 000 ms (840 s < 900 s)**: the bounded pool is `Promise.race`d against a deadline
  timer, workers stop pulling once past it, and any slot not completed is returned as `succeeded:false`
  with `error:'batch_soft_deadline'`. Returning *before* the runner's hard kill turns the timeout into a
  clean per-image failure (no throw → no CRITICAL) that feeds the existing `warnings[]` → `Has Warnings?`
  → WARN path; `Assemble Batch Output` emits a clear `image-batch/timeout-partial` reason code. The per-call
  HTTP timeout was raised **240 s → 300 s** (comfortable for a large high-effort image; ~1.7× the 176 s
  mean) and **clamped to the remaining budget** so no call starts that can't finish before the deadline;
  the fallback hop is skipped when <15 s remain.
- **Cost correctness (realizes Block 3's deferred one-liner).** Block 3 flagged that a hard-failed image
  still logged an `agent_runs` row at the per-image floor price. Graceful degrade makes whole-batch
  failure common, so this is now fixed: `Explode Results` applies the floor only when the image
  **succeeded** (`it.succeeded && it.floor != null`), so a failed/not-generated image bills **0**.
- **Verified (2026-06-16, isolation via `test-subworkflow.mjs`).** (A) Happy path — 1 image, normal
  deadline → `success:true`, real PNG, cost logged; proves the restructure (`Promise.race`/`setTimeout`,
  per-call clamp) doesn't break normal flow. (B) Forced timeout — temp soft-deadline 4 s, 2 images → both
  `success:false`, `image-batch/timeout-partial` warning, the node **returned (status success, no throw)**,
  **0 CRITICAL** in the alert channel; cost fix confirmed (`cost_pln 0`, was 0.77). Deadline reverted to
  840 000 and re-exported drift-clean. **Not force-tested:** the full orchestrator → resolver → Post Reply
  spine end-to-end (the downstream `warnings[]`→WARN and `[obraz niedostępny]` render is the pre-existing,
  unchanged path; the batch was verified to feed it the timeout warning). The 5 `log-model-run` WARNs seen
  during testing were a **test-data artifact** (a synthetic task id failed the `agent_runs` insert; 0 rows
  leaked, cleaned).

## Context

A single agent run can emit several `generate` image blocks (the drafting model's output-block
list; ADR-036 Block 11/12). Today `Image Resolver (v1)` produces them with a `Call Invoke Model`
node configured `mode: "each"` (`n8n/workflows/image-resolver.json`), which n8n runs **strictly
sequentially**: image 1 to completion, then image 2, on a single thread. n8n executes one workflow
run on one thread, the `executeWorkflow` node has **no parallel/batch/concurrency option**, and
fanning into side-by-side branches still runs serially. With `gpt-image-2` at ~176 s/image
(Wysoki/Krytycznie tiers), three images is ~9 minutes of wall-clock — poor UX and a real risk
against stage/HTTP timeouts. The gemini tiers (~5 s) are not the problem.

The only way to overlap the slow provider calls **inside one execution** is a Code node using
`Promise.all` over `this.helpers.httpRequest` (Node.js overlaps I/O-bound awaits). The alternative
— a queue scatter-gather across separate executions — is genuinely parallel too but needs a
rendezvous store, a poll/timeout loop, and partial-failure plumbing, and is capped at n8n worker
concurrency while competing with all other pipeline work. Per CLAUDE.md "default to the design that
ages well", the in-execution path was chosen for lower topology fragility; the scatter-gather's
extra moving parts were judged the larger long-run cost for this case.

Two constraints shaped the design:

1. **Auth.** The Code node must authenticate to LiteLLM, but in this n8n a Code node cannot read
   the `LiteLLM master key` credential (no credential helpers) and `$env` is globally blocked
   (`N8N_BLOCK_ENV_ACCESS_IN_NODE` — flipping it would expose every env var, including
   `N8N_ENCRYPTION_KEY`, to every Code node). n8n Variables (`$vars`) are a **licensed feature,
   unavailable on the self-hosted community edition**, so the key is read from **Supabase Vault**
   via a credentialed Postgres node (which *can* use credentials) and handed to the Code node.
2. **Seam preservation.** `Invoke Model (v1)` + `Call Model with Fallback (v1)` are the unified
   model-call seams (ADR-013/024/047). A parallel Code-node path cannot call them per image without
   re-serializing. So the HTTP call + per-image fallback are reimplemented in the batch — a
   deliberate divergence from the seam, which this ADR documents (CLAUDE.md divergence rule).

## Decision

1. **In-execution concurrency.** A new sub-workflow `Generate Images Parallel (v1)` takes all the
   run's `generate` blocks as one array and fires their LiteLLM `/v1/images/generations` calls
   **concurrently** via a Code node `Promise.all` over a **bounded promise pool**. Wall-clock ≈ the
   slowest single image instead of the sum. `Image Resolver (v1)`'s generate branch calls it **once**
   (replacing `Call Invoke Model` `mode: each`) and maps results back by `placeholder_id`.

2. **Concurrency cap.** A tunable `config.image_concurrency_cap` row (default **4**, migration 031)
   bounds simultaneous in-flight calls — a self-imposed guard for provider rate limits / box / cost,
   **independent of n8n worker concurrency** (the worker limit does not bound Promise.all inside one
   execution). The separate `config.image_count_ceiling=20` (migration 026) still bounds the TOTAL
   image count (runaway guard).

3. **Cost stays unified.** The batch reuses `Log Model Run` (`n8n/workflows/log-model-run.json`)
   unchanged, one `agent_runs` row per image, priced by the **served** model (header → token-math →
   `fallback_price_per_unit` floor). Only the HTTP call + fallback diverge from the seam, not cost.

4. **Single image-gen path (no shared helper).** The image-resolution logic (size
   validation/snap + gemini→gpt-image-2 shape-intent upgrade, ADR-045) is **ported inline** into
   the batch's resolve step. `Invoke Model`'s only image caller was the resolver, so once the
   resolver uses the batch, `Invoke Model`'s image branch is dead and is **deleted** (Block 5),
   with `Resolve Routing` simplified to text-only. The logic thus lives in exactly one place — by
   deletion, not by extracting a single-caller helper (CLAUDE.md: wait for a real second caller
   before unifying; rewiring the central all-traffic workflow is avoidable risk).

5. **Per-image fallback.** The batch reimplements the minimal one-tier-below fallback inline
   (matching `Call Model with Fallback (v1)`'s behaviour for the image leg): on a non-2xx or a
   2xx-with-empty `b64_json`, retry once with the next-lower-tier image model; a failure after that
   becomes a `warnings[]` entry (non-blocking, never a CRITICAL — image stays non-blocking per
   ADR-047 Block B). Top-tier (gpt-image-2) has no lower image tier, so its fallback is a no-op, as
   today. **Only the HTTP retry is inline** — the *step-down rule* (which tier is one below) is **not**
   re-derived in the batch: it reuses `Resolve Lower Tier (v1)` (the sole owner of the ordering),
   called **once** for the run's shared impact (so it does not re-serialize the parallel calls), and
   the lower tier's prices are read from the image-tier rows by the returned impact. Likewise every
   model name and price is DB-sourced (`model_routing`); the only literals in the resolve step are
   irreducible DB-down last-resorts (a gemini safety net when the routing read returns no image row,
   and gpt-image-2's upgrade prices when the tier read is empty).

6. **Auth via a dedicated, revocable, image-scoped LiteLLM key in Supabase Vault.** Enable LiteLLM
   **key management** (was off — `litellm-config.yaml` had only `general_settings.master_key`, no
   `database_url`) by reusing the `n8n-postgres` container via a separate `litellm` database
   (`DATABASE_URL=postgresql://n8n:<pw>@n8n-postgres:5432/litellm`, `LITELLM_SALT_KEY`,
   `STORE_MODEL_IN_DB=false`; docker-compose.yml). Mint a key scoped to the image models and store
   it in **Supabase Vault** (`vault.create_secret(..., 'litellm_image_key', ...)`). The batch reads
   it via a `SECURITY DEFINER` getter `public.get_litellm_image_key()` (mirrors the zip-purge
   function's `vault.decrypted_secrets` read, ADR-046/048) called from a **credentialed Postgres
   node**, then passes the value into the Promise.all Code node — Code nodes can't use credentials,
   but the Postgres node can. **n8n Variables (`$vars`) were rejected**: a licensed feature,
   unavailable on the self-hosted community edition (paying a recurring license to hold one secret
   fails the cost test). Vault is encrypted at rest and the project's established secret store, so
   it beats both `$vars` and the rejected master-key-in-plaintext option per CLAUDE.md "default to
   the design that ages well".

## Consequences

- **The batch becomes the sole image-gen path** (Block 5 deletes `Invoke Model`'s image branch),
  so there is no lasting duplication: image-resolution logic and the image HTTP/fallback live in
  one place. Cost stays unified via `Log Model Run`. The only divergence from the text seams
  (`Call Model with Fallback`) is the batch's inline minimal one-tier-below image fallback.
- **LiteLLM gains a DB.** Key/spend/budget tables now live in a `litellm` database in n8n-postgres.
  More surface (and spend logs can grow — revisit `disable_spend_logs` if needed). The redeploy is a
  hard cutover: the `litellm` DB must exist before `docker compose up -d litellm`, or LiteLLM fails
  to boot (all model calls down). Deploy per ADR-033 (`deploy-infra.bat` + `up -d`, never `restart`).
- **Secret posture.** The image key is encrypted at rest in Supabase Vault and exposed only through
  the `SECURITY DEFINER` getter; it's a dedicated, revocable, image-scoped key, and LiteLLM is
  loopback-only. In-flight it rides pruned n8n execution data. Rotate via `POST /key/delete` + mint +
  `vault.update_secret`; no workflow edit. The env-access block (`N8N_BLOCK_ENV_ACCESS_IN_NODE`)
  stays on — `$env` is never exposed to Code nodes.
- **Base64 images ride n8n execution data** concurrently (bounded by the cap). Execution pruning
  (docker-compose `EXECUTIONS_DATA_*`) already bounds this; the cap keeps peak memory modest; and Block 6's
  `mem_limit`/`NODE_OPTIONS` heap ceilings (above) make any pathological growth fail the worker's own
  execution rather than OOM the box. Measured worker peak on a 5-image concurrent batch: ~228 MiB.
- **Surgery on `Invoke Model`** (the central workflow) is only the **deletion** of its now-dead, unreachable
  image-OUTPUT branch (Block 5), done after the batch was proven the sole live image path (Block 4) — far lower
  risk than rewiring a live path. The text and multimodal-INPUT paths were regression-verified before/after.
  No shared helper was extracted (Block 2 was removed): the image logic ends in one place by deletion, not by
  sharing a single-caller sub-workflow (CLAUDE.md: wait for a real second caller before unifying).

## Date

2026-06-15
