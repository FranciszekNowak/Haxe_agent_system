// deliver-blocks.mjs — ADR-072: assemble a managed agent's final answer into the renderer's block array.
//
// The agent delivers its answer through FLAT-SCALAR tool calls — deliver_output(markdown) plus
// attach_text / attach_generated_image / attach_input_image — which the session-waiter accumulates from the
// durable session event log. Nothing here is a nested container the model can stringify, so the
// stringified-`blocks` misescape class (ADR-063 amendment / ADR-071) is structurally gone.
//
// This is the PURE assembly core: no I/O, no logging, no server bootstrap — so it is unit-testable directly
// (see test/deliver-blocks.test.mjs) without importing app.mjs (which boots the service on import).
//
// DUAL-READ (ADR-072 Block 1, transitional): until the contract flips (Block 2), live agents still emit the
// LEGACY nested `blocks` array on deliver_output. buildOutputBlocks() prefers the flat shape and falls back
// to the legacy array via extractDeliverBlocks() so nothing breaks mid-rollout. The legacy path + jsonrepair
// are deleted in Block 5 once the flat contract is the only path.

import { jsonrepair } from 'jsonrepair';

export const ATTACH_TOOL_NAMES = ['attach_text', 'attach_generated_image', 'attach_input_image'];

const numOr = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const str = (v) => (typeof v === 'string' ? v : (v == null ? '' : String(v)));

// caption/alt only when provided (the renderer tolerates their absence: `b.caption || ''`).
function withMeta(block, inp) {
  if (inp.caption != null && str(inp.caption) !== '') block.caption = str(inp.caption);
  if (inp.alt != null && str(inp.alt) !== '') block.alt = str(inp.alt);
  return block;
}

// LEGACY (pre-ADR-072): deliver_output.input.blocks is a real array — OR a JSON string the model
// hand-serialized (sometimes invalid: an unescaped `"` inside Polish „…" quotes). jsonrepair recovers the
// common malformations; on total failure returns []. Deleted in Block 5.
export function extractDeliverBlocks(picked) {
  if (!picked || !picked.input) return [];
  let b = (picked.input.blocks !== undefined) ? picked.input.blocks : picked.input;
  if (typeof b === 'string') {
    try { b = JSON.parse(b); }
    catch (e) { try { b = JSON.parse(jsonrepair(b)); } catch (e2) { return []; } }
  }
  return Array.isArray(b) ? b : [];
}

// Collect the flat delivery-block tool calls from the durable event log, in event order. Answered or not —
// their presence in the log IS the agent's delivered content (the waiter acks them locally while driving).
export function collectAttachEvents(events) {
  const out = [];
  for (const e of (events || [])) {
    if (e && e.type === 'agent.custom_tool_use' && typeof e.name === 'string' && e.name.indexOf('attach_') === 0) out.push(e);
  }
  return out;
}

// NEW flat assembly: deliver_output(markdown) + attach_* events -> the renderer's internal block array
// (text: {type,md,order}; image: {type,mode,ref,source_ref?,caption?,alt?,order}). Ordering: each block's
// explicit `order` when given, else its call sequence; the result carries a final positional `order` (1-based)
// so `Render Agent Output -> Parse Blocks` renders them in the intended sequence (interleaving preserved).
export function assembleFlatBlocks(deliverCall, attachEvents) {
  const raw = [];
  const dInput = (deliverCall && deliverCall.input) || {};
  const md = str(dInput.markdown).trim();
  if (md !== '') raw.push({ order: numOr(dInput.order, 0), block: { type: 'text', md: str(dInput.markdown) } });
  let seq = 1;
  for (const e of (attachEvents || [])) {
    const inp = e.input || {};
    const order = numOr(inp.order, seq);
    if (e.name === 'attach_text') {
      if (str(inp.md).trim() !== '') raw.push({ order, block: withMeta({ type: 'text', md: str(inp.md) }, inp) });
    } else if (e.name === 'attach_generated_image') {
      if (str(inp.ref) !== '') raw.push({ order, block: withMeta({ type: 'image', mode: 'generate', ref: str(inp.ref) }, inp) });
    } else if (e.name === 'attach_input_image') {
      if (str(inp.ref) !== '' || str(inp.source_ref) !== '') {
        const block = { type: 'image', mode: 'embed_input' };
        if (str(inp.ref) !== '') block.ref = str(inp.ref);
        if (str(inp.source_ref) !== '') block.source_ref = str(inp.source_ref);
        raw.push({ order, block: withMeta(block, inp) });
      }
    }
    seq += 1;
  }
  const sorted = raw.map((r, i) => ({ ...r, i })).sort((a, b) => (a.order - b.order) || (a.i - b.i));
  return sorted.map((r, i) => ({ ...r.block, order: i + 1 }));
}

// Flat-first, legacy fallback. Empty flat result AND no legacy blocks => [] (a genuinely empty delivery,
// which the caller gates against the ADR-069 doc-only case via the Files API before treating it as empty).
export function buildOutputBlocks(deliverCall, attachEvents) {
  const flat = assembleFlatBlocks(deliverCall, attachEvents);
  if (flat.length > 0) return flat;
  return extractDeliverBlocks(deliverCall);
}
