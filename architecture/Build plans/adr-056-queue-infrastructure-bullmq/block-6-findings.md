# Block 6 findings — burst + priority + negative-config acceptance; doc reconciliation; LIVE (2026-06-26)

Block 6 is the acceptance gate and the final reconciliation. No net-new product code — it proves the
behaviours the earlier blocks built, reconciles `current.md` §14/§15 from the stale n8n-queue-mode plan to
the as-built BullMQ design, flips ADR-056 to **Accepted**, and marks the queue **LIVE**.

The whole acceptance suite ran against the **isolated `agent-jobs-test` queue** (`haxeq:agent-jobs-test:*`)
with **no real spine call and no Anthropic cost**, via `docker exec queue-consumer node --input-type=module
-e …` — so it generated **zero n8n executions** (heeding the CLAUDE.md Insights-flood caution) and touched
neither the production `agent-jobs` queue nor any real ClickUp task. Test keys were flushed after each step.

---

## Acceptance results (all live)

### 1. Priority formula — 8/8 buckets correct
A transient consumer (`docker run --rm`, image `haxe-agents-queue-consumer`, `QUEUE_NAME=agent-jobs-test`,
spine + alert URLs black-holed) computed priority via the **real `/enqueue`** for all 8
(invocation_type × impact) combinations. Read-back priorities were exactly:

| invocation_type | impact | priority |
|---|---|---|
| explicit_mention | Krytycznie ważne / Wysoki / Średni / Niski | 1 / 2 / 3 / 4 |
| due_date | Krytycznie ważne / Wysoki / Średni / Niski | 5 / 6 / 7 / 8 |

Confirms `priority = (is_explicit ? 0 : 4) + impact_rank` end-to-end (the Polish `[AI] Wpływ` labels
round-tripped through the API intact).

### 2. Strict dequeue order — explicit before automatic
8 jobs added in scrambled order `[5,2,8,1,6,3,7,4]` with a **concurrency-1** worker drained in order
`[1,2,3,4,5,6,7,8]`. This proves BullMQ honours the priority key strictly, that **every explicit job
(1–4) precedes every automatic job (5–8)**, and specifically that an **automatic `Krytycznie ważne` (5)
waits behind an explicit `Niski` (4)** — the intended, not accidental, cross-class ordering.

### 3. Burst pacing + priority jump
52 jobs (50 automatic at priority 8, then **2 explicit at priority 1 enqueued LAST**), worker
concurrency 5, 150 ms processor:
- **max-in-flight observed = 5** — the worker paced the burst at exactly the concurrency cap, never
  exceeding it. This is the "50 tasks at midnight without a 429/529 storm" property: in-flight is bounded
  to C, the rest wait.
- both explicit jobs completed at **positions 0 and 1** — they jumped the entire 50-job batch despite
  being enqueued after it.

### 4. Negative config — the silent-failure gate (operator-authorized temporary edit)
`queue.concurrency=99` and `queue.lock_duration_ms=120000` were written to the shared `config` (both pass
the migration-045 DB trigger's *absolute* bounds **by design** — the trigger deliberately lets
`concurrency > env_cap` through so the read-side clamp is exercised). On consumer restart, the fail-safe
reader clamped **all three coupled invariants** and WARNed each to the Alerts channel
(`queue-consumer/config`, 0 CRITICAL):

| knob | bad value | clamped to | guard |
|---|---|---|---|
| concurrency | 99 | 10 (= env_concurrency_cap) | 429/529-storm |
| lock_duration_ms | 120000 | 1020000 (= max_runtime_ms + MARGIN) | stalled-rerun → double-draft |
| spine_timeout_ms | (1200000) | 900000 (= lock_duration_ms − MARGIN) | premature-abort → double-draft |

The third is a **cascade**: raising `lock_duration_ms` pushed `spine_timeout_ms` above its derived ceiling,
so it was lowered too. The effective running config used the clamped values — **bad values never reached
the worker**. Reverted to `5` / `1500000`; clean restart, 0 WARN, healthy.

