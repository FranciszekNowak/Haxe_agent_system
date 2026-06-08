# ADR-029: ClickUp @-mention webhook trigger (automatic runs) + agent→agent loop guard

Date: 2026-06-08
Status: Accepted (built + verified live: a `@Agent Haxe` mention on `869dhad2q` ran the
spine end-to-end — `triggered_by=explicit_mention`, caller resolved to the mentioner,
rules loaded, draft posted).

## Context
Through Increment 1 the spine could only be started by hand (the Form Trigger). The
core model (`current.md`) calls for **automatic** runs: a human (or another agent)
@-mentions the agent on a ClickUp task, and the agent picks the work up. ClickUp emits a
`taskCommentPosted` webhook; we need a thin producer that decides "is this a real
mention of the agent?" and, if so, starts `Agent Spine (v1)` with the right caller/reviewer
attribution — without coupling the spine to ClickUp's webhook retry window.

## Decision
A dedicated **`CU Webhook Producer (v1)`** workflow (id `eS66Sk6fweQ0EOPa`) is the
production entry point; the spine gains a second trigger (`When Called`,
`executeWorkflowTrigger`) that the producer invokes. The Form Trigger stays as the manual
test harness. Flow:

`CU Webhook` (POST `/webhook/cu-comment`, `responseMode: onReceived` → instant 200, decoupled
from ClickUp's retry window) → `Get Comments` (the webhook payload doesn't reliably carry the
mention tags, so we re-fetch the task's comments) → `Detect Mention` (pure shaping) →
`If Mentioned` → **loop guard** → `Run Agent Spine`.

- **Mention detection.** Newest comment is "for the agent" iff it contains a `tag` block
  with `user.id = 99811284` (Agent Haxe). The **caller/reviewer = the comment author** (the
  mentioner). This matches "we mention each other, we don't assign" (ADR-027): the resulting
  draft @-mentions whoever called.
- **Reviewer rule (ADR-027) holds.** On the mention path the reviewer is unambiguous — the
  mentioner — so the assignee→creator fallback isn't needed here.
- **Webhook scope + secret.** The webhook is registered against the `Lista testy AI` list
  only (blast-radius containment for the MVP). The signing secret lives in n8n / ClickUp,
  **never in the repo** (signature verification is a known TODO — see Consequences).
- **Attribution.** The producer passes `triggered_by=explicit_mention`,
  `invocation_type=explicit`, plus `taskId`, `reviewer_user_id`, `caller_username` into the
  spine, which logs them on `agent_runs`.

### Agent→agent chaining + loop guard (operator decision 2026-06-08)
The original `Detect Mention` ignored any comment **authored by the agent** — a hard
loop-break. The operator wants to relax this so an agent can deliberately mention the agent
(agent A commits an artifact, then points another agent at it). We removed the
`author != agent` skip, with two reasons it is safe:

1. **Normal human-initiated runs never loop.** The agent's auto-draft @-mentions the *human*
   reviewer, not the agent, so the producer's "is the agent tagged?" test fails on the draft →
   no re-trigger. (Verified: the post-back drafts produced `matched:false`.)
2. **The only loop is a real agent→agent chain** (caller = agent → draft mentions the agent →
   re-triggers). To bound it we added a **circuit breaker**: before running, `Recent Runs`
   counts `agent_runs` for the task in the last 10 minutes; `Under Limit?` allows the run only
   if `< 8`, else routes to `Alert Loop Breaker` (WARN via the Post Alert seam, ADR-025).
   `Recent Runs` is `onError: continueRegularOutput` so a DB hiccup degrades to "allowed"
   rather than blocking legitimate work.

This honors the CLAUDE.md reliability rule (a feature that could silently run away gets an
error/over-limit path that posts a note), at a worst-case bounded cost of ~8 runs (~2–3 PLN)
before a runaway chain is cut.

## Consequences
- The agent now runs **automatically** on a real ClickUp mention, attributed to the
  mentioner — verified live on `869dhad2q`.
- Agent→agent chaining is enabled but **bounded** (≤ 8 runs / task / 10 min). The threshold
  is a deliberate, tunable guess; revisit if real chains need more depth, or replace the
  count-based breaker with explicit chain-depth metadata once the artifact-handoff pattern
  is designed properly.
- **Known gap — signature verification.** The producer does not yet verify ClickUp's
  `X-Signature`. Until it does, the webhook trusts any caller who knows the URL. Acceptable
  for the MVP (obscure path, list-scoped, low blast radius); must be closed before the agent
  acts on anything sensitive. Tracked as the next hardening step.
- The breaker also caps accidental human storms (8+ mentions on one task in 10 min) — an
  acceptable edge.

Related: ADR-027 (post-back draft + reviewer rule + mention-not-assign), ADR-026 (capability
containment — deterministic nodes only), ADR-025 (alert seam), ADR-015 (one generic
pipeline), ADR-024 (`agent_runs` / cost), ADR-004 (Docs v3 rules loading).

> Update 2026-06-08 — signature verification implemented (closes the known gap) + a loop it exposed.
>
> **HMAC verification (done).** The webhook node now uses `rawBody: true` (the exact signed
> bytes land in binary `data`; `$json.body` stays parsed, so `task_id` is unaffected and no
> decode node is needed). A native **`Verify Signature`** Crypto node computes
> `HMAC-SHA256(secret, rawBody)` in hex; **`Signature Valid?`** compares it to the
> `X-Signature` header — pass → `Get Comments` …; fail → **`Alert Bad Signature`** (WARN, seam)
> and the agent is **not** run. Verified live: valid sig proceeds, wrong/missing sig is
> rejected with a WARN.
>
> **Secret storage.** Empirically, this n8n instance blocks `require('crypto')` and `$env` in
> Code nodes (`N8N_BLOCK_ENV_ACCESS_IN_NODE`), so HMAC-in-code and env-based secrets are out.
> The Crypto node's v2 HMAC takes its secret from a **`crypto` credential** (`hmacSecret`),
> stored encrypted in n8n's DB and **never** serialized into the exported workflow JSON (only a
> credential-ID reference). That is the chosen secret store — no repo exposure, no `$env`.
> Credential: **"ClickUp Webhook HMAC"** (`NY5wM3VKKC1jZtQY`).
> **Operator action required:** set that credential's `hmacSecret` to the **real ClickUp webhook
> secret**. Until then it holds a placeholder and *all* real mentions are rejected (fail-closed)
> — each emits a `cu-webhook/signature` WARN explaining the mismatch.
>
> **Loop discovered & fixed.** Posting a bad-signature WARN as a comment on the **Alerts & Health
> task (`869dj2z2c`)** — which sits inside the watched list — re-fires the webhook → fails again
> → posts again → infinite loop (observed ~80 iterations before manual stop while the placeholder
> secret rejected everything). Fix: a **`Not Telemetry Task?`** guard as the *first* step drops
> any webhook whose `task_id` is the telemetry task, *before* the signature/alert path, so our own
> alert echoes can never re-trigger — independent of secret state. Verified live: a real WARN echo
> on `869dj2z2c` was dropped at the guard. (General principle: the producer must not act on its own
> telemetry; the alert channel and the watched work-list overlap.)
>
> **Residual risks:** (1) a deliberate flood of forged webhooks aimed at a *work* task_id would
> each fail verification and emit a WARN — i.e. an alert-spam vector (no loop; the WARN lands on the
> dropped telemetry task). Debounce/rate-limit if it ever becomes a problem. (2) Secret drift
> (operator rotates ClickUp's webhook but not the credential) now degrades to per-real-mention
> WARNs (sporadic, no loop) instead of a storm — the WARN is the signal to re-sync.

> Update 2026-06-08 (later) — secret set + verified live; webhook is production-ready.
> The `hmacSecret` was retrieved from ClickUp (`GET /api/v2/team/761759/webhook`) and written to
> the "ClickUp Webhook HMAC" credential. End-to-end proof: a real ClickUp-signed `taskCommentPosted`
> delivery (producer exec 264) passed `Signature Valid?` and continued into the pipeline, while a
> forged/unsigned POST routed to `Alert Bad Signature`. The earlier "operator action required /
> placeholder" note is therefore closed. (Webhook `health` read `failing/6` transiently from the
> deactivation window during the build; self-heals as 2xx deliveries resume — a proactive
> webhook-health WARN is a recommended future hardening, since auto-deletion after ~100 consecutive
> failures would otherwise stop mentions silently.)

