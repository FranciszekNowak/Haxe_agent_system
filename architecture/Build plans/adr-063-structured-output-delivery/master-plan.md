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
| 1 | Define `deliver_output` tool contract (one shared block schema, incl. doc block) | pending |
| 2 | Managed lane: register tool in `Build System`; `Poll Round` terminal detection; `Build Final Output` emits structured `output_blocks` | pending |
| 3 | `Render Agent Output → Parse Blocks`: consume structured blocks; delete `parseBlockArray()`; loud WARN only if `deliver_output` missing | pending |
| 4 | Bare-lane parity: `Invoke Model`/`Execute LLM Call` tool + `tool_choice`; `Image Resolver → Resolve & Explode Blocks` delete parse twin | pending |
| 5 | Persona contract text (ClickUp SSOT) → "call deliver_output"; write back current.md, finalize ADR-063, supersede spec §1/§3.1 + ADR-053 #4 | pending |

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
