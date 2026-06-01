# ADR-014: Multimodal I/O via first-class file-reference passing

Date: 2026-06-01
Status: Accepted (format adapters DEFERRED, built per-workflow on demand)

## Context
Inputs and outputs may be non-text (images, Office documents, HTML, markdown,
gifs/video). Base models handle multimodal *input* natively; public skills can
handle conversion. The only architectural risk is hardcoding a text-only
assumption into the core orchestration, which would make multimodality a rewrite
later instead of an addition.

## Decision
1. **File references are first-class.** Input-gathering and output-delivery steps
   carry file references (URLs / ClickUp attachment IDs) generically; the
   orchestration must not assume every payload is text. A task can carry a file
   from input through to output without the orchestrator choking on it.
2. **Per-skill format declaration.** Each skill declares the formats it consumes
   and produces. Multimodality is a per-skill concern; the skills-folder
   structure already supports this, so no core change is needed beyond (1).
3. **Non-text output storage.** Binary/large outputs (generated images, files)
   are stored as ClickUp attachments (or object storage) and referenced by URL,
   not inlined as text.

## Implementation status
DEFERRED per format. Build only the generic file-passing pipe (1) when first
needed (likely Phase 2). Specific format adapters — image generation, .docx /
.xlsx / .pptx generation, video handling — are added per-workflow when a real
workflow needs them, NEVER speculatively. Supporting every Office format before
a workflow requires one is the abstraction trap.

## Consequences
- The core pipe can carry files; each format adapter is additive and isolated.
- Avoids both failure modes: text-only lock-in (rewrite later) and speculative
  universal-format plumbing (wasted effort now).