> Update 2026-06-08 (later) — workspace-wide scope + payload-based mention detection.
> Requirement: employees must be able to @-mention the agent from **any** task, not one list.
> - **Scope.** ClickUp scopes a webhook by `list_id`/`folder_id`/`space_id` at creation and can't
>   re-scope on update, so the list-scoped webhook (`d6a9daaf…`, list `901218475160`) was deleted and
>   a **team-level** one created (`66208c81…`, all scope-ids null = whole workspace). New secret
>   rotated into the same `crypto` credential; verified only the team-level webhook remains and a
>   real signed delivery passes the gate.
> - **Overflow.** A workspace-wide webhook fires on *every* comment. ClickUp can't filter by
>   content, so we filter cheaply in n8n: `Detect Mention` now reads the tag straight from the
>   webhook **payload** (`body.history_items[].comment.comment[]` carries `{type:'tag',user}` + the
>   author — confirmed on a live delivery), and the `Get Comments` API call was **removed**. A
>   non-mention comment is dropped in-memory with zero ClickUp API calls (~12 ms producer run).
> - **Does not limit autonomous `Czy dla AI = Tak`.** That path is a *separate* trigger (daily
>   due-date cron + Phase-3 status/field-change webhooks gated by `Czy dla AI`), never mention-gated.
>   The mention filter lives only on the comment route. **Guardrail:** if the producer ever
>   subscribes to more events, route by event/field first and apply the right gate per route — never
>   a single global "must be a mention" filter.
> - **Identity note.** The agent ClickUp account is a **member** (role 3) — required, not a loose
>   end: only Members can generate the personal API token the pipeline needs (decided 2026-06-02,
>   ADR-004 update; see also ADR-026). Member = reads all public spaces, which also suits
>   workspace-wide mentions; caller-scoping is enforced in software (prompt + MCP) and the LLM stays
>   tool-less (ADR-026). Private spaces the agent isn't a member of won't deliver/read (a mention
>   there triggers but Context Gather 403s → WARN).
