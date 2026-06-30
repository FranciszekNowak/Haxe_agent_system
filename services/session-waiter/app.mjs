// Haxe session-waiter service (ADR-066 — external async managed-agent session waiter).
//
// WHY: today a managed-agent session is polled inside a SINGLE n8n Code node (Execute Agent Session ->
// Poll Round) bounded by an 840 s soft deadline under n8n's ~900 s per-node task-runner kill. A long
// task (the 2026-06-30 .pptx run: ~21 min) can therefore never be polled to completion inside one n8n
// execution — n8n abandons the still-running remote session and the real answer is never consumed. The
// agent session runs on Anthropic's side independently of n8n (proven: it kept working 7 min after n8n
// quit). The fix is to DECOUPLE the session's wall-clock from any single n8n execution: this always-on
// Node service holds the session, services client-side tools, and calls n8n back by webhook when the
// agent delivers. No node cap, no recursion-depth limit, arbitrarily long runs.
//
// SCOPE — BLOCK 4 (this): the SKELETON only.
//   * /health  — liveness for the n8n dead-man's-switch (Session Waiter Health Monitor pings it).
//   * /handoff — receives the orchestrator's carry-state (Block 5), PERSISTS a waiter_sessions row
//                (status 'handed_off'), returns 202. It does NOT yet drive the session — the event loop
//                (open SSE / long-poll GET /events dedup-by-id, service get_task_*/list_attachments/
//                get_attachment/extract_clickup_task by delegating to the n8n tail/extract handlers,
//                POST user.custom_tool_result, capture deliver_output, POST the finish callback) is
//                BLOCK 6. Persisting the row now is deliberate: it is exactly the store the freshness
//                reconciliation check watches, so the reliability seam is real and testable from day one
//                (a handoff that never finishes WILL trip the CRITICAL freshness alert — the seam guards
//                itself). Nothing calls /handoff in production yet: the orchestrator split (Block 5) is
//                gated behind config.session_waiter.enabled, which this migration seeds 'false'.
//   * structured JSON logging with secret REDACTION (the managed Anthropic key arrives in the handoff
//     body per A6 "handed at handoff"; it is NEVER logged and NEVER persisted — the waiter re-derives it
//     from public.get_anthropic_key() when it needs it in Block 6, so no credential lands in the DB/.env).
//   * the reused alert seam (Storage Watchdog Intake -> Post Alert (v1), ADR-025) for self-alerting.
//
// CONTRACT
//   GET  /health   -> 200 { ok:true, service, version, uptime_s, active_sessions } (always; liveness)
//   POST /handoff  -> 202 { ok:true, session_id, persisted:true, processed:false }   (skeleton: persist only)
//                  -> 400 { ok:false, error }   (bad contract)
//                  -> 500 { ok:false, error }   (persistence failure -> CRITICAL alert)
//     body: { session_id (req), clickup_task_id, triggering_comment_id, caller_user_id, agent_id,
//             model_id, surface, surface_ref, impact, deadline_at?|absolute_budget_ms?,
//             anthropic_key? (REDACTED, not stored), ...carry-state (stored as carry_state, key stripped) }
//
// Reads/writes Supabase (waiter_sessions, config) via REST with SUPABASE_SERVICE_KEY (service_role
// bypasses RLS). No ClickUp creds. Alerts ride the reused Storage Watchdog Intake (header-auth
// X-Watchdog-Key) -> Post Alert (v1) -> ClickUp Alerts task (the swappable seam; ADR-025). Mirrors
// services/queue-consumer (ADR-056) and services/zip-extractor (ADR-058).

import express from 'express';

const VERSION = '1.0.0-block4';
const STARTED_AT = Date.now();

const {
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
  ALERT_INTAKE_URL,
  ALERT_INTAKE_KEY,
  // n8n internal base for the finish callback + tail/extract tool handlers (Block 6/7). Non-secret
  // topology; set now so the container env is complete and forward-compatible.
  N8N_BASE_URL = 'http://n8n-main:5678',
  // Anthropic Sessions API surface (constants today; env-overridable for forward-compat). The event
  // loop (Block 6) uses these; baked now so the skeleton documents the full external dependency set.
  ANTHROPIC_API_BASE = 'https://api.anthropic.com',
  ANTHROPIC_VERSION = '2023-06-01',
  ANTHROPIC_BETA = 'managed-agents-2026-04-01,files-api-2025-04-14',
  PORT = '8080',
} = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('FATAL: SUPABASE_URL and SUPABASE_SERVICE_KEY are required');
  process.exit(1);
}
if (!ALERT_INTAKE_URL || !ALERT_INTAKE_KEY) {
  // Not fatal (the service can still run + persist), but a waiter that cannot alert is a silent-failure
  // surface — warn loudly at startup so the gap is visible.
  console.warn('[startup][WARN] ALERT_INTAKE_URL/ALERT_INTAKE_KEY not set — self-alerts will be dropped');
}

