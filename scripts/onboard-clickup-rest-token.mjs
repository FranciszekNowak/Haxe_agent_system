#!/usr/bin/env node
// onboard-clickup-rest-token.mjs — ADR-054 Block 1 (Option A) INTERIM onboarder for the EXTRACTION token.
//
// WHY THIS EXISTS (the two-path collision, 2026-06-24). Option A needs TWO tokens per user:
//   * DISCOVERY  = an MCP-OAuth token in the user's Anthropic Vault  -> minted by onboard-clickup-mcp-user.mjs.
//   * EXTRACTION = the CLASSIC REST OAuth token in Supabase Vault     -> minted HERE.
// The production path that mints BOTH is the hosted webhook `ClickUp OAuth Onboarding (v1)`, but right now it
// is unusable for the REST token for two reasons: (1) its "Already Connected?" guard short-circuits for any
// user who already has a user_data_and_config row (which the loopback DISCOVERY onboarder creates), so it
// throws the REST token away and shows an "already connected" page; and (2) even past that, it chains into the
// hosted-MCP consent phase, which is STILL allowlist-blocked, so it always ends in a failure page + CRITICAL.
// This script is the clean interim: the CLASSIC ClickUp OAuth loopback flow -> store ONLY the REST token via
// public.set_clickup_rest_token(). It does NOT touch the mapping row or the Anthropic Vault, so it never
// collides with the discovery onboarding. Retire it once the webhook is allowlisted (then the webhook mints
// both tokens self-serve).
//
// IDENTITY is self-verified: unlike the MCP token, the CLASSIC REST token works on ClickUp REST, so we call
// GET /api/v2/user to learn who actually consented and store the token under THAT id. If --clickup-user-id is
// passed, we assert it matches (die on mismatch) — this catches "the wrong person was logged into ClickUp in
// the browser", the silent trap that would mislabel a token and defeat the Block-5 scope test.
//
// Flow (all loopback):
//   1. read the OAuth app credentials from Supabase Vault via RPC get_clickup_oauth_app() (service_role),
//   2. open https://app.clickup.com/api?client_id=…&redirect_uri=http://localhost:<port>/callback&state=… ,
//   3. capture ?code= on localhost (state-checked),
//   4. exchange code -> access_token (POST https://api.clickup.com/api/v2/oauth/token, params as query string),
//   5. GET /api/v2/user (Authorization: <raw token>, no "Bearer ") to verify identity,
//   6. store the token via RPC set_clickup_rest_token(p_user_id, p_token) (service_role) — Supabase Vault.
// The access token is NEVER printed or written to disk — it is write-only in the Vault.
//
// Usage (run on a machine WITH a browser, logged into ClickUp AS the user being onboarded):
//   set SUPABASE_URL=https://hkeslnosxibeuesxndnz.supabase.co
//   set SUPABASE_SERVICE_KEY=...            (service_role — calls the two SECURITY DEFINER getters)
//   node scripts/onboard-clickup-rest-token.mjs --clickup-user-id 2604220
//
// Flags:  --clickup-user-id <id> (optional but recommended — asserts the consenting user matches)
//         --port <n> (loopback port, default 8723 — MUST be a registered redirect on the ClickUp OAuth app)
//         --no-open  (print the URL only, don't try to launch a browser)
//
// REDIRECT NOTE: ClickUp validates redirect_uri against the OAuth app's registered list. The production app
// registers https://agents.haxe.ai/webhook/clickup-oauth-callback. For this loopback flow, the app owner must
// also have http://localhost:<port>/callback registered. If ClickUp returns an "invalid redirect_uri" error,
// add http://localhost:8723/callback to the app's Redirect URLs (ClickUp app settings) and re-run.

import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const PORT = Number(opt('--port', '8723'));
const REDIRECT = `http://localhost:${PORT}/callback`;
const EXPECT_USER_ID = opt('--clickup-user-id', '');
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';

function die(msg) { console.error('FATAL: ' + msg); process.exit(2); }
if (!SUPABASE_URL) die('SUPABASE_URL not set (e.g. https://hkeslnosxibeuesxndnz.supabase.co)');
if (!SUPABASE_SERVICE_KEY) die('SUPABASE_SERVICE_KEY not set (service_role — needed to read the app creds and store the token)');

