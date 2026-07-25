/**
 * The business date — the one definition of "which hotel-day is this?".
 *
 * Three classes of bug this file exists to catch, all of which have real
 * precedent in this repo:
 *
 *   1. UTC ROUND-TRIP. src/lib/schedule/local-date.ts exists because a
 *      noon-UTC anchor plus a UTC day-add silently skipped a calendar date at
 *      Pacific/Kiritimati (UTC+14). Any implementation that formats in UTC, or
 *      that adds days through an instant, fails the +14 cases below.
 *
 *   2. DST. Chicago's spring-forward skips 02:00 and its fall-back repeats
 *      01:00. Both must land on the plain calendar day; an implementation that
 *      subtracts 24h from an instant gets the fall-back case wrong.
 *
 *   3. THE CUTOFF. A hotel whose night audit runs at 3am must put a 02:15
 *      transaction on the day that is closing, not the one that is opening.
 *      Cutoff 0 must be a numeric NO-OP versus the old calendar-day behavior —
 *      every live property is on 0, so any drift here is a silent data change.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  businessDate,
  businessDateFromReport,
  assertBusinessDateFormat,
  isBusinessDate,
} from '@/lib/business-date';
import { sealTargetBusinessDate } from '@/lib/seal-daily';

const CHI = 'America/Chicago';
const KIR = 'Pacific/Kiritimati'; // UTC+14, the zone that broke the old math

/** Reference implementation of "the plain local calendar day", computed a
 *  different way from the one under test, so agreement is meaningful. */
function localCalendarDay(instant: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(instant);
}

describe('businessDate — cutoff 0 is the plain local calendar day', () => {
  const prop = { timezone: CHI, business_date_cutoff_hour: 0 };

  test('spring-forward: 01:30 local on the day DST starts', () => {
    // 2026-03-08 02:00 CST -> 03:00 CDT. 01:30 CST is 07:30 UTC.
    const instant = new Date('2026-03-08T07:30:00Z');
    assert.equal(businessDate(prop, instant), '2026-03-08');
    assert.equal(businessDate(prop, instant), localCalendarDay(instant, CHI));
  });

  test('spring-forward: 03:30 local, just after the skipped hour', () => {
    const instant = new Date('2026-03-08T08:30:00Z'); // 03:30 CDT
    assert.equal(businessDate(prop, instant), '2026-03-08');
  });

  test('fall-back: BOTH occurrences of 01:30 local land on the same day', () => {
    // 2026-11-01 02:00 CDT -> 01:00 CST. 01:30 happens twice.
    const first = new Date('2026-11-01T06:30:00Z');  // 01:30 CDT
    const second = new Date('2026-11-01T07:30:00Z'); // 01:30 CST
    assert.equal(businessDate(prop, first), '2026-11-01');
    assert.equal(businessDate(prop, second), '2026-11-01');
  });

  test('agrees with the plain local calendar day across a year of samples', () => {
    for (let day = 0; day < 365; day += 7) {
      for (const hourUtc of [0, 5, 6, 11, 18, 23]) {
        const instant = new Date(Date.UTC(2026, 0, 1 + day, hourUtc, 17, 0));
        assert.equal(
          businessDate(prop, instant),
          localCalendarDay(instant, CHI),
          `cutoff 0 must equal the calendar day (${instant.toISOString()})`,
        );
      }
    }
  });
});

describe('businessDate — UTC+14 (the skip-a-day trap)', () => {
  test('local date is AHEAD of the UTC date', () => {
    // 2026-05-16 10:00 local (+14) is 2026-05-15 20:00 UTC. A UTC-based
    // implementation answers 2026-05-15 — a whole day wrong.
    const instant = new Date('2026-05-15T20:00:00Z');
    assert.equal(instant.toISOString().slice(0, 10), '2026-05-15', 'fixture sanity');
    assert.equal(businessDate({ timezone: KIR, business_date_cutoff_hour: 0 }, instant), '2026-05-16');
  });

  test('the cutoff shift still crosses the LOCAL midnight, not the UTC one', () => {
    // 2026-05-16 02:00 local (+14) = 2026-05-15 12:00 UTC. With a 3am cutoff
    // the hotel is still working on the 15th.
    const instant = new Date('2026-05-15T12:00:00Z');
    assert.equal(businessDate({ timezone: KIR, business_date_cutoff_hour: 3 }, instant), '2026-05-15');
    assert.equal(businessDate({ timezone: KIR, business_date_cutoff_hour: 0 }, instant), '2026-05-16');
  });
});

