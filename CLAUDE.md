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
- Agents run as a ClickUp Member account (only Members can mint the API token the pipeline needs), with caller-scoped permissions enforced in software, not by the CU account — see ADR-004
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

## n8n environment

- **Code-node sandbox blocks crypto and `$env`.** This n8n instance blocks
  `require('crypto')`, the global `crypto`, **and** `$env` inside Code nodes
  (`N8N_BLOCK_ENV_ACCESS_IN_NODE`). Consequences: do HMAC/hashing with the
  **native Crypto node** (not a Code node), and store secrets a Code node can't
  reach as **n8n credentials** — the Crypto node's HMAC action reads its key from
  a `crypto` credential (`hmacSecret`). Note `$vars` works in expressions but
  `$env` does not.
- **ClickUp webhook auth = HMAC-SHA256(secret, rawBody) hex** in the
  `X-Signature` header. You must hash the **raw** request body, not a
  re-stringified JSON (bytes differ → signature mismatch): set the Webhook node's
  `rawBody: true`, which keeps the exact bytes in binary `data` while still
  leaving `$json.body` parsed for downstream use.

## Definition of done

Before reporting a feature or fix as complete, you must verify it actually works
end-to-end — not just that the code was written or the workflow was updated. For example, for/
anything that touches the agent pipeline:

1. **Trigger the full ClickUp flow.** @-mention the agent on a real task (or use
   the n8n manual test trigger if the webhook isn't wired). Confirm the expected
   outcome appears in ClickUp — comment posted, status updated, whatever the
   feature is supposed to produce.
2. **Check n8n execution logs.** Open the relevant workflow in n8n and inspect the
   last execution. Look at every node — not just whether the run succeeded overall,
   but whether any node produced a warning, an empty result it shouldn't have, or
   a fallback it shouldn't have taken. A green checkmark on the execution does not
   mean every node did what was intended.
3. **Check the ClickUp alert channel.** If any WARN or CRITICAL alert fired during
   the test run, treat it as a failure until explained.

Only after these three checks pass report the task complete. "The code looks
right" is not a substitute for observing the system behave correctly.

**Claude must attempt verification autonomously before asking the user to do it.**
 Never hand the entire verification back to the user
when you can complete parts of it independently.
This applies to all actions and parts of the system, not only ClickUp.

## Reliability & observability (mandatory)

The goal is a system that runs reliably and, when something goes wrong, lets the
maintainer act in an informed and timely way. Therefore:

- **Every feature that can fail or silently degrade MUST have an error handler that
  posts an appropriate note to the ClickUp alerting channel.** "Silently degrade"
  means it keeps running while delivering reduced/zero value with nobody noticing
  (e.g. a cron that stops, a fallback that quietly downgrades quality, a missing
  cost/usage figure, a failed log write). A loud crash is not enough on its own —
  ask "what breaks without throwing?" and cover that too.
- Route every alert through the centralized **`Post Alert (v1)`** seam (ADR-025),
  with a severity (`INFO`/`WARN`/`CRITICAL`), a `source`, a human-readable message,
  and actionable `details` (task id, which check failed, what to do). Don't post
  ad-hoc to ClickUp from individual nodes — go through the seam so the channel stays
  swappable.
- Two layers, both required where applicable (ADR-025): **reactive** — set the global
  `Error Handler (v1)` as the `errorWorkflow` on every pipeline workflow so throws
  surface as CRITICAL; **proactive** — for anything that can fail *without* throwing,
  add an explicit check (a freshness/dead-man's-switch cron, an in-flow IF that fires
  a WARN). The reactive layer cannot catch a job that simply never ran.
- A degradation alert must **not** break the main path: fire it on a side branch / via
  `onError: continueErrorOutput`, and let the run still return its result.
- **Alert-channel-inside-watched-scope = loop risk.** If a producer posts an
  alert/WARN comment to a task that its own webhook watches, that comment re-fires
  the webhook → another alert → infinite loop. Guard producers to drop their own
  telemetry task (e.g. the Alerts task) *before* any side-effecting/alerting step.
- When you build or change a feature, state in your summary which silent-failure modes
  you covered and how. If a failure mode is knowingly left uncovered, say so explicitly.

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

Phase 2 - the agent spine. The generic ClickUp→LLM→ClickUp pipeline is live and
verified: Context Gather → Invoke Model (LiteLLM/Bedrock routing + PLN cost) →
draft comment posted back (@-mention + rendered markdown), rules-doc loading,
status field. Automatic triggering via a signature-verified ClickUp @-mention
webhook (ADR-029). Remaining: selective `linked_doc_leaves`, autonomous
status/due-date triggers (Phase 3).

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

### 2026-06-09 — ClickUp `comment.parent` is the task id for top-level comments

To reply in-thread, POST to `/api/v2/comment/{h.comment.id}/reply` — use the
comment's own `id`, **never** `h.comment.parent`. For a top-level comment ClickUp
populates `parent` with the **task id**, so replying to it targets a task, not a
comment, and the call fails ("The service was not able to process your request").
This silently broke in-thread replies in the CU Webhook Producer's `Detect Mention`
node (it preferred `h.comment.parent`); fix was to read `h.comment.id` first
(ADR-035). Verify with the producer's webhook payload, not assumptions.