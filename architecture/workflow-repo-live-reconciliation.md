# Workflow repo↔live reconciliation tracker

**Why this exists.** ADR-038's multimodal deploy (and other live edits) changed the running n8n
graph without re-exporting the JSON, so `n8n/workflows/*.json` drifted from live. Block 1 (ADR-043)
re-baselined the repo against live. This file records the drift found and, for anything **not yet
reconciled**, exactly what to fix and in which block — so a future block can finish the job without
re-deriving the analysis.

**Key finding — drift is bidirectional.** In some workflows the *repo* held the correct/ahead version
and *live* had regressed (e.g. execute-llm-call's deterministic return). In others *live* was ahead
(ADR-038 modality work). So **never blindly dump live over repo** — check direction per node. Reconcile
by behaviour, preserving curated node `notes` (live almost always lacks them).

Method: `node tmp-drift-check.mjs`-style behavioural diff (ignore `notes`, `position`, UI
`cachedResult*`, `workflowInputs.schema`, `binaryMode`, connection key-order). Live IDs are in
`architecture/current.md` / the master plan.

## Status (as of Block 1, 2026-06-11)

| Workflow | Behavioural drift | Direction | Status |
|---|---|---|---|
| invoke-model | messages-based multimodal + modality routing + Gemini label | repo-ahead impl + live-ahead routing → merged | **RECONCILED** (fix-forward deployed to live; repo==live) |
| execute-llm-call | sole-terminal return fix; `modality` input/mapping | repo-ahead (return fix) + live-ahead (modality) → merged | **RECONCILED** (bug-2 fix deployed to live; repo gained modality; repo==live) |
| research-the-web | `triggered_by: 'search_step'` hardcode | live-ahead (ADR-035/009 logging) | **RECONCILED** (repo updated) |
| decide-research-and-deliver | — (only UI schema/cachedResultUrl) | cosmetic | match — no action |
| workspace-search | — (only cachedResultUrl); live has richer node notes | cosmetic + live-ahead notes | match — optionally enrich notes at Block 2 |
| cu-webhook-producer, error-handler, fable-access-monitor, fx-freshness, fx-rates-daily, log-model-run, pd-verifier, post-alert, post-reply | — | — | match |

## Deferred — reconcile in a later block

These have **real behavioural drift** left in the repo. Each is re-exported when its owning block edits
it live (per the "always re-export after a live change" rule in CLAUDE.md).

### agent-orchestrator → **RECONCILED in Block 2 (2026-06-11)**
- `Call Execute LLM`: live adds `modality` → invoke-model mapping (`={{ $json.modality || 'text' }}`) + schema entry. **live-ahead.**
- `Alert Status Failed`: live sets `onError: continueRegularOutput`. **live-ahead.**
- **Resolution:** the repo file already carried the `modality` mapping and `Alert Status Failed`
  `onError` (the tracker over-stated the drift). Block 2 dropped the `personal_data` passthrough on both
  sides; `check-workflow-drift.mjs` now reports repo == live.

### assemble-context-and-build-prompt → **RECONCILED in Block 2 (2026-06-11)**
- `Build Prompt` (jsCode): live adds the `modality` line + `image_blocks_json` + a `pd_verifier_ok` flag. **live-ahead.**
- `Check Rules Loaded`: live adds context-health conditions (context_gather/workspace_search/pd_verifier) + v3/strict. **live-ahead.**
- `Alert Rules Missing`: live repurposed to a context-health degradation alert (`source=assemble-context/context-health`). **live-ahead.**
- **Resolution:** the repo file already carried the ADR-038 context-health/modality work (modality line,
  `image_blocks_json`, the `*_ok` flags, the context-health alert) — the tracker over-stated the drift.
  Block 2 removed the PD verifier call (+ rewire), the `personal_data` mappings, the `pd_verifier_ok`
  flag, and the `r4`/`pd_verifier=` context-health bits on both sides; `check-workflow-drift.mjs` now
  reports repo == live (12 nodes).

### context-gather → when next edited (low priority; **do-not-touch scope**)
- `IF L0..L4 has parent`: live upgraded conditions to `typeValidation: strict`, `version: 3` (n8n bump). **live-ahead, benign.**
- This is the subtask-tree read (master-plan do-not-touch guardrail). No PD logic. Reconcile only when a future block legitimately edits it.

### read-input → when next edited (low priority; **do-not-touch scope**)
- Most "drift" is the repo writing explicit n8n defaults live omits (`language: javaScript`, `authentication: none`, `mode`, `numberInputs`) — **semantically equal, not real drift.**
- One real bit: `Classify Attachment` switch rules upgraded to `caseSensitive: true` / `typeValidation: strict` / v3. **live-ahead, benign** (image/PDF reading verified working).
- The reading path is the master-plan do-not-touch guardrail. Reconcile only when a future block edits it.
