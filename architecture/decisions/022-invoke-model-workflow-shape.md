# ADR-022: Invoke Model (v1) sub-workflow shape — Execute Workflow Trigger, Set-node selection step, dynamic Bedrock profile

Date: 2026-06-03
Status: Accepted

## Context
ADR-013 fixes the architecture for model invocation (one centralized "invoke
model" sub-workflow + a discrete selection step), and ADR-021 fixes the concrete
Bedrock path (native AWS Bedrock Chat Model node + EU inference profiles). Neither
specified the assembled workflow shape. Building `Invoke Model (v1)` (n8n id
`XcOIVdZnVCCWNPeb`, exported to `n8n/workflows/invoke-model.json`) forced the
concrete choices below. This is the implementation of ADR-013 seams #1 and #2, not
a new architectural decision.

## Decision

### Execute Workflow Trigger with a typed `workflowInputs` contract
The sub-workflow is entered by an `executeWorkflowTrigger` (v1.1) in
`workflowInputs` mode declaring four typed string inputs:
`prompt`, `importance`, `sensitivity`, `task_type`. This makes the seam's calling
contract self-documenting at the boundary rather than an implicit passthrough —
any caller (the future Main Orchestrator) sees exactly what to supply. `sensitivity`
is declared now though unused (ADR-013 defers the classifier); declaring it keeps
the contract stable when the classifier lands — no downstream ripple.

### The selection step is a Set node TODAY (will become a DB lookup)
The discrete selection step (ADR-013 seam #2) is a `Set` node ("Select Model")
that outputs `provider` and `model` and echoes the three routing inputs through for
observability. Today it is FIXED: `provider = "bedrock-eu"`,
`model = "eu.anthropic.claude-sonnet-4-6"` — the one EU profile actually verified
to return a completion (ADR-021). A Set node (a "normal" node) is the most
inspectable expression of a fixed mapping (CLAUDE.md: normal nodes over Code). When
the real `(importance x sensitivity[, task_type]) -> (provider, model)` mapping is
decided, it becomes a Supabase lookup per ADR-013 (a credential-aware DB node +
shaping) — swapped in this one node. The seam is the node's position, not its
current contents.

### Model chosen by expression, not a static field
The native Bedrock node's `model` is set by expression
`={{ $('Select Model').item.json.model }}`, so the selection step drives the
profile. Confirmed working: an `options`-typed model field accepts an expression
resolving to the profile string, and a LangChain model sub-node resolves
`$('NodeName')` references against the run's data. This is what makes the selection
step load-bearing rather than decorative.

### Explicit return contract (Shape Output)
A final `Set` node returns `{ completion, model, provider }` — the completion plus
which model/provider actually served it, so the downstream caller can log model and
(later) cost to `agent_runs` without re-deriving them. The raw `Basic LLM Chain`
`{ text }` output is not the contract.

### Testing: a throwaway Execute-Sub-workflow harness, not a swapped trigger
An Execute Workflow Trigger cannot be fired by the n8n MCP test tool (it only fires
webhook/form/chat triggers). Rather than temporarily swapping in a Form Trigger
(the ADR-020 pattern, which would not exercise the real calling contract), a
separate throwaway harness (`Invoke Model — test harness (throwaway)`, id
`2x0ENUaaHCneAXkF`: Form Trigger -> Execute Sub-workflow) calls the real
sub-workflow. This validated the production path: the parent's `workflowInputs`
resourceMapper -> the trigger's typed inputs -> the chain. (n8n requires a
referenced sub-workflow to be published before the parent can activate.)

## Consequences
- Verified live (2026-06-03): mapped inputs (`importance`/`sensitivity`/`task_type`)
  arrive intact at Select Model; the dynamic `model` expression drove the Bedrock
  node; `prompt = "Reply with exactly the word: BANANA"` returned
  `completion = "BANANA"` — prompt flows end-to-end and the completion reflects it.
  Both workflows left inactive between tests.
- **Pending decision flagged (ADR-021):** the `(importance x sensitivity) -> (model,
  provider, priority)` mapping is not yet made, and only the Sonnet EU profile is
  verified. Wiring Haiku/Opus requires (a) the operator's tier/cost decision and
  (b) verifying their `eu.`-prefixed profile IDs return completions. Until then all
  traffic uses Sonnet — compliant and verified, not optimized.
- The MCP form-test tool did not populate the Form Trigger field, so the harness's
  form->trigger hop is unverified; irrelevant to production, where `prompt` is a
  mapped value (proven to flow) exactly like the other three inputs.
- Next: wire `Context Gather (v1)`'s assembled context into a prompt and call this
  sub-workflow; then post the completion back to ClickUp.

Related: ADR-013 (centralized invocation + selection step), ADR-021 (native Bedrock
node + EU profiles), ADR-019 (credential-aware nodes; Set/Code only shape),
ADR-020 (Context Gather shape + the harness/testing precedent), ADR-018 (built via
the n8n MCP control plane).
