# ADR-019: Credential-aware nodes do authenticated I/O; Code nodes only shape data

Date: 2026-06-02
Status: Accepted

## Context
Workflows frequently need to call an authenticated API (ClickUp, Bedrock, Gmail) from
inside logic that also wants custom code — e.g. walking an unknown-depth parent chain and
accumulating results. The tempting shortcut is to make the HTTP call from within a Code
(JavaScript) node, keeping fetch + loop + accumulation "in one readable place."

That shortcut fights n8n's design. n8n's whole credential model treats the **node** as the
unit of authentication: a credential-aware node (HTTP Request with a predefined credential
type, or a native service node) declares which credential type it accepts, and at run time
n8n decrypts the stored credential and injects it **only into that node's auth handler**.
The secret never enters the data stream, an expression, or the workflow JSON. The Code node
is deliberately *outside* this model — it is a sandbox for arbitrary user JS and has **no
credential selector**. The only way to authenticate from inside it is
`this.helpers.httpRequestWithAuthentication`, which is fragile: version-sensitive (the
`this.getNode is not a function` bug was fixed only in n8n 1.42.0), the credential ends up
buried in a JS string instead of the visible node binding (defeating the
"visually inspectable" rule in CLAUDE.md), and credential-instance resolution from a node
with no attached credential is ambiguous.

## Decision
- **Authenticated I/O always lives in a credential-aware node** — HTTP Request with
  *Authentication → Predefined Credential Type*, or a native service node. Never via the
  Code-node `httpRequestWithAuthentication` back-door.
- **Code nodes are restricted to pure data shaping/transformation.** They MUST NOT make
  network calls and MUST NOT reference credentials or secrets.
- When logic needs both fetching and custom processing, **separate the concerns**: a
  credential-aware node fetches; a Code node (or normal nodes) shapes the result.

## Consequences
- Unknown-depth fetch-and-accumulate loops (e.g. the ClickUp parent-walk) are expressed as
  a **normal-node cycle** — a credential-aware fetch node + an IF (continue?) + a back-edge —
  with a small Code node only for final ordering/labelling. The fiddly part is
  cross-iteration accumulation in normal nodes; that cost is accepted as the price of clean
  credential handling and inspectability.
- This is the *reason behind* the CLAUDE.md rule "use normal nodes, not Code nodes, wherever
  possible": the rule's escape hatch ("when no normal node can express the logic") may apply
  to **looping/accumulation**, but it never licenses doing **authentication** inside a Code
  node.
- Secrets stay confined to the node n8n injects them into — consistent with the Tier-3
  encrypted credential store (ADR-011).

Related: ADR-011 (credential storage), ADR-015 (single generic pipeline).
