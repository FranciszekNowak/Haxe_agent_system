#!/usr/bin/env node
// onboard-clickup-user.mjs — ADR-054 Block 1: onboard one ClickUp user into permission-scoped
// context retrieval. Runs the OAuth authorization-code flow, mints that user's ClickUp access
// token, stores it as a static_bearer credential in a NEW per-user Anthropic Vault keyed to the
// hosted ClickUp MCP, and records the mapping row in user_clickup_credentials.
//
// Why this exists: the managed lane reads ClickUp through one shared bot token today. ADR-054 moves
// scope enforcement onto the CREDENTIAL — each member's own OAuth token in their own Vault, attached
// per session by n8n (Block 2). This script is the consent path that creates that per-user credential.
// ClickUp OAuth access tokens DO NOT EXPIRE and there is NO refresh token (Block-0), so onboarding is
// a one-time event per user; re-run only to re-consent after a revoke.
//
// WHY ONE VAULT PER USER: an Anthropic Vault credential is keyed by mcp_server_url; two credentials
// with the same URL in one vault return HTTP 409 (proven live, ma-spike-clickup-vault.py). Every
// user's ClickUp credential keys to https://mcp.clickup.com/mcp, so each user needs a vault of their
// own. This script creates that vault.
//
// WHY NOT code-challenge PKCE: this is a CONFIDENTIAL client (we hold client_secret), and ClickUp's
// token endpoint authenticates the exchange with client_secret, not a code_verifier (Block-0 finding).
// `state` covers CSRF on the loopback redirect. That is the OAuth 2.1 confidential-client flow; the
// "PKCE" label in ClickUp's MCP docs describes how an interactive MCP client (e.g. claude.ai) connects,
// not how our registered app issues a token.
//
// Flow:
//   1. start a localhost callback server (the registered redirect_uri),
//   2. open the ClickUp consent screen (https://app.clickup.com/api?client_id=…&redirect_uri=…&state=…),
//   3. capture ?code= on the redirect (state-checked),
//   4. exchange code -> access_token  (POST https://api.clickup.com/api/v2/oauth/token),
//   5. identify the user (GET https://api.clickup.com/api/v2/user),
//   6. create a per-user Anthropic Vault + a static_bearer credential
//      { mcp_server_url: https://mcp.clickup.com/mcp, token: <access_token> },
//   7. record the user_clickup_credentials row (via Supabase REST if SUPABASE_* set, else print SQL).
// The access token is NEVER printed or written to disk — it is write-only in the Vault.
//
// Usage (run on a machine with a browser — Franciszek's Windows desktop, NOT the headless VPS):
//   set ANTHROPIC_API_KEY=...     (or export on bash)
//   set CLICKUP_CLIENT_ID=...
//   set CLICKUP_CLIENT_SECRET=...
//   set SUPABASE_URL=https://hkeslnosxibeuesxndnz.supabase.co   (optional — else the INSERT SQL is printed)
//   set SUPABASE_SERVICE_KEY=...                                 (optional, service_role — bypasses RLS)
//   node scripts/onboard-clickup-user.mjs
//
// Flags:  --port <n>   localhost callback port (default 8723; must match the registered redirect_uri)
//         --no-open    don't try to launch the browser (print the URL only)
//
// env:  ANTHROPIC_API_KEY, CLICKUP_CLIENT_ID, CLICKUP_CLIENT_SECRET (required);
//       SUPABASE_URL + SUPABASE_SERVICE_KEY (optional, for the row insert);
//       CLICKUP_REDIRECT_URI (optional, overrides http://localhost:<port>/callback)

import http from 'node:http';
import crypto from 'node:crypto';
import { exec } from 'node:child_process';

const MCP_URL = 'https://mcp.clickup.com/mcp';     // the credential key (Block-0); scopes the call to U
const MA_BETA = 'managed-agents-2026-04-01';
const ANTHROPIC = 'https://api.anthropic.com';

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const PORT = Number(opt('--port', '8723'));
const REDIRECT = process.env.CLICKUP_REDIRECT_URI || `http://localhost:${PORT}/callback`;
const CLIENT_ID = process.env.CLICKUP_CLIENT_ID;
const CLIENT_SECRET = process.env.CLICKUP_CLIENT_SECRET;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

