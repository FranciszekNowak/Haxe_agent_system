#!/usr/bin/env node
// test-image-delivery.mjs — exercise the multimodal image-delivery path end-to-end.
//
// Generates real images through Invoke Model (v1) (returns base64), builds the in-memory
// base64 image_manifest + a rendered_delta with {type:'image_ref'} placeholders, and drives
// Post Reply (v1) Stage C — which converts base64->binary, uploads each as a ClickUp task
// attachment, and posts ONE comment with the proven inline op {type:'attachment',{id,url}}
// (ADR-036 Block 10). Base64 stays in-process (never printed). Useful whenever you touch the
// delivery contract — Block 10 (Stage C), Block 11 (resolver/assembler), Block 12 (end-to-end).
//
// What it proves: 2 generated images render inline; run_payload_bytes + size footer; no base64
// in the DB (check the agent_runs row separately); Record Artifact writes the comment id.
//
// Usage:
//   N8N_API_KEY=...  node scripts/test-image-delivery.mjs           # 2-image delivery
//   N8N_API_KEY=...  node scripts/test-image-delivery.mjs --text    # text-only regression
//   env: N8N_API_URL  (default https://agents.haxe.ai/api/v1)
//        TEST_TASK     (default 869dhad2q — Lista testy AI)
//        TEST_REVIEWER (default 2521617 — Franciszek)
// After it runs, inspect node-by-node:  node scripts/inspect-execution.mjs <execId>
// NOTE: each generated/uploaded image becomes a task attachment ClickUp's API CANNOT delete
// (no delete-attachment endpoint) — test litter accumulates on TEST_TASK; tidy in the UI.

const BASE = process.env.N8N_API_URL || 'https://agents.haxe.ai/api/v1';
const KEY = process.env.N8N_API_KEY;
if (!KEY) { console.error('FATAL: N8N_API_KEY not set'); process.exit(2); }
const H = { 'X-N8N-API-KEY': KEY, 'Content-Type': 'application/json' };
const WEBHOOK_BASE = BASE.replace(/\/api\/v1\/?$/, '') + '/webhook';
const INVOKE_MODEL = 'XcOIVdZnVCCWNPeb';
const POST_REPLY = 't17moGs7Vxo5ZcFv';
const TASK = process.env.TEST_TASK || '869dhad2q';
const REVIEWER = process.env.TEST_REVIEWER || '2521617';
const TEXT_ONLY = process.argv.includes('--text');

