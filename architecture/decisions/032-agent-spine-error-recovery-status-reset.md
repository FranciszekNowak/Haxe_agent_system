# ADR-032: Agent Spine Error Recovery — Status Reset on LLM Failure

## Context

Agent Spine (v1) sets the `[AI] Status agenta` custom field to "W trakcie" (`Set Status W trakcie`
node) before calling `Invoke Model (v1)`. This is intentional — it gives the operator
real-time visibility that the agent is working.

The problem: `Call Invoke Model` (executeWorkflow node) has no `onError` setting, so any
sub-workflow failure (Anthropic 429, network timeout, DB error inside Invoke Model) propagates
as an unhandled throw. n8n routes the throw to the `errorWorkflow` (`Error Handler (v1)`), which
fires a CRITICAL alert but has no task context with which to reset the custom field.

Consequence: the task stays stuck at "W trakcie" indefinitely. The only recovery path is a
manual custom field reset by the operator.

Observed in production: after the initial deployment the LiteLLM cooldown (self-perpetuating
Anthropic 429s) left multiple tasks stuck in this state. Operators noticed via the ClickUp
view, not via any alert.

## Decision

Add `onError: continueErrorOutput` to the `Call Invoke Model` executeWorkflow node in Agent
Spine. Connect the error output (index 1) to a two-node local error path:

1. **`Reset Status on Failure`** — HTTP Request `PATCH /api/v2/task/{taskId}`, body:
   `{ "custom_fields": [{ "id": "<AI_STATUS_FIELD_ID>", "value": null }] }` — clears the
   custom field so the task no longer shows "W trakcie". Executed unconditionally on error.

2. **`Alert Invoke Model Failed`** — executeWorkflow calling `Post Alert (v1)` with
   `severity: CRITICAL`, `source: agent-spine/invoke-model`, human-readable message, and
   `details` containing the task ID, the error message from the failed sub-workflow output,
   and the instruction "restart LiteLLM if 429 cooldown: `cd /opt/haxe-agents && docker compose
   restart litellm`".

The error path must not re-throw. After `Alert Invoke Model Failed` the execution ends on
the error branch — no further nodes, no status set to a "failed" value. Null is the correct
terminal state: "W trakcie" means work is in progress; no value means the agent did not
complete, which is true and visible.

**Why not set a "Błąd" value?** The custom field uses a fixed option set; adding a failure
option requires ClickUp UI work and schema coordination. Null is equivalent for the operator:
absence of "W trakcie" / "Zakończono" signals the run aborted. If a dedicated failure option
is added later, this path is the correct place to set it.

**Why not reset in Error Handler (v1)?** Error Handler fires without workflow execution
context — it receives the error but not the live node data (taskId, custom field ID). A local
`onError` path runs inside the execution context and has full access to prior nodes.

## Consequences

- Tasks no longer stick at "W trakcie" after LLM failure.
- Operator receives a CRITICAL alert with actionable detail (LiteLLM restart command).
- The alert fires through `Post Alert (v1)` seam — channel-swappable (ADR-025).
- `Error Handler (v1)` still fires as a secondary layer (n8n's errorWorkflow runs after
  the execution ends), catching errors that occur *before* `Call Invoke Model` (e.g., a
  failure in `Call Search` or `Build Prompt`). Those nodes do not have an `onError` path
  and their failures still go unrecovered for the custom field — accepted for now. The
  failure surface for "stuck W trakcie" shrinks significantly: the LLM call is by far the
  most likely failure point in the current pipeline.
- Workflow export must be updated and committed after the fix is applied in n8n UI.

## Date

2026-06-08
