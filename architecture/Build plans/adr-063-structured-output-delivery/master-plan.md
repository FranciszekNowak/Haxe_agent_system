# ADR-063 — Structured tool-call output delivery (master plan)

Fixes the recurring "image/document comment downgrades to pure text" defect at its root.
Every block starts by reading THIS file in full.

## Problem / root cause (confirmed against the live system)

The downgrade is **not** in `Post Reply (v1)`. It is in **`Render Agent Output (v1)` → `Parse
Blocks`** (managed lane) and its twin in `Image Resolver (v1)` (bare lane). The drafting model is
required to return its entire answer as a single fenced JSON block-array; a custom
`parseBlockArray()` hand-parses it, and on **any** JSON defect falls back to one plain-text block,
silently dropping every image/doc block. The alert that actually fires is
`agent-orchestrator/render → output-adapter/parse-fallback` (repeatedly on real tasks `869dux9ne`,
`869dw6wtx`, `869dp7ww2`) — upstream of Post Reply, which is why there are **zero `post-reply/*`
alerts in 30 days**. "Complex/realistic" content breaks the parser more (Polish typographic quotes,
tables, multi-line markdown, quote-before-comma, prose preamble). Patched 4× (ADR-036, ADR-053 ×2,
ADR-059) — the fragile contract itself is the defect.

Ruled out on evidence: base64 corruption across workflow boundaries (1.3–1.6 MB manifests delivered
fine; n8n v2 has no payload ceiling; upload-failed WARN never fired).

## Decision

Replace the free-text JSON contract with a **`deliver_output` custom tool** whose input schema *is*
the block array. The Anthropic API returns tool inputs as validated parsed JSON, eliminating the
defect class. **Delete** `parseBlockArray()` and its twin — do not extend them. Apply to **both
lanes** (user-chosen). Record as **ADR-063**, superseding the free-text protocol of ADR-053 #4 /
multimodal spec §1.

## Block status

| Block | Scope | Status |
|-------|-------|--------|
| 0 | Verify assumptions (tool registration, input round-trip, bare-lane feasibility) | ✅ DONE — GO (see block-0-findings.md) |
| 1 | Define `deliver_output` tool contract (one shared block schema, incl. doc block) | ✅ DONE — ADR-063 (Proposed) defines the contract; canonical input_schema + per-type/per-lane field table + doc-block resolution rules |
| 2 | Managed lane: register tool in `Build System`; `Poll Round` terminal detection; `Build Final Output` emits structured `output_blocks` | ✅ DONE — registered live (Anthropic agent def v18 returns `deliver_output`); forced session exec 4425 → `outcome=delivered`, `output_blocks` captured clean; dormant (contract unchanged until Block 5) |
| 3 | `Render Agent Output → Parse Blocks`: consume structured blocks; delete `parseBlockArray()`; loud WARN only if `deliver_output` missing | ✅ DONE — repo-built (not yet deployed; deploys with Block 5). `Parse Blocks` consumes `output_blocks_json`/`delivered_via_tool`; `parseBlockArray()` + parse-fallback/preamble/quote-repair deleted; only fallback = `output-adapter/no-deliver-output` WARN + text-render of `output_message`. Orchestrator `Call Render Agent Output` now passes `output_blocks_json` (stringified) + `delivered_via_tool`. Doc/embed/image-fetch/mdToOps assembly unchanged. Unit-verified (4 cases incl. Polish typographic quote); `test-image-delivery.mjs --text` green (Post Reply boundary intact); 2-image variant fails pre-existing/upstream in live Gemini image-gen (empty b64), unrelated to Block 3 (nothing deployed). |
| 4 | Bare-lane parity: `Invoke Model`/`Execute LLM Call` tool + `tool_choice`; `Image Resolver → Resolve & Explode Blocks` delete parse twin | ✅ DONE — repo-built (not deployed; deploys with Block 5). `Invoke Model` forces `deliver_output` (OpenAI `tools`+`tool_choice` on primary/fallback/retry bodies), `Parse Response` captures `message.tool_calls[].function.arguments` → `output_blocks_json`+`delivered_via_tool`; `Execute LLM Call`'s tolerant `Parse Output Blocks` node DELETED (Invoke Model emits structured blocks directly); `Image Resolver → Resolve & Explode Blocks` consumes structured blocks, `parseBlockArray` twin DELETED. Unit-verified (14 cases incl. Polish typographic quote + no-deliver-output fallback). **Live-probed the forced-tool-call round-trip on LiteLLM:** `haxe-gemini-flash` → HTTP 200, clean `deliver_output` call, `arguments` valid JSON, typographic-quote block intact. **Infra finding (separate, pre-existing):** the bare lane's upstream `ANTHROPIC_API_KEY` in the VPS `.env` is stale — all `haxe-*-direct` Claude models 401 (`invalid x-api-key`); dormant lane masks it; managed lane unaffected (separate Agent-API creds). Must be refreshed before any bare-lane go-live. |
| 5 | Persona contract text (ClickUp SSOT) → "call deliver_output"; write back current.md, finalize ADR-063, supersede spec §1/§3.1 + ADR-053 #4 | pending |

