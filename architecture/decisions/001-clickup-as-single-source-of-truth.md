# ADR-001: ClickUp as single source of truth for operational knowledge

## Context

The agent system needs a place to store and retrieve operational knowledge:
process instructions, agent personas, brand voice guidelines, departmental
rules, and the tasks agents actually act on. Options considered:

- **Separate knowledge base** (Notion, Confluence, custom CMS): team maintains
  two systems — one for tasks (ClickUp) and one for knowledge.
- **Git-only**: version-controlled but inaccessible to non-technical team members;
  requires a deployment step to update live instructions.
- **ClickUp** (existing task management tool): team already works here daily.
  Tasks, subtasks, custom fields, and Docs are all available.

The team is 5 people. At this scale, operational friction from a second tool is
disproportionately expensive.

## Decision

ClickUp is the single source of truth for all operational knowledge. Process
templates, agent personas, brand voice, rules, and the tasks agents act on all
live in ClickUp. Agents are provisioned as CU guest users and read context
directly from the task hierarchy they are acting on.

The git repo holds code and configuration (ADRs, workflow JSON, schema
migrations, prompt files). ClickUp holds live operational knowledge (process
instructions, team-editable rules). These two domains do not overlap.

## Consequences

Positive:
- Team works in one tool; no context-switching or duplicate maintenance.
- Agent context is co-located with the task it is executing — no separate lookup.
- Process instructions are editable by non-technical team members in real time.
- Adding a new process = new CU task structure, no deployment required.

Negative:
- ClickUp API rate limits and schema constraints become agent system constraints.
- ClickUp vendor lock-in: pricing changes or API deprecations affect the whole
  system.
- Rich structured data (e.g. exact field enumerations) must be mirrored to the
  repo to be version-controlled (see CLAUDE.md: "what belongs where").

## Date

2026-05-26

> Update 2026-06-08 (supersedes the "guest users" detail in Decision): the agent
> account `agent@haxe.com` is a ClickUp **Member**, not a guest — ClickUp only lets
> Members generate the personal API token the pipeline needs. Caller-scoping is now
> enforced in software (prompt + n8n MCP gateway) rather than by the CU account, and
> the LLM holds no write capability. See ADR-004 (2026-06-02 update) and ADR-026.
> The "single source of truth" decision above is unaffected.
