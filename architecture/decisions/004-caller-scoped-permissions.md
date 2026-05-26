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