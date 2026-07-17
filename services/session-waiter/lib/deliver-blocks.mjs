// deliver-blocks.mjs — ADR-072 (amended): parse a managed agent's deliver_output(markdown) into the
// renderer's block array.
//
// The agent delivers its final answer as ONE flat-scalar tool call — deliver_output(markdown) — where
// `markdown` is the whole answer as ordinary markdown prose, with inline standard-markdown image
// references (![opis](file_id)) for generated/attached images. There is no nested container the model can
// stringify, so the stringified-`blocks` misescape class (ADR-063 amendment / ADR-071) is structurally
// gone; and there is no multi-call segment protocol (the retired attach_* tools) the model resists — it
// just writes its answer, which is how managed agents are designed to respond.
//
// This is the PURE assembly core: no I/O, no logging, no server bootstrap — unit-testable directly (see
// test/deliver-blocks.test.mjs) without importing app.mjs (which boots the service on import).
//
// What we extract is the ![alt](ref) image pattern — trivial and robust: a malformed/missing reference
// renders as literal text (visible, correctable), never a crash or an empty/corrupt delivery. That is a
// categorically different thing from hand-parsing a model-authored JSON array of prose.

const str = (v) => (typeof v === 'string' ? v : (v == null ? '' : String(v)));

// Standard markdown image: ![alt](ref). ref is a single token (file_id or attachment ref/url) with no
// spaces; alt is optional. We ignore any title after the ref.
const IMG_RE = /!\[([^\]]*)\]\(\s*([^)\s]+)[^)]*\)/g;

// Backslide detection: a model that ignores the contract may serialize the OLD nested blocks array as a
// JSON string into `markdown`. Detect a valid top-level JSON array of block-like objects so the caller can
// unwrap it (so the user still gets content) and raise a loud WARN. Valid JSON only — no jsonrepair.
export function blocksArrayInMarkdown(md) {
  const t = str(md).trim();
  if (!(t.startsWith('[') && t.endsWith(']'))) return null;
  let arr;
  try { arr = JSON.parse(t); } catch (e) { return null; }
  if (!Array.isArray(arr) || arr.length === 0) return null;
  if (!arr.every((b) => b && typeof b === 'object' && typeof b.type === 'string')) return null;
  return arr;
}

// Blank out code spans / fenced code blocks (replace their chars with spaces, preserving length + newlines)
// so an ![](…) written INSIDE code — e.g. an agent documenting the contract as `![opis](file_id)` — is NOT
// mistaken for a real image. Matches on the masked copy have intact alt/ref (only code regions are blanked);
// text slices come from the ORIGINAL string, so the code example stays verbatim in the rendered prose.
function maskCode(s) {
  const out = s.split('');
  const blank = (a, b) => { for (let i = a; i < b && i < out.length; i++) { if (out[i] !== '\n') out[i] = ' '; } };
  let m;
  const fence = /(`{3,}|~{3,})[\s\S]*?\1/g;         // ```…``` / ~~~…~~~
  while ((m = fence.exec(s)) !== null) blank(m.index, m.index + m[0].length);
  const s2 = out.join('');
  const inline = /`[^`\n]*`/g;                       // `…` inline code (single backtick)
  while ((m = inline.exec(s2)) !== null) blank(m.index, m.index + m[0].length);
  return out.join('');
}

// Split markdown prose into the renderer's ordered text/image block array. Image `mode` is inferred by the
// renderer from the ref (file_-prefixed => generated; else embed against the input-attachment refs), so we
// only need to pass `ref` (and caption/alt from the markdown alt text).
export function markdownToBlocks(md) {
  const s = str(md);
  const masked = maskCode(s);
  const blocks = [];
  let last = 0, m, order = 1;
  IMG_RE.lastIndex = 0;
  while ((m = IMG_RE.exec(masked)) !== null) {
    const before = s.slice(last, m.index);
    if (before.trim() !== '') blocks.push({ type: 'text', md: before.replace(/\s+$/, ''), order: order++ });
    const alt = str(m[1]).trim();
    const ref = str(m[2]).trim();
    const img = { type: 'image', ref, order: order++ };
    if (alt !== '') { img.caption = alt; img.alt = alt; }
    blocks.push(img);
    last = m.index + m[0].length;
  }
  const tail = s.slice(last);
  if (tail.trim() !== '') blocks.push({ type: 'text', md: tail.replace(/^\s+/, ''), order: order++ });
  return blocks;
}

// Assemble the final block array from deliver_output(markdown) and raise proactive degradation WARNs on a
// side channel (the caller fires them via Post Alert; the main result path is unaffected).
// opts.generateImageUsed: whether generate_image ran in the session (to catch an orphaned generated image).
export function parseMarkdownDelivery(deliverCall, opts) {
  const warnings = [];
  const md = str(deliverCall && deliverCall.input && deliverCall.input.markdown);
  let blocks;
  const arr = blocksArrayInMarkdown(md);
  if (arr) {
    warnings.push({
      source: 'managed-agents/deliver-blocks-array-in-markdown',
      err: 'deliver_output.markdown zawiera zserializowana tablice blokow JSON zamiast prozy markdown — rozpakowano awaryjnie, aby odpowiedz nie byla pusta. Sprawdz kontrakt persony (CONV) — model powinien pisac zwykla proze z ![opis](file_id).',
      severity: 'WARN',
    });
    blocks = arr; // renderer tolerates text/image/doc blocks; a generate-block without a file_id renders
                  // as a failed embed (its own WARN) while the text still renders.
  } else if (md.trim() !== '') {
    blocks = markdownToBlocks(md);
  } else {
    blocks = [];
  }
  const hasImage = blocks.some((b) => b && b.type === 'image');
  if (!hasImage && opts && opts.generateImageUsed) {
    warnings.push({
      source: 'managed-agents/generated-image-orphaned',
      err: 'W sesji wywolano generate_image, ale w dostarczonej odpowiedzi nie ma zadnego odwolania do obrazu (![opis](file_...)) — wygenerowany obraz NIE zostal dostarczony do odbiorcy.',
      severity: 'WARN',
    });
  }
  return { blocks, warnings };
}
