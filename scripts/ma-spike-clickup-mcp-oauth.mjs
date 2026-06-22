#!/usr/bin/env node
// ma-spike-clickup-mcp-oauth.mjs — ADR-054 Option-1 PROBE (THROWAWAY): can we drive the hosted ClickUp
// MCP's OWN OAuth flow to mint a token the MCP actually accepts, and is that token durable?
//
// Background: the positive acceptance test (ma-spike-clickup-mcp.py) proved the hosted MCP rejects a token
// from our classic ClickUp OAuth app — mcp.clickup.com is its own OAuth 2.1 authorization server
// (MCP Authorization spec, DCR + PKCE, public client, scopes read/write, no refresh grant). Anthropic's
// Vault does NOT perform the consent for us (confirmed in the Managed Agents vault docs) — we must obtain
// the token ourselves. This probe does exactly that, end to end, and asks the Vault whether the MCP honors
// the result.
//
// Flow (all against mcp.clickup.com's published OAuth metadata):
//   1. Dynamic Client Registration  -> POST /oauth/register (public client, loopback redirect)
//   2. PKCE authorize                -> open /oauth/authorize?...&code_challenge=...&scope=read in the browser
//   3. capture ?code= on localhost
//   4. token exchange                -> POST /oauth/token (grant=authorization_code, code_verifier, no secret)
//      >>> prints token_type / expires_in / scope  (expires_in answers the DURABILITY question)
//   5. store it in a THROWAWAY Anthropic Vault as an mcp_oauth credential keyed to mcp.clickup.com/mcp
//   6. POST .../mcp_oauth_validate   -> the Vault performs the MCP `initialize` handshake with the token
//      >>> status "valid" => the MCP HONORS our self-driven token => OPTION 1 WORKS
//      >>> status "invalid" + mcp_probe 401 => still rejected => go OPTION 3 (self-host)
//   7. tear down the throwaway vault.
// The access token is never printed (only token_type/expires_in/scope) and never written to disk.
//
// HOW TO RUN (Windows — works in BOTH Command Prompt and PowerShell, no env-var syntax needed):
//   node scripts\ma-spike-clickup-mcp-oauth.mjs
// It will prompt for your Anthropic key with hidden input (the key is NOT echoed, NOT stored in env,
// a file, the repo, or shell history). Paste the key, press Enter. A browser opens for one ClickUp
// consent click. Alternatively, if ANTHROPIC_API_KEY is already in the environment it is used silently.
// Flags:  --port <n> (loopback port, default 8731)  --scope <s> (default "read")  --no-open

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
let KEY = (process.env.ANTHROPIC_API_KEY || '').trim();   // may be filled by a hidden prompt in main()

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function jf(label, url, init) {
  const r = await fetch(url, init);
  const t = await r.text();
  let b; try { b = t && (t.trim()[0] === '{' || t.trim()[0] === '[') ? JSON.parse(t) : t; } catch { b = t; }
  if (!r.ok) throw new Error(`${label} -> HTTP ${r.status}: ${typeof b === 'string' ? b.slice(0, 600) : JSON.stringify(b).slice(0, 600)}`);
  return b;
}

const aHdr = () => ({ 'x-api-key': KEY, 'anthropic-version': '2023-06-01', 'anthropic-beta': MA, 'content-type': 'application/json' });

// Read the Anthropic key from a HIDDEN prompt when it is not in the env — so the key never goes into a
// shell command, a file, the repo, or this terminal's scrollback. Raw-mode keystrokes, no echo.
// Control keys are matched by char code (no literal control chars in source).
function promptKeyHidden() {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) { resolve(''); return; }   // non-interactive run: caller handles the empty result
    process.stdout.write('Paste your Anthropic API key (hidden), then press Enter: ');
    stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf8');
    let buf = '';
    const finish = () => { stdin.setRawMode(false); stdin.pause(); stdin.removeListener('data', onData); process.stdout.write('\n'); resolve(buf.trim()); };
    const onData = (chunk) => {
      for (const c of chunk) {
        const code = c.charCodeAt(0);
        if (code === 13 || code === 10) return finish();        // Enter
        if (code === 3) { process.stdout.write('\n'); process.exit(1); }  // Ctrl-C
        if (code === 127 || code === 8) { buf = buf.slice(0, -1); continue; }  // backspace
        buf += c;
      }
    };
    stdin.on('data', onData);
  });
}

function openBrowser(url) {
  if (flag('--no-open')) return;
  // Open WITHOUT cmd.exe so the URL's '&' chars don't trip cmd's `start` parser
  // ("The filename, directory name, or volume label syntax is incorrect"). rundll32 / open /
  // xdg-open each take the URL as a single argv element — no shell parsing. Best-effort only;
  // the URL is also printed for manual paste.
  try {
    const [cmd, args] = process.platform === 'win32'
      ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
      : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
    spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  } catch { /* ignore — paste the printed URL manually */ }
}

function getCode(authUrl, state) {
  return new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      const u = new URL(req.url, `http://localhost:${PORT}`);
      if (u.pathname !== '/callback') { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h2>OK - wracaj do terminala.</h2>');
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
      console.log('\nOpen this URL and approve (browser may open automatically):\n\n  ' + authUrl + '\n');
      console.log(`Waiting for the redirect to ${REDIRECT} ...`);
      openBrowser(authUrl);
    });
  });
}

