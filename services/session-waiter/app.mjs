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
// SCOPE — BLOCK 6 (this): the EVENT LOOP. /handoff persists the row (Block 4), returns 202, then drives
// the session in the background:
//   * re-derives the managed Anthropic key from public.get_anthropic_key() (A6 — the key is NOT in the
//     handoff body; Block 5 deliberately omits it so it never spreads into the orchestrator's logs).
//   * LONG-POLLS GET /v1/sessions/{id}/events (the source of truth, dedup-by-id implicit since the API
//     returns the full ordered log) + GET /v1/sessions/{id} (status). This ports Poll Round verbatim; SSE
//     is left as a future latency optimization (A1 says long-poll is the proven, n8n-independent fallback
//     and is far simpler than SSE reconnect/reconcile — the right call for a background batch agent).
//   * terminal detection (ports Poll Round): deliver_output pending -> capture blocks, stop (delivered);
//     session error / status terminated -> terminated; agent replied after the last user turn with no
//     pending tool -> done; absolute-budget (deadline_at) exceeded -> deadline (non-delivery).
//   * client-tool servicing DELEGATES to the SSOT n8n handlers via the Session Waiter Tool Bridge webhook
//     (anti-duplication, ADR-066): a pending get_task_*/list_attachments/get_attachment/get_task_details/
//     extract_clickup_task -> POST the bridge -> POST user.custom_tool_result -> resume. generate_image
//     and clickup_* are in-harness MCP (ADR-055/054) and never reach the waiter. ANY pending tool is
//     always resolved (deadlock avoidance) — a bridge failure posts a fail-soft result, never hangs.
//   * on terminal, POSTs the finish callback (Block 7 consumes it: cost + doc enumeration + render + post,
//     idempotent on session_id). The waiter only reports outcome + blocks + carry-state; it does NOT post
//     to ClickUp. Block 7's finish half must NOT re-fire front-half warning sources (Block 5 carry-forward).
//   * crash resilience: on startup, re-adopts any handed_off/running row (resumes driving it) so a waiter
//     restart mid-session recovers; a row past its deadline finishes immediately as non-delivery.
//
//   Still NOT a credential store: the managed key lives only in memory while a session is driven; it is
//   never logged (redaction) and never persisted (A6).
//
// CONTRACT
//   GET  /health   -> 200 { ok:true, service, version, uptime_s, active_sessions } (always; liveness)
//   POST /handoff  -> 202 { ok:true, session_id, persisted:true, processing:true }  (persist + drive async)
//                  -> 400 { ok:false, error }   (bad contract)
//                  -> 500 { ok:false, error }   (persistence failure -> CRITICAL alert)
//     body: { session_id (req), clickup_task_id, triggering_comment_id, caller_user_id, reviewer_user_id,
//             agent_id, model_id, surface, surface_ref, impact, clickup_scope, file_map_json,
//             finish_callback_url, deadline_at?|absolute_budget_ms?, ...carry-state }
//
// Reads/writes Supabase (waiter_sessions, RPC get_anthropic_key) via REST with SUPABASE_SERVICE_KEY
// (service_role bypasses RLS). Calls Anthropic Sessions API + the n8n tool bridge. Alerts ride the reused
// Storage Watchdog Intake (header-auth X-Watchdog-Key) -> Post Alert (v1) -> ClickUp Alerts task (ADR-025).
// Mirrors services/queue-consumer (ADR-056) and services/zip-extractor (ADR-058).

import express from 'express';

const VERSION = '1.1.0-block6';
const STARTED_AT = Date.now();

const {
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
  ALERT_INTAKE_URL,
  ALERT_INTAKE_KEY,
  // n8n internal base for the tool bridge + finish callback. Non-secret topology.
  N8N_BASE_URL = 'http://n8n-main:5678',
  // Anthropic Sessions API surface (env-overridable for forward-compat).
  ANTHROPIC_API_BASE = 'https://api.anthropic.com',
  ANTHROPIC_VERSION = '2023-06-01',
  ANTHROPIC_BETA = 'managed-agents-2026-04-01,files-api-2025-04-14',
  PORT = '8080',
} = process.env;

