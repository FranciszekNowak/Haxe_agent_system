# ADR-053 Block 8 — lane switch + orchestrator wiring + retire research: build + live-DoD findings

**Status: DONE 2026-06-19.** The orchestrator now reads a `config.agent_lane` flag (`managed` | `bare`)
and routes Stage B to either the new managed lane (`Execute Agent Session → Render Agent Output → Post
Reply`) or the existing bare lane (`Execute LLM Call → Post Reply`). The research workflows are retired from
Stage A (web search is in-harness on the managed lane). The flag defaults to **`bare`** until the Block 9
cutover. Proven live against the production Anthropic Managed Agents API + our live n8n on both lanes and the
fail-safe path. The bare lane stays the default and the verified failover.

## What was built (4 parts)

### 1) `config.agent_lane` flag + the lane switch (orchestrator `Agent Orchestrator (v1)` `a8XKaijkMFNBpRBa`)

New `config.agent_lane` row (key/value `config` table, default `'bare'`). The orchestrator's `Context OK?`
true branch now flows into a lane-resolution group instead of straight to `Call Execute LLM`:

`Context OK?` (true) → **`Read Agent Lane`** (Postgres `select value as agent_lane from public.config where
key='agent_lane'`, `onError=continueRegularOutput`, `alwaysOutputData`) → **`Resolve Lane`** (Code) →
fans out to **`Lane = managed?`** (IF) and **`Lane Unreadable?`** (IF).

- `Resolve Lane` re-reads the full Stage A context from `$('Call Assemble Context')` and **spreads it**
  (`Object.assign({}, ctx, {agent_lane, lane_unreadable})`) so the bare lane's existing
  `Call Execute LLM` input mapping (`$json.prompt`, `$json.impact`, …) keeps resolving unchanged downstream.
- **Fail-safe:** a value that is neither `managed` nor `bare` (absent row, malformed, or a DB error where
  `continueRegularOutput` passes the input item through with no `agent_lane`) → `lane_unreadable=true` and
  `lane='bare'`. `Lane Unreadable?` true → **`Alert Lane Unreadable`** (WARN via `Post Alert (v1)`,
  source `agent-orchestrator/lane-flag`). So an unreadable flag fails safe to the bare lane **and** is loud.
- `Lane = managed?` false → the existing `Call Execute LLM` (bare lane, byte-identical behaviour); true →
  the new managed branch.

### 2) The managed Stage-B branch (wired end-to-end)

`Lane = managed?` (true) → **`Call Execute Agent Session`** (`Rtb1cZbmUqmfGD98`) → **`Session OK?`** (IF) →
(true) **`Call Render Agent Output`** (`vPbbN4UQj0LAAtiV`) → **`Call Post Reply (Managed)`** (`t17moGs7Vxo5ZcFv`).

- **Stage B inputs** map from the spread Stage A context: `user_message`=`prompt`, `impact`,
  `input_images_json`=`image_blocks_json`, `clickup_task_id`, `caller_user_id`, `process_type`,
  `triggered_by`, `invocation_type`. `session_id` is intentionally NOT passed (Execute Agent Session's
  `Is Recursive?` keys on a non-empty `session_id`; omitting it forces the fresh-session path).
- **Render** takes `output_message` + `clickup_task_id` from the session result and returns the Post Reply
  contract `{rendered_delta, image_manifest, image_models, total_image_cost_pln}`.
