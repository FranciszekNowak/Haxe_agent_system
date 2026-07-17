# ADR-072 — Markdown-native `deliver_output` delivery (master plan)

Kills the stringified-`blocks` misescape at its root by removing every nested container from the
`deliver_output` tool input, and delivers the answer the way managed agents are *designed* to — as one
markdown message with inline image references — instead of a custom multi-call tool protocol the model
resists. **Every block starts by reading THIS file in full.**

## Amendment (2026-07-17) — pivot from `attach_*` multi-call to markdown-native

The original decision below removed the nested `blocks` array (correct) and replaced it with flat
**segment tools** (`attach_text` / `attach_generated_image` / `attach_input_image`) the agent was supposed
to call once per block, plus a terminal `deliver_output(markdown)`. Block 2's first live end-to-end test
(Sonnet, task `869e5wm5u`) disproved the segment-tool half: the agent did the real work (called
`generate_image`, built the `.xlsx`) but at delivery **ignored every `attach_*` tool** and instead
hand-wrote the OLD nested `blocks` array as a JSON string inside `markdown`. The renderer showed raw JSON,
the generated image was orphaned, and **no alert fired** (silent degradation).

Root of that behaviour: managed agents are built to answer by (1) writing a **final message** and (2)
writing **files to session outputs** (enumerated via the Files API). `deliver_output` is *our* invention;
asking the model to route its answer through a foreign multi-call segment protocol fights its single
strongest prior. **The fix is to stop fighting it:** keep `deliver_output(markdown)` as the terminal
signal, but let `markdown` be the whole answer as ordinary prose, with **inline standard-markdown image
references** (`![alt](file_id)`) for generated/attached images. The waiter parses that one markdown string
into the renderer's existing text/image block array by splitting on `![…](…)`.

This **keeps ADR-072's real win** — the tool input is still one flat scalar string, so the Polish-prose
misescape class stays structurally dead — while dropping the part the model won't use. What we parse now is
markdown-image syntax (trivial; a malformed ref degrades to visible literal text, never a crash or empty
delivery), which is a categorically different thing from the JSON-in-JSON hand-parsing ADR-063/071 fought.
Framed simply: ADR-072 was right that the container had to go; it was wrong that the replacement was
`attach_*` tools. The replacement is inline markdown — the model's native idiom. The `attach_*` tools are
**retired before they ever really shipped**.

## Problem / root cause (confirmed against the live system)

Managed agents submit their final answer by **calling** `deliver_output` with a nested `blocks` array
(ADR-063). ADR-063 correctly killed the older "LLM hand-writes fenced JSON, we hand-parse it" protocol by
relying on the Anthropic guarantee that **tool inputs arrive as valid parsed JSON**. The defect returned
**one layer inside the tool input**: Sonnet intermittently serializes the `blocks` **array** into a JSON
**string** (`{"blocks":"[ … ]"}`) and hand-writes the inner JSON — including escaping — getting it wrong on
Polish prose (unescaped `"` inside `„…"`). The API guarantee only covers the **outer** object; a
stringified array is a valid string *value*, so we are back to hand-parsing model-authored JSON with
embedded prose — exactly the fragility ADR-063 set out to remove.

The response so far had been a heuristic treadmill on the symptom: ADR-063 amendment (coerce string→array),
ADR-071 (`jsonrepair`), and an uncommitted `sanitizeStrayValueQuotes` state machine.

**Root cause (one sentence):** we transport the entire free-form Polish answer inside the *arguments* of
one tool call as a **nested array**, and the moment the model stringifies that container we lose the API's
escaping guarantee.

## Decision (as amended)

