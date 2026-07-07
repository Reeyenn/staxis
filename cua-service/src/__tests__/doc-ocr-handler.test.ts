/**
 * Tests for the doc_ocr handler's pure logic.
 *
 * Pins the invariants that make scanned-doc OCR safe:
 *   - payload parsing rejects a malformed job and passes pageCount through;
 *   - image vs. PDF routing (isOcrImageMime);
 *   - the single vision request is built with Anthropic's NATIVE PDF input —
 *     a `document` content block (base64, media_type application/pdf, data
 *     with NO newlines), media block first, text instruction after;
 *   - the >60-page path: the instruction limits transcription to pages 1-60
 *     and pageCapped=true (→ the doc lands `partial`);
 *   - error classification via the SDK's TYPED error classes: transient
 *     (429 / 5xx incl. 529 / network / abort) → defer WITHOUT failing the doc;
 *     permanent (400 bad request, unknown) → fail;
 *   - the $2/property/day budget decision (ocrBudgetDecision) — the seam the
 *     handler defers on when over cap;
 *   - the [no text] sentinel normalizes to empty.
 *
 * No supabase / Anthropic network call fires — the handler keeps I/O behind
 * lazy imports, so importing this module doesn't pull the Node<22 realtime
 * client, and the SDK error classes are constructed locally.
 */

import './_bootstrap-env.js';

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import Anthropic from '@anthropic-ai/sdk';
import {
  parseDocOcrPayload,
  isOcrImageMime,
  ocrBudgetDecision,
  buildOcrUserContent,
  classifyOcrError,
  normalizeTranscript,
  OCR_MAX_PAGES,
  OCR_PROPERTY_DAILY_USD,
  OCR_MODEL,
  OCR_SYSTEM_PROMPT,
} from '../doc-ocr-handler.js';

