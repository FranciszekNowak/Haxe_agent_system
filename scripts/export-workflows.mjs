#!/usr/bin/env node
// export-workflows.mjs — pull live n8n workflows into the repo's curated JSON shape.
//
// The companion to check-workflow-drift.mjs: when drift-check reports a workflow you
// edited live is ahead of the repo, run this to write the repo file back from live.
// Re-export the WHOLE workflow rather than hand-patching the JSON — n8n's partial-update
// API auto-sanitises every IF/Switch node's condition options on any edit (v2→v3,
// loose→strict), so a surgical patch silently leaves those untouched nodes drifted.
//
// Mirrors drift-check's normalisation so a fresh export is drift-clean:
//   - strips UI-derived keys drift-check ignores (schema, cachedResultName, cachedResultUrl)
//   - keeps the repo's curated node `notes` from LIVE (edit notes in the n8n UI, not here)
//   - preserves each repo file's existing top-level `active` flag (won't flip activation)
//   - compacts [x, y] node positions onto one line
//
// EXPLICIT FILES ONLY — never mass-exports. Drift is often bidirectional (the repo is
// sometimes the correct/ahead side), so you name exactly the files to overwrite:
//
//   N8N_API_KEY=...  node scripts/export-workflows.mjs read-input.json agent-orchestrator.json
//   (optional) N8N_API_URL=https://agents.haxe.ai/api/v1
//
// Then re-run check-workflow-drift.mjs to confirm the file(s) now match live.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WF_DIR = join(ROOT, 'n8n', 'workflows');
const BASE = process.env.N8N_API_URL || 'https://agents.haxe.ai/api/v1';
const KEY = process.env.N8N_API_KEY;
if (!KEY) { console.error('FATAL: N8N_API_KEY not set'); process.exit(2); }
const H = { 'X-N8N-API-KEY': KEY };

const files = process.argv.slice(2).filter((a) => !a.startsWith('-'));
if (!files.length) {
  console.error('usage: node scripts/export-workflows.mjs <file.json> [more.json ...]');
  console.error('  (names are files in n8n/workflows/; export is matched to live by the file\'s "name")');
  process.exit(2);
}

// UI-derived keys the repo omits (also the ones check-workflow-drift.mjs strips before comparing).
const STRIP = new Set(['schema', 'cachedResultName', 'cachedResultUrl']);
const deepStrip = (v) => {
  if (Array.isArray(v)) return v.map(deepStrip);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v)) if (!STRIP.has(k)) o[k] = deepStrip(v[k]);
    return o;
  }
  return v;
};

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
const getLive = async (id) => {
  const r = await fetch(`${BASE}/workflows/${id}`, { headers: H });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${id}`);
  return r.json();
};

// Keep behaviour-relevant node fields, in the repo's rough key order. Cosmetic/UI cruft dropped.
const cleanNode = (n) => {
  const o = {};
  o.id = n.id; o.name = n.name; o.type = n.type; o.typeVersion = n.typeVersion;
  o.position = n.position;
  if (n.webhookId) o.webhookId = n.webhookId;
  if (n.notes != null) o.notes = n.notes;
  if (n.disabled) o.disabled = true;
  o.parameters = deepStrip(n.parameters || {});
  if (n.credentials) o.credentials = n.credentials;
  if (n.onError) o.onError = n.onError;
  if (n.retryOnFail) o.retryOnFail = true;
  if (n.maxTries != null) o.maxTries = n.maxTries;
  if (n.waitBetweenTries != null) o.waitBetweenTries = n.waitBetweenTries;
  if (n.alwaysOutputData) o.alwaysOutputData = true;
  if (n.continueOnFail) o.continueOnFail = true;
  return o;
};

const nameToId = await listLive();
let failed = 0;

for (const file of files) {
  const path = join(WF_DIR, file);
  if (!existsSync(path)) { console.error(`skip   ${file} — no such repo file`); failed++; continue; }
  const repo = JSON.parse(readFileSync(path, 'utf8'));
  const id = nameToId[repo.name];
  if (!id) { console.error(`skip   ${file} — no live workflow named "${repo.name}"`); failed++; continue; }
  const live = await getLive(id);
  const out = {
    name: live.name,
    active: repo.active,            // preserve the repo's activation convention
    nodes: live.nodes.map(cleanNode),
    connections: live.connections,
    settings: live.settings || {},
  };
  let s = JSON.stringify(out, null, 2);
  s = s.replace(/\[\s*(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)\s*\]/g, '[$1, $2]'); // compact positions
  writeFileSync(path, s + '\n');
  console.log(`wrote  ${file}  (${out.nodes.length} nodes from "${live.name}")`);
}

if (failed) { console.error(`\n${failed} file(s) skipped`); process.exit(1); }
console.log('\n✓ re-run check-workflow-drift.mjs to confirm');
