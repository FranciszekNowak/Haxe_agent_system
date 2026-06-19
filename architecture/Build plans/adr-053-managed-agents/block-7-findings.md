# ADR-053 Block 7 — Post Reply office-doc delivery: build + live-DoD findings

**Status: DONE 2026-06-19.** The managed lane can now deliver office documents (xlsx/docx/pptx/pdf the
agent produces via Skills/code-exec) to ClickUp as **task attachments + a comment link**, gated by a
**structural validation gate** that blocks corrupt/wrong files (WARN + Polish note, never a broken
attachment), and records the attachment ids on the run's `agent_runs` row for erasure (ADR-044). Proven
live against the production Anthropic Managed Agents API + our live n8n. The managed lane stays **dormant**
(not wired into the orchestrator until Block 8) — these are the pieces Block 8 will thread between
`Execute Agent Session (v1)` and `Post Reply (v1)`.

## The design fork, resolved empirically (the key Block-7 decision)

The handoff flagged an open question: **does the agent reference a produced doc's `file_id` in its
block-array (a new `{type:file}` block), or do we enumerate the session's output files independently?**
Office-doc OUTPUT files (unlike images) ARE downloadable from the Files API (Block 0), so either path could
fetch the bytes — but only if we know the `file_id`.

Rather than guess, I built the enumeration first (needed regardless) and watched one live "make an xlsx with
111/222/333" run through `Execute Agent Session (v1)`. The result decided it:

- **`doc_files[]` enumeration works and is authoritative** — `GET /v1/files?scope_id=<session_id>` (both
  betas) listed the produced `raport-haxe.xlsx` (`file_011CcCNQW35o67xHLQsWEXCp`, xlsx mime, 4961 B,
  `downloadable:true`).
- **The agent did NOT reference the file_id.** Its `output_message` block-array was **text-only**: it named
  the file in prose ("✓ Plik został przygotowany. **Nazwa pliku:** `raport-haxe.xlsx`") but emitted no
  `{type:file}` block and no `file_id`.

**Conclusion: enumeration-authoritative.** We do not depend on the agent emitting a file_id it doesn't
reliably know (the same Haiku-follows-instructions fragility Block 6 hit with images). `Execute Agent
Session` lists the session's downloadable office-docs after idle and returns them; the agent just mentions
the file in prose so the comment reads coherently. This is more robust than the handoff's tentative
`{type:file}` guess and uses only Block-0-confirmed mechanics.

## What was built (4 parts)

### 1) Migration 038 — `clickup_attachment_ids` on `agent_runs`

A nullable `jsonb` array column (`038_agent_runs_attachment_ids.sql`, append-only). Recorded by Post Reply's
`Record Artifact` for erasure-readiness (ADR-044): the ClickUp attachment ids a run creates (office-doc task
attachments **+** inline image-comment attachments, folded together). ClickUp v2 still has no
delete-attachment API, so recording the ids is the erasure hook regardless. Bare-lane runs (no docs) leave
it `[]`.

### 2) `Execute Agent Session (v1)` — session-output doc enumeration

`Build Final Output` now, on a completed/partial outcome, lists the session's output files
(`GET /v1/files?scope_id=<session_id>`, both betas, key already in carried state), filters to
**`downloadable:true` + office-doc mime** (the OOXML trio + `application/pdf`), and returns
`doc_files[] = [{file_id, filename, mime, size_bytes}]` in the contract (alongside the existing
`session_id`). A ~2.5 s settle covers the post-idle index lag (Block 0). Fail-soft: a listing failure → a
`managed-agents/doc-list-failed` WARN + empty `doc_files` (the task still delivers its text/images). This is
the only `Execute Agent Session` change; the loop/cost path is untouched.

### 3) `Post Reply (v1)` — the office-doc delivery branch (the main change)

Two new contract inputs (`doc_attachments`, `session_id`); the bare lane never sets them, so the branch is a
no-op there (the shared workflow is unaffected). New flow off `Finalize Comment`:

