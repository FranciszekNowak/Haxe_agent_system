#!/usr/bin/env node
// import-workflow.mjs — push a repo workflow JSON file UP to the live n8n instance.
//
// The inverse of export-workflows.mjs: when you've edited a workflow's JSON in the repo
// (a structural rewire, a note fix, a constant change) and want it live, this PUTs the file
// to the matching live workflow. After importing, re-export it (export-workflows.mjs) and run
// check-workflow-drift.mjs so the repo file reflects exactly what n8n stored (n8n normalises
// some fields on save), and inspect a real run per the Definition of Done.
//
// Matches live by the file's "name" (same as export), so you pass the FILENAME, not an id:
//
//   N8N_API_KEY=...  node scripts/import-workflow.mjs image-resolver.json [more.json ...]
//   (optional) N8N_API_URL=https://agents.haxe.ai/api/v1
//
// WHY THE settings WHITELIST: n8n's public API is asymmetric — GET /workflows/{id} returns a
// settings object that can include keys (e.g. `binaryMode`) the PUT schema then REJECTS with
// HTTP 400 "request/body/settings must NOT have additional properties". So a naive round-trip
// (export then re-import) 400s. We send only the keys the PUT schema accepts; the dropped keys
// are n8n-managed defaults that live keeps on its own, so nothing is lost.
//
// EXPLICIT FILES ONLY — never mass-imports. You name exactly the file(s) to push live, so a
// stray repo edit can't silently overwrite an unrelated live workflow. Pushing is deliberate.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WF_DIR = join(ROOT, 'n8n', 'workflows');
const BASE = process.env.N8N_API_URL || 'https://agents.haxe.ai/api/v1';
const KEY = process.env.N8N_API_KEY;
if (!KEY) { console.error('FATAL: N8N_API_KEY not set'); process.exit(2); }
const H = { 'X-N8N-API-KEY': KEY, 'Content-Type': 'application/json' };

const files = process.argv.slice(2).filter((a) => !a.startsWith('-'));
if (!files.length) {
  console.error('usage: node scripts/import-workflow.mjs <file.json> [more.json ...]');
  console.error('  (names are files in n8n/workflows/; matched to live by the file\'s "name")');
  process.exit(2);
}

// The only settings keys n8n's PUT /workflows/{id} schema accepts. Anything else (binaryMode,
// callerPolicy, …) is n8n-managed and would 400 the request, so we never send it.
const ALLOWED_SETTINGS = [
  'saveExecutionProgress', 'saveManualExecutions', 'saveDataErrorExecution',
  'saveDataSuccessExecution', 'executionTimeout', 'errorWorkflow', 'timezone', 'executionOrder',
];

async function listLive() {
  const out = {}; let cursor = '';
  do {
    const url = `${BASE}/workflows?limit=250${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const r = await fetch(url, { headers: H });
    if (!r.ok) throw new Error(`HTTP ${r.status} listing workflows`);
    const j = await r.json();
    for (const w of (j.data || j.workflows || [])) out[w.name] = w.id;
    cursor = j.nextCursor || '';
  } while (cursor);
  return out;
}

const nameToId = await listLive();
let failed = 0;

for (const file of files) {
  const path = join(WF_DIR, file);
  if (!existsSync(path)) { console.error(`skip   ${file} — no such repo file`); failed++; continue; }
  const wf = JSON.parse(readFileSync(path, 'utf8'));
  const id = nameToId[wf.name];
  if (!id) { console.error(`skip   ${file} — no live workflow named "${wf.name}"`); failed++; continue; }

  const settings = {};
  for (const k of ALLOWED_SETTINGS) if (wf.settings && wf.settings[k] !== undefined) settings[k] = wf.settings[k];
  const dropped = Object.keys(wf.settings || {}).filter((k) => !ALLOWED_SETTINGS.includes(k));

  const body = { name: wf.name, nodes: wf.nodes, connections: wf.connections, settings };
  const r = await fetch(`${BASE}/workflows/${id}`, { method: 'PUT', headers: H, body: JSON.stringify(body) });
  if (!r.ok) {
    console.error(`FAIL   ${file} → ${id} — HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
    failed++; continue;
  }
  console.log(`pushed ${file} → ${id} ("${wf.name}", ${wf.nodes.length} nodes)` +
    (dropped.length ? `  [dropped settings: ${dropped.join(',')}]` : ''));
}

if (failed) { console.error(`\n${failed} file(s) failed`); process.exit(1); }
console.log('\n✓ now re-export (export-workflows.mjs) + check-workflow-drift.mjs, then verify a real run');
