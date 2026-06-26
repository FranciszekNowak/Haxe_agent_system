# Block 3 findings — producer cutover (CU Webhook Producer) (2026-06-26)

Block 3 cuts the one live producer, `CU Webhook Producer (v1)` (`eS66Sk6fweQ0EOPa`), over to the BullMQ
queue behind `config.queue_enabled`, with the unchanged synchronous `Run Agent Spine` as the fallback.
It also lands a **consumer-side dedup fix** that was a precondition for the cutover (without it the queue
path would have silently dropped follow-up @-mentions). Every Definition-of-Done item below is backed by
a live run against the production stack, not assertion.

The terminal dead-letter CRITICAL alert is **Block 4**; monitoring + heartbeat + the config refresh poll
is **Block 5**; the §14.2–§14.6 doc reconciliation + burst/priority scope-test + mark-LIVE is **Block 6**.

---

## The precondition: the dedup regression (found before cutover, fixed consumer-side)

The handoff scoped Block 3 as "producer cutover only," but tracing the consumer first surfaced a
**correctness bug that the literal DoD would have passed while breaking the agent's main interactive
behaviour.** Recorded here because it shaped the block.

**The bug.** The consumer derived one `jobId = ${task_id}:${invocation_type}:${24h-bucket}` for *all*
invocation types (`app.mjs` `deriveJobId`, Block 1/2). Every @-mention from this producer carries
`invocation_type='explicit_mention'`, so two **distinct** mentions on one task within the same 24h window
collapse to the same `jobId` → the second returns `deduped:true` and never processes. For the next 1–24h
the processor's `findCompletedRun` (matched on `task_id`+`triggered_by`+`status=completed` within
`dedup_window_h`) would also skip it. Net: after the first answer on a task, the agent silently ignores
every further @-mention on that task for ~24h. Block 2's "idempotent skip verified" test missed it because
it re-enqueued the *same* task+invocation — the exact duplicate the design suppresses — never two distinct
mentions. The today-synchronous path has no such bug (its only guards are the per-comment `Claim Comment`
PK and a 10-min/8-run loop-breaker, both of which pass a genuinely new comment).

