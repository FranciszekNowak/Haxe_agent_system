# ADR-063: Structured tool-call output delivery (`deliver_output` contract)

Status: **Accepted** (2026-06-27 — both lanes consume the contract; the managed lane is deployed and
verified end-to-end, the bare lane is repo-built and dormant pending a VPS key refresh). Master plan:
`architecture/Build plans/adr-063-structured-output-delivery/master-plan.md`.

## Context

Realistic image- and document-bearing agent comments repeatedly arrive in ClickUp as **plain
text** — the inline image and rich formatting vanish. Patched four times (ADR-036, ADR-053
Block 9 ×2, ADR-059) and it kept recurring.

The downgrade is **not** in `Post Reply (v1)` (which faithfully posts whatever ops it is handed —
zero `post-reply/*` alerts in 30 days). It is one step earlier, in **`Render Agent Output (v1)` →
`Parse Blocks`** (managed lane) and its KEEP-IN-SYNC twin **`Image Resolver (v1)` →
`Resolve & Explode Blocks`** (bare lane). The drafting model is required to return its **entire**
answer as a single fenced JSON block-array; a hand-rolled `parseBlockArray()` repair routine
parses it, and on **any** JSON defect falls back to one plain-text block — silently dropping every
image/doc block. The alert that actually fires is
`agent-orchestrator/render → output-adapter/parse-fallback`, repeatedly on real tasks `869dux9ne`,
`869dw6wtx`, `869dp7ww2`.

"Complex/realistic" content breaks the parser more because richer answers carry more of what
defeats hand-parsed JSON: Polish typographic quotes (`„…"`), multi-line markdown, tables, a
quote-before-comma, a prose preamble. Each past patch killed one defect class; the next complex
output found a new one. **The fragile contract — "LLM hand-writes JSON we hand-parse and
hand-repair" — is itself the defect.** (A base64-corruption-across-boundaries theory was
considered and rejected on evidence: 1.3–1.6 MB manifests delivered intact; n8n v2 has no payload
ceiling; the upload-failed WARN never fired.)

## Decision

Replace the free-text JSON block-array protocol with a **`deliver_output` custom tool whose input
schema *is* the block array**. The agent submits its final answer by **calling `deliver_output`**
instead of emitting a fenced JSON string as free text. The Anthropic API returns tool inputs as
**syntactically-valid, parsed JSON objects** — eliminating the entire defect class structurally.
`parseBlockArray()` and its twin are **deleted, not extended** (Blocks 3 and 4).

This is the design that ages well (CLAUDE.md "build vs buy" + "ages well"): we consume the
platform's JSON-validity guarantee rather than custom-building a parser/repair that every new
content shape defeats. Applied to **both lanes** (operator-chosen). Supersedes the free-text
block-array protocol of **ADR-053 #4** and the multimodal spec **§1 / §3.1**.

### Why a flat item schema, not nested `oneOf`

The guarantee we rely on is that the tool input arrives as **syntactically valid parsed JSON** —
that is the whole defect class. The Anthropic API uses `input_schema` to *steer* generation; it
does **not** hard-reject inputs that miss a deep `oneOf`/discriminator branch. A flat item schema
(`type` enum + per-field descriptions) generates more reliably and is unambiguous when paired with
the per-type field table below. The strict per-type/per-lane field rules are documented here (the
human SSOT), not encoded as JSON-Schema `required` at the item level — at the array-item level only
`type` is required, because requiredness is per type and per lane.

## The contract

`deliver_output` is declared on the managed agent in `sync-agent-definitions.json → Build System`
`tools[]` (mirroring `extract_clickup_task`), and on the bare lane via the `tools` + forced
`tool_choice` on the single LiteLLM/Anthropic completion. **One schema, both lanes.**

The tool input is an object `{ "blocks": [ … ] }` (Anthropic tool inputs must be objects; the
existing reader already accepts a `{blocks:[…]}` wrapper). `blocks` is the ordered block array.

### Canonical `input_schema` (copy verbatim into both lanes)

