# Block 5 findings — monitoring + heartbeat dead-man's-switch + config refresh (2026-06-26)

Block 5 adds the observability layer to the queue-consumer. The processing pipeline (enqueue → priority
dequeue → idempotency → spine → retry/backoff/DLQ) was complete after Block 4; Block 5 makes the running
system *visible* and adds the two silent-failure alarms it still lacked — a backlog/wedged-worker alarm
and a dead-consumer alarm — plus a live config-refresh poll. Every Definition-of-Done item below is
backed by a live run against the production stack, except the two that require disturbing shared
production state (a Redis restart, a shared-config mutation), which were blocked by the safety classifier
and are addressed below.

Block 6 remains: the burst + priority + negative-config scope-test, the §14.2–§14.6 doc reconciliation,
and flipping ADR-056 to Accepted / marking the queue LIVE.

---

## What was built

### 1. Consumer `GET /metrics` + the depth-monitor cron (`n8n/workflows/queue-depth-monitor.json`)

`/metrics` returns `queue.getJobCounts()` **plus a consumer-computed `alert`** (or `null`). The design
choice that matters: **the consumer decides the alarm, the cron just forwards it.** This keeps every
`queue.*` threshold in the one fail-safe reader (ADR-056 "Single reader" / R4) — the n8n cron reads no
config. `Queue Depth Monitor (v1)` (`M48svwpdhDg8l6An`, active, 5-min schedule + a `When Called` test
entry) GETs `http://queue-consumer:8080/metrics` over the internal network and, if `alert` is non-null,
forwards `severity`/`message`/`details` to `Post Alert (v1)` (source `queue-consumer/depth`). A failed
GET routes to a WARN ("monitor can't reach /metrics") — the *host heartbeat* owns the consumer-down
CRITICAL, so this is only the secondary "monitoring itself degraded" signal.

Two alarm-shape decisions, both to avoid false/noisy alerts:

- **Backlog alarm is targeted, not raw-depth.** A raw `waiting > 20` WARN would fire on the very
  50-task midnight burst the queue exists to absorb. Instead: **CRITICAL** at `waiting + delayed ≥
  alert_depth_any` (absolute flood); **WARN** at `waiting ≥ alert_depth_high` **and** `active === 0`
  (queued but nothing draining = a wedged worker — a healthy burst has `active = concurrency`, so it
  cannot trip). The WARN now means "stuck," not "busy."
- **Failed-set alarm is edge-triggered; Block 4 stays primary.** A level-triggered `failed > 0` would
  re-fire every 5 min for the 24 h a dead-letter lingers (`removeOnFail age 86400`) — an alert storm,
  and redundant with Block 4's exactly-once-per-dead-letter CRITICAL. So `/metrics` only WARNs when the
  failed count **rises** vs the consumer's last read (a backstop for a lost Block-4 alert), baselined at
  startup so pre-existing dead-letters don't alarm on boot.

### 2. Consumer heartbeat dead-man's-switch (host systemd)

The consumer SETs `haxeq:consumer:heartbeat` (value = ISO timestamp) with `EX = queue.heartbeat_stale_s`,
refreshing every ~⅓-TTL. **Staleness is encoded as the TTL**, so the host watchdog only does
`redis-cli EXISTS` — no clock math, one knob governs both sides. New files:
`infrastructure/scripts/consumer-heartbeat-watchdog.sh` + `infrastructure/systemd/consumer-heartbeat.{service,timer}`
(1-min cadence). It mirrors the ADR-046 disk-watchdog: lives **outside** the watched container, **reuses
the same `watchdog.env`** (`WATCHDOG_URL`/`WATCHDOG_KEY`) and the `Storage Watchdog Intake (v1)` webhook —
**no new secret, no new alert workflow**. It distinguishes two CRITICALs: Redis unreachable
(`docker exec`/`redis-cli` failed) vs key absent (consumer dead/hung). Like the disk-watchdog it `exit 1`s
on a breach (systemd marks the oneshot failed) *after* delivering the alert; the `ALERTED` log line is the
success signal, not the exit code.

