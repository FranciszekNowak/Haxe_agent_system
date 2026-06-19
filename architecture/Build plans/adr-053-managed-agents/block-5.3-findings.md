# ADR-055 Block 5.3 — switch agents to the image MCP server: build + live-DoD findings

**Status: DONE 2026-06-19.** The four tier agents now generate images **via the self-hosted MCP server**
(`Haxe Image MCP (v1)`, ADR-055 Block 5.2) instead of the client-side `generate_image` custom tool. Proven
live against the production Anthropic Managed Agents API + our live n8n (`agents.haxe.ai`). The client-side
image path (Block 4/5) is retained as the **dormant rollback**. All test artifacts cleaned up.

## The headline finding — auth is a per-session Vault, NOT a field on `mcp_servers`

Block 5.1 left an open item: the auth-token field on the agent's `mcp_servers` entry, guessed to be
`authorization_token` (mirroring the **Messages-API** MCP connector). **That guess was wrong for Managed
Agents.** Confirmed against the live API:

- The agent's `mcp_servers` entry carries **`{type:"url", name, url}` only — no auth field.**
- Bearer credentials live in an **Anthropic Vault** (`vlt_…`) as a credential **keyed by the MCP server URL**,
  and the vault is attached **at session-create time via `vault_ids:[…]`** — not on the agent. The harness
  injects the token at egress when the agent connects to that URL.
- For our identity-neutral image bearer the credential type is **`static_bearer`** (not OAuth):
  `{ "display_name": "…", "auth": { "type": "static_bearer", "mcp_server_url": "<MCP url>", "token": "<bearer>" } }`.
  The `token` is write-only (never echoed back).

Verified raw-API shapes (the SDK examples differ — `vaults.create` takes `display_name`, not `name`):
- **Vault create:** `POST /v1/vaults { "display_name": "…" }` → `vlt_…` (an empty body 400s "display_name: Field required"; `name` 400s "unknown field").
- **Credential create:** `POST /v1/vaults/{id}/credentials` with the `static_bearer` body above → `vcrd_…`.
- **Session create:** `POST /v1/sessions { agent, environment_id, vault_ids:[vlt] }` → the bearer reaches our
  bearer-protected trigger; `generate_image` runs **in-harness** as `agent.mcp_tool_use` (no client pause).

This matches ADR-055 §5 ("stored in the Anthropic Vault and attached per session"); only the 5.1 hand-off line
("auth-token field on the `mcp_servers` entry") was imprecise. The vault plumbing is also the down-payment
ADR-054 needs (per-user ClickUp MCP credentials use the same `vault_ids` mechanism).

## What was built

- **Persistent Anthropic Vault `vlt_011CcCBgjtCiZewXB8c6Ty47`** + a `static_bearer` credential keyed by
  `https://agents.haxe.ai/mcp/haxe-image-gen`, token = Supabase Vault `image_mcp_bearer_token`
  (`get_image_mcp_bearer()`, migration 036). The vault id is stored in **`config.image_mcp_vault_id`**
  (mirrors how `config.managed_agent_environment_id` holds the create-once environment). No migration —
  `config` is an existing key/value table; the row was upserted directly.
- **`Sync Agent Definitions (v1)`** (`4K1w78hJ7JhsUwdN`) — `Build System` Code node:
  - dropped the `generate_image` **custom tool**;
  - `tools = [{type:'agent_toolset_20260401'}, {type:'mcp_toolset', mcp_server_name:'haxe_image',
    default_config:{enabled:true, permission_policy:{type:'always_allow'}}}]` (5.1: `always_allow` is
    mandatory — the default `always_ask` would pause the harness on every call, re-introducing a round-trip);
  - emits `mcp_servers = [{type:'url', url:'https://agents.haxe.ai/mcp/haxe-image-gen', name:'haxe_image'}]`;
  - **`CONV` bumped 1→2** — the sync's idempotency keys on `rules_sha256 + conventions_version`, and the CU
    rules text is unchanged, so without the bump every agent would **skip** (no re-version). `Upsert Agent`'s
    body now includes `mcp_servers`. Ran with `force:true`; all four agents re-versioned and **verified live**
    (read back: tools = agent_toolset + mcp_toolset(`always_allow`), mcp_servers = haxe_image, no custom tool).
- **`Execute Agent Session (v1)`** (`Rtb1cZbmUqmfGD98`) — three surgical edits: `Resolve Agent` also selects
  `config.image_mcp_vault_id`; `Build Setup` carries it; `Create Session` body becomes
  `Object.assign({agent, environment_id}, vault_id ? {vault_ids:[vault_id]} : {})` — **conditional/fail-soft**
  (a missing config key sends no `vault_ids`; the MCP then 403s and surfaces as the agent's tool error + the
  health monitor, not a silent stall). No structural/loop change: image is now `agent.mcp_tool_use`, which the
  `Poll Round` pending-tool logic ignores (it only services `agent.custom_tool_use`), so the `generate_image`
  custom-tool branch is **dormant for image** but **retained for ADR-054's Google DWD tool**.
