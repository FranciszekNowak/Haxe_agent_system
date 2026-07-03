#!/usr/bin/env node
// alerts-since.mjs — list recent Post Alert (v1) firings in a time window (Definition-of-Done step 3).
//
// Every alert in this system is an execution of the central Post Alert (v1) workflow
// (id YSCdHlmdf3p9XEUx, ADR-025), with severity/source/message/details on its trigger input. So the
// alert channel can be read straight from n8n — no ClickUp token, and no pulling the oversized Alerts
// task comment payload just to eyeball WARN/CRITICAL after a test. Read-only.
//
//   N8N_API_KEY=...  node scripts/alerts-since.mjs [minutes] [--crit] [--source <substr>] [--limit N]
//   (optional) N8N_API_URL=https://agents.skalus.com/api/v1
//
//   minutes          look-back window (default 30)
//   --crit           only CRITICAL
//   --source <s>     only alerts whose source contains <s> (e.g. multimodal, cost, routing)
//   --limit N        max executions to scan (default 100)
//
// Examples:
//   node scripts/alerts-since.mjs 15
//   node scripts/alerts-since.mjs 60 --crit
//   node scripts/alerts-since.mjs 30 --source multimodal

const BASE = process.env.N8N_API_URL || 'https://agents.skalus.com/api/v1';
const KEY = process.env.N8N_API_KEY;
if (!KEY) { console.error('FATAL: N8N_API_KEY not set'); process.exit(2); }
const POST_ALERT_ID = 'YSCdHlmdf3p9XEUx';

const argv = process.argv.slice(2);
const minutes = Number(argv.find((a) => /^\d+$/.test(a))) || 30;
const CRIT_ONLY = argv.includes('--crit');
const srcI = argv.indexOf('--source');
const srcFilter = srcI >= 0 ? (argv[srcI + 1] || '') : null;
const limI = argv.indexOf('--limit');
const LIMIT = limI >= 0 ? Number(argv[limI + 1]) || 100 : 100;

const cutoff = Date.now() - minutes * 60 * 1000;

const url = `${BASE}/executions?workflowId=${POST_ALERT_ID}&includeData=true&limit=${LIMIT}`;
const r = await fetch(url, { headers: { 'X-N8N-API-KEY': KEY } });
if (!r.ok) { console.error(`HTTP ${r.status} listing Post Alert executions`); process.exit(1); }
const j = await r.json();
const execs = j.data || j.executions || [];

// Pull {severity, source, message, details} from a Post Alert execution (trigger input, with fallback).
const alertOf = (e) => {
  const rd = e?.data?.resultData?.runData || {};
  let t = rd['When Called']?.[0]?.data?.main?.[0]?.[0]?.json;
  if (!t || t.severity === undefined) {
    for (const n of Object.keys(rd)) {
      const cand = rd[n]?.[0]?.data?.main?.[0]?.[0]?.json;
      if (cand && cand.severity !== undefined && cand.source !== undefined) { t = cand; break; }
    }
  }
  return t || null;
};

const rows = [];
let oldestSeen = Infinity;
for (const e of execs) {
  const ts = e.startedAt ? new Date(e.startedAt).getTime() : 0;
  oldestSeen = Math.min(oldestSeen, ts);
  if (ts < cutoff) continue;
  const a = alertOf(e);
  if (!a) continue;
  if (CRIT_ONLY && String(a.severity).toUpperCase() !== 'CRITICAL') continue;
  if (srcFilter && !String(a.source || '').includes(srcFilter)) continue;
  rows.push({ ts, sev: a.severity, source: a.source, message: a.message, details: a.details });
}

rows.sort((x, y) => y.ts - x.ts);
const hhmmss = (ts) => new Date(ts).toISOString().slice(11, 19);
let nCrit = 0, nWarn = 0;
console.log(`Alerts in the last ${minutes} min${CRIT_ONLY ? ' (CRITICAL only)' : ''}${srcFilter ? ` matching source~"${srcFilter}"` : ''} — ${rows.length} hit(s):\n`);
for (const a of rows) {
  const sev = String(a.sev || '?').toUpperCase();
  if (sev === 'CRITICAL') nCrit += 1; else if (sev === 'WARN') nWarn += 1;
  console.log(`[${hhmmss(a.ts)}] [${sev}] ${a.source}`);
  console.log(`    ${a.message}`);
  if (a.details) console.log(`    ${a.details}`);
}
console.log(`\n${nCrit} CRITICAL, ${nWarn} WARN${rows.length - nCrit - nWarn ? `, ${rows.length - nCrit - nWarn} other` : ''}.`);
// Warn if the scan window didn't reach back past the cutoff (more alerts may exist beyond --limit).
if (oldestSeen > cutoff && execs.length >= LIMIT) {
  console.log(`NOTE: scanned ${execs.length} execs but the oldest is still inside the window — raise --limit to be sure you saw them all.`);
}