describe('parseDocOcrPayload', () => {
  test('accepts a well-formed payload and passes pageCount through', () => {
    const p = parseDocOcrPayload({
      propertyId: 'p', documentId: 'd', filePath: 'p/knowledge/x.pdf',
      mime: 'application/pdf', pageCount: 12,
    });
    assert.deepEqual(p, {
      propertyId: 'p', documentId: 'd', filePath: 'p/knowledge/x.pdf',
      mime: 'application/pdf', pageCount: 12,
    });
  });
  test('missing/invalid pageCount normalizes to null (backfill jobs)', () => {
    assert.equal(parseDocOcrPayload({ propertyId: 'p', documentId: 'd', filePath: 'x', mime: 'application/pdf' })?.pageCount, null);
    assert.equal(parseDocOcrPayload({ propertyId: 'p', documentId: 'd', filePath: 'x', mime: 'application/pdf', pageCount: null })?.pageCount, null);
    assert.equal(parseDocOcrPayload({ propertyId: 'p', documentId: 'd', filePath: 'x', mime: 'application/pdf', pageCount: 'many' })?.pageCount, null);
    assert.equal(parseDocOcrPayload({ propertyId: 'p', documentId: 'd', filePath: 'x', mime: 'application/pdf', pageCount: -3 })?.pageCount, null);
  });
  test('rejects a payload missing any required field', () => {
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

describe('buildOcrUserContent — native PDF document block', () => {
  // ~90 bytes → a base64 string long enough that a line-wrapping encoder
  // would have inserted a newline (MIME wraps at 76 chars).
  const bytes = Buffer.alloc(90, 7);
  const b64 = bytes.toString('base64');

  test('PDF → [document block, text instruction], correct source shape', () => {
    const { content, pageCapped } = buildOcrUserContent({
      mime: 'application/pdf', base64: b64, pageCount: 3,
    });
    assert.equal(pageCapped, false);
    assert.equal(content.length, 2);
    const doc = content[0] as { type: string; source: { type: string; media_type: string; data: string } };
    assert.equal(doc.type, 'document');
    assert.equal(doc.source.type, 'base64');
    assert.equal(doc.source.media_type, 'application/pdf');
    assert.equal(doc.source.data, b64);
    // The PDF-input API requires base64 with no newlines.
    assert.ok(doc.source.data.length > 76, 'test data long enough to catch MIME wrapping');
    assert.ok(!/[\r\n]/.test(doc.source.data), 'base64 data has no newlines');
    const txt = content[1] as { type: string; text: string };
    assert.equal(txt.type, 'text');
    assert.ok(!txt.text.includes(`${OCR_MAX_PAGES}`), 'no page-cap instruction under the cap');
  });

  test(`>60-page PDF → pageCapped=true + "pages 1 through ${OCR_MAX_PAGES}" instruction`, () => {
    const { content, pageCapped } = buildOcrUserContent({
      mime: 'application/pdf', base64: b64, pageCount: 61,
    });
    assert.equal(pageCapped, true);
    const txt = content[1] as { type: string; text: string };
    assert.match(txt.text, /pages 1 through 60/i);
    assert.match(txt.text, /61 pages/);
  });

  test('exactly 60 pages is NOT capped; unknown pageCount is NOT capped', () => {
    assert.equal(buildOcrUserContent({ mime: 'application/pdf', base64: b64, pageCount: 60 }).pageCapped, false);
    assert.equal(buildOcrUserContent({ mime: 'application/pdf', base64: b64, pageCount: null }).pageCapped, false);
  });

  test('image mime → single image block with matching media_type, never capped', () => {
    for (const mime of ['image/jpeg', 'image/png', 'image/webp'] as const) {
      const { content, pageCapped } = buildOcrUserContent({ mime, base64: b64, pageCount: null });
      assert.equal(pageCapped, false);
      const img = content[0] as { type: string; source: { type: string; media_type: string; data: string } };
      assert.equal(img.type, 'image');
      assert.equal(img.source.type, 'base64');
      assert.equal(img.source.media_type, mime);
      assert.equal((content[1] as { type: string }).type, 'text');
    }
  });

  test('system prompt demands verbatim transcription with [Page N] markers', () => {
    assert.match(OCR_SYSTEM_PROMPT, /\[Page N\]/);
    assert.match(OCR_SYSTEM_PROMPT, /EXACTLY as it appears/);
    assert.match(OCR_SYSTEM_PROMPT, /Do NOT summarize/);
  });
});

describe('classifyOcrError — typed SDK errors, no string matching', () => {
  const apiErr = (status: number) =>
    Anthropic.APIError.generate(status, { error: { type: 'x', message: 'boom' } }, 'boom', new Headers());

  test('429 rate limit → defer (doc NOT failed)', () => {
    const e = apiErr(429);
    assert.ok(e instanceof Anthropic.RateLimitError, 'generate(429) yields RateLimitError');
    assert.equal(classifyOcrError(e), 'defer');
  });
  test('500 and 529 server errors → defer', () => {
    const e500 = apiErr(500);
    const e529 = apiErr(529);
    assert.ok(e500 instanceof Anthropic.InternalServerError);
    assert.ok(e529 instanceof Anthropic.InternalServerError, '529 overloaded maps to InternalServerError');
    assert.equal(classifyOcrError(e500), 'defer');
    assert.equal(classifyOcrError(e529), 'defer');
  });
  test('network / connection errors (incl. timeout subclass) → defer', () => {
    assert.equal(classifyOcrError(new Anthropic.APIConnectionError({ message: 'fetch failed' })), 'defer');
    assert.equal(classifyOcrError(new Anthropic.APIConnectionTimeoutError()), 'defer');
  });
  test('job-timeout abort → defer', () => {
    assert.equal(classifyOcrError(new Anthropic.APIUserAbortError()), 'defer');
  });
  test('400 bad request (corrupt/rejected PDF) → fail', () => {
    const e = apiErr(400);
    assert.ok(e instanceof Anthropic.BadRequestError);
    assert.equal(classifyOcrError(e), 'fail');
  });
  test('unknown non-API error → fail (loud, no 24h defer loop)', () => {
    assert.equal(classifyOcrError(new Error('undefined is not a function')), 'fail');
    assert.equal(classifyOcrError(apiErr(401)), 'fail'); // auth misconfig — surface it
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
  test('page cap constant is 60', () => {
    assert.equal(OCR_MAX_PAGES, 60);
  });
});

describe('normalizeTranscript', () => {
  test('lone [no text] sentinel → empty string', () => {
    assert.equal(normalizeTranscript('[no text]'), '');
    assert.equal(normalizeTranscript('  [No Text]  '), '');
  });
  test('real transcripts pass through trimmed', () => {
    assert.equal(normalizeTranscript('  [Page 1]\nhello  '), '[Page 1]\nhello');
    assert.equal(normalizeTranscript('mentions [no text] mid-sentence'), 'mentions [no text] mid-sentence');
  });
});
