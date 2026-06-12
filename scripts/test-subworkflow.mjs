#!/usr/bin/env node
// test-subworkflow.mjs — drive an n8n SUB-workflow (executeWorkflowTrigger / "When Called") with
// pinned inputs and print its return, then inspect it.
//
// Why this exists: a sub-workflow can't be triggered by the n8n public API or by n8n_test_workflow —
// only webhook/form/chat triggers can be fired externally. So to exercise a "When Called" sub-workflow
// (Invoke Model, Read Input, Log Model Run, the future resolver/assembler, …) with real inputs you'd
// otherwise hand-build a throwaway webhook harness each time. This does it for you:
//   1. introspects the target's declared When-Called inputs,
//   2. stands up a TEMPORARY webhook harness  Webhook → Execute <target> → Respond,
//      wiring every declared input from the POST body ({{ $json.body.<name> }}),
//   3. activates it, POSTs your JSON once (UTF-8 — no diacritic mangling), prints the return
//      (long strings truncated unless --raw) + the target's latest execution id,
//   4. tears the harness down (unless --keep).
//
// Then inspect the real run node-by-node:  node scripts/inspect-execution.mjs <execId>
//
// Usage:
//   node scripts/test-subworkflow.mjs <workflowId> '{"impact":"Niski","requested_modality_of_output":"image","prompt":"red apple"}'
//   node scripts/test-subworkflow.mjs <workflowId> --file inputs.json
//   echo '{ "...": "..." }' | node scripts/test-subworkflow.mjs <workflowId>
//
// Flags:  --file <path>   read the input JSON from a file
//         --keep          leave the harness in place (don't delete) — handy for repeated manual POSTs
//         --raw           don't truncate long string fields in the printed result
//         --timeout <sec> client timeout (default 300; gpt-image-2 high ≈ 176 s)
//   env:  N8N_API_KEY (required), N8N_API_URL (default https://agents.haxe.ai/api/v1)

const BASE = process.env.N8N_API_URL || 'https://agents.haxe.ai/api/v1';
const KEY = process.env.N8N_API_KEY;
if (!KEY) { console.error('FATAL: N8N_API_KEY not set'); process.exit(2); }
const H = { 'X-N8N-API-KEY': KEY, 'Content-Type': 'application/json' };
const WEBHOOK_BASE = BASE.replace(/\/api\/v1\/?$/, '') + '/webhook';

// ── args ──────────────────────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const targetId = argv.find((a) => !a.startsWith('-'));
if (!targetId) {
  console.error('usage: node scripts/test-subworkflow.mjs <workflowId> \'<json>\' [--file f] [--keep] [--raw] [--timeout 300]');
  process.exit(2);
}
const flag = (n) => argv.includes(n);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const KEEP = flag('--keep'), RAW = flag('--raw');
const TIMEOUT = Number(opt('--timeout', '300')) * 1000;

async function readInputs() {
  const fileArg = opt('--file', null);
  if (fileArg) return JSON.parse((await import('node:fs')).readFileSync(fileArg, 'utf8'));
  const positional = argv.slice(1).find((a) => !a.startsWith('-') && a !== targetId);
  if (positional) return JSON.parse(positional);
  // stdin
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  const s = Buffer.concat(chunks).toString('utf8').trim();
  if (!s) { console.error('FATAL: no inputs given (positional JSON, --file, or stdin)'); process.exit(2); }
  return JSON.parse(s);
}

const api = async (path, init = {}) => {
  const r = await fetch(`${BASE}${path}`, { headers: H, ...init });
  const text = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status} ${init.method || 'GET'} ${path}: ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : {};
};

// truncate long strings (b64 images etc.) so the result is readable; --raw keeps them
const shrink = (v) => {
  if (typeof v === 'string') return (!RAW && v.length > 200) ? `«string ${v.length} chars» ${v.slice(0, 80)}…` : v;
  if (Array.isArray(v)) return v.map(shrink);
  if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v)) o[k] = shrink(v[k]); return o; }
  return v;
};