// The n8n client-tool bridge (ADR-066 Block 6) — wraps the SSOT tail/extract handlers. Authed with the
// shared waiter<->n8n key (X-Watchdog-Key = ALERT_INTAKE_KEY): n8n /webhook/* is public via nginx.
const BRIDGE_URL = `${N8N_BASE_URL}/webhook/session-waiter-tool-bridge`;

// Loop tuning (ports Poll Round). The absolute per-session budget is the real bound (deadline_at from the
// handoff); MAX_TOOL_ROUNDS is a runaway backstop (generous — tail/extract are cheap, image gen is MCP).
const POLL_INTERVAL_MS = 3000;
const MAX_TOOL_ROUNDS = 40;
const MAX_CONSEC_ERRORS = 5;
const DEFAULT_BUDGET_MS = 2_700_000; // 45 min — only used if a handoff carries no deadline/budget.
const FINISH_MAX_TRIES = 4;
const FINISH_RETRY_MS = 4000;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('FATAL: SUPABASE_URL and SUPABASE_SERVICE_KEY are required');
  process.exit(1);
}
if (!ALERT_INTAKE_URL || !ALERT_INTAKE_KEY) {
  console.warn('[startup][WARN] ALERT_INTAKE_URL/ALERT_INTAKE_KEY not set — self-alerts will be dropped');
}

