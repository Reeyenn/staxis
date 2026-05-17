/**
 * Tests for src/lib/sentry-base.ts.
 *
 * Run via: npx tsx --test src/lib/__tests__/sentry-base.test.ts
 *
 * The H3 audit finding (May 2026) happened because the three Sentry init
 * configs (client/server/edge) were authored independently and one drifted
 * off the shared safety defaults — specifically, edge was missing the
 * `beforeSend: scrubSentryEvent` scrubber for months.
 *
 * getBaseSentryOptions exists so that drift is structurally impossible:
 * the three configs spread the same object. These tests pin the contract
 * so a future "tidy-up" PR that deletes one of these defaults gets caught.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { getBaseSentryOptions, shouldSampleTransaction } from '@/lib/sentry-base';
import { scrubSentryEvent } from '@/lib/sentry-scrub';

describe('getBaseSentryOptions', () => {
  test('beforeSend is the shared scrubber (fails if anyone deletes the wiring)', () => {
    const opts = getBaseSentryOptions();
    assert.equal(opts.beforeSend, scrubSentryEvent);
  });

  test('sendDefaultPii is false', () => {
    assert.equal(getBaseSentryOptions().sendDefaultPii, false);
  });

  test('debug is false (no per-cold-start init noise)', () => {
    assert.equal(getBaseSentryOptions().debug, false);
  });

  test('ignoreErrors includes the upstream fan-out noise patterns', () => {
    const opts = getBaseSentryOptions();
    assert.ok(Array.isArray(opts.ignoreErrors));
    assert.ok(opts.ignoreErrors.includes('failed to pipe response'));
    // The regex form for "other side closed" — confirm a regex literal is present.
    const hasOtherSideClosed = opts.ignoreErrors.some(
      (e) => e instanceof RegExp && e.test('SocketError: other side closed'),
    );
    assert.ok(hasOtherSideClosed, 'expected an /other side closed/ regex in ignoreErrors');
  });
});

/**
 * Per-route trace sampler — logging-PII audit S2.
 *
 * Pins the policy: which routes are downsampled to what rate. Anyone
 * changing the rules updates this test in the same commit; nobody can
 * silently flip /api/events back to 10%.
 */
describe('shouldSampleTransaction', () => {
  test('suppresses /api/events to 1%', () => {
    assert.equal(
      shouldSampleTransaction({ transactionContext: { name: 'POST /api/events' } }),
      0.01,
    );
  });

  test('suppresses /api/sms-reply to 1%', () => {
    assert.equal(
      shouldSampleTransaction({ transactionContext: { name: 'POST /api/sms-reply' } }),
      0.01,
    );
  });

  test('downsamples /api/cron/* to 5%', () => {
    assert.equal(
      shouldSampleTransaction({ transactionContext: { name: 'GET /api/cron/process-sms-jobs' } }),
      0.05,
    );
    assert.equal(
      shouldSampleTransaction({ transactionContext: { name: 'GET /api/cron/ml-run-inference' } }),
      0.05,
    );
  });

  test('downsamples /api/agent/voice-brain and nudges/check to 5%', () => {
    assert.equal(
      shouldSampleTransaction({ transactionContext: { name: 'POST /api/agent/voice-brain/chat/completions' } }),
      0.05,
    );
    assert.equal(
      shouldSampleTransaction({ transactionContext: { name: 'POST /api/agent/nudges/check' } }),
      0.05,
    );
  });

  test('returns undefined for routes that should inherit the global rate', () => {
    assert.equal(
      shouldSampleTransaction({ transactionContext: { name: 'POST /api/agent/command' } }),
      undefined,
    );
    assert.equal(
      shouldSampleTransaction({ transactionContext: { name: 'GET /api/admin/doctor' } }),
      undefined,
    );
    assert.equal(
      shouldSampleTransaction({ transactionContext: { name: 'PUT /api/auth/team' } }),
      undefined,
    );
  });

  test('falls back to request.url when transactionContext.name is unavailable', () => {
    assert.equal(
      shouldSampleTransaction({ request: { url: 'https://getstaxis.com/api/events' } }),
      0.01,
    );
  });

  test('handles empty / unknown context gracefully (default rate inherited)', () => {
    assert.equal(shouldSampleTransaction({}), undefined);
    assert.equal(shouldSampleTransaction({ transactionContext: {} }), undefined);
  });
});
