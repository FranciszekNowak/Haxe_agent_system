# ADR-004: Caller-scoped permissions for all agent invocations

## Context

The agent has a ClickUp guest user account with broad permissions 
(must access content across all Spaces). Without scoping, a team 
member could use the agent as a workaround to access content they 
shouldn't see.

Multi-agent system research identifies "permission explosion" 
(agents accumulating excessive access) as a top-4 production 
failure mode.

## Decision

Two enforcement layers:

Layer A (prompt-level): At workflow start, identify caller, query 
their CU scope, pass to Claude as system prompt constraint.

Layer B (n8n MCP gateway): Between Claude and ClickUp MCP, n8n 
intercepts every tool call and verifies the caller has access to 
the requested resource. Unauthorized requests return empty.

The agent CU account has broad base permissions; runtime scope is 
the calling user's permissions, enforced at the wiring layer.

## Consequences

Positive:
- Security by architecture, not by trust
- Team members get personal agents without separate CU accounts
- Compliance with "least privilege" principle

Negative:
- 4 hours of additional Phase 2 implementation work
- Slightly more complex orchestrator workflow
- Both layers must be maintained as MCP/CU APIs evolve

## Date

2026-05-26

> Update 2026-06-02 (supersedes the "guest account" assumption): the agent
> account `agent@haxe.com` was made a **Member**, not a guest. Reason: ClickUp
> does not let guests generate a personal API token, which the agent needs to
> authenticate to the API (the n8n `clickUpApi` credential). The security model
> is unchanged — broad base access on the agent account, narrowed to the
> caller's scope at the wiring layer (Layers A/B above); "broad base permissions"
> is now realised as a Member seat rather than a broad-access guest.
>
> Field finding (first live fetch, 2026-06-02): the agent Member can read tasks
> via the API, but task descriptions that embed ClickUp **Doc** links render as
> "You do not have access to this Doc". So Member task-read access does **not**
> imply Doc access. This must be resolved before the `linked_doc_leaves`
> increment (doc-page resolution) can work — the agent needs explicit access to
> the relevant Docs, or that content stays invisible to it.