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
//   * BLOCK 6.1 — SSE-INCREMENTAL (primary): seeds once with GET /v1/sessions/{id}/events, then
//     accumulates from the SSE stream GET /v1/sessions/{id}/events/stream (full event objects with stable
//     `sevt_` ids — probe 6.1.0). Terminal/pending/idle are derived from the accumulated events
//     (session.status_* + deliver_output / client-tool detection, ported from Poll Round). Steady state
//     does NO full-log re-fetch; a GET /events DELTA (created_at[gte]=<cursor>, probe-verified) runs only
//     on (re)connect reconcile + a slow safety tick. On repeated SSE failure it DEGRADES to the long-poll
//     loop below (still correct), never hangs.
//   * LONG-POLL (fallback): re-fetches the FULL GET /v1/sessions/{id}/events each tick + GET
//     /v1/sessions/{id} (status). This is the Block 6 loop (ports Poll Round verbatim) — kept as the
//     proven, SSE-independent path (A1). Toggle with SSE_ENABLED=false to force it.
//   * terminal detection (ports Poll Round): deliver_output pending -> capture blocks, stop (delivered);
//     session error / status terminated -> terminated; agent replied after the last user turn with no
//     pending tool -> done; absolute-budget (deadline_at) exceeded -> deadline (non-delivery).
//   * client-tool servicing DELEGATES to the SSOT n8n handlers via the Session Waiter Tool Bridge webhook
//     (anti-duplication, ADR-066): a pending get_task_*/list_attachments/get_attachment/get_task_details/
//     extract_clickup_task -> POST the bridge -> POST user.custom_tool_result -> resume. generate_image
//     and clickup_* are in-harness MCP (ADR-055/054) and never reach the waiter. ANY pending tool is
//     always resolved (deadlock avoidance) — a bridge failure posts a fail-soft result, never hangs.
//   * on terminal, POSTs the finish callback (Block 7's Session Waiter Finish v1 consumes it: cost + doc
//     enumeration + render + post via the shared Publish Managed Result v1, idempotent on session_id). The
//     callback is header-authed (X-Watchdog-Key, shared key) — the finish webhook posts ClickUp comments +
//     flips status. The waiter only reports outcome + blocks + carry-state; it does NOT post to ClickUp.
//     Block 7's finish half must NOT re-fire front-half warning sources (Block 5 carry-forward).
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

const VERSION = '1.3.0-block7';
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
// Block 6.1 SSE tuning. SSE is primary; on repeated stream failure the driver degrades to the long-poll
// loop above. SSE_ENABLED=false forces the poll loop (operational rollback without a redeploy).
const SSE_ENABLED = (process.env.SSE_ENABLED || 'true').toLowerCase() !== 'false';
const SSE_SAFETY_MS = 45000;          // slow safety tick: a delta pull (NOT a full re-fetch) to backstop a missed wakeup
const SSE_RECONNECT_BASE_MS = 1000;   // exponential backoff base for stream reconnect
const MAX_SSE_RECONNECTS = 4;         // consecutive stream failures before falling back to the poll loop

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
  // ADR-054/066 silent-degrade guard: when the ClickUp MCP fails to CONNECT (as opposed to a clean
  // auth error, caught above), the harness does not surface an error event — it just DENIES each
  // clickup_* call ("Permission to use clickup_X has been denied", is_error tool_result). Without this
  // scan those denials are invisible: the agent loses all scoped ClickUp discovery/doc reading and the
  // run silently degrades to a worse (or empty) deliverable with no operator signal. Collect the denied
  // tool names so driveSession can raise ONE consolidated WARN (does not affect the main result path).
  const clickupToolDenied = [];
  for (const e of events) {
    if (e.type !== 'agent.tool_result') continue;
    const txt = Array.isArray(e.content) ? e.content.map((c) => (c && c.text) || '').join(' ') : '';
    const m = txt.match(/Permission to use (clickup_[A-Za-z0-9_]+) has been denied/);
    if (m) clickupToolDenied.push(m[1]);
  }
  const clickupToolDeniedUniq = [...new Set(clickupToolDenied)];
  let webSearchCount = 0;
  for (const e of events) { if (e.type === 'agent.tool_use' && e.name === 'web_search') webSearchCount++; }
  return { pending, agentRepliedAfter, lastAgentMsg, sessionError, clickupAuthError, clickupToolDenied: clickupToolDeniedUniq, webSearchCount };
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