```json
{
  "type": "object",
  "properties": {
    "blocks": {
      "type": "array",
      "description": "Uporządkowana lista bloków tworzących finalną odpowiedź. Renderowane w kolejności (pole order lub kolejność tablicy). CAŁA treść oraz wszystkie obrazy/dokumenty muszą być przekazane jako bloki — nic poza wywołaniem tego narzędzia nie trafia do odbiorcy.",
      "items": {
        "type": "object",
        "properties": {
          "type":  { "type": "string", "enum": ["text", "image", "doc"],
                     "description": "Rodzaj bloku: 'text' = treść markdown; 'image' = obraz (wygenerowany lub osadzony z załączników); 'doc' = plik biurowy (xlsx/docx/pptx/pdf) zapisany do wyjść sesji, dołączany jako załącznik." },
          "order": { "type": "integer", "description": "Opcjonalna pozycja renderowania (rosnąco). Pominięte => kolejność w tablicy." },

          "md":    { "type": "string", "description": "(bloki text) Treść markdown po polsku: nagłówki, listy, tabele, pogrubienia, linki." },

          "mode":  { "type": "string", "enum": ["generate", "embed_input"],
                     "description": "(bloki image) 'generate' = nowy obraz; w lane managed wstaw w polu ref file_id zwrócone przez narzędzie generate_image. 'embed_input' = osadź ISTNIEJĄCY załącznik zadania, podając jego ref z sekcji „Załączone obrazy”." },
          "ref":   { "type": "string", "description": "(bloki image) Dla mode=generate (lane managed): file_id zwrócone przez generate_image w TEJ sesji. Dla mode=embed_input: ref załącznika wejściowego DOKŁADNIE jak w sekcji „Załączone obrazy”." },
          "source_ref":     { "type": "string", "description": "(bloki image, mode=embed_input) Opcjonalny identyfikator źródłowy załącznika, gdy podany obok ref." },
          "prompt":         { "type": "string", "description": "(bloki image, mode=generate — WYŁĄCZNIE lane bare) Opis obrazu do wygenerowania przez resolver. W lane managed NIE używaj prompt — obraz tworzysz wywołując generate_image i podajesz zwrócone file_id w ref." },
          "aspect":         { "type": "string", "description": "(bloki image, mode=generate — lane bare) Proporcje, np. \"1:1\", \"16:9\"." },
          "size":           { "type": "string", "description": "(bloki image, mode=generate — lane bare) Rozdzielczość \"SZERxWYS\" w pikselach, tylko gdy potrzebna konkretna." },
          "reference_refs": { "type": "array", "items": { "type": "string" },
                              "description": "(bloki image, mode=generate — lane bare) Lista ref obrazów wejściowych użytych jako referencje wierności." },

          "filename": { "type": "string", "description": "(bloki doc) Nazwa pliku zapisanego do wyjść sesji (np. \"Analiza.xlsx\"). Umieszcza i podpisuje załącznik w wybranym miejscu; system dopasuje nazwę do autorytatywnej listy plików wyjściowych sesji i dołączy właściwy plik. NIE podawaj file_id." },

          "caption": { "type": "string", "description": "(bloki image/doc) Krótki podpis renderowany pod obrazem / przy załączniku." },
          "alt":     { "type": "string", "description": "(bloki image/doc) Tekst alternatywny / opis dla dostępności." }
        },
        "required": ["type"]
      }
    }
  },
  "required": ["blocks"]
}
```

### Per-block-type field table

| Block | Field | Req? | Lane(s) | Meaning |
|-------|-------|------|---------|---------|
| **text** | `md` | required | both | Markdown body (PL). |
| | `order` | optional | both | Render position; defaults to array index. |
| **image** | `mode` | required | both | `generate` or `embed_input`. |
| `image / generate` | `ref` | required (managed) | managed | `file_id` returned by the `generate_image` tool in this session. Managed-lane generation is done **by the tool**, not the resolver; the block only carries the resulting file_id. |
| | `prompt` | required (bare) | bare | Prompt the resolver generates from. **Managed lane must not set `prompt`.** |
| | `aspect`, `size`, `reference_refs` | optional | bare | Generation params (bare-lane resolver only). |
| `image / embed_input` | `ref` | required | both | Input-attachment ref, exactly as shown in „Załączone obrazy". |
| | `source_ref` | optional | both | Source attachment id, resolved by `source_ref` OR `ref` (ADR-059). |
| **image (any)** | `caption`, `alt` | optional | both | Caption rendered under the image; alt text. |
| **doc** | `filename` | required | both | Name of a file the agent saved to session outputs. |
| | `caption`, `alt`, `order` | optional | both | Placement caption / alt / position. |

**Lane asymmetry (preserved, not invented):** a `mode:"generate"` block means different things per
lane. In the **managed lane** the image is already produced by the `generate_image` MCP tool and
the block carries its `ref` (`file_*` file_id); the resolver fetches that file. In the **bare lane**
the resolver generates from `prompt`/`aspect`/`size`/`reference_refs`. This mirrors the existing
protocol exactly; ADR-063 changes the *delivery channel*, not the image path.

### Office-doc block resolution (the previously-skipped block)

Office docs were historically **not** agent-emitted: `Execute Agent Session (v1) → Build Final
Output` enumerates them authoritatively from the Files API
(`GET /v1/files?scope_id=<session>`, downloadable office MIME types → `doc_files[]`), with the
explicit rationale *"the AUTHORITATIVE, agent-independent source of produced doc file_ids (we do
not rely on the agent emitting a file_id it may not reliably know)."* Post Reply then attaches
them. Doc blocks were skipped in the renderers for that reason.

The `doc` block adds **placement + captioning** without weakening that robustness:

1. The agent supplies a **`filename`**, never a `file_id`.
2. The renderer (Block 3) matches `filename` against the authoritative `doc_files[]` enumeration and
   attaches **that** file at the block's `order` position. The file_id is always the
   platform-enumerated one — the agent's known-file-id fragility never enters the path.
3. **Safety net:** any enumerated `doc_files[]` entry **not** referenced by a `doc` block is still
   appended at the end (today's behavior is the floor — a produced document is never dropped because
   the agent forgot to place it or named it slightly differently).
