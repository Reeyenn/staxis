/**
 * Tests for timezone-aware day arithmetic.
 *
 * Each test pins a concrete UTC instant + a target timezone and asserts
 * the local date or local "today + N days" matches a hand-verified
 * expectation. Especially the DST transition cases and the high-positive
 * offset zone (Kiritimati) that broke the previous UTC-round-trip impl.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  propertyLocalToday,
  addDaysInTz,
  propertyLocalDateOffset,
} from '@/lib/schedule/local-date';

describe('propertyLocalToday', () => {
  it('returns the property local date in CT', () => {
    // 2026-05-15T01:00:00Z = 8 PM CDT on 2026-05-14
    const now = new Date('2026-05-15T01:00:00Z');
    assert.equal(
      propertyLocalToday(now, 'America/Chicago'),
      '2026-05-14',
    );
  });

  it('returns the property local date in Pacific/Kiritimati (UTC+14)', () => {
    // 2026-05-15T01:00:00Z = 3:00 PM (15:00) on 2026-05-15 in Kiritimati
    const now = new Date('2026-05-15T01:00:00Z');
    assert.equal(
      propertyLocalToday(now, 'Pacific/Kiritimati'),
      '2026-05-15',
    );
  });

  it('falls back to UTC date when timezone is null', () => {
    const now = new Date('2026-05-15T01:00:00Z');
    assert.equal(propertyLocalToday(now, null), '2026-05-15');
  });

  it('falls back to UTC date on invalid timezone string', () => {
    const now = new Date('2026-05-15T01:00:00Z');
    assert.equal(propertyLocalToday(now, 'Not/A/Real/TZ'), '2026-05-15');
  });
});

describe('addDaysInTz', () => {
  it('adds positive days across a month boundary', () => {
    assert.equal(addDaysInTz('2026-01-31', 1), '2026-02-01');
  });

  it('subtracts days across a year boundary', () => {
    assert.equal(addDaysInTz('2026-01-01', -1), '2025-12-31');
  });

  it('handles leap-year February correctly', () => {
    // 2028 is a leap year — Feb 28 + 1 = Feb 29, not Mar 1
    assert.equal(addDaysInTz('2028-02-28', 1), '2028-02-29');
    assert.equal(addDaysInTz('2028-02-29', 1), '2028-03-01');
  });

  it('zero days is a no-op', () => {
    assert.equal(addDaysInTz('2026-05-15', 0), '2026-05-15');
  });

  it('rejects malformed input', () => {
    assert.throws(() => addDaysInTz('2026/05/15', 1), /Invalid YYYY-MM-DD/);
    assert.throws(() => addDaysInTz('not-a-date', 1), /Invalid YYYY-MM-DD/);
    assert.throws(() => addDaysInTz('26-05-15', 1), /Invalid YYYY-MM-DD/);
  });
});

describe('propertyLocalDateOffset — Codex Round 18 regression cases', () => {
  // The original UTC-round-trip implementation broke for Pacific/Kiritimati
  // by skipping calendar dates. These tests pin the correct behavior.
  it('Kiritimati: target=today does NOT skip a day', () => {
    const now = new Date('2026-05-15T01:00:00Z');
    assert.equal(
      propertyLocalDateOffset(now, 'Pacific/Kiritimati', 0),
      '2026-05-15',
    );
  });

  it('Kiritimati: target=tomorrow is the very next calendar day', () => {
    const now = new Date('2026-05-15T01:00:00Z');
    // The previous broken impl returned '2026-05-17' — skipping 5-16.
    assert.equal(
      propertyLocalDateOffset(now, 'Pacific/Kiritimati', 1),
      '2026-05-16',
    );
  });

  it('Pacific/Honolulu (UTC-10): target=tomorrow advances by one day', () => {
    // 2026-05-15T22:00:00Z = 12:00 PM HST on 2026-05-15
    const now = new Date('2026-05-15T22:00:00Z');
    assert.equal(
      propertyLocalDateOffset(now, 'Pacific/Honolulu', 0),
      '2026-05-15',
    );
    assert.equal(
      propertyLocalDateOffset(now, 'Pacific/Honolulu', 1),
      '2026-05-16',
    );
  });

  it('America/Chicago: cron at 01:00 UTC = 8 PM CT previous day', () => {
    const now = new Date('2026-05-15T01:00:00Z');
    assert.equal(
      propertyLocalDateOffset(now, 'America/Chicago', 0),
      '2026-05-14',
    );
    assert.equal(
      propertyLocalDateOffset(now, 'America/Chicago', 1),
      '2026-05-15',
    );
  });

  it('America/Chicago: cron at 12:00 UTC = 7 AM CT same day', () => {
    const now = new Date('2026-05-15T12:00:00Z');
    assert.equal(
      propertyLocalDateOffset(now, 'America/Chicago', 0),
      '2026-05-15',
    );
    assert.equal(
      propertyLocalDateOffset(now, 'America/Chicago', 1),
      '2026-05-16',
    );
  });
});

describe('propertyLocalDateOffset — DST transitions', () => {
  // US "spring forward" 2026: 02:00 CST → 03:00 CDT on 2026-03-08
  it('crosses US DST spring-forward without losing or duplicating a day', () => {
    // Cron firing at 12:00 UTC on 2026-03-08 = 07:00 CST/CDT
    // Today's local date should be 2026-03-08
    const now = new Date('2026-03-08T12:00:00Z');
    assert.equal(propertyLocalDateOffset(now, 'America/Chicago', 0), '2026-03-08');
    // Tomorrow should be 2026-03-09 — even though "tomorrow" is one hour
    // shorter than usual because of the spring-forward.
    assert.equal(propertyLocalDateOffset(now, 'America/Chicago', 1), '2026-03-09');
    // Yesterday should be 2026-03-07
    assert.equal(propertyLocalDateOffset(now, 'America/Chicago', -1), '2026-03-07');
  });

  // US "fall back" 2026: 02:00 CDT → 01:00 CST on 2026-11-01
  it('crosses US DST fall-back without losing or duplicating a day', () => {
    // Cron firing at 12:00 UTC on 2026-11-01 = 06:00 CT (CST after fall-back)
    const now = new Date('2026-11-01T12:00:00Z');
    assert.equal(propertyLocalDateOffset(now, 'America/Chicago', 0), '2026-11-01');
    assert.equal(propertyLocalDateOffset(now, 'America/Chicago', 1), '2026-11-02');
    assert.equal(propertyLocalDateOffset(now, 'America/Chicago', -1), '2026-10-31');
  });
});
