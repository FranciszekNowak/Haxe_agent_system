# ADR-025: Monitoring & alerting — detect failures and silent degradation

Date: 2026-06-03
Status: Accepted (core built; proactive monitors in progress)

## Context
The system can fail loudly (a workflow throws) or **silently degrade** — keep running
while delivering reduced/zero value, with nobody noticing. The operator needs to know
and act. Examples of silent degradation: the daily FX import stops (stale `cost_pln`);
routing falls back to the cheap default so a high-impact task is quietly downgraded;
LiteLLM returns no cost figure (price-map gap); run logging fails (observability lost).

## Decision
Two complementary layers, behind one channel seam:

1. **Centralized alert seam — `Post Alert (v1)`** (n8n id `YSCdHlmdf3p9XEUx`). An
   Execute-Workflow sub-workflow taking `{severity, source, message, details}` that
   posts a comment to the ClickUp **🚨 Agent System — Alerts & Health** task
   (`869dj2z2c`, currently in the test space) with `notifyAll`. Every alert flows
   through here, so adding email/Slack later is a one-node change.
   - **Channel choice:** ClickUp over email/Slack. It reuses the existing ClickUp
     credential (no new secret), and ClickUp's own assignment/comment notifications
     deliver to the operator's email + mobile — effectively multi-channel via one
     integration. Email/Slack need new credentials and are deferred.

2. **Reactive layer — `Error Handler (v1)`** (n8n id `81eplXMD1v5ONhzs`): a global
   n8n **Error Trigger** → Post Alert (severity CRITICAL, with workflow name, error
   message, execution id/link). Set as the `errorWorkflow` on every pipeline workflow.
   Catches anything that throws (incl. LiteLLM/DB unreachable). **Proven** live: a
   forced failure produced a CRITICAL alert on the hub task.

3. **Proactive layer (heartbeats / in-flow signals)** — catches degradation that does
   NOT throw. To build in Phase C:
   - **FX freshness "dead-man's-switch"**: a daily cron checks the latest `fx_rates`
     row; if older than ~1 day → alert. Catches both "cron errored" *and* "cron
     silently didn't run" (the Error Trigger only catches the former).
   - **Routing fail-safe fired**: in Invoke Model, when the Supabase lookup misses or
     the DB is unreachable and the in-code Sonnet default is used for a task that had a
     real impact → WARN with the task id (silent quality downgrade).
   - **Cost figure missing**: LiteLLM returns no `x-litellm-response-cost` → WARN
     (cost-data integrity).
   - **`agent_runs` logging failure**: don't fail the run, but alert (losing
     observability is itself degradation).

## Consequences
- Failures and (once Phase C lands) silent degradations surface on one ClickUp task
  the operator already watches, with push/email via ClickUp.
- The seam keeps channel choice cheap to change; severity is in every message
  (`INFO`/`WARN`/`CRITICAL`).
- **Follow-up:** alert execution links currently point to `localhost:5678`; set
  `N8N_EDITOR_BASE_URL=https://agents.haxe.ai` in the VPS `.env` to make them clickable.
- These workflows live in n8n now; export to `n8n/workflows/` is pending (Phase C).

Related: ADR-024 (LiteLLM/routing/cost — the pipeline being monitored), ADR-018
(built via the n8n MCP control plane), ADR-011 (stack/secrets).

> Update 2026-06-08 (proactive layer built). The Phase-C monitors now exist and are
> live: **FX freshness dead-man's-switch** (`FX Freshness Monitor (v1)`, daily; WARN if
> latest `fx_rates` row >4 days old — threshold tolerates NBP weekend/holiday gaps);
> and in-flow **degradation WARNs** through `Post Alert` — `routing-default-used`
> (real impact silently downgraded), `cost-missing` (no LiteLLM cost header),
> `agent_runs-insert-failed` (in Invoke Model), and `cost-sync-failed` (Agent Spine CU
> cost write). All fire on non-blocking side branches / `onError`, so the run still
> returns its result. The FX cron + both FX/monitor workflows set `errorWorkflow` =
> `Error Handler (v1)`. This convention is now mandatory project-wide (CLAUDE.md
> "Reliability & observability").
