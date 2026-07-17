// deliver-blocks.test.mjs — ADR-072 (amended): markdown-native delivery parser.
// Run: node --test  (from services/session-waiter)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  markdownToBlocks,
  blocksArrayInMarkdown,
  parseMarkdownDelivery,
} from '../lib/deliver-blocks.mjs';

const deliver = (input) => ({ name: 'deliver_output', input });

// ---- markdownToBlocks ----
test('text-only markdown -> one text block', () => {
  const blocks = markdownToBlocks('## Wyniki\nGotowe.');
  assert.deepEqual(blocks, [{ type: 'text', md: '## Wyniki\nGotowe.', order: 1 }]);
});

test('inline image splits into text / image / text, preserving order', () => {
  const md = 'Wstęp o produkcie.\n\n![Wizualizacja produktu](file_abc123)\n\n## Kluczowe parametry\nTreść po obrazie.';
  const blocks = markdownToBlocks(md);
  assert.equal(blocks.length, 3);
  assert.equal(blocks[0].type, 'text');
  assert.match(blocks[0].md, /Wstęp o produkcie/);
  assert.deepEqual(
    { type: blocks[1].type, ref: blocks[1].ref, caption: blocks[1].caption, alt: blocks[1].alt, order: blocks[1].order },
    { type: 'image', ref: 'file_abc123', caption: 'Wizualizacja produktu', alt: 'Wizualizacja produktu', order: 2 },
  );
  assert.equal(blocks[2].type, 'text');
  assert.match(blocks[2].md, /Kluczowe parametry/);
});

test('image at the very start yields no leading empty text block', () => {
  const blocks = markdownToBlocks('![x](file_z)\n\nPo obrazie.');
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].type, 'image');
  assert.equal(blocks[0].ref, 'file_z');
  assert.equal(blocks[1].type, 'text');
});

test('image with empty alt omits caption/alt', () => {
  const blocks = markdownToBlocks('![](file_q)');
  assert.deepEqual(blocks, [{ type: 'image', ref: 'file_q', order: 1 }]);
});

test('image syntax inside inline code / fenced block is NOT treated as an image', () => {
  // Real image + a backtick-quoted example (the live CONV20 failure: agent documented `![opis](file_id)`).
  const md = 'Wstęp.\n\n![prawdziwy](file_real)\n\nOpis: wstawiam inline przez `![opis](file_id)`, gotowe.';
  const blocks = markdownToBlocks(md);
  const imgs = blocks.filter((b) => b.type === 'image');
  assert.equal(imgs.length, 1);            // only the real image, not the code-span example
  assert.equal(imgs[0].ref, 'file_real');
  // the backtick example survives verbatim in a text block
  assert.ok(blocks.some((b) => b.type === 'text' && b.md.includes('`![opis](file_id)`')));
});

test('fenced code block image is not treated as an image', () => {
  const md = 'Przyklad:\n\n```md\n![x](file_zzz)\n```\n\nKoniec.';
  const imgs = markdownToBlocks(md).filter((b) => b.type === 'image');
  assert.equal(imgs.length, 0);
});

test('input-attachment ref (non file_) passes through as ref for embed lookup', () => {
  const blocks = markdownToBlocks('Oto załącznik: ![zdjęcie](att-9931)');
  assert.equal(blocks[1].ref, 'att-9931'); // renderer will embed_input-resolve it
});

// ---- blocksArrayInMarkdown (backslide guard) ----
test('detects a serialized blocks array in markdown', () => {
  const arr = blocksArrayInMarkdown('[{"type":"text","md":"a"},{"type":"image","ref":"file_1"}]');
  assert.equal(Array.isArray(arr), true);
  assert.equal(arr.length, 2);
});

test('plain prose is not mistaken for a blocks array', () => {
  assert.equal(blocksArrayInMarkdown('Zwykła odpowiedź [z nawiasem] w tekście.'), null);
  assert.equal(blocksArrayInMarkdown('## Nagłówek'), null);
});

// ---- parseMarkdownDelivery ----
test('typical markdown delivery -> blocks, no warnings', () => {
  const { blocks, warnings } = parseMarkdownDelivery(deliver({ markdown: 'Gotowe.' }), {});
  assert.deepEqual(blocks, [{ type: 'text', md: 'Gotowe.', order: 1 }]);
  assert.deepEqual(warnings, []);
});

test('empty markdown -> no blocks', () => {
  assert.deepEqual(parseMarkdownDelivery(deliver({ markdown: '' }), {}).blocks, []);
  assert.deepEqual(parseMarkdownDelivery(deliver({}), {}).blocks, []);
  assert.deepEqual(parseMarkdownDelivery(null, {}).blocks, []);
});

test('backslide: blocks-array-in-markdown is unwrapped + WARNed', () => {
  const valid = '[{"type":"text","md":"cześć"},{"type":"image","ref":"file_1"}]';
  const { blocks, warnings } = parseMarkdownDelivery(deliver({ markdown: valid }), {});
  assert.equal(blocks.length, 2);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].source, 'managed-agents/deliver-blocks-array-in-markdown');
  assert.equal(warnings[0].severity, 'WARN');
});

test('orphaned generated image: generate_image ran but no image in answer -> WARN', () => {
  const { blocks, warnings } = parseMarkdownDelivery(deliver({ markdown: 'Sam tekst, bez obrazu.' }), { generateImageUsed: true });
  assert.equal(blocks.length, 1);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].source, 'managed-agents/generated-image-orphaned');
});

test('generate_image ran AND image referenced -> no orphan WARN', () => {
  const { warnings } = parseMarkdownDelivery(deliver({ markdown: 'Oto obraz: ![p](file_9)' }), { generateImageUsed: true });
  assert.deepEqual(warnings, []);
});