**Fix the shape, not the parser — and deliver in the model's native idiom.** `deliver_output(markdown)` is
the single terminal signal. `markdown` is the whole answer as ordinary markdown prose; the agent embeds
images inline with standard markdown image syntax `![opis](ref)` where `ref` is the `file_id` returned by
`generate_image` (generated image) or the input-attachment `ref` (embed). The session-waiter parses the one
markdown string into the renderer's existing block array (text/image, in order) by splitting on the
`![…](…)` pattern. There is **no nested container** in the tool input (misescape class structurally gone)
and **no multi-call segment protocol** (the model just writes its answer). Office docs remain delivered
**authoritatively** from the Files-API `doc_files[]` enumeration (ADR-069) — the answer only *mentions* them
in prose. Recorded as **ADR-072** (amended), superseding ADR-063's array schema and retiring ADR-071's
repair machinery **and** the never-shipped `attach_*` tools.

Operator decisions (2026-07-17):
- **Interleaving is preserved** for free — it is just where the `![](…)` sits in the prose.
- **No Haiku / narration normalizer.** Rely on the structural fix + the one-shot empty-delivery retry +
  the already-shipped outcome-aware incomplete notice (ADR-071 amend. 3), now plus a proactive
  degradation WARN (below). Recorded as considered-and-deferred.
- **Keep `deliver_output` as the terminal signal** rather than going fully message-native (reading the raw
  final `agent.message`). The explicit terminal tool is the one genuinely useful thing the custom tool
  buys us; dropping it means guessing done-ness from idle state — a bigger, riskier change. Considered and
  deferred.

## The new contract (one flat-scalar markdown call — no nested array, no segment tools)

- `deliver_output(markdown)` — **terminal signal.** `markdown` is the ENTIRE final answer as ordinary
  markdown prose in Polish (headings, lists, tables, bold). The 90% text-only path is exactly this one
  bulletproof call.
- **Inline generated image:** call `generate_image` (returns `file_id`), then place
  `![krótki opis](file_id)` in the markdown where the image should appear.
- **Inline input attachment:** `![opis](ref)` using the attachment's `ref` from the „Załączone obrazy"
  section.
- **Office docs:** write to session outputs (auto-attached from the Files API, ADR-069); just mention the
  file by name in the prose. No markdown image for docs.
- Empty delivery = no markdown AND no session output files → non-delivery (bounce once, ADR-071).

No `attach_text` / `attach_generated_image` / `attach_input_image` tools. No `doc` block type.

## Why markdown parsing is not the fragility we deleted

The misescape bug was the model hand-writing a JSON **array** as a string and mis-escaping prose quotes
inside it. Here the model writes **markdown prose** — prose is prose, there is no quote-escaping layer — and
the only thing we extract is the `![alt](ref)` image pattern. A malformed or missing image reference renders
as literal text (visible, correctable), never a crash, never an empty/corrupt delivery. The API's
per-string escaping guarantee fully covers the markdown string. So the root fragility class stays gone.

## Proactive degradation guard (mandatory, reliability rule)

The current live failure is **silent** (raw JSON posted, `outcome=delivered`, zero alerts). Whatever we
ship, the waiter must raise a WARN through Post Alert when a delivery still looks wrong — fired on a side
branch, main path still returns its result:
- `deliver_output.markdown` parses as a JSON array of block-like objects (the old-format backslide) →
  WARN + defensively unwrap it to blocks so the user still gets rendered content.
- `generate_image` ran in the session but the assembled blocks contain **no** image → WARN (orphaned
  image).

## Surfaces to change

**Managed-lane LIVE** (`services/session-waiter/`):
- `lib/deliver-blocks.mjs`: replace `assembleFlatBlocks` (attach-event assembly) with
  `parseMarkdownDelivery(deliverCall, allEvents)` → `{ blocks, warnings }` — split `markdown` on
  `![alt](ref)` into ordered text/image blocks (image `mode` inferred: `file_`-prefixed ref → `generate`,
  else `embed_input`); include the backslide-unwrap + orphaned-image WARNs. Keep the legacy `blocks`-array
  detection ONLY as the backslide guard (no `jsonrepair`).
