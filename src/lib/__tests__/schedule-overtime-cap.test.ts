/**
 * The overtime / weekly-day caps, exercised end to end the way the nightly
 * auto-fill cron composes them:
 *
 *   computeWeeklyLoadByStaff(property, targetDate)   →  overlay onto the staff
 *   row  →  checkCrewEligibility(staff, { targetDate })
 *
 * The bug this pins (2026-08-07): the committed-load window used to INCLUDE
 * `targetDate`, and both caps compare with `>=`. A housekeeper on the ordinary
 * five-days-a-week, eight-hours-a-day schedule therefore reached days = 5 and
 * hours = 40 — the two defaults — on her FIFTH day, and was thrown out of the
 * crew with `weekly_day_cap_reached` on a day she was rostered, standing in the
 * hotel, and inside every limit. When the whole crew shares that schedule the
 * cron sees zero eligible housekeepers and assigns nobody any rooms.
 *
 * These tests use a reader that honestly obeys the window it is handed, so they
 * fail if the window bounds move back to including the target date, and they
 * still fail if someone widens the caps to paper over it.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import type { StaffMember } from '@/types';
import { checkCrewEligibility } from '@/lib/schedule/active-crew';
import {
  computeWeeklyLoadByStaff,
  weeklyLoadWindow,
  type WeeklyLoadReader,
  type WeeklyLoadShiftRow,
} from '@/lib/schedule/weekly-load';

const PID = '11111111-1111-1111-1111-111111111111';
const MARIA = '22222222-2222-2222-2222-222222222222';

/** Five consecutive days, then the day after them. */
const DAY_1 = '2026-08-03';
const DAY_2 = '2026-08-04';
const DAY_3 = '2026-08-05';
const DAY_4 = '2026-08-06';
const DAY_5 = '2026-08-07';
const DAY_6 = '2026-08-08';

/** A full-time housekeeper on the product's default caps. */
function maria(overlay: Partial<StaffMember> = {}): StaffMember {
  return {
    id: MARIA,
    name: 'Maria',
    language: 'en',
    isSenior: false,
    department: 'housekeeping',
    isActive: true,
    scheduledToday: false,
    // The defaults checkCrewEligibility falls back to, stated explicitly so the
    // scenario does not silently change if the fallbacks change.
    maxDaysPerWeek: 5,
    maxWeeklyHours: 40,
    weeklyHours: 0,
    daysWorkedThisWeek: 0,
    ...overlay,
  };
}

/** One 8-hour shift on each of the given days. */
function eightHourDays(dates: readonly string[]): WeeklyLoadShiftRow[] {
  return dates.map((shift_date) => ({
    staff_id: MARIA,
    shift_date,
    start_time: '09:00:00',
    end_time: '17:00:00',
  }));
}

/**
 * A reader that returns only the rows falling inside the window it is asked
 * for. That is the point: the assertions below are about WHICH days the load
 * counts, so the fake must not hand back everything regardless.
 */
function readerFor(rows: readonly WeeklyLoadShiftRow[]): WeeklyLoadReader {
  return {
    async shiftsInWindow(_propertyId, window) {
      return rows.filter(
        (r) => r.shift_date != null && r.shift_date >= window.start && r.shift_date <= window.end,
      );
    },
  };
}

/** The cron's exact composition: load → overlay → eligibility. */
async function eligibilityOn(
  targetDate: string,
  rows: readonly WeeklyLoadShiftRow[],
  staff: StaffMember = maria(),
) {
  const load = await computeWeeklyLoadByStaff(PID, targetDate, readerFor(rows));
  const committed = load.get(staff.id);
  const withLoad: StaffMember = committed
    ? { ...staff, weeklyHours: committed.hours, daysWorkedThisWeek: committed.days }
    : staff;
  return { result: checkCrewEligibility(withLoad, { targetDate }), committed };
}

