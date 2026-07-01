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
| 2 | Doc-link serialization fix (Detect Mention + Assemble Task Context) | ✅ DONE — verified live on task 869dxn3d8 2026-06-30 |
| 3 | Enable image embedding (image MCP handler signed URL + persona contract) — ADR-067 | ✅ DONE — verified E2E 2026-06-30 (.pptx embeds the generated PNG) |
| 4 | Waiter service skeleton: deploy, health, env, dead-man's-switch — ADR-066 draft | ✅ DONE — deployed + verified live 2026-06-30 |
| 5 | Orchestrator split — async handoff (create session → hand to waiter → return) | ✅ DONE — verified live 2026-06-30 (both paths) |
| 6 | Waiter event loop: long-poll, client-tool servicing (delegate to n8n), deliver_output capture | ✅ DONE — verified live E2E 2026-06-30 (A2 baseline GO) |
| 6.1 | Streaming event source: SSE-incremental + `GET /events` reconcile (replaces the full-log re-fetch) | ✅ DONE — verified live E2E 2026-07-01 (SSE drive + restart-recovery + A2) |
| 7 | Finish-callback half in n8n: doc enumeration + cost + render + post (+ Block 1 guard) | ☐ TODO |
| 8 | Reliability + cutover behind `config.session_waiter.enabled`; reconciliation cron; finalize ADR-066 | ☐ TODO (Block 6.1 landed — precondition met) |

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

### Block 2 — execution notes (2026-06-30, DONE)

- **Root cause refined by the real op shape.** Fetched the original failing comment (task `869dxn3d8`): the
  `doc_mention` op is `{type:'doc_mention', doc_mention:{teamId,viewId,pageId,pageTitle}, text:'<pageId>'}`.
  The bug is the **`comment_text`/`text_content`-first preference**, not the op join: ClickUp's flat text omits
  the doc-mention line entirely, and being truthy it short-circuits the `|| ops.map(.text)` fallback. (Even
  reaching the fallback, `op.text` is only the bare `pageId` — no doc/team/URL.) There is **no `docId` field**;
  the **`viewId` is the doc id** (`clickup_get_document_pages` wants `document_id`=viewId, `page_ids`=[pageId],
  both parseable from the canonical URL `app.clickup.com/{teamId}/docs/{viewId}/{pageId}`).
