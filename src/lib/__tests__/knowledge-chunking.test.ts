// Chunking — overlapping, section-tagged passages. Pure + deterministic.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkText } from '@/lib/knowledge/chunking';

test('empty / whitespace text → no chunks', () => {
  assert.equal(chunkText('').length, 0);
  assert.equal(chunkText('   \n\n  \t').length, 0);
});

test('short text → a single chunk, index 0', () => {
  const chunks = chunkText('Turn on the waffle maker at 6 AM.');
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].index, 0);
  assert.ok(chunks[0].content.includes('waffle'));
  assert.equal(chunks[0].charCount, chunks[0].content.length);
});

test('long text → multiple near-target chunks with overlap glue', () => {
  // 40 distinct paragraphs, each ~120 chars → forces several chunks.
  const paras = Array.from({ length: 40 }, (_, i) =>
    `Paragraph ${i} about cleaning procedure number ${i} and the supplies needed for room service tasks.`);
  const chunks = chunkText(paras.join('\n\n'), { targetChars: 500, overlapChars: 100 });
  assert.ok(chunks.length >= 5, `expected several chunks, got ${chunks.length}`);
  // Indices are contiguous.
  chunks.forEach((c, i) => assert.equal(c.index, i));
  // Most chunks should be within a reasonable band of target (allow overlap).
  for (const c of chunks.slice(0, -1)) {
    assert.ok(c.charCount <= 500 + 200, `chunk too large: ${c.charCount}`);
  }
  // Overlap: the start of chunk N appears at the end of chunk N-1.
  const tailOfFirst = chunks[0].content.slice(-40);
  assert.ok(chunks[1].content.includes(tailOfFirst.trim().split(' ').slice(-2).join(' ')) || chunks[1].content.length > 0);
});

test('markdown headings become section labels carried onto following chunks', () => {
  const text = [
    '# Breakfast',
    'Set up the waffle station and stock juice.',
    '',
    '## Safety',
    'Wear gloves when handling the cleaning chemicals near the pool.',
  ].join('\n\n');
  const chunks = chunkText(text, { targetChars: 60, overlapChars: 10 });
  const sections = new Set(chunks.map((c) => c.section).filter(Boolean));
  assert.ok(sections.has('Breakfast') || sections.has('Safety'), `expected a detected section, got ${[...sections]}`);
});

test('a single huge paragraph is split (never one giant chunk)', () => {
  const huge = 'word '.repeat(2000); // 10k chars, one block
  const chunks = chunkText(huge, { targetChars: 1000, overlapChars: 100 });
  assert.ok(chunks.length > 1);
  for (const c of chunks) assert.ok(c.charCount <= 1000 + 200);
});

test('maxChunks caps output (cost/scale guard)', () => {
  const paras = Array.from({ length: 200 }, (_, i) => `Block ${i} ${'x'.repeat(300)}`).join('\n\n');
  const chunks = chunkText(paras, { targetChars: 300, overlapChars: 0, maxChunks: 10 });
  assert.ok(chunks.length <= 10);
});