**Root cause.** The ADR's job contract used **one** `dedup_window` for all invocation types. A 24h
task+type window is *right* for autonomous invocations (don't let a cron reprocess a task twice a day) and
*wrong* for interactive ones (each comment is a distinct request).

**The fix (consumer-only; no `agent_runs` schema change; keeps one path).** Made the dedup *unit*
invocation-class-aware (ADR-056 amendment 2026-06-26):
- **Explicit** (`explicit_mention`/`explicit_command`): `jobId = ${task_id}:${invocation_type}:c${dedup_comment_id}`
  (the comment's **own** id, from `payload.dedup_comment_id`). The `agent_runs` check runs **only as a
  retry-after-partial guard**: on `attemptsMade>0`, bounded to runs created **after** the job's
  `enqueued_at`. First attempt → comment-keyed `jobId` is the sole dedup → a distinct follow-up always
  drafts.
- **Autonomous**: unchanged (time-bucket `jobId` + full `dedup_window_h` window every attempt).

No `agent_runs` column was added: the producer's permanent `Claim Comment` (`agent_webhook_dedup` PK on
the comment id, migration 018) already guarantees one enqueue per comment, so the comment-keyed `jobId`
only ever collapses a true duplicate of the same comment; the cutoff-by-`enqueued_at` retry guard
distinguishes a retry-after-partial (completed run stamped *after* enqueue → skip) from a genuine
follow-up (sibling run stamped *before* enqueue → draft). The operator approved the simpler consumer-only
path over adding a `triggering_comment_id` column (the column would have required threading the id through
six hops — producer → job → consumer → ingress → orchestrator → `log-model-run` INSERT — for no
correctness gain, since the producer's claim already bounds enqueues).

Consumer files changed: `services/queue-consumer/app.mjs` only (`deriveJobId` forks on invocation class;
`findCompletedRun` takes an explicit `cutoffIso`; `processJob` gates the check on
`!isExplicit || attemptsMade>0` and computes the per-class cutoff; scope-header comment updated).
Redeployed via `docker compose up -d --build queue-consumer`; `/health` green, `concurrency=5`.

---

## What was built (producer)

Six nodes added to the live producer after `Under Limit?` (true), via `n8n_update_partial_workflow`
(15 ops atomic, then `cachedResultName` on the alert node), validated (`n8n_validate_workflow` → 0
errors), re-exported, drift-clean:

- **`Read Queue Flag`** (Postgres) — `select value from config where key='queue.enabled'`.
  `onError:continueRegularOutput`+retry → a DB blip passes through with no `value`, so `Queue Enabled?`
  reads false → synchronous fallback (fail-safe to the known-good path).
- **`Queue Enabled?`** (IF) — `String(value).trim().toLowerCase() === 'true'`. True → enqueue branch;
  false → `Run Agent Spine` (the existing synchronous node, unchanged).
- **`Fetch Task Impact`** (HTTP GET `/api/v2/task/{id}`, `clickUpApi` cred `QRrgf6hteyGWSJyv`) —
  `onError:continueRegularOutput`+retry → a ClickUp blip degrades to the `Średni` default, never a throw.
- **`Build Enqueue Job`** (Code) — resolves impact from the `[AI] Wpływ` custom field (`55c7ff79…`, same
  option map as `Assemble Parent Context`; default `Średni` for absent / `n/d` / unreadable) and builds
  the ADR-056 job: top-level `invocation_type='explicit_mention'` (drives priority + jobId +
  `agent_runs.triggered_by` idempotency); `payload` = `{reviewer_user_id, caller_username,
  triggered_by:'explicit_mention', triggering_comment_id (= reply_to_comment_id, the **thread root**),
  triggering_comment_text, dedup_comment_id (= the **own** comment id)}`.
- **`Enqueue Job`** (HTTP POST `http://queue-consumer:8080/enqueue`, internal Docker network, 10s timeout)
  — `onError:continueErrorOutput` → output 1 fans to **both** `Run Agent Spine` (fallback) **and**
  `Alert Enqueue Failed` (WARN). A non-200 or unreachable consumer never silently drops the mention
  (ADR-056 §9 failover).
- **`Alert Enqueue Failed`** (executeWorkflow → Post Alert `YSCdHlmdf3p9XEUx`) — WARN
  `cu-webhook/enqueue` with task id + truncated response.

The instant 200 (`responseMode:onReceived`) is unchanged on both paths — webhook latency unaffected (all
new work runs in the background of that already-answered execution).

---

## Definition of Done — live verification

Driving the real `@`-mention path required a **real tag-op webhook**. The ClickUp MCP posts plain
`comment_text` with **no tag op** — confirmed empirically (producer exec 4074: `Detect Mention`
`matched:false`, dead-ends at `If Mentioned`). So verification used two prongs, both live:

**Prong 1 — consumer/queue/spine/draft + the dedup fix** (jobs enqueued directly to `/enqueue` from
inside `n8n-internal` via `docker exec -i queue-consumer node`, mimicking the producer's exact job shape;
disposable task `869dwbwfk`, impact field set to `Wysoki`):

| DoD item | Result |
|---|---|
| queued job → real spine → draft | ✅ job 1 `…:c90120232575705` (priority **2** = explicit+Wysoki) → `agent_runs` **659** (caller 2521617, triggered_by explicit_mention, invocation_type explicit, completed, opus) → **one** threaded reply by "Agent Haxe" (correct Polish answer, addressed to Franciszek) |
| **distinct follow-up @-mention drafts** (the regression fix) | ✅ job 2 `…:c90120232576541` (distinct comment id → distinct jobId, `deduped:false`) → `agent_runs` **660** → its **own** distinct threaded reply. The old 24h-window logic would have silently skipped this. |
| same-comment re-enqueue dedups | ✅ re-POST of job 1's comment → `deduped:true` (no second run, no double-draft) |
| priority correct | ✅ both `priority:2` (explicit + Wysoki) |

**Prong 2 — the producer's new nodes + sync fallback** (a throwaway internal-only n8n workflow posted a
**properly tagged** comment via the agent's `clickUpApi` cred; triggered over the internal network):

| DoD item | Result |
|---|---|
| flag on → full producer queue branch | ✅ exec **4107** (884 ms, all background after the instant 200): `Detect Mention matched:true` → `Read Queue Flag value:"true"` → `Queue Enabled?` true → `Fetch Task Impact` (field `55c7ff79…` value 3) → `Build Enqueue Job` **impact:"Wysoki"** → `Enqueue Job` HTTP 200 `{jobId:…:c90120232585681, priority:2, deduped:false}` |
| …processed async into one draft | ✅ consumer log single clean lifecycle `enqueued → spine_call(attempt 0) → spine_completed(outcome:ok) → completed`; `agent_runs` **661**; no retry, no failure |
| webhook latency unchanged | ✅ `responseMode:onReceived` untouched; the 884 ms is background, the HTTP 200 is still immediate |
| **flag off → synchronous fallback drafts** | ✅ set `queue.enabled=false`, re-triggered the tagged poster → `agent_runs` **662** (a draft was produced) **and zero new `enqueued` events** in the consumer log → the producer took the `Run Agent Spine` branch, bypassing the queue |
| no agent→agent loop | ✅ the agent's own draft reply re-fired the webhook (it watches the task) but `Detect Mention matched:false` (literal "@Agent Haxe" text carries no tag op) → dead-ends |

**Alerts during the test (all explained, none Block-3-introduced).** Post Alert fired a few WARNs timed
with the spine runs; inspected:
- `agent-orchestrator/render` WARN ("model dodał tekst przed/po tablicy bloków JSON — odzyskano") — a
  benign model-output-shape warning from the spine, queue-independent, would fire identically on the sync
  path.
- `managed-agents/session` WARN ("użytkownik 99811284 nie ma aktywnego poświadczenia ClickUp") — a
  **test-harness artifact**: the throwaway poster posts *as the agent* (id 99811284), which has no ClickUp
  OAuth, so that session ran without scoped access; the real-caller jobs (659/660, caller 2521617) did not
  raise it. Net positive: it confirms the spine's own alert seam flows correctly *through* the queue. No
  CRITICAL; none indicate double-draft.

After testing: `queue.enabled` restored to **true** (the documented live default — the cutover is on);
both throwaway workflows deleted; test `agent_runs` rows 659–662 deleted; the 3 comment-keyed `haxeq`
job hashes flushed (DEL 3 / ZREM 3, 0 remaining); disposable ClickUp task `869dwbwfk` deleted. Producer
re-exported from live (`export-workflows.mjs`, curated notes preserved); `check-workflow-drift.mjs`
clean (39/39). Consumer healthy on the real ingress throughout; n8n core unaffected.

---

## Silent-failure modes covered by Block 3

- **Follow-up @-mentions silently dropped** (the regression): covered by the invocation-class-aware
  comment-keyed dedup + the retry-only `agent_runs` guard for explicit jobs. Verified live (jobs 1+2 both
  drafted).
- **Enqueue failure / unreachable consumer silently dropping a mention:** covered — `Enqueue Job`'s error
  output falls back to the synchronous `Run Agent Spine` **and** fires a WARN (`cu-webhook/enqueue`).
- **Config-read blip routing wrongly:** covered — `Read Queue Flag` fails to "value absent" → `Queue
  Enabled?` false → synchronous fallback (fail-safe to the known-good path), never a throw.
- **Impact-fetch blip:** covered — `Fetch Task Impact` degrades to the `Średni` default (Build Job
  try/catch + retry), never a throw; priority is still set 1..8.
- **In-thread follow-up re-collapse via wrong dedup key:** covered — the producer sends the **own** comment
  id as `dedup_comment_id` (distinct per mention), separate from the thread-root `triggering_comment_id`
  (the reply target).

**Knowingly deferred (scheduled, not silent gaps):** terminal attempts-exhaustion → CRITICAL DLQ alert
(Block 4); dead consumer → heartbeat (Block 5); backlog depth cron (Block 5); the config refresh poll
(Block 5).

---

## Operational notes / carry-forward

- **VPS SSH (port 22) flapped repeatedly** this block (multi-minute drops; the box + containers stayed
  healthy — verified via the HTTPS control planes: Supabase, n8n API, ClickUp). All VPS work was wrapped
  in SSH retries; enqueue/cleanup ran as `docker exec -i … node` one-shots over the recovering link. The
  HTTPS-side checks (Supabase `agent_runs`, n8n executions, ClickUp threaded comments) were the reliable
  verification channel when SSH was down. Worth a host/network glance — flagged in block-1 and block-2 too.
- **Local Git Bash lacks coreutils** (`grep`/`sleep`/`cat`/`head`/`tail` → "command not found"); do log
  filtering **server-side** (`docker logs … | grep …` over SSH) and use `ping -n N 127.0.0.1` for local
  waits. The n8n MCP tools and `inspect-execution`-style execution reads worked throughout.
- **Driving the real producer is not fully autonomous:** the MCP cannot post a tag-op comment, and forging
  a signed ClickUp webhook needs the HMAC secret (n8n credential, unreadable). Prong 2 used a throwaway
  internal n8n workflow with the agent's `clickUpApi` cred to post a real tagged comment — reusable pattern
  for any future test that needs a genuine mention webhook (create → activate → trigger over
  `n8n-internal` → delete).
- **`caller_user_id`/`impact` come from the producer now**, so a job's priority is fixed at enqueue; the
  spine still re-reads impact itself for tier routing (unchanged). The consumer stays ClickUp-credential-free.