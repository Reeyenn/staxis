/**
 * Tests for validateFutureTimestamp — the validator behind the
 * "pause delivery until" field in /api/settings/notifications.
 *
 * Why a dedicated test file: silently accepting past timestamps was
 * the prior behavior — the cron's "paused_until > now" filter just
 * didn't fire and the user got a 200 with no actual pause. The
 * server-side reject is the boundary that makes the UI's "this date
 * must be in the future" form validation reliable.
 *
 * `now` is injected on every assertion so the test stays
 * deterministic regardless of when CI runs.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { validateFutureTimestamp } from '@/lib/api-validate';

const NOW = Date.parse('2026-05-25T12:00:00Z');

describe('validateFutureTimestamp', () => {
  describe('shape', () => {
    test('non-string input is rejected', () => {
      const r = validateFutureTimestamp(null, { label: 'pausedUntil' });
      assert.match(r.error ?? '', /must be an ISO date string/);
    });

    test('garbage string is rejected', () => {
      const r = validateFutureTimestamp('not-a-date', { label: 'pausedUntil' });
      assert.match(r.error ?? '', /not a valid ISO date string/);
    });
  });

  describe('past timestamps — strict by default', () => {
    test('a clearly-past timestamp is rejected', () => {
      const r = validateFutureTimestamp('2026-05-24T12:00:00Z', { label: 'pausedUntil', now: NOW });
      assert.match(r.error ?? '', /must be a future timestamp/);
    });

    test('default has NO slack — even 30s ago rejects', () => {
      // Strict by default — Codex adversarial review pointed out that a
      // permissive default contradicts the "reject past timestamps"
      // contract. Callers opt in via clockSkewSlackMs.
      const iso = new Date(NOW - 30_000).toISOString();
      const r = validateFutureTimestamp(iso, { label: 'pausedUntil', now: NOW });
      assert.match(r.error ?? '', /must be a future timestamp/);
    });

    test('clockSkewSlackMs override allows a recently-past stamp', () => {
      // 30 seconds past, with 60s opt-in slack → accepted.
      const iso = new Date(NOW - 30_000).toISOString();
      const r = validateFutureTimestamp(iso, {
        label: 'pausedUntil',
        now: NOW,
        clockSkewSlackMs: 60_000,
      });
      assert.equal(r.error, undefined);
      assert.equal(r.value, new Date(NOW - 30_000).toISOString());
    });

    test('beyond the opt-in slack still rejects', () => {
      // 90 seconds past, with only 60s of slack → still rejected.
      const iso = new Date(NOW - 90_000).toISOString();
      const r = validateFutureTimestamp(iso, {
        label: 'pausedUntil',
        now: NOW,
        clockSkewSlackMs: 60_000,
      });
      assert.match(r.error ?? '', /must be a future timestamp/);
    });
  });

  describe('future timestamps', () => {
    test('1 hour in the future is accepted', () => {
      const iso = new Date(NOW + 60 * 60_000).toISOString();
      const r = validateFutureTimestamp(iso, { label: 'pausedUntil', now: NOW });
      assert.equal(r.error, undefined);
      assert.equal(r.value, iso);
    });

    test('past the maxFutureDays cap is rejected', () => {
      // 200 days from NOW, with a 180-day cap.
      const iso = new Date(NOW + 200 * 24 * 60 * 60_000).toISOString();
      const r = validateFutureTimestamp(iso, {
        label: 'pausedUntil',
        maxFutureDays: 180,
        now: NOW,
      });
      assert.match(r.error ?? '', /cannot be more than 180 days/);
    });

    test('exactly at the maxFutureDays cap is accepted', () => {
      // Exactly 180 days from NOW → within the cap.
      const iso = new Date(NOW + 180 * 24 * 60 * 60_000).toISOString();
      const r = validateFutureTimestamp(iso, {
        label: 'pausedUntil',
        maxFutureDays: 180,
        now: NOW,
      });
      assert.equal(r.error, undefined);
    });

    test('without maxFutureDays the future is unbounded', () => {
      // Year 2100 is fine if no cap is set.
      const iso = '2100-01-01T00:00:00Z';
      const r = validateFutureTimestamp(iso, { label: 'pausedUntil', now: NOW });
      assert.equal(r.error, undefined);
    });
  });

  describe('label propagation', () => {
    test('error messages use the supplied label', () => {
      const r = validateFutureTimestamp('2020-01-01T00:00:00Z', { label: 'snoozeUntil', now: NOW });
      assert.match(r.error ?? '', /^snoozeUntil/);
    });
  });
});