- **Three sites confirmed, no others.** `Detect Mention` (producer, → `triggering_comment_text`, the always-present
  "Wiadomość wywołująca" prompt floor) + `Assemble Task Context`'s `Build Output` (top comments) and `Collect
  Replies` (replies). The managed `get_task_comments` tail tool routes through `Triggering Task Tail Handler →
  Call Assemble Task Context`; its `Build Comments Result` just passes through the already-serialized `.text`, so
  fixing `Build Output` covers both lanes. `get_task_details` serializes task *description*, not comment ops — not a site.
- **Reuse decision (documented exception).** One canonical `serializeCommentOps(ops, flat)` inlined at all three
  sites (+ `truncateKeepingLinks(text,600)` at the two truncating sites), each carrying a "KEEP IDENTICAL" provenance
  header. A shared `executeWorkflow` serializer was rejected: n8n Code nodes share no module, and a sub-workflow on
  the producer's webhook hot path would add an exec row per comment (Insights-flood risk) + a synchronous failure
  surface to mention-detection — worse fragility than 3 copies of a pure string transform. See `current.md` §15.5.
- **Mutation + verification.** Applied via `n8n_update_partial_workflow` `patchNodeField` (surgical; unchanged code
  untouched), re-exported both files, **drift-clean 42/42**, git diff = exactly the 3 jsCode lines (no IF/Switch
  sanitization noise). Serializer unit-tested on the real op (doc_mention → URL; plain → flat; link/bookmark) and
  then **live-tested** by driving `Assemble Task Context` (`test-subworkflow.mjs`) against `869dxn3d8`: `task_comments[0].text`
  now contains `[dokument ClickUp: https://app.clickup.com/761759/docs/q7wz-16892/q7wz-44692 (doc …, strona …)]`,
  the threaded reply (no rich op) fell through to plain text. Read-only (no ClickUp writes); harness auto-torn-down.
- **Not autonomously runnable: the literal UI @-mention E2E.** A `doc_mention` op is created only by the ClickUp UI
  (the `create_comment` API takes plain markdown and won't synthesize one), and a real @-mention spins a full agent
  session (delivery still broken until Blocks 4–7). The live `Build Output` test exercises the **identical** serializer
  on real `doc_mention` data in the n8n runtime; the `Detect Mention` copy is the same function (unit-tested on the
  same op, deployed, drift-clean). Operator may do a UI @-mention as optional belt-and-suspenders.

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

### Block 3 — execution notes (2026-06-30, DONE)

- **A4 (sandbox egress) probed GO first.** Drove a disposable managed task that `curl`-ed
  `hkeslnosxibeuesxndnz.supabase.co/storage/v1/...` → HTTP 400 (request reached Supabase; expected for an
  unsigned/nonexistent object), agent reported network egressing. So the signed-URL-the-sandbox-downloads
  design is viable (no need for the Files-API-download fallback). Same run also confirmed a **short** managed
  task still delivers end-to-end through today's poll loop (the waiter is only needed for long tasks).
- **Server.** New `Sign Output Image URL` node in `image-tool-handler.json` after the carrier write
  (`Upload Output Image to Storage` → Sign → `Build Stored OK`), `POST /storage/v1/object/sign/agent-output-images/<file_id>`
  `{expiresIn:3600}` via the `supabaseApi` service-role cred; `Build Stored OK` builds the absolute
  `download_url`; `Aggregate` surfaces `images[].download_url` + an `image-tool/sign-failed` WARN on signing
  failure. `image-mcp-tool-handler.json → Build MCP Output` now returns `images:[{file_id,download_url}]`
  (still **no** base64). **Server half byte-verified:** a `test-subworkflow.mjs` generation returned a 427-char
  signed URL that served the real PNG (HTTP 200, image/png, 174 KB, valid PNG magic).
- **Contract.** `sync-agent-definitions.json → Build System` `CONV=16`: `generate_image` returns
  `file_id`+`download_url`; embed inside an office doc by downloading from `download_url`, inline still by
  `file_id`; download-fail → vector visuals. Re-synced (the CONV bump made all 3 agent definitions stale →
  updated; `force` not needed).
- **DoD E2E (two runs, disposable tasks).** Run 1 (`869dxuerr`): the agent generated a 1024×1024 PNG and built
  a 147 KB `.pptx`; the file (downloaded from the Files API and unzipped) contained `ppt/media/image-1-1.png`
  = a valid PNG 1024×1024 (byte-verified). Delivery to ClickUp was suppressed by the **Block 1 guard** because
  Sonnet hit the pre-existing `output-adapter/deliver-output-empty` flake (`output_blocks=[]`, the CONV=15
  blocks-as-string issue — unrelated to ADR-067), which `Session OK?` correctly treated as non-delivery
  (incomplete notice, no narration, CRITICAL `non-delivery`). Run 2 (`869dxun5g`) delivered cleanly:
  `output_blocks` proper (text+doc), `outcome=delivered`, zero warnings; the **ClickUp-attached** `prezentacja.pptx`
  (downloaded from its public attachment URL) contained `ppt/media/image-1-1.png` = PNG 1024×1024. Inline path
  untouched (only `download_url` added; `file_ids`/`image_manifest` unchanged). Only alert across the clean run
  was the benign `assemble-context/context-health` WARN (test reviewer has no person-rules) — no `image-tool/*`
  alerts. Re-exported the 3 workflows, drift-clean 42/42; disposable tasks + test `agent_runs` rows cleaned up.
- **Carry-forward:** the `deliver-output-empty` Sonnet flake is a real, separate delivery risk for office-doc
  tasks (Block 1 turns it into an incomplete notice rather than a silent empty post). It is out of ADR-067's
  scope but worth a future hardening pass on `deliver_output` block coercion.

## Blocks 4–8 — External session waiter (ADR-066)

Re-architect managed sessions from synchronous held-poll to asynchronous waiter + callback, behind
`config.session_waiter.enabled` (poll loop = fallback until verified).

**Block 4 — skeleton.** New Node service under `/opt/haxe-agents` (docker compose, ADR-033; model:
`queue-consumer`): health endpoint, structured logging, env (managed key per A6, Supabase creds, n8n webhook
base URLs), `restart: unless-stopped`. Reliability seam: n8n health dead-man's-switch pinging the waiter +
a freshness check on "handed-off-but-not-finished within N min" → CRITICAL. Draft ADR-066.

### Block 4 — execution notes (2026-06-30, DONE)

- **Service deployed + verified live.** `services/session-waiter/` (Node 20 + express; mirrors
  `queue-consumer`/`zip-extractor`). Built on the VPS via the stack compose (`docker compose up -d --build
  session-waiter`); container **`Up (healthy)`, `restarts=0`**, no collateral restart of any other container
  (all kept their prior uptimes). Internal only (`expose:8080`, `n8n-internal`, `mem_limit:256m`). The repo
  `n8n/docker-compose.yml` is the compose master; the live VPS file was functionally identical (only comment/
  whitespace drift) and was brought in line on deploy (backup `docker-compose.yml.bak-adr066`).
- **Skeleton surface.** `GET /health` (cheap liveness — no DB round-trip, so a wedged Supabase can't make a
  live waiter look dead) + `POST /handoff` (validate → upsert a `waiter_sessions` row → 202; the event loop is
  Block 6). Structured JSON logging with **secret redaction** (the managed key arrives in the handoff body per
  A6 and is never logged or persisted — re-derived from `get_anthropic_key()` in Block 6). Crash self-alert +
  graceful shutdown. Verified locally: `/health` 200, `/handoff` 400-guard on missing `session_id`, structured
  logs. Verified in prod: clean startup logs, env wired (no missing-`ALERT_INTAKE` WARN).
- **Migration 049** (`waiter_sessions` table + RLS + `session_waiter.*` config knobs behind a validation
  trigger + `check_stuck_waiter_sessions()` getter). Applied via Supabase MCP. Config seeded:
  `enabled=false` (Block-5 cutover flag), `stuck_after_minutes=50` (> the ~45-min budget so a healthy long
  task doesn't false-alarm), `absolute_budget_ms=2700000`. Advisors clean (only the expected
  `rls_enabled_no_policy` INFO, matching migration 007's pattern; both new trigger functions pin
  `search_path`). Getter unit-proven directly: a 70-min `handed_off` row → `stuck_count 1`; a 5-min `running`
  row and a 90-min `finished/delivered` row → correctly excluded; empty table → `0`.
- **Reliability seam — two n8n monitors, both ACTIVE, drift-clean 44/44.**
  - **`Session Waiter Health Monitor (v1)`** (`5oUkOeAgprmnvauI`, every 10 min): `GET /health` → 2xx Healthy
    (silent) / non-2xx|unreachable → CRITICAL `session-waiter/health`. **Live test:** `When Called` →
    returned the waiter's real `/health` JSON via the Healthy branch, **no alert** — which also proves the
    real internal path `n8n-main → session-waiter:8080`. (The down path is the same `onError` pattern as the
    verified Image MCP Health Monitor; not exercised live to avoid taking down a healthy prod service.)
  - **`Session Waiter Freshness Monitor (v1)`** (`0eCpWtpwgFB25Lz6`, every 15 min): calls the getter → any
    handed-off-but-not-finished row past the threshold → CRITICAL `session-waiter/freshness`. **Live test:**
    with a staged stuck row, `When Called` → **exactly 1 CRITICAL** in `alerts-since.mjs` with the correct
    session/task/minutes detail, **0 WARN**, no health alert. Test row deleted afterward (the active 15-min
    schedule now stays silent on the empty table).
- **Carry-forward to Block 5:** nothing calls `/handoff` in production yet (orchestrator split is gated on
  `config.session_waiter.enabled`, seeded `false`). The freshness seam already protects a premature cutover —
  a handoff that never finishes trips the CRITICAL. **VPS access caution:** rapid SSH/scp bursts trip an
  IP-wide connection rate-limit (clears in ~2-3 min); space VPS connections out.

**Block 5 — orchestrator split.** `agent-orchestrator.json`: after context build, create the session + send
first message (front half of today's `Execute Agent Session`), then POST carry-state to the waiter
(`session_id`, `clickup_task_id`, `triggering_comment_id`, `caller_user_id`, `impact`, `model_id`,
`agent_id`, `clickup_scope`, `input_image_refs_json`, `file_map`, managed key, `finish_callback_url`,
absolute budget) and **return** — no long hold. Keep `Set Status W trakcie`. Behind the flag: `enabled=false`
→ today's synchronous path unchanged.

### Block 5 — execution notes (2026-06-30, DONE)

- **Design: data-driven fork, ONE front half (no duplication).** The "front half of Execute Agent Session"
  is NOT copied into the orchestrator (the managed key + agent/model + clickup_scope are resolved *inside*
  `execute-agent-session`, not visible to the orchestrator). Instead `execute-agent-session.json` gained a
  `mode` input (absent → `sync`): a new IF **`Mode = handoff?`** after `Build Initial State` routes TRUE →
  new **`Build Handoff Output`** (Code) → **`Merge Final` (input 3)**, reusing the workflow's existing
  "alternative terminal via Merge Final" idiom (same as the create/send-failed branches), so `Final Return`
  (`$('Merge Final').first()`) stays deterministic — the four Merge Final inputs are mutually exclusive
  upstream. FALSE → `Merge State` (today's poll loop, unchanged). Recursion never reaches the IF
  (`Is Recursive?` routes straight to Merge State). This avoids the sub-workflow-return-determinism trap.
- **Orchestrator (`agent-orchestrator.json`).** New `Read Waiter Flag` (Postgres; reads
  `session_waiter.enabled` + `absolute_budget_ms` in one row; `onError=continueRegularOutput`+`alwaysOutputData`
  so a config-read failure degrades SAFELY to sync). `Call Execute Agent Session` gained
  `mode = {{ flag==='true' ? 'handoff':'sync' }}`. New `Handoff?` IF on the returned `outcome==='handed_off'`:
  TRUE → new `Post Handoff to Waiter` (POST `http://session-waiter:8080/handoff`) ; FALSE → `Session OK?`
  (today's gate, untouched). POST failure → new `Alert Handoff Failed` (CRITICAL `session-waiter/handoff-post`).
  The managed-lane head was rewired `Upsert File Map (Managed)`/`Alert File Map Failed` → `Read Waiter Flag`
  → `Call Execute Agent Session`.
- **Deliberate deviation from the plan's carry-state: the managed key is NOT sent to the waiter.** Passing it
  would only spread the credential into the orchestrator's execution data (it is resolved inside the
  sub-workflow and the orchestrator never sees it today). The waiter re-derives it from
  `public.get_anthropic_key()` in Block 6 (exactly what `app.mjs` already documents), so the handoff body
  omits it (A6-minimal). Verified end-to-end: the persisted `carry_state` had neither `anthropic_key` nor
  `managed_key`. `input_image_refs_json` is likewise not sent separately — `file_map_json` carries the
  resolved input-image file map.
- **`finish_callback_url`** is set now to `http://n8n-main:5678/webhook/session-waiter-finish` — a forward
  contract for the Block-7 webhook (which doesn't exist yet; harmless since the handoff path is gated off in
  prod until Block 8). `absolute_budget_ms` (config, 2.7 M ms) flowed through to the row's `deadline_at`
  (handoff + 45 min).
- **DoD verified live (both paths), drift-clean 47/47.** (A) Driving `execute-agent-session` directly with
  `mode=handoff` returned `outcome='handed_off'` + a real `session_id` in **2 s** with **Poll Round never
  running** (`Mode = handoff?` TRUE, `Build Handoff Output → Merge Final → Final Return`), no `anthropic_key`
  in the output. (B) With `session_waiter.enabled=true`, driving the **orchestrator** `When Called` on a
  disposable task (`869dxzfjr`, "Lista testy AI") → `Read Waiter Flag` true → `mode=handoff` →
  `Call Execute Agent Session` (`handed_off`) → `Handoff?` TRUE → `Post Handoff to Waiter` got the waiter's
  **202** and persisted a `waiter_sessions` row (`status=handed_off`, `surface=task`, `deadline_at`=+45 min,
  `finish_callback_url` set, **`carry_has_key=false`**), orchestrator returned in **6 s** with **no comment
  and no `Session OK?`**, **0 CRITICAL** (only the benign `context-health` WARN: test reviewer has no
  person-rules). (C) Flag flipped back to **false** → the same orchestrator run took the **sync** path:
  full poll loop (`outcome=delivered`), `Handoff?` **FALSE** → `Session OK?` TRUE → Render → `Post Reply
  (Managed)` posted the answer, `cost_pln=0.030`, 0 CRITICAL — confirming the live prod path is intact (the
  flag is false in prod, so sync is what actually runs). Test row/task/`agent_runs` cleaned up; the two
  orphan Anthropic sessions idle harmlessly (no waiter drives them; Block 6).
- **Carry-forward to Block 6/7.** (1) Front-half warnings (e.g. `clickup-scope-degraded`) ride through
  `Classify Alert` on the handoff path for parity — Block 7's finish callback must **not** re-fire the same
  front-half warning sources (double-alert). (2) Nothing drives a handed-off session yet (Block 6); a real
  cutover stays blocked on `enabled=false`. (3) `/handoff` has no auth (internal-only on `n8n-internal`) —
  acceptable for now; note as a possible hardening item.

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

### Block 6 — execution notes (2026-06-30, DONE)

- **`generate_image` reconciliation (load-bearing).** The plan's "generate_image is in-harness MCP — waiter
  never sees it" is CORRECT: `sync-agent-definitions → Build System` documents that ADR-055 moved image gen to
  the self-hosted `haxe_image` MCP server (`agent.mcp_tool_use`, `permission_policy=always_allow`), so it never
  enters the pause/resume loop; `clickup_*` discovery is likewise MCP (ADR-054). The `Is generate_image?` branch
  still in `execute-agent-session` is **legacy dead code** (pre-ADR-055). So the client-side custom tools the
  waiter services are exactly: `deliver_output` (terminal), `extract_clickup_task`, and the 5 tail tools
  (`get_task_comments`/`get_parent_chain`/`list_attachments`/`get_attachment`/`get_task_details`). Anything else
  → resolved with a "tool not available" result (deadlock avoidance).
- **Waiter event loop (`services/session-waiter/app.mjs`, v1.1.0-block6).** `/handoff` now persists + returns
  202 + drives the session in the background (fire-and-forget). The driver: re-derives the managed key via
  `POST /rest/v1/rpc/get_anthropic_key` (A6 — SECURITY DEFINER, service_role EXECUTE; the key is never in the
  handoff body, never logged, never persisted) → **long-polls** `GET /events` (truth) + `GET /sessions/{id}`
  (status), porting `Poll Round`'s `analyze()` verbatim (pending-tool / session-error / idle+replied detection)
  → on a pending client tool POSTs the **Session Waiter Tool Bridge** → POSTs `user.custom_tool_result` →
  resumes; on `deliver_output` captures `input.blocks`; on terminal POSTs the finish callback. **Shipped
  long-poll as the robust first cut** (A1's proven, n8n-independent path) — but this is a deliberate DEFERRAL,
  not a claim that polling beats streaming: each poll re-fetches the **entire** `GET /events` log, so a long
  session re-downloads its growing transcript every 3 s (≈ O(N²) bytes + JSON re-parse on a 256 MB container) —
  wasteful exactly for the 20–45 min sessions this exists to support. **SSE-incremental is Block 6.1, and must
  land before Block 8 cutover** (where real long sessions first run through it). Absolute budget = the row's
  `deadline_at` (handoff + 45 min) → `deadline` (non-delivery) past it. **Crash recovery:** on startup re-adopts
  any `handed_off`/`running` row (resumes driving it); the freshness monitor is the backstop.
- **Tool bridge (`Session Waiter Tool Bridge (v1)`, `mbAegTOPm4PhamhX`, ACTIVE).** Thin HTTP wrapper the waiter
  POSTs to: `Webhook → Is extract? → Call Extract/Tail Handler → Build Bridge Response → Respond`. Delegates to
  the SSOT handlers (`Ouo0BlYOw92DUXIh` tail, `y985MgyA5lCxOFCH` extract) — anti-duplication, the handlers stay
  authoritative. **Authed** with `headerAuth` (X-Watchdog-Key = the shared waiter↔n8n key, reusing the Storage
  Watchdog credential) because n8n `/webhook/*` is public via nginx and the tail handler reads task data with the
  bot token. `Build Bridge Response` is `runOnceForEachItem` so the 4 incoming (extract/tail × success/error)
  connections don't trigger per-connection re-runs (CLAUDE.md trap); handler failure → fail-soft content (the
  waiter always resolves the tool, never deadlocks).
- **DoD verified live E2E (flag ON, disposable task `869dy07tf`).** Orchestrator handed off → waiter logs
  `handoff_persisted → drive_start → tool_serviced (get_task_details, round 1) → drive_terminal (delivered,
  1 block) → finish_posted` in ~12 s. The bridge execution routed `get_task_details` to the Tail Handler (single
  clean run) and returned the title+status; the agent's `deliver_output` block literally contained
  `"## Wyniki — Tytuł: [TEST]… — Status: Open"` (proving the whole chain: client tool → bridge → handler → agent
  → captured block). The finish-callback payload (caught by a TEMP sink at the real `session-waiter-finish` path,
  now deleted) carried the full **24-field Block-7 contract** — `outcome=delivered`, `delivered_via_tool=true`,
  `output_blocks[1]`, usage, duration 13 s, carry-state, `warnings=0`. Row → `status=delivered`, `finished_at`
  set, **`carry_has_key=false`**. **0 CRITICAL** (only the benign `context-health` WARN). Flag restored to
  `false`; test task/rows cleaned up.
- **A2 (≥30-min survival) — baseline GO, ≥30-min re-probe pending (non-blocking).** New reusable probe
  `Session Events Probe (v1)` (`2PUz84FsMenyJXUx`): given a `session_id`, fetches the key + `GET /events` +
  status. Baseline on the just-delivered session returned **17 events retrievable** incl. both
  `agent.custom_tool_use` (get_task_details + deliver_output). The session (`sesn_01G3DGXGqdN9t4TEPqtSWwQA`,
  idle 19:12 UTC) is left alive for the ≥30-min retention re-probe — run
  `node scripts/test-subworkflow.mjs 2PUz84FsMenyJXUx --file a2-input.json` after ~19:45 and confirm
  `events_retrievable=true`+`has_deliver_output=true`. (The 06-30 incident already evidenced ~20 min + post-idle
  retrieval; the 45-min absolute budget + freshness cron are the fallbacks regardless. Auto-scheduling was
  unavailable in this session.)
- **Carry-forward to Block 7/8.** (1) The finish payload shape is the Block-7 input contract (see above; a TEMP
  sink proved it). (2) Block 7's finish half must be idempotent on `session_id` and must NOT re-fire front-half
  warning sources (they ride in `warnings`). (3) Deadline / re-adoption / poll-error paths are code-complete +
  happy-path-adjacent but get their LIVE test at Block 8 (which already mandates "simulate a stuck session + a
  waiter restart mid-session"). (4) The tool bridge + probe are new ACTIVE workflows (drift-clean 49/49).

**Block 6.1 — streaming event source (SSE-incremental).** Replace the full-log re-fetch with the design A1
actually intended: consume the SSE stream as the **incremental event source + low-latency wakeup**, and keep
`GET /events` only for reconnect/reconcile and the deadlock-safety invariant — so the waiter stops
re-downloading the growing transcript every poll (kills the O(N²) bandwidth/CPU on long sessions) and reacts
without the ~3 s poll lag. **Independent of Block 7** (can land in either order) but **must precede Block 8
cutover**, since cutover is when real 20-min+ sessions first run through the waiter.

- **Block 6.1.0 — verify assumptions first (live probe against a held session).** (a) Does
  `GET /v1/sessions/{id}/events` support an **incremental cursor** (e.g. `?after=<event_id>` / pagination /
  `order`)? If yes, even the fallback poll can fetch only the delta — lowers the stakes and is reused on
  reconcile. (b) Does `GET /v1/sessions/{id}/events/stream` deliver **full event objects with stable ids**
  (dedup key), or only "something changed" pings? Observe close/heartbeat cadence between turns. (c) Confirm a
  pending tool is still resolvable across a stream drop (POST `user.custom_tool_result` after reconnect →
  session resumes; no deadlock). Use the reusable `Session Events Probe (v1)` + a short live session; record
  findings inline (mirror `block-0-findings.md`).
- **Design.** Maintain an in-memory event map keyed by event id, fed incrementally from the SSE stream; run the
  ported `analyze()` over the accumulated map (terminal/pending/idle detection unchanged). On stream
  close/error → reconnect with backoff and do ONE `GET /events` (or cursor delta) **reconcile** (dedup by id)
  to catch anything missed while disconnected. Preserve the load-bearing invariants verbatim: **always resolve
  a pending tool** (service via the bridge → POST result → the stream delivers resumption), the absolute-budget
  `deadline`, terminal `deliver_output` capture, and startup re-adoption. **Keep the long-poll path in the code
  as the documented fallback** — if SSE is unavailable or errors repeatedly, degrade to polling (still correct),
  never hang.
- **Reliability.** SSE failure must degrade to poll, never deadlock; the reconnect-reconcile is what guarantees
  no missed terminal/pending event. No alert-channel change.
- **DoD.** Drive a real multi-tool session over SSE: parity with the Block 6 E2E (services tools via the bridge,
  captures `deliver_output`, posts the finish callback, 0 unexpected alerts) **and** confirm via request-logging
  that steady state does **no** full-log re-fetch (only on reconnect/reconcile). Force a mid-tool stream drop →
  confirm reconnect + the pending tool still resolves (no deadlock). Re-run the A2 long-session shape. Bump the
  waiter version; redeploy; update `current.md` + ADR-066; commit.

### Block 6.1.0 — assumption probe (DONE, 2026-07-01)

Live SSE-mechanics probe against a throwaway managed session (self-contained Node script run in a `node:20`
container on `haxe-agents_n8n-internal`; created its own env+agent+session with one custom tool, then cleaned
up; the managed key was fetched via `get_anthropic_key()` and never printed). Verdict: **GO on all three.**
- **(a) `GET /events` cursor.** No `?after=`/`?starting_after=` — both return **400 Unknown query parameter**.
  The API's own error lists the valid params: `created_at[gt|gte|lt|lte]`, `limit`, `order`, `page`, `types[]`.
  So the cheap delta is **`created_at[gte]=<processed_at>`** (every event carries a `processed_at` timestamp —
  better than an id cursor for our purpose). Default envelope is `{data:[...]}`; a `?limit` truncation adds an
  opaque `next_page`. This resolves the plan's open question (a) favourably.
- **(b) SSE shape + cadence.** `GET /events/stream` opens with a `: connected` comment, then delivers **full
  event objects with stable `sevt_` ids** + `processed_at` (same shape as the list endpoint) — a clean dedup
  key. Held **20 s idle → the server did NOT close the stream** (refutes block-0's pessimistic "closes between
  turns"; the stream is long-lived). **No replay:** a stream reopened after a drop delivered only post-open
  events (so `GET /events` is the backlog truth, SSE is the incremental source).
- **(c) Pending tool across a drop.** Dropped the stream with an `agent.custom_tool_use` unanswered →
  `GET /events` showed it unanswered → reopened the stream → `POST user.custom_tool_result` → the session
  resumed and delivered the follow-up over the reopened stream. Decisive: a pending tool resolves across a
  reconnect (the invariant `scheduleReconnect` implements).

### Block 6.1 — execution notes (2026-07-01, DONE)

- **Design (data-driven, one finish path).** `driveSession` is now an orchestrator: it fetches the key, then
  runs `runSseLoop` (primary); on repeated SSE failure `runSseLoop` **rejects** and it falls back to
  `runPollLoop` (the Block-6 long-poll loop, refactored to *return* the terminal result instead of finishing
  inline). Both loops return `{outcome, picked, analysis, statusObj, warnings, toolRound}`; `driveSession`
  builds the finish payload + posts the callback ONCE (no duplicated finish code). Tool servicing is shared
  (`serviceToolSafe` — always returns `{content,warnings}` so the caller ALWAYS resolves the tool, no
  deadlock). `SSE_ENABLED=false` forces the poll loop without a redeploy (operational rollback).
- **SSE loop.** Seed once with a full `GET /events` (SSE has no replay), then accumulate from the stream into an
  in-memory event map (`seen` Set + ordered `events` + `cursor`). `analyze()` (ported from Poll Round) runs over
  the accumulated events; **status is derived from the `session.status_*` events** (so no `GET /sessions` per
  tick — only ONE `getSession` at terminal, for final usage/duration). Serialized `evaluate()` (mutex + re-run
  flag) coalesces concurrent SSE wakeups so a tool is serviced once; a `servicedIds` guard blocks a double-POST
  if a post-tool delta momentarily lags. Reconnect = backoff + a `created_at[gte]` **delta** reconcile + reopen;
  a `deadlineTimer` is the hard absolute-budget stop; a slow safety tick (45 s) is a delta pull, not a full
  re-fetch. Startup re-adoption re-drives via SSE.
- **DoD verified live E2E (flag ON, disposable task `869dyajhe`, then reverted false).** (1) **Parity:**
  orchestrator handoff → waiter logs `drive_start source=sse → events_fetch mode=seed → tool_serviced
  (get_task_details) via=sse → drive_terminal delivered blocks=1 → finish_posted attempt=1`. The finish payload
  (caught by a TEMP sink at `session-waiter-finish`, since deleted) carried the full 24-field contract with a
  real `get_task_details` result block, `delivered_via_tool=true`, `warnings=[]`. Row `delivered`,
  `carry_has_key=false`. **(2) No full-log re-fetch:** the ONLY `events_fetch` logged was `mode=seed`; the
  session completed via SSE merges (which are logged only in aggregate) — steady state re-fetched nothing.
  **(3) Mid-session drop / reconnect:** a two-tool session was killed mid-drive with `docker restart`
  (`shutdown SIGTERM in_flight:1`); on restart `readopt_found count=1` re-adopted the row, re-seeded via
  `GET /events`, serviced **both** pending client tools over SSE (`get_task_details`, `get_task_comments`), and
  **delivered — no deadlock** (a full-process-loss superset of a single stream reconnect; the single-stream case
  is proven by probe 6.1.0). **(4) A2 shape:** `Session Events Probe (v1)` on the recovered session →
  `events_retrievable=true`, `event_count=21`, `has_deliver_output=true`, `status=idle`. **0 CRITICAL / 0 WARN**
  across the whole window. No n8n workflow JSON changed (the TEMP sink was a throwaway live-only workflow), so
  there is no repo↔live drift to reconcile.
- **Carry-forward to Block 7/8.** (1) The `blocks:0` seen on the restart-run delivery is the pre-existing Sonnet
  `deliver-output-empty` flake (Block 3 carry-forward), NOT an SSE regression — Block 7's guard turns an empty
  `output_blocks` into the Block-1 incomplete notice. (2) The harness produced a **duplicate handoff** per drive
  (two sessions for one `test-subworkflow` POST); both delivered cleanly. Block 7's finish half must be
  idempotent on `session_id` regardless — but the duplicate-handoff shape is worth noting for Block 8 (a single
  producer trigger can yield >1 handoff under the test harness). (3) Block 8's precondition (SSE landed) is met.

**Block 8 — cutover + reliability.** Flip `config.session_waiter.enabled=true` (poll loop = documented
rollback). Verify reconciliation cron + health monitor (simulate a stuck session + a waiter restart
mid-session). Finalize ADR-066 (supersede the ADR-053/063 held-poll text); update `current.md` Stage-B;
re-export all touched workflows; `check-workflow-drift.mjs` clean. **Precondition: Block 6.1 (SSE) landed** —
do not cut real long sessions over to the full-log-re-fetch poll.

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
