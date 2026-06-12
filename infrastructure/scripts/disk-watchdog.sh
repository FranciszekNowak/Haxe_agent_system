#!/usr/bin/env bash
# disk-watchdog.sh — host-level dead-man's-switch for VPS disk + n8n execution DB (ADR-046).
#
# Runs via a systemd timer ON THE VPS, deliberately OUTSIDE n8n: a watchdog must not share the
# fate of the thing it watches. An n8n workflow watching n8n's own DB would die silently when n8n
# dies (e.g. disk full); this runs independently and measures the REAL root-disk % (which n8n cannot
# read — no Execute Command node). On a threshold breach it POSTs into the n8n "Storage Watchdog
# Intake (v1)" webhook, which forwards to Post Alert (v1) -> ClickUp Alerts task (the swappable seam).
#
# Secrets + tunables come from /opt/haxe-agents/watchdog.env (NOT committed; chmod 600):
#   WATCHDOG_URL=https://agents.haxe.ai/webhook/<path>
#   WATCHDOG_KEY=<value of the X-Watchdog-Key header-auth credential>
#   # optional overrides: WARN_PCT, CRIT_PCT, N8N_DB_WARN_GB
#
# Thresholds are deliberately conservative so the WARN fires while n8n is still healthy and able to
# deliver it — the one case this cannot escalate is n8n already fully down, which the early WARNs are
# designed to pre-empt (and that failure is logged loudly to watchdog.log as a last resort).
set -uo pipefail

ENVFILE="/opt/haxe-agents/watchdog.env"
LOG="/opt/haxe-agents/watchdog.log"
[ -f "$ENVFILE" ] && . "$ENVFILE"

WARN_PCT="${WARN_PCT:-60}"          # root-disk % -> WARN
CRIT_PCT="${CRIT_PCT:-75}"          # root-disk % -> CRITICAL
N8N_DB_WARN_GB="${N8N_DB_WARN_GB:-5}"  # secondary signal: n8n Postgres size
ts="$(date -Is)"

# --- measure (each probe guarded; a failed probe must never abort the alerting path) ---
disk_pct="$(df --output=pcent / 2>/dev/null | tail -1 | tr -dc '0-9')"; disk_pct="${disk_pct:-0}"
db_bytes="$(docker exec n8n-postgres psql -U n8n -d n8n -tAc "select pg_database_size('n8n')" 2>/dev/null | tr -dc '0-9')"; db_bytes="${db_bytes:-0}"
db_pretty="$(docker exec n8n-postgres psql -U n8n -d n8n -tAc "select pg_size_pretty(pg_database_size('n8n'))" 2>/dev/null | tr -d '\r\n ')"; db_pretty="${db_pretty:-unknown}"
execs="$(docker exec n8n-postgres psql -U n8n -d n8n -tAc "select count(*) from execution_entity" 2>/dev/null | tr -dc '0-9')"; execs="${execs:-0}"
db_gb=$(( db_bytes / 1073741824 ))

# --- decide severity (disk is the catastrophic metric; n8n DB size is the early base64 signal) ---
sev=""; reason=""
if   [ "$disk_pct" -ge "$CRIT_PCT" ]; then sev="CRITICAL"; reason="dysk ${disk_pct}% >= ${CRIT_PCT}%"
elif [ "$disk_pct" -ge "$WARN_PCT" ]; then sev="WARN";     reason="dysk ${disk_pct}% >= ${WARN_PCT}%"
elif [ "$db_gb"   -ge "$N8N_DB_WARN_GB" ]; then sev="WARN"; reason="baza n8n ${db_pretty} >= ${N8N_DB_WARN_GB} GB"
fi

if [ -z "$sev" ]; then
  echo "$ts OK disk=${disk_pct}% n8n_db=${db_pretty} execs=${execs}" >> "$LOG" 2>/dev/null || true
  exit 0
fi

msg="Magazyn VPS: ${reason}. Sprawdź dysk i pruning wykonań n8n."
details="disk_used=${disk_pct}%; n8n_db=${db_pretty}; n8n_executions=${execs}; progi=WARN${WARN_PCT}/CRIT${CRIT_PCT}; host=vps57524999"

if [ -z "${WATCHDOG_URL:-}" ] || [ -z "${WATCHDOG_KEY:-}" ]; then
  echo "$ts ALERT-NOT-SENT(no watchdog.env) sev=$sev $reason" >> "$LOG" 2>/dev/null || true
  exit 1
fi

payload="$(printf '{"severity":"%s","source":"infra/disk-watchdog","message":"%s","details":"%s"}' "$sev" "$msg" "$details")"
if curl -fsS -m 20 -X POST "$WATCHDOG_URL" -H "X-Watchdog-Key: ${WATCHDOG_KEY}" -H "Content-Type: application/json" -d "$payload" >/dev/null 2>&1; then
  echo "$ts ALERTED sev=$sev $reason" >> "$LOG" 2>/dev/null || true
else
  # The one case a host->n8n watchdog cannot escalate: n8n itself unreachable (the alert channel is
  # the thing that's down). Log loudly; the early thresholds exist precisely to fire before this.
  echo "$ts ALERT-DELIVERY-FAILED sev=$sev $reason (n8n webhook unreachable)" >> "$LOG" 2>/dev/null || true
  exit 1
fi
