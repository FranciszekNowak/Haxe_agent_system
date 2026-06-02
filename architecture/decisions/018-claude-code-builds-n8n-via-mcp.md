# ADR-018: Claude Code builds n8n workflows via the n8n MCP server (REST API control plane)

Date: 2026-06-02
Status: Accepted

## Context
Workflows have to be authored somewhere. The two obvious options were (a) hand-write
n8n workflow JSON and import it, or (b) build everything by hand in the n8n editor.
Option (a) is error-prone and untestable outside a running n8n; option (b) makes the
operator do all the mechanical work, which defeats the point of having Claude Code as
a builder. The operator's stance: "I want Claude to be the builder; I inspect, comment,
and correct."

n8n is already reachable — `n8n-main` binds `127.0.0.1:5678` on the VPS and is exposed
over TLS at `https://agents.haxe.ai` via the Nginx `location /` catch-all (ADR-012), so
its public REST API (`/api/v1/…`) is reachable, key-protected (401 without a key). No
new exposure is required to drive it programmatically.

## Decision
Claude Code drives n8n through the community **`n8n-mcp`** server
(czlonkowski/n8n-mcp), configured as an MCP server in a **committed** `.mcp.json` at the
repo root. It gives Claude management tools (`n8n_create_workflow`,
`n8n_update_partial_workflow`, `n8n_validate_workflow`, `n8n_test_workflow`,
`n8n_executions`, `n8n_list_workflows`, …) over the n8n REST API, plus an offline node
catalog and a `validate_workflow` tool.

Configuration specifics:
- **Endpoint**: `N8N_API_URL=https://agents.haxe.ai` (base URL, no `/api/v1` suffix).
- **Secret**: `N8N_API_KEY` is referenced as `${N8N_API_KEY}` in `.mcp.json` and supplied
  from the machine environment (setx — see ADR-017). The key never enters git; the config
  file is safe to commit and shared across both Windows desktops.
- **Launch command**: `cmd /c npx n8n-mcp@2.56.0` (pinned for reproducibility). The `cmd /c` wrapper is mandatory on
  Windows — `npx` is a `.cmd`/`.ps1` shim, not a real `.exe`, and Claude Code's spawner
  cannot execute it directly (fails with "%1 is not a valid Win32 application"). Both
  operator desktops are Windows, so the committed config works for both.

## Why this over the alternatives
- Claude can create, **validate**, and deploy workflows directly, then iterate against
  real executions. The bundled validator closes the "can't test n8n locally" gap that
  otherwise made hand-authored JSON risky.
- It resolves the standing CLAUDE.md tension ("n8n workflow files are exported JSON; do
  not hand-edit them — edit in the UI and re-export"): steady-state authoring happens via
  the API + UI, not hand-edited JSON. Hand-authoring a JSON *scaffold* to bootstrap an
  empty workflow (e.g. `n8n/workflows/context-gather.json`) remains acceptable; the repo
  copy is kept current by exporting from n8n after changes.

## Consequences
- **The API key is an internet-facing control-plane key** — full read/write over every
  workflow via the public API. Mitigated by: key-only auth (401 without), an expiry of
  2026-08-31, and event-based rotation (ADR-017). Optional future hardening: restrict
  `/api/` + `/rest/` in Nginx to known IPs or require an SSH tunnel.
- **Supply chain**: `n8n-mcp` is a third-party npm package running with a full-access key.
  Pinned to `2.56.0` for reproducibility (bump deliberately, not via `@latest`). Worth a
  periodic glance at the upstream repo given the GDPR posture.
- Workflows remain version-controlled by exporting their JSON into `n8n/workflows/`.
- No n8n MCP node is involved — this is about *managing* n8n, distinct from n8n's own
  `MCP Server Trigger` / `MCP Client Tool` nodes, which expose workflows as tools.

Related: ADR-017 (API key storage/expiry), ADR-011 (Docker stack / credential store),
ADR-012 (Nginx TLS endpoint), ADR-019 (node/credential discipline inside workflows).
