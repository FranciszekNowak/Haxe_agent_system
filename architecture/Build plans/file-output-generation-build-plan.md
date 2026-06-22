 File Output Generation: block-based build plan (ADR-045 + ADR-046)

 > **SUPERSEDED 2026-06-22 — do not build from this plan.** This plan generated office documents on the
 > *bare* Messages API plus our own code-execution and a hand-built Skills layer. ADR-053 (Managed Agents)
 > replaced that approach: office-document output (docx/xlsx/pptx/pdf) is now produced by **Anthropic
 > Skills inside the Managed Agents runtime** and delivered as ClickUp attachments by `Post Reply (v1)`
 > (ADR-053 Block 7), verified live in the Block 9 cutover. Kept for historical context only. See
 > `architecture/Build plans/adr-053-managed-agents/master-plan.md` and ADR-053/ADR-055.

 This is a self-contained master plan for the file-output capability. Read it in full at the start of
 every block. It can run standalone or be appended to the existing GDPR/multimodal master plan; its blocks
 are numbered F1..F5 to avoid collision. Same routine as the other plans: read this file top to bottom,
 do the first not-done block, write back to architecture/current.md and the ADRs, update the status table,
 commit, emit a handoff, /clear, repeat.

 Numbering to confirm against the live repo before committing: ADRs 045 and 046 are the next free numbers;
 migrations 026 (route on output_modality) and 027 (file routing) are the next free numbers. decisions/ runs
 through 044; migrations through 025. Correct here if the repo disagrees.

 Block status

 ┌─────┬───────────────────────────────────────────────────────────────────┬──────────┐
 │  #  │                               Block                               │  State   │
 ├─────┼───────────────────────────────────────────────────────────────────┼──────────┤
 │ F1  │ Route on output_modality (collapse the input axis; Gemini→alias)  │ ☐ to do  │
 ├─────┼───────────────────────────────────────────────────────────────────┼──────────┤
 │ F2  │ File routing rows + file_gen_params side table                    │ ☐ to do  │
 ├─────┼───────────────────────────────────────────────────────────────────┼──────────┤
 │ F3  │ File Gen Adapter: Anthropic (skills + code execution + download)   │ ☐ to do  │
 ├─────┼───────────────────────────────────────────────────────────────────┼──────────┤
 │ F4  │ Wire the file lane into Invoke Model + file-aware cost            │ ☐ to do  │
 ├─────┼───────────────────────────────────────────────────────────────────┼──────────┤
 │ F5  │ Validation gate + delivery + erasure recording + e2e + write-backs│ ☐ to do  │
 └─────┴───────────────────────────────────────────────────────────────────┴──────────┘

 ---
 Context (why)

 The pipeline outputs text and generated images only. It cannot produce xlsx/pdf/docx/pptx deliverables.
 ADR-046 adds a fenced file-generation lane that uses Anthropic's managed code execution + Agent Skills (so
 the runtime, libraries, and formatting skills are Anthropic's to maintain, not ours), behind a provider
 adapter seam so OpenAI or others can be added later by writing one adapter and repointing a routing row.
 The lane is gated by output_modality='file'.

 ADR-045 (the routing prerequisite) collapses the routing key to (impact, output_modality). We researched
 whether routing by input shape (vision to Gemini, text to Claude) is warranted and found it is not for our
 workload: image-QA is saturated (frontier models within ~2-3 points), our documents are Docling-to-text
 (not a vision question), our only vision input is product photos (no visible Gemini advantage), and we have
 no audio/video. An input axis would also have created ~36 uncuratable cells. So input parts are handled
 per-path by the reader (parse files, pass images and text), not routed on; Gemini becomes a dormant
 litellm alias with no routing row. F1 lands that collapse; F2..F5 build the lane on top.

 Rules every block inherits (state them, do not re-derive)

 - Build n8n via the n8n MCP (ADR-018); export JSON to n8n/workflows/ and commit after any live change. Do
   not hand-edit exported JSON.
 - All alerts route through Post Alert (v1) (YSCdHlmdf3p9XEUx). Severity + source + actionable details.
 - The sole agent_runs writer and cost owner is Log Model Run (v1) (ztSIUkp9ytbG1xpE, ADR-035). File-gen
   cost rows go through it too. No FX/PLN math anywhere else.
 - Loop guard: never read or post-watch the Alerts task 869dj2z2c.
 - Supabase migrations are append-only, new number each time. Workflows verified live, not "looks right".
 - model_routing is the SSOT for active routing decisions (one row per (impact, output_modality)); the
   catalogue of callable models lives in litellm-config. Dormant models are aliases, not rows. Routing does
   not read input; input parts are handled per-path by the reader.
 - State which silent-failure modes each block covers.

 Scope guardrail (do not touch)

 Docling and the reading path · the agent spine and context gathering · the text inference lane · the image
 generation lane (ADR-036). F1 changes the routing key and deletes the dormant Gemini rows; it must keep
 text and image OUTPUT routing identical. The file lane is additive and fenced; it must not alter how text
 or image tasks route or render.

 The internal contract (the one shared reference for the lane)

 File Gen Adapter contract (provider-agnostic):
   in : { instruction, data, file_type, guidance }
   out: { file_bytes_b64, mime, filename, cost_pln, model_used, provider }
 ref/bytes never cross a workflow boundary except as base64 inside execution data (mirrors Block 10).

 ---
 Block F1 — Route on output_modality (collapse the input axis; dormant Gemini to alias)

 - Context: Foundational refactor. Replaces the overloaded modality column with an output-only routing key,
   moves input handling out of routing into the reader's per-path logic, and takes the dormant Gemini rows
   out of the table so they cannot be selected. Everything downstream (the file lane) depends on
   output_modality existing as the key.
 - Grounding: ADR-045; current.md §15.4 (Invoke Model, Lookup Routing / Resolve Routing, multimodal input
   message build); migration 021.
 - Prereq: none. Reuse: the Lookup Routing / Resolve Routing nodes; Read Input (v1); the message builder.
 - Do: migration 026 — add output_modality; backfill text→text, image→image; DELETE the multimodal_input
   rows (they point at Gemini and would collide with the Claude text rows under the new PK; deleting them
   makes Gemini a dormant alias, still callable in litellm-config, simply unrouted). Swap PK to
   (impact, output_modality); drop the old modality column once the consumer reads the new key. Confirm the
   reader (Read Input v1) already emits ordered blocks per input part (files→Docling→text, images/text passed
   through) and the message builder assembles them; no flag, no input read in routing. Send all tasks to the
   impact-tier model. Update Lookup Routing's query and Resolve Routing to key on (impact, output_modality).
   Keep the 0-row guard (ADR-041) keyed on the new combo. To reactivate Gemini later, repoint a slot's row to
   the alias via a tracked migration; never add it back as a key column or an active flag.
 - Behavioral note: this moves vision-input tasks from the Gemini multimodal_input route to the impact-tier
   Claude model. Capability-neutral per ADR-045's research (and possibly already a no-op, since the history
   is ambiguous about whether Gemini ever served a vision task). Verify it explicitly below.
 - Live test: re-run one text-output task and one image-generation task; each must resolve the SAME
   provider/model/price as before (diff the resolved row). Run one image-INPUT task: it must now resolve the
   impact-tier Claude model AND still read its image correctly (image blocks present in the assembled
   messages). Force an unseeded combo → CRITICAL invoke-model/routing + Sonnet fail-safe. Inspect every node.
 - Write-back: ADR-045 to Accepted/landed; current.md §15.4 routing-key description updated to
   (impact, output_modality) + the per-path reader note (input handled in the reader, not routing); migration
   026 noted (multimodal_input rows deleted, Gemini alias dormant).
 - Silent-failure modes: a mis-mapped backfill row silently re-routing a task → the diff test is the guard;
   a vision task losing its image because image blocks were dropped in assembly → the image-input live test
   catches it; an unseeded combo → the 0-row CRITICAL.

 ---
 Block F2 — File routing rows + file_gen_params side table

 - Context: Teaches model_routing about file output. Adds the output_modality='file' rows (selection) and a
   side table for file-specific params (skill set, version pin, container memory), mirroring image_gen_params.
 - Grounding: ADR-046 (selection in table); ADR-045 (the (impact, output_modality) key); current.md §15.4
   (image_gen_params join pattern).
 - Prereq: F1. Reuse: the image_gen_params side-table + LEFT JOIN pattern.
 - Do: migration 027 — create file_gen_params keyed to match the file routing rows: columns skill_ids
   (text[]), container_memory (text), default file_type, and a
   max_tokens suited to a code-writing turn (the model writes Python; that is output tokens, so size it
   higher than a plain text reply, for example 16k+). Seed file rows for the real combos only:
   (impact ∈ {Niski, Średni, Wysoki, Krytycznie ważne, __default__}, output_modality='file') →
   provider='anthropic', model by tier (recommend Sonnet for Niski/Średni, Opus for Wysoki/Krytycznie; tune
   at build), price fields as a fallback floor. Add 'file' to any output_modality CHECK/enum. Lean on
   __default__ + the 0-row guard for anything unseeded.
 - Live test: SELECT the file rows resolve with a joined file_gen_params row; an unseeded file combo →
   0-row CRITICAL, not a null route.
 - Write-back: ADR-046 selection section landed; current.md §15.4 + §5 (new table); migration 027 noted.
 - Silent-failure modes: a file row without a file_gen_params match (skill set null) → the adapter must
   treat missing params as a hard config error + CRITICAL, not a silent default.

 ---
 Block F3 — File Gen Adapter: Anthropic (skills + code execution + download)

 - Context: The provider-specific subworkflow, the only place that knows Anthropic's beta surface. Implements
   the in/out contract. Isolated so a future OpenAI adapter is a sibling, not a rewrite.
 - Grounding: ADR-046 (adapter mechanics); the skills container shape; LiteLLM /v1/skills passthrough.
 - Prereq: F2 (for the skill set + model). Reuse: the LiteLLM gateway credential; the credential-aware fetch
   pattern for the download.
 - Do: build `File Gen Adapter: Anthropic` (n8n subworkflow). Inputs the contract's `in`. Build the Messages
   request: container.skills=[{type:'anthropic', skill_id:<by file_type>, version:'latest'}] (+ the custom
   Haxe skill once it exists), tools=[code_execution_20250825], beta headers
   skills-2025-10-02 / code-execution-2025-08-25 / files-api-2025-04-14. Prompt = instruction + data +
   guidance; the skill is attached by id, not named in prose. Send via the LiteLLM /v1/skills passthrough.
   Extract the produced file_id with a recursive search over the nested tool-result blocks, in ONE node;
   WARN multimodal/file-id-missing if extraction returns nothing (defense in depth against a response-shape
   change). Download the bytes via the Files API → base64. Return the contract's `out` (file_bytes_b64, mime,
   filename, cost fields from the usage/cost surface, model_used, provider='anthropic'). Pin the beta headers
   and the extraction in this subworkflow only.
 - Live test: feed a hand-written instruction ("a 3-row budget xlsx") + dummy data → assert a file_id is
   found, the download returns non-empty xlsx bytes, and the out-contract is populated. Force a bad skill_id
   → a clean error + CRITICAL, no silent empty file.
 - Write-back: ADR-046 adapter section landed; current.md §15 new subworkflow row.
 - Silent-failure modes: file_id missing → WARN; 24h expiry between generate and download → download
   immediately in-flow (no deferral); a code-execution error inside the sandbox → surfaced as an adapter
   error + CRITICAL, never a 0-byte "success".

 ---
 Block F4 — Wire the file lane into Invoke Model + file-aware cost

 - Context: Connects the table-driven selection to the adapter. Adds the output_modality fork and the
   provider Switch, and teaches Log Model Run to price a code-execution run.
 - Grounding: ADR-046; current.md §15.4 (the existing Output Is Image? fork; Normalize Model Result; Log
   Model Run); ADR-035.
 - Prereq: F3. Reuse: the existing fork + Normalize Model Result + Log Model Run.
 - Do: after Lookup Routing, add an `Output Is File?` branch (reads output_modality), parallel to
   `Output Is Image?`. On file: a Switch on the row's `provider` → File Gen Adapter: <provider> (only
   anthropic wired now; other branches → CRITICAL "no adapter for provider"). Do NOT route file through
   Resolve Routing / Call LiteLLM (that path builds a single completion). Converge the adapter's out into
   `Normalize Model Result` (uniform schema: file_bytes_b64 + mime + filename alongside the existing union).
   Add a file-aware cost path to Log Model Run: cost = token usage + code-execution session/container billing
   from the response surface; the model_routing price is the fallback floor; one priced agent_runs row,
   triggered_by reflecting file gen.
 - Live test: a file task routes to the adapter (not the LLM call), returns bytes, and writes exactly one
   priced agent_runs row with the right model/impact and a non-zero cost; a text and an image task are
   unaffected (regression).
 - Write-back: ADR-046 wiring landed; current.md §15.4 (the new fork + cost path); §5 cost note.
 - Silent-failure modes: a file row whose provider has no adapter → CRITICAL, not a dropped task; a
   code-exec cost that the response omits → fallback-floor price + a cost-missing WARN (mirrors the image
   cost-header-missing pattern).

 ---
 Block F5 — Validation gate + delivery + erasure recording + end-to-end + write-backs

 - Context: Closes the lane. Validates the artifact, delivers it through the existing Block 10 upload, records
   it for erasure, and proves the whole arc on a real task.
 - Grounding: ADR-046 (validation, delivery, data discipline, erasure); ADR-036 Block 10 (comment_native
   upload); ADR-044 (artifact recording / erasure hub).
 - Prereq: F4. Reuse: Block 10's base64 → Upload Attachment → {id,url}; Record Artifact.
 - Do: validation gate — parse the produced file back (open it, assert non-corrupt, light schema check: sheet
   exists / page count > 0). On failure: WARN multimodal/file-invalid, do NOT post the broken file; post a
   short Polish text note that generation failed, or retry once. Delivery: reuse Block 10's upload half
   (binary → Upload Attachment → ClickUp {id,url}); post a draft comment that links the file + the
   "do weryfikacji, nie finalizuje" footer + the reviewer @-mention. This is an attachment + a comment line,
   NOT an inline-image Delta rewrite; keep Block 10's upload half modality-agnostic. Erasure: record the
   uploaded attachment id on the run's agent_runs row (the erasure hub; alongside clickup_comment_id). Data
   discipline: the prompt/skill guidance instructs the model to lay out and format, using the numbers it is
   given, never inventing or recomputing business-critical figures.
 - Live test (the worked flow): @-mention the agent on a test task in Lista testy AI with
   requested_modality_of_output='file', file_type='xlsx', and real data (for example the sample-assignment
   table) → a draft comment with an attached .xlsx that OPENS and contains the fed numbers, one priced
   agent_runs row, the attachment id recorded, status flow intact, no unexplained alerts. Then a deliberately
   corrupt-output case → file-invalid WARN + a text note, no broken attachment posted. Check the Alerts task.
 - Write-back: ADR-046 to fully landed; current.md §15.6 (file delivery note) + §15.4 (lane) + §4/§5 (erasure
   recording of the file attachment id); compliance/gdpr-processing-decisions.md — add the Anthropic
   code-execution + Files sandbox as a processing activity / sub-processor, and a line confirming the
   no-training + DPA terms cover the code-execution and files products (operator to confirm the executed
   terms). Block status table → all F-blocks done. Final commit.
 - Silent-failure modes: a corrupt or empty file posted as if valid → the validation gate; an upload that
   half-fails (orphaned attachment) → the Block 10 rollback/WARN already covers it; an unrecorded artifact id
   (erasure gap) → the Record Artifact 0-row WARN (ADR-044) covers it.

 ---
 Out of scope (do NOT build)

 No OpenAI/Gemini file adapter (seam only; add later by writing one adapter + repointing the row's provider).
 No deterministic self-hosted renderer. No input_modality routing axis (input parts are handled per-path by
 the reader, not routed on). No active column or dormant rows in model_routing (dormant models are litellm
 aliases; reactivate by repointing a row via a tracked migration). No audio/video input routes (add a
 targeted route when those inputs are real, never a pre-built cross-product). No inline-rendering of files (a
 file is an attachment, not a Delta image). No code-execution for non-file tasks (gate strictly by
 output_modality).

 Open decisions (recommendations baked in; confirm before the relevant block)

 1. File-gen model per tier (F2): Sonnet for Niski/Średni, Opus for Wysoki/Krytycznie [recommended]; tune
    after the first real outputs. The skill carries much of the quality, so a mid model may suffice for low tiers.
 2. Validation-failure behavior (F5): post a text note explaining + retain nothing [recommended] vs one
    silent retry then the note. Either way, never post a broken file.
 3. Custom Haxe SKILL.md (F3/F5): build a thin one now (brand, footer, table conventions) [recommended] vs
    rely on the prebuilt anthropic skills only and put guidance in the prompt. The custom skill is the only
    content we own and it changes rarely.
 4. Cost surface (F4): confirm in a smoke test whether code-execution billing arrives in the response cost
    header or only in a usage block, and wire Log Model Run to whichever is authoritative; the row price is
    the fallback floor either way.
