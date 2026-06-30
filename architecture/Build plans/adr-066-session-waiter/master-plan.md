# Master plan — Fix the managed-agent long-task delivery failure (ADR-066 + ADR-067)

> Repo SSOT for this work, surviving `/clear`. Every block starts by reading THIS file in full.
> Origin: investigation of the 2026-06-30 pptx run (ClickUp task `869dxn3d8`, session
> `sesn_017tJw1dSoJXUyBK1HKmPxnj`). Plan-mode source: `~/.claude/plans/there-are-several-things-silly-pillow.md`.

## Context — why this work exists

A high-impact task ("build a .pptx about the Haxe agent system from my ClickUp doc") ran through the
managed-agent lane and **failed to deliver its answer** despite the agent doing the work correctly.
Four failures, each root-caused:

1. **Doc link never reached the agent.** The triggering comment carried a `doc_mention` op (page
   `q7wz-44692`), but the serialization reads ClickUp's flat `comment_text`/`op.text`, and a
   `doc_mention` op has empty `.text` → blank gap. The agent fell back to `clickup_search` (lucky guess).
2. **Generated images can't be embedded in the .pptx.** `generate_image` (in-harness MCP, ADR-055)
   uploads bytes as `purpose=agent` (non-downloadable) + a Supabase carrier and returns only a `file_id`.
   Bytes never reach the session filesystem → a skill-built `.pptx` can't embed them. The agent burned
   ~4 min probing the filesystem, then fell back to vector-only visuals.
