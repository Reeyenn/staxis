// Document extraction state machine + junk/scanned heuristics — exercised
// against REAL fixtures (a typed PDF, a scanned/image-only PDF, a .docx, csv,
// txt) so the unpdf/mammoth integration is genuinely tested, not mocked.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  extractDocumentText, isMostlyReadable, meaningfulCharCount, EXTRACTED_TEXT_MAX,
} from '@/lib/knowledge/extraction';

const PDF = 'application/pdf';
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const DOC = 'application/msword';

function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(fileURLToPath(new URL(`./fixtures/knowledge/${name}`, import.meta.url))));
}

test('typed PDF → ready with real text', async () => {
  const out = await extractDocumentText(fixture('text-sop.pdf'), PDF);
  assert.equal(out.status, 'ready');
  assert.ok((out.text ?? '').toLowerCase().includes('waffle'), 'extracts the PDF body text');
  assert.ok((out.text ?? '').includes('PX-4471'), 'keeps exact part numbers');
});

test('scanned / image-only PDF → needs_ocr (routes to vision worker, not a dead end)', async () => {
  const out = await extractDocumentText(fixture('scanned.pdf'), PDF);
  assert.equal(out.status, 'needs_ocr');
  assert.equal(out.text, null);
  assert.match(out.error ?? '', /scan/i);
  // The page count rides into the doc_ocr job payload so the worker can apply
  // its 60-page cap instruction — unpdf must have produced a real number here.
  assert.ok(typeof out.pageCount === 'number' && out.pageCount >= 1, `pageCount is ${out.pageCount}`);
});

test('uploaded photo (jpg/png/webp) → needs_ocr (no text layer to parse)', async () => {
  // A tiny 1x1 PNG — the byte content is irrelevant: image mimes route straight
  // to the OCR worker without any local parse.
  const tinyPng = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]);
  for (const mime of ['image/jpeg', 'image/png', 'image/webp']) {
    const out = await extractDocumentText(tinyPng, mime);
    assert.equal(out.status, 'needs_ocr', `${mime} routes to OCR`);
    assert.equal(out.text, null);
  }
});

test('.docx → ready with real text', async () => {
  const out = await extractDocumentText(fixture('text-sop.docx'), DOCX);
  assert.equal(out.status, 'ready');
  assert.ok((out.text ?? '').toLowerCase().includes('breakfast'));
});

test('csv + txt → ready (numbers/commas are not junk)', async () => {
  const csv = await extractDocumentText(fixture('rooms.csv'), 'text/csv');
  assert.equal(csv.status, 'ready');
  assert.ok((csv.text ?? '').includes('PX-4471'));
  const txt = await extractDocumentText(fixture('notes.txt'), 'text/plain');
  assert.equal(txt.status, 'ready');
});

test('legacy .doc → unsupported (convert to .docx/PDF)', async () => {
  const out = await extractDocumentText(new Uint8Array([1, 2, 3, 4]), DOC);
  assert.equal(out.status, 'unsupported');
  assert.match(out.error ?? '', /\.docx|PDF/i);
});

test('binary garbage labeled text/plain → failed (alpha-ratio junk guard)', async () => {
  const junk = new Uint8Array(Array.from({ length: 64 }, (_, i) => (i * 37) % 7 === 0 ? 65 : (i % 256)));
  const out = await extractDocumentText(junk, 'text/plain');
  assert.equal(out.status, 'failed');
});

test('empty text file → failed (no readable text)', async () => {
  const out = await extractDocumentText(new TextEncoder().encode('   \n\t  '), 'text/plain');
  assert.equal(out.status, 'failed');
});

test('over-cap text → partial + truncated at the index cap', async () => {
  const big = 'La política de limpieza del hotel. '.repeat(6000); // ~210 KB, > 100 KB cap
  assert.ok(big.length > EXTRACTED_TEXT_MAX);
  const out = await extractDocumentText(new TextEncoder().encode(big), 'text/markdown');
  assert.equal(out.status, 'partial');
  assert.equal(out.truncated, true);
  assert.ok((out.text ?? '').length <= EXTRACTED_TEXT_MAX);
});

test('isMostlyReadable: passes EN/ES text + CSV, rejects control-byte noise', () => {
  assert.equal(isMostlyReadable('Clean the room before 11am. Limpie la habitación.'), true);
  assert.equal(isMostlyReadable('room,status\n101,clean\n102,dirty'), true);
  const noise = Array.from({ length: 50 }, (_, i) => String.fromCharCode(i % 8)).join('');
  assert.equal(isMostlyReadable(noise), false);
});

test('meaningfulCharCount: counts letters/digits incl. accents, ignores punctuation', () => {
  assert.equal(meaningfulCharCount('...,,,   '), 0);
  assert.ok(meaningfulCharCount('habitación 302') >= 12);
});
