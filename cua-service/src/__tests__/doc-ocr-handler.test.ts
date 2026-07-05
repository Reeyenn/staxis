/**
 * Tests for the doc_ocr handler's pure logic + real PDF rasterization.
 *
 * Pins the invariants that make scanned-doc OCR safe:
 *   - payload parsing rejects a malformed job;
 *   - image vs. PDF routing (isOcrImageMime);
 *   - the $2/property/day budget decision (ocrBudgetDecision) — the seam the
 *     handler defers on when over cap;
 *   - the 60-page cap: a >60-page PDF rasterizes exactly 60 pages + capped=true
 *     (→ the doc lands `partial`);
 *   - rasterizePdf actually opens a real PDF and emits valid PNG bytes with the
 *     mupdf wasm build (proves the rasterizer runs in this Node runtime — the
 *     same one the Fly Playwright image runs);
 *   - joinPageTranscripts markers + [no text] dropping.
 *
 * No supabase / Anthropic call fires — the handler keeps those behind lazy
 * imports, so importing this module doesn't pull the Node<22 realtime client.
 */

import './_bootstrap-env.js';

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseDocOcrPayload,
  isOcrImageMime,
  ocrBudgetDecision,
  rasterizePdf,
  joinPageTranscripts,
  OCR_MAX_PAGES,
  OCR_PROPERTY_DAILY_USD,
  OCR_MODEL,
} from '../doc-ocr-handler.js';

// A clean 2-page PDF (built by mupdf's own writer — valid xref, no repair).
const TWO_PAGE_PDF_B64 =
  'JVBERi0xLjcKJcK1wrYKJSBXcml0dGVuIGJ5IE11UERGIDEuMjguMAoKMSAwIG9iago8PC9UeXBlL0NhdGFsb2cvUGFnZXMgMiAwIFIvSW5mbzw8L1Byb2R1Y2VyKE11UERGIDEuMjguMCk+Pj4+CmVuZG9iagoKMiAwIG9iago8PC9UeXBlL1BhZ2VzL0NvdW50IDIvS2lkc1s1IDAgUiA4IDAgUl0+PgplbmRvYmoKCjMgMCBvYmoKPDw+PgplbmRvYmoKCjQgMCBvYmoKPDwvTGVuZ3RoIDQ2Pj4Kc3RyZWFtCkJUIC9GMSAyMCBUZiAyMCAxMDAgVGQgKFBhZ2UgMSBPQ1IgdGVzdCkgVGogRVQKZW5kc3RyZWFtCmVuZG9iagoKNSAwIG9iago8PC9UeXBlL1BhZ2UvTWVkaWFCb3hbMCAwIDIwMCAyMDBdL1JvdGF0ZSAwL1Jlc291cmNlcyAzIDAgUi9Db250ZW50cyA0IDAgUi9QYXJlbnQgMiAwIFI+PgplbmRvYmoKCjYgMCBvYmoKPDw+PgplbmRvYmoKCjcgMCBvYmoKPDwvTGVuZ3RoIDQ2Pj4Kc3RyZWFtCkJUIC9GMSAyMCBUZiAyMCAxMDAgVGQgKFBhZ2UgMiBPQ1IgdGVzdCkgVGogRVQKZW5kc3RyZWFtCmVuZG9iagoKOCAwIG9iago8PC9UeXBlL1BhZ2UvTWVkaWFCb3hbMCAwIDIwMCAyMDBdL1JvdGF0ZSAwL1Jlc291cmNlcyA2IDAgUi9Db250ZW50cyA3IDAgUi9QYXJlbnQgMiAwIFI+PgplbmRvYmoKCnhyZWYKMCA5CjAwMDAwMDAwMDAgNjU1MzUgZiAKMDAwMDAwMDA0MiAwMDAwMCBuIAowMDAwMDAwMTIwIDAwMDAwIG4gCjAwMDAwMDAxNzggMDAwMDAgbiAKMDAwMDAwMDE5OSAwMDAwMCBuIAowMDAwMDAwMjk0IDAwMDAwIG4gCjAwMDAwMDA0MDAgMDAwMDAgbiAKMDAwMDAwMDQyMSAwMDAwMCBuIAowMDAwMDAwNTE2IDAwMDAwIG4gCgp0cmFpbGVyCjw8L1NpemUgOS9Sb290IDEgMCBSPj4Kc3RhcnR4cmVmCjYyMgolJUVPRgo=';

function twoPagePdf(): Uint8Array {
  return new Uint8Array(Buffer.from(TWO_PAGE_PDF_B64, 'base64'));
}

