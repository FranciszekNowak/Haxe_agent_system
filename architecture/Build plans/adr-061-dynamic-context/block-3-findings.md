# Block 3 findings — ADR-061 end-to-end + scope test, write-backs

Date: 2026-06-26. Final block. The 100k case re-run + the heavy/trivial split, driven on the **full
spine** (orchestrator `When Called` `a8XKaijkMFNBpRBa` via `scripts/test-subworkflow.mjs` with the
producer's exact inputs: `triggered_by=explicit_mention`, `invocation_type=explicit`, real
`reviewer_user_id=2521617`). Input JSON built with Node `JSON.stringify`, absolute scratchpad path
(never a hand-escaped heredoc, never the Form Trigger over the API). Live lane = `managed`. All five
routing tiers at `conventions_version=12` (today's sync), Wysoki→Opus.

Test task: `869dux9ne` ("Stworzenie moodboarda") — the standing heavy disposable test task (2 PNG +
2 product-image ZIPs [23 + 16 inner PNGs] + 1 DOCX, 13 comments incl. threaded replies, impact
**Wysoki**, `[AI] Czy zadanie dla AI = Nie` so the autonomous webhook gate is OFF). Reused the real
human triggering comment `90120231403669` as `triggering_comment_id` (so Stage C threads its reply)
— **no new comment created → zero production-webhook risk**.

## 1. Trivial-on-heavy ("2+2") — floor only, zero tail tools ✅

`triggering_comment_text = "Ile to jest 2+2? Odpowiedz krótko, samą liczbą."` → orchestrator exec **3969**
(41 s, success).

- **Stage A floor = 5,409 chars (~1.35k tok)**: personal prefs + triggering comment + `# Waga zadania`
  impact line + task **title** + the `get_task_details` hint. **No** description, **no** comment thread,
  **no** attachment text. (Image floor = the two top-level PNG refs, listed lazily; `Build Floor File
  Map` wrote both `source_ref`→`url` rows; `input_images_json='[]'` so no eager Files-API upload.)
- **Session: single turn, zero tail tools.** `input_tokens=2`, `cache_read_input_tokens=0`,
  `cache_creation.ephemeral_5m=30680`, `output_tokens=1521`. A tail round-trip would have shown
  `cache_read>0` + tool-result input tokens — neither present, so **no tail tool was called**.
- **Answer correct:** `"4"`, then a diligent flag that the trivial question doesn't match the moodboard
  task title (good agent behaviour, not a miss). Threaded reply posted (comment `90120232422007`).
- **The 100k→floor win, realized.** Only **2 uncached input tokens** because the global rules now live
  in the cached agent `system` (Block 1 dropped the per-run fold), vs Block-0 G3's ~6.8k-tok floor with
  rules inline and the ADR's original ~100k pathological case.

## 2. Heavy task — agent pulls only implicated material via four tail round-trips ✅

A 4-part `triggering_comment_text` engineered to require the description, the attachment list, a
zip-inner image, and a comment fact:
> (1) na podstawie OPISU zadania streść w 2 zdaniach…; (2) wypisz nazwy załączników; (3) otwórz
> pierwszy zip ze zdjęciami produktu i opisz zdjęcie o indeksie 5 ze środka; (4) sprawdź w
> komentarzach, jaki kolor obudowy zaproponowano.

Orchestrator exec **3982** (81 s, success). Floor still floor-only (5,742 chars). Session
`input_tokens=6`, **`cache_read_input_tokens=98299`**, `output_tokens=2937` — the large cache-read
proves the cached prefix is **re-read on every tool round-trip** (multi-pull heavy tasks still get
prefix caching; the practical answer to gate **G1** re-use). Four `Triggering Task Tail Handler (v1)`
sub-executions, one per tool, all `status=ok`:

| exec | tool | result |
|---|---|---|
| 3988 | `get_task_details` | title + status + full 4.7k-char description (the agent **pulled the description on demand**) |
| 3990 | `list_attachments` | 5 attachments; **both zips' inner manifests nested inline** (no extraction/upload) |
| 3992 | `get_task_comments` | 13 comments + threaded replies |
| 3995 | `get_attachment("6966c837-…zip:5")` | **exactly one** inner PNG (`Zdjęcia produktu/1000x1000/2.png`) as a Files-API vision block ("0 dok., 1 obr.") |

**Answer correct on all four parts** (threaded reply `90120232422702`): (1) summarised the moodboard
brief from the pulled description; (2) listed all 5 attachments and even flagged the duplicate
`gen_0.png` name trap; (3) accurately described the zip-inner lifestyle photo it **saw as vision**
(woman holding a black T-shaped massage gun with turquoise accents); (4) reported the color from the
comments (czarny korpus + turkusowe akcenty) and cross-checked it against the real product image.

**This runtime-confirms the two items earlier blocks left structurally verified only:** the agent
reliably pulls the description via `get_task_details` when the comment isn't self-contained, and the
`Execute Agent Session` loop services a `get_attachment("<zip>:<idx>")` inner pull end-to-end
(extractor single-entry materialize → `Upload Tail Images` → vision).

**Cost attribution** (via `Log Model Run`, before deletion): row 654 (trivial — caller 2521617, Opus,
in 2 / out 1521, 0.8695 PLN, completed) and row 655 (heavy — in 6 / out 2937, 0.7966 PLN, completed).

## 3. Per-user scope / cross-department negative — unchanged, confirmed ✅ (with one explicit non-coverage)

ADR-061 is **orthogonal** to the per-user scoping mechanism: it added bot-token tools for the
**triggering** task (which the caller already has access to) and shrank the floor; it did **not** touch
`extract_clickup_task` or the in-harness scoped `clickup_*` MCP. Confirmed structurally + empirically:

- The session still binds the **caller's** per-user ClickUp MCP **vault credential**
  (`clickup_mcp_vault_id`) and routes `extract_clickup_task` other-task discovery through
  `caller_user_id` — the ADR-054 Block 3a per-user credential scoping, intact.
- The triggering-task **tail** tools take `clickup_task_id` from the **n8n-carried** value, never agent
  input — the agent **cannot widen scope**. Empirically the heavy run passed only `attachment_id`
  (e.g. `{"attachment_id":"6966c837-…zip:5"}`), never a task id.

**Explicitly not re-run:** the full ADR-054 Block 5 two-user / two-department live negative. Its
fixture (a second onboarded user + a task in a department they cannot see) is out of scope for this
block, and the scoping mechanism it exercised is unchanged by ADR-061. Flagged for the operator: if you
want fresh runtime coverage of the cross-dept negative, it is an ADR-054 Block 5 re-run, not a Block-3
regression.

## 4. Alerts / executions / drift — clean ✅

- `alerts-since.mjs 20` (the Block-3 window) → **0 CRITICAL, 0 WARN**. (A single `tail-unknown-tool`
  WARN at 08:08 belongs to the earlier Block 2c follow-on's deliberate bad-tool probe, 25 min before
  these runs.)
- Executions inspected node-by-node (`inspect-execution.mjs`) — Stage A emitted the floor, the session
  called exactly the implicated tools, no silent fallback.
- `check-workflow-drift.mjs` → **all 38 workflows match live** (expected — Block 3 changes no workflow
  JSON; it is test + documentation only).
- **Cleanup:** test `agent_runs` rows 654 + 655 deleted. The two threaded reply comments remain on the
  disposable test task (ClickUp has no delete-comment API in the tool set; consistent with prior
  blocks). The task's status field flips `W trakcie → Zakończono` per run, ending where it started.

## Write-backs done

- **ADR-061:** line-1 title typo `ADR-060` → `ADR-061` fixed; Status `Proposed` → **Accepted**
  (`Date: 2026-06-23 (accepted 2026-06-26)`); added a Block-3 end-to-end consequence and a deferred
  consequence pointing at ADR-062.
- **`architecture/current.md` §15.2:** added the Block-3 end-to-end + scope verification note under the
  Stage B managed-session description (floor + lane guard and bot-token tail tools were already
  documented by Blocks 1/2/2b/2c — this reconciles §15 to the verified final state).
- **ADR-062 created** (`062-tier-additive-cached-system-prefix.md`, **Proposed — deferred, not
  scheduled**): records the tier-additive cached system prefix as the follow-up, with the three real
  revival gates (four tier-specific `system` variants; per-tier cache-prefix stability proof; rules-doc
  source reconciliation) and the explicit note that it is **not** a token-savings lever.
- Master-plan status table: Block 3 → done.

## Carry-forward / known residuals (unchanged by Block 3)

- **Bare failover lane runtime coverage** is still deferred (the prod `config.agent_lane` flip is
  access-gated; the bare path is structurally unchanged — gates are `!floorOnly`). An operator-supervised
  flip would give runtime coverage if desired.
- **Zip-inner images** are seeable as vision via `get_attachment("<zip>:<idx>")` but still not wired
  into `embed_input` / `reference_file_ids` (accepted regression from Block 2b/2c).
- **Quality risk (knowingly uncovered):** the agent *choosing not* to pull context it should — no thrown
  error detects it. Standing risk across all lazy tail tools.
