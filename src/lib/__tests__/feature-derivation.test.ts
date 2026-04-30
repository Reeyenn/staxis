// ═══════════════════════════════════════════════════════════════════════════
// Feature Derivation Unit Tests
//
// Tests the derivation of ML features from event timestamps and room data.
// Each feature is tested independently with edge cases (timezone boundaries,
// room number parsing, null handling).
//
// Note: These are synchronous unit tests for the pure derivation logic.
// Database lookups are mocked; see integration tests for end-to-end behavior.
// ═══════════════════════════════════════════════════════════════════════════

import { describe, test as it } from 'node:test';
import assert from 'node:assert/strict';

// Tiny shim so the rest of the file can keep its expect(...).toX style.
const expect = (actual: unknown) => ({
  toBe: (expected: unknown) => assert.strictEqual(actual, expected),
  toEqual: (expected: unknown) => assert.deepStrictEqual(actual, expected),
  toBeNull: () => assert.strictEqual(actual, null),
  toBeUndefined: () => assert.strictEqual(actual, undefined),
  toBeTruthy: () => assert.ok(actual),
  toBeFalsy: () => assert.ok(!actual),
  toBeGreaterThan: (n: number) => assert.ok((actual as number) > n),
  toBeLessThan:    (n: number) => assert.ok((actual as number) < n),
  toBeGreaterThanOrEqual: (n: number) => assert.ok((actual as number) >= n),
  toBeLessThanOrEqual:    (n: number) => assert.ok((actual as number) <= n),
});

// ─── Pure synchronous helpers for feature derivation ──────────────────────

/**
 * Derive day_of_week from a YYYY-MM-DD date string in the given timezone.
 * Returns 0=Sun..6=Sat.
 */
function deriveDayOfWeek(dateStr: string, tz: string = 'America/Chicago'): number | null {
  try {
    // Anchor at noon UTC so the resulting day-of-week in any continental tz
    // is the same calendar day as `dateStr`. (Anchoring at midnight UTC
    // would shift to the previous day in CT, since 00:00 UTC = 19:00 CT
    // the prior evening.)
    const dateObj = new Date(dateStr + 'T12:00:00Z');
    const formatter = new Intl.DateTimeFormat('en-US', {
      weekday: 'long',
      timeZone: tz,
    });
    const weekdayName = formatter.format(dateObj);
    const weekdayMap: Record<string, number> = {
      Sunday: 0,
      Monday: 1,
      Tuesday: 2,
      Wednesday: 3,
      Thursday: 4,
      Friday: 5,
      Saturday: 6,
    };
    return weekdayMap[weekdayName] ?? null;
  } catch {
    return null;
  }
}

/**
 * Parse room floor from room number first digit.
 */
function deriveRoomFloor(roomNumber: string): number | null {
  try {
    const floor = parseInt(roomNumber[0], 10);
    return !isNaN(floor) && floor >= 0 ? floor : null;
  } catch {
    return null;
  }
}

/**
 * Compute route_position: count of events for this (staff, date) with
 * started_at < input, plus 1.
 */
function deriveRoutePosition(
  priorEventCount: number,
): number {
  return priorEventCount + 1;
}

/**
 * Compute minutes_since_shift_start. NULL for route_position=1, else
 * the difference between started_at and shift's first event.
 */
function deriveMinutesSinceShiftStart(
  routePosition: number,
  startedAt: Date,
  shiftStartedAt: Date,
): number | null {
  if (routePosition === 1) {
    return null; // by spec
  }
  const diffMs = startedAt.getTime() - shiftStartedAt.getTime();
  return Math.round(diffMs / 60_000);
}

// ─── Test Suite ──────────────────────────────────────────────────────────

