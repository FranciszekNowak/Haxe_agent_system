# ADR-053 Block 9 — end-to-end cutover, GDPR record, write-backs: findings

**Status: DONE 2026-06-22.** The Managed Agents lane is now the **default** (`config.agent_lane='managed'`).
The full cross-modality Definition-of-Done matrix passed live through the orchestrator; the one defect the
matrix surfaced was fixed mid-block; the documentation (current.md, ADR-053, the GDPR record, the superseded
file-output plan) is reconciled. The bare LiteLLM lane is retained, unchanged, as the dormant failover.

## The gate that had to be resolved first — Fable 5 → Opus 4.8

Block 8 left a hard precondition: **do not flip the default until the Krytycznie ważne (Fable) tier is
serviceable on the managed lane.** Re-tested live (2026-06-22): a session against the Fable agent
terminates with the provider error **"Claude Fable 5 is not available. Please use Opus 4.8"**
(`retry_status: exhausted`) — Fable 5 on the Managed Agents beta is gated behind a separate "Fable Mythos"
access program we are not in.

**Resolution (operator-approved):** repoint the `agent_routing` row for **Krytycznie ważne** from the Fable
agent to the **Opus 4.8** agent (`agent_01TNKHGAg5CHDe93Gai7CKoP`, `claude-opus-4-8`). Rationale:

- Anthropic's own error directs callers to Opus 4.8; it is the strongest Claude model we actually have.
- It mirrors the bare lane's existing Fable→Opus fallback (ADR-037).
- It is fully reversible — repoint the row back when Fable Mythos access is granted.
- **It is durable against `Sync Agent Definitions (v1)`**: Sync reads `agent_routing` as the impact→tier
  source of truth (`select distinct on (model_id) … from agent_routing`) and writes agent metadata back
  keyed by `model_id`. So pointing the row at `claude-opus-4-8` makes Sync treat Opus as serving two
  impacts (Wysoki + Krytycznie ważne) — exactly as Sonnet already serves Średni + `__default__` — and the
  now-unreferenced Fable agent is simply left dormant in the Anthropic org (no longer synced).

Verified live: a Krytycznie ważne session now returns a clean block-array on `claude-opus-4-8`
(`status: completed`, exec 3022). Recorded as an amendment in ADR-053.

## The defect the cutover testing caught (and the fix)

