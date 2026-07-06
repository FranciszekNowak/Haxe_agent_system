ADR-071: An empty deliver_output is bounced back once for re-delivery; the incomplete notice tells the truth

Status: ACCEPTED (shipped + verified live 2026-07-06). Refines ADR-063 (structured tool-call delivery),
ADR-066 (async session waiter), ADR-069 (document-only delivery).

Correction (2026-07-06, same day — supersedes the "empty delivery" framing below)

The first fix (retry + decline clause + honest notice, all described below) treated the symptom as an
EMPTY / declined delivery. A same-day recurrence on the same task (`869e0t8r2`) proved the actual root
cause: the agent produces a COMPLETE, correct answer but hand-serializes `blocks` into a JSON STRING that
is INVALID JSON — an unescaped `"` inside a Polish „…" quotation (`…o nowości"*`) — so every `JSON.parse`
throws and the whole answer is silently dropped, looking empty. The content was never missing. **Primary
fix:** `extractDeliverBlocks` (session-waiter) now repairs a malformed `blocks` string with the `jsonrepair`
library and re-parses, recovering the answer (validated: the exact failing delivery recovers to a full
2,185-character report). The retry, decline clause, and outcome-aware notice below are RETAINED as
backstops for a genuinely empty delivery, but they do NOT fix this failure — re-asking just makes the model
re-serialize the same broken string (observed: the retry fired and the second attempt failed at the same
character). Files (this correction): `services/session-waiter/app.mjs` (`extractDeliverBlocks` +
`jsonrepair` dependency), `services/session-waiter/package.json`.

Context

A managed agent submits its final answer by *calling* the `deliver_output` custom tool with a `blocks`
array (ADR-063). On 2026-07-06, task `869e0t8r2` (session `sesn_01PLkZMhhqXnEtHHQEdbs11u`) recurred a
failure mode we had seen before: the agent finished cleanly (`outcome=delivered`, `status=completed`) but
called `deliver_output` with an **empty** `blocks` array and produced **no** output files. Its actual answer
sat in ordinary assistant narration (`final_message_text`) — which, per the contract, never reaches the
recipient. The pipeline behaved correctly: `Publish Managed Result`'s `Session OK?` gate (ADR-066 Amendment 3
/ ADR-069) recognized an empty, doc-less delivery as non-publishable and took the failure branch. But that
branch posted the Polish notice *"Nie udało się dokończyć zadania w wyznaczonym czasie — agent nie dostarczył
wyniku"* ("failed to finish in the allotted time") plus a CRITICAL `managed-agents/non-delivery` alert — a
**timeout that never happened**. The user saw a false timeout instead of an answer, again.

Root cause is agent behaviour, not the pipeline. The output-format contract in `sync-agent-definitions.json`
(Build System, convention version 17) **already** stated, in plain Polish, that inline text reaches nobody
and that the whole answer — even a trivial one — must go inside `deliver_output`. The agent violated it
anyway (writing the answer inline and firing an empty tool call), and there was **no** guidance for the case
it actually hit: it set `impact: "n/d - zadanie nie jest dla AI"` ("not for AI") and bailed with an empty
report instead of delivering that conclusion.

We verified there is **no schema-layer enforcement** available: the Anthropic Messages / Managed-Agents API
does not enforce JSON-Schema array constraints (`minItems`) server-side. A default custom tool passes
`input_schema` to the model as guidance only; even `strict: true` excludes "complex array constraints", and
an empty `blocks: []` still satisfies `required: ['blocks']`. So `minItems: 1` would have been model
guidance, not a guarantee — the same category as the prose contract that was already ignored.

Decision

Three layers, from hard to soft, all shipped together.

1. **Deterministic verify-and-retry in the Session Waiter** (`services/session-waiter/app.mjs`). The waiter
   already drives the live session, detects the pending `deliver_output`, and captures its blocks. It now
   inspects the delivery *before* accepting it as terminal: if the block array is empty AND the session
   produced no output files (`GET /v1/files?scope_id=<session>` — the ADR-069 doc-only delivery, whose answer
   IS the file, is thereby preserved), it posts an `is_error` `user.custom_tool_result` to that
   `deliver_output` call — *"deliver_output nie zawierało żadnych bloków ani plików… dostarcz pełną odpowiedź
   ponownie…"* — and keeps driving the same session. The still-live agent gets the error back and re-delivers
   with real content. Bounded to `MAX_DELIVER_RETRIES = 1` (empty → one nudge → re-deliver; still empty ⇒
   fall through to the existing gate). Implemented identically on both the SSE-incremental and long-poll
   paths, guarded by `servicedIds` on the SSE path so a retry is requested once. The files-lookup is
   **fail-open**: on an API error it returns "not empty" (no retry), so a transient blip never bounces a real
   doc-only delivery. A `session-waiter/deliver-output-empty-retry` WARN records each retry.

2. **Decline clause in the contract** (`sync-agent-definitions.json → Build System`, CONV 17→18, re-synced to
   all agents). Explicit instruction that a refusal / "not for AI" / cannot-complete conclusion must still be
   delivered as a `text` block via `deliver_output`, and that ending with an empty `deliver_output` counts as
   non-delivery and reaches nobody. This is the *soft* layer — it reduces empty deliveries at the source and
   turns a decision to decline into a real delivered message; the retry (1) is the *hard* backstop.

3. **Honest incomplete notice** (`publish-managed-result.json`). The `Call Post Reply (Incomplete)` reply and
   the `Alert Non-Delivery` message are now outcome-aware. A `delivered`/`done`-but-empty session reads
   *"Agent zakończył pracę, ale nie przekazał żadnej treści odpowiedzi (pusty wynik)"* and the alert reads
   *"zakończyła się bez treści odpowiedzi (pusty deliver_output)"*; genuine `deadline`/`terminated`/etc.
   outcomes keep the timeout wording. This path still never publishes the agent's narration as the answer
   (ADR-069 intent preserved).

Rejected alternatives

- **`minItems: 1` on `deliver_output.blocks`** — not enforced server-side (verified), so no guarantee.
- **Publishing `final_message_text` as the answer on an empty delivery** — reopens ADR-069's deliberate
  refusal to publish mid-work narration; and in the triggering case that narration was a truncated preamble.
- **Reverting to plain-final-message delivery** — reopens the free-text-parsing fragility ADR-063 removed.

Consequences

- An empty delivery now gets one deterministic re-delivery chance, driven by explicit tool-error feedback
  (a far stronger corrective than passive prompting), before anything is published. If it still comes back
  empty, the now-accurate incomplete notice fires.
- Document-only deliveries (ADR-069) are unaffected — the Files-API check distinguishes "answer is a file"
  from "answer is nowhere". One extra Files-API call is incurred, but only on the rare empty-blocks path.
- The retry is still, ultimately, a bet on model compliance — but with `is_error` feedback rather than a
  passive prompt. The decline clause reduces how often the bet is placed.
- The false-timeout notice is gone; the alert channel regains precision for this outcome.

Verification

- Session Waiter rebuilt and restarted on the VPS (`docker compose up -d --build session-waiter`); container
  healthy, startup clean (`startup` → `listening` → `readopt_none`, i.e. no in-flight session disrupted).
  `node --check` clean; the deployed file diffs against the repo as exactly the four intended changes.
- Contract synced live: `Sync Agent Definitions` run returned `all_synced: true` at convention version 18
  with no stale tiers and no alerts; `sync-agent-definitions.json` re-exported and drift-clean.
- `publish-managed-result.json` deployed, validates with **0 errors** across 55 expressions, drift-clean
  (all 51 workflows match live).
- A live empty → retry → re-deliver round cannot be force-induced deterministically (it depends on an agent
  actually mis-delivering); it will be exercised on the next real empty delivery, with the corrected
  incomplete notice as the bounded fallback. The notice text itself is functionally testable via a crafted
  `delivered`-empty `test-subworkflow.mjs` run against `Publish Managed Result` (deferred — posts to a real
  task).

Files: `services/session-waiter/app.mjs`; `n8n/workflows/sync-agent-definitions.json` (Build System,
CONV 18); `n8n/workflows/publish-managed-result.json` (`Call Post Reply (Incomplete)`, `Alert Non-Delivery`).

Date: 2026-07-06
