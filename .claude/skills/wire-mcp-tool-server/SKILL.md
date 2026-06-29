---
name: wire-mcp-tool-server
description: >-
  Host a self-hosted MCP tool server and wire it to a Claude Managed Agent. Covers the decision to
  self-host versus rent a hosted MCP, then the five-step wiring (host the container, store the auth
  token in the Vault, add it to the agent's mcp_servers, scope the toolset, attach a health
  dead-man's-switch) plus the capability gate and the hard-won gotchas. Use when adding a new tool
  capability to the agent by exposing it as an MCP server, or when the user says "wire up an MCP
  server", "expose X as a tool to the agent", "add a tool server", "host an MCP for Y", or names a
  specific tool server (Playwright, browser, image generation, a custom API wrapper).
---

# Wire a self-hosted MCP tool server to the managed agent

This is the repeatable pattern behind ADR-055 (image MCP) and the browser/Playwright MCP. The server is
usually off-the-shelf; the value and the risk are in the wiring, the scoping, and the operations.

## Step 0: decide self-host vs rent (do this first, do not skip)

Self-hosting is the default, not the law. Choose before wiring:

- **Self-host** when the tool runtime is cheap to run and you want control plus cost logging in your lane
  (the handler is your code, so it can write the ADR-035 cost rows). Most custom API wrappers and the image
  lane are here.
- **Rent a hosted MCP** when the runtime is heavy or operationally painful: browsers at volume
  (Browserbase and similar) offload crash and resource management that would otherwise threaten the host.

Only proceed into the procedure once self-host is chosen. Skipping this gate trains you to self-host
everything, which is the commodity-replication trap.

## Step 1: capability gate (the kill-criterion, run before building)

Confirm the harness MCP tool-call timeout tolerates the tool's slowest real operation. Image generation
runs ~170s (ADR-055); browser flows run minutes. If the timeout cannot tolerate it, the tool is infeasible
as an MCP call: stop, or rent a host that streams progress. This is the single fastest way to find out the
wiring will not work, so it goes first, before any hosting effort.

Also confirm session isolation: each agent session must get its own tool context (its own browser context,
its own working directory), or concurrent sessions corrupt each other.

## Step 2: host the server

Run the server as a container behind the existing reverse proxy, in HTTP/SSE mode, on the VPS. Off-the-shelf
servers (for example Microsoft's `@playwright/mcp`) need only hosting and reachability, which is the same
work as the image MCP. Heavy stateful servers (browsers) get a hard concurrency cap (1 to 2) at this step,
see gotchas.

## Step 3: auth token in the Vault

Pick the auth model by what the tool reads:

- **Identity-neutral tool** (generates an image, renders a page, calls a public API): a fixed **service
  bearer** is correct. Mint once, store in the Anthropic Vault (attached per session, proxied outside the
  sandbox), mirror in Supabase Vault for rotation. This is the ADR-055 model.
- **Tool that reads departmental data** (anything that could surface one user's data to another): it needs
  **per-user scoping** per ADR-054 (per-user token in the Vault, or DWD), bound to the triggering user at
  the executor. Do not give a data-reading tool a single shared identity.

The token never enters the sandbox. The Vault proxies it so generated code cannot reach it.

## Step 4: add to the agent's mcp_servers

Register the server URL on the agent definition's `mcp_servers`. Agents are versioned, so a change here is a
new agent version to deploy, not a live edit.

## Step 5: scope the toolset (read-mostly by default)

Allowlist the read and discovery tools; disable or gate the write and state-changing tools. A tool that can
act on the real world (place an order, change a live setting, submit a form, browse a production site) is a
loaded weapon if exposed raw. Point browser-class tools at staging URLs and gate any state-changing action
behind human approval. This mirrors the ADR-054 read-only ClickUp lock.

## Step 6: attach the health dead-man's-switch

A self-hosted MCP that goes down fails silently: the agent's tool calls just start erroring. Add a heartbeat
plus a host systemd timer (the ADR-046 pattern, external to n8n) that alerts when the heartbeat goes stale.
Queue-depth or run-failure alerts will not catch a quietly-dead server fast enough.

## Gotchas (each tied to where it was learned)

- **Timeout is the kill-criterion, gate it first** (Step 1). ADR-055 image ~170s; browser flows minutes.
- **Credentials live in the Vault, proxied outside the sandbox.** Generated code must never reach them.
- **Read-mostly by default; gate writes behind approval.** Real-world side effects are the danger, not the
  tool itself.
- **Heavy stateful servers need a hard concurrency cap plus the health monitor.** A runaway browser OOMs the
  host and takes n8n and the queue consumer down with it. Cap at 1 to 2, or rent.
- **Decide cost-logging placement at wiring time.** The self-hosted handler is your code, so it writes the
  ADR-035 cost rows. This is the whole reason to self-host over a third-party MCP; do not lose it.
- **Auth model follows the data, not the convenience.** Identity-neutral → service bearer. Reads
  departmental data → per-user scoping (ADR-054). Getting this wrong is a silent permission leak.
- **Agent definitions are snapshotted.** Adding the server requires deploying a new agent version; a live
  edit will not take effect until redeploy.

## Examples

- **Image MCP (ADR-055).** `generate_image`; self-hosted; reuses the existing image lane and parallel
  executor; cost logged in the handler; identity-neutral, so a fixed service bearer. Corrects the earlier
  premise that an MCP loses cost logging (false for a self-hosted server: the handler is your code).
- **Browser / Playwright MCP.** Off-the-shelf `@playwright/mcp`; read-mostly, pointed at staging; concurrency
  capped at 1 to 2; timeout gate for minute-long flows; used for open-ended diagnosis ("reproduce the DTC
  checkout failure"), beside, not replacing, the deterministic render-and-screenshot harness.

## References (in the repo)

ADR-046 (dead-man's-switch), ADR-054 (per-user scoping and read-only locking), ADR-055 (image MCP, the worked
instance and the cost-logging correction), ADR-035 (cost logging), ADR-056 (timeout and lock discipline).
