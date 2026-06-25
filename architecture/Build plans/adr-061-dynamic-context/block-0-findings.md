# Block 0 findings — ADR-061 capability gates

Date: 2026-06-25. Method: read-only measurement against the live n8n
(`https://agents.haxe.ai`) — recent real Stage-A and sub-workflow executions; no system change,
no ClickUp side-effects created. (G1's tier-cache gate is deferred with Block 3.)

## G2 — lazy single-attachment extraction works mid-session ✅ RESOLVED

Confirmed by existing live evidence + a trivial, located code change:

1. **Extraction works** — `Read Input (v1)` (`zgGpONulGMohQQqI`) Docling-extracts documents and returns
   `blocks[]` in production: recent runs measured 12–20 s when documents are present, 0.3 s when not
   (durations below). So the extraction primitive is live, not hypothetical.
2. **Mid-session delivery works** — `extract_clickup_task` (ADR-054 Block 4b, live-verified
   2026-06-23) already drives Read Input mid-session and returns document text + image `file_id`
   vision blocks as a `user.custom_tool_result` inside the 840 s poll loop. The bot-token variant
   ADR-061 needs is *simpler* than that proven as-U path (no per-user token routing).
3. **Single-attachment filter is a one-line addition** — `Explode Attachments` (Code) already builds
   one item per attachment carrying `att_id`. Lazy `get_attachment(attachment_id)` needs only: an
   optional `attachment_id` input on the `When Called` node + `if (wantId && String(a.att_id) !==
   String(wantId)) continue;` in the loop. The no-attachment sentinel (which prevents a zero-item
   Explode from silently nulling the chain) is preserved. This is Block-2 work; Block 0 confirms it
   is clean and located.

**Verdict:** no reshape. Build the tail handlers on the bot token; add the single-attachment filter
to Read Input in Block 2.

## G3 — floor size + round-trip latency ✅ MEASURED

### Floor decomposition (real data)

Decomposed Stage-A execution **3767** (one of the heavier recent real runs, ~9,598 tok total prompt;
~4 char/token estimate):

| Prompt section | ~tokens | floor / tail |
|---|---|---|
| `# Zasady ogólne` (global rules doc) | 3,534 | floor |
| `# Preferencje osoby` (personal prefs) | 522 | floor |
| `# Wiadomość wywołująca` (triggering comment) | 978 | floor |
| task title + description | ~1,789 | floor |
| comment thread (`task_comments`) | ~1,181 | **tail (removed)** |
| `Załączone` attachment section | ~1,595 | **tail (removed)** |

Component sub-workflow outputs on the same run: `Assemble Task Context.task_comments` ≈ 1,181 tok;
`Read Input.blocks` ≈ 8,177 tok (mostly **image refs/metadata** here — only ~1,595 folded as text,
i.e. this task's attachments were images, not big documents); ancestor chain ≈ negligible (root).

**Floor ≈ 6.8k tok on this normal task; tail removed ≈ 2.8k.** None of the 15 recent real runs
exceeded ~9.6k — because none carried heavy Docling-extracted **document** attachments or a 30+
comment thread. The pathological **100k** case (ADR §16) is exactly those two: large PDF/XLSX text
(can be 80k+ tok) and a long comment thread — **all tail.** So the 100k→~floor win scales with tail
weight and is fully realized by Block 1; the floor is bounded at rules + comment + title/description.

### Honest nuance on "low thousands" (matters for the Block-3 deferral)

The floor's dominant fixed cost is the **global rules doc (~3.5k tok)**. The ADR's "low thousands
(floor + cached prefix)" assumes Block 3 has moved the rules into the **cached** static prefix
(~10× cheaper). With Block 3 deferred, the rules stay in the **uncached** per-run floor, so the
floor is ~5–7k tok on a real task, not ~1–2k. This is **not a regression** (the rules are already
uncached in today's prompt); it just leaves that incremental saving on the table until the Block-3
follow-up.

**Bonus finding → Block-1 opportunity:** the managed lane may be **double-paying** the rules. Stage A
folds CU doc **`q7wz-16892`** into the per-run prompt (`Load Agent Rules`), while
`Sync Agent Definitions` bakes CU doc **`q7wz-44812`** into the agent `system` (which the harness
caches). If those two docs overlap, the ~3.5k floor rules block is redundant with the cached system
rules and can be **dropped from the per-run prompt on the managed lane in Block 1** — pulling the
floor down to true low-thousands (comment + title + description ≈ 1.5–3k) **without** needing Block 3.
**Action: verify the q7wz-16892 vs q7wz-44812 content overlap at the top of Block 1** before deciding
whether Block 1 also drops the per-run rules fold.

### Round-trip latency (sub-workflow runtimes, 8 recent runs each)

| Tail tool → reused workflow | durations (s) | avg |
|---|---|---|
| `get_task_comments` → Assemble Task Context | 0.8, 0.4, 0.2, 0.6, 0.4, 0.6, 0.2, 0.2 | **0.4 s** |
| `get_parent_chain` → Assemble Parent Context | 1.8, 0.4, 0.2, 0.5, 0.9, 0.3, 0.3, 0.7 | **0.6 s** |
| `get_attachment` / `list_attachments` → Read Input | 19.8, 2.4, 0.3, 0.3, 13.3, 12.1, 12.6, 4.3 | **8.1 s** (0.3 s no-doc → 12–20 s Docling) |

Comments/parents are sub-second. Only **document** extraction is slow (12–20 s) — and lazy/on-pull
means it is paid once per **implicated** document, one at a time, well inside the 840 s poll deadline.
`list_attachments` (ClickUp metadata, no extraction) is ~0.3 s. This validates locked decision #3
(lazy attachments): the cheap metadata index gates the expensive extraction to only what the request
touches.

## DoD

- ✅ Single-attachment bot-token extraction confirmed feasible mid-session (G2) — proven primitive +
  one-line located filter; no reshape.
- ✅ Floor size measured on real data (~5–7k uncached with rules in floor; ~1.5–3k if Block-1 drops the
  duplicated rules fold) and per-round-trip latency measured (sub-second for comments/parents, 12–20 s
  per implicated document) (G3).
- ➕ Two carry-forwards into Block 1: (a) verify q7wz-16892 vs q7wz-44812 overlap and drop the
  redundant per-run rules fold on the managed lane if they overlap; (b) the lane-aware guard keeps the
  bare lane on full assembly.
