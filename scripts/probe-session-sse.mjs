// probe-session-sse.mjs — live probe of the Anthropic Managed-Agents Sessions API event surface.
//
// PURPOSE (ADR-066 Block 6.1.0 tool). Verifies the mechanics the session-waiter's SSE driver depends on,
// against a REAL session, so we never trust the docs blind:
//   (a) GET /v1/sessions/{id}/events cursor/pagination — which query params the API accepts (it rejects
//       ?after=; the only event cursor is created_at[gte]=<processed_at>);
//   (b) GET /v1/sessions/{id}/events/stream — that SSE delivers FULL event objects with stable sevt_ ids,
//       the heartbeat/comment cadence, and whether the server closes the stream when the session goes idle;
//   (c) that a pending client tool RESOLVES across a forced mid-stream drop (drop stream -> reopen -> POST
//       user.custom_tool_result -> session resumes) — the invariant scheduleReconnect / readopt rely on.
// It also doubles as the A2 "does an idle session stay queryable" check (events remain retrievable after
// delivery). The probe is fully self-contained: it creates its own throwaway environment + agent (one custom
// tool) + session, drives one tool round + a drop/reconnect, then DELETES/archives everything it made.
//
// The managed Anthropic key is fetched via public.get_anthropic_key() and is NEVER printed (A6).
//
// USAGE (run on the VPS so the key stays in-process; needs egress to api.anthropic.com + Supabase):
//   scp scripts/probe-session-sse.mjs franciszek@185.25.149.174:/tmp/probe-session-sse.mjs
//   ssh franciszek@185.25.149.174 "docker run --rm --network haxe-agents_n8n-internal \
//       --env-file /opt/haxe-agents/.env -v /tmp/probe-session-sse.mjs:/probe.mjs:ro \
//       node:20-alpine node /probe.mjs"
//   ssh franciszek@185.25.149.174 "rm -f /tmp/probe-session-sse.mjs"
// Requires env: SUPABASE_URL, SUPABASE_SERVICE_KEY (both already in /opt/haxe-agents/.env). Optional
// overrides: ANTHROPIC_API_BASE, ANTHROPIC_BETA, PROBE_MODEL (default claude-haiku-4-5).

const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
const API = process.env.ANTHROPIC_API_BASE || 'https://api.anthropic.com';
const BETA = process.env.ANTHROPIC_BETA || 'managed-agents-2026-04-01,files-api-2025-04-14';
const MODEL = process.env.PROBE_MODEL || 'claude-haiku-4-5';
const now = () => new Date().toISOString().slice(11, 23);
const log = (...a) => console.log(now(), ...a);

