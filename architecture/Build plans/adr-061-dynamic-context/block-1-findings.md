# Block 1 findings — ADR-061 floor assembler

Date: 2026-06-25. Stage A (`Assemble Context and Build Prompt (v1)`, `GGTBvFBgGSNbtUR6`) is now
lane-aware: the managed lane emits the bounded floor; the bare failover lane keeps full assembly.

## What changed

1. **New node `Read Lane (Stage A)`** (Postgres) — reads `config.agent_lane` early
   (`When Called → Read Lane → Call Assemble Parent Context`). `onError: continueRegularOutput` +
   `alwaysOutputData`, so a DB error still emits an item and `Build Prompt` defaults to `bare`/full
   — a managed run is never starved of context. Mirrors the orchestrator's `Read Agent Lane`.
2. **`Build Prompt` rewritten lane-aware.** `floorOnly = (agent_lane === 'managed')`. On the managed
   lane the prompt is the **floor**: personal prefs + triggering comment + a new `# Waga zadania`
   impact line (ADR-061 decision #4) + task title/description + eager input images. **Dropped on
   managed:** comment thread, ancestor bodies, linked-doc leaves, semantic-search context, attachment
   **text**, and the per-run global-rules fold. The bare lane is byte-identical to before (every tail
   gate is `&& !floorOnly` / `&& !isManaged`) plus the new impact line.
3. **Carry-forward (a) resolved — drop the duplicated global rules.** The per-run `# Zasady ogólne`
   block was page `q7wz-44812`, the **same page** Sync Agent Definitions bakes verbatim into the cached
   agent `system`. On the managed lane it was a pure ~3.5k-tok duplicate → dropped. `global_rules_missing`
   is now lane-aware (`isManaged ? false : !global_rules`) so the managed lane never fires a false
   "rules missing" WARN.
4. **One self-inflicted bug, fixed.** Inserting `Read Lane` inline broke `Call Assemble Parent Context`,
   which mapped `taskId` from the bare `$json.taskId` of the *previous* node (now Read Lane's row, no
   taskId) → empty id → ClickUp auth failure (exec 3826/3827 CRITICALs). Fixed by making the mapping an
   explicit `$('When Called').first().json.taskId`. Every other downstream node already used explicit
   `$('node')` refs, so this was the only break.

## Safety check — is it safe to drop the per-run rules on managed?

Yes. The rules must be present in the cached `system`, kept current. Verified against
**Agent Rules Freshness Check (v1)** exec **3819** (10:00, success):

- `current_sha = 087f37221c2f…` equals every agent's recorded `rules_sha256` (agent_routing, CONV=8,
  all 5 rows `has_agent=true`).
- `ok=3, stale=0, no_provenance=0` — each live agent's provenance marker matches the current doc hash,
  i.e. the baked rules are **byte-current** with live `q7wz-44812` ("treść na razie zgodna").

**New dependency (recorded in ADR-061 consequences):** the managed lane's rules currency now relies
entirely on the sync + freshness loop; the per-run fold no longer provides a fresh-every-run net. The
freshness check makes a stalled sync **loud** (WARN), so this is bounded, not silent.

**Pre-existing operational flag (NOT introduced by Block 1):** the same freshness check WARNs that
`Sync Agent Definitions (v1)` has not run successfully in **26h** (content still matches). Worth
checking the sync schedule — it is the load-bearing writer post-ADR-061.

## Measurement (live)

Replayed task `869dux9ne` (the heavy image-gen task = old exec 3767) through the new Stage A → exec **3835**:

| | Old (3767) | New floor (3835) |
|---|---|---|
| `# Zasady ogólne` (global rules) | present | **dropped** |
| `# Ostatnie komentarze` / `# Kontekst nadrzędny` / `# Szczegółowe wytyczne` / `# Dodatkowy kontekst` / `# Treść załączników` | present | **dropped** |
| `# Preferencje osoby` / `# Wiadomość wywołująca` / `# Waga zadania` / `# Zadanie` / `# Załączone obrazy` / `# Format odpowiedzi` | — | kept |
| prompt size | ~9.6k tok | **~3.4k tok** |

`agent_lane=managed`, `global_rules_missing=false`, all `*_ok=true`, no WARN fired (the run succeeded
cleanly; the only alerts in-window were the self-inflicted 3826/3827 CRITICALs, since fixed). For the
pathological 100k case (heavy doc text + 30+ comment thread) the win is far larger — that material is
exactly the dropped tail.

## Bare lane

Not flipped on prod (`config.agent_lane='bare'` would risk a real run hitting the failover during the
test window). Verified **structurally**: every tail gate is `&& !floorOnly`, and `floorOnly=false` on
the bare lane reproduces the prior code exactly, plus the one new (intended) impact line. Read Lane
fail-safes to `bare` so an unreadable flag also yields full assembly.

## DoD

- ✅ Managed lane → low-thousands floor (~3.4k), floor-only, metadata payload contract intact, zero tail
  tools (none exist until Block 2; rules served from cached `system`, verified current).
- ✅ Bare lane → full assembly preserved (structural + fail-safe).
- ✅ `Context OK?` guard fed a non-empty prompt; `Check Rules Loaded` / `Check Input Warnings` seams
  intact; `global_rules_missing` made lane-aware to avoid a false managed-lane WARN.
- ✅ Validation passes (0 errors), drift clean, touched workflow re-exported.