// ---- structured logging with secret redaction --------------------------------------------------
// Every line is one JSON object (mirrors queue-consumer). REDACT_KEYS are stripped from any logged
// object so a handoff body's managed key (and any future secret) never reaches stdout/your log store.
const REDACT_KEYS = new Set([
  'anthropic_key', 'managed_key', 'api_key', 'x-api-key', 'authorization', 'key', 'token', 'secret',
]);
function redact(obj) {
  if (Array.isArray(obj)) return obj.map(redact);
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = REDACT_KEYS.has(k.toLowerCase()) ? '[REDACTED]' : redact(v);
    }
    return out;
  }
  return obj;
}
function log(level, evt, fields = {}) {
  const line = { level, evt, ts: new Date().toISOString(), ...redact(fields) };
  (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(JSON.stringify(line));
}

// ---- Supabase REST helpers (service_role; bypasses RLS) ----------------------------------------
async function supabaseSelect(table, select, filter) {
  const url = `${SUPABASE_URL}/rest/v1/${table}?select=${encodeURIComponent(select)}${filter ? `&${filter}` : ''}`;
  const r = await fetch(url, {
    headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` },
  });
  if (!r.ok) throw new Error(`supabase select ${table} ${r.status}: ${await r.text().catch(() => '')}`);
  return r.json();
}

// Upsert a waiter_sessions row keyed on session_id (idempotent: a duplicate handoff for the same
// session merges, never errors — Block 6/7 finish callbacks are also idempotent on session_id).
async function upsertWaiterSession(row) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/waiter_sessions?on_conflict=session_id`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=representation',
    },
    body: JSON.stringify(row),
  });
  if (!r.ok) throw new Error(`supabase upsert waiter_sessions ${r.status}: ${await r.text().catch(() => '')}`);
  return r.json();
}

// ---- alert seam (reused Storage Watchdog Intake -> Post Alert (v1), ADR-025) -------------------
async function postAlert(severity, message, details, source = 'session-waiter') {
  if (!ALERT_INTAKE_URL || !ALERT_INTAKE_KEY) {
    log('warn', 'alert_dropped', { severity, message, reason: 'intake not configured' });
    return;
  }
  try {
    const r = await fetch(ALERT_INTAKE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Watchdog-Key': ALERT_INTAKE_KEY },
      body: JSON.stringify({
        severity, source, message,
        details: typeof details === 'string' ? details : JSON.stringify(details || {}),
      }),
    });
    if (!r.ok) log('error', 'alert_intake_non2xx', { http: r.status });
  } catch (e) {
    log('error', 'alert_post_failed', { err: e.message });
  }
}

// ---- in-memory liveness counters ---------------------------------------------------------------
// Skeleton: only handoff persistence increments this. Block 6 makes it the count of sessions the
// event loop is actively holding.
let activeSessions = 0;

// ---- HTTP surface ------------------------------------------------------------------------------
const app = express();
app.use(express.json({ limit: '1mb' })); // carry-state (file_map, image refs) can be larger than queue-consumer's

// Liveness for the n8n dead-man's-switch (Session Waiter Health Monitor pings this every N min; a
// down/unreachable waiter -> CRITICAL). Deliberately cheap: no DB round-trip on the hot ping path —
// a wedged Supabase must not make a live waiter look dead.
app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'session-waiter',
    version: VERSION,
    uptime_s: Math.round((Date.now() - STARTED_AT) / 1000),
    active_sessions: activeSessions,
  });
});

