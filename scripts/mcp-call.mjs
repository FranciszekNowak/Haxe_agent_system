#!/usr/bin/env node
// mcp-call.mjs — call a self-hosted n8n MCP Server Trigger endpoint over its HTTP+SSE transport
// (MCP protocol 2024-11-05), as an MCP client/harness would: open SSE (bearer) -> read the `endpoint`
// event -> POST initialize -> tools/list -> tools/call. Built for the ADR-055 Block 5.2 DoD (drive the
// image MCP endpoint directly). Node 18+ (global fetch). Reads MCP_BEARER from env.
//
// Usage: MCP_BEARER=... node scripts/mcp-call.mjs [toolName] [promptOrArgsJson]
//   default toolName=generate_image; arg is treated as {prompt:<arg>} unless it parses as a JSON object.

const BASE = process.env.MCP_BASE || 'https://agents.skalus.com';
const MCP_PATH = process.env.MCP_PATH || '/mcp/haxe-image-gen';
const BEARER = process.env.MCP_BEARER;
const TOOL = process.argv[2] || 'generate_image';
const ARG = process.argv[3] || 'A red apple on a white background, clean studio product photo';
let toolArgs;
try { const o = JSON.parse(ARG); toolArgs = (o && typeof o === 'object') ? o : { prompt: ARG }; }
catch { toolArgs = { prompt: ARG }; }

let endpoint = null;
const waiters = new Map();
const buffered = new Map();
function deliver(obj) {
  const id = obj.id;
  if (waiters.has(id)) { waiters.get(id)(obj); waiters.delete(id); } else buffered.set(id, obj);
}
function waitId(id, ms) {
  if (buffered.has(id)) { const o = buffered.get(id); buffered.delete(id); return Promise.resolve(o); }
  return new Promise((r) => { const t = setTimeout(() => { waiters.delete(id); r(null); }, ms); waiters.set(id, (o) => { clearTimeout(t); r(o); }); });
}

async function sse() {
  const res = await fetch(BASE + MCP_PATH, { headers: { Authorization: 'Bearer ' + BEARER, Accept: 'text/event-stream' } });
  if (!res.ok) { console.log('SSE GET failed', res.status, (await res.text()).slice(0, 300)); process.exit(1); }
  const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = ''; let event = null;
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, ''); buf = buf.slice(idx + 1);
      if (line === '') { event = null; continue; }
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) {
        const data = line.slice(5).trim();
        if (event === 'endpoint') endpoint = data;
        else { try { deliver(JSON.parse(data)); } catch { /* keepalive/non-json */ } }
      }
    }
  }
}

async function post(msg) {
  let url = endpoint; if (url.startsWith('/')) url = BASE + url;
  const r = await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer ' + BEARER, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify(msg) });
  const body = await r.text();
  try { const o = JSON.parse(body); if (o && o.id === msg.id) return o; } catch { /* delivered via SSE */ }
  return null;
}
async function rpc(id, method, params, ms = 240000) { const inline = await post({ jsonrpc: '2.0', id, method, params }); if (inline) return inline; return waitId(id, ms); }

async function main() {
  if (!BEARER) { console.log('NO MCP_BEARER'); process.exit(2); }
  sse();
  for (let i = 0; i < 50 && !endpoint; i++) await new Promise((r) => setTimeout(r, 200));
  if (!endpoint) { console.log('no endpoint event received (auth/path?)'); process.exit(1); }
  console.log('endpoint:', endpoint);

  const init = await rpc(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'adr055-b52', version: '1' } }, 30000);
  console.log('\ninitialize ->', JSON.stringify(init?.result ?? init).slice(0, 500));

  await post({ jsonrpc: '2.0', method: 'notifications/initialized' });

  const tl = await rpc(2, 'tools/list', {}, 30000);
  const tools = tl?.result?.tools || [];
  console.log('\ntools/list ->', tools.length, 'tool(s)');
  for (const t of tools) {
    console.log('  name:', t.name);
    console.log('  desc:', (t.description || '').slice(0, 140));
    console.log('  inputSchema:', JSON.stringify(t.inputSchema || {}).slice(0, 800));
  }

  console.log('\ntools/call', TOOL, 'args=', JSON.stringify(toolArgs));
  const t0 = Date.now();
  const call = await rpc(3, 'tools/call', { name: TOOL, arguments: toolArgs }, 240000);
  console.log('  elapsed', Math.round((Date.now() - t0) / 1000) + 's');
  const res = call?.result ?? call;
  const content = res?.content;
  if (Array.isArray(content)) { for (const c of content) if (c.type === 'text') console.log('  result text:', (c.text || '').slice(0, 1400)); }
  else console.log('  result:', JSON.stringify(res).slice(0, 1400));
  process.exit(0);
}
main();
