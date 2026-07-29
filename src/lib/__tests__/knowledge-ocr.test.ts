/**
 * Reading scanned documents — the contract that keeps a scan from stalling.
 *
 * The bug this suite exists to prevent (2026-07-27): uploading a scan queued a
 * `doc_ocr` job for the Fly robot, which had been decommissioned, so the
 * document sat on `processing` forever with a spinner and no error. A stable
 * per-document idempotency key meant a second attempt collided with the dead
 * row and was read as "already enqueued" — so it could not even retry.
 *
 * Covers:
 *   • image mimes are recognized as OCR-able (isImageMime);
 *   • the refusals that happen BEFORE any spend (checkOcrFits);
 *   • every model failure maps to a reason a user can act on
 *     (classifyOcrFailure) and to the right badge (ocrStatusForReason);
 *   • a retry is never blocked by a previous attempt;
 *   • the stored-sentence ↔ reason-code round trip the bilingual UI rides on;
 *   • the stranded-document safety net (isStrandedIndex);
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

import {
  isImageMime, KNOWLEDGE_IMAGE_MIME_TYPES, docIssueReason, DOC_ISSUE_MESSAGE,
  type DocIssueReason,
} from '@/lib/knowledge/types';
import {
  decideOcrStatus, checkOcrFits, classifyOcrFailure, ocrStatusForReason,
  ocrByteLimitFor, ocrIssueMessage, runDocumentOcr, DOC_OCR_MAX_PAGES,
} from '@/lib/knowledge/ocr';
import { isStrandedIndex } from '@/lib/knowledge/core';
import {
  VisionTruncatedError, VisionImageInvalidError,
  VISION_MAX_DECODED_BYTES, VISION_PDF_MAX_DECODED_BYTES,
} from '@/lib/vision-extract';
import { AiExecutionDeadlineError, AiFeatureDisabledError } from '@/lib/ai/runtime';
import { AI_FEATURE_KEYS, AI_LEDGER_ONLY_FEATURES } from '@/lib/ai/types';
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
});

describe('refusals that cost nothing (checkOcrFits)', () => {
  test('a normal one-page photo fits', () => {
    assert.equal(checkOcrFits({ byteLength: 900_000, mime: 'image/jpeg', pageCount: null }), null);
  });

  test('a short scanned PDF fits', () => {
    assert.equal(checkOcrFits({ byteLength: 2_000_000, mime: 'application/pdf', pageCount: 6 }), null);
  });

  test('an oversized photo is refused as too large, not attempted', () => {
    assert.deepEqual(
      checkOcrFits({ byteLength: VISION_MAX_DECODED_BYTES + 1, mime: 'image/png', pageCount: null }),
      { reason: 'scan_too_large' },
    );
  });

  test('a PDF over the PDF ceiling is refused even though it would fit the image ceiling', () => {
    // The two limits genuinely differ (4MB PDF vs 5MB image). A PDF sized
    // between them must be judged by the PDF limit or the model rejects it
    // after we have already paid to upload it.
    const between = VISION_PDF_MAX_DECODED_BYTES + 1;
    assert.ok(between < VISION_MAX_DECODED_BYTES, 'fixture must sit between the two ceilings');
    assert.deepEqual(
      checkOcrFits({ byteLength: between, mime: 'application/pdf', pageCount: 1 }),
      { reason: 'scan_too_large' },
    );
    assert.equal(checkOcrFits({ byteLength: between, mime: 'image/jpeg', pageCount: null }), null);
  });

  test('a scan longer than one response can hold is refused before spending', () => {
    assert.deepEqual(
      checkOcrFits({ byteLength: 1_000, mime: 'application/pdf', pageCount: DOC_OCR_MAX_PAGES + 1 }),
      { reason: 'scan_too_long' },
    );
    assert.equal(
      checkOcrFits({ byteLength: 1_000, mime: 'application/pdf', pageCount: DOC_OCR_MAX_PAGES }),
      null,
    );
  });

  test('an unknown page count is not treated as evidence of a long scan', () => {
    assert.equal(checkOcrFits({ byteLength: 1_000, mime: 'application/pdf', pageCount: null }), null);
  });

  test('the byte ceiling follows the mime, not the caller', () => {
    assert.equal(ocrByteLimitFor('image/jpeg'), VISION_MAX_DECODED_BYTES);
    assert.equal(ocrByteLimitFor('application/pdf'), VISION_PDF_MAX_DECODED_BYTES);
  });
});

describe('every failure becomes something the user can act on', () => {
  test('a truncated response means the scan was too long — not a generic error', () => {
    // The partial transcript is discarded on truncation, so "try again" would
    // be a lie: the same file truncates every time.
    assert.equal(classifyOcrFailure(new VisionTruncatedError(8192, 8192)), 'scan_too_long');
  });

  test('rejected bytes map to too-large', () => {
    assert.equal(classifyOcrFailure(new VisionImageInvalidError('too big')), 'scan_too_large');
  });

  test('running out of time is retryable', () => {
    assert.equal(classifyOcrFailure(new AiExecutionDeadlineError()), 'scan_busy');
  });

  test('an admin switching the feature off is retryable, not the file\'s fault', () => {
    assert.equal(classifyOcrFailure(new AiFeatureDisabledError('knowledge.document_ocr')), 'scan_busy');
  });

  test('a blank page reads as empty rather than broken', () => {
    assert.equal(
      classifyOcrFailure(new Error('Vision API returned no text. Try a clearer photo.')),
      'scan_empty',
    );
  });

  test('an unrecognized error is retryable rather than silently terminal', () => {
    assert.equal(classifyOcrFailure(new Error('socket hang up')), 'scan_busy');
  });

  test('structural reasons get the "not searchable" badge, retryable ones get "couldn\'t read"', () => {
    assert.equal(ocrStatusForReason('scan_too_large'), 'unsupported');
    assert.equal(ocrStatusForReason('scan_too_long'), 'unsupported');
    assert.equal(ocrStatusForReason('scan_busy'), 'failed');
    assert.equal(ocrStatusForReason('scan_empty'), 'failed');
    assert.equal(ocrStatusForReason('scan_budget'), 'failed');
  });
});

describe('the budget refusal tells the truth about which limit was hit', () => {
  test('an unreadable ledger is retryable, not "come back tomorrow"', async () => {
    // Both refuse (fail closed — never spend when the ledger can't be read),
    // but "you hit today's limit" would send someone away for a day over what
    // may be a seconds-long database hiccup. The placeholder supabase in the
    // test env makes the ledger read fail for real, which is exactly this case.
    const res = await runDocumentOcr({
      propertyId: '00000000-0000-0000-0000-0000000000a2',
      documentId: '00000000-0000-0000-0000-0000000000b2',
      bytes: new Uint8Array(2048),
      mime: 'image/png',
      accountId: '00000000-0000-0000-0000-0000000000c2',
      pageCount: null,
    });
    assert.deepEqual(res, { ok: false, reason: 'scan_busy' });
    assert.equal(ocrStatusForReason('scan_busy'), 'failed', 'must stay retryable in the UI');
  });
});

describe('a retry is never blocked by an earlier attempt', () => {
  test('the same document refused twice is refused twice — no "already in flight"', async () => {
    // The regression guard for the original bug. The old path wrote a
    // workflow_jobs row keyed `doc_ocr:<docId>`; a second attempt collided with
    // the leftover row, was reported as success, and put the document back on
    // `processing` with nobody to run it. With no queue there is no key to
    // burn, so attempt two must do exactly what attempt one did.
    //
    // Oversized input on purpose: the size refusal is the first thing
    // runDocumentOcr does, so this exercises the real function without a
    // database or a model call.
    const input = {
      propertyId: '00000000-0000-0000-0000-0000000000a1',
      documentId: '00000000-0000-0000-0000-0000000000b1',
      bytes: new Uint8Array(VISION_PDF_MAX_DECODED_BYTES + 10),
      mime: 'application/pdf',
      accountId: '00000000-0000-0000-0000-0000000000c1',
      pageCount: 2,
    };
    const first = await runDocumentOcr(input);
    const second = await runDocumentOcr(input);
    assert.deepEqual(first, { ok: false, reason: 'scan_too_large' });
    assert.deepEqual(second, first, 'a second attempt must not be short-circuited by the first');
  });
});

describe('the stored reason survives the round trip into the UI', () => {
  // KnowledgePane translates a CODE, but the database stores an English
  // SENTENCE. If a writer ever stores a hand-typed sentence instead of the
  // constant, the note silently disappears — this is what catches that.
  const reasons: DocIssueReason[] = [
    'scan_too_large', 'scan_too_long', 'scan_empty', 'scan_busy', 'scan_budget', 'legacy_doc',
  ];

  for (const reason of reasons) {
    test(`${reason} maps back to itself`, () => {
      assert.equal(docIssueReason(DOC_ISSUE_MESSAGE[reason]), reason);
    });
  }

  test('the message a refusal stores is the one that maps back', () => {
    assert.equal(docIssueReason(ocrIssueMessage('scan_too_large')), 'scan_too_large');
  });

  test('unknown, legacy and empty errors degrade to no note rather than a wrong one', () => {
    assert.equal(docIssueReason('Embedding service was unavailable — searchable by keyword for now.'), null);
    assert.equal(docIssueReason(''), null);
    assert.equal(docIssueReason(null), null);
    assert.equal(docIssueReason(undefined), null);
  });

  test('no two reasons share a sentence (the map would be ambiguous)', () => {
    const sentences = reasons.map((r) => DOC_ISSUE_MESSAGE[r]);
    assert.equal(new Set(sentences).size, sentences.length);
  });
});

describe('nothing may spin forever (isStrandedIndex)', () => {
  const now = Date.parse('2026-07-27T12:00:00.000Z');
  const minutesAgo = (m: number) => new Date(now - m * 60_000).toISOString();

  test('a scan that is still being read is left alone', () => {
    assert.equal(isStrandedIndex('processing', minutesAgo(1), now), false);
    assert.equal(isStrandedIndex('pending', minutesAgo(10), now), false);
  });

  test('an unfinished document older than any real pass is declared dead', () => {
    assert.equal(isStrandedIndex('processing', minutesAgo(16), now), true);
    assert.equal(isStrandedIndex('pending', minutesAgo(120), now), true);
  });

  test('finished documents are never disturbed, however old', () => {
    for (const status of ['ready', 'partial', 'failed', 'unsupported'] as const) {
      assert.equal(isStrandedIndex(status, minutesAgo(10_000), now), false, status);
    }
  });

  test('a missing or unparseable timestamp is not treated as stranded', () => {
    assert.equal(isStrandedIndex('processing', null, now), false);
    assert.equal(isStrandedIndex('processing', 'not-a-date', now), false);
  });
});

describe('scan reading is a real, admin-configurable feature', () => {
  test('it is a Control Center feature, no longer a ledger-only label', () => {
    assert.ok(
      (AI_FEATURE_KEYS as readonly string[]).includes('knowledge.document_ocr'),
      'the model that reads scans must be switchable like every other scan feature',
    );
    assert.ok(!(AI_LEDGER_ONLY_FEATURES as readonly string[]).includes('knowledge.document_ocr'));
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