3. **A premature, confusing comment posted** (the agent's mid-work English narration).
4. **The real answer was never posted.**

3+4 are one mechanism: the session loop polls inside a **single n8n Code node** (`Execute Agent Session →
Poll Round`) bounded by an absolute **840 s soft deadline** (`Build Initial State → SOFT_DEADLINE_MS`,
under n8n's ~900 s per-node task-runner kill). After the early context tools (~09:46) all remaining work
(image gen via MCP, deck build, slide QA) produced **no client-side tool calls**, so the loop never
recursed — it sat in one node until 840 s fired at 09:55, returned `outcome='deadline'`, set
`output_message` to the last `agent.message` (the narration). `Build Final Output` → `status:partial`; the
orchestrator `Session OK?` gate publishes on non-empty `output_message`, so the **narration posted as the
answer**. The agent's real `deliver_output` fired at 10:02 — 7 min after n8n abandoned the still-running
remote session — with nothing left to consume it.

**Key structural fact:** raising 840 s alone cannot fix this. One Code node is capped at ~900 s, so a
21-minute task can never be polled to completion inside a single n8n execution. The agent session runs on
Anthropic's side independently of n8n (proven: it kept working 7 min after n8n quit, `deliver_output` still
queryable). Fix = **decouple the agent's wall-clock from any single n8n execution.**

ADR-063 (structured `deliver_output` tool) already shipped and works — it is *not* the bug; it never got
to run because the session was abandoned mid-task.

## Decisions taken (operator-chosen, 2026-06-30)

| Fork | Decision |
|------|----------|
| Long-task / timeout | **External "session waiter" service.** A small always-on Node process on the VPS holds one streaming (SSE; else long-poll) connection to the Anthropic session, services client-side tools, and calls n8n back by webhook when `deliver_output` lands. No node cap, no recursion-depth limit, arbitrarily long runs; also relieves the ADR-056 ~15-min spine ceiling for managed tasks. |
| Images in office docs | **Enable embedding.** `generate_image` returns a fetchable (signed) URL so the agent downloads bytes into the session and embeds them; the inline-comment path still uses `file_id`. |
| Doc-link drop | **Bundle the fix** — cheap, independent. |
| Premature narration | **Fail-loud guard** shipped first: a non-delivery outcome must never post mid-work narration. |

## ADRs

- **ADR-066** — Asynchronous managed-agent session via external waiter service (supersedes the synchronous
  held-poll loop of ADR-053/ADR-063 `Poll Round`).
- **ADR-067** — Downloadable generated-image bytes for in-document embedding (amends ADR-055).

## Block status

| Block | Scope | Status |
|-------|-------|--------|
| 0 | Verify assumptions (A1–A6) | ✅ DONE — GO (see block-0-findings.md) |
| 1 | Fail-loud guard: non-delivery never posts narration (+ CRITICAL alert) | ✅ DONE — verified live 2026-06-30 (commit pending) |
| 2 | Doc-link serialization fix (Detect Mention + Assemble Task Context) | ☐ TODO |
| 3 | Enable image embedding (image MCP handler signed URL + persona contract) — ADR-067 | ☐ TODO |
| 4 | Waiter service skeleton: deploy, health, env, dead-man's-switch — ADR-066 draft | ☐ TODO |
| 5 | Orchestrator split — async handoff (create session → hand to waiter → return) | ☐ TODO |
| 6 | Waiter event loop: SSE/long-poll, client-tool servicing (delegate to n8n), deliver_output capture | ☐ TODO |
| 7 | Finish-callback half in n8n: doc enumeration + cost + render + post (+ Block 1 guard) | ☐ TODO |
| 8 | Reliability + cutover behind `config.session_waiter.enabled`; reconciliation cron; finalize ADR-066 | ☐ TODO |

Each block: read this file → do one verifiable unit → write back (`architecture/current.md` + ADR + this
table) → commit → emit a handoff prompt.

## Block 0 — assumptions (DONE)

Verified GO; see `block-0-findings.md`. Carry-forward: waiter uses `GET /events` (dedup by id) as truth +
SSE for wakeups, reconnect/reconcile on stream close, must always resolve a pending tool; waiter is a
failure surface → health dead-man's-switch + "handed-off-but-not-finished" reconciliation cron are
mandatory (Block 4/8). A2 long-survival (Block 6) and A4 sandbox egress (Block 3) get live probes; both
have fallbacks and gate only their own block. Key facts: tool-result API = `POST /v1/sessions/{id}/events`
with `user.custom_tool_result` (custom_tool_use_id); managed key via DB `Get Anthropic Key` (hand to waiter
at handoff); VPS already runs Node services (`queue-consumer`, `zip-extractor`) on `haxe-agents_n8n-internal`.

## Block 1 — Fail-loud guard (ship first)

Discriminator is `outcome`, not text presence. Non-delivery (`deadline|max_rounds|terminated|poll_error`)
with `delivered_via_tool=false` is **not an answer**; keep the legit degrade-to-text path (`outcome='done'`
+ free text → existing `output-adapter/no-deliver-output` WARN). **Where:** `agent-orchestrator.json →
Session OK?` (`sok1`) — add the outcome check, route non-delivery to a new "post incomplete-status comment"
branch (Polish: *"Agent nie ukończył zadania w limicie czasu i nie dostarczył wyniku."*) via `Post Reply
(v1)`, flip status, fire **CRITICAL** `Post Alert` (`source: managed-agents/non-delivery`; details: task id,
outcome, duration). Never render `output_message` as the deliverable on this path. Keep `Build Final
Output`'s existing WARNs.
**DoD:** force a deadline via `test-subworkflow.mjs` on `Rtb1cZbmUqmfGD98` (small budget) → incomplete-status
comment, no narration; CRITICAL `non-delivery` in `alerts-since.mjs`; a normal `done`+free-text run still
degrades to text. Re-export the two workflows; `check-workflow-drift.mjs` clean; delete test rows/tasks.

### Block 1 — ready-to-execute implementation spec (live graph confirmed == repo, 2026-06-30)

Workflow: **Agent Orchestrator (v1)** `a8XKaijkMFNBpRBa`. Confirmed topology:
`Call Execute Agent Session → Session OK? [TRUE→Call Render Agent Output] [FALSE→Alert Session Empty]`.
The FALSE branch today posts **no** comment and never flips status off "W trakcie".

1. **`Session OK?`** (id `327820e7-8af5-4246-8fce-c76c3e8c8666`) — replace the `sok1` condition with the
   publishable-answer test (note: it must be FALSE for a non-delivery outcome even when `output_message`
   carries narration):
   ```
   ={{ ($json.delivered_via_tool === true && Array.isArray($json.output_blocks) && $json.output_blocks.length > 0)
       || ($json.outcome === 'done' && ($json.output_message || '').toString().trim() !== '') }}
   ```
   (`outcome` values from `Build Final Output`: delivered | done | deadline | terminated | max_rounds |
   poll_error | send_failed | create_failed. Only `delivered` and `done` are publishable.)
2. **New node `Call Post Reply (Incomplete)`** — `executeWorkflow` → Post Reply (v1) `t17moGs7Vxo5ZcFv`.
   Mirror `Call Post Reply (Managed)`'s input mapping for `reviewer_user_id`/`triggering_comment_id`/
   `model`/`cost_pln`/`clickup_task_id`/`session_id` (read from `Call Execute Agent Session` + `When Called`),
   set `image_manifest`/`image_models`/`doc_attachments` to `[]`, `total_image_cost_pln` 0, `web_sources` '',
   `completion` '', and a canned single-op `rendered_delta`:
   ```
   ={{ [ { text: 'Nie udało się dokończyć zadania w wyznaczonym czasie — agent nie dostarczył wyniku ('
        + ($('Call Execute Agent Session').first().json.outcome || 'brak')
        + '). Spróbuj podzielić zadanie na mniejsze kroki albo ponów zlecenie.' } ] }}
   ```
   (Verify Post Reply (v1) tolerates empty `completion` + a minimal `rendered_delta`; it flips status to
   Zakończono via `Set Status Zakonczono`, which also clears "W trakcie".)
3. **Rewire** `Session OK?` `main#1` (FALSE): `[ Call Post Reply (Incomplete), Alert Non-Delivery ]`.
4. **Repurpose `Alert Session Empty`** (id `694fcc5a-670b-41a1-96b3-81f4b84e7f83`) → rename `Alert Non-Delivery`:
   `severity: CRITICAL`, `source: managed-agents/non-delivery`,
   `message: "Sesja Managed Agents nie dostarczyła wyniku (timeout/błąd) — opublikowano komunikat o niepowodzeniu."`,
   `details: task={{…clickup_task_id}}; outcome={{…outcome}}; status={{…status}}; duration={{…duration_seconds}}s`.
5. **Mutation method:** prefer the n8n UI; if via MCP, `n8n_update_partial_workflow` then **re-export the whole
   workflow** (`export-workflows.mjs`) — partial updates re-sanitize ALL IF/Switch options, so re-export is
   the way to keep repo == live (see memory `n8n-partial-update-sanitization-drift`). Then `check-workflow-drift.mjs`.
6. **DoD test (integration):** temporarily set `execute-agent-session.json → Build Initial State`
   `SOFT_DEADLINE_MS` to ~20000, deploy, drive the orchestrator's `When Called` via `test-subworkflow.mjs`
   with the producer's real inputs on a **disposable** task whose prompt runs >20 s → confirm the orchestrator
   posts the incomplete comment (NOT narration), flips status, fires CRITICAL `non-delivery`; **restore
   840000** and redeploy. Also confirm a normal short task still posts its answer. Verify with
   `inspect-execution.mjs` + `alerts-since.mjs`; delete test rows/tasks. (Cheaper pre-check: drive Post Reply
   (v1) directly with the canned `rendered_delta` to prove the comment+status path before the full run.)

### Block 1 — execution notes (2026-06-30)

- **Pre-block drift write-back (separate commit).** Starting Block 1 surfaced live-ahead-of-repo drift: an
  entire **ClickUp Chat surface** feature (`Surface = chat?` router, `Call Assemble Chat Context`, a
  `Call Assemble Context` Merge, `Skip Cost If Chat?`, and a chat reply path in Post Reply) was live in
  `agent-orchestrator`/`post-reply`/`spine-http-ingress` with **no repo artifact and no ADR**, and its node
  notes claimed **"ADR-066"** — colliding with this plan. Operator decision: renumber it to **ADR-068**,
  write the drift back first as its own commit, then do Block 1 on the clean base. Done: live notes + repo
  JSON renumbered, 3 workflows re-exported (drift-clean), `architecture/decisions/068-chat-surface-convergence.md`
  added. The spec's "live == repo" claim held only for the `Session OK?` sub-topology, not the whole graph.
- **Surface-aware extension to the spec.** Because a chat-surface request can reach the managed `Session OK?`
  gate, `Call Post Reply (Incomplete)` passes `surface`/`surface_ref` and carries the failure text in **both**
  `rendered_delta` (task path → Pass Delta) **and** `completion` (chat path → Build Chat Markdown, which ignores
  `rendered_delta`). Otherwise as specced.
- **DoD verified live** (temporary 20 s `SOFT_DEADLINE_MS`, restored to 840000): a `deadline` run (opus,
  output_message empty) and a `delivered`-with-empty-blocks run (sonnet) each → `Session OK?` FALSE → canned
  Polish incomplete notice (outcome interpolated, **no narration**), status flipped to Zakończono, **CRITICAL
  `managed-agents/non-delivery`** alert. A normal `done`+free-text run (`"To jest 4."`) → `Session OK?` TRUE →
  published via Render → Post Reply (Managed), with only the known `no-deliver-output` text-fallback WARN.
  Drift-clean 42/42; test rows + disposable task deleted.

## Block 2 — Doc-link serialization fix

Make `doc_mention`/`bookmark`/`link` ops survive serialization. **Sites:** `cu-webhook-producer.json →
Detect Mention` (`triggering_comment_text`) and `assemble-task-context.json → Build Output` + `Collect
Replies` (the `get_task_comments` tail-tool path). **Fix:** when joining ops, emit text for rich entities —
`doc_mention` → `[dokument ClickUp: page <pageId> (doc <docId>)]` + canonical URL
`https://app.clickup.com/{teamId}/docs/{viewId}/{pageId}` when present (agent can then call
`clickup_get_document_pages`); `attributes.link`/`bookmark` → the URL. Reuse rule: same serialization, same
reason → one canonical op-serializer (shared helper / tiny `executeWorkflow`); decide in-block + document.
Keep the 600-char truncation unless it would cut a link.
**DoD:** mention the agent on a disposable task whose comment embeds a doc link → assembled prompt /
`get_task_comments` contains the reference; no `clickup_search` fallback. Verify via `inspect-execution.mjs`.
Re-export; drift clean.

## Block 3 — Enable image embedding (ADR-067)

Probe A4 first (sandbox egress). **Server:** in `image-mcp-tool-handler.json` / `image-tool-handler.json`
(already upload bytes to the Supabase `agent-output-images` carrier via `Has Carrier Bytes? → Convert
Carrier File`), return a **short-TTL signed URL** per generated image alongside `file_id`. Do **not** return
base64 in the tool result (context pollution). **Contract** (`sync-agent-definitions.json → Build System`):
update the `generate_image` description + office-doc guidance — *to embed a generated image in an office
doc, download it from the returned `download_url` into the session, then embed; the `deliver_output` block
still references it by `file_id` for inline rendering.* Bump `CONV`, re-sync (`force:true`). Removes the
wasted filesystem probing + the false "attached" implication. **Reliability:** signing failure → `file_id`
only + WARN; sandbox download failure → agent falls back to vector visuals.
**DoD:** image-in-document task end-to-end; the attached `.pptx` actually contains the generated image
(download+open or render check); inline image blocks still render; zero unexpected alerts. Update
`current.md` + ADR-067; re-export image workflows + sync; drift clean.

## Blocks 4–8 — External session waiter (ADR-066)

Re-architect managed sessions from synchronous held-poll to asynchronous waiter + callback, behind
`config.session_waiter.enabled` (poll loop = fallback until verified).

**Block 4 — skeleton.** New Node service under `/opt/haxe-agents` (docker compose, ADR-033; model:
`queue-consumer`): health endpoint, structured logging, env (managed key per A6, Supabase creds, n8n webhook
base URLs), `restart: unless-stopped`. Reliability seam: n8n health dead-man's-switch pinging the waiter +
a freshness check on "handed-off-but-not-finished within N min" → CRITICAL. Draft ADR-066.

**Block 5 — orchestrator split.** `agent-orchestrator.json`: after context build, create the session + send
first message (front half of today's `Execute Agent Session`), then POST carry-state to the waiter
(`session_id`, `clickup_task_id`, `triggering_comment_id`, `caller_user_id`, `impact`, `model_id`,
`agent_id`, `clickup_scope`, `input_image_refs_json`, `file_map`, managed key, `finish_callback_url`,
absolute budget) and **return** — no long hold. Keep `Set Status W trakcie`. Behind the flag: `enabled=false`
→ today's synchronous path unchanged.

**Block 6 — waiter event loop.** Open SSE (A1) / long-poll; truth = `GET /events` dedup by id; reconnect +
reconcile on stream close. Terminal detection ports `Poll Round` (`deliver_output` → capture blocks, stop;
`done`/`terminated`/error → finish; absolute-budget timeout → finish non-delivery). Client-tool servicing
**delegates to n8n** (anti-duplication): pending `get_task_*`/`list_attachments`/`get_attachment`/
`extract_clickup_task` → POST to a thin HTTP-trigger wrapper around `Triggering Task Tail Handler`
(`Ouo0BlYOw92DUXIh`) / `ClickUp Extract Tool Handler` (`y985MgyA5lCxOFCH`) → POST `user.custom_tool_result`
(A3) → resume. `generate_image` is MCP (in-harness) — waiter never sees it. Always resolve a pending tool
(deadlock). On terminal, POST the finish callback. Live-probe A2 (≥30-min survival) here.

**Block 7 — finish-callback half in n8n.** New HTTP-triggered sub-workflow: receive `{session_id, outcome,
delivered_via_tool, output_blocks, final_message_text, +carry-state}` → re-fetch usage/duration → run the
doc-files enumeration + cost computation now in `execute-agent-session.json → Build Final Output`
(move/share) → `Call Render Agent Output` → `Call Post Reply (Managed)` → `Write Cost Field` → flip status.
Integrate the Block 1 guard (non-delivery → incomplete-status comment + CRITICAL, never narration).
Idempotent on `session_id` (no double-post).

**Block 8 — cutover + reliability.** Flip `config.session_waiter.enabled=true` (poll loop = documented
rollback). Verify reconciliation cron + health monitor (simulate a stuck session + a waiter restart
mid-session). Finalize ADR-066 (supersede the ADR-053/063 held-poll text); update `current.md` Stage-B;
re-export all touched workflows; `check-workflow-drift.mjs` clean.

## End-to-end verification (whole-plan DoD)

Re-run the original failing shape (doc-analysis + multi-image + `.pptx`) on a disposable task with
`session_waiter.enabled=true`: (1) agent receives the doc link, no search fallback; (2) generated images
embed **inside** the `.pptx`, file attaches; (3) run exceeds ~15 min and **still completes** — waiter holds,
agent calls `deliver_output`, finish-callback posts the real answer; (4) **no premature narration** ever;
induced timeout → only incomplete-status comment + CRITICAL alert; (5) `inspect-execution.mjs` shows clean
`rendered_delta` + `image_manifest` + `.pptx` attachment, `alerts-since.mjs` zero unexpected; (6) cost
written, status Zakończono; (7) clean up test rows + disposable task/attachments.

## Red-team / risks (carry into ADR-066)

- **New always-on service = new failure surface.** A crashed/wedged waiter orphans running sessions
  silently → health dead-man's-switch + "handed-off-but-not-finished" reconciliation cron are mandatory
  (the biggest cost of this design).
- **Duplicate finish callbacks** → finish-half idempotent on `session_id` (reuse ADR-056 consumer idempotency).
- **Two systems, one secret** → scope the waiter's key; no repo/`.env` exposure (A6).
- **Recursion-depth concern removed** (no n8n self-recurse for the wait) — a win over chunked-recurse.
- **Drift discipline** → tail/extract handlers stay SSOT; the waiter only calls them.