- **`Image MCP Health Monitor (v1)`** (`Er1JlLYAQLkIk7yB`, active, every 6h) — mirrors
  `Managed Agents Auth Monitor (v1)`. Reads the bearer via `get_image_mcp_bearer()`; if unseeded → CRITICAL
  ("seed the secret"); else POSTs an MCP `initialize` to the endpoint with the bearer. Probe semantics
  (verified): authed `initialize` → **200 `text/event-stream`, closes in ~18 ms**; bad/missing bearer → 403;
  inactive/wrong path → 404. So 2xx = healthy (silent), any non-2xx/network error → CRITICAL via `Post Alert
  (v1)` with the HTTP error + a bearer-mismatch/endpoint checklist.

## Live DoD (all pass)

- **Isolation gate** (throwaway agent + vault + session against the real MCP server, `scripts/ma-spike-vault.py`):
  vault + `static_bearer` cred → agent (`mcp_servers` + `always_allow`) → session with `vault_ids` → drove a
  generation → `agent.mcp_tool_use`/`_result` (no `agent.custom_tool_use`, no pause), `status:ok` + `file_id`
  in **48 s**. All four throwaway resources torn down (session deleted, agent archived, credential + vault deleted).
- **Production Stage B** (`Execute Agent Session (v1)` via `test-subworkflow.mjs`, image task, `impact=Niski`):
  `status:completed`, **`outcome:done`** (the custom-tool branch `Is generate_image?` / `Call Image Tool Handler`
  **did not fire**), `model claude-haiku-4-5`, 45 s, `warnings:[]`; `output_message` is the block-array embedding
  the produced **`file_id`**. Exactly **one priced `image_mcp` `agent_runs` row** written.
- **Alert channel:** the only WARN was the existing ADR-051/052 image-batch degradation (the batch fell back one
  model level, `gemini-3-pro` → `gemini-2.5-flash-image`, ~0.14 PLN) — the reliability pattern working, **not** a
  5.3 regression (intermittent provider availability; the spike used the pro model fine). No CRITICAL.
- **Health check trips:** repointing the probe at a deliberately-down path (`…/haxe-image-gen-DOWNTEST`) → 404 →
  CRITICAL fired via `Post Alert (v1)` with the 404 + remediation detail; URL reverted; healthy re-probe green.
  (Test-induced CRITICAL — mirrors how Block 1 verified its missing-key path.)

Cleanup: test `agent_runs` rows + produced Files-API images + test session deleted.

## Block-6 delivery gap (carried forward, unchanged)

`files`/`file_ids` come back **empty** from `Execute Agent Session (v1)` on the MCP path — the produced bytes
are consumed inside our endpoint and only the `file_id` returns (embedded in the agent's block-array). Files-API
uploads are `purpose=agent` → not downloadable. **Block 6 must add a bytes carrier** (e.g. the image MCP handler
also persists each produced image to Supabase Storage / an output `file_id→signed_url` map) before MCP-produced
images can be delivered to ClickUp. Safe now (managed lane dormant until Block 8/9); a hard prerequisite before
cutover. **Do not make the managed lane the default before Block 6 lands the carrier.**

## Silent-failure modes covered

- **Down/misauthed image MCP failing every image** → the new `Image MCP Health Monitor (v1)` dead-man's-switch
  (CRITICAL within ~6h; trip verified live).
- **Agents updated but the MCP entry misregistered (partial sync)** → `Sync Agent Definitions (v1)`'s existing
  per-tier CRITICAL + `Verify Synced` completeness gate; plus the live image test as the acceptance check.
- **Bearer mismatch across the three copies** (Supabase Vault / n8n credential / Anthropic Vault) → the health
  monitor's 403 path fires CRITICAL with the rotation checklist.
- **`config.image_mcp_vault_id` missing** → `Create Session` omits `vault_ids` (fail-soft) → MCP 403 → the agent
  surfaces the tool error and the health monitor alerts; not a silent stall.
- **Image quietly falling back to text-only** → the agent surfaces the MCP tool error; the MCP handler's own
  consolidated `Post Alert (v1)` (Block 5.2) WARNs on any generation degradation.

## Net effect on the plan

- 5.3 done; **Block 6 next** (output adapter + session cost into `Log Model Run`) — and Block 6 **must** resolve
  the image-bytes delivery carrier (above) before the managed lane can deliver images.
- Rollback documented: re-register the `generate_image` custom tool in `Build System` (drop the
  `mcp_servers`/`mcp_toolset`, bump `CONV`) → the Block-4/5 client-side path re-activates.