### 5. Idempotent runs + exactly-once dead-letter
Not re-run — both were proven live earlier: idempotent-skip in Block 2 (`prior_run_id` skip, no spine call)
and Block 3 (comment-keyed dedup, two distinct mentions both drafted), and exactly-once dead-letter in
Block 4 (`alerts-since.mjs` → 2 CRITICAL / 0 WARN, not 3). Re-running would only add test artifacts.

**Cleanup.** Transient consumer `--rm`'d; all `haxeq:agent-jobs-test:*` keys flushed (verified 0
remaining); production `agent-jobs` empty + `alert:null`; `config` reverted and re-verified; consumer
healthy (`/health` ok, concurrency 5).

---

## Documentation reconciliation (write-backs)

- **`current.md` §14** rewritten from the stale n8n-queue-mode spec to the **as-built BullMQ design**:
  §14.2 (stack → BullMQ + thin consumer; **n8n stays in queue mode, BullMQ coexists by prefix `haxeq`**),
  §14.3 (→ 8-level explicit/impact priority), §14.4 (Bedrock per-integration RPM → Managed-Agents limits +
  concurrency cap as the primary control), §14.5 (BullMQ backoff + ADR-047 classification + the
  exactly-once DLQ alarm), §14.6 (the depth cron + heartbeat dead-man's-switch). The §14 banner flipped
  from "⚠ being replaced" to **✅ LIVE**; the verbose block-by-block status block was condensed to a
  short as-built summary.
- **`current.md` §15.10** planned producers now state they adopt the `/enqueue` contract and land in the
  automatic priority band 5–8 (stale 1/5/10 priorities removed). §15.7 already documented the Block-3
  cutover.
- **Docker-stack list** corrected: "six containers" → **eight** (it had silently omitted `zip-extractor`
  too); added a `queue-consumer` entry (ADR-056) + a `zip-extractor` pointer (ADR-058).
- **ADR-056**: Status **Proposed → Accepted**; the §1/R3/topology "n8n stays in regular mode" line
  **corrected** (struck + annotated) to "stays in queue mode, BullMQ coexists by prefix"; Block-6 line
  marked done; a **Block-6 amendment** appended (the two decision corrections + the acceptance results).

`check-workflow-drift.mjs` clean (no n8n workflow changed in this block).

---

## Why the regular-mode reversal matters (the load-bearing correction)

The original ADR's biggest miss was rejecting "BullMQ + n8n queue mode together" as redundant. They are
not redundant — they are at different layers. n8n queue mode isolates *n8n executions* (memory/crash
isolation of the base64 image path and Docling off the webhook/UI process — ADR-058 depends on the
main/worker split); BullMQ admits *agent jobs* (priority, Managed-Agents concurrency, retry/DLQ,
idempotency) and can only *trigger* n8n, never execute it. Going regular mode would have collapsed every
execution into `n8n-main`'s 768 MB heap — a reliability regression — and only becomes clean once image
generation is containerized (deferred by ADR-055). The two coexist safely on one Redis via distinct key
prefixes (`haxeq:*` vs `bull:*`), at a cost of ~tens of MB. This is now the documented as-built topology.

## Silent-failure coverage (final tally for ADR-056)

- **Dead consumer** → host heartbeat dead-man's-switch (Block 5), verified.
- **Backlog / wedged worker** → depth cron, targeted alarm (Block 5), verified.
- **Config mis-edit** → read-side clamp + WARN on all three coupled invariants (Block 1 + this block),
  verified live this block for all three.
- **Terminal job failure** → exactly-once DLQ CRITICAL (Block 4), verified.
- **Spine-trigger infra failure** → retryable throw → eventual DLQ (Block 2), verified.
- **429/529 storm under burst** → concurrency cap paces in-flight to C (this block), verified (max-in-flight
  held at 5).
- **Double-draft** → idempotency check + `lock_duration ≥ max_runtime + MARGIN` clamp + business failures
  kept as `200 + status` (not 5xx) (Blocks 1–3), verified.