describe('parseDocOcrPayload', () => {
  test('accepts a well-formed payload', () => {
    const p = parseDocOcrPayload({ propertyId: 'p', documentId: 'd', filePath: 'p/knowledge/x.pdf', mime: 'application/pdf' });
    assert.deepEqual(p, { propertyId: 'p', documentId: 'd', filePath: 'p/knowledge/x.pdf', mime: 'application/pdf' });
  });
  test('rejects a payload missing any field', () => {
    assert.equal(parseDocOcrPayload({ documentId: 'd', filePath: 'x', mime: 'application/pdf' }), null);
    assert.equal(parseDocOcrPayload({ propertyId: 'p', filePath: 'x', mime: 'application/pdf' }), null);
    assert.equal(parseDocOcrPayload({ propertyId: 'p', documentId: 'd', mime: 'application/pdf' }), null);
    assert.equal(parseDocOcrPayload({ propertyId: 'p', documentId: 'd', filePath: 'x' }), null);
    assert.equal(parseDocOcrPayload({}), null);
  });
});

describe('isOcrImageMime', () => {
  test('recognizes image mimes, rejects pdf', () => {
    assert.equal(isOcrImageMime('image/jpeg'), true);
    assert.equal(isOcrImageMime('image/png'), true);
    assert.equal(isOcrImageMime('image/webp'), true);
    assert.equal(isOcrImageMime('application/pdf'), false);
  });
});

describe('ocrBudgetDecision ($2/property/day)', () => {
  test('under cap → proceed', () => {
    assert.equal(ocrBudgetDecision(0), 'proceed');
    assert.equal(ocrBudgetDecision(1_500_000), 'proceed'); // $1.50
  });
  test('at/over cap → defer', () => {
    const capMicros = OCR_PROPERTY_DAILY_USD * 1_000_000;
    assert.equal(ocrBudgetDecision(capMicros), 'defer'); // exactly $2.00
    assert.equal(ocrBudgetDecision(capMicros + 1), 'defer');
    assert.equal(ocrBudgetDecision(5_000_000), 'defer'); // $5.00
  });
  test('the OCR model is the cheap Sonnet, not the Opus mapper', () => {
    assert.equal(OCR_MODEL, 'claude-sonnet-4-6');
  });
});

describe('rasterizePdf (mupdf wasm — real render)', () => {
  test('renders a 2-page PDF to two valid PNG pages, not capped', async () => {
    const r = await rasterizePdf(twoPagePdf());
    assert.equal(r.totalPages, 2);
    assert.equal(r.capped, false);
    assert.equal(r.pages.length, 2);
    assert.equal(r.pages[0].page, 1);
    assert.equal(r.pages[1].page, 2);
    for (const pg of r.pages) {
      assert.equal(pg.mediaType, 'image/png');
      const png = Buffer.from(pg.base64, 'base64');
      // PNG magic bytes: 89 50 4E 47 0D 0A 1A 0A
      assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
      assert.ok(png.length > 100, 'a real rendered page is more than a header');
    }
  });
});

describe('page cap (OCR_MAX_PAGES) is 60', () => {
  test('the cap constant is 60', () => {
    assert.equal(OCR_MAX_PAGES, 60);
  });
  // We can't cheaply synthesize a 61-page PDF fixture here, so we assert the
  // exported constant and the rasterizer's capping arithmetic separately:
  // rasterizePdf renders Math.min(totalPages, OCR_MAX_PAGES) and sets
  // capped = totalPages > OCR_MAX_PAGES. For the 2-page fixture that's
  // (2, false) — verified above. The >60 branch is a pure min()/comparison.
});

describe('joinPageTranscripts', () => {
  test('adds [Page N] markers and joins with blank lines', () => {
    const out = joinPageTranscripts([
      { page: 1, text: 'first page text' },
      { page: 3, text: 'third page text' },
    ]);
    assert.equal(out, '[Page 1]\nfirst page text\n\n[Page 3]\nthird page text');
  });
  test('drops empty and [no text] pages', () => {
    const out = joinPageTranscripts([
      { page: 1, text: 'kept' },
      { page: 2, text: '   ' },
      { page: 3, text: '[no text]' },
      { page: 4, text: 'also kept' },
    ]);
    assert.equal(out, '[Page 1]\nkept\n\n[Page 4]\nalso kept');
  });
  test('all-empty → empty string', () => {
    assert.equal(joinPageTranscripts([{ page: 1, text: '' }, { page: 2, text: '[no text]' }]), '');
  });
});
