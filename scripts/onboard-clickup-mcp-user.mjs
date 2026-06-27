#!/usr/bin/env node
// onboard-clickup-mcp-user.mjs — ADR-054 Block 1 (Option A) INTERIM onboarder for the DISCOVERY token.
//
// WHY THIS EXISTS (the allowlist gate, 2026-06-22). The hosted ClickUp MCP is its own OAuth 2.1 server and
// now ALLOWLISTS which integrations may register a real HTTPS redirect URI: DCR with our webhook redirect
// (https://agents.haxe.ai/...) returns 400 "Your integration is not currently allowlisted", so the self-serve
// onboarding webhook's MCP phase is blocked until ClickUp approves the allowlist form. BUT ClickUp still allows
// the OAuth LOOPBACK developer path (DCR with http://localhost:<port>/callback returns a client_id, and the
// resulting token is honored by the MCP — proven by scripts/ma-spike-clickup-mcp-oauth.mjs). So this script
// mints a user's MCP-OAuth DISCOVERY token via the loopback flow and stores it exactly where the webhook would
// have: a per-user Anthropic Vault static_bearer credential keyed to https://mcp.clickup.com/mcp. The webhook
// stays the production path for when allowlisting lands; this is the interim/dev onboarder + the way to test
// Blocks 2-5 now. (The CLASSIC REST token — identity + Block-4 extraction — is handled separately: it is
// already captured for users who hit the webhook's classic phase, stored in Supabase Vault.)
//
// IDENTITY is passed in (--clickup-user-id), because the MCP-OAuth token is 401 on ClickUp REST and cannot
// self-identify. For Franciszek that is 2521617; for a test user, read it from ClickUp (or the webhook's
// classic phase, which stored clickup_rest_token_<id>).
//
// Flow (all loopback, no allowlist needed):
//   1. DCR register at https://mcp.clickup.com/oauth/register (public client, loopback redirect),
//   2. PKCE S256 (verifier + challenge),
//   3. open https://mcp.clickup.com/oauth/authorize?... in the browser, capture ?code= on localhost,
//   4. token exchange at https://mcp.clickup.com/oauth/token (code_verifier, no secret) -> MCP access_token,
//   5. create a per-user Anthropic Vault + a static_bearer credential { mcp.clickup.com/mcp, <token> },
//   6. upsert the user_data_and_config row (PostgREST if SUPABASE_* set, else print the INSERT SQL).
// The access token is NEVER printed or written to disk — it is write-only in the Vault.
//
// Usage (run on a machine WITH a browser, logged into ClickUp AS the user being onboarded):
//   set ANTHROPIC_API_KEY=...                                   (required — creates the Vault credential)
//   set SUPABASE_URL=https://hkeslnosxibeuesxndnz.supabase.co   (optional — else the upsert SQL is printed)
//   set SUPABASE_SERVICE_KEY=...                                (optional, service_role — bypasses RLS)
//   node scripts/onboard-clickup-mcp-user.mjs --clickup-user-id 2521617 --username "Franciszek Nowak" --email franciszek.nowak@haxe.com
//
// Flags:  --clickup-user-id <id> (required)  --username <u>  --email <e>
//         --port <n> (loopback port, default 8731)  --scope <s> (default "read")  --no-open
//
// Then confirm discovery works:  SPIKE_VAULT_ID=<printed vault> python3 scripts/ma-spike-clickup-mcp.py
// (run on the VPS so ANTHROPIC_API_KEY comes from .env and is never echoed).

import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const PORT = Number(opt('--port', '8731'));
const SCOPE = opt('--scope', 'read');
const REDIRECT = `http://localhost:${PORT}/callback`;
const MCP = 'https://mcp.clickup.com';
const MCP_URL = 'https://mcp.clickup.com/mcp';
const ANTHROPIC = 'https://api.anthropic.com';
const MA = 'managed-agents-2026-04-01';

const CLICKUP_USER_ID = opt('--clickup-user-id', '');
const USERNAME = opt('--username', '');
const EMAIL = opt('--email', '');
const KEY = (process.env.ANTHROPIC_API_KEY || '').trim();
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

function die(msg) { console.error('FATAL: ' + msg); process.exit(2); }
if (!CLICKUP_USER_ID) die('--clickup-user-id <id> is required (the ClickUp member id; the MCP token cannot self-identify)');
if (!KEY) die('ANTHROPIC_API_KEY not set (needed to create the Vault credential)');

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const sqlStr = (s) => (s == null || s === '') ? 'null' : `'${String(s).replace(/'/g, "''")}'`;

async function jf(label, url, init) {
  const r = await fetch(url, init);
  const t = await r.text();
  let b; try { b = t && (t.trim()[0] === '{' || t.trim()[0] === '[') ? JSON.parse(t) : t; } catch { b = t; }
  if (!r.ok) throw new Error(`${label} -> HTTP ${r.status}: ${typeof b === 'string' ? b.slice(0, 600) : JSON.stringify(b).slice(0, 600)}`);
  return b;
}
const aHdr = () => ({ 'x-api-key': KEY, 'anthropic-version': '2023-06-01', 'anthropic-beta': MA, 'content-type': 'application/json' });

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
      res.end('<h2>ClickUp MCP connected ✓ — wróć do terminala.</h2>');
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
      console.log('\nOpen this URL and approve (the browser may open automatically). Approve AS the user you are onboarding:\n\n  ' + authUrl + '\n');
      console.log(`Waiting for the redirect to ${REDIRECT} ...`);
      openBrowser(authUrl);
    });
  });
}