4. A `doc` block whose `filename` matches **no** enumerated output → no attachment + a WARN
   (`output-adapter/doc-ref-not-found`): the agent referenced a document it did not actually
   produce. This is a loud protocol violation, not a silent drop.

Filename matching is exact-then-basename-normalized (Block 3 detail); the safety net makes a near
miss non-fatal regardless.

**Implementation status (Block 5, 2026-06-27 — what actually shipped vs. deferred).** Block 3 built the
renderer to **skip `doc` blocks entirely**: office docs are attached by the *authoritative*
`doc_files[]` enumeration (`Execute Agent Session → Build Final Output` → orchestrator → Post Reply),
which is exactly safety-net rule #3 above and is the long-standing, robust behavior. So of the four rules:
**#1 (agent supplies `filename`, never a file_id) and #3 (every produced doc is attached) are LIVE**, while
**#2 (place/caption a doc at its block's `order`) and #4 (`doc-ref-not-found` WARN) are NOT yet implemented**
— the renderer never reads `doc` blocks. The end-to-end DoD confirmed this is correct and non-lossy: the
agent emitted a `doc` block for `Analiza_produktu.xlsx`, the file was enumerated and attached, and nothing
was dropped. The persona contract (Block 5) was written to match this reality — it tells the agent that
saving the file to session outputs is sufficient for attachment and that the `doc` block is an *optional*
marker (it does **not** promise per-block ordering or a rendered caption). Per-block doc placement/caption
remains a clean future enhancement (read `doc` blocks in `Render Agent Output → Parse Blocks`, match
`filename` → `doc_files[]`, attach at `order`, WARN on a non-produced filename) and would close rules #2/#4.

### Worked example

```json
{
  "blocks": [
    { "type": "text", "order": 1, "md": "## Wyniki\nPrzygotowałem planszę i pełną analizę." },
    { "type": "image", "order": 2, "mode": "generate", "ref": "file_01ABC...", "caption": "Plansza produktowa", "alt": "Wizualizacja produktu na białym tle" },
    { "type": "doc", "order": 3, "filename": "Analiza_GPSR.xlsx", "caption": "Pełna analiza ryzyka (GPSR)" },
    { "type": "text", "order": 4, "md": "## Pytania do zlecającego\nCzy wariant kolorystyczny ma być finalny?" }
  ]
}
```

## Consequences

- **The routine, alert-less collapse of image/doc comments to plain text is structurally
  eliminated** — there is no parse step left to fail. `parseBlockArray()` and its KEEP-IN-SYNC twin
  are deleted in Blocks 3/4; the `output-adapter/parse-fallback` and `multimodal/parse-fallback`
  WARNs (and the `preamble-stripped`/quote-repair machinery) cease to exist.
- **New, rarer failure mode, loudly covered:** the agent fails to call `deliver_output` → text
  render + WARN (a protocol violation, not a parse defect). A `doc` block naming a non-produced
  file → `doc-ref-not-found` WARN.
- **Field names are unchanged** from today's protocol (`type/md/mode/ref/source_ref/prompt/aspect/
  size/reference_refs/caption/alt/order`) plus the new `doc.filename`, so Blocks 3/4 read fields
  directly with no translation layer.
- **One schema, both lanes.** A future block-schema field is added here once and consumed by both
  the managed renderer and the bare resolver — no more "add the key to `KNOWN` in both parser
  copies."
- **Supersession:** ADR-053 #4 (free-text fenced block array) and multimodal spec §1 / §3.1 are
  superseded by this contract; ADR-059's parser becomes dead code removed in Blocks 3/4. The
  supersession is finalized (status Accepted, spec text rewritten) in Block 5.
- **Rollout (all blocks complete, 2026-06-27):** Block 2 registered the tool + captured its input
  (managed), Block 3 made the managed renderer consume structured blocks (parser deleted), Block 4 gave
  the bare lane parity (forced `tool_choice`, twin parser deleted), and Block 5 flipped the persona
  output-format contract (`sync-agent-definitions.json → Build System`, CONV 13→14, re-synced to agents
  v19) and deployed all five workflows together for a single cut-over.

- **End-to-end verification (Block 5 DoD, managed lane, full spine).** A realistic image+document task
  (`869dwgvea`, now deleted) ran through the live orchestrator (exec 4512): the agent **called
  `deliver_output`** (`delivered_via_tool=true`), returning structured `output_blocks` (text +
  `mode:generate` image `file_011CcTfHKZPdT7GC4aLjvRN2` + `doc` `Analiza_produktu.xlsx`),
  `outcome=delivered`. `Render Agent Output` produced an `image_manifest` with the inline image and a
  74-op `rendered_delta` with **zero** warnings; Post Reply posted one threaded comment carrying the
  **inline image** and the **`.xlsx` attachment**. **Zero alerts fired**, and there is no `parse-fallback`
  path left to take. The text-only Post Reply regression was green. The bare-lane forced-tool-call
  round-trip was proven live against LiteLLM (Block 4) but the lane is dormant; bare go-live remains gated
  on refreshing the stale VPS `ANTHROPIC_API_KEY` (a separate, pre-existing infra issue — not an ADR-063
  defect).

## Date

2026-06-27
