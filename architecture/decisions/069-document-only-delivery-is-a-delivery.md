ADR-069: A document-only delivery is a delivery (doc_files counts toward the publishable-answer gate)

Status: ACCEPTED (shipped + verified live 2026-07-02). Refines ADR-066 Block 1 Amendment 3.

Context

The shared `Publish Managed Result (v1)` sub-workflow decides whether a finished managed-agent
session produced a publishable answer via its `Session OK?` gate. ADR-066 Block 1 Amendment 3
(2026-06-30) re-cut that gate to discriminate on `outcome`, not text presence: it passed **only**
for `(delivered_via_tool AND output_blocks non-empty) OR (outcome === 'done' AND output_message
non-empty)`. Any `delivered` result with an **empty `output_blocks` array** was treated as a
non-delivery — routed to `Call Post Reply (Incomplete)` (a Polish "did not finish in time / no
result" notice) plus a CRITICAL `managed-agents/non-delivery` alert. That guard was written to stop
a `deadline` run's mid-work narration (`output_message`) from being published as the answer.

On 2026-07-02, task `869dxn3d8` (session `sesn_01M83MpaMoUBAbToZr7cYAvo`) exposed a hole in it. The
agent produced a 5.6 MB PowerPoint (`Podejscie-Haxe-do-AI.pptx`) and delivered it by calling
`deliver_output` with an **empty** `output_blocks` array: the artifact was the file (enumerated
authoritatively from the Files API into `doc_files[]`) and the narration ("The deck is complete,
verified, and saved to outputs.") went into `final_message_text`. The session finished cleanly
(`outcome=delivered`, `status=completed`). But the gate recognized text blocks and a `done`
free-text message as deliverables and **ignored `doc_files`** — so an empty `output_blocks` fell to
FALSE. The run therefore:

- posted the false notice *"Nie udało się dokończyć zadania w wyznaczonym czasie — agent nie
  dostarczył wyniku"* (a timeout that never happened),
- fired a CRITICAL `managed-agents/non-delivery` alert whose own details line read
  `outcome=delivered; status=completed` (self-contradicting), and
- because it took the failure branch, **never attached the `.pptx`** — the delivered path is what
  downloads/validates/attaches `doc_files`.

Two `deliver-output-empty` WARNs also fired (the async `Session Waiter Finish → Build Result`; the
sync `Execute Agent Session → Build Final Output` would fire the same), because that WARN keyed on
`delivered && output_blocks empty` without considering `doc_files`.

Root cause: the "publishable answer" definition covered text and free-text `done` messages but not a
produced office document, even though `doc_files[]` is the authoritative, agent-independent
enumeration and `Post Reply (v1)` already knows how to download, validate, and attach it. A
document-only delivery — a common shape for "make me a deck / spreadsheet" tasks, where the answer
IS the file and the comment is a short note — was structurally misclassified as a failure.

Decision

1. **`Session OK?` gate (`Publish Managed Result (v1)`)** — a delivery is publishable when
   `delivered_via_tool` AND (`output_blocks` non-empty **OR** `doc_files` non-empty). The
   `outcome === 'done'` free-text branch is unchanged. Non-delivery outcomes (`deadline` /
   `terminated` / `max_rounds` / `poll_error` / `send_failed` / `create_failed`) still fail the gate
   because `delivered_via_tool` is false there, so mid-work narration is still never posted as the
   answer — the ADR-066 Block 1 intent is preserved, only the empty-block sub-clause is refined.

2. **Render Agent Output (`Parse Blocks`)** — when the delivered block array is empty, render
   `output_message` as the comment body so a delivered doc-only comment is never blank. The
   `output-adapter/no-deliver-output` WARN still fires **only** for the genuine protocol violation
   (`delivered_via_tool` false and no blocks); a legitimate tool delivery with docs does not warn.
   This is required because task-surface `Post Reply` builds the body from `rendered_delta` only
   (`completion`/`output_message` is used on the chat surface) — without it, the deck would attach
   under an empty comment and the narration would be lost.

3. **`deliver-output-empty` WARN** (both the async `Session Waiter Finish → Build Result` and the
   sync `Execute Agent Session → Build Final Output`, kept in sync) — fire only when `output_blocks`
   is empty **AND** `doc_files` is empty, i.e. genuinely nothing was delivered. Relocated below the
   `doc_files` enumeration in both nodes so the guard can see the docs.

Consequences

- A document-only managed delivery now posts the agent's narration, attaches the produced file,
  flips status to Zakończono, and logs cost — instead of a false timeout notice, a CRITICAL alert,
  and a silently dropped deck.
- The CRITICAL `managed-agents/non-delivery` alert regains precision (no longer fires on successful
  document deliveries), and `output-adapter/deliver-output-empty` now means what it says.
- The fix spans both lanes so behavior is identical whichever runs: the async waiter is the
  production default after the ADR-066 cutover; the synchronous poll loop is the documented rollback.
- Refines/supersedes the specific ADR-066 Block 1 Amendment 3 clause that treated *any*
  empty-`output_blocks` `delivered` as non-delivery. The rest of Amendment 3 stands.
- Known limitation (accepted, unchanged): a **non-delivery** outcome that nonetheless produced a
  document (e.g. a `deadline`/`partial` with `doc_files` populated but `delivered_via_tool` false)
  still posts the incomplete notice and does not attach the orphaned document — the gate keys on
  `delivered_via_tool`. Salvaging orphaned docs on a non-delivery outcome is out of scope (rare, and
  would risk re-muddying "delivered" semantics).

Verification

- Render Agent Output live sub-workflow tests (`scripts/test-subworkflow.mjs`): doc-only input
  (`delivered_via_tool=true`, empty `output_blocks`, `output_message` set) renders the narration as
  `rendered_delta` with **zero** warnings; the protocol-violation input (`delivered_via_tool=false`,
  empty blocks) still renders the narration **and** still fires `output-adapter/no-deliver-output`.
- The gate change verified against the real failing payload (`delivered_via_tool=true`,
  `doc_files=[{…pptx…}]`, empty `output_blocks` → now publishable).
- All four edited workflows validate with 0 errors; repo re-exported drift-clean (all 51 match live).
- A full end-to-end managed re-run (≈ $5, ≈ 20 min) was **not** performed; the change is confined to
  a boolean gate, a render fallback (live-tested), and a WARN guard (diff-verified).

Files: `publish-managed-result.json` (`Session OK?`), `render-agent-output.json` (`Parse Blocks`),
`session-waiter-finish.json` (`Build Result`), `execute-agent-session.json` (`Build Final Output`).

Date: 2026-07-02
