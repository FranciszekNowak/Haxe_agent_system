# Haxe Agentic OS - Claude Code Instructions

## Project context

This repository contains the infrastructure-as-code for Haxe's internal 
agentic operating system. The architecture is described in 
`architecture/current.md`. Read that first if you're new to this project or if you want to see what the current phase is.

## Project goal

Build a system where AI agents execute routine/commoditizable work at Haxe 
(Polish wellness/electronics e-commerce distributor, 5-person team), 
governed by:

- Process knowledge in ClickUp (single source of truth for operational rules)
- Agents run as a ClickUp Member account (only Members can mint the API token the pipeline needs), with caller-scoped permissions enforced in software, not by the CU account — see ADR-004
- Recursive self-improvement via structured feedback loops from humans,
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
- **Use subagents**: Delegate independent subtasks to subagents and keep working while they run. Intervene
if a subagent goes off track or is missing relevant context.

## Communication rules
- **Brevity during work, complete sentences at handoff**:
Terse shorthand is fine between tool calls (that's you thinking out loud, and brevity
there is good). Your final summary is different: it's for a reader who didn't see any of
that.

If you've been working for a while without the user watching (overnight, across many
tool calls, since they last spoke), your final message is their first look at any of it.
Write it as a re-grounding, not a continuation of your working thread: the outcome
first, then the one or two things you need from them, each explained as if new. The
vocabulary you built up while working is yours, not theirs; leave it behind unless you
re-introduce it.

