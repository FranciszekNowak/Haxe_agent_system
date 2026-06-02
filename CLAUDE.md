# Haxe Agentic OS - Claude Code Instructions

## Project context

This repository contains the infrastructure-as-code for Haxe's internal 
agentic operating system. The architecture is described in 
`architecture/current.md`. Read that first if you're new to this project.

## Project goal

Build a system where AI agents execute routine/commoditizable work at Haxe 
(Polish wellness/electronics e-commerce distributor, 5-person team), 
governed by:

- Process knowledge in ClickUp (single source of truth for operational rules)
- Agents as ClickUp guest users with caller-scoped permissions
- Recursive self-improvement via structured feedback loops from humans,
- All inference via AWS Bedrock EU (Claude family) for GDPR compliance
- Gmail-native email integration (drafts in Gmail, not separate CU comments)
- Queue-based execution (Redis + n8n queue mode)
- Conversation session caching for multi-turn efficiency,
- as little custom build as possible, given the overall constraints.

## My role and your role

I (Franciszek) am the architect, builder, and operator. I'm 19, CEO of 
Haxe, with strong fluid intelligence but limited time. I'm building this 
in 3-4 weeks, along with running the rest of the company. I need to move decisevely.

Your role: technical collaborator. Help me build, but push back when I'm 
wrong. Surface failure modes. Don't accommodate sloppy thinking.

## Working preferences

- **No flattery, no preamble.** Direct response first.
- **Red-team my decisions.** If you see a problem, surface it. Do not wave under pressure unless you accept the arguments based on their merits.
- **Reference architecture docs.** Cite specific files when relevant.
- **Polish for end-user content, English for code and technical docs.** 
  This is intentional - match existing patterns in the repo.
- **Stay practical.** I have limited time. Don't propose detours.
- **Use my actual environment.** Both desktops are Windows. Commands 
  should work in PowerShell or Command Prompt. When showing scripts, 
  Windows-native (.ps1 or .bat) preferred over bash unless we're 
  scripting on the Linux VPS.
- whenever you explain how to do something, and you notice it may be useful in the future for Franciszek, teach him a deeper understanding of it. He wants his knowledge to grow by doing, not outsource everything blindly with no understanding.

## File conventions

- All documentation in markdown
- ADRs (Architecture Decision Records) follow this format:
ADR-NNN: [Title]
Context
[What was the situation/problem]
Decision
[What was decided]
Consequences
[Trade-offs and downstream effects]
Date
[YYYY-MM-DD]

- n8n workflow files are exported JSON. Do not hand-edit them - edit in 
  n8n UI and re-export.
- When building n8n automations, use normal nodes, not Code nodes, wherever 
  possible. The logic should be visually inspectable without parsing 
  (sometimes complex) JavaScript. Only reach for a Code node when no normal 
  node can express the logic.
- Supabase migrations are append-only. Never modify existing migrations; 
  add new ones.
- SQL uses lowercase keywords, snake_case names.

## What's in this repo vs in ClickUp

**In this repo (I edit, version-controlled):**
- Agent persona prompts (mirrored to CU Docs when deployed)
- n8n workflow JSON exports
- Database schema and migrations
- Infrastructure configuration
- Architecture documentation
- Operating procedures

**In ClickUp (team-editable, live):**
- Process-specific instructions in task descriptions
- Stage-level instructions in subtask groupings
- Brand voice and departmental rules
- The actual "Agent System" Space content

The repo is the master for code and configuration. ClickUp is the master 
for operational knowledge. Don't mix these.

## Where things live

- Architecture (current state): `architecture/current.md`
- Architecture decisions log: `architecture/decisions/`
- Operating procedures: `docs/operating-procedures.md`
- Deployment runbook: `infrastructure/deployment.md`
- Prompts (agent personas): `prompts/`
- Skills definitions: `skills/`
- Database schema docs: `supabase/schema.md`
- Database migrations: `supabase/migrations/`
- n8n workflows: `n8n/workflows/`

