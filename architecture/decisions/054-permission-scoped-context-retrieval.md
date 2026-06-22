# ADR-054: Permission-scoped context retrieval within Managed Agents

Status: Accepted
Date: 2026-06-16
Depends on: ADR-053 (Managed Agents switch), ADR-049 (per-user permission fidelity, audience tiers, DWD design)
References: ADR-035 (cost logging)
Beta surface: Anthropic Managed Agents Vault (OAuth auto-refresh, `vault_ids` per session, credentials proxied outside the sandbox)

> **Build status (updated 2026-06-22; full consequences reconciled in master-plan Block 6).** This is being
> built **ClickUp-only**; Google (Drive + Gmail) DWD is **deferred to a follow-up ADR**. Two Block-0 reshapes
> override the mechanism described below: (1) ClickUp OAuth tokens **do not expire and issue no refresh
> token**, so the per-user credential is a **`static_bearer`** holding the access token — **not** the
> "OAuth auto-refresh" credential the Beta-surface line and §2 describe, and there is no refresh machinery;
> (2) the as-U **REST `GET task` extraction is load-bearing**, not optional, because the hosted ClickUp MCP
> returns no attachment metadata/content. **Block 1 landed (scaffold, not yet wired into sessions):** the
> per-user credential store (`user_clickup_credentials`, migration 039; one Anthropic Vault per user), the
> OAuth app-secret getter (`get_clickup_oauth_app()`, migration 040), a CSRF-state table (migration 041), and
> a self-serve hosted consent flow (n8n `ClickUp OAuth Onboarding (v1)`: `/webhook/clickup-oauth-start` →
> ClickUp consent → `/webhook/clickup-oauth-callback` mints the per-user Vault credential + mapping row); a
> local-loopback script (`scripts/onboard-clickup-user.mjs`) is a dev fallback. See
> `architecture/Build plans/adr-054-clickup-scoped-retrieval/`
> (`master-plan.md`, `block-0-findings.md`, `block-1-findings.md`).

## Decision (verdict first)

The managed agent gathers context from ClickUp, Gmail, and Drive under the triggering user's identity, enforced by n8n at the executor level, never by the agent. Google uses domain-wide delegation through a custom tool; ClickUp uses per-user OAuth tokens held in the Vault and selected per session. Task-bound context is pre-gathered deterministically; only open-ended discovery runs as live scoped tools. Scope is enforced by the credential, so a prompt-injected agent cannot exceed the user's permissions.

## Context

The agent needs live context from ClickUp, Gmail, and Drive during reasoning. Per ADR-049, per-user permission fidelity is required: the departmental boundary (for example Marketing cannot read Purchasing) is a real boundary, not advisory. So any data retrieved for a task triggered by user U must be limited to what U may see, and only that may surface in U's deliverable.

The trap: MCP authenticates as the identity of the credential in the Vault, which is fixed, not the triggering user. A single bot or service credential would expose everything that credential can see, on every task, regardless of who triggered it. Off-the-shelf MCP therefore does not provide per-user scoping. The reason a personal ChatGPT ClickUp connector works is that it is authenticated as that one user; the multi-user unattended automation has no logged-in user and must inject the right identity per task.

The Vault helps: it stores OAuth credentials with auto-refresh and static bearer tokens, attaches to sessions via `vault_ids`, and keeps credentials outside the sandbox, proxied, so generated code cannot exfiltrate them.

Key observation that frames the design: holding per-user identity at retrieval is the same engineering whether the search is driven by the agent or by n8n, because credentials must live outside the agent either way. So the agent-versus-n8n choice is about retrieval quality, not permission cost, and the agent wins on open-ended discovery because deciding what to search is judgment.

## Decision detail

1. Identity enforced at the executor, not by the agent. The agent never holds a token and never selects the identity. n8n binds each session to its triggering user U at session creation, and every retrieval on that session runs as U. Because the binding is set by n8n (which knows whose task it is) and not passed by the agent, it is unspoofable, and scope is enforced by the credential rather than by the agent's behavior.

2. Mechanism by system.
   - Google: domain-wide delegation. One service account, admin-granted impersonation, can act as any user with no per-user consent. The stock Drive and Gmail MCP do not perform DWD, so this is a custom client-side tool: n8n, knowing U, makes the impersonated API call as U and returns scoped results. Future-proof, because new users are covered automatically through the directory.
   - ClickUp: per-user OAuth tokens (no DWD equivalent). Each user consents once; the token is stored as a Vault credential with auto-refresh; at session creation n8n attaches U's `vault_id`; the stock ClickUp MCP then runs authenticated as U for the whole session. No custom handler required.

3. Session-to-user binding is the enforcement point. At session creation n8n attaches U's `vault_id` and tags the session's tool-executor context with U. This is roughly one day of work and is the linchpin of correctness.