When you write the summary at the end, or a plan at the beginning, drop the working shorthand. Write complete
sentences. Spell out terms. Don't use arrow chains, hyphen-stacked compounds, or labels
you made up earlier. When you mention files, commits, flags, or other identifiers, give
each one its own plain-language clause. Open with the outcome: one sentence on what
happened or what you found. Then the supporting detail. If you have to choose between
short and clear, choose clear.
- Aim to be readable - avoid jargon, keep yourself concise. The way to keep output short is to be selective about what you include (drop details
that don't change what the reader would do next), not to compress the writing into
fragments, abbreviations, arrow chains like A → B → fails, or jargon. 

## Git and commit discipline

- **Commit automatically at meaningful milestones** — a completed build block, a verified
  unit of work, a self-contained fix or doc write-back — with a descriptive message. No need
  to ask for approval first; a clean, well-described commit at a natural boundary is the
  default, not an interruption.
- **Every commit, regardless:** show the staged file list, verify the change via `git diff`
  before committing, **never stage credentials or `.env`**, and **never force-push**. Reserve
  asking before committing only when the change set mixes unrelated work, the scope is
  ambiguous, or the change is destructive/hard to reverse.
- **Pushing is NOT automatic.** Commits are local and cheap to amend or revert; pushes —
  especially to `main` — remain a deliberate, explicitly-approved step. Auto-commit at
  milestones does not imply auto-push. Push when ending a work session or when the operator
  asks, after the milestone's verification has passed (see *Definition of done*).
- **Do not act unless explicitely told to**: When the user is describing a problem, asking a question, or thinking out loud rather
than requesting a change, the deliverable is your assessment. Run the tools necessary to deliver it, report your findings and
stop. Don't apply a fix until they ask for one. Before running a command that changes
system state (restarts, deletes, config edits), check that the evidence actually
supports that specific action. A signal that pattern-matches to a known failure may have
a different cause.

## Live changes must be written back (every repo-mastered system)

Several systems are edited **live** (via MCP/UI) but are **mastered by the repo**. After ANY
live change, write the repo artifact back **in the same session** and commit. A forward-note
("a later block will codify it") is NOT a write-back — it is the exact drift that has bitten us in the past.

- **n8n graph** → re-export `n8n/workflows/*.json` (`n8n_get_workflow` mode `active`),
  reconciling by behaviour and preserving curated node `notes` (live usually lacks them) —
  don't dump raw API JSON over them.
- **Supabase DB** → add an append-only migration; never leave a live SQL change uncodified.
- **LiteLLM** → update `litellm-config.yaml`.

Drift is often **bidirectional** (repo ahead in some files, live in others), so check direction
per artifact — never blind-dump one side over the other. Run `node scripts/check-workflow-drift.mjs`
to surface n8n repo↔live drift loudly instead of relying on memory (see `docs/drift-check.md`).

## Plans: block-by-block master-plan routine

Large changes run as a sequence of self-contained **Blocks** against one durable **master plan**
(the plan file). The master plan is the single source of truth across `/clear` boundaries.

- **Every block starts by reading the master plan in full.** Do not rely on prior-session memory.
- **A block does one verifiable unit of work**, scoped to leave the system working and verified
  (its own Definition of Done) — never a half-cut-over path. Each block must have a Defintion of Done - if it doesn't, write it, and notify the user.
- **Then it writes back** (mandatory before commit): update `architecture/current.md` and any ADRs
  the block introduced/closed, update the master plan's block-status table, and commit the block.
- **It ends by emitting a handoff prompt;** the operator `/clears` and starts the next block, using the handoff prompt given at the end of the previous one by the LLM, which
  again begins by reading the master plan.
- Order blocks so each leaves a working, verified state. The per-block write-backs to
  `current.md`/ADRs are the durable record of what changed; the master plan file is the artifact
  that survives `/clear`.

## Reuse and unification (default to one path)

- **If two or more workflows need the same behaviour for the same reason, promote it to a separate
  sub-workflow.** Genuinely shared logic means a future change otherwise has to be made in N places
  and will drift; a shared sub-workflow (called via `executeWorkflow`) makes the change once and
  keeps the callers honest. **But require same behaviour *for the same reason* before extracting** —
  coincidental duplication (two paths that happen to look alike today but answer to different
  needs) should *not* be merged. Forcing a shared abstraction onto callers that then pull it in
  incompatible directions is worse than two honest copies. When in doubt, wait for the second
  caller to actually need the *same* change before unifying.
- **Whenever a unified approach is possible — one contract shape, one workflow, one table, etc. — that
  is the default choice.** Adding a separate, parallel path (a second contract, a forked workflow,
  a second table for the same concept) is an **exception that must be documented and explained**
  (typically as an ADR stating why unification was not viable). Do not introduce a divergent path
  silently — the burden of proof is on the divergence, not on unification.

## Build vs. buy: gate every major component on Wardley evolution

Before building any major component, place it on Wardley's evolution axis and
answer two questions **before writing code or an ADR for the build**:

1. **Differential value** — does building this *ourselves* create advantage for
   Haxe's specific process, or is it undifferentiated plumbing every business
   needs? Scarce build capacity should go only where custom work is genuinely
   differentiating; commodity work consumed elsewhere frees that capacity for it.
2. **Existing commodity/off-the-shelf solution** — has this component already
   evolved into a product or utility we can rent? If a commodity solution exists,
   the default is to **use it**, not rebuild it.

Wardley's axis runs **Genesis → Custom-Built → Product (rental) → Commodity
(utility)**. Components drift left-to-right over time as markets industrialize
them. The expensive, recurring mistake is using the wrong method for the stage:
custom-building (a Genesis-stage method) something that is already a commodity.
Match the method to the stage — **differentiate on the genuinely novel, consume
the commoditized.**

**Decision rule:**
- **Commodity + no differential value → buy/rent/use the utility.** Do not
  custom-build. (e.g. **OCR is a commodity market** — use an off-the-shelf OCR
  service, never a hand-rolled one.)
- **Commodity but staying off-the-shelf forces us to custom-build something
  *else* → switch to the platform that gives the commodity for free.** (e.g.
  **NAS → Google Drive**, ADR-049: keeping the live file store on the NAS would
  force us to custom-build a per-user permission architecture that Google Drive
  already provides off-the-shelf via native ACLs and domain-wide delegation — so
  the agent runs against Drive, not the NAS. The build we avoid is the real cost,
  not the storage itself.)
- **Genesis/Custom-Built *and* differential value → build it ourselves.** This is
  where our effort earns its keep (our agent orchestration, our ClickUp-mastered
  process knowledge).

**When a build survives this gate, state why in the ADR or block plan:** which
stage the component is at, and why no commodity/off-the-shelf option covers it
(or why adopting one would force a larger custom build elsewhere). Building a
commoditized component in-house is the exception that must be justified — the
burden of proof is on the build, mirroring the unification rule above.

## Default to the design that ages well

When two designs both solve the problem, **the default is the one that is better in 5–10 years
and at 2× / 5× scale** — less fragile, more secure, lower maintenance as usage, data, and the
number of integrations grow. The **burden of proof is on the design that works now but degrades
later**: rising maintenance cost, concentrating risk in one place, a shared secret or bottleneck
that gets worse with every new consumer, a schema or interface that needs rework at scale. A
higher one-time setup cost is *not* a strike against a design if it buys lower long-run
fragility; a low setup cost does *not* redeem a design whose cost curve bends upward. State the
long-horizon comparison explicitly when you choose, and if you pick the works-now option anyway,
say why the future cost is acceptable — and prefer recording that as an ADR.

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
  a `crypto` credential (`hmacSecret`). Note `$env` is blocked in Code nodes (above)
  **and** `$vars` (n8n Variables) is a **licensed feature — unavailable on this
  self-hosted community edition** (the `$vars` expression syntax resolves, but you
  cannot create/store variables without a paid license). So a Code node has **no**
  built-in way to read a secret. For a workflow-readable secret, store it in **Supabase
  Vault** and read it via a credentialed Postgres node (a `SECURITY DEFINER` getter over
  `vault.decrypted_secrets`) — see ADR-051 (image key) and ADR-046/048 (storage-purge key).
- **No `Execute Command` node; `Read/Write Files` cannot delete; no disk-temp schemes.** This n8n
  (2.x) does not ship a usable `Execute Command` node — the API rejects `n8n-nodes-base.executeCommand`
  with "Unrecognized node type" even with no `NODES_EXCLUDE` set — so there is **no shell** (no `rm`,
  no `find` sweeps) from inside a workflow. `n8n-nodes-base.readWriteFile` exists but is **read/write
  only — no delete operation**. Consequence: never design a temp-file-on-disk scheme that needs
  cleanup from inside n8n (nothing can garbage-collect it). To move binary across without disk, use
  **`Convert to File`** (`operation:'toBinary'`, base64 string → binary `data`) and pass image bytes
  as **base64 in the JSON payload** (then rely on n8n execution pruning, not files). This is why
  ADR-036 Block 10's image delivery is in-memory base64, not server temp.
- **ClickUp comment inline image = the undocumented `{type:attachment}` op; there is no
  delete-attachment API.** To render an image inline in a ClickUp comment, the comment ops array op
  must be `{ "type":"attachment", "attachment":{ "id":"<attachment_id>", "url":"<attachment_url>" } }`
  referencing a **real ClickUp task attachment** (uploaded via `POST /api/v2/task/{id}/attachment`,
  multipart field `attachment` → `{id,url}`). A bare `{ "image":"<url>" }` op is accepted + stored but
  **never renders** (blank); `comment_text` markdown `![](url)` stays literal text. The comment endpoint
  is **JSON-only** (no one-call multipart). ClickUp v2 has **no delete-attachment endpoint**, and a
  comment-referenced attachment is **free-floating** (deleting the comment leaves it), so a failed post
  can only WARN with the orphaned ids — it cannot roll back the upload (ADR-036 Block 10).
- **ClickUp webhook auth = HMAC-SHA256(secret, rawBody) hex** in the
  `X-Signature` header. You must hash the **raw** request body, not a
  re-stringified JSON (bytes differ → signature mismatch): set the Webhook node's
  `rawBody: true`, which keeps the exact bytes in binary `data` while still
  leaving `$json.body` parsed for downstream use.
- **Sub-workflow return value is the "last" node — keep the return path
  branch-free.** A `When Called`/`executeWorkflow` sub-workflow returns the output
  of whichever node n8n considers "last"; with **any branching (IFs, side-effect
  nodes) this is non-deterministic** and will silently return the wrong node's data
  — independent of connection order *or* node-array order (both were tried and
  neither controls it). Make the return path a single linear terminal (… →
  aggregate as the **sole leaf**); push side-effects (alerts, posts) to the caller
  or a post-return step, and have the reader *report* problems as structured data
  (e.g. a `warnings` array) for the caller to act on. Also: a **`Code (run once for
  all items)` node with multiple incoming connections runs once *per* connection**,
  processing only that branch's items and dropping the rest — give aggregators
  exactly **one** input (merge upstream into a single stream first). Both traps were
  hit building `read-input-text` (ADR-036, Block 2).
- **ClickUp threaded replies: reply to the comment's own `id`, never `comment.parent`.**
  To reply in-thread, POST to `/api/v2/comment/{comment.id}/reply`. For a **top-level**
  comment ClickUp populates `parent` with the **task id**, so replying to `parent` targets a
  task (not a comment) and the call fails ("The service was not able to process your request").
  This silently broke in-thread replies in the CU Webhook Producer's `Detect Mention` node
  (it preferred `comment.parent`); the fix reads `comment.id` first (ADR-035). Verify against
  the producer's real webhook payload, not assumptions.
- **Live-testing any workflow: use `scripts/test-subworkflow.mjs`, not a hand-built harness and not
  the Form Trigger over the API.** A sub-workflow whose production entry is a `When Called`
  (`executeWorkflowTrigger`) node can't be hit over HTTP directly. The script automates the throwaway
  harness: `node scripts/test-subworkflow.mjs <workflowId> --file input.json` stands up a temporary
  `Webhook → Execute → Respond` caller, maps every declared `When Called` input from the POST body,
  returns the workflow's output inline, prints the real `integrated` execution id, and tears the harness
  down. Then inspect with `scripts/inspect-execution.mjs <execId>` (node-by-node), scan
  `scripts/alerts-since.mjs`, and for anything that writes `agent_runs` check the row(s) and **delete
  test rows + any test ClickUp tasks afterward** (ClickUp has no delete-attachment API, so prefer a fresh
  disposable task over re-using one). Three traps that have each cost a debugging cycle:
  - **Don't trigger the orchestrator spine through its Form Trigger over the API** (`/form/<webhookId>`).
    The n8n production form endpoint does **not** map `FormData`/url-encoded field names the way the
    browser form does, so the run starts with **all-null fields** → a ClickUp call on a null task id
    fails → a **cascade of CRITICAL alerts** (self-inflicted; explain it, don't chase it). A
    `--data-urlencode` POST also fails outright ("Expected multipart/form-data"). To drive the full
    spine, call the orchestrator's `When Called` via `test-subworkflow.mjs` with the producer's exact
    inputs (`triggered_by=explicit_mention`, `invocation_type=explicit`, a real `reviewer_user_id`).
  - **Build the input JSON with Node (`JSON.stringify`), never by hand-escaping in a heredoc.** Fields
    like `output_blocks_json` are JSON-inside-JSON; hand-written `\n`/`\"` double-encode, the inner
    `JSON.parse` silently throws, and the node emits **0 items** (looks like a logic bug, isn't). Write
    the input file with a tiny Node script instead.
  - **Use a project-relative path for the input file** (e.g. `./input.json`). Node on Windows resolves
    `/tmp` to `C:\tmp` while Git Bash maps `/tmp` elsewhere, so a script that writes `/tmp/x.json` and a
    reader that reads `/tmp/x.json` silently disagree. Found landing ADR-048 Block 5 / ADR-051 Block 4.

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
   mean every node did what was intended. Helper: `node scripts/inspect-execution.mjs
   <execId> [--nodes A,B] [--fields x,y]` prints a compact per-node view (status,
   per-output item counts so you can see which IF/error branch fired, selected fields)
   without the oversized payload — use it instead of dumping the raw execution.
3. **Check the ClickUp alert channel.** If any WARN or CRITICAL alert fired during
   the test run, treat it as a failure until explained. Helper: `node
   scripts/alerts-since.mjs <minutes> [--crit] [--source <substr>]` lists Post Alert
   firings in a window (reads them as n8n executions — no ClickUp token needed).

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

## Reusable tooling — offer to persist it (don't let it die with the session)

Much of the repetitive work in this project (deploying n8n changes, inspecting executions
node-by-node, re-exporting, drift-checking, scanning the Alerts channel during a Definition-of-Done
test) is done with throwaway, session-only snippets — ad-hoc PowerShell `ConvertFrom-Json`,
one-off `jq`-style extracts, manual API pokes. Those evaporate at `/clear` and get re-derived from
scratch next time, which is wasted effort and a source of inconsistency.

**First — check for an existing tool before writing new code.** Persisting scripts is pointless if the
next session re-derives them blind. Before hand-rolling a snippet for a deploy/verify/inspection task,
**scan `scripts/` (and skim each candidate's top-of-file comment)** for something that already does it
or is one flag away — e.g. `inspect-execution.mjs`, `alerts-since.mjs`, `export-workflows.mjs`,
`check-workflow-drift.mjs`. Reuse or extend it rather than starting fresh. This is the standing "read
existing patterns before adding new ones" rule, applied to tooling specifically.

**Then — offer to persist anything reusable.** Whenever you write a script, snippet, or small program
that you'd plausibly reuse — or that sped *this* task up enough that re-deriving it next session would
hurt — **stop and ask the operator whether to save it permanently** (typically under `scripts/`,
mirroring the existing `export-workflows.mjs` / `check-workflow-drift.mjs`). When you ask:

1. Say in one or two lines **what the program does**.
2. Say **how it would aid future work/deployment** (which recurring step it replaces, e.g. "every
   block's verification re-parses a too-big execution payload by hand — this prints the compact
   per-node summary directly").
3. Propose a name + home (`scripts/<name>.mjs`), note any env it needs (e.g. `N8N_API_KEY`), and let
   the operator decide — default to **not** committing it unless they say yes.

This applies to genuinely reusable tooling, not to a literal one-liner you'd never run twice. Prefer
extending an existing script over adding a near-duplicate. If the operator says yes, document it with
a top-of-file comment (purpose + usage), the way the existing `scripts/*.mjs` are.

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

## VPS access — SSH is standing-authorized

Claude has **standing permission to SSH into the production VPS** (`franciszek@185.25.149.174`,
docker group + passwordless sudo) to diagnose and operate the stack — `docker ps` / `logs` /
`restart`, container health, memory checks, etc. Use it directly; no need to ask first for
read-only diagnostics or standard incident recovery. Guardrails still apply: **don't edit `.env`
or make irreversible config changes without per-task confirmation**, and confirm the evidence
actually supports a state-changing command before running it (restart a container only once
logs/status show it is genuinely wedged). Deploy dir is `/opt/haxe-agents`; prefer
`docker compose up -d` for config changes (ADR-033), `docker restart <container>` to bounce a
hung process. **Caution:** heavy execution floods + rapid workflow create/delete can drive n8n's
Insights subsystem into a write-error loop that starves `n8n-main` and returns 502 — recover with
`docker restart n8n-main`; avoid generating large bursts of throwaway executions when testing.

## When in doubt

- Check `architecture/decisions/` for past reasoning
- Check `docs/operating-procedures.md` for what should happen day-to-day
- If a significant decision is needed, propose it as a new ADR draft in 
  `architecture/decisions/` rather than making the change silently
- For ambiguous situations, ask me before proceeding

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

_(empty — entries get promoted into the sections above once they stabilize.)_