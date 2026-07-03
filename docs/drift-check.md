# Drift checks: keep the repo == live reality

## Why

Several systems are edited **live** (via MCP/UI) but **mastered by the repo**. Live-first edits
without a write-back silently rot the repo (ADR-038 was deployed and never exported; a live
`model_routing` change was left as a forward-note). The CLAUDE.md rule *"live changes must be
written back"* states the discipline; these checks make a missed write-back **fail loudly** instead
of relying on memory. They **report** drift — they do not auto-fix, because drift is often
**bidirectional** (the repo is sometimes the correct/ahead version), so a human picks the direction.

## Coverage

| System | Repo master | Check | Status |
|---|---|---|---|
| n8n workflows | `n8n/workflows/*.json` | `scripts/check-workflow-drift.mjs` | **implemented** |
| Supabase schema/seed | `supabase/migrations/*.sql` | (designed below) | scoped, not built |
| LiteLLM models | `litellm-config.yaml` | (designed below) | scoped, not built |

## n8n check (implemented)

`node scripts/check-workflow-drift.mjs` (needs `N8N_API_KEY`; optional `N8N_API_URL`, default
`https://agents.skalus.com/api/v1`).

- Matches each repo workflow to the live one **by `name`** (no hardcoded IDs).
- Compares **behaviour only** — normalises away node `notes`, canvas `position`, UI
  `cachedResultName`/`cachedResultUrl`, `workflowInputs.schema` (UI-derived), the internal-only
  `binaryMode` setting, and connection **key order**.
- Reports per workflow `ok` / `DRIFT` (with added/removed/changed nodes, connection/settings diffs).
- Exit `0` = all match, `1` = drift, `2` = misconfig (no API key).
- **Limitations:** reports, never fixes; only checks workflows that exist in the repo (a live-only
  workflow with no repo file is invisible — enumerate live separately if that matters); requires the
  n8n public API (the interactively-authenticated MCP server is absent in headless/CI).

Expected non-empty output is fine **only** when matched by a deliberate, documented deferral — see
`architecture/workflow-repo-live-reconciliation.md`. As of 2026-06-11 the check flags **two** deferred
files (assemble-context, context-gather); `agent-orchestrator` and `read-input` were reconciled to live
(the no-attachment empty-return fix) and now match.

## Re-exporting from live (fixing n8n drift)

When the check flags a workflow you edited live as drifted (repo behind live), write it back with:

```
N8N_API_KEY=...  node scripts/export-workflows.mjs read-input.json agent-orchestrator.json
```

- **Explicit files only** — it never mass-exports, so it can't clobber a file whose drift direction you
  haven't decided. Name exactly the files to overwrite.
- Re-exports the **whole** workflow from live, not a patch: n8n's partial-update API auto-sanitises every
  IF/Switch node's condition options on any edit (`v2→v3`, `loose→strict`), so a surgical hand-patch
  silently leaves those untouched nodes drifted. A full re-export is the only reliable way to go green.
- Mirrors the check's normalisation (strips `schema`/`cachedResultName`/`cachedResultUrl`, keeps live node
  `notes`, compacts positions) and **preserves each repo file's existing `active` flag**.
- Diffs are larger than the behavioural change (inline→expanded re-formatting) — trust the green check,
  not a line count. Re-run `check-workflow-drift.mjs` afterwards to confirm.

## Supabase check (design)

Harder than n8n because the master is a *migration history*, not a snapshot. Two options:

1. **Schema diff** — apply migrations to a throwaway/branch DB, `pg_dump --schema-only` both it and
   live, diff. Catches structural drift (columns, indexes, constraints) but is heavy and misses
   *seed-data* drift (which is exactly what bit us: `model_routing.temperature`).
2. **Targeted seed assertions** (recommended first step) — a small SQL/script that checks the rows
   the pipeline depends on against expected values, e.g. *no active `model_routing` row sends a
   `temperature` to a model that rejects it*; *every `(impact, modality)` has exactly one active
   row*. Cheap, runs against live, and would have caught the Fable 5 hotfix gap directly.

Status: not built. Recommend starting with a `model_routing` seed-assertion check.

## LiteLLM check (design)

Compare the **deployed** model list (`GET /model/info` on the LiteLLM gateway, or the running
container's mounted `litellm-config.yaml`) against the repo `litellm-config.yaml` — alias names and
`litellm_model` targets. Status: not built; low drift surface today but in scope once Block 3 edits
the aliases.

## Enforcement — roadmap

1. **Now: manual.** Run `node scripts/check-workflow-drift.mjs` before committing workflow changes
   and at the end of a session. CLAUDE.md points here.
2. **Next: CI advisory.** A GitHub Action (or scheduled job) runs the n8n check and posts results;
   non-blocking at first. Needs `N8N_API_KEY` as a CI secret. The MCP servers are **not** available
   headless, so CI must hit the public API directly (as the script already does).
3. **Later: blocking.** Once the deferred-drift list is empty and the check is stable, promote to a
   pre-commit hook / required CI gate. On Windows, wire via a git `pre-commit` hook or a Claude Code
   `PreToolUse`/`Stop` hook calling the script (prefer a `.bat`/`node` invocation per environment).
   Keep an allowlist or a "known-deferred" file so intentional deferrals don't block — never let a
   blocking check tempt anyone to skip it.

## Adding a new live-mastered system

When a new system becomes live-editable with a repo master, add a row to the coverage table, write
its check here, and add a bullet to the CLAUDE.md *"Live changes must be written back"* section.