describe('weeklyLoadWindow', () => {
  test('covers the six days before the target date and never the target date itself', () => {
    // The day being decided is not "already committed" — the caller is asking
    // whether to add work to it.
    assert.deepEqual(weeklyLoadWindow(DAY_5), { start: '2026-08-01', end: DAY_4 });
  });

  test('with the day being decided, the caps still span seven days', () => {
    const w = weeklyLoadWindow(DAY_5);
    const spanDays =
      (Date.parse(`${w.end}T00:00:00Z`) - Date.parse(`${w.start}T00:00:00Z`)) / 86_400_000 + 1;
    assert.equal(spanDays, 6, 'six committed days + the target date = a seven-day cap window');
  });
});

describe('a full-time housekeeper on her fifth day', () => {
  test('is still on the crew (the fifth of five days is inside the cap, not past it)', async () => {
    const { result, committed } = await eligibilityOn(
      DAY_5,
      eightHourDays([DAY_1, DAY_2, DAY_3, DAY_4, DAY_5]),
    );
    assert.deepEqual(
      committed,
      { hours: 32, days: 4 },
      'the four days before her fifth are what she is already committed to',
    );
    assert.equal(
      result.eligible,
      true,
      `Maria is rostered on ${DAY_5} and inside both caps, but was excluded as ${result.reason}`,
    );
  });

  test('the whole crew does not vanish, so the cron still has someone to give rooms to', async () => {
    const shifts = eightHourDays([DAY_1, DAY_2, DAY_3, DAY_4, DAY_5]);
    const load = await computeWeeklyLoadByStaff(PID, DAY_5, readerFor(shifts));
    const crew = [maria()].map((s) => {
      const l = load.get(s.id);
      return l ? { ...s, weeklyHours: l.hours, daysWorkedThisWeek: l.days } : s;
    });
    const eligible = crew.filter((s) => checkCrewEligibility(s, { targetDate: DAY_5 }).eligible);
    assert.equal(eligible.length, 1, 'an all-Mon-to-Fri crew must not empty out on the fifth day');
  });
});

describe('the caps still bite when they should', () => {
  test('a sixth consecutive day is refused on the day cap', async () => {
    const { result, committed } = await eligibilityOn(
      DAY_6,
      eightHourDays([DAY_1, DAY_2, DAY_3, DAY_4, DAY_5]),
    );
    assert.deepEqual(committed, { hours: 40, days: 5 });
    assert.equal(result.eligible, false);
    assert.equal(result.reason, 'weekly_day_cap_reached');
  });

  test('someone already past 40 hours in four long days is refused on the hour cap', async () => {
    // Four 11-hour days = 44h committed, still only 4 days, so only the hour
    // cap can catch this one.
    const longDays: WeeklyLoadShiftRow[] = [DAY_1, DAY_2, DAY_3, DAY_4].map((shift_date) => ({
      staff_id: MARIA,
      shift_date,
      start_time: '07:00:00',
      end_time: '18:00:00',
    }));
    const { result, committed } = await eligibilityOn(DAY_5, longDays);
    assert.deepEqual(committed, { hours: 44, days: 4 });
    assert.equal(result.eligible, false);
    assert.equal(result.reason, 'weekly_hour_cap_reached');
  });

  test('an overnight shift counts its full length toward the cap', async () => {
    // 23:00 -> 07:00 is 8 hours, not a negative number and not zero. Five of
    // them puts her at 40h, so a sixth day is refused on hours as well as days.
    const overnights: WeeklyLoadShiftRow[] = [DAY_1, DAY_2, DAY_3, DAY_4, DAY_5].map(
      (shift_date) => ({
        staff_id: MARIA,
        shift_date,
        start_time: '23:00:00',
        end_time: '07:00:00',
      }),
    );
    const { committed } = await eligibilityOn(DAY_6, overnights);
    assert.deepEqual(committed, { hours: 40, days: 5 });
  });
});

describe('degrading', () => {
  test('a failed schedule read leaves the load unknown rather than inventing one', async () => {
    const failing: WeeklyLoadReader = {
      async shiftsInWindow() {
        throw new Error('scheduled_shifts read failed: boom');
      },
    };
    const load = await computeWeeklyLoadByStaff(PID, DAY_5, failing);
    assert.equal(load.size, 0);
  });
});