## Key facts carried forward (from Block 4)

- **Bare lane is OpenAI-shaped, not the Agent API.** The bare drafting call goes through LiteLLM
  `/v1/chat/completions`, so the tool is declared in **OpenAI function format**
  (`{type:'function', function:{name, description, parameters}}`) and forced with
  `tool_choice:{type:'function', function:{name:'deliver_output'}}`. `function.parameters` is the **canonical
  ADR-063 input_schema verbatim** (KEEP IN SYNC with the managed `custom` tool in `sync-agent-definitions.json
  → Build System`; one schema, both lanes). The block array comes back as
  `message.tool_calls[0].function.arguments` — a **provider-serialized JSON string** parsed with **one
  `JSON.parse`** (still machine-serialized, not model-hand-written prose, so the defect class is gone).
- **Where the tool/capture live:** `Invoke Model (v1)` — `Resolve Routing` emits `deliver_output_tool` +
  `tool_choice`; `Call Model Text`'s `request_body` and the `Retry Text-Only` safety-net `jsonBody` both add
  `tools`+`tool_choice` (the shared fallback seam `Call Model with Fallback (v1)` only swaps `model`, so the
  tool survives the fallback automatically); `Parse Response` captures the call → `output_blocks` +
  `delivered_via_tool`, flowed through `Normalize Model Result` → `Shape Output` as `output_blocks_json`
  (stringified) + `delivered_via_tool`.
- **`Execute LLM Call (v1)` lost a node:** `Parse Output Blocks` (the tolerant free-text parser) is **deleted**;
  `Call Invoke Model` wires straight to `Call Image Resolver`, passing `output_blocks_json` +
  `delivered_via_tool` + `output_message` (= Invoke Model `completion`, the no-tool fallback text). Now 9 nodes.
- **`Image Resolver (v1)` → `Resolve & Explode Blocks`** deletes `parseBlockArray` and consumes the structured
  blocks (mirrors `Render Agent Output → Parse Blocks`): two new `When Called` inputs `delivered_via_tool` +
  `output_message`; the only fallback is `!delivered_via_tool && blocks.length===0` → one text block from
  `output_message` + a loud `multimodal/no-deliver-output` WARN. The explode/route/ceiling/embed/generate logic
  downstream is unchanged (bare-lane `generate` blocks still carry `prompt`/`aspect`/`size`/`reference_refs`).
- **NOT deployed (deploys with Blocks 3/5).** The bare lane is dormant in production (`agent_lane=managed`), so
  deploying it alone would not regress live traffic — but it is bundled with the Block 5 go-live for one cut-over.
  `invoke-model.json`, `execute-llm-call.json`, `image-resolver.json` are repo-ahead-of-live (drift expected).
