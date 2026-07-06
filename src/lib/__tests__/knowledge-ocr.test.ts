/**
 * OCR routing + ocr-complete endpoint contract.
 *
 * Covers the web side of the scanned-PDF / photo → AI-search feature:
 *   • image mimes are recognized as OCR-able (isImageMime);
 *   • the OCR status transition table (decideOcrStatus): ready vs. partial;
 *   • /api/internal/knowledge/ocr-complete auth (CRON_SECRET required) + input
 *     validation branches, exercised WITHOUT touching supabase (all reachable
 *     before the DB lookup — same technique as save-fcm-token.test.ts).
 *
 * The test env sets CRON_SECRET=placeholder-cron-secret-min-16 (see the root
 * `npm test` script), so requireCronSecret is genuinely enforced here.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { NextRequest } from 'next/server';

import { isImageMime, KNOWLEDGE_IMAGE_MIME_TYPES } from '@/lib/knowledge/types';
import { decideOcrStatus, buildDocOcrJobRow, DOC_OCR_JOB_KIND, DOC_OCR_TIMEOUT_MS } from '@/lib/knowledge/ocr';
import { POST as ocrCompletePOST } from '@/app/api/internal/knowledge/ocr-complete/route';

const CRON = 'placeholder-cron-secret-min-16';
const UUID_A = '00000000-0000-0000-0000-00000000000a';
const UUID_B = '00000000-0000-0000-0000-00000000000b';

function ocrReq(body: unknown, opts: { auth?: string } = {}): NextRequest {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.auth !== undefined) headers.Authorization = opts.auth;
  return new Request('https://staxis.test/api/internal/knowledge/ocr-complete', {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }) as unknown as NextRequest;
}

describe('image mime acceptance', () => {
  test('jpeg/png/webp are OCR-able image mimes', () => {
    assert.equal(isImageMime('image/jpeg'), true);
    assert.equal(isImageMime('image/png'), true);
    assert.equal(isImageMime('image/webp'), true);
  });
  test('documents + null are NOT image mimes', () => {
    assert.equal(isImageMime('application/pdf'), false);
    assert.equal(isImageMime('text/plain'), false);
    assert.equal(isImageMime(null), false);
    assert.equal(isImageMime(undefined), false);
  });
  test('the shared image set is exactly the three we accept', () => {
    assert.deepEqual([...KNOWLEDGE_IMAGE_MIME_TYPES].sort(), ['image/jpeg', 'image/png', 'image/webp']);
  });
});

describe('OCR status transition table (decideOcrStatus)', () => {
  test('all-clear → ready', () => {
    assert.equal(decideOcrStatus({ truncated: false, pageCapped: false, embedPartial: false, hitChunkCap: false }), 'ready');
  });
  test('page-capped (>60 pages) → partial', () => {
    assert.equal(decideOcrStatus({ truncated: false, pageCapped: true, embedPartial: false, hitChunkCap: false }), 'partial');
  });
  test('text truncated at index cap → partial', () => {
    assert.equal(decideOcrStatus({ truncated: true, pageCapped: false, embedPartial: false, hitChunkCap: false }), 'partial');
  });
  test('embedding degraded to keyword-only → partial', () => {
    assert.equal(decideOcrStatus({ truncated: false, pageCapped: false, embedPartial: true, hitChunkCap: false }), 'partial');
  });
  test('chunk cap hit → partial', () => {
    assert.equal(decideOcrStatus({ truncated: false, pageCapped: false, embedPartial: false, hitChunkCap: true }), 'partial');
  });
  test('job kind constant is doc_ocr', () => {
    assert.equal(DOC_OCR_JOB_KIND, 'doc_ocr');
  });
});

describe('doc_ocr enqueue row (buildDocOcrJobRow)', () => {
  const input = {
    propertyId: UUID_A,
    documentId: UUID_B,
    filePath: `${UUID_A}/knowledge/x.pdf`,
    mime: 'application/pdf',
    pageCount: 7,
  };

  test('payload sets the 15-min timeout_ms override the worker runtime honors', () => {
    const row = buildDocOcrJobRow(input);
    assert.equal(row.payload.timeout_ms, 900_000);
    assert.equal(row.payload.timeout_ms, DOC_OCR_TIMEOUT_MS);
  });

  test('payload carries the doc identity + pageCount for the worker', () => {
    const row = buildDocOcrJobRow(input);
    assert.equal(row.kind, 'doc_ocr');
    assert.deepEqual(
      { propertyId: row.payload.propertyId, documentId: row.payload.documentId, filePath: row.payload.filePath, mime: row.payload.mime, pageCount: row.payload.pageCount },
      { propertyId: UUID_A, documentId: UUID_B, filePath: input.filePath, mime: 'application/pdf', pageCount: 7 },
    );
  });

  test('omitted pageCount (images / backfill) normalizes to null', () => {
    const row = buildDocOcrJobRow({ ...input, pageCount: undefined });
    assert.equal(row.payload.pageCount, null);
  });

  test('stable-per-doc idempotency key + single attempt', () => {
    const row = buildDocOcrJobRow(input);
    assert.equal(row.idempotency_key, `doc_ocr:${UUID_B}`);
    assert.equal(row.max_attempts, 1);
    assert.equal(row.property_id, UUID_A);
  });
});

describe('ocr-complete: auth (CRON_SECRET required)', () => {
  test('no Authorization header → 401', async () => {
    const res = await ocrCompletePOST(ocrReq({ propertyId: UUID_A, documentId: UUID_B, text: 'x', pages: 1, inputTokens: 1, outputTokens: 1, costUsd: 0 }));
    assert.equal(res.status, 401);
  });
  test('wrong bearer → 401', async () => {
    const res = await ocrCompletePOST(ocrReq(
      { propertyId: UUID_A, documentId: UUID_B, text: 'x', pages: 1, inputTokens: 1, outputTokens: 1, costUsd: 0 },
      { auth: 'Bearer not-the-real-secret-value' },
    ));
    assert.equal(res.status, 401);
  });
});

describe('ocr-complete: input validation (authorized, pre-DB)', () => {
  const auth = `Bearer ${CRON}`;

  test('non-UUID documentId → 400 naming documentId', async () => {
    const res = await ocrCompletePOST(ocrReq(
      { propertyId: UUID_A, documentId: 'not-a-uuid', text: 'x', pages: 1, inputTokens: 1, outputTokens: 1, costUsd: 0 },
      { auth },
    ));
    assert.equal(res.status, 400);
    assert.match(JSON.stringify(await res.json()), /documentId/);
  });

  test('non-UUID propertyId → 400 naming propertyId', async () => {
    const res = await ocrCompletePOST(ocrReq(
      { propertyId: 'nope', documentId: UUID_B, text: 'x', pages: 1, inputTokens: 1, outputTokens: 1, costUsd: 0 },
      { auth },
    ));
    assert.equal(res.status, 400);
    assert.match(JSON.stringify(await res.json()), /propertyId/);
  });

  test('missing numeric fields (pages/tokens/cost) → 400', async () => {
    const res = await ocrCompletePOST(ocrReq(
      { propertyId: UUID_A, documentId: UUID_B, text: 'x' },
      { auth },
    ));
    assert.equal(res.status, 400);
  });

  test('negative costUsd → 400', async () => {
    const res = await ocrCompletePOST(ocrReq(
      { propertyId: UUID_A, documentId: UUID_B, text: 'x', pages: 1, inputTokens: 1, outputTokens: 1, costUsd: -5 },
      { auth },
    ));
    assert.equal(res.status, 400);
  });

  test('invalid JSON body → 400 (documentId validator fails on undefined)', async () => {
    const res = await ocrCompletePOST(ocrReq('not-json', { auth }));
    assert.equal(res.status, 400);
  });

  test('empty text is allowed by the validator (worker may send [no text] → empty)', async () => {
    // Valid shape, empty text. This passes validation and proceeds to the DB
    // lookup — which, against the placeholder test supabase, resolves to a
    // non-200 (404 no-doc or 500 db). The point here is it is NOT a 400: the
    // validator accepts empty text (allowEmpty), so we're past validation.
    const res = await ocrCompletePOST(ocrReq(
      { propertyId: UUID_A, documentId: UUID_B, text: '', pages: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 },
      { auth },
    ));
    assert.notEqual(res.status, 400);
  });
});
