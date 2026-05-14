/**
 * Tests for propertyLocalDate in src/app/api/cron/seed-rooms-daily/route.ts.
 *
 * Round 14 (2026-05-14). The cron walks every property and computes its
 * local-today date so the seed lands on the right rooms.date value.
 * Beaumont is America/Chicago; the rest of the fleet might be on
 * different timezones. The fallback (when timezone is missing or
 * invalid) must be UTC today — never throw.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { propertyLocalDate } from '@/app/api/cron/seed-rooms-daily/route';

describe('propertyLocalDate', () => {
  it('returns the property-local date in YYYY-MM-DD', () => {
    // 2026-05-14 04:30 UTC = 2026-05-13 23:30 in Chicago (CDT = UTC-5)
    const utc = new Date('2026-05-14T04:30:00Z');
    assert.equal(propertyLocalDate(utc, 'America/Chicago'), '2026-05-13');
  });

  it('crosses the day boundary correctly for an evening UTC moment', () => {
    // 2026-05-14 23:30 UTC = 2026-05-14 18:30 in Chicago
    const utc = new Date('2026-05-14T23:30:00Z');
    assert.equal(propertyLocalDate(utc, 'America/Chicago'), '2026-05-14');
  });

  it('handles a positive-offset timezone (Tokyo, UTC+9)', () => {
    // 2026-05-14 16:00 UTC = 2026-05-15 01:00 in Tokyo
    const utc = new Date('2026-05-14T16:00:00Z');
    assert.equal(propertyLocalDate(utc, 'Asia/Tokyo'), '2026-05-15');
  });

  it('falls back to UTC today when timezone is null', () => {
    const utc = new Date('2026-05-14T15:00:00Z');
    assert.equal(propertyLocalDate(utc, null), '2026-05-14');
  });

  it('falls back to UTC today on an invalid IANA timezone string', () => {
    const utc = new Date('2026-05-14T15:00:00Z');
    // Intl.DateTimeFormat throws on a malformed zone name; we should
    // catch and fall back rather than letting the cron crash.
    assert.equal(propertyLocalDate(utc, 'Not/A_RealZone'), '2026-05-14');
  });

  it('falls back to UTC today on an empty timezone string', () => {
    const utc = new Date('2026-05-14T15:00:00Z');
    assert.equal(propertyLocalDate(utc, ''), '2026-05-14');
  });
});