async function jf(label, url, init) {
  const r = await fetch(url, init);
  const t = await r.text();
  let b; try { b = t && (t.trim()[0] === '{' || t.trim()[0] === '[') ? JSON.parse(t) : t; } catch { b = t; }
  if (!r.ok) throw new Error(`${label} -> HTTP ${r.status}: ${typeof b === 'string' ? b.slice(0, 600) : JSON.stringify(b).slice(0, 600)}`);
  return b;
}
const sbHdr = () => ({ apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, 'content-type': 'application/json' });
const rpc = (fn, body) => jf(`rpc ${fn}`, `${SUPABASE_URL}/rest/v1/rpc/${fn}`, { method: 'POST', headers: sbHdr(), body: JSON.stringify(body || {}) });

function openBrowser(url) {
  if (flag('--no-open')) return;
  try {
    const [cmd, args] = process.platform === 'win32'
      ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
      : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
    spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  } catch { /* paste the printed URL manually */ }
}

function getCode(authUrl, state) {
  return new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      const u = new URL(req.url, `http://localhost:${PORT}`);
      if (u.pathname !== '/callback') { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h2>ClickUp połączono ✓ — wróć do terminala.</h2>');
      srv.close();
      const err = u.searchParams.get('error');
      if (err) return reject(new Error('authorize error: ' + err + ' ' + (u.searchParams.get('error_description') || '')));
      if (u.searchParams.get('state') !== state) return reject(new Error('state mismatch'));
      const code = u.searchParams.get('code');
      if (!code) return reject(new Error('no code on callback'));
      resolve(code);
    });
    srv.on('error', reject);
    srv.listen(PORT, () => {
      console.log('\nOpen this URL and approve AS the user you are onboarding (the browser may open automatically):\n\n  ' + authUrl + '\n');
      console.log(`Waiting for the redirect to ${REDIRECT} ...`);
      openBrowser(authUrl);
    });
  });
}

(async () => {
  // 1) app credentials from the Vault (service_role RPC)
  const app = await rpc('get_clickup_oauth_app', {});
  const clientId = app && app.client_id;
  const clientSecret = app && app.client_secret;
  if (!clientId || !clientSecret) die('get_clickup_oauth_app() returned no client_id/client_secret — is the app seeded?');
  console.log('✓ loaded ClickUp OAuth app creds from the Vault');

  // 2+3) consent + capture the code on the loopback redirect
  const state = crypto.randomBytes(16).toString('hex');
  const authUrl = `https://app.clickup.com/api?client_id=${encodeURIComponent(clientId)}`
    + `&redirect_uri=${encodeURIComponent(REDIRECT)}&state=${state}`;
  const code = await getCode(authUrl, state);
  console.log('✓ authorization code captured');

  // 4) exchange code -> access_token (ClickUp takes the params as a query string on the POST; no redirect_uri)
  const tokenUrl = `https://api.clickup.com/api/v2/oauth/token?client_id=${encodeURIComponent(clientId)}`
    + `&client_secret=${encodeURIComponent(clientSecret)}&code=${encodeURIComponent(code)}`;
  const tok = await jf('token exchange', tokenUrl, { method: 'POST' });
  const accessToken = tok && tok.access_token;
  if (!accessToken) die('token exchange returned no access_token: ' + JSON.stringify(tok).slice(0, 300));
  console.log('✓ REST access token obtained (not displayed)');

  // 5) verify identity — the classic token works on REST, so confirm WHO consented
  const me = await jf('get user', 'https://api.clickup.com/api/v2/user', { headers: { Authorization: accessToken } });
  const user = me && me.user;
  if (!user || user.id == null) die('GET /user returned no user: ' + JSON.stringify(me).slice(0, 300));
  const userId = String(user.id);
  console.log(`✓ consenting user: ${user.username || '(no name)'} <${user.email || '?'}> (id ${userId})`);
  if (EXPECT_USER_ID && EXPECT_USER_ID !== userId) {
    die(`identity mismatch: you passed --clickup-user-id ${EXPECT_USER_ID} but the browser consented as ${userId}. `
      + `The WRONG ClickUp account is logged in. Re-run and approve as the intended user (incognito window).`);
  }

  // 6) store the REST token in Supabase Vault (service_role RPC) — keyed by the VERIFIED id
  await rpc('set_clickup_rest_token', { p_user_id: userId, p_token: accessToken });
  console.log('✓ REST token stored in Supabase Vault (clickup_rest_token_' + userId + ')');

  console.log('\nDONE. Verify (no secret in it):');
  console.log(`  select get_clickup_rest_token('${userId}') is not null as has_rest_token;`);
  console.log('Summary:', JSON.stringify({ clickup_user_id: userId, username: user.username || '', stored: true }));
  process.exit(0);
})().catch((e) => { console.error('\nFATAL: ' + (e && e.message ? e.message : e)); process.exit(1); });