4. Hybrid retrieval split.
   - Task-bound context (the task's own attachments, comments, linked items): pre-gathered deterministically in n8n under U's identity, reusing the read-input layer (ADR-053). Mechanical, cheap, mostly already built.
   - Open-ended discovery (find related material across the workspace): live tools the agent calls, scoped to U (stock ClickUp MCP via the per-session Vault credential; custom Google DWD tool). The agent's judgment drives the search; the executor and Vault enforce scope. This is the only surface that needs live per-user MCP, which keeps the hard surface small.

5. Credentials never enter the sandbox. ClickUp tokens live in the Vault (proxied, outside the sandbox). The Google DWD service-account key lives in n8n or a secrets manager and is never exposed to the agent. The agent receives only scoped results.

6. Scope-correctness testing is the acceptance gate. Before production, explicitly verify that a task triggered by a user of one department cannot retrieve another department's data through any path, including open-ended search. A mis-mapped credential fails silently, and this boundary is the entire point, so this gate is mandatory.

## Rejected alternatives

- R1. Single bot or service identity for the agent's MCP. Exposes everything that identity can see to every task, re-opening the ADR-049 departmental boundary. Acceptable only if that boundary is downgraded to advisory, which is not the decision.
- R2. Run the entire research lane in n8n with no agent live tools. The per-user credential machinery is identical (n8n holds the credentials either way), so it costs the same on permissions, but n8n must decide what to search via fixed heuristics, which is weaker than agent-driven iterative search for open-ended discovery. Pure-n8n pays the same for a worse result. Deterministic task-bound pre-gather is kept as the complement, not the whole.
- R3. Service account plus post-hoc permission filtering. Re-implements the permission system in application code; fragile and error-prone. The boundary must come from the API acting as U, not from our filter.
- R4. Per-user OAuth for Google instead of DWD. Rejected as the default: DWD avoids per-user consent and covers staff changes automatically. Per-user Google OAuth is the lower-build v1 shortcut if DWD setup is delayed, but it does not scale as cleanly.
- R5. Pass the triggering user-id to a hosted MCP for it to scope. A user-id passed by the agent is spoofable; binding identity at the n8n executor is not.

## Consequences

- Per-user fidelity is preserved, and scope enforcement is injection-resistant because it lives in the credential, not the agent. The agent still gets intelligent, scoped, open-ended search; the deterministic bulk is handled cheaply.
- Reuses two existing patterns: the image-tool session-stream listener (ADR-053) and the read-input pre-gather (ADR-048, ADR-053).
- Effort: roughly one to two focused weeks. The distribution: the ClickUp OAuth plumbing (app registration, per-user consent, Vault wiring) and the Google DWD tool (admin setup, impersonation handler) are a few days each; the session-to-user binding is about a day; scope-correctness testing is several days and is the acceptance gate.
- Ongoing: new ClickUp users need a one-time OAuth consent; DWD covers new Google users automatically. ClickUp token refresh is handled by the Vault; revocation is handled by us.
- The Google DWD tool is the one piece of genuinely custom code in the context layer; everything else composes the Vault, the stock ClickUp MCP, and existing n8n patterns.

## Block 0 capability-gate outcome (2026-06-22)

The ClickUp-only build (operator-scoped 2026-06-22; Google deferred) ran its capability-gate spike. Full spec: `architecture/Build plans/adr-054-clickup-scoped-retrieval/block-0-findings.md`. The core decision **holds** — ClickUp operates a registerable hosted MCP (`https://mcp.clickup.com/mcp`) and a per-user OAuth token in the Anthropic Vault scopes it to the triggering user via `vault_ids`. Three reshapes refine, but do not overturn, the design:

1. **Credential type is `static_bearer`, not Vault auto-refresh.** ClickUp OAuth tokens do not expire, issue no refresh token, and carry no granular scopes — so there is nothing to auto-refresh. This simplifies the lifecycle (onboard + revoke only) and removes the refresh dead-man's-switch this ADR's "ClickUp token refresh is handled by the Vault" line anticipated; revocation remains ours.
2. **The discovery MCP must be locked read-only in software.** With no read-only OAuth scope, the `mcp_toolset` allowlists read/discovery tools and disables every write tool.
3. **The as-U extraction (decision detail §4) is load-bearing, not optional.** The hosted MCP returns descriptions, comments, custom-field values, and Doc-page text but **not** attachment metadata or extracted content — so reaching any attachment requires the as-U REST `GET task` (Option 2), re-validated as the user at fetch time.

One sequencing consequence: the MCP rejects ClickUp personal (`pk_`) tokens, and the workspace is greenfield (no OAuth app yet), so the live cross-department scope-correctness test (the §6 acceptance gate) cannot run until the OAuth 2.1 + PKCE app exists. A minimal two-user negative smoke is pulled into the OAuth-app block's tail; the exhaustive gate remains.
