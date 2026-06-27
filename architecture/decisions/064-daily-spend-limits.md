# ADR-064: Daily spend limits with a pre-execution gate

## Status

Accepted — 2026-06-27. **DONE and LIVE** across three blocks: Block 1 (DB foundation +
table rename), Block 2 (pre-execution gate at the orchestrator entry), Block 3
(end-of-message warning in Post Reply). All verified live: a user-cap block posted the
Polish notice + WARN with the spine skipped (exec 4720); the non-blocked path flowed
through the gate into the spine (exec 4726); and the warning line appended at 80% of a
lowered cap.

## Context

Every agent run costs real money — Anthropic model tokens plus image generation —
recorded per run in `agent_runs.cost_pln` (PLN, FX-converted at write time, ADR-024
/ ADR-035). Cost is observed *after the fact*: surfaced in the reply footer
(ADR-060) and written to a ClickUp cost field (ADR-057). Nothing caps it. A single
user looping on an expensive task, a runaway autonomous trigger, or simply five
people on a busy day can run the bill arbitrarily high with no ceiling and no
warning.

This cost gets strictly worse with scale and adoption — more users, more autonomous
triggers, more expensive multimodal work — which is exactly the cost curve the
project's "design that ages well" rule says to cap now rather than after it bends
upward. Cost control is not a feature users ask for; it is a guardrail the operator
needs so that a single bad day or a misbehaving loop cannot drain the budget
unnoticed.

The constraint that shapes the design: cost is logged only when a run completes, so
any pre-execution check can see *already-incurred* spend but not the cost of the run
it is about to permit. A second constraint: execution is queued (ADR-056), so a
check at enqueue time is not authoritative — by the time a queued job runs, other
jobs may have pushed the user/company over. The authoritative place to check is at
execution time, on the single path all runs pass through.

## Decision

Introduce daily spend caps enforced by a gate at the **single spine chokepoint**
(the Agent Orchestrator's `When Called`, which both the synchronous mention producer
and the queued `Spine HTTP Ingress` invoke). The gate runs before any spend-bearing
work (context assembly, the LLM call).

1. **Caps.** Per-user 40 PLN/day (default, per-user overridable via
   `user_data_and_config.daily_spend_limit_pln`); company-wide 100 PLN/day across all
   users. A user is blocked once their own spend reaches their cap; everyone is
   blocked once company spend reaches the company cap.

2. **Warnings.** At message-end, append a notice when the user is past 60% of their
   cap or the company is past 70% of its cap. Computed post-run (the just-finished
   run is already counted) and shown in the reply.

3. **Day boundary.** Calendar day in **Europe/Warsaw**; spend resets at 00:00 Warsaw.
   Chosen over a rolling 24-hour window because "today's budget" is intuitive,
   resets predictably, and matches how the operator reasons about a daily allowance.

4. **Soft cap, by necessity.** The gate blocks when *already-incurred* spend ≥ the
   limit. Because the in-flight run's cost is unknown until it finishes, one run may
   overshoot by its own cost (~1–3 PLN against a 40 PLN cap). Accepted: the overshoot
   is bounded and small, and the only way to make the cap truly hard would be mid-run
   termination, which the platform does not offer. Pre-estimating an agentic tool
   loop's cost is not reliable enough to gate on. Checking at execution time (not
   enqueue time) bounds the queue's contribution to this same one-run overshoot.

5. **One measurement, one place.** All spend math — the per-user and company
   `SUM(cost_pln)` over today's rows, the configured limits, the ratios, and the
   block/warn flags — lives in a single SQL function `get_spend_status(p_user_id)`
   (migration 047). Both consumers (the gate and the end-of-message warning) call it.
   A SQL function, not an n8n sub-workflow, because this is a pure read with no
   orchestration; only the *reactions* differ (block + reply vs. append text), so
   only the computation is shared. This follows the unification rule and keeps the
   rule definitions out of N node configs.

6. **Configuration split.** Tunable thresholds live in the `config` table
   (`spend.company_daily_limit_pln`, `spend.user_warn_pct`, `spend.company_warn_pct`,
   `spend.user_daily_limit_pln_default`, and `spend.enabled` as a kill-switch); the
   per-user override lives on the user row (`daily_spend_limit_pln`). To hold per-user
   config, the credentials table `user_clickup_credentials` is renamed
   `user_data_and_config` (migration 047) — it stops being credentials-only and
   becomes the per-user data/config row.

7. **Fail-open on gate error.** If `get_spend_status` itself errors, the gate allows
   the run and fires a WARN. A database hiccup must not silently freeze all agent
   work; the operator is told, and the worst case is brief over-spend, not an outage.

8. **Zero-downtime rename.** The rename uses the expand/contract pattern: migration
   047 renames the table and leaves a compatibility view under the old name so live
   workflows keep resolving; the two workflows (`Execute Agent Session`,
   `ClickUp OAuth Onboarding`) and three `onboard-clickup-*.mjs` scripts are cut over
   to the new name; migration 048 drops the view. `get_clickup_onboarding_state()` is
   recreated against the new name because Postgres does not rewrite function bodies on
   rename.

## Consequences

- A hard ceiling on daily cost, per user and company-wide, that scales with adoption
  instead of degrading.
- Early warning (60%/70%) gives users and the operator runway before a hard block.
- The gate sits before context assembly and the LLM call, so a blocked run incurs no
  model spend.
- **Trade-off — soft cap:** the realized cap is `limit + (one run's cost)` in the
  worst case. Acceptable given the bound; revisit only if mid-run cancellation
  becomes available.
- **Trade-off — accuracy ceiling:** the cap is only as accurate as cost logging. If
  `Log Model Run (v1)` fails to record a run (existing WARN), spend is under-counted
  and the cap is correspondingly loose. No new failure mode, but the dependency is
  now load-bearing.
- **Single-chokepoint placement** means a future entry path that bypasses the
  orchestrator would bypass the gate. Today the orchestrator is the only path; any
  new producer must route through it (or re-call the gate). Noted as a standing
  constraint.
- **Autonomous runs** are gated too (they pass through the orchestrator); a blocked
  autonomous run with no comment thread fires only the WARN alert.

## Date

2026-06-27