// Receive the orchestrator handoff (Block 5 wires to this). SKELETON: validate + persist the row +
// 202. The event loop is Block 6. The managed key (A6) arrives here, is used in-memory by Block 6,
// and is NEVER logged or persisted.
app.post('/handoff', async (req, res) => {
  const b = req.body || {};
  if (!b.session_id || typeof b.session_id !== 'string') {
    return res.status(400).json({ ok: false, error: 'session_id (string) is required' });
  }

  // Strip the managed key out of the carry-state before it is logged or stored. A6: the waiter
  // re-derives the key from public.get_anthropic_key() when the Block-6 loop needs it; storing it
  // would put a credential in the DB for no reason.
  const { anthropic_key, managed_key, api_key, ...carry } = b;

  // deadline_at: prefer an explicit absolute timestamp; else derive from absolute_budget_ms; else
  // leave null (the freshness check's stuck_after_minutes threshold still catches a never-finishing
  // handoff). Block 6 enforces the deadline as the session's own budget.
  let deadlineAt = null;
  if (b.deadline_at) {
    deadlineAt = b.deadline_at;
  } else if (Number.isFinite(Number(b.absolute_budget_ms))) {
    deadlineAt = new Date(Date.now() + Number(b.absolute_budget_ms)).toISOString();
  }

  const row = {
    session_id: b.session_id,
    clickup_task_id: b.clickup_task_id ?? null,
    triggering_comment_id: b.triggering_comment_id ?? null,
    caller_user_id: b.caller_user_id ?? null,
    agent_id: b.agent_id ?? null,
    model_id: b.model_id ?? null,
    surface: b.surface ?? null,
    surface_ref: b.surface_ref ?? null,
    impact: b.impact ?? null,
    status: 'handed_off',
    handed_off_at: new Date().toISOString(),
    last_event_at: new Date().toISOString(),
    deadline_at: deadlineAt,
    carry_state: carry, // key already stripped
  };

  try {
    await upsertWaiterSession(row);
    activeSessions += 1;
    log('info', 'handoff_persisted', {
      session_id: b.session_id, clickup_task_id: b.clickup_task_id, agent_id: b.agent_id,
      model_id: b.model_id, deadline_at: deadlineAt,
    });
    // Skeleton boundary: make it loud that processing is not yet wired, so a premature Block-5 cutover
    // (flag flipped before Block 6) is visible in the logs as well as caught by the freshness check.
    log('warn', 'handoff_processing_not_implemented', {
      session_id: b.session_id, note: 'Block 6 event loop not yet deployed — row will sit handed_off',
    });
    return res.status(202).json({ ok: true, session_id: b.session_id, persisted: true, processed: false });
  } catch (e) {
    log('error', 'handoff_persist_failed', { session_id: b.session_id, err: e.message });
    postAlert('CRITICAL',
      `session-waiter nie zapisał przekazania sesji (handoff) ${b.session_id}`,
      { session_id: b.session_id, clickup_task_id: b.clickup_task_id, error: e.message },
      'session-waiter/handoff',
    ).catch(() => {});
    return res.status(500).json({ ok: false, error: 'handoff persistence failed' });
  }
});

// ---- startup / shutdown ------------------------------------------------------------------------
const server = app.listen(Number(PORT), () => {
  log('info', 'listening', {
    port: Number(PORT), version: VERSION, n8n_base: N8N_BASE_URL,
    anthropic_api_base: ANTHROPIC_API_BASE, anthropic_beta: ANTHROPIC_BETA,
  });
});

// Surface a startup self-check to the Alerts channel so a crash-looping waiter is visible there too
// (the health monitor catches unreachability, but a one-line "I'm up" on boot is a cheap liveness mark).
log('info', 'startup', { service: 'session-waiter', version: VERSION });

function shutdown(signal) {
  log('info', 'shutdown', { signal });
  server.close(() => process.exit(0));
  // Hard stop if connections don't drain promptly.
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Never let an unexpected throw take the service down silently — log + alert, then exit so the
// container's restart:unless-stopped brings it back (and the health monitor catches the gap).
process.on('uncaughtException', (e) => {
  log('error', 'uncaught_exception', { err: e?.message, stack: e?.stack?.slice(0, 500) });
  postAlert('CRITICAL', 'session-waiter uncaughtException — proces zostanie zrestartowany',
    { error: e?.message }, 'session-waiter/crash').catch(() => {});
  setTimeout(() => process.exit(1), 500).unref();
});
process.on('unhandledRejection', (e) => {
  log('error', 'unhandled_rejection', { err: e?.message || String(e) });
});
