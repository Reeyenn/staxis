/**
 * Tests for propertyMidnightIso — the helper that converts the
 * property's IANA timezone into a UTC ISO string for "today at 00:00
 * in that timezone." Used by the inspections stats endpoint so the
 * "today" boundary lines up with the property's local clock, not the
 * server's.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { propertyMidnightIso } from '@/lib/inspections/property-midnight';

// Pin "now" so the test is deterministic. We swap globalThis.Date for a
// proxy that intercepts no-arg construction and Date.now(). All other
// constructor signatures pass through to the real Date.
const REAL_DATE = Date;

function pinNow(iso: string): void {
  const pinned = new REAL_DATE(iso).getTime();
  const FakeDate = function (
    this: Date | void,
    ...args: unknown[]
  ): Date | string {
    if (!(this instanceof FakeDate)) {
      // Called without `new` — return ISO string of the pinned date.
      return new REAL_DATE(pinned).toString();
    }
    if (args.length === 0) {
      return new REAL_DATE(pinned) as unknown as Date;
    }
    return new (REAL_DATE as unknown as new (...a: unknown[]) => Date)(...args);
  } as unknown as DateConstructor;
  // Copy static methods.
  FakeDate.now = () => pinned;
  FakeDate.UTC = REAL_DATE.UTC;
  FakeDate.parse = REAL_DATE.parse;
  Object.setPrototypeOf(FakeDate, REAL_DATE);
  (FakeDate as unknown as { prototype: object }).prototype = REAL_DATE.prototype;
  (globalThis as unknown as { Date: DateConstructor }).Date = FakeDate;
}

function restoreNow(): void {
  (globalThis as unknown as { Date: DateConstructor }).Date = REAL_DATE;
}

describe('propertyMidnightIso', () => {
  after(restoreNow);

  it('rolls back to the previous-UTC-day for properties west of UTC near server-midnight', () => {
    // It is currently 2026-05-25 02:00 UTC. In America/Chicago (UTC-5),
    // that's 2026-05-24 21:00 — still "today" in Chicago, where today
    // is May 24 (which started at 2026-05-24 05:00 UTC).
    pinNow('2026-05-25T02:00:00Z');
    const got = propertyMidnightIso('America/Chicago');
    assert.equal(got, new Date('2026-05-24T05:00:00.000Z').toISOString());
  });

  it('matches the UTC midnight when tz is UTC', () => {
    pinNow('2026-05-25T15:30:00Z');
    const got = propertyMidnightIso('UTC');
    assert.equal(got, '2026-05-25T00:00:00.000Z');
  });

  it('returns the upcoming UTC time when tz is far east of UTC', () => {
    // It is currently 2026-05-25 14:00 UTC. In Asia/Tokyo (UTC+9), that's
    // 2026-05-25 23:00 — already late evening on May 25 in Tokyo.
    // Today-midnight in Tokyo (May 25 00:00 JST) was 2026-05-24 15:00 UTC.
    pinNow('2026-05-25T14:00:00Z');
    const got = propertyMidnightIso('Asia/Tokyo');
    assert.equal(got, '2026-05-24T15:00:00.000Z');
  });

  it('handles DST spring-forward correctly in America/New_York', () => {
    // 2026-03-08 was a DST spring-forward day. At 09:00 UTC on that
    // date, NY's *current* offset is EDT -04:00 (because DST already
    // jumped at 02:00 local). But local midnight that morning was
    // still EST -05:00 — meaning midnight NY = 05:00 UTC, not 04:00 UTC.
    // The old "current wall-clock offset" math returned 04:00Z and
    // mis-attributed the last hour of yesterday to today.
    pinNow('2026-03-08T09:00:00Z');
    const got = propertyMidnightIso('America/New_York');
    assert.equal(got, '2026-03-08T05:00:00.000Z');
  });

  it('handles DST fall-back correctly in America/New_York', () => {
    // 2026-11-01 fall-back: NY went from EDT -04:00 to EST -05:00 at
    // 02:00 local. Local midnight that morning was EDT (since fall
    // happens AT 02:00). So midnight NY = 04:00 UTC. Pin now to a time
    // after the transition so the current offset is EST (-05:00) and
    // confirm the function doesn't return 05:00Z by mistake.
    pinNow('2026-11-01T15:00:00Z');
    const got = propertyMidnightIso('America/New_York');
    assert.equal(got, '2026-11-01T04:00:00.000Z');
  });

  it('handles fractional-hour offsets (Asia/Kolkata = UTC+05:30)', () => {
    // It is 2026-05-25 12:00 UTC. In Kolkata (+05:30) that's 17:30.
    // Midnight in Kolkata today = 2026-05-24 18:30 UTC.
    pinNow('2026-05-25T12:00:00Z');
    const got = propertyMidnightIso('Asia/Kolkata');
    assert.equal(got, '2026-05-24T18:30:00.000Z');
  });

  it('produces an ISO string that an inspection.startedAt UTC compare reads correctly', () => {
    // Anchor: now is 2026-05-25 13:00 UTC = 2026-05-25 08:00 Chicago.
    // Midnight in Chicago today (May 25 00:00 CDT) = 2026-05-25 05:00 UTC.
    pinNow('2026-05-25T13:00:00Z');
    const today = propertyMidnightIso('America/Chicago');

    // An inspection started at 2026-05-25 03:00 UTC (= 2026-05-24 22:00 Chicago,
    // so YESTERDAY locally) must be BEFORE today's boundary.
    const yesterday = '2026-05-25T03:00:00.000Z';
    assert.ok(yesterday < today, 'yesterday-local should be before today-local midnight');

    // An inspection started at 2026-05-25 12:00 UTC (= 2026-05-25 07:00 Chicago,
    // today locally) must be AT-OR-AFTER today's boundary.
    const todayInsp = '2026-05-25T12:00:00.000Z';
    assert.ok(todayInsp >= today, 'today-local should be at or after today-local midnight');
  });
});
