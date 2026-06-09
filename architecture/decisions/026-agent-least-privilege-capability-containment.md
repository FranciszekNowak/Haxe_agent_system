# ADR-026: Agent least privilege — capability containment over credential trust

Date: 2026-06-08
Status: Accepted. Cost-field write resolved 2026-06-08 — deterministic node writes are
permitted; the constraint is that **write capability is never exposed to the LLM**.

## Context
The agent must not be able to edit or delete arbitrary ClickUp data (custom fields,
task content, tasks themselves). Operator directive: the agent reads and *proposes*
(draft comments) — it does not mutate state.

Two facts shape how we can enforce this:

1. **The model has no agency of its own.** `Invoke Model` (ADR-022/024) is a pure
   `prompt → completion` HTTP call to LiteLLM. The LLM holds no credentials and no
   tools; it can only emit text. Every side-effect is performed by a deterministic,
   version-controlled n8n node (ADR-019). So "what the agent can do to the world" =
   exactly the set of operations we wire into workflows — nothing the model decides.

2. **ClickUp cannot give us a least-privilege API token.** Guests can be made
   comment-write-only but **cannot mint a personal API token**; Members can mint a
   token but carry **broad edit/delete/field-write** rights across every Space they
   join. ADR-004's 2026-06-02 update records that `agent@haxe.com` was therefore made
   a **Member** (token in n8n credential `QRrgf6hteyGWSJyv`), not the comment-only
   guest §13.3 originally described. The token is consequently over-privileged
   relative to intent. Live proof: the Agent-Spine cost-field write (ADR-024 / item
   "Koszt akcji") succeeds, i.e. the token can edit custom fields.

ADR-004's caller-scoping (Layer A prompt-scope, Layer B MCP gateway) is not built,
and Layer B as conceived — intercepting the model's tool calls — does not apply while
the model has no tools.

## Decision
Enforce "agent edits/deletes nothing" by **capability containment first, credential
scoping second**:

1. **The model stays tool-less (primary guarantee).** No generic ClickUp/Postgres
   write tool is ever exposed to the LLM. The only mutations possible are the exact,
   code-reviewed operations wired into version-controlled workflows. We keep an
   explicit **write allow-list**; the default for any agent-driven path is
   **read + draft-comment only**.
2. **If a ClickUp tool surface is ever exposed to the model** (future Layer B / MCP
   gateway), it must be an **allow-list of read + comment** operations — edit/delete
   absent *by construction*, not by runtime policy.
3. **Single identity, scoped by membership.** All ClickUp I/O uses the one
   `agent@haxe.com` Member token; add it only to Spaces it must see. A separate
   telemetry identity was considered and **decided against (2026-06-08)** — the
   tool-less-model guarantee already bounds what can happen, and a second account adds
   operational overhead for little marginal safety at this scale.
4. **Drafts, never finalize.** The agent proposes via comments a human approves; it
   never edits work-product fields or status.

### The cost-field write (the one current mutation)
**Resolved (2026-06-08, operator decision):** the system **may** edit custom fields —
including `[AI] Koszt akcji [PLN]` — provided the write is performed by a **deterministic
n8n node or Code block**, never by a capability handed to the LLM. The Agent-Spine cost
node satisfies this: it is a fixed, version-controlled `SUM(agent_runs.cost_pln)` →
ClickUp set-field call; the model has no part in it. It stays as built, on the existing
ClickUp token. No identity split is required (a dedicated telemetry token was considered
and decided against, 2026-06-08).

## Consequences
- The strong, durable guarantee is architectural: a tool-less model + a fixed,
  reviewed node set means the agent cannot perform an operation we did not write. This
  holds regardless of ClickUp's coarse token permissions.
- **Residual risk (accepted):** the `agent@haxe.com` Member token can edit/delete
  anything in its Spaces; it is used for reads, comments, and the cost write. Mitigations:
  keep it out of Spaces it needn't see; on plans that support custom roles, restrict
  delete. Accepted because the tool-less-model guarantee is the real control.
- The cost-field write stays live as a deterministic node (resolved above); no blocking
  operator step remains.
- Reinforces the project-wide rule (CLAUDE.md "Reliability & observability"): writes
  are an explicit, allow-listed capability — not an emergent one.

Related: ADR-004 (caller-scoped permissions; the Member-vs-guest token constraint),
ADR-019 (credential-aware nodes; Code nodes only shape data), ADR-024 (the cost-field
write being constrained), ADR-013 (centralized, tool-less invocation seam).

> Update 2026-06-09 (bounded exception — supersedes the literal "model stays
> tool-less" claim): ADR-034 gives the model exactly one tool — `web_search` — so
> "the LLM holds no tools" is no longer literally true. The *guarantee this ADR
> protects still holds*: web search is **read-only**, executed by deterministic infra
> (LiteLLM interception → Tavily), returns only public information, and exposes **no
> write/edit/delete and no Haxe/ClickUp state** to the model. The default for any
> agent-driven path remains read + draft-comment only; the only tool ever exposed is a
> read-only external search. Any *write* tool would still require a new ADR.