// ---- structured logging with secret redaction --------------------------------------------------
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- Supabase REST helpers (service_role; bypasses RLS) ----------------------------------------
function sbHeaders(extra = {}) {
  return { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, ...extra };
}
async function supabaseSelect(table, select, filter) {
  const url = `${SUPABASE_URL}/rest/v1/${table}?select=${encodeURIComponent(select)}${filter ? `&${filter}` : ''}`;
  const r = await fetch(url, { headers: sbHeaders() });
  if (!r.ok) throw new Error(`supabase select ${table} ${r.status}: ${await r.text().catch(() => '')}`);
  return r.json();
}
async function upsertWaiterSession(row) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/waiter_sessions?on_conflict=session_id`, {
    method: 'POST',
    headers: sbHeaders({ 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=representation' }),
    body: JSON.stringify(row),
  });
  if (!r.ok) throw new Error(`supabase upsert waiter_sessions ${r.status}: ${await r.text().catch(() => '')}`);
  return r.json();
}
async function patchWaiterSession(sessionId, patch) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/waiter_sessions?session_id=eq.${encodeURIComponent(sessionId)}`, {
    method: 'PATCH',
    headers: sbHeaders({ 'Content-Type': 'application/json', Prefer: 'return=minimal' }),
    body: JSON.stringify(patch),
  });
  if (!r.ok) log('warn', 'waiter_session_patch_failed', { session_id: sessionId, http: r.status });
}
// A6: re-derive the managed key from public.get_anthropic_key() (SECURITY DEFINER, service_role EXECUTE).
async function getAnthropicKey() {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_anthropic_key`, {
    method: 'POST',
    headers: sbHeaders({ 'Content-Type': 'application/json' }),
    body: '{}',
  });
  if (!r.ok) throw new Error(`get_anthropic_key rpc ${r.status}: ${await r.text().catch(() => '')}`);
  const v = await r.json();
  const key = (typeof v === 'string' ? v : (v && (v.get_anthropic_key || v.key)) || '').toString().trim();
  if (!key) throw new Error('get_anthropic_key returned empty');
  return key;
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

// ---- Anthropic Sessions API helpers ------------------------------------------------------------
function anthropicHeaders(key) {
  return { 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION, 'anthropic-beta': ANTHROPIC_BETA };
}
async function getEvents(key, sessionId) {
  const r = await fetch(`${ANTHROPIC_API_BASE}/v1/sessions/${sessionId}/events`, { headers: anthropicHeaders(key) });
  if (!r.ok) throw new Error(`anthropic GET events ${r.status}`);
  const b = await r.json();
  return Array.isArray(b.data) ? b.data : [];
}
async function getSession(key, sessionId) {
  const r = await fetch(`${ANTHROPIC_API_BASE}/v1/sessions/${sessionId}`, { headers: anthropicHeaders(key) });
  if (!r.ok) throw new Error(`anthropic GET session ${r.status}`);
  return r.json();
}
async function postToolResult(key, sessionId, toolUseId, content) {
  const r = await fetch(`${ANTHROPIC_API_BASE}/v1/sessions/${sessionId}/events`, {
    method: 'POST',
    headers: { ...anthropicHeaders(key), 'Content-Type': 'application/json' },
    body: JSON.stringify({ events: [{ type: 'user.custom_tool_result', custom_tool_use_id: toolUseId, content }] }),
  });
  if (!r.ok) throw new Error(`anthropic POST tool_result ${r.status}: ${await r.text().catch(() => '')}`);
}

// ---- event analysis (ported verbatim from execute-agent-session "Poll Round") -------------------
function analyze(events) {
  let lastUserIdx = -1;
  for (let i = 0; i < events.length; i++) { const t = events[i].type; if (t === 'user.message' || t === 'user.custom_tool_result') lastUserIdx = i; }
  const answered = {};
  for (const e of events) { if (e.type === 'user.custom_tool_result' && e.custom_tool_use_id) answered[e.custom_tool_use_id] = true; }
  const pending = [];
  for (const e of events) { if (e.type === 'agent.custom_tool_use' && !answered[e.id]) pending.push(e); }
  let agentRepliedAfter = false, lastAgentMsg = null;
  for (let i = 0; i < events.length; i++) { if (events[i].type === 'agent.message') { lastAgentMsg = events[i]; if (i > lastUserIdx) agentRepliedAfter = true; } }
  let sessionError = null, clickupAuthError = null;
  for (const e of events) {
    const t = e.type || '';
    if (t === 'session.error' || (t.indexOf('error') >= 0 && e.error)) {
      const err = e.error || e;
      if (err && err.type === 'mcp_authentication_failed_error' && err.mcp_server_name === 'clickup') clickupAuthError = err;
      else sessionError = err;
    }
  }
  let webSearchCount = 0;
  for (const e of events) { if (e.type === 'agent.tool_use' && e.name === 'web_search') webSearchCount++; }
  return { pending, agentRepliedAfter, lastAgentMsg, sessionError, clickupAuthError, webSearchCount };
}
function extractText(msg) {
  if (!msg) return '';
  const c = msg.content || [];
  return c.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('');
}
function extractDeliverBlocks(picked) {
  if (!picked || !picked.input) return [];
  let b = (picked.input.blocks !== undefined) ? picked.input.blocks : picked.input;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { return []; } }
  return Array.isArray(b) ? b : [];
}

// ---- client-tool servicing via the n8n bridge (anti-duplication; SSOT handlers stay authoritative) --
async function serviceClientTool(handoff, pending) {
  const body = {
    tool_name: pending.name,
    clickup_task_id: handoff.clickup_task_id || '',
    tool_input_json: JSON.stringify(pending.input || {}),
    caller_user_id: handoff.caller_user_id || '',
    clickup_scope: handoff.clickup_scope || '',
  };
  const r = await fetch(BRIDGE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Watchdog-Key': ALERT_INTAKE_KEY || '' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`bridge ${r.status}: ${await r.text().catch(() => '')}`);
  const j = await r.json();
  let content; try { content = JSON.parse(j.tool_result_content_json); } catch (e) { content = null; }
  if (!Array.isArray(content) || content.length === 0) content = [{ type: 'text', text: 'Tool result unavailable. Proceed without it.' }];
  let warnings = []; try { warnings = JSON.parse(j.new_warnings_json || '[]'); } catch (e) {}
  return { content, warnings };
}

// ---- the driver: hold ONE session to terminal, then POST the finish callback --------------------
const inFlight = new Set();
let activeSessions = 0;

async function driveSession(handoff) {
  const sessionId = handoff.session_id;
  if (inFlight.has(sessionId)) { log('warn', 'already_driving', { session_id: sessionId }); return; }
  inFlight.add(sessionId);
  activeSessions = inFlight.size;

  const deadlineAt = handoff.deadline_at ? Date.parse(handoff.deadline_at) : (Date.now() + DEFAULT_BUDGET_MS);
  const finishUrl = handoff.finish_callback_url || '';
  let warnings = [];
  let toolRound = 0;
  let outcome = null, picked = null, analysis = null, statusObj = {};

  try {
    const key = await getAnthropicKey();
    await patchWaiterSession(sessionId, { status: 'running', last_event_at: new Date().toISOString() });
    log('info', 'drive_start', { session_id: sessionId, clickup_task_id: handoff.clickup_task_id, deadline_at: new Date(deadlineAt).toISOString() });

    let consecErr = 0;
    await sleep(1500);
    while (true) {
      if (Date.now() >= deadlineAt) { outcome = 'deadline'; break; }
      try {
        const events = await getEvents(key, sessionId);
        statusObj = await getSession(key, sessionId);
        consecErr = 0;
        analysis = analyze(events);
        await patchWaiterSession(sessionId, { last_event_at: new Date().toISOString() });
        const status = statusObj.status;
        if (analysis.sessionError) { outcome = 'terminated'; break; }
        if (status === 'terminated') { outcome = 'terminated'; break; }
        if (status === 'idle') {
          if (analysis.pending.length > 0) {
            const delivered = analysis.pending.find((e) => e.name === 'deliver_output');
            if (delivered) { outcome = 'delivered'; picked = delivered; break; }
            if (toolRound >= MAX_TOOL_ROUNDS) { outcome = 'max_rounds'; break; }
            const tool = analysis.pending[0];
            let svc;
            try {
              svc = await serviceClientTool(handoff, tool);
            } catch (e) {
              log('warn', 'tool_bridge_failed', { session_id: sessionId, tool: tool.name, err: e.message });
              svc = {
                content: [{ type: 'text', text: `Tool "${tool.name}" failed (${String(e.message).slice(0, 150)}). Proceed without it and inform the user if relevant.` }],
                warnings: [{ source: 'session-waiter/tool-bridge-failed', err: String(e.message).slice(0, 300), severity: 'WARN' }],
              };
            }
            // ALWAYS resolve the pending tool (deadlock avoidance), even on bridge failure.
            await postToolResult(key, sessionId, tool.id, svc.content);
            warnings = warnings.concat(Array.isArray(svc.warnings) ? svc.warnings : []);
            toolRound += 1;
            log('info', 'tool_serviced', { session_id: sessionId, tool: tool.name, round: toolRound });
            continue; // re-poll promptly
          }
          if (analysis.agentRepliedAfter) { outcome = 'done'; break; }
        }
      } catch (e) {
        consecErr += 1;
        log('warn', 'poll_error', { session_id: sessionId, consec: consecErr, err: e.message });
        if (consecErr >= MAX_CONSEC_ERRORS) { outcome = 'poll_error'; break; }
      }
      if (Date.now() >= deadlineAt) { outcome = 'deadline'; break; }
      await sleep(POLL_INTERVAL_MS);
    }

    const finalText = extractText(analysis ? analysis.lastAgentMsg : null);
    const output_blocks = (outcome === 'delivered') ? extractDeliverBlocks(picked) : [];
    const delivered_via_tool = (outcome === 'delivered');
    const rowStatus = (outcome === 'delivered' || outcome === 'done') ? 'delivered' : 'failed';

    await patchWaiterSession(sessionId, { status: rowStatus, outcome, finished_at: new Date().toISOString() });
    log('info', 'drive_terminal', { session_id: sessionId, outcome, tool_rounds: toolRound, blocks: output_blocks.length });

    const finishPayload = {
      session_id: sessionId,
      outcome,
      delivered_via_tool,
      output_blocks,
      final_message_text: finalText,
      web_search_count: analysis ? analysis.webSearchCount : 0,
      duration_seconds: (statusObj && statusObj.stats) ? statusObj.stats.duration_seconds : null,
      session_usage: (statusObj && statusObj.usage) ? statusObj.usage : {},
      terminated_error_json: (analysis && analysis.sessionError) ? JSON.stringify(analysis.sessionError).slice(0, 500) : '',
      clickup_auth_error_json: (analysis && analysis.clickupAuthError) ? JSON.stringify(analysis.clickupAuthError).slice(0, 500) : '',
      warnings,
      // carry-state for the finish callback (Block 7). Front-half warnings are already in `warnings`;
      // Block 7 must NOT re-fire front-half warning sources (Block 5 carry-forward).
      clickup_task_id: handoff.clickup_task_id || '',
      caller_user_id: handoff.caller_user_id || '',
      reviewer_user_id: handoff.reviewer_user_id || '',
      triggering_comment_id: handoff.triggering_comment_id || '',
      agent_id: handoff.agent_id || '',
      model_id: handoff.model_id || '',
      impact: handoff.impact || '',
      surface: handoff.surface || 'task',
      surface_ref: handoff.surface_ref || '',
      clickup_scope: handoff.clickup_scope || '',
      process_type: handoff.process_type || '',
      triggered_by: handoff.triggered_by || 'explicit_mention',
      invocation_type: handoff.invocation_type || 'explicit',
    };
    await postFinishCallback(finishUrl, finishPayload);
  } catch (e) {
    log('error', 'drive_failed', { session_id: sessionId, err: e.message, stack: e.stack?.slice(0, 400) });
    postAlert('CRITICAL', `session-waiter: błąd pętli sesji ${sessionId} — sesja mogła nie dostarczyć wyniku`,
      { session_id: sessionId, clickup_task_id: handoff.clickup_task_id, error: e.message }, 'session-waiter/drive').catch(() => {});
    await patchWaiterSession(sessionId, { status: 'failed', outcome: 'drive_error', finished_at: new Date().toISOString() }).catch(() => {});
  } finally {
    inFlight.delete(sessionId);
    activeSessions = inFlight.size;
  }
}

async function postFinishCallback(url, payload) {
  const sessionId = payload.session_id;
  if (!url) {
    log('error', 'finish_no_url', { session_id: sessionId });
    postAlert('CRITICAL', `session-waiter: brak finish_callback_url dla ${sessionId} — wynik agenta gotowy, ale nie ma gdzie go opublikować`,
      { session_id: sessionId, outcome: payload.outcome }, 'session-waiter/finish').catch(() => {});
    return;
  }
  for (let attempt = 1; attempt <= FINISH_MAX_TRIES; attempt++) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      if (r.ok) { log('info', 'finish_posted', { session_id: sessionId, outcome: payload.outcome, attempt }); return; }
      log('warn', 'finish_non2xx', { session_id: sessionId, http: r.status, attempt });
    } catch (e) {
      log('warn', 'finish_post_err', { session_id: sessionId, err: e.message, attempt });
    }
    if (attempt < FINISH_MAX_TRIES) await sleep(FINISH_RETRY_MS);
  }
  log('error', 'finish_failed', { session_id: sessionId, outcome: payload.outcome });
  postAlert('CRITICAL', `session-waiter: nie udało się wywołać finish callback dla ${sessionId} (wynik agenta gotowy, ale nie opublikowany)`,
    { session_id: sessionId, outcome: payload.outcome, finish_url: url }, 'session-waiter/finish').catch(() => {});
}

// Normalize a handoff (POST body) OR a re-adopted waiter_sessions row into the shape driveSession needs.
function handoffFromBody(b) {
  return {
    session_id: b.session_id,
    clickup_task_id: b.clickup_task_id ?? null,
    triggering_comment_id: b.triggering_comment_id ?? null,
    caller_user_id: b.caller_user_id ?? null,
    reviewer_user_id: b.reviewer_user_id ?? null,
    agent_id: b.agent_id ?? null,
    model_id: b.model_id ?? null,
    surface: b.surface ?? null,
    surface_ref: b.surface_ref ?? null,
    impact: b.impact ?? null,
    clickup_scope: b.clickup_scope ?? null,
    process_type: b.process_type ?? null,
    triggered_by: b.triggered_by ?? null,
    invocation_type: b.invocation_type ?? null,
    finish_callback_url: b.finish_callback_url ?? null,
    deadline_at: b.deadline_at ?? null,
  };
}

// ---- HTTP surface ------------------------------------------------------------------------------
const app = express();
app.use(express.json({ limit: '1mb' }));

// Cheap liveness for the n8n dead-man's-switch — no DB round-trip so a wedged Supabase can't make a live
// waiter look dead.
app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'session-waiter', version: VERSION, uptime_s: Math.round((Date.now() - STARTED_AT) / 1000), active_sessions: activeSessions });
});

// Receive the orchestrator handoff: validate -> persist the row -> 202 -> drive the session in the
// background (fire-and-forget). The managed key arrives NOT here (Block 5); the driver re-derives it.
app.post('/handoff', async (req, res) => {
  const b = req.body || {};
  if (!b.session_id || typeof b.session_id !== 'string') {
    return res.status(400).json({ ok: false, error: 'session_id (string) is required' });
  }
  // Strip any credential out before logging/storing (A6 — Block 5 should never send it, but defend anyway).
  const { anthropic_key, managed_key, api_key, ...carry } = b;

  let deadlineAt = null;
  if (b.deadline_at) deadlineAt = b.deadline_at;
  else if (Number.isFinite(Number(b.absolute_budget_ms))) deadlineAt = new Date(Date.now() + Number(b.absolute_budget_ms)).toISOString();

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
    carry_state: carry,
  };

  try {
    await upsertWaiterSession(row);
    log('info', 'handoff_persisted', { session_id: b.session_id, clickup_task_id: b.clickup_task_id, agent_id: b.agent_id, model_id: b.model_id, deadline_at: deadlineAt });
  } catch (e) {
    log('error', 'handoff_persist_failed', { session_id: b.session_id, err: e.message });
    postAlert('CRITICAL', `session-waiter nie zapisał przekazania sesji (handoff) ${b.session_id}`,
      { session_id: b.session_id, clickup_task_id: b.clickup_task_id, error: e.message }, 'session-waiter/handoff').catch(() => {});
    return res.status(500).json({ ok: false, error: 'handoff persistence failed' });
  }

  // Drive in the background; never block the 202. deadline_at is the persisted absolute budget.
  const handoff = handoffFromBody({ ...carry, deadline_at: deadlineAt });
  driveSession(handoff).catch((e) => log('error', 'drive_unhandled', { session_id: b.session_id, err: e.message }));
  return res.status(202).json({ ok: true, session_id: b.session_id, persisted: true, processing: true });
});

// ---- startup re-adoption (crash recovery) ------------------------------------------------------
// A waiter restart mid-session leaves rows handed_off/running with no in-memory driver. Re-adopt them so
// the session is driven to completion (the freshness monitor is the backstop if this misses one).
async function readoptInflightSessions() {
  try {
    const rows = await supabaseSelect(
      'waiter_sessions',
      'session_id,clickup_task_id,deadline_at,carry_state,status',
      'status=in.(handed_off,running)&order=handed_off_at.asc',
    );
    if (!rows.length) { log('info', 'readopt_none', {}); return; }
    log('info', 'readopt_found', { count: rows.length });
    for (const row of rows) {
      const carry = row.carry_state || {};
      const handoff = handoffFromBody({ ...carry, session_id: row.session_id, deadline_at: row.deadline_at });
      driveSession(handoff).catch((e) => log('error', 'readopt_drive_unhandled', { session_id: row.session_id, err: e.message }));
    }
  } catch (e) {
    log('error', 'readopt_failed', { err: e.message });
    postAlert('WARN', 'session-waiter: nie udało się wznowić sesji po restarcie (re-adoption)', { error: e.message }, 'session-waiter/readopt').catch(() => {});
  }
}

// ---- startup / shutdown ------------------------------------------------------------------------
const server = app.listen(Number(PORT), () => {
  log('info', 'listening', { port: Number(PORT), version: VERSION, n8n_base: N8N_BASE_URL, bridge_url: BRIDGE_URL, anthropic_api_base: ANTHROPIC_API_BASE });
  readoptInflightSessions();
});

log('info', 'startup', { service: 'session-waiter', version: VERSION });

function shutdown(signal) {
  log('info', 'shutdown', { signal, in_flight: inFlight.size });
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('uncaughtException', (e) => {
  log('error', 'uncaught_exception', { err: e?.message, stack: e?.stack?.slice(0, 500) });
  postAlert('CRITICAL', 'session-waiter uncaughtException — proces zostanie zrestartowany', { error: e?.message }, 'session-waiter/crash').catch(() => {});
  setTimeout(() => process.exit(1), 500).unref();
});
process.on('unhandledRejection', (e) => {
  log('error', 'unhandled_rejection', { err: e?.message || String(e) });
});
