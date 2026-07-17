# ADR-072 Block 0 — Assumption verification (findings)

Date: 2026-07-17. Verdict: **GO on the flat-scalar refactor** (not the one-line `strict` shortcut).

## A1 (decisive) — Does `strict: true` / a typed array now give a server-side guarantee that would make the refactor unnecessary?

**No.** Closed against the authoritative Anthropic tool-use reference (claude-api skill) + the prior empirical finding in ADR-071.

- **Strict tool use is a real Messages-API guarantee** — `strict: true` on a tool definition "guarantees `tool_use.input` validates exactly against the schema." But it comes with two hard constraints that the current `deliver_output` schema violates:
  1. Strict **requires** `additionalProperties: false` and all properties `required`. ADR-063's block-item schema is deliberately **polymorphic** — only `type` is required at the item level; `md`/`ref`/`mode`/`filename`/… are optional per block-type and per lane. Making it strict would force every field required (or none), which the multi-type block design cannot satisfy.
  2. The docs explicitly list **"complex array constraints" as unsupported** under strict. The nested `blocks` array is exactly that — so even the `minItems`-style guarantee ADR-071 wanted is out, and type-level array enforcement on a nested polymorphic array is not a documented behavior.
- **Managed-Agents surface**: ADR-071 already empirically established that the Managed-Agents session API treats `input_schema` as generation **guidance**, not server-side enforcement (the live path is the session-waiter driving a session, not a Messages call). The skill's strict guarantee is documented for the Messages API and does not contradict that.
- **Conclusion**: there is no clean one-line escape. The refactor stands. **Bonus**: the flat schema the refactor introduces (scalar `markdown` + flat-scalar `attach_*`) is exactly the shape strict *can* validate exactly (simple objects, all-required scalars, `additionalProperties:false`, no arrays) — so on the bare lane / any Messages-API path, `strict: true` becomes a free belt-and-suspenders, not a substitute for the shape change.
- A forced live "make the model stringify and observe rejection" probe is not reliably reproducible (the failure is nondeterministic per generation) and would require the Anthropic key; the documented behavior + ADR-071's prior empirical result are the sound basis. A live re-test remains available before Block 2 if the operator wants extra assurance.

## A2 — Does the waiter service sequential `attach_*` then stop on `deliver_output`?

**Waiter mechanics: confirmed by code.** `runPollLoop`/`runSseLoop` (services/session-waiter/app.mjs) already:
- Detect a pending `deliver_output` as the terminal signal (`analysis.pending.find(e => e.name === 'deliver_output')`, app.mjs:577).
- Service **any other** pending custom tool generically — `const tool = analysis.pending[0]; serviceToolSafe(...); postToolResult(...); continue;` (app.mjs:590–596) — the exact path `generate_image` rides today.
So `attach_*` calls flow through the existing non-terminal servicing loop unchanged; the only new code is a local short-circuit in `serviceToolSafe`/`serviceClientTool` that acks `attach_*` without bridging to n8n. The Anthropic managed-agents model matches this: the session goes idle per `agent.custom_tool_use`, you reply `user.custom_tool_result`, repeat.
**Agent-behavior half** (that the model actually emits `attach_*` then `deliver_output` in sequence) can only be exercised once the tools are registered — validated at Block 2's live run.

## A3 — Does `Render Agent Output → Parse Blocks` consume the assembled shape with zero change?

**Confirmed by static analysis of the deployed node.** `Parse Blocks` (n8n/workflows/render-agent-output.json) reads `output_blocks_json` as the block array and, per block: `order = b.order ?? i+1`; text → `{kind:'text', order, md: b.md ?? b.text}`; image with `ref` starting `file_` → generated-image placeholder; else → embed against `input_image_refs_json` by `source_ref`/`ref`; **doc blocks skipped** (docs flow orchestrator→Post Reply). This is exactly the shape `assembleOutputBlocks` will emit from `deliver_output.markdown` + the `attach_*` calls, with `order` preserved. The renderer already consumes this identical shape for today's `deliver_output` blocks in production (ADR-063 runs), so **zero renderer change**. A crafted interleaved `test-subworkflow.mjs` render run is folded into Block 1's unit tests + Block 2's live DoD rather than repeated here.

## Housekeeping — uncommitted `app.mjs` sanitizer

The working tree carries an uncommitted ADR-071 amendment (`sanitizeStrayValueQuotes` state machine + `MALFORMED_DELIVER_RETRY_MSG` + `parseDeliverBlocks`/`assessDelivery` rework). It is **superseded** by this refactor (the flat schema removes the stringified-array failure class entirely). Decision for the operator at Block 1 start: whether to (a) keep it as the live mitigation until Block 5 deletes it — but note it is NOT currently deployed (deployed/committed = `jsonrepair` only, commit 99eb933), so it provides no live protection as-is — or (b) `git stash`/discard it now, since Block 1 rebuilds this exact code path. Recommended: **discard/stash before Block 1** (it is not deployed, and Block 1 rewrites `parseDeliverBlocks`/`assessDelivery` wholesale). Left for the operator to confirm — not acted on in Block 0.