// ---- event-map helpers (Block 6.1: accumulate from SSE, reconcile with a GET /events delta) ----------
// The DELTA fetch uses created_at[gte]=<cursor> (probe 6.1.0: the only event-cursor the API supports; it
// rejects ?after=). gte + dedup-by-id guarantees no misses at the timestamp boundary (the boundary event
// is re-fetched and dropped as already-seen). This is what avoids re-downloading the whole growing log.
async function fetchEventsSince(key, sessionId, cursor) {
  let url = `${ANTHROPIC_API_BASE}/v1/sessions/${sessionId}/events?limit=1000&order=asc`;
  if (cursor) url += `&created_at%5Bgte%5D=${encodeURIComponent(cursor)}`;
  const r = await fetch(url, { headers: anthropicHeaders(key) });
  if (!r.ok) throw new Error(`anthropic GET events delta ${r.status}`);
  const b = await r.json();
  return Array.isArray(b.data) ? b.data : [];
}
function mergeEvents(state, incoming, mode) {
  let added = 0;
  for (const e of incoming) {
    if (!e || !e.id || state.seen.has(e.id)) continue;
    state.seen.add(e.id);
    state.events.push(e);
    added += 1;
    if (e.processed_at && (!state.cursor || e.processed_at > state.cursor)) state.cursor = e.processed_at;
  }
  if (added && mode !== 'sse') log('info', 'events_fetch', { session_id: state.sessionId, mode, added, total: state.events.length });
  return added;
}
async function pullDelta(key, state, mode) {
  return mergeEvents(state, await fetchEventsSince(key, state.sessionId, state.cursor), mode);
}
// Chronological order for analyze()/status derivation. SSE + delta append mostly-ordered; sort defensively
// (stable; our just-posted user events have null processed_at and sort last, which is correct — latest action).
function orderedEvents(state) {
  return [...state.events].sort((a, b) => {
    const ka = a.processed_at || '￿', kb = b.processed_at || '￿';
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}
// Session status from the last top-level session.status_* event (SSE carries these explicitly, so we don't
// need GET /v1/sessions per tick — only once at terminal, for final usage/duration). thread-status ignored.
function deriveStatus(events) {
  let s = 'running';
  for (const e of events) {
    if (e.type === 'session.status_idle') s = 'idle';
    else if (e.type === 'session.status_running' || e.type === 'session.status_rescheduling') s = 'running';
    else if (e.type === 'session.status_terminated') s = 'terminated';
  }
  return s;
}
// Open the SSE stream; call onEvent(parsedEvent) per event frame. Resolves when the server closes the
// stream; rejects on network error / abort. Heartbeat/comment frames (": ...") are ignored (probe 6.1.0
// saw ": connected" at open; the stream stays open across idle with no periodic close).
async function consumeSse(key, sessionId, signal, onEvent) {
  const r = await fetch(`${ANTHROPIC_API_BASE}/v1/sessions/${sessionId}/events/stream`, { headers: anthropicHeaders(key), signal });
  if (!r.ok) throw new Error(`anthropic SSE ${r.status}`);
  const dec = new TextDecoder();
  let buf = '';
  for await (const chunk of r.body) {
    buf += dec.decode(chunk, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, idx); buf = buf.slice(idx + 2);
      if (!frame.trim() || frame.startsWith(':')) continue;
      const data = frame.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
      if (!data) continue;
      let o; try { o = JSON.parse(data); } catch { continue; }
      if (o && o.id) onEvent(o);
    }
  }
}
// Service a pending client tool via the n8n bridge, always returning a {content, warnings} shape — a bridge
// failure yields a fail-soft text result (so the caller ALWAYS resolves the tool; no session deadlock).
async function serviceToolSafe(key, handoff, tool) {
  try {
    return await serviceClientTool(handoff, tool);
  } catch (e) {
    log('warn', 'tool_bridge_failed', { session_id: handoff.session_id, tool: tool.name, err: e.message });
    return {
      content: [{ type: 'text', text: `Tool "${tool.name}" failed (${String(e.message).slice(0, 150)}). Proceed without it and inform the user if relevant.` }],
      warnings: [{ source: 'session-waiter/tool-bridge-failed', err: String(e.message).slice(0, 300), severity: 'WARN' }],
    };
  }
}

async function driveSession(handoff) {
  const sessionId = handoff.session_id;
  if (inFlight.has(sessionId)) { log('warn', 'already_driving', { session_id: sessionId }); return; }
  inFlight.add(sessionId);
  activeSessions = inFlight.size;

  const deadlineAt = handoff.deadline_at ? Date.parse(handoff.deadline_at) : (Date.now() + DEFAULT_BUDGET_MS);
  const finishUrl = handoff.finish_callback_url || '';

  try {
    const key = await getAnthropicKey();
    await patchWaiterSession(sessionId, { status: 'running', last_event_at: new Date().toISOString() });
    log('info', 'drive_start', { session_id: sessionId, clickup_task_id: handoff.clickup_task_id, deadline_at: new Date(deadlineAt).toISOString(), source: SSE_ENABLED ? 'sse' : 'poll' });

    // Primary = SSE-incremental; on repeated SSE failure it rejects and we fall back to the poll loop.
    let result = null;
    if (SSE_ENABLED) {
      result = await runSseLoop(key, handoff, deadlineAt).catch((e) => { log('warn', 'sse_loop_failed', { session_id: sessionId, err: e.message }); return null; });
      if (!result) log('warn', 'sse_fallback_to_poll', { session_id: sessionId });
    }
    if (!result) result = await runPollLoop(key, handoff, deadlineAt);

    const { outcome, picked, analysis, statusObj, warnings, toolRound } = result;
    const finalText = extractText(analysis ? analysis.lastAgentMsg : null);
    const output_blocks = (outcome === 'delivered') ? extractDeliverBlocks(picked) : [];
    const delivered_via_tool = (outcome === 'delivered');
    const rowStatus = (outcome === 'delivered' || outcome === 'done') ? 'delivered' : 'failed';

    await patchWaiterSession(sessionId, { status: rowStatus, outcome, finished_at: new Date().toISOString() });
    log('info', 'drive_terminal', { session_id: sessionId, outcome, tool_rounds: toolRound, blocks: output_blocks.length });

    // Silent-degrade guard (ADR-054/066): raise ONE consolidated WARN if the ClickUp MCP failed to
    // connect and its tools were denied at runtime. Side-channel only — the run still returns its result.
    const finalWarnings = Array.isArray(warnings) ? warnings.slice() : [];
    if (analysis && Array.isArray(analysis.clickupToolDenied) && analysis.clickupToolDenied.length) {
      finalWarnings.push({
        source: 'managed-agents/clickup-tool-denied',
        err: 'Narzedzia ClickUp odmowione w trakcie sesji (hostowany MCP nie polaczyl sie): ' + analysis.clickupToolDenied.join(', ') + '. Agent utracil zakresowane wyszukiwanie/odczyt ClickUp na tej sesji -> wynik moze byc gorszy lub niepelny. Prawdopodobny przejsciowy problem polaczenia z mcp.clickup.com albo token uzytkownika ' + (handoff.caller_user_id || '?') + '. Sprawdz ClickUp MCP Health Monitor; jesli powtarza sie u tego uzytkownika, przeloguj go (clickup-oauth-start).',
        severity: 'WARN',
      });
      log('warn', 'clickup_tools_denied', { session_id: sessionId, tools: analysis.clickupToolDenied });
    }

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
      warnings: finalWarnings,
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

// FALLBACK (Block 6): the long-poll loop. Re-fetches the FULL GET /events each tick + GET /sessions
// (status). Proven and SSE-independent (A1). Returns the terminal result object for driveSession to finish.
async function runPollLoop(key, handoff, deadlineAt) {
  const sessionId = handoff.session_id;
  let warnings = [], toolRound = 0, consecErr = 0;
  let outcome = null, picked = null, analysis = null, statusObj = {};
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
          const svc = await serviceToolSafe(key, handoff, tool);
          await postToolResult(key, sessionId, tool.id, svc.content); // ALWAYS resolve (deadlock avoidance)
          warnings = warnings.concat(Array.isArray(svc.warnings) ? svc.warnings : []);
          toolRound += 1;
          log('info', 'tool_serviced', { session_id: sessionId, tool: tool.name, round: toolRound, via: 'poll' });
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
  return { outcome, picked, analysis, statusObj, warnings, toolRound };
}

// PRIMARY (Block 6.1): SSE-incremental. Seed once with a full GET /events, then accumulate from the SSE
// stream (full event objects w/ stable ids). Terminal/pending/idle derived from the accumulated events
// (ports Poll Round's analyze() + idle gate). Steady state does NO full-log re-fetch; a GET /events delta
// runs only on (re)connect reconcile + a slow safety tick. Always resolves a pending tool. Resolves the
// terminal result; REJECTS to trigger the poll-loop fallback (seed failure, or MAX_SSE_RECONNECTS hit).
function runSseLoop(key, handoff, deadlineAt) {
  const sessionId = handoff.session_id;
  return new Promise((resolve, reject) => {
    const state = { sessionId, events: [], seen: new Set(), cursor: null };
    const servicedIds = new Set(); // tool ids already answered (immediate re-eval can race the result's propagation)
    let outcome = null, picked = null, analysis = null, statusObj = {}, warnings = [], toolRound = 0;
    let done = false, settled = false, evaluating = false, reEval = false, sseFailures = 0;
    let streamCtrl = null, safetyTimer = null, deadlineTimer = null;

    const settle = (fn) => {
      if (settled) return;
      settled = true;
      if (safetyTimer) clearInterval(safetyTimer);
      if (deadlineTimer) clearTimeout(deadlineTimer);
      try { if (streamCtrl) streamCtrl.abort(); } catch {}
      fn();
    };
    async function onTerminal() {
      try { statusObj = await getSession(key, sessionId); } catch (e) { log('warn', 'sse_final_status_err', { session_id: sessionId, err: e.message }); }
      settle(() => resolve({ outcome, picked, analysis, statusObj, warnings, toolRound }));
    }
    const fallback = (why) => settle(() => reject(new Error(why)));

    async function evaluateOnce() {
      if (done || settled) return;
      if (Date.now() >= deadlineAt) { outcome = 'deadline'; done = true; return; }
      const ordered = orderedEvents(state);
      analysis = analyze(ordered);
      const status = deriveStatus(ordered);
      if (analysis.sessionError) { outcome = 'terminated'; done = true; return; }
      if (status === 'terminated') { outcome = 'terminated'; done = true; return; }
      if (status === 'idle') {
        if (analysis.pending.length > 0) {
          const delivered = analysis.pending.find((e) => e.name === 'deliver_output');
          if (delivered) { outcome = 'delivered'; picked = delivered; done = true; return; }
          if (toolRound >= MAX_TOOL_ROUNDS) { outcome = 'max_rounds'; done = true; return; }
          const tool = analysis.pending[0];
          if (servicedIds.has(tool.id)) return; // already answered; wait for the result to propagate (next SSE wakeup)
          const svc = await serviceToolSafe(key, handoff, tool);
          await postToolResult(key, sessionId, tool.id, svc.content); // ALWAYS resolve (deadlock avoidance)
          servicedIds.add(tool.id);
          warnings = warnings.concat(Array.isArray(svc.warnings) ? svc.warnings : []);
          toolRound += 1;
          log('info', 'tool_serviced', { session_id: sessionId, tool: tool.name, round: toolRound, via: 'sse' });
          await pullDelta(key, state, 'post-tool').catch(() => {}); // reflect our own tool_result promptly
          reEval = true;
          return;
        }
        if (analysis.agentRepliedAfter) { outcome = 'done'; done = true; return; }
      }
    }
    // Serialized evaluate: coalesces concurrent SSE wakeups (mutex + re-run flag) so a tool is serviced once.
    async function evaluate() {
      if (settled) return;
      if (evaluating) { reEval = true; return; }
      evaluating = true;
      try { do { reEval = false; await evaluateOnce(); } while (reEval && !done && !settled); }
      catch (e) { log('warn', 'sse_evaluate_err', { session_id: sessionId, err: e.message }); }
      finally { evaluating = false; }
      if (done && !settled) await onTerminal();
      else if (!settled) patchWaiterSession(sessionId, { last_event_at: new Date().toISOString() }).catch(() => {});
    }

    function startStream() {
      const ctrl = new AbortController();
      streamCtrl = ctrl;
      consumeSse(key, sessionId, ctrl.signal, (o) => { mergeEvents(state, [o], 'sse'); evaluate(); })
        .then(() => { if (!settled && !done) { log('info', 'sse_closed_by_server', { session_id: sessionId }); scheduleReconnect(); } })
        .catch((e) => {
          if (settled || done || e.name === 'AbortError') return;
          sseFailures += 1;
          log('warn', 'sse_stream_error', { session_id: sessionId, consec: sseFailures, err: e.message });
          scheduleReconnect();
        });
    }
    function scheduleReconnect() {
      if (settled || done) return;
      if (sseFailures >= MAX_SSE_RECONNECTS) { fallback(`sse unavailable after ${sseFailures} reconnects`); return; }
      const backoff = Math.min(SSE_RECONNECT_BASE_MS * (2 ** sseFailures), 8000);
      setTimeout(async () => {
        if (settled || done) return;
        try { await pullDelta(key, state, 'reconcile'); await evaluate(); } // reconcile catches anything missed while disconnected
        catch (e) { log('warn', 'sse_reconcile_err', { session_id: sessionId, err: e.message }); }
        if (!settled && !done) startStream();
      }, backoff);
    }

    // Deadline hard stop (fires even if the stream is silent).
    deadlineTimer = setTimeout(async () => { if (!settled && !done) { outcome = 'deadline'; done = true; await onTerminal(); } }, Math.max(0, deadlineAt - Date.now()));
    // Slow safety tick: a DELTA pull (not a full re-fetch) to backstop a missed SSE wakeup / heartbeat gap.
    safetyTimer = setInterval(async () => {
      if (settled || done) return;
      try { await pullDelta(key, state, 'safety'); await evaluate(); }
      catch (e) { log('warn', 'sse_safety_err', { session_id: sessionId, err: e.message }); }
    }, SSE_SAFETY_MS);

    // Seed (one full GET /events — SSE has no replay), evaluate (maybe already terminal), then open SSE.
    (async () => {
      try {
        await sleep(1200);
        await pullDelta(key, state, 'seed');
        await evaluate();
        if (!settled && !done) startStream();
      } catch (e) { fallback(`sse seed failed: ${e.message}`); }
    })();
  });
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
      // Block 7: the finish webhook (Session Waiter Finish v1) is header-authed (n8n /webhook/* is public
      // via nginx and this posts ClickUp comments + flips status). Send the shared waiter<->n8n key, same
      // as the tool bridge. The finish half is idempotent on session_id, so a retry after a lost response
      // is a safe no-op (it returns 200 idempotent_skip).
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Watchdog-Key': ALERT_INTAKE_KEY || '' }, body: JSON.stringify(payload) });
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
