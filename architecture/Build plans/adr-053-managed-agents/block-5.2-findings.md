# ADR-055 Block 5.2 — image MCP server: build + live-DoD findings

**Status: DONE 2026-06-18.** The self-hosted image MCP server is built and verified **in isolation**
(the four tier agents are **not** switched to it yet — that is Block 5.3). Proven live against the
production Anthropic Files API + our live n8n (`agents.haxe.ai`) by calling the MCP endpoint directly
with the bearer (probe `scripts/mcp-call.mjs`). All test artifacts cleaned up.

## What was built

- **Migration 036** (`supabase/migrations/036_agent_input_file_map.sql`):
  - `agent_input_file_map(file_id pk, url, mime, source_ref, created_at)` — a global, **session-context-free**
    map. **RLS enabled, no policy** (denies PostgREST anon/authenticated; the pipeline's direct Postgres role
    bypasses RLS — mirrors migration 007). Stricter than `agent_routing` (no RLS) because it holds signed URLs
    that can point at personal-data images.
  - 24h TTL prune: `prune_agent_input_file_map()` + `agent_input_file_map_prune_runs` audit log, hourly
    `pg_cron` (`prune-agent-input-file-map`). Synchronous DELETE → `deleted_count` is authoritative (unlike
    the async zip purge); `cron.job_run_details` also records firing.
  - `get_image_mcp_bearer()` — SECURITY DEFINER Vault getter (mirrors `get_anthropic_key()`), `service_role`
    only. The bearer token is **seeded in Vault** (`image_mcp_bearer_token`, generated server-side via
    `gen_random_bytes`); the getter is the rotation record + the source Block 5.3 mirrors into the Anthropic
    Vault. The n8n MCP trigger validates the token via the `Image MCP bearer (ADR-055)` credential
    (`httpBearerAuth`, id `mTlnNTCynGhQtYMO`) — the same value in both places.
  - `agent_runs.triggered_by += 'image_mcp'` (append-only; preserves 009's list + 023's `image_gen`).
- **`Upload Input Images (v1)`** (`2VkZN5UeqVk6MDLW`) now **upserts** `{file_id→url,mime,source_ref}` into
  `agent_input_file_map` after the upload. Additive + fail-soft: `Aggregate → Upsert File Map
  (onError=continueRegularOutput, alwaysOutputData) → Final Return` (re-reads Aggregate, single branch-free
  terminal); a write failure appends an `agent-input-file-map/write-failed` WARN to the returned warnings and
  **never blocks the upload**. Empty map → `jsonb_to_recordset('[]')` → 0-row no-op (the common case).
- **`Image MCP Tool Handler (v1)`** (`zxY41zZWRbXon2Eq`, sub-workflow) — the intermediate. `When Called`
  {prompt, reference_file_ids_json, count, aspect_ratio, size} → resolve `reference_file_ids` → rows from
  `agent_input_file_map` (`Resolve References`, fail-soft) → build `file_map_json` + `tool_input_json` →
  **call `Image Tool Handler (v1)` (`vpGswBj2kR2D85hl`) UNCHANGED** → shape `{status, file_ids[], message,
  count_*, warnings[]}`. Because the harness calls it directly (no Stage B caller), it **fires its own
  consolidated `Post Alert (v1)`** (`Merge Final → Classify Alert → Should Alert? → Post Alert/Merge Tail →
  Final Return`). Unresolved reference ids are warned by `Image Tool Handler` itself (it gets only the
  resolved rows as its `file_map`) — no duplicate logic.
- **`Haxe Image MCP (v1)`** (`c4vnNLb9usfHJWg3`, active) — the MCP server: an `@n8n/n8n-nodes-langchain.mcpTrigger`
  (typeVersion 2, path `haxe-image-gen`, `bearerAuth`) at **`https://agents.haxe.ai/mcp/haxe-image-gen`** (SSE),
  with one `@n8n/n8n-nodes-langchain.toolWorkflow` (v2.2) node named **`generate_image`** wired via an `ai_tool`
  connection, delegating to `Image MCP Tool Handler (v1)`.

## Reuse / cost (unchanged seams)

The image-gen+upload+cost core is **one shared path**: both the client-side custom-tool route (Block 4/5) and
the MCP route funnel through `Image Tool Handler (v1)` → `Generate Images Parallel (v1)` (`2keb6XVWq5PG0leK`).
**No second cost writer** — the batch's own `Log Model Run` (mode=each) writes one priced `agent_runs` row per
image. No MCP-specific cost field (Block 6 USD formula unchanged).

## Live DoD (all pass)

Direct MCP call with the bearer (`MCP_BEARER=… node scripts/mcp-call.mjs`):
- **Transport/auth/schema:** SSE `initialize` (serverInfo `MCP_Server_Trigger`) + `tools/list` advertises
  `generate_image` with `required:["prompt"]` only (others optional with defaults) + `tools/call`.
