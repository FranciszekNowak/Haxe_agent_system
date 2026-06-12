#!/usr/bin/env node
// inspect-execution.mjs — compact, node-by-node view of one n8n execution (Definition-of-Done step 2).
//
// The n8n execution payload is usually too big to read whole (base64 image bytes, full message
// arrays, header blobs) — pulling it via the API/MCP overflows the tool output and forces a
// dump-to-file + hand-written JSON poke every time. This fetches the execution and prints only what
// verification needs: per-node status, per-OUTPUT item counts (so you can SEE which IF/Switch branch
// fired), execution time, and a truncated dump of each node's output JSON. Read-only.
//
//   N8N_API_KEY=...  node scripts/inspect-execution.mjs <execId> [--nodes A,B] [--fields x,y] [--full] [--in]
//   (optional) N8N_API_URL=https://agents.haxe.ai/api/v1
//
//   --nodes A,B   only these nodes (default: all, in execution order)
//   --fields x,y  only these json keys per node (default: all keys, truncated)
//   --full        don't truncate long strings / big arrays (use when you need the raw value)
//   --in          also show each node's INPUT items (default: output only)
//
// Examples:
//   node scripts/inspect-execution.mjs 1569
//   node scripts/inspect-execution.mjs 1569 --nodes "Parse Response,Call Log Model Run" --fields image_unprocessable,model_used,cost_pln
//   node scripts/inspect-execution.mjs 1569 --nodes "Retry Text-Only" --full

const BASE = process.env.N8N_API_URL || 'https://agents.haxe.ai/api/v1';
const KEY = process.env.N8N_API_KEY;
if (!KEY) { console.error('FATAL: N8N_API_KEY not set'); process.exit(2); }

const argv = process.argv.slice(2);
const execId = argv.find((a) => !a.startsWith('--'));
if (!execId) {
  console.error('usage: node scripts/inspect-execution.mjs <execId> [--nodes A,B] [--fields x,y] [--full] [--in]');
  process.exit(2);
}
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true) : undefined;
};
const onlyNodes = typeof flag('--nodes') === 'string' ? flag('--nodes').split(',').map((s) => s.trim()) : null;
const onlyFields = typeof flag('--fields') === 'string' ? flag('--fields').split(',').map((s) => s.trim()) : null;
const FULL = !!flag('--full');
const SHOW_IN = !!flag('--in');

const MAXSTR = 180, MAXARR = 6;
const trunc = (v) => {
  if (FULL) return v;
  if (typeof v === 'string') return v.length > MAXSTR ? `«${v.length}c» ${v.slice(0, MAXSTR)}…` : v;
  if (Array.isArray(v)) {
    const head = v.slice(0, MAXARR).map(trunc);
    return v.length > MAXARR ? head.concat([`…(+${v.length - MAXARR} more)`]) : head;
  }
  if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v)) o[k] = trunc(v[k]); return o; }
  return v;
};
const fmtJson = (json) => {
  if (json == null || typeof json !== 'object') return `    ${JSON.stringify(json)}`;
  let keys = Object.keys(json);
  if (onlyFields) keys = keys.filter((k) => onlyFields.includes(k));
  if (!keys.length) return '    (no matching fields)';
  return keys.map((k) => {
    const v = trunc(json[k]);
    const s = (v != null && typeof v === 'object') ? JSON.stringify(v) : String(v);
    return `    ${k} = ${s}`;
  }).join('\n');
};
const itemsOf = (mainArr, outIdx = 0) => (mainArr && mainArr[outIdx]) || [];

const r = await fetch(`${BASE}/executions/${execId}?includeData=true`, { headers: { 'X-N8N-API-KEY': KEY } });
if (!r.ok) { console.error(`HTTP ${r.status} fetching execution ${execId}`); process.exit(1); }
const j = await r.json();
const runData = j?.data?.resultData?.runData;
if (!runData) { console.error('no resultData.runData (execution may have no data / be too old)'); process.exit(1); }

const wfName = j?.workflowData?.name || j.workflowId;
const durMs = j.startedAt && j.stoppedAt ? (new Date(j.stoppedAt) - new Date(j.startedAt)) : null;
console.log(`exec ${execId} — "${wfName}" — status=${j.status}${durMs != null ? ` — ${durMs}ms` : ''}`);
const topErr = j?.data?.resultData?.error;
if (topErr) console.log(`  TOP-LEVEL ERROR @ ${topErr.node?.name || '?'}: ${topErr.message || topErr}`);
console.log('');

let names = Object.keys(runData); // execution order
if (onlyNodes) names = names.filter((n) => onlyNodes.includes(n));

let i = 0;
for (const name of names) {
  const runs = runData[name] || [];
  for (const run of runs) {
    i += 1;
    const main = run?.data?.main || [];
    const counts = main.length ? main.map((o, idx) => `[${idx}]=${(o || []).length}`).join(' ') : '[]';
    const st = run.executionStatus || (run.error ? 'error' : '?');
    console.log(`${String(i).padStart(2)}. ${name}  status=${st}  out:${counts}  time=${run.executionTime ?? '?'}ms`);
    if (run.error) console.log(`    ERROR: ${run.error.message || run.error}`);
    if (SHOW_IN) {
      const inItems = run?.source?.[0] ? '(input shown via upstream node)' : null; // n8n input = upstream output
      if (inItems) console.log(`    in: ${inItems}`);
    }
    // show output items: for each output index that has items, dump item[0]
    main.forEach((out, idx) => {
      const arr = out || [];
      if (!arr.length) return;
      if (main.length > 1) console.log(`    └ output[${idx}] (${arr.length} item${arr.length > 1 ? 's' : ''}):`);
      console.log(fmtJson(arr[0]?.json));
    });
  }
}