const api = async (path, init = {}) => {
  const r = await fetch(`${BASE}${path}`, { headers: H, ...init });
  const t = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status} ${init.method || 'GET'} ${path}: ${t.slice(0, 400)}`);
  return t ? JSON.parse(t) : {};
};

// fire a When-Called sub-workflow with pinned inputs via a temporary webhook harness; return its output
async function callViaHarness(targetId, inputs, timeoutSec = 300) {
  const target = await api(`/workflows/${targetId}`);
  const trig = (target.nodes || []).find((n) => n.type === 'n8n-nodes-base.executeWorkflowTrigger');
  const declared = trig?.parameters?.workflowInputs?.values?.map((v) => v.name).filter(Boolean) || Object.keys(inputs);
  const inputMap = {};
  for (const n of declared) inputMap[n] = `={{ $json.body['${n}'] }}`;
  const path = `imgdel-${Date.now()}-${Math.floor(performance.now())}`;
  const harness = {
    name: `_TMP test-image-delivery ${target.name}`,
    nodes: [
      { id: 'wh', name: 'Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [0, 300],
        parameters: { httpMethod: 'POST', path, responseMode: 'responseNode', options: {} } },
      { id: 'call', name: 'Call Target', type: 'n8n-nodes-base.executeWorkflow', typeVersion: 1.3, position: [260, 300],
        parameters: { workflowId: { __rl: true, value: targetId, mode: 'list' },
          workflowInputs: { mappingMode: 'defineBelow', value: inputMap, matchingColumns: [],
            attemptToConvertTypes: false, convertFieldsToString: false }, options: {} } },
      { id: 'resp', name: 'Respond', type: 'n8n-nodes-base.respondToWebhook', typeVersion: 1.1, position: [520, 300],
        parameters: { respondWith: 'firstIncomingItem', options: {} } },
    ],
    connections: { Webhook: { main: [[{ node: 'Call Target', type: 'main', index: 0 }]] },
      'Call Target': { main: [[{ node: 'Respond', type: 'main', index: 0 }]] } },
    settings: { executionOrder: 'v1' },
  };
  const created = await api('/workflows', { method: 'POST', body: JSON.stringify(harness) });
  try {
    await api(`/workflows/${created.id}/activate`, { method: 'POST', body: '{}' });
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), timeoutSec * 1000);
    try {
      const r = await fetch(`${WEBHOOK_BASE}/${path}`, { method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify(inputs), signal: ctrl.signal });
      const t = await r.text();
      if (!r.ok) throw new Error(`webhook HTTP ${r.status}: ${t.slice(0, 300)}`);
      try { return JSON.parse(t); } catch { return t; }
    } finally { clearTimeout(to); }
  } finally {
    try { await api(`/workflows/${created.id}`, { method: 'DELETE' }); } catch {}
  }
}

const genImage = async (prompt) => {
  console.log(`  generating: "${prompt}"`);
  const out = await callViaHarness(INVOKE_MODEL, {
    prompt, impact: 'Niski', modality: 'image', requested_modality_of_output: 'image',
    task_type: 'test', clickup_task_id: TASK, triggered_by: 'image_gen',
    invocation_type: 'explicit', caller_user_id: REVIEWER,
  });
  const b64 = out.b64_json || '';
  console.log(`    -> model=${out.model} modality=${out.output_modality} b64=${b64.length} chars mime=${out.mime} cost_pln=${out.cost_pln}`);
  return { b64, mime: out.mime || 'image/png' };
};

if (TEXT_ONLY) {
  console.log('== TEXT-ONLY regression ==');
  const out = await callViaHarness(POST_REPLY, {
    completion: '# Test tekstowy\n\nZwykła odpowiedź tekstowa, bez obrazów (regresja ścieżki tekstowej + pole rozmiaru).',
    model: 'haxe-sonnet-4-6-direct', cost_pln: '0.01', clickup_task_id: TASK, reviewer_user_id: REVIEWER,
    triggering_comment_id: '', web_sources: '[]', image_manifest: '[]', rendered_delta: '',
  });
  console.log('Post Reply return:', JSON.stringify(out).slice(0, 300));
  process.exit(0);
}

console.log('== IMAGE delivery (2 generated images) ==');
const a = await genImage('minimalistyczna płaska ikona: czerwone jabłko na białym tle');
const b = await genImage('minimalistyczna płaska ikona: niebieski kubek kawy na białym tle');
if (!a.b64 || !b.b64) { console.error('FATAL: generation returned empty b64'); process.exit(1); }

const image_manifest = [
  { placeholder_id: 'img1', b64: a.b64, mime: a.mime, caption: 'jabłko', alt: 'czerwone jabłko' },
  { placeholder_id: 'img2', b64: b.b64, mime: b.mime, caption: 'kawa', alt: 'niebieski kubek' },
];
const rendered_delta = [
  { text: '# Test dostawy obrazów\n' },
  { text: 'Pierwszy wygenerowany obraz:\n' },
  { type: 'image_ref', placeholder_id: 'img1' },
  { text: '\nDrugi wygenerowany obraz:\n' },
  { type: 'image_ref', placeholder_id: 'img2' },
  { text: '\n—\nDo weryfikacji — nie finalizuje zadania.\n' },
];

console.log('driving Post Reply (v1) Stage C with 2-image manifest...');
const out = await callViaHarness(POST_REPLY, {
  completion: '', model: 'gemini-2.5-flash-image', cost_pln: '0',
  clickup_task_id: TASK, reviewer_user_id: REVIEWER, triggering_comment_id: '',
  web_sources: '[]', image_manifest: JSON.stringify(image_manifest), rendered_delta: JSON.stringify(rendered_delta),
});
console.log('Post Reply return:', JSON.stringify(out).slice(0, 400));
console.log('\n✓ done — check the comment on task', TASK);