let vaultId = null;
(async () => {
  if (!KEY) KEY = await promptKeyHidden();
  if (!KEY) throw new Error('No Anthropic API key provided (set ANTHROPIC_API_KEY or paste at the prompt).');

  // 0) discovery (sanity — confirm the endpoints we hard-code)
  const meta = await jf('discover', `${MCP}/.well-known/oauth-authorization-server`, {});
  console.log('OK AS metadata:', JSON.stringify({ authorize: meta.authorization_endpoint, token: meta.token_endpoint, register: meta.registration_endpoint, scopes: meta.scopes_supported, grants: meta.grant_types_supported }));

  // 1) Dynamic Client Registration (public client)
  const reg = await jf('register', meta.registration_endpoint || `${MCP}/oauth/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    // minimal RFC 7591 body — proven to 200 against mcp.clickup.com/oauth/register; extra fields
    // (client_name/scope) made it 400. scope is requested at /authorize, not at registration.
    body: JSON.stringify({
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code'],
      response_types: ['code'],
    }),
  });
  const clientId = reg.client_id;
  console.log('OK registered client_id:', clientId);

  // 2) PKCE + authorize
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const state = b64url(crypto.randomBytes(16));
  const authUrl = `${meta.authorization_endpoint}?response_type=code&client_id=${encodeURIComponent(clientId)}`
    + `&redirect_uri=${encodeURIComponent(REDIRECT)}&code_challenge=${challenge}&code_challenge_method=S256`
    + `&scope=${encodeURIComponent(SCOPE)}&resource=${encodeURIComponent(MCP)}&state=${state}`;
  const code = await getCode(authUrl, state);
  console.log('OK got authorization code');

  // 4) token exchange (form-encoded; public client => code_verifier, no secret)
  const form = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier, resource: MCP });
  const tok = await jf('token', meta.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form.toString() });
  if (!tok.access_token) throw new Error('no access_token in token response: ' + JSON.stringify(tok).slice(0, 300));
  console.log('OK token obtained - DURABILITY:', JSON.stringify({ token_type: tok.token_type, expires_in: tok.expires_in ?? '(none -> non-expiring)', scope: tok.scope ?? '(unspecified)' }));

  // 4b) Does the SAME MCP-OAuth token also work on ClickUp REST? Decides one-token (identity + Block-4
  //     extraction ride the MCP token) vs two-token onboarding, and yields the consenting user's
  //     clickup_user_id for the mapping row. Tries raw Authorization then Bearer. Token itself never printed.
  let restStatus = 'n/a', whoami = null;
  for (const scheme of [tok.access_token, 'Bearer ' + tok.access_token]) {
    try {
      const r = await fetch('https://api.clickup.com/api/v2/user', { headers: { Authorization: scheme } });
      restStatus = r.status;
      if (r.ok) { const j = await r.json().catch(() => ({})); whoami = j && j.user ? { id: j.user.id, username: j.user.username } : null; break; }
    } catch (e) { restStatus = 'error:' + (e && e.message); }
  }
  console.log('OK REST /user with the MCP token -> HTTP', restStatus, '| identity:', JSON.stringify(whoami));

  // 5) throwaway vault + mcp_oauth credential (no refresh block; far-future expiry)
  const vault = await jf('vault', `${ANTHROPIC}/v1/vaults`, { method: 'POST', headers: aHdr(), body: JSON.stringify({ display_name: 'spike-clickup-mcp-oauth-054' }) });
  vaultId = vault.id;
  const cred = await jf('cred', `${ANTHROPIC}/v1/vaults/${vaultId}/credentials`, {
    method: 'POST', headers: aHdr(),
    body: JSON.stringify({ display_name: 'clickup mcp-oauth probe', auth: { type: 'mcp_oauth', mcp_server_url: MCP_URL, access_token: tok.access_token, expires_at: '2099-12-31T23:59:59Z' } }),
  });
  console.log('OK stored credential', cred.id, 'in throwaway vault', vaultId);

  // 6) the decisive test — does the MCP honor it?
  const val = await jf('validate', `${ANTHROPIC}/v1/vaults/${vaultId}/credentials/${cred.id}/mcp_oauth_validate`, { method: 'POST', headers: aHdr() });
  console.log('\n=== VERDICT ===');
  console.log('  mcp_oauth_validate status:', val.status);
  if (val.mcp_probe) console.log('  mcp_probe:', JSON.stringify(val.mcp_probe).slice(0, 500));
  if (val.status === 'valid') console.log('  => OPTION 1 WORKS: the hosted ClickUp MCP HONORS a token from its own OAuth flow. Rework onboarding to this flow.');
  else console.log('  => OPTION 1 FAILS (status ' + val.status + '): go OPTION 3 (self-host a thin ClickUp MCP on our REST token).');
})().catch((e) => { console.error('\nFATAL: ' + (e && e.message ? e.message : e)); process.exitCode = 1; })
  .finally(async () => {
    if (vaultId) { try { await fetch(`${ANTHROPIC}/v1/vaults/${vaultId}`, { method: 'DELETE', headers: aHdr() }); console.log('\n(cleanup) deleted throwaway vault', vaultId); } catch {} }
  });