function H(key) { return { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-beta': BETA }; }

async function getKey() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY are required');
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_anthropic_key`, {
    method: 'POST',
    headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (!r.ok) throw new Error(`get_anthropic_key ${r.status}`);
  const v = await r.json();
  const key = (typeof v === 'string' ? v : (v && (v.get_anthropic_key || v.key)) || '').toString().trim();
  if (!key) throw new Error('empty key');
  return key;
}

async function jpost(key, path, body) {
  const r = await fetch(`${API}${path}`, { method: 'POST', headers: { ...H(key), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const t = await r.text();
  if (!r.ok) throw new Error(`POST ${path} ${r.status}: ${t.slice(0, 300)}`);
  return t ? JSON.parse(t) : {};
}
async function jget(key, path) {
  const r = await fetch(`${API}${path}`, { headers: H(key) });
  const t = await r.text();
  if (!r.ok) throw new Error(`GET ${path} ${r.status}: ${t.slice(0, 300)}`);
  return t ? JSON.parse(t) : {};
}

// Open the SSE stream and invoke onEvent(evt) for each parsed event; logs raw non-data frames (heartbeats).
function openStream(key, sessionId, label, onEvent) {
  const ctrl = new AbortController();
  (async () => {
    try {
      const r = await fetch(`${API}/v1/sessions/${sessionId}/events/stream`, { headers: H(key), signal: ctrl.signal });
      log(`[${label}] stream opened http=${r.status}`);
      const dec = new TextDecoder();
      let buf = '';
      for await (const chunk of r.body) {
        buf += dec.decode(chunk, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, idx); buf = buf.slice(idx + 2);
          if (!frame.trim()) continue;
          if (frame.startsWith(':')) { log(`[${label}] HEARTBEAT/comment: ${JSON.stringify(frame)}`); continue; }
          const dataLines = frame.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim());
          const evLine = frame.split('\n').find((l) => l.startsWith('event:'));
          const evName = evLine ? evLine.slice(6).trim() : '(none)';
          const data = dataLines.join('');
          let obj = null; try { obj = JSON.parse(data); } catch {}
          if (obj) onEvent(obj, evName, label);
          else log(`[${label}] non-json frame ev=${evName} data=${JSON.stringify(data).slice(0, 120)}`);
        }
      }
      log(`[${label}] stream CLOSED by server`);
    } catch (e) {
      if (e.name === 'AbortError') log(`[${label}] stream aborted by probe`);
      else log(`[${label}] stream error: ${e.message}`);
    }
  })();
  return { abort: () => ctrl.abort() };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let ENV_ID, AGENT_ID, SESSION_ID, KEY;

async function cleanup() {
  try { if (SESSION_ID) { await fetch(`${API}/v1/sessions/${SESSION_ID}`, { method: 'DELETE', headers: H(KEY) }); log('cleanup: session deleted'); } } catch (e) { log('cleanup session err', e.message); }
  try { if (AGENT_ID) { await jpost(KEY, `/v1/agents/${AGENT_ID}/archive`, {}); log('cleanup: agent archived'); } } catch (e) { log('cleanup agent err', e.message); }
  try { if (ENV_ID) { await fetch(`${API}/v1/environments/${ENV_ID}`, { method: 'DELETE', headers: H(KEY) }); log('cleanup: env deleted'); } } catch (e) { log('cleanup env err', e.message); }
}

async function main() {
  KEY = await getKey();
  log('key fetched (not printed)');

  const env = await jpost(KEY, '/v1/environments', { name: `probe-sse-${Date.now()}`, config: { type: 'cloud', networking: { type: 'unrestricted' } } });
  ENV_ID = env.id; log('env', ENV_ID);

  const agent = await jpost(KEY, '/v1/agents', {
    name: `probe-sse-${Date.now()}`, model: MODEL,
    system: 'You are a probe. Follow instructions literally and tersely.',
    tools: [{ type: 'custom', name: 'probe_tool', description: 'Test tool. Returns a value.', input_schema: { type: 'object', properties: { n: { type: 'integer' } }, required: ['n'] } }],
  });
  AGENT_ID = agent.id; log('agent', AGENT_ID, 'v', agent.version);

  const session = await jpost(KEY, '/v1/sessions', { agent: { type: 'agent', id: AGENT_ID, version: agent.version }, environment_id: ENV_ID });
  SESSION_ID = session.id; log('session', SESSION_ID, 'status', session.status);

  // ---- Phase 1: stream-first, then send a message that forces one custom-tool call ----
  let pendingToolId = null;
  const onEvA = (o, ev) => {
    const tag = o.type || ev;
    log(`[A] evt type=${tag} id=${o.id || '-'} processed_at=${o.processed_at ?? 'null'}`);
    if (o.type === 'agent.custom_tool_use') { pendingToolId = o.id; log(`[A]   -> custom_tool_use name=${o.name} input=${JSON.stringify(o.input)}`); }
    if (o.type === 'session.status_idle') log(`[A]   -> idle stop_reason=${JSON.stringify(o.stop_reason)}`);
  };
  const streamA = openStream(KEY, SESSION_ID, 'A', onEvA);
  await sleep(1200); // let the stream attach before sending
  await jpost(KEY, `/v1/sessions/${SESSION_ID}/events`, { events: [{ type: 'user.message', content: [{ type: 'text', text: 'Call the probe_tool tool exactly once with n=1. After you receive the tool result, reply with exactly the word DONE and nothing else.' }] }] });
  log('sent kickoff user.message');

  for (let i = 0; i < 40 && !pendingToolId; i++) await sleep(1000);
  if (!pendingToolId) { log('!! no pending tool appeared in 40s — aborting probe'); streamA.abort(); await cleanup(); return; }
  log(`pending tool captured id=${pendingToolId}; DROPPING stream A without answering (simulated mid-tool drop)`);
  streamA.abort();
  await sleep(2500);

  // ---- Phase 2: reconnect. GET /events (truth), inspect pagination envelope, confirm tool still pending ----
  const full = await jget(KEY, `/v1/sessions/${SESSION_ID}/events`);
  log(`GET /events envelope keys: ${JSON.stringify(Object.keys(full))}`);
  const arr = Array.isArray(full.data) ? full.data : [];
  log(`GET /events returned ${arr.length} events; has_more=${full.has_more} first_id=${full.first_id} last_id=${full.last_id} next_page=${full.next_page}`);
  const answered = new Set(arr.filter((e) => e.type === 'user.custom_tool_result').map((e) => e.custom_tool_use_id));
  log(`tool ${pendingToolId} answered-in-log? ${answered.has(pendingToolId)} (expect false)`);

  // pagination param probes (documents which cursors the API accepts)
  for (const q of [`?limit=3`, `?after=${pendingToolId}`, `?starting_after=${pendingToolId}`, `?order=desc`]) {
    try { const p = await jget(KEY, `/v1/sessions/${SESSION_ID}/events${q}`); const n = Array.isArray(p.data) ? p.data.length : '?'; log(`param ${q} -> ${n} events, keys=${JSON.stringify(Object.keys(p))}`); }
    catch (e) { log(`param ${q} -> ERROR ${e.message}`); }
  }

  // ---- Phase 3: open stream B, then POST the tool result; confirm session resumes over B (no replay) ----
  let sawDone = false, sawIdleEnd = false;
  const streamB = openStream(KEY, SESSION_ID, 'B', (o, ev) => {
    const tag = o.type || ev;
    log(`[B] evt type=${tag} id=${o.id || '-'}`);
    if (o.type === 'agent.message') { const txt = (o.content || []).filter((b) => b.type === 'text').map((b) => b.text).join(''); log(`[B]   -> agent.message text=${JSON.stringify(txt).slice(0, 60)}`); if (/DONE/.test(txt)) sawDone = true; }
    if (o.type === 'session.status_idle') { log(`[B]   -> idle stop_reason=${JSON.stringify(o.stop_reason)}`); if (o.stop_reason && o.stop_reason.type === 'end_turn') sawIdleEnd = true; }
  });
  await sleep(1200);
  await jpost(KEY, `/v1/sessions/${SESSION_ID}/events`, { events: [{ type: 'user.custom_tool_result', custom_tool_use_id: pendingToolId, content: [{ type: 'text', text: 'probe-result-42' }] }] });
  log('POSTed user.custom_tool_result after reconnect');

  for (let i = 0; i < 30 && !(sawDone && sawIdleEnd); i++) await sleep(1000);
  log(`RECONNECT RESULT: resumed_and_delivered_DONE=${sawDone} idle_end_turn=${sawIdleEnd}`);

  // ---- Phase 4: hold stream B idle ~20s to observe heartbeat cadence / whether server closes on idle ----
  log('holding stream B idle ~20s to observe heartbeat/idle-close behaviour...');
  await sleep(20000);
  streamB.abort();

  await cleanup();
  log('PROBE DONE');
}

main().catch(async (e) => { log('FATAL', e.message); await cleanup(); process.exit(1); });
