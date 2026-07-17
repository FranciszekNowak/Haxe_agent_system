# ADR-072 — Flat-scalar `deliver_output` delivery (master plan)

Kills the stringified-`blocks` misescape at its root by removing every nested container from the
`deliver_output` tool input. **Every block starts by reading THIS file in full.**

## Problem / root cause (confirmed against the live system)

Managed agents submit their final answer by **calling** `deliver_output` with a nested `blocks` array
(ADR-063). ADR-063 correctly killed the older "LLM hand-writes fenced JSON, we hand-parse it" protocol by
relying on the Anthropic guarantee that **tool inputs arrive as valid parsed JSON**. The defect returned
**one layer inside the tool input**: Sonnet intermittently serializes the `blocks` **array** into a JSON
**string** (`{"blocks":"[ … ]"}`) and hand-writes the inner JSON — including escaping — getting it wrong on
Polish prose (unescaped `"` inside `„…"`). The API guarantee only covers the **outer** object; a
stringified array is a valid string *value*, so we are back to hand-parsing model-authored JSON with
embedded prose — exactly the fragility ADR-063 set out to remove.

The response so far has been a heuristic treadmill on the symptom: ADR-063 amendment (coerce string→array),
ADR-071 (`jsonrepair`), and an **uncommitted** `sanitizeStrayValueQuotes` state machine in
`services/session-waiter/app.mjs`. It still fails live: task **869bwejqz** recently ran ~214 s of real
work, delivery came back empty/unrecoverable, the one-shot retry fired and failed, and a **CRITICAL
`managed-agents/non-delivery`** notice was published to the user instead of the answer — precisely what
ADR-071 predicted ("re-asking just makes the model re-serialize the same broken string").

**Root cause (one sentence):** we transport the entire free-form Polish answer inside the *arguments* of
one tool call as a **nested array**, and the moment the model stringifies that container we lose the API's
escaping guarantee.

## Decision

**Fix the shape, not the parser.** Remove every nested container from the tool input so there is nothing to
stringify — the API's per-string escaping then covers all prose and the whole defect class becomes
structurally impossible. Each block is delivered by its **own flat-scalar tool call**; a deterministic
function in the session-waiter merges the calls (from the durable event log) in `order` into the block
array the renderer already consumes. This continues ADR-063's correct thesis and **deletes** the repair
machinery rather than growing it. Recorded as **ADR-072**, superseding ADR-063's array schema and retiring
ADR-071's repair machinery.

Operator decisions (2026-07-17):
- **Interleaving is preserved** via flat *segment* tools, not sacrificed. The common text-only case stays a
  single `deliver_output(markdown="…")` call; interleaving is opt-in via `attach_text` segments + `order`.
- **No Haiku / narration normalizer.** Rely on the structural fix + the one-shot retry + the already-shipped
  outcome-aware incomplete notice (ADR-071 amend. 3). Publishing narration conflicts with ADR-069 and adds a
  model dependency for a case the structural fix makes rare. Recorded as considered-and-deferred.

## The new contract (flat scalars only — no nested array anywhere)

One shared **core** tool, plus managed-only flat **segment/attach** tools:

- `deliver_output(markdown?)` — **terminal signal.** If `markdown` is present it becomes the text block at
  `order` 0. The 90% text-only path is exactly one bulletproof call.
- `attach_text(md, order)` — optional additional text segment, for text placed **after** an image
  (interleaving). Each `md` is a top-level string scalar — still no nested container.
- `attach_generated_image(ref, caption?, alt?, order?)` — `ref` = `file_id` from `generate_image`.
- `attach_input_image(ref, source_ref?, caption?, alt?, order?)` — embed an input attachment.

No `attach_doc`: office docs are already attached **authoritatively** from the Files-API `doc_files[]`
enumeration; a doc tool would be cosmetic (the renderer skips doc blocks). Bare lane uses **only**
`deliver_output(markdown)` (it emits no media output — one forced completion).

## Why multi-call is not more fragile than the single array

Assembly is a **pure function of the durable session event log**, exactly like today's single-call capture.
`attach_*` calls are ordinary non-terminal `agent.custom_tool_use` events that live in the log next to
`deliver_output`. On SSE reconnect, safety tick, or crash re-adoption the waiter re-derives the whole block
array by scanning events — nothing depends on in-memory accumulator state. Terminal signal is **unchanged**:
delivery is finished iff a `deliver_output` is pending on an idle session. The merge handles already-parsed
objects (one per call) — **zero parsing of model-authored JSON text**.

## Surfaces to change