`Has Docs?` → `Get Doc Key` (the `get_anthropic_key()` getter, keeps the key out of the inter-workflow
contract) → `Parse Docs` (one item per doc) → **`Download Doc`** (GET `/v1/files/{id}/content`,
`scope_id=session_id`, both betas; `onError=continueErrorOutput`) → **`Validate Doc`** → `Doc Valid?` →
(valid) **`Upload Doc`** (multipart → ClickUp task attachment, reusing the Block-10 upload pattern) →
`Build Doc Uploaded`; (invalid) `Build Doc Invalid`; (download-failed) `Build Doc Download Failed` →
`Merge Docs` (3-way) → `Aggregate Docs` → **`Append Doc Ops`** (appends a "Załączniki" section: a `📎`
link line per delivered doc, a Polish note per dropped doc) → `Is @mention?` (unchanged post path).
A side branch `Docs Dropped?` → `Alert Docs Dropped` fires one consolidated WARN via `Post Alert (v1)`.
`Record Artifact` extended (`$5::jsonb`) to write `clickup_attachment_ids` = image attachment ids
(`Rewrite Delta`) + doc attachment ids (`Append Doc Ops`).

**The validation gate** (the DoD's load-bearing piece) opens each downloaded file WITHOUT a zip library
(crypto/zlib are unavailable in Code nodes, CLAUDE.md): OOXML must be a `PK` ZIP, contain the
End-Of-Central-Directory record (`PK\x05\x06` → not truncated), `[Content_Types].xml`, and the type's
required part (`xl/workbook.xml` | `word/document.xml` | `ppt/presentation.xml` — stored as plaintext member
names in the zip). PDF must start `%PDF-`, contain `%%EOF` in the tail, and have `/Page`. This catches the
realistic failure modes — truncated download, empty file, wrong/mismatched content — and the bytes are read
via `this.helpers.getBinaryDataBuffer` (filesystem binary mode, same as Block 6's `Extract B64`).

### 4) Agent doc-output convention — `Sync Agent Definitions (v1)` CONV 3→4

The `Build System` contract now states: office docs are produced by a Skill and **saved to session outputs**;
the agent **must NOT** put them in JSON blocks or supply a `file_id` — **the system attaches each produced
doc automatically** — and should **mention the file in a `text` block** (name + contents) so the reader knows
what they got, and must not claim it "cannot attach a file." This codifies the enumeration-authoritative
decision. CONV 3→4 forced a re-sync (idempotency keys on `rules_sha256 + conventions_version`); all four
tier agents re-versioned to `conventions_version=4`, `all_synced=true`.

## Live DoD (all pass)

- **xlsx happy path** (`Post Reply (v1)` via `test-subworkflow.mjs`, fed the real produced
  `file_011CcCNQW35o67xHLQsWEXCp` + its `session_id`): `Download Doc` 200 → `Validate Doc` `valid=true` →
  `Upload Doc` → ClickUp attachment `715d0a88-…xlsx` → comment posted (id `90120230039676`) →
  `Record Artifact` `updated=1`, `clickup_attachment_ids=["715d0a88-…xlsx"]`. **The attachment, downloaded
  back from its ClickUp URL, opens (valid ZIP) and contains the fed numbers** — first cell values
  `<v>111</v> <v>222</v> <v>333</v>`. 0 alerts.
- **Deliberately corrupt output** (one run, two bad docs): (a) the real xlsx bytes declared `mime=pdf` →
  PDF gate rejected (`naglowek PDF nieprawidlowy`); (b) a bogus `file_id` → `Download Doc` 404 →
  download-failed. **Nothing was uploaded** (`doc_attachment_ids=[]`), the comment **still posted** with two
  Polish "nie udało się dołączyć pliku" notes, `Record Artifact` wrote `clickup_attachment_ids=[]` (no broken
  artifact recorded), and **exactly one consolidated WARN** fired via `Post Alert (v1)`
  (`post-reply/doc-delivery`). Alert channel: 0 CRITICAL, 1 WARN (the expected test-induced one).
- **Drift:** `post-reply`, `execute-agent-session`, `sync-agent-definitions` re-exported and **clean**; the 3
  remaining drifts (`decide-research-and-deliver`, `read-input`, `workspace-search`) are pre-existing and not
  ours (re-exporting post-reply cleared it from that list).
- Test `agent_runs` rows (589, 590) + the disposable ClickUp task `869dtbbk8` deleted. The produced session
  doc file + session left per the Block 3/4 precedent (can't delete without exposing the key on the CLI;
  harmless).

## Findings (non-obvious)

1. **The agent's office-doc output is prose-only** — it names the file but emits no `file_id` (confirmed
   live). So enumeration, not agent self-report, is the source of truth for produced docs. Mirrors the
   image-output fragility of Block 6, but here we sidestep it entirely (the file_id never has to round-trip
   through the model).
2. **Validation without a zip library is viable.** OOXML member names (`[Content_Types].xml`, `xl/workbook.xml`,
   …) are stored as plaintext in the zip's local + central headers, so a Buffer scan asserts "structurally an
   xlsx/docx/pptx with the required part present" without inflating anything — combined with the magic-bytes
   and EOCD checks it catches truncation and wrong-type files. No `crypto`/`zlib` needed.
3. **`responseFormat=file` + `getBinaryDataBuffer` is the proven binary read** on this filesystem-mode
   instance (Block 6); `item.binary.data.data` is only the storage marker. The Code node sets
   `binary.data.fileName`/`mimeType` so the multipart upload carries the right ClickUp filename.
4. **`Post Reply` is shared with the bare lane** — the doc branch is gated behind `Has Docs?` (empty
   `doc_attachments`), so the bare lane's behaviour is byte-identical. The new anthropic-key dependency only
   fires when docs are present.
5. The runtime validator flags `valid:false` on `Post Reply` for a **pre-existing** reason (`Aggregate
   Uploads` fanning out to `Rewrite Delta` + `Uploads Failed?` on `main[0]`) and IF-node false branches as
   "missing onError" — both false positives, not introduced by Block 7.

## Silent-failure modes covered

- **Corrupt/empty/wrong-type doc posted as valid** → the structural validation gate drops it → WARN + Polish
  note, never a broken attachment (DoD-verified).
- **Doc un-fetchable from the Files API** (expired/missing/network) → `onError` → download-failed drop → WARN
  + note, the rest of the comment still posts.
- **Upload to ClickUp fails** (`onError=continueRegularOutput`) → marked dropped → WARN + note; ClickUp has
  no delete-attachment API so a partial upload surfaces the orphaned ids in the WARN.
- **Session output listing fails** (in `Execute Agent Session`) → `managed-agents/doc-list-failed` WARN +
  empty `doc_files`; the task still delivers text/images rather than failing.
- **Unrecorded attachment id** → the existing `Record Artifact` 0-row WARN path (ADR-044); the erasure hub
  also records the inline image attachment ids now.

## Net effect on the plan

- Block 7 **DONE**. **Block 8 next**: lane switch flag + orchestrator wiring (thread `Execute Agent Session`
  → `Render Agent Output` → `Post Reply`, passing `doc_attachments` = `doc_files` + `session_id` straight to
  Post Reply alongside the adapter's `rendered_delta`/`image_manifest`) + retire the research workflows.
- **Render Agent Output (v1) needs no change for docs** — office docs are attachments (no markdown
  rendering), so Block 8 passes `doc_files` + `session_id` from Stage B to Post Reply directly; the adapter
  keeps owning text + inline images only.
- Office-doc OUTPUT files are downloadable, so Block 7's download path is **separate from the Block 6 image
  carrier** (images stay `purpose=agent`/non-downloadable → carrier bucket; docs → Files API direct).
