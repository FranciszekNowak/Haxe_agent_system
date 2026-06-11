#!/usr/bin/env node
// check-workflow-drift.mjs — surface n8n repo↔live BEHAVIOURAL drift loudly.
//
// Compares every n8n/workflows/<file>.json against the live workflow of the same `name`,
// normalising away things that don't affect execution: node `notes`, canvas `position`,
// UI resourceLocator caches (cachedResultName/cachedResultUrl), workflowInputs `schema`
// (UI-derived), the internal-only `binaryMode` setting, and connection key ORDER.
//
// Exit 0 = every repo workflow matches live (behaviourally). Exit 1 = drift (or a repo
// workflow with no live match). Run before committing, or in CI.
//
//   N8N_API_KEY=...  node scripts/check-workflow-drift.mjs
//   (optional) N8N_API_URL=https://agents.haxe.ai/api/v1
//
// NOTE: this reports drift; it does not auto-fix. Drift is often bidirectional (the repo is
// sometimes the correct/ahead version), so a human must decide direction — see docs/drift-check.md.

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WF_DIR = join(ROOT, 'n8n', 'workflows');
const BASE = process.env.N8N_API_URL || 'https://agents.haxe.ai/api/v1';
const KEY = process.env.N8N_API_KEY;
if (!KEY) { console.error('FATAL: N8N_API_KEY not set'); process.exit(2); }
const H = { 'X-N8N-API-KEY': KEY };

// ---- normalisation ----
const COSMETIC_KEYS = new Set(['cachedResultName', 'cachedResultUrl', 'schema']);
const strip = (v) => {
  if (Array.isArray(v)) return v.map(strip);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v)) if (!COSMETIC_KEYS.has(k)) o[k] = strip(v[k]);
    return o;
  }
  return v;
};
const sortKeys = (v) => {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v).sort()) o[k] = sortKeys(v[k]);
    return o;
  }
  return v;
};
const canon = (v) => JSON.stringify(sortKeys(strip(v)));
const nodeFP = (n) => canon({
  name: n.name, type: n.type, typeVersion: n.typeVersion,
  parameters: n.parameters ?? {}, credentials: n.credentials ?? null,
  disabled: !!n.disabled, onError: n.onError ?? null,
  retryOnFail: !!n.retryOnFail, maxTries: n.maxTries ?? null,
  waitBetweenTries: n.waitBetweenTries ?? null,
});
const byName = (nodes) => Object.fromEntries((nodes || []).map((n) => [n.name, n]));
const dropBin = (s) => { const o = { ...(s || {}) }; delete o.binaryMode; return o; };

async function listLive() {
  const out = {};
  let cursor = '';
  do {
    const url = `${BASE}/workflows?limit=250${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const r = await fetch(url, { headers: H });
    if (!r.ok) throw new Error(`HTTP ${r.status} listing workflows`);
    const j = await r.json();
    for (const w of j.data || j.workflows || []) out[w.name] = w.id;
    cursor = j.nextCursor || '';
  } while (cursor);
  return out;
}
const getLive = async (id) => {
  const r = await fetch(`${BASE}/workflows/${id}`, { headers: H });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${id}`);
  return r.json();
};

const nameToId = await listLive();
const files = readdirSync(WF_DIR).filter((f) => f.endsWith('.json')).sort();
const drifted = [];

for (const file of files) {
  const repo = JSON.parse(readFileSync(join(WF_DIR, file), 'utf8'));
  const id = nameToId[repo.name];
  if (!id) { console.log(`DRIFT  ${file} — no live workflow named "${repo.name}"`); drifted.push(file); continue; }
  const live = await getLive(id);

  const rN = byName(repo.nodes), lN = byName(live.nodes);
  const rNames = new Set(Object.keys(rN)), lNames = new Set(Object.keys(lN));
  const added = [...lNames].filter((x) => !rNames.has(x));
  const removed = [...rNames].filter((x) => !lNames.has(x));
  const changed = [...lNames].filter((x) => rNames.has(x) && nodeFP(rN[x]) !== nodeFP(lN[x]));
  const connDiff = canon(repo.connections || {}) !== canon(live.connections || {});
  const setDiff = canon(dropBin(repo.settings)) !== canon(dropBin(live.settings));

  if (added.length || removed.length || changed.length || connDiff || setDiff) {
    let line = `DRIFT  ${file}`;
    if (added.length) line += ` | +nodes(live): ${added.join(', ')}`;
    if (removed.length) line += ` | -nodes(repo-only): ${removed.join(', ')}`;
    if (changed.length) line += ` | changed: ${changed.join(', ')}`;
    if (connDiff) line += ` | connections differ`;
    if (setDiff) line += ` | settings differ`;
    console.log(line);
    drifted.push(file);
  } else {
    console.log(`ok     ${file}`);
  }
}

console.log(`\n${drifted.length ? `✗ ${drifted.length} workflow(s) drifted` : `✓ all ${files.length} workflows match live`}`);
process.exit(drifted.length ? 1 : 0);