**Managed-lane LIVE** (`services/session-waiter/app.mjs` is the live path since ADR-066):
- New `assembleOutputBlocks(orderedEvents, deliverCall)` → renderer's exact internal shape (text: `{type,md,
  order}`; image: `{type,mode,ref,source_ref,caption,alt,order}`); stable-sort by `order`.
- `driveSession` (app.mjs:498): `output_blocks = assembleOutputBlocks(...)` not `extractDeliverBlocks(picked)`.
- `serviceToolSafe`/`serviceClientTool` (app.mjs:462): local short-circuit for `attach_*` (post a success
  `user.custom_tool_result`, do **not** bridge to n8n). `analyze()` already treats them as generic pending.
- `assessDelivery`: empty = no `markdown` AND no answered `attach_*` AND no session output files; keep the
  one-shot `EMPTY_DELIVER_RETRY_MSG` bounce.
- **Delete:** `sanitizeStrayValueQuotes`, `parseDeliverBlocks` repair branches, `extractDeliverBlocks`,
  `MALFORMED_DELIVER_RETRY_MSG`, `jsonrepair` (import + `services/session-waiter/package.json` dep).
- `sync-agent-definitions.json → Build System` (`jsCode`): new `deliver_output_tool` schema (`blocks`→
  `markdown` scalar), add `attach_text`/`attach_generated_image`/`attach_input_image` to `tools[]`, rewrite
  the output-format `contract` prose, bump `CONV 18→19`, re-sync all agents.
- `render-agent-output.json → Parse Blocks`: **no change** (already reads `md ?? text`, `ref/file_id`,
  `source_ref`, `mode`; skips docs). Verify only.
- `publish-managed-result.json`: **no change** (already outcome-aware, ADR-071 amend. 3).

**Bare-lane PARITY** (dormant, one-schema rule): `invoke-model.json` `Resolve Routing → deliver_output_tool`
flat `markdown` schema (no `blocks`, no attach tools); `Parse Response` → `[{type:'text', md: args.markdown}]`,
drop the `args.blocks` coercion. Unification-exception documented: core `deliver_output(markdown)` shared
verbatim; segment/attach tools only where media output exists (managed).

**Sync-fallback PARITY** (dormant rollback): `execute-agent-session.json` `Poll Round` + `Build Final Output`
assemble `output_blocks_json` from `markdown` + `attach_*` by the same rule; drop the string coercion; keep
doc enumeration + the `deliver-output-empty` WARN.

## Block status

| Block | Scope | Status |
|-------|-------|--------|
| 0 | Verify assumptions: A1 re-test whether `strict:true`/typed array now server-rejects string-for-array (if yes → abort, ship one-line flag); A2 agent emits sequential `attach_*` then `deliver_output` and waiter services non-terminal + stops on terminal; A3 `Parse Blocks` renders a crafted interleaved assembled array with 0 warnings. Reconcile the uncommitted `app.mjs` sanitizer. | ✅ DONE — GO (see block-0-findings.md). A1: `strict` can't rescue the current polymorphic nested-array schema (needs additionalProperties:false + all-required; "complex array constraints" unsupported) and the managed-agents API doesn't server-enforce input_schema (ADR-071) — refactor stands; the flat schema is additionally strict-friendly. A2: waiter services sequential non-terminal custom tools + stops on `deliver_output` (app.mjs:577,590-596) — confirmed by code; agent-behavior half validated at Block 2. A3: `Parse Blocks` already consumes the exact assembled shape (`output_blocks_json` → text/image blocks, honors `order`, skips docs) — zero renderer change. Uncommitted sanitizer is superseded + not deployed; recommend discard/stash before Block 1 (operator to confirm). |
| 1 | Waiter assembly, dual-read (`app.mjs` only): add `assembleOutputBlocks`, local `attach_*` servicing, simplified `assessDelivery`; keep a temporary legacy `blocks` reader so nothing breaks pre-contract-flip. | ⬜ TODO |
| 2 | Flip managed contract (`sync-agent-definitions.json`): new schema + segment/attach tools + rewritten prose + CONV 18→19; re-sync. | ⬜ TODO |
| 3 | Bare-lane parity (`invoke-model.json`): flat `markdown` schema + `Parse Response` one text block. | ⬜ TODO |
| 4 | Sync-fallback parity (`execute-agent-session.json`): `Poll Round` + `Build Final Output` assemble from `markdown`+`attach_*`; drop coercion. | ⬜ TODO |
| 5 | Delete dead code: `sanitizeStrayValueQuotes`, `jsonrepair`, `MALFORMED_DELIVER_RETRY_MSG`, legacy `blocks` readers in all 3 capture points, Block 1's dual-read. | ⬜ TODO |
| 6 | Write-back: ADR-072 (supersede ADR-063 array schema, retire ADR-071 repair machinery); `current.md`; annotate ADR-063/066/071; drift-check clean. | ⬜ TODO |

## Definition of Done (per block)

Each block leaves the system working + verified. For blocks touching the live spine: trigger the full
ClickUp flow (@-mention a real disposable task or `scripts/test-subworkflow.mjs` against the orchestrator's
`When Called`), inspect node-by-node with `scripts/inspect-execution.mjs <execId>`, scan
`scripts/alerts-since.mjs <minutes>` for WARN/CRITICAL, and delete test `agent_runs` rows + disposable
ClickUp tasks afterward. **Block 2 acceptance is decisive:** a realistic interleaved image+doc task must
post one threaded comment with inline image, ordered text, and the `.xlsx` attachment, zero alerts, and the
event log showing flat `attach_*` + `deliver_output(markdown)` calls.

## Risks / edge cases

- **Ordering discipline:** an agent could call `deliver_output` before its `attach_*` calls, stranding late
  media. Contract states "attach first, then deliver," set `order` when interleaving. Loud, correctable
  protocol point — rarer and far less damaging than the silent prose corruption it replaces.
- **`strict:true` might now be a one-line fix** — Block 0/A1 gates the whole refactor on re-testing it.
- **Uncommitted `app.mjs` sanitizer** is superseded — reconcile in Block 0 before Block 1.