## When in doubt

- Check `architecture/decisions/` for past reasoning
- Check `docs/operating-procedures.md` for what should happen day-to-day
- If a significant decision is needed, propose it as a new ADR draft in 
  `architecture/decisions/` rather than making the change silently
- For ambiguous situations, ask me before proceeding

## Current phase

Phase 0 - Infrastructure setup. We're provisioning the foundations: VPS, 
n8n, Redis, Supabase, Bedrock access, git repo, dev/prod isolation.

No agent code yet. Just infrastructure preparation.

## Self-improving documentation

**When to propose updates to this file:**

Suggest a CLAUDE.md update when you encounter:
- A non-obvious pattern in this codebase that you had to figure out
- A correction I made that reveals a preference or convention not yet documented
- An environment-specific gotcha (Windows path issue, n8n behavior, etc.)
- A workflow that worked well and should become the default
- A reference to a file or pattern that took multiple turns to locate

When proposing updates, follow this format:
1. State what you learned in one sentence
2. Identify which section of CLAUDE.md it belongs in
3. Show the exact text to add or modify
4. Wait for my explicit approval before writing

Do NOT update CLAUDE.md autonomously. Always propose first.

## What belongs where

**CLAUDE.md (this file)**: 
- Stable conventions, decisions, and patterns the whole project depends on
- Things that should be shared via git (every team member benefits)
- Architecture-level rules

**MEMORY.md (Claude Code's auto-memory)**:
- Session-specific learnings still being validated
- Personal debugging insights specific to this machine
- Workflow habits that haven't crystallized into team conventions yet

**ADRs in architecture/decisions/**:
- Major architectural decisions with full context, reasoning, alternatives
- Things future-me needs to remember WHY, not just WHAT

When proposing a learning, suggest which of the three places it belongs.

## Recently learned (rolling buffer)

This section accumulates learnings until I review and either promote them to 
the appropriate permanent section above or remove them. Append new entries 
below with date and context.

### 2026-06-01 — Changeset merge ritual for architecture docs

`prompts/MERGE_PROMPT.md` is the reusable prompt for applying a changeset
handed off from a chat session. A changeset is a **targeted diff** to
`architecture/current.md` (plus zero or more new ADR files), NOT a replacement
document. Mechanics learned applying one this session:

- **Apply only the named edits; treat every unmentioned line as immutable.**
  Detailed accumulated sections (diagrams, tables, the credential/Docker
  architecture blocks) must survive byte-for-byte unless explicitly edited.
  Preserving accumulated detail is the entire point of the ritual.
- **Changesets can be stale — reconcile against reality, don't apply blindly.**
  This one's version examples lagged the live file (it said "v7/v8"; the doc was
  already v9), and its "password auth still ENABLED" claim was already false.
  When the changeset's replacement block is *thinner* than the live doc, MERGE
  (take the factual updates, keep the existing detail) rather than overwrite —
  and flag the merge for the operator instead of silently choosing.
- **New ADRs:** add as complete files; assign the next free contiguous number;
  renumber on collision; verify the `decisions/` sequence stays gap-free.
  Strip any `> NOTE FOR MERGE` placeholder lines and set the real number.
- **ADR numbering:** the *filename* number is canonical — `current.md` cites
  "ADR-010" etc. Match the recent `# ADR-0NN:` heading style and the filename.
- **ADRs are append-only.** When reality supersedes one (password auth got
  disabled, contradicting ADR-010's "deferred" section), append a dated
  `> Update YYYY-MM-DD (supersedes ...)` note — never edit the original claim.
- **Process:** apply to working tree → produce `git diff` + a report (applied
  cleanly / needed adaptation / could-not-apply with reason) → WAIT for
  approval → commit → push only when explicitly told. To review a diff that
  includes new untracked files, `git add -N <file>` first so `git diff` shows
  them.

Candidate for promotion to a permanent "Working with architecture docs"
subsection once stable.