The output adapter `Render Agent Output (v1)` parses the agent's final block-array (a fenced ```json array).
Two of the text-heavy DoD runs hit its parse-fallback, and inspection showed a genuine user-facing failure:
on the **vision** run the agent emitted a clean ```json fence, but with **literal, unescaped newlines/tabs
inside the JSON string values** (a very common model-output defect when writing multi-line markdown into a
JSON string). `JSON.parse` therefore threw, and the old fallback dumped the **entire raw `output_message`
(fence and all) into the ClickUp comment as one text block** — i.e. the user got a raw JSON blob, not a
readable answer.

**Fix (in `Render Agent Output (v1)` → node `Parse Blocks`):** after a strict `JSON.parse` fails, run a
single-pass repair that walks the string and escapes raw control characters (`< 0x20`) that occur **inside**
string literals (tracking the in-string / escape state), then re-parse. Only if that also fails does it fall
back to plain text — and the fallback now uses the fence-stripped `raw`, never the original `output_message`.
The repair only runs on the already-failing path, so payloads that parse strictly today are untouched
(verified: the image-gen and office-doc runs, whose JSON was valid, behaved identically). Re-verified live
(exec 3100): the vision response now renders as **structured ClickUp ops** (header, bold, bullets) instead of
a raw-JSON dump. Pushed live via `import-workflow.mjs`, re-exported, drift clean.

## Known limitation carried forward (fast-follow, not a blocker)

`embed_input` — re-embedding an image **already attached to the task** back into the reply — is **not
supported on the managed lane.** The agent emits `{type:image, mode:embed_input, ref:"<clickup-filename>.png"}`
(a ClickUp attachment filename, not a Files-API `file_id`), so the adapter cannot fetch the bytes → it renders
`[Obraz niedostępny]` and fires an `output-adapter/image-ref-unrecognized` WARN. The vision **description**
works fully (the agent sees and describes the input image); only re-displaying the already-attached image is
unsupported. A future fix would resolve the input image's bytes via `agent_input_file_map` (the signed URL we
already store) and deliver it like a generated image. Documented; left for a follow-up.

## Live DoD matrix (all delivered to ClickUp; 0 CRITICAL; every WARN explained)

Driven through `Agent Orchestrator (v1)` via `test-subworkflow.mjs` with producer-exact inputs
(`triggered_by=explicit_mention`, `invocation_type=explicit`, reviewer `2521617`), `config.agent_lane='managed'`:

| Modality | Task | Tier / model | Result |
|---|---|---|---|
| Text | `869dp7vkg` | Niski / Haiku | Comment posted, no warnings (exec 3026) |
| Web research | `869dmarca` | Średni / Sonnet | `web_search_count=1`, **no n8n research workflows**, comment posted (exec 3042). Agent answered in prose → adapter parse-fallback WARN (content delivered correctly as text) |
| Image generation | `869dp7vjz` | Niski / Haiku | MCP → carrier → `image_manifest` (1.6 MB PNG) → inline image in ClickUp, attachment id recorded, per-image cost row written (exec 3060) |
| Image input / vision | `869dp7ww2` | Niski / Haiku | Agent described the input image (Files API vision); after the adapter fix renders structured (exec 3082 pre-fix → 3100 post-fix); embed_input WARN per the known limitation |
| Office-doc | `869du324d` (disposable) | Wysoki / Opus | xlsx via Skill with the fed numbers (111/222/333) + formula sum 666, enumerated as a session file, delivered as a ClickUp attachment, **attachment id recorded on `agent_runs`** (exec 3118) |
| Critical tier | session-level | Krytycznie ważne / Opus | Returns block-array on `claude-opus-4-8` (exec 3022) — confirms the Fable→Opus repoint |

Cost: each managed run logs one priced session `agent_runs` row (Haiku ~0.11, Sonnet ~1.27 with cache
creation, Opus ~1.39 PLN) plus the image batch's per-image rows; `Log Model Run (v1)` keeps sole FX/PLN
ownership. Minor observation: each run also writes a small `haxe-haiku-4-5-direct` row (~0.003 PLN, no
comment) from a pre-existing Stage A helper call (Assemble Context) — unchanged by Block 9, not a duplicate
delivery.

**Alerts:** 0 CRITICAL, 4 WARN in the test window — all explained: the pre-fix vision parse-fallback (now
fixed), the web-research prose fallback (acceptable; content delivered), the embed_input known-limitation
WARN, and the Fable-gate diagnostic that drove the repoint.

## Bare lane (failover) — unchanged, still selectable

Block 9 changed nothing on the bare lane; the only workflow change (the `Render Agent Output` adapter) is
managed-lane-only. The bare lane (`Execute LLM Call (v1)` + `Image Resolver (v1)`) was verified end-to-end in
Block 8 (execs 2827, 2908, incl. the `__invalid__`→bare fail-safe) and remains the dormant outage failover,
selectable via `config.agent_lane='bare'`. (The auto-mode safety classifier even blocked a transient test
flip back to `bare` as "undoing the cutover" — an extra guard on the default.) Note the bare failover is now
text+image only; web research was retired from Stage A in Block 8.

## Write-backs landed this block

- `architecture/current.md` — §2 Layer 3, §3, and §15 rewritten to describe the managed lane as live and the
  default; the long planned-state "Accepted redirection" section collapsed to a concise "live" summary that
  points to this build-plan directory for per-block detail.
- `architecture/decisions/053-switch-to-managed-agents.md` — status flipped to landed; added the
  **Fable 5 → Opus 4.8** amendment and the **output-adapter JSON-robustness** amendment; a "Landed" summary.
- `compliance/gdpr-processing-decisions.md` — recorded the new processing surfaces of the managed lane
  (Anthropic Files API, code sandbox, Skills, in-harness web search, the self-hosted image MCP endpoint, and
  the `agent-output-images` Supabase Storage carrier bucket) and the global-endpoint-for-PII posture.
- `architecture/Build plans/file-output-generation-build-plan.md` — marked **superseded** by this plan
  (office docs are produced by Anthropic Skills on the managed lane, not the bare Messages API + code-exec).
- `architecture/Build plans/adr-053-managed-agents/master-plan.md` — Block 9 status row → DONE.

## Cleanup

Test `agent_runs` rows (the gate tests + the matrix rows 603–615) deleted; the disposable office-doc task
`869du324d` deleted; the reusable `Lista testy AI` tasks keep their test comments (consistent with prior
blocks). Test sessions / Files-API uploads left per the Block 3–5 precedent (cannot delete without exposing
the key on the CLI; harmless, `purpose=agent`). `config.agent_lane` intentionally left at **`managed`** (the
cutover).