describe('businessDate — the night-audit cutoff', () => {
  test('cutoff 3: 02:15 local belongs to the day that is CLOSING', () => {
    const instant = new Date('2026-06-10T07:15:00Z'); // 02:15 CDT
    assert.equal(localCalendarDay(instant, CHI), '2026-06-10', 'fixture sanity');
    assert.equal(businessDate({ timezone: CHI, business_date_cutoff_hour: 3 }, instant), '2026-06-09');
  });

  test('cutoff 3: 03:00 local belongs to the new day', () => {
    const instant = new Date('2026-06-10T08:00:00Z'); // 03:00 CDT
    assert.equal(businessDate({ timezone: CHI, business_date_cutoff_hour: 3 }, instant), '2026-06-10');
  });

  test('cutoff 3 rolls the month and year backwards correctly', () => {
    const newYear = new Date('2026-01-01T07:30:00Z'); // 01:30 CST on Jan 1
    assert.equal(businessDate({ timezone: CHI, business_date_cutoff_hour: 3 }, newYear), '2025-12-31');
  });

  test('an out-of-range or garbage cutoff degrades to 0, never to a random shift', () => {
    const instant = new Date('2026-06-10T07:15:00Z'); // 02:15 CDT
    for (const bad of [-1, 25, Number.NaN, null, undefined]) {
      assert.equal(
        businessDate({ timezone: CHI, business_date_cutoff_hour: bad as number | null }, instant),
        '2026-06-10',
        `cutoff ${String(bad)} must fall back to plain calendar day`,
      );
    }
  });
});

describe('businessDate — a bad timezone must not take the write down', () => {
  test('invalid IANA string falls back to UTC instead of throwing', () => {
    const instant = new Date('2026-05-15T20:00:00Z');
    assert.equal(businessDate({ timezone: 'Mars/Olympus_Mons', business_date_cutoff_hour: 0 }, instant), '2026-05-15');
  });

  test('null / empty timezone falls back to UTC', () => {
    const instant = new Date('2026-05-15T20:00:00Z');
    assert.equal(businessDate({ timezone: null, business_date_cutoff_hour: 0 }, instant), '2026-05-15');
    assert.equal(businessDate({ timezone: '   ', business_date_cutoff_hour: 0 }, instant), '2026-05-15');
  });
});

describe('businessDateFromReport — what the report printed, or nothing', () => {
  test('returns the printed date verbatim, trimmed', () => {
    assert.equal(businessDateFromReport('2026-06-09'), '2026-06-09');
    assert.equal(businessDateFromReport('  2026-06-09 '), '2026-06-09');
  });

  test('refuses a date that does not exist rather than rolling it forward', () => {
    // Date.UTC(2026, 1, 31) silently becomes March 3rd. A garbled report must
    // NOT quietly land revenue on a plausible-looking wrong day.
    assert.throws(() => businessDateFromReport('2026-02-31'), /not a real calendar date/);
    assert.throws(() => businessDateFromReport('2026-13-01'), /not a real calendar date/);
    assert.throws(() => businessDateFromReport('2026-06-00'), /not a real calendar date/);
  });

  test('refuses anything that is not YYYY-MM-DD', () => {
    for (const bad of ['06/09/2026', '2026-6-9', '', 'yesterday', '2026-06-09T00:00:00Z']) {
      assert.throws(() => businessDateFromReport(bad), /business date must be YYYY-MM-DD|not a real calendar date/);
    }
  });

  test('assertBusinessDateFormat / isBusinessDate agree', () => {
    assert.equal(isBusinessDate('2026-02-29'), false, '2026 is not a leap year');
    assert.equal(isBusinessDate('2024-02-29'), true, '2024 is');
    assert.doesNotThrow(() => assertBusinessDateFormat('2024-02-29'));
    assert.throws(() => assertBusinessDateFormat(20260609 as unknown as string));
  });
});

describe('sealTargetBusinessDate — which day the nightly seal closes', () => {
  test('cutoff 0 at 01:00 local seals yesterday (unchanged behavior)', () => {
    const instant = new Date('2026-06-10T06:00:00Z'); // 01:00 CDT
    assert.equal(
      sealTargetBusinessDate({ timezone: CHI, business_date_cutoff_hour: 0 }, instant),
      '2026-06-09',
    );
  });

  test('cutoff 0 before 01:00 local is too early — returns null', () => {
    const instant = new Date('2026-06-10T05:30:00Z'); // 00:30 CDT
    assert.equal(sealTargetBusinessDate({ timezone: CHI, business_date_cutoff_hour: 0 }, instant), null);
  });

  test('cutoff 3 at 02:00 local is still inside the open business day — null', () => {
    const instant = new Date('2026-06-10T07:00:00Z'); // 02:00 CDT
    assert.equal(sealTargetBusinessDate({ timezone: CHI, business_date_cutoff_hour: 3 }, instant), null);
  });

  test('cutoff 3 at 04:00 local seals the business day that just closed', () => {
    const instant = new Date('2026-06-10T09:00:00Z'); // 04:00 CDT
    assert.equal(
      sealTargetBusinessDate({ timezone: CHI, business_date_cutoff_hour: 3 }, instant),
      '2026-06-09',
    );
  });

  test('over 24 hourly ticks a cutoff-3 hotel seals each business day exactly once', () => {
    const sealed = new Set<string>();
    for (let h = 0; h < 24; h++) {
      const instant = new Date(Date.UTC(2026, 5, 10, h, 0, 0));
      const target = sealTargetBusinessDate({ timezone: CHI, business_date_cutoff_hour: 3 }, instant);
      if (target) sealed.add(target);
    }
    // Exactly the two business days the UTC day straddles for a CDT hotel, no
    // gap and no third stray date.
    assert.deepEqual([...sealed].sort(), ['2026-06-08', '2026-06-09']);
  });
});
