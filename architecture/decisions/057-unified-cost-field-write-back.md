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

> **Superseded by ADR-060 (2026-06-24).** This "managed footer = cumulative `SUM`" decision was
> reversed: on multi-run tasks it made every reply show the climbing running total instead of the
> cost of that reply. ADR-060 sources the managed footer from the session's **own** PLN cost
> (surfacing `cost_pln` from `Execute Agent Session` turned out to be a one-line `Final Return`
> change, not the return-path restructuring feared here) **plus** the per-execution image cost
> (a `created_at`-windowed `SUM` over the run's `image_mcp` rows). `Write Cost Field`'s `total`
> still writes the cumulative CU field; the footer no longer reads it.

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
- **Known limitation — CLOSED 2026-06-24 (see Amendment below):** managed **image-gen** cost rows were
  logged with a `null` `clickup_task_id` because the in-harness image MCP tool has no session/task
  context (ADR-055), so they were excluded from the per-task `SUM`. This is now fixed: the task id is
  threaded through the managed image MCP path as an agent-supplied tool argument. Image-gen cost rows
  carry the real `clickup_task_id` and are included in the field/footer `SUM`.
- The bare lane is the dormant failover; its success path was validated structurally + by the shared
  sub-workflow's live proof (a live bare-lane firing hit a transient LiteLLM 429 on `Invoke Model`,
  upstream of the changed nodes, and its untouched failure path handled it correctly).

## Amendment (2026-06-24) — close the image-gen attribution gap

The managed image-gen cost is now attributed to the task. Mechanism and the trap hit while building it:

**The fix (task id threaded as a tool argument).** Block 5.1 established that the n8n **MCP Server
Trigger does not expose the inbound request (headers/body) to the tool handler** — the handler sees
only the tool arguments the model fills via `$fromAI`. The `mcp_servers` URL is also baked into the
**agent definition** (static, shared across sessions), so there is no per-session/out-of-band channel.
Therefore the **only** way to get the task id to the cost writer is as an **agent-supplied tool
argument**. This is acceptable because image generation is identity-neutral (ADR-055 §5): a wrong/missing
id only mis-attributes a cost row — never a data leak (unlike ADR-054's user-id spoofing concern). Wiring:

- `Haxe Image MCP (v1)` — `generate_image` gains a `clickup_task_id` `$fromAI` param.
- `Agent Orchestrator (v1)` — the managed `user_message` is prefixed with `# Identyfikator zadania
  ClickUp (clickup_task_id): <id>` so the model has the value to copy (kept out of the shared bare-lane
  prompt).
- `Sync Agent Definitions (v1)` — `generate_image`'s description instructs the agent to copy that id;
  `CONV` bumped 7→8 to force a re-sync.
- `Image MCP Tool Handler (v1)` — accepts `clickup_task_id`, passes it to `Image Tool Handler (v1)` →
  `Generate Images Parallel (v1)` → per-image `Log Model Run` row. **Silent-degradation guard:** if the
  arg arrives empty (model omitted it), the row falls back to a `null` id (the old behaviour) **and** a
  `WARN` (`image-mcp/missing-task-id`) fires through `Post Alert (v1)` — so the degradation is visible,
  not silent. Verified live: the WARN fired on the broken runs; the good run was clean.
- Verified live (2026-06-24) on a disposable task: the agent passed `clickup_task_id`, the image cost
  row carried the real task id, and the cost field + footer `SUM` included the image cost.
- **Residual:** attribution depends on the model copying the id. If it omits it, that one image's cost is
  un-attributed and a WARN fires (no regression vs. the old always-null behaviour). A fully unspoofable
  channel would require a standalone MCP host that reads a per-session correlation header — the R4-scale
  build ADR-055 deferred; disproportionate for cost accounting.

**The trap — `toolWorkflow.workflowInputs.schema` is repo↔live drift the tools don't catch.** A
`toolWorkflow` node feeding an MCP Server Trigger carries a `parameters.workflowInputs.schema[]` array
(one entry per declared input) that n8n uses to **map the `$fromAI` values to the sub-workflow's inputs**.
**`export-workflows.mjs` strips this array** (the public-API GET it uses does not return it) and
**`check-workflow-drift.mjs` does not compare it**, so the repo copy of `haxe-image-mcp.json` had silently
been missing it since it was first exported (the workflow was originally built via n8n-MCP `partial_update`,
which set the array; it had never been round-tripped through the public-API PUT). Importing that
schema-less file via `import-workflow.mjs` (public-API PUT) **stripped the array from live**, after which
the MCP tool advertised/mapped **no** arguments — every `$fromAI` value (including `prompt`) arrived
`null` at the handler, breaking **all** image generation, not just the new field. Recovery: hand-restore
the full `schema[]` array (now 6 fields incl. `clickup_task_id`) into the repo file and re-import. The repo
file is now the master that carries the array; **do not let `export-workflows.mjs` overwrite
`haxe-image-mcp.json`** (it will re-strip `schema[]`), and prefer editing this workflow via n8n-MCP
`partial_update` / the UI over a public-API PUT.

## Date

2026-06-24 (amended 2026-06-24)
