# ADR-072: Markdown-native `deliver_output` delivery

## Context

ADR-063 replaced the fragile "LLM hand-writes fenced JSON, we hand-parse it" output contract with a
structured tool call: the agent submits its final answer by **calling** `deliver_output` with a nested
`blocks` array, relying on the Anthropic guarantee that tool inputs arrive as valid parsed JSON. That
guarantee holds for the **outer** object only. The defect returned one layer inside the tool input: Sonnet
intermittently serializes the `blocks` **array** into a JSON **string** (`{"blocks":"[ … ]"}`) and
hand-writes the inner JSON — including escaping — getting it wrong on Polish prose (an unescaped `"` inside
`„…"`). A stringified array is a valid string *value*, so we were back to hand-parsing model-authored JSON
with embedded prose — exactly the fragility ADR-063 set out to remove.

The response had been a heuristic treadmill on the symptom: the ADR-063 amendment (coerce string→array),
ADR-071 (`jsonrepair`), and an uncommitted `sanitizeStrayValueQuotes` state machine. Live task `869bwejqz`
still failed — ~214 s of real work, an empty/unrecoverable delivery, the one-shot retry fired and failed,
and a CRITICAL `managed-agents/non-delivery` notice was published to the user instead of the answer.

**Root cause (one sentence):** we transport the entire free-form Polish answer inside the *arguments* of one
tool call as a **nested array**, and the moment the model stringifies that container we lose the API's
per-string escaping guarantee.

An interim design (a flat `deliver_output(markdown)` terminal plus per-segment `attach_text` /
`attach_generated_image` / `attach_input_image` tools) was built and shipped to test. The first live
end-to-end run (Sonnet, task `869e5wm5u`) disproved the segment-tool half: the agent did the real work
(called `generate_image`, built the `.xlsx`) but **ignored every `attach_*` tool** and instead hand-wrote
the old `blocks` array as a JSON string into `markdown`, orphaning the image, with **no alert** (silent
degradation). Managed agents are built to answer by writing a **final message** and writing **files to
session outputs** (enumerated via the Files API); asking the model to route its answer through a foreign
multi-call segment protocol fights its single strongest prior.

## Decision

**Fix the shape, and deliver in the model's native idiom.** `deliver_output` takes a single flat scalar,
`markdown` — the entire final answer as ordinary markdown prose in Polish. Images are embedded **inline**
with standard markdown image syntax:

- generated image: call `generate_image` (returns `file_id`), then place `![opis](file_id)` in the markdown;
- input attachment: `![opis](ref)` using the attachment's `ref` from the „Załączone obrazy" section.

There is **no nested container** in the tool input (the misescape class becomes structurally impossible) and
**no multi-call segment protocol** (the model just writes its answer). The `attach_*` segment tools are
**retired before they ever really shipped**. Office docs remain delivered authoritatively from the Files-API
`doc_files[]` enumeration (ADR-069); the answer only *mentions* them in prose.

The **session-waiter** parses the one markdown string into the renderer's existing text/image block array by
splitting on `![…](…)` (`services/session-waiter/lib/deliver-blocks.mjs` → `parseMarkdownDelivery`). Inline
code spans and fenced code blocks are masked first, so an `![](…)` an agent writes inside backticks (e.g.
documenting the contract) is not mistaken for a real image. `Render Agent Output → Parse Blocks`, the image
carrier/resolver, and Post Reply are **unchanged** — the waiter emits exactly the block shape they already
consume, and generated-vs-embed is inferred from the `file_`-prefixed ref as before.

Keep `deliver_output` as the **terminal signal** rather than going fully message-native (reading the raw
final `agent.message`): the explicit terminal tool is the one genuinely useful thing the custom tool buys,
and dropping it means guessing done-ness from idle state — a bigger, riskier change. Considered and deferred.

**One contract, all lanes** (unification rule): the dormant bare lane (`Invoke Model (v1)`) and sync-fallback
(`Execute Agent Session (v1)` `Poll Round`) carry the same flat `markdown` schema and the same markdown→blocks
split (shared `md2blocks`, hand-kept in sync with the waiter lib — the two runtimes, an n8n Code node and a
Node service, cannot share a module).

**Proactive degradation guard** (reliability rule): the waiter raises a `Post Alert` WARN on a side branch —
without breaking the main result — when a delivery still looks wrong: `markdown` that parses as a JSON
blocks-array (a model backslide; the waiter unwraps it defensively so the user still gets content), or
`generate_image` ran but no image reference reached the delivered markdown (an orphaned image). This turns
the previously-silent media degradation into a loud, actionable signal. A backslide is additionally
**bounced once** — an `is_error` tool result asking the agent to re-send its answer as markdown prose with
inline `![](file_id)`, mirroring the ADR-071 empty-delivery retry (`MAX_BACKSLIDE_RETRIES=1`, both SSE and
poll paths). The unwrap preserves text and attached files but cannot recover images from an old-format
array (its image blocks carry no valid `file_id`), so the retry gives the agent a second, correct attempt
to inline its already-generated images. Verified live: a Sonnet run that backslid on the first attempt (task
`869e62jzh`) delivered clean markdown with both inline images on a subsequent run; the backslide rate is
non-trivial (~1 in 3 on complex 2-image + 2-file tasks in testing), which is why the loud guard + bounce
matter.

Recorded as ADR-072, **superseding ADR-063's `blocks`-array schema** and **retiring ADR-071's repair
machinery** (`jsonrepair`, and the uncommitted `sanitizeStrayValueQuotes`). The ADR-071 empty-delivery
retry, the outcome-aware incomplete notice, and ADR-069 doc-only handling are retained as backstops.

**Rejected — `strict: true` / a typed array as a one-line fix:** verified against the Anthropic tool-use
reference that strict requires `additionalProperties:false` + all-required and explicitly excludes "complex
array constraints"; the polymorphic nested `blocks` array cannot be made strict, and the Managed-Agents API
does not server-enforce `input_schema` (ADR-071). The flat scalar is what strict *can* validate, but the
shape change is what removes the defect.

## Consequences

- The stringified-array misescape class (ADR-063 amendment, ADR-071) is **structurally gone** — there is no
  container in the tool input to stringify. What the waiter parses now is markdown-image syntax, which has no
  prose-escaping layer; a malformed/missing reference renders as visible literal text, never a crash or an
  empty/corrupt delivery.
- The 90% text-only path is one bulletproof `deliver_output(markdown)` call. Interleaving is free (inline
  `![](…)` position is the order) with no ordering protocol for the model to follow.
- Media deliveries can no longer degrade silently: a backslide or an orphaned image now fires a WARN.
- A markdown→blocks splitter is **duplicated** across the Node waiter and two n8n Code nodes (different
  runtimes; no shared module possible). Marked KEEP IN SYNC; a future change must touch all three.
- Removed the `jsonrepair` dependency and the dead `attach_*` servicing branch from the waiter.
- The bare lane's forced-tool-call arguments carried the same latent misescape risk; flipping it to markdown
  closes that too (not merely a cosmetic parity change).
- Verified end-to-end on the managed lane (Sonnet, full spine): a realistic interleaved image+doc one-pager
  posted one threaded comment with the inline image, ordered prose, and the `.xlsx` attachment, zero alerts,
  the event log showing a single `deliver_output(markdown)` with an inline `![…](file_…)`.

## Date

2026-07-17
