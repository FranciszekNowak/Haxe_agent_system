# ADR-051: Parallel image generation

**Status:** Proposed (build in progress — master plan `parallel image generation`). Block 1 done +
verified: LiteLLM key management enabled (65 key-store tables, liveliness 200), image-scoped key in
Vault, `get_litellm_image_key()` getter live. **Auth spike PASS (2026-06-15):** the pipeline's
Postgres node (role `postgres`) reads the getter, and a Code-node `Promise.all` fired 2 concurrent
authenticated `gemini-2.5-flash-image` calls in 6.25s (≈ one call, not ~12s sequential), both
200 + b64.

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
   today.

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
  (docker-compose `EXECUTIONS_DATA_*`) already bounds this; the cap keeps peak memory modest.
- **Surgery on `Invoke Model`** (the central workflow) to call the extracted helper is regression-
  verified in isolation (Block 2) before the batch depends on it.

## Date

2026-06-15
