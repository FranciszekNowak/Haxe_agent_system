# ADR-057: Unified cost write-back across both Stage-B lanes (`Write Cost Field (v1)`)

## Context

Every agent run records its cost in `agent_runs.cost_pln` (USD × daily NBP FX, owned by
`Log Model Run (v1)`, ADR-035). Two **user-facing** surfaces are meant to expose that cost:

1. the ClickUp custom field **`[AI] Koszt akcji [PLN]`** (`ca7a3874-…`) — the running task total, and
2. the **comment footer** the agent posts (`…(model: X, koszt: Y PLN)`), rendered by `Post Reply (v1)`.

Both were wired only for the **bare lane** (`Execute LLM Call (v1)`): an inline
`Sum Task Cost → Update CU Cost Field` pair wrote the field, and the per-run `cost_pln` was
passed through to the footer.

When ADR-053 moved the default execution to the **managed lane** (`Execute Agent Session (v1)`),
the cost write-backs were **not** ported:

- The orchestrator's `Call Post Reply (Managed)` passed a **hardcoded `cost_pln: 0`**, and the
  managed lane's `total_image_cost_pln` is `0` by design (image cost is logged straight to
  `agent_runs`), so the footer always rendered **`koszt: 0.0000 PLN`**.
- No node on the managed path wrote the cost custom field, so `[AI] Koszt akcji [PLN]` stayed
  **blank**.

The database row was correct throughout (e.g. the moodboard task `869dux9ne` logged
`cost_pln = 8.6413`); only the two displays were broken. Because moodboard/image tasks always run
on the managed lane, this reproduced on every such run. Reported 2026-06-24.

This is also a unification problem: the field-write logic (`SUM(agent_runs.cost_pln)` → set field)
is the same behaviour for the same reason on both lanes, so per the repo's unification rule it
should live in **one** place rather than be duplicated.

## Decision

Extract the field write into a shared sub-workflow **`Write Cost Field (v1)`**
(`GoFPwWsSQOHnrClH`) and call it from both lanes:

```
When Called(clickup_task_id)
  → Sum Task Cost   (SELECT coalesce(sum(cost_pln),0) AS total FROM agent_runs WHERE clickup_task_id = $1)
  → Update CU Cost Field   (POST /task/{id}/field/ca7a3874-…  { value: total })
  → Build Return   (sole branch-free terminal; returns { total })
  (Sum/Update errors → Alert Cost Sync Failed (WARN, ADR-025) → Build Return; total falls back to 0)
```

- **Bare lane** (`Execute LLM Call (v1)`): the inline `Sum Task Cost` + `Update CU Cost Field` +
  `Alert Cost Sync Failed` nodes are replaced by one `Call Write Cost Field`, placed after
  `Call Image Resolver` (so per-`generate` image rows are summed). The footer still uses the
  per-run `cost_pln` from `Invoke Model` (unchanged).
- **Managed lane** (`Agent Orchestrator (v1)`): a `Call Write Cost Field` is inserted between
  `Call Render Agent Output` and `Call Post Reply (Managed)`. Its returned `total` replaces the
  hardcoded `0` as the footer's `cost_pln`; the render-output fields Post Reply needs
  (`rendered_delta`, `image_manifest`, `image_models`, `total_image_cost_pln`) are re-pointed to
  absolute `$('Call Render Agent Output')` references so they survive the new intermediate node.

**Footer semantics:** the managed footer therefore shows the **task `SUM`** (cumulative), whereas
the bare footer shows the **per-run** cost. They coincide for single-run tasks (the common case).
Sourcing the managed footer from the `SUM` (rather than threading a per-run PLN value out of the
session workflow) was chosen deliberately: surfacing a per-run PLN would mean restructuring
`Execute Agent Session`'s branch-free return path — the documented return-determinism trap — for
no real benefit, since the `SUM` is at least as accurate and reuses one query.

**Reliability:** the sub-workflow is internally fail-soft (a DB or CU error fires a WARN through
`Post Alert (v1)` and still returns `{ total: 0 }`); both call sites also set
`onError: continueRegularOutput`, so a cost-sync hiccup never blocks the comment or the run.

## Consequences

- Moodboard/image and all managed runs now populate both the cost field and a non-zero footer.
  Verified live (2026-06-24): a Niski managed run wrote `[AI] Koszt akcji [PLN] = 0.1302`, footer
  `koszt: 0.1302 PLN`, matching `agent_runs.cost_pln`, zero alerts. The existing task `869dux9ne`
  was backfilled to its true all-in cost (`8.7886` = `8.6413` text + `0.1473` image).
- One field-write path for both lanes; a future change to how the field is computed/written is made
  once. `Post Reply (v1)` no longer owns the cost-field write (it never actually did on either lane;
  the docs that said so were corrected).
- **Known limitation (tracked):** managed **image-gen** cost rows are logged with a `null`
  `clickup_task_id` because the in-harness image MCP tool has no session/task context (ADR-055), so
  they are excluded from the per-task `SUM`. The field/footer reflect the **text/session** cost (the
  dominant component); the image sub-cost lives in `agent_runs` but is not task-attributed. Closing
  this needs the task id threaded through the managed image MCP path — a separate change.
- The bare lane is the dormant failover; its success path was validated structurally + by the shared
  sub-workflow's live proof (a live bare-lane firing hit a transient LiteLLM 429 on `Invoke Model`,
  upstream of the changed nodes, and its untouched failure path handled it correctly).

## Date

2026-06-24