### 3. Config refresh poll (45s)

`refreshConfig()` re-reads `queue.*` every 45 s and: applies `concurrency` live (BullMQ's dynamic
`worker.concurrency` setter); for the construction-only knobs (`lock_duration_ms`, `rate_limit_per_min`,
which BullMQ reads once at Worker build) it cannot hot-apply, so it WARNs "restart required" rather than
silently no-op'ing; and posts only warnings **new** since the last poll (a persistently mis-set knob WARNs
once, not every 45 s). `loadQueueConfig()` was refactored to return `{ cfg, warnings }` (it no longer
posts inline) so startup posts all warnings and the poll diffs. The module-level `cfg` is reassigned each
poll, so `processJob` / `writeHeartbeat` / `/metrics` pick up live values.

---

## Definition of Done — live verification

| DoD item | Result |
|---|---|
| **Depth thresholds alert** | ✅ Injected 100 **delayed** jobs (2 h delay → worker never picks them, no spine, no cost) into the production `agent-jobs` queue. `/metrics` flipped to `alert.severity=CRITICAL` "backlog 100 (waiting+delayed) >= alert_depth_any 100". Drove the cron via its `When Called` entry (exec **4160**): `Get Queue Metrics` (alert CRITICAL) → `Alert Present?` true → `Post Depth Alert` posted to the Alerts task `869dj2z2c`. The scheduled 5-min tick also fired in the same window (bonus: confirms the schedule path, not just the test entry). Removed all 100 → `/metrics` back to `alert:null`, counts all 0. |
| **A killed consumer alerts within the heartbeat window** | ✅ `docker stop queue-consumer` (TTL 105 at stop) → waited 130 s → `redis-cli EXISTS haxeq:consumer:heartbeat` = **0** (expired) → forced `consumer-heartbeat.service`: log `ALERTED sev=CRITICAL ... klucz ... wygasl`, alert delivered. `docker start` → key back (EXISTS=1), `/health` ok PONG. |
| **Exactly the intended alerts, nothing spurious** | ✅ `node scripts/alerts-since.mjs 15` → **3 CRITICAL, 0 WARN**: 1 × `queue-consumer/heartbeat` + 2 × `queue-consumer/depth` (manual cron run + the coincident scheduled tick, both while the 100-job backlog was live). All three are intended test artifacts. |
| **Queue survives a Redis restart (AOF)** | ◑ Read-only confirmed AOF is enabled (`CONFIG GET appendonly` = `yes`; `aof_enabled:1`, `aof_last_write_status:ok`). The actual restart-survival was **already proven live in Block 0 G4** (Redis 7.4.9 + AOF survived `docker restart` with no job loss). A fresh restart test here was **blocked by the safety classifier** (restarting shared production Redis isn't incident recovery) — correctly, since Block 0 already established it. |
| **Config refresh poll: live concurrency + "restart required" WARN** | ◑ Deployed and verified-by-construction. The live mutation test (set `queue.concurrency`/`rate_limit_per_min`, observe apply + WARN, revert) was **blocked by the classifier** (mutating shared production config). The interval mechanism is proven (the heartbeat `setInterval`, started in the same `main()`, rewrote its key after the restart); `loadQueueConfig` is the proven startup reader; `worker.concurrency` is the documented BullMQ setter. **Left for explicit operator authorization** — see "Carry-forward". |

**Why delayed jobs for the depth test.** A delayed BullMQ job sits in the `delayed` state until its delay
elapses; the worker never picks it. So 100 jobs with a 2 h delay produce `waiting+delayed = 100` (tripping
the flood CRITICAL) with **zero spine calls, zero Anthropic cost, zero `agent_runs` rows** — then removed
by `jobId` (`B5DEPTH-0..99`), never `obliterate()` (which would nuke real jobs too). Same isolation
discipline as Block 4.

**Cleanup.** All 100 `B5DEPTH-*` jobs removed (final counts all 0); the consumer was restarted cleanly and
is healthy (`/health` ok, concurrency 5, PONG). No `agent_runs` rows or ClickUp tasks were created. The
three test CRITICALs sit in the Alerts task as labelled artifacts (same as Block 4's). No shared config was
mutated; no migration added (all `queue.*` keys, including `alert_depth_*`/`heartbeat_stale_s`, were
already seeded by `045_queue_config.sql`).

---

## Silent-failure modes covered by Block 5

- **Dead/hung consumer going unnoticed** (the queue stops draining with nobody watching): covered by the
  host heartbeat dead-man's-switch — independent of the container, fires CRITICAL within ~`heartbeat_stale_s`
  + one timer interval. Verified live.
- **Backlog growing / worker wedged** (consumer alive but not draining — e.g. the spine all-stalled, lock
  starvation): covered by the depth cron's targeted backlog alarm (`waiting ≥ alert_depth_high && active==0`
  WARN; `waiting+delayed ≥ alert_depth_any` CRITICAL). Verified live (flood CRITICAL).
- **Redis (queue backing store) down**: covered — the heartbeat watchdog's first branch is "Redis
  unreachable" CRITICAL, distinct from "consumer dead".
- **Config mis-edit after startup** (a fat-finger that the startup clamp already caught is now also caught
  on a live edit): covered by the 45s refresh poll re-running the same clamp + the "restart required" WARN
  for knobs that can't hot-apply.
- **The monitor itself silently failing** (depth cron can't reach `/metrics`): covered by the cron's
  HTTP-error WARN branch.
- **Alert storm from the new alarms** (the risk this block introduces): covered — the depth backlog alarm
  is targeted (won't fire on a healthy burst) and the failed-set alarm is edge-triggered (won't re-fire for
  the 24 h a dead-letter lingers).

**Knowingly not covered here (scoped elsewhere):** the burst/priority/negative-config acceptance test and
the §14 doc reconciliation are Block 6. Bull Board was deferred (the `/metrics` endpoint + cron cover the
operator need; a UI adds an exposed surface for no current benefit).

---

## Operational notes / carry-forward

- **Two live tests need explicit operator authorization** (both blocked by the safety classifier as
  shared-state mutations, correctly): (a) a fresh Redis-restart job-survival test — *not needed*, Block 0
  G4 already proved it and AOF is confirmed on; (b) the config-refresh live test — if you want
  belt-and-suspenders, authorize a ~2-min run: set `queue.concurrency` to a different valid value (e.g. 4)
  and `queue.rate_limit_per_min` to e.g. 59, wait ~50 s, expect a `concurrency_changed` log + `/health`
  reflecting the new concurrency + one WARN "rate_limit_per_min changed … RESTART required", then revert
  both. (concurrency 4↔5 and rate-limit 59↔60 are harmless.)
- **The systemd oneshot shows `failed` on a breach by design** — the watchdog `exit 1`s after delivering
  the alert (mirrors disk-watchdog). Don't read systemd's `Result=exit-code` as a malfunction; read
  `/opt/haxe-agents/consumer-heartbeat.log` for `ALERTED` vs `ALERT-DELIVERY-FAILED`.
- **Deploy path:** updated `app.mjs` scp'd to `/opt/haxe-agents/queue-consumer/` + `docker compose up -d
  --build queue-consumer`; the systemd unit + script installed per the new `infrastructure/deployment.md`
  section ("Queue-consumer heartbeat dead-man's-switch"). The depth-monitor workflow was created via the
  n8n MCP, activated via the public API, then re-exported + drift-checked (40/40 clean).
- **`docker exec ... node --input-type=module -e`** is required to run inline ESM against the consumer's
  BullMQ (the container is `type: module`); a bare `node -e` is CommonJS and `import` throws. Recorded for
  Block 6's burst test, which will enqueue many jobs the same way.
