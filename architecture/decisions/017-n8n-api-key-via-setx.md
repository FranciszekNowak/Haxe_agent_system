# ADR-017: Store the n8n API key for Claude Code via setx (user environment variable)

Date: 2026-06-02
Status: Accepted

> Update 2026-06-02 (supersedes the "No expiry on the key" decision below):
> an expiry of **2026-08-31** was set on the key at creation time. The original
> no-expiry reasoning is retained below for the record. The trade-off was
> resolved in favour of a hard backstop — a single dated expiry caps the
> lifetime of an unnoticed leak — with the silent-mid-build-failure risk
> mitigated by a calendar reminder to rotate before 2026-08-31 (see the
> "To add an expiry" runbook below). Event-based rotation still applies *on top
> of* the expiry, not instead of it.

## Context
Claude Code builds workflows directly in n8n through the n8n MCP server, which
authenticates to the n8n public API with an API key (env var `N8N_API_KEY`). That
key is full read/write over every workflow via the internet-facing public API, so it
is effectively a control-plane key for the n8n instance. Two decisions were needed:
(1) whether to put an expiry on the key, and (2) how to store the value so Claude
Code (and the MCP server it launches) can read it.

This is build-phase tooling on a single personal Windows machine, used interactively
by one operator (Franciszek). The n8n instance holds no irreplaceable production data
yet. The key is used in a fast iteration loop, not handed to a third party.

## Decision

### No expiry on the key (for now)
The key is created without an expiry. Leak risk is controlled by **event-based
rotation** instead of a timer: revoke and regenerate when the heavy build phase ends,
when Claude Code stops being used against n8n for a while, or if the machine is ever
compromised.

Rationale: blast radius is currently small (one machine, one operator, no production
data, misuse would be noticed fast). An expiry's only benefit is capping the lifetime
of an unnoticed leak; against that, an expiry imposes a recurring cost: the key dies
silently mid-build on a forgotten date, costing diagnosis time. For an actively-used
build key, that interruption is the more probable harm than a leak. Event-based
rotation captures most of the leak-capping benefit with no silent time-bomb.

### Storage via setx (user environment variable)
The value is stored with `setx N8N_API_KEY "<key>"`, which writes it permanently into
the current user's environment in the Windows registry. Future processes (a freshly
launched Claude Code) inherit it automatically.

Rationale: it is the standard, lowest-friction way to hand a secret to a dev tool
without writing it into any file the tool reads, so it cannot be committed to git by
accident. Set once, inherited everywhere, nothing to remember at launch. The main
discomfort with it was opacity, not a real scoping problem, and that is resolved by
knowing where the value lives (see below).

## How setx actually works (so future-me can reason about it)
- Windows keeps per-user environment variables in the registry. When any program
  starts, it receives a COPY of those variables.
- `setx` edits the stored registry copy. It does NOT change the environment of any
  already-running process, only of processes started afterward. This is why Claude
  Code must be fully quit and reopened after `setx` for the new value to take effect.
- The value is stored in the registry in PLAINTEXT, readable by anything running as
  this user. Acceptable for a build-phase key on a personal machine; weaker than a
  real secret manager for long-lived production secrets.
- Inspect the current value in a NEW terminal with: `set N8N_API_KEY` (cmd) or
  `$Env:N8N_API_KEY` (PowerShell), or via the "Edit environment variables for your
  account" dialog. A current/old shell will not show a value set after it launched.

## Considered alternatives
- **Git-ignored `.env` file in the project.** More transparent (you can open it and
  see the key) and project-scoped, but more moving parts: a `.env` does nothing on its
  own — something must load it (e.g. launching via `dotenv-cli`), and the MCP server's
  environment still has to point at it. Rejected for now as higher-friction than setx
  for a single-machine key; remains the natural fallback if scoping/visibility ever
  matters more (see "How to change this").
- **OS keychain / secret manager (e.g. Windows Credential Manager, Vault, AWS Secrets
  Manager).** Correct for long-lived production secrets; overkill for build-phase
  tooling. Deferred until this n8n instance runs real operations.
- **Expiry on the key.** Rejected for now (see above); revisit per tripwires.

## Tripwires — revisit this decision when any of these become true
- The n8n instance starts running real company operations / holds data whose loss or
  tampering matters. → Add an expiry and/or move the key to a secret manager.
- The key needs to live on more than one machine, or be shared with anyone else.
  → Reconsider scoping; per-machine keys, and a managed store rather than setx.
- Claude Code stops being the only consumer, or the key ends up needed by an
  unattended/automated process. → Treat as standing infrastructure, not a build tool.
- Any suspicion of machine compromise. → Rotate immediately (revoke in n8n, regenerate,
  re-`setx`, restart Claude Code), regardless of the above.

## How to change this later (operational runbook)
**To rotate the key (same storage method):**
1. In n8n: Settings → n8n API → revoke the old key, create a new one (copy it once).
2. In PowerShell: `setx N8N_API_KEY "<new-key>"`.
3. Fully quit and reopen Claude Code so the new process inherits the new value.
4. Verify in a NEW terminal: `set N8N_API_KEY` shows the new value; then `/mcp` in
   Claude Code shows the n8n server connected.

**To add an expiry:** create the key with an expiry in the n8n API settings, set a
calendar reminder a few days before expiry to rotate, then follow the rotation steps
above on/before that date.

**To switch to a git-ignored `.env` instead of setx:**
1. Create `.env` in the project root containing `N8N_API_KEY=<key>` (no quotes, no
   spaces around `=`).
2. Add `.env` to `.gitignore`; confirm `git status` does NOT list `.env`.
3. Launch Claude Code through a loader that reads `.env` (e.g. `npx dotenv -e .env --
   claude`) OR reference the var from the n8n MCP server block in `.mcp.json`.
4. Remove the registry value so there is one source of truth:
   `setx N8N_API_KEY ""` (sets empty) or `REG delete HKCU\Environment /v N8N_API_KEY`
   then restart the shell.

**To remove the key entirely:** revoke it in n8n, then clear the env var as in the
last step above.

## Consequences
- Lowest-friction setup for the build phase; no silent expiry failures mid-iteration.
- The key sits in the user registry in plaintext — acceptable at this stage, explicitly
  revisited via tripwires before this becomes standing infrastructure.
- Operational discipline required: rotate on the named events rather than relying on a
  timer; keep the key off git and out of chats/screenshots.