- `app.mjs`: `driveSession` + `deliverIsEmpty` consume `parseMarkdownDelivery`; push delivery warnings into
  `finalWarnings` (side-channel). `serviceToolSafe` local `attach_*` ack becomes vestigial (harmless; deleted
  in Block 5). `analyze().attachEvents` unused (deleted in Block 5).
- `sync-agent-definitions.json → Build System` (`jsCode`): rewrite the output-format `contract` prose to
  markdown-native + `![](file_id)`, update the `generate_image` tool blurb, **remove**
  `attach_text`/`attach_generated_image`/`attach_input_image` from `tools[]`, keep `deliver_output(markdown)`
  scalar schema (description updated), bump **CONV 19→20**, re-sync all agents.
- `render-agent-output.json → Parse Blocks`: **no change** (already consumes the text/image block array,
  honors `order`, skips docs, infers generated vs embed by `file_` prefix). Verify only.
- `publish-managed-result.json`: **no change** (outcome-aware, ADR-071 amend. 3).

**Bare-lane PARITY** (dormant): `invoke-model.json` `deliver_output_tool` flat `markdown` schema; `Parse
Response` → parse `markdown` into blocks by the same `![…](…)` split (shared helper if practical), drop the
`args.blocks` coercion.

**Sync-fallback PARITY** (dormant rollback): `execute-agent-session.json` `Poll Round` + `Build Final
Output` assemble `output_blocks_json` from `markdown` by the same rule; drop the string coercion; keep doc
enumeration + the `deliver-output-empty` WARN.

## Block status