const inputs = await readInputs();

// ── introspect the target's declared When-Called inputs ─────────────────────────────────────────
const target = await api(`/workflows/${targetId}`);
const trig = (target.nodes || []).find((n) => n.type === 'n8n-nodes-base.executeWorkflowTrigger');
const declared = trig?.parameters?.workflowInputs?.values?.map((v) => v.name).filter(Boolean) || [];
if (!trig) console.error(`warn: "${target.name}" has no executeWorkflowTrigger; passing inputs by name anyway`);
const mapNames = declared.length ? declared : Object.keys(inputs);
const inputMap = {};
for (const n of mapNames) inputMap[n] = `={{ $json.body['${n}'] }}`;

console.log(`→ target "${target.name}" (${targetId}); inputs wired: ${mapNames.join(', ') || '(none)'}`);

// ── build + create the temporary harness ────────────────────────────────────────────────────────
const path = `subwf-test-${Date.now()}`;
const harness = {
  name: `_TMP test-subworkflow ${target.name}`,
  nodes: [
    { id: 'wh', name: 'Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [0, 300],
      parameters: { httpMethod: 'POST', path, responseMode: 'responseNode', options: {} } },
    { id: 'call', name: 'Call Target', type: 'n8n-nodes-base.executeWorkflow', typeVersion: 1.3, position: [260, 300],
      parameters: { workflowId: { __rl: true, value: targetId, mode: 'list' },
        workflowInputs: { mappingMode: 'defineBelow', value: inputMap, matchingColumns: [],
          attemptToConvertTypes: false, convertFieldsToString: false }, options: {} } },
    { id: 'resp', name: 'Respond', type: 'n8n-nodes-base.respondToWebhook', typeVersion: 1.1, position: [520, 300],
      parameters: { respondWith: 'firstIncomingItem', options: {} } },
  ],
  connections: {
    'Webhook': { main: [[{ node: 'Call Target', type: 'main', index: 0 }]] },
    'Call Target': { main: [[{ node: 'Respond', type: 'main', index: 0 }]] },
  },
  settings: { executionOrder: 'v1' },
};

const created = await api('/workflows', { method: 'POST', body: JSON.stringify(harness) });
const harnessId = created.id;
let exitCode = 0;
try {
  await api(`/workflows/${harnessId}/activate`, { method: 'POST', body: '{}' });

  // ── fire it ────────────────────────────────────────────────────────────────────────────────
  console.log(`→ POST ${WEBHOOK_BASE}/${path}`);
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), TIMEOUT);
  const t0 = Date.now();
  let result, ok = true;
  try {
    const r = await fetch(`${WEBHOOK_BASE}/${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(inputs), signal: ctrl.signal,
    });
    const text = await r.text();
    ok = r.ok;
    try { result = JSON.parse(text); } catch { result = text; }
    if (!ok) console.error(`✗ webhook HTTP ${r.status}`);
  } finally { clearTimeout(to); }
  const secs = Math.round((Date.now() - t0) / 1000);

  console.log(`\n── result (${secs}s) ──`);
  console.log(JSON.stringify(shrink(result), null, 2));

  // ── point at the real sub-execution for node-by-node inspection ──────────────────────────────
  try {
    const ex = await api(`/executions?workflowId=${targetId}&limit=1`);
    const id = (ex.data || [])[0]?.id;
    if (id) console.log(`\n→ inspect: node scripts/inspect-execution.mjs ${id}`);
  } catch { /* best-effort */ }
  if (!ok) exitCode = 1;
} finally {
  if (KEEP) {
    console.log(`\n(harness kept: ${harnessId} — POST ${WEBHOOK_BASE}/${path}; delete with DELETE /workflows/${harnessId})`);
  } else {
    try { await api(`/workflows/${harnessId}`, { method: 'DELETE' }); console.log(`\n✓ harness torn down`); }
    catch (e) { console.error(`warn: harness ${harnessId} not deleted — ${e.message}`); }
  }
}
process.exit(exitCode);