- **Generate:** plain prompt → an image **`file_id`** in **24 s** (well under the Block-5.1 200 s harness
  ceiling), `status:ok`.
- **Cost:** exactly **one priced `agent_runs` row** — `triggered_by=image_mcp`, `impact=Średni`,
  `model_used=vertex_ai/gemini-3-pro-image-preview`, `cost_pln≈0.49`.
- **Reference path:** `generate_image` with `reference_file_ids=[<uploaded file_id>]` resolved the id → its
  signed URL via `agent_input_file_map` (`requested_refs=1, resolved_refs=1`) and produced `used_reference:true`.
- **Fail-soft:** empty prompt → `status:failed` tool_result + an `image-tool/no-prompt` WARN, **no throw**.
- **Alerts:** the only WARNs in the window were the intentional empty-prompt test and the (now-fixed) cost-row
  bug below; the successful run fired none.

## Findings (non-obvious; cost a cycle each)

1. **`agent_runs.impact` rejects `__default__`.** The CHECK allows only `NULL` / `Niski` / `Średni` / `Wysoki`
   / `Krytycznie ważne` / `n/d …`. The MCP path has no session impact, so the first build passed `__default__`
   → the batch's `Log Model Run` **insert failed silently** (image still returned; a `log-model-run` WARN fired;
   **no cost row**). Fixed: the handler passes **`Średni`** (the lane's `__default__` tier, valid for both
   `agent_runs.impact` and image routing). **Consequence:** MCP image gens are **tier-fixed to `Średni`** (the
   gemini *pro* image model, ~0.49 PLN/image) — the agent cannot pass impact through the tool, and the harness
   passes no session context. If cost matters more than quality here, a future tweak could default to `Niski`
   (flash, ~0.14 PLN).
2. **MCP image cost rows are not task-attributable.** No session/correlation context reaches the tool (Block
   5.1), so `clickup_task_id` is null on these rows. Spend is still captured globally and is separable by
   `triggered_by='image_mcp'`. Accepted (inherent to the MCP design; ADR-055 §4).
3. **n8n `$fromAI` schema quirks (drove the tool-arg design):**
   - Every `$fromAI('k','desc','type')` is marked **required** unless given a **4th `defaultValue` arg** — that
     is how `count`/`aspect_ratio`/`size` were made optional.
   - A **`json`-typed** `$fromAI` is required **and** validates "non-empty object/array" even with a default →
     unusable for an optional array. `reference_file_ids` is therefore exposed as an **optional JSON-array
     *string*** (`'string'` type, default `''`); the handler `JSON.parse`s it (bad/empty → `[]`).
   - The MCP tool name comes from the **node name** (`generate_image`) on toolWorkflow v2.2; the tool
     description is the node's `description`.

## ⚠ Block-6 delivery gap (must resolve before MCP image delivery works)

Files-API uploads are `purpose=agent` → **not downloadable** (Block 0). On the client-side path the produced
`b64_json` is carried back through n8n; on the **MCP path the produced bytes are consumed inside our endpoint
and never return to n8n** — the harness/agent gets only the `file_id`s. So Block 6, given the agent's
block-array with produced `file_id`s, has **no carrier for the bytes** to deliver to ClickUp. **Block 6 must
add one** (e.g. the image MCP handler also persists produced bytes to Supabase Storage / an output
`agent_output_file_map(file_id→signed_url)`, resolved by the output adapter), or amend ADR-055. Out of scope
for 5.2 (whose contract returns `file_id`s only), but a hard prerequisite for end-to-end MCP image delivery.

## Silent-failure modes covered

- Generation/upload failure → `failed`/`partial` tool_result + WARN, never a throw (reused `Image Tool
  Handler` fail-soft).
- Image lane down / key missing → the batch's own CRITICAL (its `errorWorkflow`); the MCP health
  dead-man's-switch is **Block 5.3**.
- Unresolved `reference_file_id` → generate without it + WARN (emitted by `Image Tool Handler`).
- `agent_input_file_map` write failing in `Upload Input Images` → returned WARN, upload still succeeds (a
  failed map write degrades only *later* reference resolution, so it is surfaced).
- **Newly surfaced + fixed:** cost-row insert failing on an invalid `impact` → was a silent
  cost-observability loss; fixed by passing a valid tier, and the existing `log-model-run` WARN already
  catches any future recurrence.

## Net effect on the plan

- 5.2 done; **5.3 next** (switch the 4 agents to the `mcp_servers` entry with `permission_policy:always_allow`,
  mirror the bearer into the Anthropic Vault, add the image-MCP health dead-man's-switch, keep the client-side
  loop for ADR-054's Google tool).
- **Block 6 inherits the delivery-carrier requirement** (Open-risks + Block-6 notes in the master plan).