function die(msg) { console.error('FATAL: ' + msg); process.exit(2); }
if (!ANTHROPIC_KEY) die('ANTHROPIC_API_KEY not set (needed to create the Vault credential)');
if (!CLIENT_ID) die('CLICKUP_CLIENT_ID not set (from the registered ClickUp OAuth app)');
if (!CLIENT_SECRET) die('CLICKUP_CLIENT_SECRET not set (from the registered ClickUp OAuth app)');

// ── helpers ──────────────────────────────────────────────────────────────────────────────────
async function jsonFetch(label, url, init) {
  const r = await fetch(url, init);
  const text = await r.text();
  let body;
  try { body = text && (text.trim().startsWith('{') || text.trim().startsWith('[')) ? JSON.parse(text) : text; }
  catch { body = text; }
  if (!r.ok) {
    throw new Error(`${label} -> HTTP ${r.status}: ${typeof body === 'string' ? body.slice(0, 500) : JSON.stringify(body).slice(0, 500)}`);
  }
  return body;
}

function openBrowser(url) {
  if (flag('--no-open')) return;
  const cmd = process.platform === 'win32' ? `start "" "${url}"`
            : process.platform === 'darwin' ? `open "${url}"`
            : `xdg-open "${url}"`;
  exec(cmd, () => {});  // best-effort; the URL is also printed
}

// ── 1+2+3: consent + capture the code on the loopback redirect ──────────────────────────────────
function getAuthCode() {
  return new Promise((resolve, reject) => {
    const state = crypto.randomBytes(16).toString('hex');
    const authUrl = `https://app.clickup.com/api?client_id=${encodeURIComponent(CLIENT_ID)}`
      + `&redirect_uri=${encodeURIComponent(REDIRECT)}&state=${state}`;
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, `http://localhost:${PORT}`);
      if (u.pathname !== '/callback') { res.writeHead(404); res.end(); return; }
      const code = u.searchParams.get('code');
      const gotState = u.searchParams.get('state');
      const err = u.searchParams.get('error');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      if (err) {
        res.end(`<h2>ClickUp returned an error: ${err}</h2><p>You can close this tab.</p>`);
        server.close(); reject(new Error('ClickUp consent error: ' + err)); return;
      }
      if (gotState !== state) {
        res.end('<h2>State mismatch — possible CSRF. Aborting.</h2><p>You can close this tab.</p>');
        server.close(); reject(new Error('state mismatch on OAuth callback')); return;
      }
      if (!code) {
        res.end('<h2>No authorization code in the callback.</h2>');
        server.close(); reject(new Error('no code on callback')); return;
      }
      res.end('<h2>ClickUp connected ✓</h2><p>Onboarding is finishing in the terminal. You can close this tab.</p>');
      server.close(); resolve(code);
    });
    server.on('error', reject);
    server.listen(PORT, () => {
      console.log('\nOpen this URL and approve the workspace (the browser may open automatically):\n');
      console.log('  ' + authUrl + '\n');
      console.log(`Waiting for the redirect to ${REDIRECT} …`);
      openBrowser(authUrl);
    });
  });
}