| Block | Scope | Status |
|-------|-------|--------|
| 0 | Verify assumptions (A1 `strict` can't rescue; A2 waiter services/stops; A3 `Parse Blocks` consumes the shape). | ✅ DONE — GO (see block-0-findings.md). Flat-scalar stands; `strict` is not a one-line escape; renderer needs zero change. |
| 1 | Waiter assembly scaffolding, dual-read (`lib/deliver-blocks.mjs` extracted, `app.mjs` wired, Dockerfile COPYs `lib/`, unit tests). | ✅ DONE + DEPLOYED (commits 4adcc1d, 6b02d6e, f62b94c) at `1.4.0-adr072-blk1`. NOTE: the `assembleFlatBlocks` half is superseded by the markdown parser in Block 2; the pure-core extraction, app wiring, and Docker/test scaffolding remain. |
| 2 | **REVISED (markdown-native):** waiter markdown→blocks parser + degradation WARN; flip managed contract prose to markdown + `![](file_id)`, remove `attach_*`, CONV 19→20, re-sync; decisive interleaved image+doc e2e. | ✅ DONE + DEPLOYED + VERIFIED. Waiter `lib/deliver-blocks.mjs` = `parseMarkdownDelivery` (markdown→text/image blocks by `![…](…)`, code-span/fence-masked so a backtick-quoted `![]()` example isn't a spurious image) + backslide-unwrap/orphaned-image WARNs; `app.mjs` wired (`driveSession`/`deliverIsEmpty`, `analysis.generateImageUsed`, warnings→`finalWarnings`); 14/14 unit tests. Deployed to VPS `1.5.0-adr072-blk2-md` (`docker compose up -d --build`, `readopt_none`). Contract flipped: CONV 20, `deliver_output(markdown)` only, `attach_*` removed, prose = native markdown + inline `![opis](file_id)`; imported + re-exported (drift clean), all 5 agents re-synced. **Decisive e2e** (Sonnet, task `869e5wm5u`, session `sesn_018uW1Hub8s2PAV5Efrmr5qt`): one `deliver_output(markdown)` with inline `![…](file_011…)`, waiter split into 3 ordered blocks, render `image_count=1` + bytes resolved (`warnings=[]`), threaded comment with **inline image + ordered prose + `.xlsx` attachment, 0 alerts**. (First markdown run surfaced + fixed the code-span parser bug: an earlier v1 run rendered a spurious `[Obraz niedostepny]` from the agent's own backtick-quoted `![opis](file_id)` example → 1 WARN; masking fixed it.) |
| 3 | Bare-lane parity (`invoke-model.json`): flat `markdown` schema + `Parse Response` markdown→blocks. | ✅ DONE + DEPLOYED (dormant). `Resolve Routing` `deliver_output_tool` = OpenAI-function `{markdown}` schema (blocks-array + `prompt`/`aspect`/`doc` items removed); `Parse Response` prepends the shared `md2blocks` (KEEP IN SYNC with the waiter lib) and reads `args.markdown` instead of `args.blocks` (string-coercion dropped). This also closes the bare lane's latent misescape (forced tool-call args are model-authored). Imported + re-exported, drift clean; simulated (text/image/text, code-span example not a spurious image). No live e2e — dormant path (managed is live). |
| 4 | Sync-fallback parity (`execute-agent-session.json`): `Poll Round` assemble from `markdown`; drop coercion. | ✅ DONE + DEPLOYED (dormant). `Poll Round` `output_blocks_json` now `md2blocks(picked.input.markdown)` (the `picked.input.blocks` + string-coercion IIFE removed); `Build Final Output` unchanged (still consumes `output_blocks_json` + doc enumeration + `deliver-output-empty` WARN). Imported + re-exported, drift clean; syntax + simulation verified. |
| 5 | Delete dead code. | ✅ DONE + DEPLOYED. Removed the vestigial `attach_*` local ack in `serviceToolSafe` (unreachable post-CONV20 — no such tools), the stale assembly comment, and the unused `jsonrepair` dep (`package.json` + regenerated `package-lock.json`). (`sanitizeStrayValueQuotes`/`MALFORMED_DELIVER_RETRY_MSG` were the discarded uncommitted amendment — never in the tree; `collectAttachEvents`/`assembleFlatBlocks`/`extractDeliverBlocks` already removed in Block 2.) Waiter rebuilt + booted clean at `1.5.1-adr072-blk5` (build resolves deps without jsonrepair); 14/14 tests. Change is provably behaviour-preserving (unreachable-branch + comment + unused-dep removal) so Block 2's e2e still stands. |
| 6 | Write-back. | ✅ DONE. Created `architecture/decisions/072-markdown-native-deliver-output.md` (supersedes ADR-063's array schema, retires ADR-071's repair machinery + the `attach_*` interim); added the ADR-072 markdown-native amendment to `current.md`'s delivery section; annotated ADR-063 (schema superseded, thesis stands) and ADR-071 (repair machinery retired, retry/notice survive). Drift-check clean (all 51). |

## Definition of Done (per block)

Each block leaves the system working + verified. For blocks touching the live spine: trigger the full
ClickUp flow (drive the orchestrator's `When Called` via `scripts/test-subworkflow.mjs` with the producer's
exact inputs, or @-mention a disposable task), inspect node-by-node with `scripts/inspect-execution.mjs`,
scan `scripts/alerts-since.mjs` for WARN/CRITICAL, and delete test `agent_runs` rows + disposable ClickUp
tasks afterward. **Block 2 acceptance is decisive:** a realistic interleaved image+doc task must post one
threaded comment with **inline image, ordered prose, and the `.xlsx` attachment, zero alerts**, and the
session event log showing a single `deliver_output(markdown)` whose markdown contains `![…](file_…)`.

## Risks / edge cases

- **Model still emits a JSON array** in `markdown` (backslide) → the degradation guard unwraps it + fires a
  WARN, so it renders and is loud, not silent. Should be rare once the contract speaks the model's idiom.
- **Bad/hallucinated `file_id`** in `![](…)` → the image resolver already fails soft; renders as a broken
  reference (visible), and the orphaned-image / resolver WARN covers it.
- **Ordering discipline** is no longer a protocol point — inline position IS the order.
