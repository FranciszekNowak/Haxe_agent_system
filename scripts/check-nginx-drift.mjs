#!/usr/bin/env node
/**
 * check-nginx-drift.mjs — compare the repo's nginx reference copy against the LIVE
 * host nginx config on the VPS, so host-level config drift is surfaced loudly
 * instead of discovered mid-migration.
 *
 * Why this exists: the host nginx config (/etc/nginx/conf.d/agents.conf) is
 * mastered by the repo copy at n8n/nginx-agents.conf but is edited live (certbot +
 * hand edits), so the two drift. The agents.haxe.ai -> agents.skalus.com cutover
 * (ADR-070) found `proxy_read_timeout/proxy_send_timeout 300s` living ONLY on the
 * live box (never written back) — which would have silently cut off ~200s MCP tool
 * calls and session-waiter long-polls once the old vhost was gone. The n8n workflows
 * have check-workflow-drift.mjs; the host nginx config had no equivalent. This is it.
 *
 * It compares SEMANTICALLY: comments (`# …`) and all whitespace/formatting are
 * ignored (including certbot quirks like `}server {`); only the directive token
 * stream is compared. Any added/removed/changed directive is reported.
 *
 * Usage:  node scripts/check-nginx-drift.mjs
 *   env:  VPS_SSH          (default franciszek@185.25.149.174)
 *         NGINX_LIVE_PATH  (default /etc/nginx/conf.d/agents.conf)
 * Needs:  SSH access to the VPS (sudo cat of the config).
 * Exit:   0 = match, 1 = drift, 2 = could not read live config.
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const VPS = process.env.VPS_SSH || 'franciszek@185.25.149.174';
const LIVE_PATH = process.env.NGINX_LIVE_PATH || '/etc/nginx/conf.d/agents.conf';
const here = dirname(fileURLToPath(import.meta.url));
const REPO_FILE = resolve(here, '..', 'n8n', 'nginx-agents.conf');

// Canonicalize an nginx config to a comparable token stream:
//  - strip comments (# … to end of line)
//  - treat { } ; as standalone tokens (so `}server {` == `} \n server {`)
//  - collapse all whitespace; blank lines / indentation are irrelevant
function tokenize(text) {
  return text
    .split('\n')
    .map((l) => { const i = l.indexOf('#'); return i === -1 ? l : l.slice(0, i); })
    .join('\n')
    .replace(/([{};])/g, ' $1 ')
    .split(/\s+/)
    .filter(Boolean);
}

function firstDiff(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

let liveText;
try {
  liveText = execSync(`ssh ${VPS} "sudo cat ${LIVE_PATH}"`, { encoding: 'utf8' });
} catch (e) {
  console.error(`FAILED to read live nginx config via SSH (${VPS}:${LIVE_PATH}).`);
  console.error((e.stderr || e.message || '').toString().trim());
  process.exit(2);
}

const repoTokens = tokenize(readFileSync(REPO_FILE, 'utf8'));
const liveTokens = tokenize(liveText);
const idx = firstDiff(repoTokens, liveTokens);

if (idx === -1) {
  console.log(`ok   nginx config matches  (n8n/nginx-agents.conf == ${VPS}:${LIVE_PATH})`);
  console.log(`     ${repoTokens.length} directive tokens; comments + whitespace ignored.`);
  process.exit(0);
}

const ctx = (arr, i) => arr.slice(Math.max(0, i - 6), i + 6).join(' ');
console.error(`DRIFT  repo n8n/nginx-agents.conf != live ${LIVE_PATH}`);
console.error(`  first difference at directive token #${idx}:`);
console.error(`  repo: … ${ctx(repoTokens, idx)} …`);
console.error(`  live: … ${ctx(liveTokens, idx)} …`);
console.error(`  (repo ${repoTokens.length} tokens, live ${liveTokens.length} tokens)`);
console.error(`  Reconcile: write the live change back to n8n/nginx-agents.conf, or fix live.`);
process.exit(1);
