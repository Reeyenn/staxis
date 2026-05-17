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

import { getBaseSentryOptions } from '@/lib/sentry-base';
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
