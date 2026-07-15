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
      shouldSampleTransaction({ name: 'POST /api/events' }),
      0.01,
    );
  });

  test('suppresses /api/sms-reply to 1%', () => {
    assert.equal(
      shouldSampleTransaction({ name: 'POST /api/sms-reply' }),
      0.01,
    );
  });

  test('downsamples /api/cron/* to 5%', () => {
    assert.equal(
      shouldSampleTransaction({ name: 'GET /api/cron/process-sms-jobs' }),
      0.05,
    );
    assert.equal(
      shouldSampleTransaction({ name: 'GET /api/cron/ml-run-inference' }),
      0.05,
    );
  });

  test('downsamples nudges/check to 5%', () => {
    assert.equal(
      shouldSampleTransaction({ name: 'POST /api/agent/nudges/check' }),
      0.05,
    );
  });

  test('falls back to global rate for routes that should inherit', () => {
    // No inheritOrSampleWith provided → returns the hardcoded default (0.1).
    assert.equal(
      shouldSampleTransaction({ name: 'POST /api/agent/command' }),
      0.1,
    );
    assert.equal(
      shouldSampleTransaction({ name: 'GET /api/admin/doctor' }),
      0.1,
    );
    assert.equal(
      shouldSampleTransaction({ name: 'PUT /api/auth/team' }),
      0.1,
    );
  });

  test('uses inheritOrSampleWith when provided (distributed-trace coherence)', () => {
    // The Sentry SDK passes inheritOrSampleWith to keep parent-sampled
    // children sampled. Confirm we call through to it on the default branch.
    let receivedFallback: number | undefined;
    const sampler = (fb: number) => {
      receivedFallback = fb;
      return 0.42; // parent-driven rate
    };
    const rate = shouldSampleTransaction({
      name: 'POST /api/agent/command',
      inheritOrSampleWith: sampler,
    });
    assert.equal(rate, 0.42);
    assert.equal(receivedFallback, 0.1);
  });

  test('inheritOrSampleWith is NOT consulted on the explicit-rule branches', () => {
    // /api/events is forced to 1% regardless of parent sampling — a sampled
    // parent trace must not push it back up to 10%.
    let called = false;
    const rate = shouldSampleTransaction({
      name: 'POST /api/events',
      inheritOrSampleWith: () => {
        called = true;
        return 1.0;
      },
    });
    assert.equal(rate, 0.01);
    assert.equal(called, false);
  });

  test('falls back to normalizedRequest.url when name is missing', () => {
    assert.equal(
      shouldSampleTransaction({ normalizedRequest: { url: 'https://getstaxis.com/api/events' } }),
      0.01,
    );
  });

  test('falls back to location.href (browser SDK shape)', () => {
    assert.equal(
      shouldSampleTransaction({ location: { href: 'https://getstaxis.com/api/sms-reply' } }),
      0.01,
    );
  });

  test('handles empty / unknown context gracefully (returns global rate)', () => {
    assert.equal(shouldSampleTransaction({}), 0.1);
  });
});