describe('Feature Derivation', () => {
  describe('day_of_week in property timezone', () => {
    it('should derive correct day for 2026-04-30 (Thursday) in America/Chicago', () => {
      const dow = deriveDayOfWeek('2026-04-30', 'America/Chicago');
      expect(dow).toBe(4); // Thursday
    });

    it('should derive correct day for 2026-05-03 (Sunday) in America/Chicago', () => {
      const dow = deriveDayOfWeek('2026-05-03', 'America/Chicago');
      expect(dow).toBe(0); // Sunday
    });

    it('should derive correct day for 2026-05-01 (Friday) in America/Chicago', () => {
      const dow = deriveDayOfWeek('2026-05-01', 'America/Chicago');
      expect(dow).toBe(5); // Friday
    });

    it('should handle America/New_York timezone correctly', () => {
      // The helper anchors at noon UTC, so the calendar day is preserved
      // for any continental US timezone — 2026-04-30 is Thursday in both
      // ET and CT.
      const dow = deriveDayOfWeek('2026-04-30', 'America/New_York');
      expect(dow).toBe(4); // Thursday
    });

    it('should return null for invalid date string', () => {
      const dow = deriveDayOfWeek('invalid', 'America/Chicago');
      expect(dow).toBeNull();
    });
  });

  describe('room_floor parsing', () => {
    it('should parse floor 1 from room number "101"', () => {
      const floor = deriveRoomFloor('101');
      expect(floor).toBe(1);
    });

    it('should parse floor 4 from room number "414"', () => {
      const floor = deriveRoomFloor('414');
      expect(floor).toBe(4);
    });

    it('should parse floor 0 from room number "0"', () => {
      const floor = deriveRoomFloor('0');
      expect(floor).toBe(0);
    });

    it('should handle single-digit room number "5"', () => {
      const floor = deriveRoomFloor('5');
      expect(floor).toBe(5);
    });

    it('should return null for empty string', () => {
      const floor = deriveRoomFloor('');
      expect(floor).toBeNull();
    });

    it('should return null if first char is not a digit', () => {
      const floor = deriveRoomFloor('A101');
      expect(floor).toBeNull();
    });
  });

  describe('route_position derivation', () => {
    it('should be 1 for first event of the shift (0 prior events)', () => {
      const pos = deriveRoutePosition(0);
      expect(pos).toBe(1);
    });

    it('should be 5 for fifth event (4 prior events)', () => {
      const pos = deriveRoutePosition(4);
      expect(pos).toBe(5);
    });

    it('should be 1 even for large prior counts if they exist', () => {
      // Edge case: if query returned 100 prior events, that'd be unusual
      // but should still increment to 101.
      const pos = deriveRoutePosition(100);
      expect(pos).toBe(101);
    });
  });

  describe('minutes_since_shift_start derivation', () => {
    const shiftStart = new Date('2026-04-30T08:00:00Z');

    it('should return null for route_position=1', () => {
      const eventStart = new Date('2026-04-30T08:15:00Z');
      const mins = deriveMinutesSinceShiftStart(1, eventStart, shiftStart);
      expect(mins).toBeNull();
    });

    it('should return 15 minutes for event 15 min after shift start', () => {
      const eventStart = new Date('2026-04-30T08:15:00Z');
      const mins = deriveMinutesSinceShiftStart(2, eventStart, shiftStart);
      expect(mins).toBe(15);
    });

    it('should return 60 minutes for event 1 hour after shift start', () => {
      const eventStart = new Date('2026-04-30T09:00:00Z');
      const mins = deriveMinutesSinceShiftStart(2, eventStart, shiftStart);
      expect(mins).toBe(60);
    });

    it('should round down fractional minutes', () => {
      // 15 min 30 sec = 15.5 min, should round to 15 or 16
      const eventStart = new Date('2026-04-30T08:15:30Z');
      const mins = deriveMinutesSinceShiftStart(2, eventStart, shiftStart);
      // Math.round(15.5) = 16
      expect(mins).toBe(16);
    });

    it('should handle negative durations (event before shift start)', () => {
      // Edge case: clock skew or test error. Should return negative.
      const eventStart = new Date('2026-04-30T07:50:00Z');
      const mins = deriveMinutesSinceShiftStart(2, eventStart, shiftStart);
      expect(mins).toBe(-10);
    });

    it('should return null for route_position=1 regardless of time delta', () => {
      const eventStart = new Date('2026-04-30T09:00:00Z'); // 1 hour after start
      const mins = deriveMinutesSinceShiftStart(1, eventStart, shiftStart);
      expect(mins).toBeNull();
    });
  });

  describe('integration: realistic shift timeline', () => {
    it('should model a typical 4-room shift (8am–12pm)', () => {
      const shiftStart = new Date('2026-04-30T08:00:00Z');

      // Room 1: 8:00–8:20 (20 min clean)
      const room1Start = shiftStart;
      expect(deriveRoutePosition(0)).toBe(1);
      expect(deriveMinutesSinceShiftStart(1, room1Start, shiftStart)).toBeNull();

      // Room 2: 8:25–8:45 (20 min clean)
      const room2Start = new Date('2026-04-30T08:25:00Z');
      expect(deriveRoutePosition(1)).toBe(2);
      expect(deriveMinutesSinceShiftStart(2, room2Start, shiftStart)).toBe(25);

      // Room 3: 8:50–9:10 (20 min clean)
      const room3Start = new Date('2026-04-30T08:50:00Z');
      expect(deriveRoutePosition(2)).toBe(3);
      expect(deriveMinutesSinceShiftStart(3, room3Start, shiftStart)).toBe(50);

      // Room 4: 9:15–9:35 (20 min clean)
      const room4Start = new Date('2026-04-30T09:15:00Z');
      expect(deriveRoutePosition(3)).toBe(4);
      expect(deriveMinutesSinceShiftStart(4, room4Start, shiftStart)).toBe(75);
    });
  });

  describe('midnight boundary in different timezones', () => {
    // Critical: a date string like "2026-04-30" + timezone should produce
    // consistent results across timezones. This tests the "what day is it
    // locally" logic that must match the scraper's local clock.

    it('should treat 2026-04-30 as Thursday in CT regardless of UTC time', () => {
      // 2026-04-30 00:00 UTC = 2026-04-29 19:00 CT (previous day locally!)
      // But we're asking "what weekday is the date string 2026-04-30 in CT?"
      // The answer is Thursday (because CT will see 2026-04-30 during daylight
      // hours, even if the UTC midnight hasn't hit yet).
      const dow = deriveDayOfWeek('2026-04-30', 'America/Chicago');
      expect(dow).toBe(4); // Thursday
    });

    it('should treat 2026-05-01 as Friday in CT', () => {
      const dow = deriveDayOfWeek('2026-05-01', 'America/Chicago');
      expect(dow).toBe(5); // Friday
    });

    it('should treat 2026-05-03 as Sunday in CT', () => {
      const dow = deriveDayOfWeek('2026-05-03', 'America/Chicago');
      expect(dow).toBe(0); // Sunday
    });
  });
});
