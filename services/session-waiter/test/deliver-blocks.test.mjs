// Unit tests for the ADR-072 flat delivery-block assembly. Pure — no server boot, no I/O.
//   node --test services/session-waiter/test/deliver-blocks.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildOutputBlocks,
  assembleFlatBlocks,
  collectAttachEvents,
  extractDeliverBlocks,
} from '../lib/deliver-blocks.mjs';

const deliver = (input) => ({ type: 'agent.custom_tool_use', name: 'deliver_output', id: 'sevt_d', input });
const attach = (name, input, id = 'sevt_' + name) => ({ type: 'agent.custom_tool_use', name, id, input });

// ---- collectAttachEvents ----
test('collectAttachEvents keeps only attach_* custom_tool_use, in order', () => {
  const events = [
    { type: 'agent.message', content: [] },
    attach('attach_text', { md: 'a' }, 's1'),
    { type: 'agent.custom_tool_use', name: 'generate_image', id: 's2', input: {} },
    attach('attach_generated_image', { ref: 'file_x' }, 's3'),
    deliver({ markdown: 'x' }),
  ];
  const got = collectAttachEvents(events).map((e) => e.id);
  assert.deepEqual(got, ['s1', 's3']);
});
test('collectAttachEvents tolerates null/empty', () => {
  assert.deepEqual(collectAttachEvents(null), []);
  assert.deepEqual(collectAttachEvents([]), []);
});

// ---- NEW flat path ----
test('text-only: deliver_output(markdown) -> one ordered text block', () => {
  const blocks = buildOutputBlocks(deliver({ markdown: '## Wyniki\nGotowe.' }), []);
  assert.deepEqual(blocks, [{ type: 'text', md: '## Wyniki\nGotowe.', order: 1 }]);
});

test('Polish typographic quotes survive verbatim (the ADR-071 failure input, now trivial)', () => {
  const md = 'Krok w stronę „realistyczne", o który prosiłeś — „brain fry": 10%.';
  const blocks = buildOutputBlocks(deliver({ markdown: md }), []);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].md, md); // no parsing, no escaping — the API delivered it as a JS string
});

test('interleaving: text, generated image, text — ordered by `order`, positional order rewritten', () => {
  const events = [
    attach('attach_generated_image', { ref: 'file_img1', caption: 'Plansza', alt: 'Wizualizacja', order: 2 }),
    attach('attach_text', { md: 'Poniżej rekomendacje.', order: 3 }),
    deliver({ markdown: 'Wstęp.', order: 1 }),
  ];
  const blocks = assembleFlatBlocks(deliver({ markdown: 'Wstęp.', order: 1 }), collectAttachEvents(events));
  assert.deepEqual(blocks, [
    { type: 'text', md: 'Wstęp.', order: 1 },
    { type: 'image', mode: 'generate', ref: 'file_img1', caption: 'Plansza', alt: 'Wizualizacja', order: 2 },
    { type: 'text', md: 'Poniżej rekomendacje.', order: 3 },
  ]);
});

test('image refs: generate carries ref; embed_input carries ref/source_ref; caption/alt omitted when absent', () => {
  const attaches = [
    attach('attach_generated_image', { ref: 'file_gen' }),
    attach('attach_input_image', { ref: 'att_url', source_ref: '6966.zip:5' }),
  ];
  const blocks = assembleFlatBlocks(null, attaches);
  assert.deepEqual(blocks, [
    { type: 'image', mode: 'generate', ref: 'file_gen', order: 1 },
    { type: 'image', mode: 'embed_input', ref: 'att_url', source_ref: '6966.zip:5', order: 2 },
  ]);
});

test('no order given -> call sequence is preserved', () => {
  const attaches = [
    attach('attach_text', { md: 'first' }),
    attach('attach_text', { md: 'second' }),
    attach('attach_text', { md: 'third' }),
  ];
  const blocks = assembleFlatBlocks(deliver({ markdown: 'top' }), attaches);
  assert.deepEqual(blocks.map((b) => b.md), ['top', 'first', 'second', 'third']);
});

test('empty markdown / empty attach fields are dropped', () => {
  const attaches = [
    attach('attach_text', { md: '   ' }),
    attach('attach_generated_image', { ref: '' }),
    attach('attach_input_image', {}),
    attach('attach_text', { md: 'kept' }),
  ];
  const blocks = assembleFlatBlocks(deliver({ markdown: '' }), attaches);
  assert.deepEqual(blocks, [{ type: 'text', md: 'kept', order: 1 }]);
});

// ---- LEGACY dual-read (removed in Block 5) ----
test('legacy: native blocks array is returned unchanged when no flat content', () => {
  const legacy = deliver({ blocks: [{ type: 'text', md: 'legacy body' }] });
  assert.deepEqual(buildOutputBlocks(legacy, []), [{ type: 'text', md: 'legacy body' }]);
});

test('legacy: stringified-array blocks (valid JSON) still parse', () => {
  const legacy = deliver({ blocks: JSON.stringify([{ type: 'text', md: 'stringified' }]) });
  assert.deepEqual(buildOutputBlocks(legacy, []), [{ type: 'text', md: 'stringified' }]);
});

test('legacy: malformed stringified blocks do not throw (recover or empty)', () => {
  const legacy = deliver({ blocks: '[{"type":"text","md":"…o nowości"*"}]' });
  const blocks = buildOutputBlocks(legacy, []);
  assert.ok(Array.isArray(blocks)); // never throws; jsonrepair recovers or falls to []
});

test('flat content wins over a legacy blocks array on the same call', () => {
  const both = deliver({ markdown: 'flat wins', blocks: [{ type: 'text', md: 'legacy' }] });
  assert.deepEqual(buildOutputBlocks(both, []), [{ type: 'text', md: 'flat wins', order: 1 }]);
});

// ---- empty delivery ----
test('genuinely empty delivery -> []', () => {
  assert.deepEqual(buildOutputBlocks(deliver({}), []), []);
  assert.deepEqual(buildOutputBlocks(null, null), []);
});

// ---- extractDeliverBlocks direct (legacy unit) ----
test('extractDeliverBlocks accepts {blocks:[…]} and a bare array wrapper', () => {
  assert.deepEqual(extractDeliverBlocks(deliver({ blocks: [{ type: 'text', md: 'a' }] })), [{ type: 'text', md: 'a' }]);
  assert.deepEqual(extractDeliverBlocks({ input: [{ type: 'text', md: 'b' }] }), [{ type: 'text', md: 'b' }]);
});