- **`Call Post Reply (Managed)`** is a SECOND caller of the shared `Post Reply (v1)` workflow (the bare lane's
  `Call Post Reply` is untouched). It passes the adapter's `rendered_delta`/`image_manifest`/`image_models`/
  `total_image_cost_pln`, plus **`doc_attachments`=`Execute Agent Session.doc_files`** and
  **`session_id`=`Execute Agent Session.session_id`** straight through (Block 7's dormant `Has Docs?` branch),
  and `model`=`model_used`, `clickup_task_id`/`reviewer_user_id`/`triggering_comment_id` from Stage A.
  `web_sources='[]'` (in-harness search; the agent embeds citations in its text), `cost_pln=0` (see the
  footer-cost note below).
- **Session-empty guard:** `Session OK?` false (empty `output_message`, i.e. a create/send/terminated
  failure) → **`Alert Session Empty`** (WARN, source `agent-orchestrator/managed-session`) and **no empty
  reply is posted**. Execute Agent Session already fires its own CRITICAL on create/send failure internally,
  so the orchestrator guard is a deliberate WARN-level breadcrumb (no double-CRITICAL).
- **Render degradation surfaced:** `Call Render Agent Output` also fans out to **`Render Has Warnings?`** →
  **`Alert Render Warnings`** (WARN, source `agent-orchestrator/render`) so an image that can't be delivered
  (`[Obraz niedostępny]`) or a non-array `output_message` parse-fallback is not silent. The adapter returns
  `warnings[]` precisely for the caller to fire (Block 6 left this to Block 8).

### 3) Retire research from Stage A (`Assemble Context and Build Prompt (v1)` `GGTBvFBgGSNbtUR6`)

Removed the `Call Decide Research` node and reconnected `Call Workspace Search → Load Agent Rules` directly.
`Build Prompt` patched: dropped the `$('Call Decide Research')` reads (`web_findings`/`web_sources` now stay
empty) and forced `research_ok=true` (so the `Check Rules Loaded` health gate no longer fires a spurious WARN
for a retired dependency). The two live workflows `Decide Research and Deliver (v1)` and `Research the web
(v1)` are removed from the repo (`decide-research-and-deliver.json`, `research-the-web.json` deleted); see the
open item below on the live copies. **This affects both lanes** — the bare failover lane is now text+image
only, no web research (accepted: the managed lane has in-harness web search; the bare lane is a minimal
dormant failover).

### 4) `research_parameters` left dormant (no migration)

The `research_parameters` table is left in place, dormant. Nothing references it after the Stage A edit;
dropping it is a destructive change with no upside, so per the plan's "leave dormant or drop" option we
leave it (lower-risk; a future cleanup migration can drop it if ever wanted).

## Live DoD (all pass)

Driven via `scripts/test-subworkflow.mjs` against the orchestrator's `When Called` (NOT the Form Trigger),
producer-exact inputs (`triggered_by=explicit_mention`, `invocation_type=explicit`, reviewer `2521617`):

- **Bare lane** (`agent_lane='bare'`, task `869dhad2q`, exec 2827): `Read Agent Lane`→`bare`, `Lane =
  managed?` **false** → `Call Execute LLM` (Opus, 0.4363 PLN) → `If LLM Succeeded?` true → `Call Post Reply`
  posted (`updated=1`); `Call Execute Agent Session` did **not** fire; `Lane Unreadable?` false dead-ended
  (no WARN). The bare lane completes through the new switch.
- **Managed lane, success path** (`agent_lane='managed'`, clean text-only task `869dtc19x` impact `Niski`→Haiku,
  exec 2892): `Read Agent Lane`→`managed`, `Lane = managed?` **true** → `Call Execute Agent Session`
  (`status:completed`, Haiku, `warnings:[]`) → `Session OK?` true → `Call Render Agent Output`
  (`rendered_delta` = the agent's text ops, `image_manifest:[]`, `warnings:[]`) → `Render Has Warnings?`
  false → `Call Post Reply (Managed)` posted (`updated=1`). End-to-end managed delivery to ClickUp.
- **Managed lane, session-failure guard** (execs 2849, 2873): two real session failures (Krytycznie ważne→
  Fable-5-unavailable; and the test task's stale image → "Could not process image") both routed correctly to
  managed, returned empty `output_message`, hit `Session OK?` **false** → `Alert Session Empty` WARN, **no
  empty reply posted**. The guard works.
- **Fail-safe flag** (`agent_lane='__invalid__'`, exec 2908): `Read Agent Lane`→`__invalid__` → `Resolve
  Lane` `lane_unreadable=true`, `lane='bare'` → `Lane = managed?` **false** → `Call Execute LLM` → `Call Post
  Reply` posted (bare lane still completes), AND `Lane Unreadable?` true → `Alert Lane Unreadable` WARN.
  Unreadable flag ⇒ bare + WARN, exactly as designed.
- **Drift:** `node scripts/check-workflow-drift.mjs` → **✓ all 32 workflows match live** (was 3 drifted).
  `agent-orchestrator` + `assemble-context` re-exported clean; the retired `decide-research`/`research-the-web`
  JSONs deleted (no longer iterated); the two pre-existing `read-input` + `workspace-search` drifts were pure
  n8n auto-sanitization (Merge default `numberInputs`, IF empty `options:{}`, node positions, one improved
  note) and were reconciled by re-export — behaviour-identical, no notes lost.
- **Alerts:** 0 CRITICAL, 9 WARN in the test window — all explained (the intentional fail-safe/guard WARNs;
  Execute Agent Session's own session-failure WARNs from the external Fable/image failures; and pre-existing
  test-task content issues on `869dhad2q` — broken.docx extraction, 17 unprocessable images). The clean
  managed run on `869dtc19x` produced zero warnings.
- Test `agent_runs` rows (591–600) deleted; disposable task `869dtc19x` deleted; `869dhad2q` impact field
  restored to `Krytycznie ważne`; `config.agent_lane` restored to `bare`. Test sessions/Files-API images left
  per the Block 3/4/5 precedent (can't delete without exposing the key on the CLI; harmless).

## Findings (non-obvious)

1. **`Resolve Lane` must re-read Stage A context, not rely on the Postgres node's passthrough.** A Postgres
   node on success *replaces* the item with its query rows (losing the Stage A fields); on error
   (`continueRegularOutput`) it passes the input through (no `agent_lane`). The Code node sidesteps both by
   spreading `$('Call Assemble Context').first().json` and treating a missing/garbage `agent_lane` as
   unreadable → bare. This is what makes a DB error and a missing row both fail safe.
2. **The managed lane needs its own Post Reply caller.** The bare and managed lanes feed Post Reply from
   different upstreams (bare: Execute LLM output; managed: Render output + session metadata incl.
   `doc_attachments`/`session_id`). Two `executeWorkflow` callers of the one shared `Post Reply (v1)` is the
   honest unification (the workflow is shared; the mappings differ) — not a forked Post Reply.
3. **`agent_runs.impact` rejects `__default__`** — already handled inside Execute Agent Session's cost row
   (`cost_impact` sanitised); no orchestrator change needed.
4. **The Fable-5-unavailable failure on Krytycznie ważne is real and pre-dates Block 8** (see the
   `critical-tier-fable5` memory). On the managed lane it surfaces as a clean session failure → `Session OK?`
   guard → WARN, no broken post. It is a Block 9 / Fable-access concern, not a wiring defect — but **the
   managed lane currently cannot serve a Krytycznie ważne task** until Fable access is restored or
   `agent_routing` repoints that tier.
5. **The managed-lane comment footer cost is deferred to Block 9.** `cost_pln=0` / `total_image_cost_pln=0`
   are passed to Post Reply, so the footer reads "koszt: 0,0000 PLN" on the managed lane. The *real* cost is
   logged to `agent_runs` (session cost via Execute Agent Session's `Log Session Cost`; per-image via
   Generate Images Parallel). The plan explicitly assigns the footer reconciliation to Block 9; calling it
   out so it is not mistaken for free.

## Silent-failure modes covered

- **Unreadable/absent/malformed `config.agent_lane`** → `Resolve Lane` fails safe to `bare` + `Alert Lane
  Unreadable` WARN (DoD-verified with `__invalid__`).
- **DB unreachable when reading the flag** → `Read Agent Lane` `onError=continueRegularOutput` passes the
  item through → no `agent_lane` → treated as unreadable → bare + WARN (same path).
- **Managed session returns no deliverable content** (create/send/terminated failure) → `Session OK?` false
  → `Alert Session Empty` WARN and no empty reply posted (Execute Agent Session also CRITICALs internally).
- **Output adapter degradation** (produced image undeliverable → `[Obraz niedostępny]`, or non-array
  `output_message` parse-fallback) → `Render Has Warnings?` → `Alert Render Warnings` WARN; the rest of the
  comment still posts.
- **A retired research workflow still referenced** → removed the only call (Stage A); drift check + a live
  run confirm no orphan call. (Live workflow copies still exist — see open item.)

## Open items carried forward

- **The two live research workflows still exist.** `Decide Research and Deliver (v1)` (`Ccc9y0AcLwL022FY`)
  and `Research the web (v1)` (`BdZ9Chhqs691Ljlk`) are removed from the repo and have **no remaining
  callers**, but the live deletion was blocked by the safety classifier (destructive action on shared infra,
  not operator-named). They are harmless (sub-workflows with no caller; `research-the-web`'s only trigger is
  `When Called`, which nothing invokes). **Operator action:** delete them in the n8n UI, or grant the delete
  permission, to finish the retirement. Drift is already clean without this (the repo no longer tracks them).
- **Block 9** flips `config.agent_lane='managed'` as the default after the full cross-modality DoD matrix,
  reconciles the comment footer cost, writes the GDPR record, and rewrites `current.md` §2/§3/§15. **Do not
  flip the default to `managed` before the Fable-tier (Krytycznie ważne) routing is serviceable** — today a
  Krytycznie ważne task fails on the managed lane.

## Net effect on the plan

- Block 8 **DONE**. **Block 9 next** (end-to-end cutover, GDPR, write-backs, flip the default). The orchestrator
  routes by flag; the managed lane is wired end-to-end and reachable today via `config.agent_lane='managed'`;
  the bare lane remains the default and the verified failover; research is retired from Stage A.
