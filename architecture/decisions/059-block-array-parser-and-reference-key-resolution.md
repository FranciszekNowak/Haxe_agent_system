# ADR-059: Schema-aware block-array parser + reference resolution by source_ref

## Context

On 2026-06-24 ~10:21 an agent run on ClickUp task `869dux9ne` (a moodboard request with
product photos attached **inside two .zip archives**) produced two visible failures in one
turn:

1. **The reply posted as a raw JSON dump**, not a formatted comment. The agent had returned
   a well-formed block array (`[{type:"text",md:...},{type:"image",mode:"generate",...},
   {type:"image",mode:"embed_input",ref:"<uuid>.zip:N"},...]`), but `Render Agent Output (v1)`
   → *Parse Blocks* rejected it and fell back to a single plain-text block — so ClickUp
   received the literal `[`, `{`, `"type"...` source (execution 3618, WARN
   `output-adapter/parse-fallback`).
2. **Reference-image generation was unavailable** — the agent's own text told the operator it
   could not use the attached photos as references. The image MCP path emitted three
   `image-tool/reference-not-found ... not in session file map` WARNs and degraded the image
   model one tier (execution 3615, fallback to `vertex_ai/gemini-2.5-flash-image`).

These are **two independent root causes**, both surfaced by the same task because it carried
zip-inner images and Polish prose.

**RC1 — the parser.** *Parse Blocks* JSON-parses `output_message` with a hand-rolled lenient
quote-repair fallback. The model's prose used a raw ASCII `"` as a typographic closing quote
sitting immediately before a comma — `...krok w stronę „realistyczne", o który prosiłeś` —
an unescaped quote inside a JSON string value. The old repair closed a string whenever a `"`
was followed by any structural char (`, } ] :`), so it mis-fired exactly here (its own comment
admitted: *"Misfire (a literal quote right before a comma) just falls through to the plain-text
fallback"*). Reproduced in isolation and against the real 6 010-char payload: direct
`JSON.parse` fails at character 332. This was the **second** time this task tripped the parser
(a preamble-strip was bolted on 2026-06-23), which is the evidence that a one-off heuristic
treadmill was the wrong shape.

**RC2 — the reference key mismatch.** Input images (loose *and* zip-inner) are uploaded to the
Anthropic Files API by `Upload Input Images (v1)`, which upserts `agent_input_file_map` rows
carrying **both** a Files-API `file_id` and the `source_ref` (`<uuid>.zip:N` for zip-inner).
But `Assemble Context and Build Prompt (v1)` → *Build Prompt* advertises images to the agent
**only by `source_ref`** — the agent never sees a `file_id`. The image MCP tool's param is
named `reference_file_ids`, so the model passes the `source_ref`s it was shown, while
`Image MCP Tool Handler (v1)` → *Resolve References* matched **`file_id` only**. Every
reference missed. Confirmed against live data: `agent_input_file_map` holds the rows
(`source_ref = 6966c837-…zip:5` → a real `file_id`); the lookup just used the wrong key.

## Decision

**RC1 — replace the ad-hoc repair with a single schema-aware `parseBlockArray(raw)` helper**,
placed verbatim in both lanes that consume the block protocol (ADR-053 #4): the managed lane
`Render Agent Output (v1)` → *Parse Blocks* and the bare lane `Image Resolver (v1)` →
*Resolve & Explode Blocks* (marked KEEP IN SYNC, same convention as the shared `mdToOps`). The
helper escalates only on failure: strip a ```json fence → narrow a prose preamble/suffix to the
`[ … ]` span → `JSON.parse` → schema-aware quote/control-char repair → `JSON.parse`. In the
repair, an in-string `"` is treated as the real terminator **only** when the next non-whitespace
token is grammar-consistent: a closing `}`/`]`, a `:` (key close), or a `,` whose following
token is structural (`{ [ } ]`) or one of the **known block keys** (`type, md, text, ref,
file_id, mode, caption, alt, source_ref, order, prompt, aspect, size, reference_refs`).
Otherwise the `"` is literal prose and is escaped. Tying the rule to the fixed key set is what
kills the quote-before-comma misfire (` o który` is not a known key → prose). On total failure
both lanes fall back to one text block carrying the raw content **and** surface a WARN (the bare
lane routes it on a dedicated empty-md text carrier, because a 0-item Code node never executes
downstream).

Alternatives rejected: a delimiter-based non-JSON block protocol (correct long-term but a large
change touching both lanes' protocol *and* the agent prompt — deferred unless the schema-aware
parser proves insufficient); an LLM repair call (latency/cost on the hot delivery path).

**RC2 — resolve references by `source_ref` OR `file_id`** at both layers that resolve, so the
key the agent is actually shown matches:
- `Image MCP Tool Handler (v1)` → *Resolve References*: widen the SQL to
  `where file_id in (…) or source_ref in (…)` against `agent_input_file_map`. No migration —
  the `source_ref` column already exists.
- `Image Tool Handler (v1)` → *Build Requests* (the shared image-gen core / drift guard): key
  the `byId` lookup by `file_id` **and** `source_ref` (and `url`), so a `source_ref` ref
  resolves to its signed URL. Fixing only the SQL would re-introduce drift the moment the
  dormant client-side `generate_image` branch reactivates.

This mirrors how the embed path (Parse Blocks / Resolve Embed) already resolves `embed_input`
by `source_ref || ref` — one resolution convention for embed and for generation references.

## Consequences

- **The raw-JSON-dump failure is fixed** and verified on the exact payload: the deployed
  *Parse Blocks* now returns all 7 blocks with `warnings: []`, and a live `test-subworkflow`
  run renders a fully formatted `rendered_delta` (headers, table, bullets, both generated
  images, and the two zip-inner photos as inline `{type:attachment}` ops).
- **Reference generation now works for zip-inner (and any `source_ref`-cited) images**: the live
  *Resolve References* returns the rows for a `source_ref` input (`resolved_refs` > 0, no
  `reference-not-found` WARN). Loose-image `file_id` resolution is unchanged (additive).
- **Both lanes share one parser.** A future block-schema key must be added to the `KNOWN` set in
  **both** copies; a future block-protocol consumer should reuse the helper. If model JSON defects
  keep evolving past what a schema-aware repair can recover, revisit the delimiter-protocol
  alternative.
- **Signed-URL expiry (6h)** applies to zip-inner reference URLs — acceptable within the 840 s
  session deadline, the same risk the embed path already accepts.
- **Duplicate `agent_input_file_map` rows** (same `source_ref`, different `file_id`, from
  re-uploads) inflate `resolved_refs` as a metric but not behaviour — `byId` dedups by key and
  one URL is pushed per requested ref.
- **Silent-failure coverage:** RC1 no longer degrades silently — a parse that even the repair
  cannot recover still posts the raw content *and* fires a WARN (managed: `output-adapter/parse-
  fallback`; bare: `multimodal/parse-fallback`), where the bare lane was previously silent
  (`catch → []`). RC2's miss path (`reference-not-found`) was already a WARN and is retained for
  genuinely absent refs.

## Date

2026-06-24
