#!/usr/bin/env bash
# consumer-heartbeat-watchdog.sh — host-level dead-man's-switch for the queue-consumer (ADR-056 Block 5).
#
# Runs via a systemd timer ON THE VPS, deliberately OUTSIDE the queue-consumer container: a watchdog
# must not share the fate of the thing it watches. The queue-consumer SETs a Redis key
# (haxeq:consumer:heartbeat) with TTL = queue.heartbeat_stale_s, refreshing it every ~stale_s/3 s. If
# the consumer dies it stops refreshing and the key EXPIRES after stale_s — so staleness is encoded as
# the TTL and this watchdog only has to check the key's EXISTENCE (no clock math, one knob).
#
# On a breach it POSTs into the n8n "Storage Watchdog Intake (v1)" webhook (the same source-agnostic
# header-auth intake the disk-watchdog uses), which forwards to Post Alert (v1) -> ClickUp Alerts task.
#
# Secrets come from /opt/haxe-agents/watchdog.env (NOT committed; chmod 600) — REUSED from the
# disk-watchdog, no new secret:
#   WATCHDOG_URL=https://agents.skalus.com/webhook/storage-watchdog-7e06358ac257ad20
#   WATCHDOG_KEY=<value of the X-Watchdog-Key header-auth credential>
#   # optional override: REDIS_CONTAINER (default n8n-redis), HEARTBEAT_KEY
#
# Two distinct failure modes, both CRITICAL:
#   * Redis unreachable (docker exec / redis-cli failed)  -> the queue's backing store is down.
#   * key absent (redis up, key gone)                     -> the consumer stopped refreshing (dead/hung).
set -uo pipefail

ENVFILE="/opt/haxe-agents/watchdog.env"
LOG="/opt/haxe-agents/consumer-heartbeat.log"
[ -f "$ENVFILE" ] && . "$ENVFILE"

REDIS_CONTAINER="${REDIS_CONTAINER:-n8n-redis}"
HEARTBEAT_KEY="${HEARTBEAT_KEY:-haxeq:consumer:heartbeat}"
ts="$(date -Is)"

post_alert() {
  # $1 severity, $2 message, $3 details
  if [ -z "${WATCHDOG_URL:-}" ] || [ -z "${WATCHDOG_KEY:-}" ]; then
    echo "$ts ALERT-NOT-SENT(no watchdog.env) sev=$1 $2" >> "$LOG" 2>/dev/null || true
    return 1
  fi
  local payload
  payload="$(printf '{"severity":"%s","source":"queue-consumer/heartbeat","message":"%s","details":"%s"}' "$1" "$2" "$3")"
  if curl -fsS -m 20 -X POST "$WATCHDOG_URL" -H "X-Watchdog-Key: ${WATCHDOG_KEY}" -H "Content-Type: application/json" -d "$payload" >/dev/null 2>&1; then
    echo "$ts ALERTED sev=$1 $2" >> "$LOG" 2>/dev/null || true
  else
    echo "$ts ALERT-DELIVERY-FAILED sev=$1 $2 (n8n webhook unreachable)" >> "$LOG" 2>/dev/null || true
    return 1
  fi
}

# --- probe: does the heartbeat key exist? (redis-cli EXISTS prints 1 or 0) ---
exists="$(docker exec "$REDIS_CONTAINER" redis-cli EXISTS "$HEARTBEAT_KEY" 2>/dev/null | tr -dc '0-9')"
rc=$?

if [ "$rc" -ne 0 ] || [ -z "$exists" ]; then
  # docker exec / redis-cli itself failed -> Redis (queue backing store) unreachable.
  post_alert "CRITICAL" \
    "Redis kolejki (${REDIS_CONTAINER}) niedostepny — nie moge sprawdzic heartbeatu queue-consumera." \
    "Kontener ${REDIS_CONTAINER}: docker exec/redis-cli nie powiodlo sie. Sprawdz: docker ps; docker logs ${REDIS_CONTAINER}. Kolejka agentow jest wtedy wstrzymana."
  exit 1
fi

if [ "$exists" = "0" ]; then
  post_alert "CRITICAL" \
    "queue-consumer nie odswieza heartbeatu (klucz ${HEARTBEAT_KEY} wygasl) — proces prawdopodobnie martwy/zawieszony." \
    "Redis dziala, ale klucz heartbeatu wygasl (TTL = queue.heartbeat_stale_s). Sprawdz: docker ps | grep queue-consumer; docker logs queue-consumer. Kolejka nie jest przetwarzana do czasu wznowienia."
  exit 1
fi

# Healthy: log the stored timestamp for forensics, stay silent on the alert channel.
hb="$(docker exec "$REDIS_CONTAINER" redis-cli GET "$HEARTBEAT_KEY" 2>/dev/null | tr -d '\r\n')"
echo "$ts OK heartbeat=${hb:-present}" >> "$LOG" 2>/dev/null || true
exit 0
