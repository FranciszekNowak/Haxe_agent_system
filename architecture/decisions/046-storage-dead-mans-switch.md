# ADR-046: Storage dead-man's-switch (VPS disk + n8n execution DB)

## Context

ADR-036 Block 10 made generated images travel as **base64 in n8n execution data** (in-memory
delivery — `Execute Command` and file-delete are unavailable on this n8n, so disk staging was
impossible). n8n persists each node's input/output, so image runs now write multi-MB rows into
n8n's Postgres on the VPS. We tightened execution pruning to 7 days / 5000 executions
(`EXECUTIONS_DATA_MAX_AGE=168`, `EXECUTIONS_DATA_PRUNE_MAX_COUNT=5000`) to bound that growth.

But pruning is a **silent** mechanism: if it stalls, or anything else fills the single 100 GB VPS
disk (shared by n8n, its Postgres, Redis, LiteLLM, Docling, Docker images, logs), nothing alerts —
the first symptom would be n8n unable to write and the whole agent system down. The reliability
mandate ("what breaks *without* throwing?") requires a proactive guard.

Two constraints shape the design:
1. **n8n cannot read the real disk** — there is no `Execute Command` node (and the Code sandbox
   blocks builtins). An n8n workflow can at best query its own DB size.
2. **A dead-man's-switch must not share the fate of what it watches.** An n8n workflow watching
   n8n's own storage dies silently exactly when storage kills n8n. The watcher must be external.

## Decision

A **host-level systemd timer** on the VPS is the watcher; n8n is only the alert *transport*.

- **`/opt/haxe-agents/disk-watchdog.sh`** (committed at `infrastructure/scripts/disk-watchdog.sh`),
  fired every 6 h by **`disk-watchdog.timer`** (units committed at `infrastructure/systemd/`). It
  measures the **real root-disk %** (`df`) and the **n8n Postgres size**
  (`docker exec n8n-postgres psql … pg_database_size('n8n')` — local trust auth, no password needed)
  plus the execution count. Severity: **CRITICAL ≥ 75 % disk**, **WARN ≥ 60 % disk**, and a secondary
  **WARN if the n8n DB ≥ 5 GB** (the early base64 signal). Thresholds are conservative on purpose so
  the alert fires while n8n is still healthy enough to deliver it.
- On breach it POSTs `{severity, source:'infra/disk-watchdog', message, details}` to a thin n8n
  workflow **`Storage Watchdog Intake (v1)`** (`iMJrbyPD7UroQZ1W`): a header-auth webhook →
  `Call Post Alert` → ClickUp Alerts task. This keeps every alert flowing through the **swappable
  Post Alert seam** (ADR-025) rather than the host posting to ClickUp directly.
- **Secrets stay off git.** The webhook URL + header key live in `/opt/haxe-agents/watchdog.env`
  (chmod 600, not committed); the committed script sources it. The webhook is gated by an n8n
  **Header Auth credential** ("Storage Watchdog Header Auth", `3ydBksESwiUW2rFV`, header
  `X-Watchdog-Key`); missing/wrong key → 403 (verified). The webhook path is also random/unguessable.
- The host script **logs every run** to `/opt/haxe-agents/watchdog.log` (OK lines included), and on
  alert-delivery failure logs `ALERT-DELIVERY-FAILED` loudly.

Rejected: an n8n-internal cron watching `pg_database_size('n8n')`. Simpler and version-controlled,
but it is *not* a dead-man's-switch (dies with n8n) and cannot read the real disk — it would give
false comfort. Rejected for now: a direct-ClickUp fallback when n8n is unreachable (would require a
ClickUp token on the host); the early WARN/CRITICAL thresholds are the mitigation instead.

## Consequences

- The catastrophic failure mode (disk fills → n8n down, silently) now has an early, escalating
  alert through the standard channel, independent of n8n's own scheduler.
- **Residual gap (documented):** the one case this cannot escalate is n8n *already fully down* — the
  alert transport is the thing that's broken. The conservative thresholds exist to fire well before
  that point (60 % disk leaves ~40 GB of runway at current sizing). The failure is logged locally.
  A future hardening could add an out-of-band channel (host-side email or a direct ClickUp post) for
  the n8n-down case, and a heartbeat so a missing watchdog run is itself noticed ("who watches the
  watchdog").
- New moving parts on the VPS (script, two systemd units, a secrets env) — committed to the repo
  (except the secrets file) and documented in `infrastructure/deployment.md`. Deploy via scp +
  `systemctl enable --now disk-watchdog.timer`.
- Verified live (2026-06-12): normal run logs OK (disk 21 %, n8n DB 74 MB); a forced-threshold run
  delivered a `[WARN] infra/disk-watchdog` to the Alerts task via Post Alert (intake exec success);
  unauthenticated/wrong-key POSTs return 403; timer scheduled (next +6 h).

## Date

2026-06-12