- **⚠ Bare-lane blocker for go-live:** the VPS `.env` `ANTHROPIC_API_KEY` (shared by all `haxe-*-direct`
  LiteLLM models) returns Anthropic `invalid x-api-key` (401). The forced-tool-call mechanism is proven
  (Gemini 200), but no Claude-direct bare run can complete until the key is refreshed. Not a Block-4 defect;
  flagged to the operator (don't auto-edit `.env`).

## Key facts carried forward (from Block 3)

- **`Render Agent Output (v1)` → `Parse Blocks` now consumes structured blocks.** New `When Called` inputs:
  `output_blocks_json` (the session's `output_blocks` array, stringified by the orchestrator) and
  `delivered_via_tool`. Logic: parse `output_blocks_json`; if `delivered_via_tool` is true **or** the array
  is non-empty, use it as-is; otherwise (agent never called `deliver_output`) wrap `output_message` as one
  `text` block and fire **one** loud WARN `output-adapter/no-deliver-output`. `parseBlockArray()` and all its
  repair paths (fence strip, `preamble-stripped`, schema-aware quote/control-char repair, `parse-fallback`)
  are **deleted**. The image-fetch / `mdToOps` / `{type:image_ref}` / `embed_input` / `embed-ref-not-found`
  assembly downstream is **unchanged**; doc blocks are still skipped here (office docs flow orchestrator →
  Post Reply via `doc_files`, never through this adapter).
- **Orchestrator wiring:** `Call Render Agent Output` now also maps
  `output_blocks_json = JSON.stringify($('Call Execute Agent Session').first().json.output_blocks || [])`
  and `delivered_via_tool = …delivered_via_tool || false`. Arrays cross the workflow boundary as a JSON
  string (repo `*_json` convention); the Parse Blocks code also tolerates a raw array or a `{blocks:[…]}`
  wrapper defensively.
- **NOT deployed live (deliberate).** Deploying Block 3 alone would regress production: with Block 5's persona
  flip not yet done, live managed runs still emit free-text in `output_message` with `delivered_via_tool=false`
  / empty `output_blocks`, so Parse Blocks would dump the raw fenced-JSON string as plain text + WARN on every
  run. Blocks 3/4/5 deploy **together** at the Block 5 go-live. `render-agent-output.json` and
  `agent-orchestrator.json` are therefore repo-ahead-of-live (`check-workflow-drift.mjs` will show this — expected).
- **Bare-lane parity (Block 4) mirrors this:** `Image Resolver (v1)` → `Resolve & Explode Blocks` deletes its
  `parseBlockArray` twin the same way; Block 4 also adds the tool + forced `tool_choice` to the bare completion.

## Key facts carried forward (from Block 2)

- The managed session output (`Build Final Output` → `Final Return`) now carries **`output_blocks`**
  (parsed array, the agent's `deliver_output` blocks) and **`delivered_via_tool`** (bool), alongside the
  legacy `output_message`. When `delivered_via_tool` is true, **`output_message` is empty** (the text
  lives in the blocks). Block 3 (`Render Agent Output → Parse Blocks`) must consume `output_blocks` when
  `delivered_via_tool`/non-empty, and only fall back to `output_message` (loud WARN) when the agent did
  NOT call `deliver_output`.
- New terminal outcome value `'delivered'` in `Poll Round` (sits beside done/deadline/terminated/
  max_rounds/poll_error). It maps to `status='completed'` in `Build Final Output`. Routing unchanged:
  `Has Pending Tool?` is TRUE only for `outcome==='pending_tool'`, so `'delivered'` falls through to the
  terminal `Build Final Output` automatically.
- **Cut-over safety:** the tool is registered but DORMANT — the `Build System` contract text still
  mandates the free-text JSON array and the tool description is deliberately non-directive, so the agent
  does not call `deliver_output` in production yet. The contract flip is Block 5; Block 3 (render consumes
  `output_blocks`) lands first so the channel is never half-cut-over.
- **Left idle, by design:** a `deliver_output` terminal leaves the Anthropic session idle with the tool
  call un-acked (no `user.custom_tool_result`). Kept the terminal path branch-free per CLAUDE.md; idle
  sessions time out on their own. Optional future enhancement: post an ack on a side branch.
- Verified via `test-subworkflow.mjs Rtb1cZbmUqmfGD98` (forced deliver_output user_message) → exec 4425;
  agent def re-pushed via sync exec 4423 (CONV 12→13, `force:true`). Test `agent_runs` row + temp inputs
  cleaned up.

## Key facts carried forward (from Block 1)

- Canonical `deliver_output` `input_schema` lives in **ADR-063 § "Canonical input_schema"** — Block 2
  copies it verbatim into `sync-agent-definitions.json → Build System` `tools[]` (and Block 4 into the
  bare lane). Top-level is `{ blocks: [...] }`; item `required:["type"]` only (per-type/per-lane fields
  documented in the ADR's field table, not as item-level `required`).
- Block types: `text` (`md`), `image` (`mode:generate|embed_input`; managed-generate carries `ref`=
  generate_image file_id, bare-generate carries `prompt`), `doc` (`filename` — agent never supplies a
  file_id). Doc resolution (Block 3): match `filename` → authoritative `doc_files[]`; append
  unreferenced docs; WARN `output-adapter/doc-ref-not-found` if a doc block names a non-produced file.

## Key facts carried forward (from Block 0)

- Custom tools declared in `sync-agent-definitions.json → Build System` `tools[]`, pushed via
  `POST /v1/agents`. Mirror `extract_clickup_task`; bump `CONV` to force re-sync.
- `Poll Round` captures tool input as native object: `pending_tool_input_json =
  JSON.stringify(picked.input)` — proven in prod (execs 4011, 3994, 3914, 3715, 3347).
- `deliver_output` becomes a **terminal** outcome (not service+recurse). Capture input → `output_blocks`.
- Live lane is `config.agent_lane = 'managed'`. Bare lane dormant fallback (heavier: LiteLLM +
  Bedrock tier) — Block 4, non-gating.
- IDs: Execute Agent Session `Rtb1cZbmUqmfGD98`; Invoke Model `XcOIVdZnVCCWNPeb`; Execute LLM Call
  `9qdJA4xnAGbxqkt9`; Post Alert `YSCdHlmdf3p9XEUx`.

## Verification (DoD, end-to-end) — per the approved plan

1. Trigger full ClickUp flow on a realistic image+document task; confirm inline image + doc attach.
2. `inspect-execution.mjs <execId>`: manifest has entries, `rendered_delta` has `image_ref`/`attachment`
   ops, and no parse-fallback path exists.
3. `alerts-since.mjs <min> --source render`: `output-adapter/parse-fallback` gone; re-run historical
   offender shapes (typographic quote before comma, prose preamble, multi-line markdown) — no downgrade.
4. `test-image-delivery.mjs` (2-image + `--text`) green.
5. Clean up `agent_runs` test rows + disposable ClickUp tasks/attachments.

Full prose plan: `C:\Users\fn\.claude\plans\sunny-riding-moore.md` (approved 2026-06-27).