// ── main ─────────────────────────────────────────────────────────────────────────────────────
(async () => {
  const code = await getAuthCode();

  // 4) exchange code -> access_token (ClickUp takes the params as query string on the POST)
  const tokenUrl = `https://api.clickup.com/api/v2/oauth/token?client_id=${encodeURIComponent(CLIENT_ID)}`
    + `&client_secret=${encodeURIComponent(CLIENT_SECRET)}&code=${encodeURIComponent(code)}`;
  const tok = await jsonFetch('token exchange', tokenUrl, { method: 'POST' });
  const accessToken = tok && tok.access_token;
  if (!accessToken) die('token exchange returned no access_token: ' + JSON.stringify(tok).slice(0, 300));
  console.log('✓ access token obtained (not displayed)');

  // 5) identify the user
  const me = await jsonFetch('get user', 'https://api.clickup.com/api/v2/user', {
    headers: { Authorization: accessToken },   // ClickUp expects the raw token (no "Bearer ") on its REST API
  });
  const user = me && me.user;
  if (!user || user.id == null) die('GET /user returned no user: ' + JSON.stringify(me).slice(0, 300));
  const clickupUserId = String(user.id);
  const username = user.username || '';
  const email = user.email || '';
  console.log(`✓ user: ${username} <${email}> (id ${clickupUserId})`);

  // 5b) guard against a duplicate / orphan vault if we can see the table
  if (SUPABASE_URL && SUPABASE_SERVICE_KEY) {
    const existing = await jsonFetch('check existing row',
      `${SUPABASE_URL}/rest/v1/user_clickup_credentials?clickup_user_id=eq.${encodeURIComponent(clickupUserId)}&select=clickup_user_id,status,vault_id`,
      { headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` } });
    if (Array.isArray(existing) && existing.length) {
      die(`a row already exists for user ${clickupUserId} (status ${existing[0].status}, vault ${existing[0].vault_id}). `
        + `Revoke/clean it before re-onboarding (delete the row + its Vault credential) to avoid an orphan vault.`);
    }
  }

  // 6) per-user Anthropic Vault + static_bearer credential
  const aHdr = { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'anthropic-beta': MA_BETA, 'content-type': 'application/json' };
  const vault = await jsonFetch('create vault', `${ANTHROPIC}/v1/vaults`, {
    method: 'POST', headers: aHdr,
    body: JSON.stringify({ display_name: `clickup ${username || clickupUserId} (ADR-054)` }),
  });
  const vaultId = vault.id;
  console.log(`✓ vault: ${vaultId}`);

  let credId;
  try {
    const cred = await jsonFetch('create credential', `${ANTHROPIC}/v1/vaults/${vaultId}/credentials`, {
      method: 'POST', headers: aHdr,
      body: JSON.stringify({
        display_name: `clickup ${username || clickupUserId}`,
        auth: { type: 'static_bearer', mcp_server_url: MCP_URL, token: accessToken },
      }),
    });
    credId = cred.id;
    console.log(`✓ credential: ${credId} (static_bearer -> ${MCP_URL})`);
  } catch (e) {
    // roll back the empty vault so we don't leak an orphan
    await fetch(`${ANTHROPIC}/v1/vaults/${vaultId}`, { method: 'DELETE', headers: aHdr }).catch(() => {});
    die('credential creation failed (rolled back the vault): ' + e.message);
  }

  // 7) record the mapping row
  const row = {
    clickup_user_id: clickupUserId,
    clickup_username: username,
    clickup_email: email,
    vault_id: vaultId,
    vault_credential_ids: { [MCP_URL]: credId },
    status: 'active',
  };
  if (SUPABASE_URL && SUPABASE_SERVICE_KEY) {
    await jsonFetch('insert row', `${SUPABASE_URL}/rest/v1/user_clickup_credentials`, {
      method: 'POST',
      headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
                 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify(row),
    });
    console.log('✓ user_clickup_credentials row inserted');
  } else {
    console.log('\nSUPABASE_URL / SUPABASE_SERVICE_KEY not set — run this INSERT yourself (no secret in it):\n');
    console.log(
      `insert into user_clickup_credentials (clickup_user_id, clickup_username, clickup_email, vault_id, vault_credential_ids)\n` +
      `values ('${clickupUserId}', ${sqlStr(username)}, ${sqlStr(email)}, '${vaultId}', '${JSON.stringify(row.vault_credential_ids)}'::jsonb);`
    );
  }

  console.log('\nDONE. Summary:');
  console.log(JSON.stringify({ clickup_user_id: clickupUserId, username, email, vault_id: vaultId, credential_id: credId }, null, 2));
  process.exit(0);
})().catch((e) => { console.error('\nFATAL: ' + (e && e.message ? e.message : e)); process.exit(1); });

function sqlStr(s) { return s == null ? 'null' : `'${String(s).replace(/'/g, "''")}'`; }