let vaultId = null;
(async () => {
  // 0) optional duplicate guard (avoid orphan vaults on re-run; clear the row first to re-onboard)
  if (SUPABASE_URL && SUPABASE_SERVICE_KEY) {
    const existing = await jf('check existing row',
      `${SUPABASE_URL}/rest/v1/user_data_and_config?clickup_user_id=eq.${encodeURIComponent(CLICKUP_USER_ID)}&select=clickup_user_id,status,vault_id`,
      { headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` } });
    if (Array.isArray(existing) && existing.length) {
      die(`a row already exists for user ${CLICKUP_USER_ID} (status ${existing[0].status}, vault ${existing[0].vault_id}). `
        + `Clear it (delete the row + its Vault) before re-onboarding to avoid an orphan vault.`);
    }
  }

  // 1) DCR (public client, loopback redirect — works without allowlisting)
  const reg = await jf('register', `${MCP}/oauth/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none', grant_types: ['authorization_code'], response_types: ['code'] }),
  });
  const clientId = reg.client_id;
  console.log('✓ registered loopback client');

  // 2) PKCE + 3) authorize
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const state = b64url(crypto.randomBytes(16));
  const authUrl = `${MCP}/oauth/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}`
    + `&redirect_uri=${encodeURIComponent(REDIRECT)}&code_challenge=${challenge}&code_challenge_method=S256`
    + `&scope=${encodeURIComponent(SCOPE)}&resource=${encodeURIComponent(MCP)}&state=${state}`;
  const code = await getCode(authUrl, state);
  console.log('✓ authorization code captured');

  // 4) token exchange (public client => code_verifier, no secret)
  const form = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier, resource: MCP });
  const tok = await jf('token', `${MCP}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form.toString() });
  if (!tok.access_token) die('token exchange returned no access_token: ' + JSON.stringify(tok).slice(0, 300));
  console.log('✓ MCP-OAuth token obtained (not displayed) — expires_in:', tok.expires_in ?? '(none)');

  // 5) per-user Anthropic Vault + static_bearer credential
  const vault = await jf('create vault', `${ANTHROPIC}/v1/vaults`, {
    method: 'POST', headers: aHdr(),
    body: JSON.stringify({ display_name: `clickup ${USERNAME || CLICKUP_USER_ID} (ADR-054)` }),
  });
  vaultId = vault.id;
  console.log('✓ vault:', vaultId);

  let credId;
  try {
    const cred = await jf('create credential', `${ANTHROPIC}/v1/vaults/${vaultId}/credentials`, {
      method: 'POST', headers: aHdr(),
      body: JSON.stringify({ display_name: `clickup ${USERNAME || CLICKUP_USER_ID} (U)`, auth: { type: 'static_bearer', mcp_server_url: MCP_URL, token: tok.access_token } }),
    });
    credId = cred.id;
    console.log('✓ credential:', credId, '(static_bearer ->', MCP_URL + ')');
  } catch (e) {
    await fetch(`${ANTHROPIC}/v1/vaults/${vaultId}`, { method: 'DELETE', headers: aHdr() }).catch(() => {});
    die('credential creation failed (rolled back the vault): ' + e.message);
  }

  // 6) upsert the mapping row (or print the SQL)
  const credIds = { [MCP_URL]: credId };
  if (SUPABASE_URL && SUPABASE_SERVICE_KEY) {
    await jf('upsert row', `${SUPABASE_URL}/rest/v1/user_data_and_config`, {
      method: 'POST',
      headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ clickup_user_id: CLICKUP_USER_ID, clickup_username: USERNAME, clickup_email: EMAIL, vault_id: vaultId, vault_credential_ids: credIds, status: 'active' }),
    });
    console.log('✓ user_data_and_config row upserted');
  } else {
    console.log('\nSUPABASE_* not set — send this to the operator/assistant to run (no secret in it):\n');
    console.log(
      `insert into user_data_and_config (clickup_user_id, clickup_username, clickup_email, vault_id, vault_credential_ids)\n` +
      `values ('${CLICKUP_USER_ID}', ${sqlStr(USERNAME)}, ${sqlStr(EMAIL)}, '${vaultId}', '${JSON.stringify(credIds)}'::jsonb)\n` +
      `on conflict (clickup_user_id) do update set vault_id=excluded.vault_id, vault_credential_ids=excluded.vault_credential_ids, status='active', updated_at=now(), revoked_at=null;`
    );
  }

  console.log('\nDONE. Confirm discovery works with this vault (run on the VPS so the key comes from .env):');
  console.log(`  set -a; . /opt/haxe-agents/.env; set +a; SPIKE_VAULT_ID=${vaultId} python3 /tmp/ma-spike-clickup-mcp.py`);
  console.log('\nSummary:', JSON.stringify({ clickup_user_id: CLICKUP_USER_ID, username: USERNAME, vault_id: vaultId, credential_id: credId }));
  process.exit(0);
})().catch((e) => {
  console.error('\nFATAL: ' + (e && e.message ? e.message : e));
  if (vaultId) console.error(`(note: vault ${vaultId} may have been created — delete it if onboarding did not complete)`);
  process.exit(1);
});
