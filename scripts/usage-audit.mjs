#!/usr/bin/env node
// usage-audit.mjs — tally in-harness tool/skill usage across real managed-agent sessions.
//
// Why this exists: the managed lane runs tools and skills INSIDE the Anthropic harness
// (clickup_* MCP discovery, generate_image, web_search, bash/code-exec, the docx/xlsx/pptx/pdf
// skills, and our custom tail tools). That usage is NOT visible in n8n — the poll loop only
// surfaces the one pending CLIENT-side tool per round. The authoritative record is the Anthropic
// session event stream (agent.custom_tool_use / agent.mcp_tool_use / agent.server_tool_use /
// skill events). This script crawls those events for recent sessions and prints a usage
// histogram — the evidence you need before trimming a tool from the agent (ADR-061 follow-up),
// or to re-measure the prefix's composition after a change.
//
// Credential handling: the Anthropic key is NEVER passed in or printed. It is read IN-PROCESS
// from a recent Execute Agent Session execution's data (the same place n8n keeps it) and used
// only to call the read-only events API. Session ids are likewise harvested from execution data.
//
// Usage:
//   node scripts/usage-audit.mjs [execScanLimit]      (default 80 executions scanned)
//   env: N8N_API_KEY (required), N8N_API_URL (default https://agents.haxe.ai/api/v1)
//
// Output: per-session tool list + a global tool-use histogram + skill-event tally. A tool that
// shows 0 uses across a representative window is a candidate for removal from the agent's
// allowlist (Build System in sync-agent-definitions.json) — confirm the sample is representative
// of the real task mix first (a capability unused in the window may still serve a rare task type).

const N8N = process.env.N8N_API_KEY;
if (!N8N) { console.error('FATAL: N8N_API_KEY not set'); process.exit(2); }
const N8N_BASE = process.env.N8N_API_URL || 'https://agents.haxe.ai/api/v1';
const SESSION_WF = 'Rtb1cZbmUqmfGD98'; // Execute Agent Session (v1) — holds session_id + the key per run
const SCAN = Number(process.argv[2]) || 80;
const H8 = { 'X-N8N-API-KEY': N8N };

const j = async (u, o = {}) => { const r = await fetch(u, { ...o, headers: { ...H8, ...(o.headers || {}) } }); if (!r.ok) throw new Error(`${r.status} ${u} ${(await r.text()).slice(0, 200)}`); return r.json(); };

// walk any nested object collecting first-seen string values for the given keys
function harvest(obj, keys, out) {
  if (!obj || typeof obj !== 'object') return;
  for (const k of Object.keys(obj)) {
    if (keys.includes(k) && typeof obj[k] === 'string' && obj[k] && !(k in out)) out[k] = obj[k];
    if (typeof obj[k] === 'object') harvest(obj[k], keys, out);
  }
}

console.log(`Scanning up to ${SCAN} recent session executions…`);
const list = await j(`${N8N_BASE}/executions?workflowId=${SESSION_WF}&limit=${SCAN}`);
const execIds = (list.data || []).map((e) => e.id);

const sessions = new Map(); // session_id -> { task, caller, execIds:[] }
let ANTH = null;
for (const id of execIds) {
  let ex; try { ex = await j(`${N8N_BASE}/executions/${id}?includeData=true`); } catch { continue; }
  const out = {};
  harvest(ex.data, ['session_id', 'anthropic_key', 'clickup_task_id', 'caller_user_id'], out);
  if (out.anthropic_key && !ANTH) ANTH = out.anthropic_key; // held in-process only; never printed
  if (out.session_id) {
    if (!sessions.has(out.session_id)) sessions.set(out.session_id, { task: out.clickup_task_id, caller: out.caller_user_id, execIds: [] });
    sessions.get(out.session_id).execIds.push(id);
  }
}
console.log(`  ${execIds.length} executions → ${sessions.size} distinct sessions; key ${ANTH ? 'acquired (hidden)' : 'NOT FOUND'}`);
if (!ANTH) { console.error('FATAL: could not read the Anthropic key from execution data'); process.exit(1); }

const HA = { 'x-api-key': ANTH, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'managed-agents-2026-04-01,files-api-2025-04-14' };
async function events(sid) {
  const seen = new Map(); let cursor = null, pages = 0;
  while (pages++ < 20) {
    const u = new URL(`https://api.anthropic.com/v1/sessions/${sid}/events`);
    u.searchParams.set('limit', '100'); if (cursor) u.searchParams.set('starting_after', cursor);
    const r = await fetch(u, { headers: HA }); if (!r.ok) return { err: `${r.status} ${(await r.text()).slice(0, 120)}` };
    const body = await r.json(); const arr = Array.isArray(body) ? body : (body.data || []);
    for (const e of arr) seen.set(e.id, e); // dedupe by event id (events repeat across poll rounds)
    if (Array.isArray(body) || !body.has_more) break; cursor = body.last_id || arr[arr.length - 1]?.id; if (!cursor) break;
  }
  return { evs: [...seen.values()] };
}

const TOOLU = /tool_use$/; // agent.custom_tool_use | agent.mcp_tool_use | agent.server_tool_use | agent.tool_use
const globalTools = {}, skillTally = {};
let crawled = 0; const rows = [];
for (const [sid, meta] of sessions) {
  const res = await events(sid);
  if (res.err) { rows.push(`  ${sid}  task=${meta.task || '?'}  ERR ${res.err}`); continue; }
  crawled++;
  const per = {};
  for (const e of res.evs) {
    if (TOOLU.test(e.type || '')) { const n = e.type.replace(/^agent\./, '').replace(/_tool_use$/, '') + ':' + (e.name || '?'); per[n] = (per[n] || 0) + 1; globalTools[n] = (globalTools[n] || 0) + 1; }
    if (/skill/i.test(e.type || '')) { const n = e.skill_id || e.name || e.type; skillTally[n] = (skillTally[n] || 0) + 1; }
  }
  const toolStr = Object.keys(per).length ? Object.entries(per).map(([k, v]) => `${k}×${v}`).join(', ') : '(none)';
  rows.push(`  ${sid}  task=${meta.task || '?'}  evts=${res.evs.length}  tools: ${toolStr}`);
}

console.log(`\nPer-session (${crawled} crawled):`);
rows.forEach((r) => console.log(r));
console.log('\n=== GLOBAL TOOL-USE HISTOGRAM ===');
const sorted = Object.entries(globalTools).sort((a, b) => b[1] - a[1]);
if (!sorted.length) console.log('  (no tool_use events at all)');
sorted.forEach(([k, v]) => console.log(`  ${k.padEnd(45)} ${v}`));
console.log('\n=== SKILL EVENTS ===');
const sk = Object.entries(skillTally);
if (!sk.length) console.log('  (no distinct skill events — note: docx/xlsx/pptx/pdf skills run via bash, so absence here ≠ unused)');
sk.forEach(([k, v]) => console.log(`  ${k} ${v}`));
