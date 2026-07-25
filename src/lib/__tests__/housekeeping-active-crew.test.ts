/**
 * Behavior tests for "who is on the housekeeping crew on date D?"
 * (src/lib/schedule/active-crew.ts — the schedule-derived resolver added
 * 2026-07-24).
 *
 * Why these matter:
 *   The housekeeping board used to read `staff.scheduled_today`, a
 *   non-date-aware boolean nothing ever writes, so a housekeeper who was
 *   off still showed up as a droppable crew row. The board now derives
 *   the crew from `scheduled_shifts`.
 *
 *   The single most dangerous failure mode of that change is the hotel
 *   that never adopted the Staff schedule: zero rows in scheduled_shifts
 *   would render an EMPTY board, which looks exactly like a broken
 *   product. The fallback is tested hardest below.
 *
 * No DB: the pure core takes rows directly, and the async resolver takes
 * an injectable reader.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  computeHousekeepingCrewForDate,
  resolveHousekeepingCrewForDate,
  shiftDurationMinutes,
  timeToMinutes,
  DEFAULT_CREW_SHIFT_MINUTES,
  type ScheduledShiftRow,
  type CrewScheduleReader,
} from '@/lib/schedule/active-crew';
import { propertyLocalToday } from '@/lib/schedule/local-date';

const DATE = '2026-07-24';

const ROSTER = [
  { id: 'maria', isActive: true },
  { id: 'brenda', isActive: true },
  { id: 'cindy', isActive: true },
  { id: 'gone', isActive: false },
];

function shift(
  staffId: string,
  over: Partial<ScheduledShiftRow> = {},
): ScheduledShiftRow {
  return {
    staff_id: staffId,
    shift_date: DATE,
    start_time: '08:00:00',
    end_time: '16:00:00',
    status: 'published',
    kind: 'shift',
    ...over,
  };
}

function ids(result: { members: Array<{ staffId: string }> }): string[] {
  return result.members.map(m => m.staffId).sort();
}

// ───────────────────────────────────────────────────────────────────────
describe('scheduled crew resolves from the shifts on file', () => {
  test('only staff with a shift that date are on the crew', () => {
    const r = computeHousekeepingCrewForDate({
      date: DATE,
      roster: ROSTER,
      shifts: [shift('maria'), shift('brenda')],
    });
    assert.equal(r.source, 'scheduled');
    assert.deepEqual(ids(r), ['brenda', 'maria']);
    // Cindy is active but not scheduled — she must NOT be a droppable row.
    assert.equal(r.memberIds.has('cindy'), false);
  });

  test('an inactive employee never joins the crew even with a shift row', () => {
    const r = computeHousekeepingCrewForDate({
      date: DATE,
      roster: ROSTER,
      shifts: [shift('maria'), shift('gone')],
    });
    assert.deepEqual(ids(r), ['maria']);
  });

  test('open (unfilled) slots and declined shifts do not put anyone on the board', () => {
    const r = computeHousekeepingCrewForDate({
      date: DATE,
      roster: ROSTER,
      shifts: [
        shift('maria'),
        shift('brenda', { kind: 'open' }),
        shift('cindy', { status: 'declined' }),
        { ...shift('brenda'), staff_id: null },
      ],
    });
    assert.deepEqual(ids(r), ['maria']);
  });

  test('everyone scheduled gets a row even when they hold no rooms yet', () => {
    const r = computeHousekeepingCrewForDate({
      date: DATE,
      roster: ROSTER,
      shifts: [shift('maria'), shift('brenda'), shift('cindy')],
    });
    assert.equal(r.members.length, 3);
  });
});

// ───────────────────────────────────────────────────────────────────────
describe('approved time off removes someone from the crew', () => {
  test('an approved request drops that housekeeper', () => {
    const r = computeHousekeepingCrewForDate({
      date: DATE,
      roster: ROSTER,
      shifts: [shift('maria'), shift('brenda')],
      timeOffStaffIds: new Set(['brenda']),
    });
    assert.deepEqual(ids(r), ['maria']);
    assert.equal(r.timeOffIgnoredToKeepCrew, false);
    assert.equal(r.timeOffStaffIds.has('brenda'), true);
  });

  test('time off is never allowed to empty the crew', () => {
    // Both scheduled people are off. An empty board with no explanation
    // is the failure we are guarding against, so we keep them and flag it.
    const r = computeHousekeepingCrewForDate({
      date: DATE,
      roster: ROSTER,
      shifts: [shift('maria'), shift('brenda')],
      timeOffStaffIds: new Set(['maria', 'brenda']),
    });
    assert.deepEqual(ids(r), ['brenda', 'maria']);
    assert.equal(r.timeOffIgnoredToKeepCrew, true);
  });

  test('time off for someone not on the roster is ignored', () => {
    const r = computeHousekeepingCrewForDate({
      date: DATE,
      roster: ROSTER,
      shifts: [shift('maria')],
      timeOffStaffIds: new Set(['a-front-desk-person']),
    });
    assert.deepEqual(ids(r), ['maria']);
    assert.equal(r.timeOffStaffIds.size, 0);
  });
});

// ───────────────────────────────────────────────────────────────────────
// THE CATASTROPHIC CASE. A hotel that has not adopted the Staff schedule
// has zero rows in scheduled_shifts. Rendering an empty board there looks
// exactly like the product is broken.
describe('empty-shifts fallback — never show an empty board', () => {
  test('no shifts at all → the whole active roster is the crew', () => {
    const r = computeHousekeepingCrewForDate({
      date: DATE,
      roster: ROSTER,
      shifts: [],
    });
    assert.equal(r.source, 'unscheduled_fallback');
    assert.deepEqual(ids(r), ['brenda', 'cindy', 'maria']);
    assert.equal(r.memberIds.has('gone'), false, 'inactive staff stay off the board');
  });

  test('shifts exist for OTHER dates only → still the whole roster', () => {
    const r = computeHousekeepingCrewForDate({
      date: DATE,
      roster: ROSTER,
      shifts: [
        shift('maria', { shift_date: '2026-07-23' }),
        shift('brenda', { shift_date: '2026-07-25' }),
      ],
    });
    assert.equal(r.source, 'unscheduled_fallback');
    assert.deepEqual(ids(r), ['brenda', 'cindy', 'maria']);
  });

  test('every shift row is unusable (open / declined / no staff) → whole roster', () => {
    const r = computeHousekeepingCrewForDate({
      date: DATE,
      roster: ROSTER,
      shifts: [
        shift('maria', { kind: 'open' }),
        shift('brenda', { status: 'declined' }),
        { ...shift('cindy'), staff_id: null },
      ],
    });
    assert.equal(r.source, 'unscheduled_fallback');
    assert.deepEqual(ids(r), ['brenda', 'cindy', 'maria']);
  });

  test('fallback crew is sized by the property shift, not left at zero', () => {
    const r = computeHousekeepingCrewForDate({
      date: DATE,
      roster: ROSTER,
      shifts: [],
      defaultShiftMinutes: 420,
    });
    for (const m of r.members) {
      assert.equal(m.scheduledMinutes, 420);
      assert.equal(m.isScheduled, false);
    }
  });

  test('no property shift set → a sane default, never 0 capacity', () => {
    const r = computeHousekeepingCrewForDate({
      date: DATE, roster: ROSTER, shifts: [], defaultShiftMinutes: null,
    });
    assert.equal(r.members[0].scheduledMinutes, DEFAULT_CREW_SHIFT_MINUTES);
    assert.ok(DEFAULT_CREW_SHIFT_MINUTES > 0);
  });

  test('fallback still honors time off, but not to the point of emptying', () => {
    const some = computeHousekeepingCrewForDate({
      date: DATE, roster: ROSTER, shifts: [],
      timeOffStaffIds: new Set(['cindy']),
    });
    assert.deepEqual(ids(some), ['brenda', 'maria']);

    const all = computeHousekeepingCrewForDate({
      date: DATE, roster: ROSTER, shifts: [],
      timeOffStaffIds: new Set(['maria', 'brenda', 'cindy']),
    });
    assert.deepEqual(ids(all), ['brenda', 'cindy', 'maria']);
    assert.equal(all.timeOffIgnoredToKeepCrew, true);
  });

  test('a failed schedule read degrades to the full roster, never to nothing', async () => {
    const brokenReader: CrewScheduleReader = {
      async shiftsForDate() { throw new Error('scheduled_shifts read failed'); },
      async approvedTimeOffForDate() { return []; },
    };
    const r = await resolveHousekeepingCrewForDate({
      propertyId: 'p1', date: DATE, roster: ROSTER, reader: brokenReader,
    });
    assert.equal(r.degraded, true);
    assert.equal(r.source, 'unscheduled_fallback');
    assert.deepEqual(ids(r), ['brenda', 'cindy', 'maria']);
  });
});

// ───────────────────────────────────────────────────────────────────────
describe('timezone boundary — an adjacent day never leaks in', () => {
  // The board resolves its date in the property's timezone. At 02:00 UTC
  // a US hotel is still on the previous calendar day; using the UTC date
  // would pull tomorrow's crew onto today's board.
  const lateNightUtc = new Date('2026-07-25T02:00:00.000Z');

  test('property-local date is what we resolve against', () => {
    assert.equal(propertyLocalToday(lateNightUtc, 'America/Chicago'), '2026-07-24');
    assert.equal(propertyLocalToday(lateNightUtc, 'UTC'), '2026-07-25');
  });

  test("tomorrow's shift does not staff today's board", () => {
    const localDate = propertyLocalToday(lateNightUtc, 'America/Chicago'); // 07-24
    const r = computeHousekeepingCrewForDate({
      date: localDate,
      roster: ROSTER,
      shifts: [
        shift('maria', { shift_date: '2026-07-24' }),
        shift('brenda', { shift_date: '2026-07-25' }),
        shift('cindy', { shift_date: '2026-07-23' }),
      ],
    });
    assert.equal(r.source, 'scheduled');
    assert.deepEqual(ids(r), ['maria']);
  });

  test('the same instant in UTC resolves the NEXT day\'s crew — the off-by-one we guard', () => {
    const utcDate = propertyLocalToday(lateNightUtc, 'UTC'); // 07-25
    const r = computeHousekeepingCrewForDate({
      date: utcDate,
      roster: ROSTER,
      shifts: [
        shift('maria', { shift_date: '2026-07-24' }),
        shift('brenda', { shift_date: '2026-07-25' }),
      ],
    });
    assert.deepEqual(ids(r), ['brenda']);
  });

  test('the resolver filters by date even if the reader hands back extra days', async () => {
    const sloppyReader: CrewScheduleReader = {
      async shiftsForDate() {
        return [
          shift('maria', { shift_date: DATE }),
          shift('brenda', { shift_date: '2026-07-25' }),
        ];
      },
      async approvedTimeOffForDate() { return []; },
    };
    const r = await resolveHousekeepingCrewForDate({
      propertyId: 'p1', date: DATE, roster: ROSTER, reader: sloppyReader,
    });
    assert.deepEqual(ids(r), ['maria']);
  });
});

// ───────────────────────────────────────────────────────────────────────
describe('scheduled minutes are real, not a uniform shift', () => {
  test('a 4-hour shift reports 240 minutes, an 8-hour one 480', () => {
    const r = computeHousekeepingCrewForDate({
      date: DATE,
      roster: ROSTER,
      shifts: [
        shift('maria', { start_time: '08:00:00', end_time: '16:00:00' }),
        shift('brenda', { start_time: '09:00:00', end_time: '13:00:00' }),
      ],
      defaultShiftMinutes: 420,
    });
    assert.equal(r.minutesByStaffId.get('maria'), 480);
    assert.equal(r.minutesByStaffId.get('brenda'), 240);
  });

  test('half-hour boundaries survive', () => {
    const r = computeHousekeepingCrewForDate({
      date: DATE,
      roster: ROSTER,
      shifts: [shift('maria', { start_time: '08:30:00', end_time: '14:15:00' })],
    });
    assert.equal(r.minutesByStaffId.get('maria'), 345);
  });

  test('a split day (two shifts) sums', () => {
    const r = computeHousekeepingCrewForDate({
      date: DATE,
      roster: ROSTER,
      shifts: [
        shift('maria', { start_time: '07:00:00', end_time: '11:00:00' }),
        shift('maria', { start_time: '15:00:00', end_time: '18:00:00' }),
      ],
    });
    assert.equal(r.minutesByStaffId.get('maria'), 420);
    assert.equal(r.members.length, 1, 'still one crew row');
  });

  test('an overnight shift wraps past midnight instead of going negative', () => {
    assert.equal(shiftDurationMinutes('23:00:00', '07:00:00', 420), 480);
  });

  test('missing or junk times fall back to the property shift, never 0', () => {
    assert.equal(shiftDurationMinutes(null, '16:00:00', 420), 420);
    assert.equal(shiftDurationMinutes('08:00:00', null, 420), 420);
    assert.equal(shiftDurationMinutes('not-a-time', 'nope', 420), 420);
    assert.equal(shiftDurationMinutes('08:00:00', '08:00:00', 420), 420);
    assert.equal(timeToMinutes('08:30'), 510);
    assert.equal(timeToMinutes(null), null);
  });
});

// ───────────────────────────────────────────────────────────────────────
describe('someone who called in still gets a row', () => {
  test('an unscheduled housekeeper holding rooms is force-included and marked', () => {
    const r = computeHousekeepingCrewForDate({
      date: DATE,
      roster: ROSTER,
      shifts: [shift('maria')],
      alwaysIncludeStaffIds: new Set(['cindy']),
      defaultShiftMinutes: 420,
    });
    assert.deepEqual(ids(r), ['cindy', 'maria']);
    const cindy = r.members.find(m => m.staffId === 'cindy')!;
    const maria = r.members.find(m => m.staffId === 'maria')!;
    assert.equal(cindy.isScheduled, false, 'flagged so the UI can say "not scheduled"');
    assert.equal(cindy.scheduledMinutes, 420);
    assert.equal(maria.isScheduled, true);
  });

  test('force-include never resurrects an inactive employee', () => {
    const r = computeHousekeepingCrewForDate({
      date: DATE,
      roster: ROSTER,
      shifts: [shift('maria')],
      alwaysIncludeStaffIds: new Set(['gone']),
    });
    assert.deepEqual(ids(r), ['maria']);
  });

  test('force-include does not duplicate an already-scheduled person', () => {
    const r = computeHousekeepingCrewForDate({
      date: DATE,
      roster: ROSTER,
      shifts: [shift('maria')],
      alwaysIncludeStaffIds: new Set(['maria']),
    });
    assert.equal(r.members.length, 1);
    assert.equal(r.members[0].isScheduled, true);
  });

  // The whole point of force-include is "this person holds today's rooms".
  // Same-day time off used to win over it, which took the person off the
  // crew while their rooms kept their name: the Board shunted the rooms to
  // Unassigned and the Timeline dropped them off the screen entirely.
  test('force-include beats approved time off — a scheduled person sent home keeps their row', () => {
    const r = computeHousekeepingCrewForDate({
      date: DATE,
      roster: ROSTER,
      shifts: [shift('maria'), shift('brenda')],
      timeOffStaffIds: new Set(['brenda']),
      alwaysIncludeStaffIds: new Set(['brenda']),
    });
    assert.deepEqual(ids(r), ['brenda', 'maria']);
    // Not the "we kept everyone to avoid an empty board" escape hatch —
    // brenda is here specifically because she holds work.
    assert.equal(r.timeOffIgnoredToKeepCrew, false);
    assert.equal(r.timeOffStaffIds.has('brenda'), true, 'still reported as off');
  });

  test('force-include beats time off in unscheduled-fallback mode too', () => {
    const r = computeHousekeepingCrewForDate({
      date: DATE,
      roster: ROSTER,
      shifts: [],
      timeOffStaffIds: new Set(['brenda', 'cindy']),
      alwaysIncludeStaffIds: new Set(['brenda']),
    });
    assert.equal(r.source, 'unscheduled_fallback');
    assert.deepEqual(ids(r), ['brenda', 'maria']);
    assert.equal(r.timeOffIgnoredToKeepCrew, false);
  });

  test('time off still removes someone who holds nothing', () => {
    const r = computeHousekeepingCrewForDate({
      date: DATE,
      roster: ROSTER,
      shifts: [shift('maria'), shift('brenda')],
      timeOffStaffIds: new Set(['brenda']),
      alwaysIncludeStaffIds: new Set(['maria']),
    });
    assert.deepEqual(ids(r), ['maria']);
  });
});

// ───────────────────────────────────────────────────────────────────────
describe('async resolver wiring', () => {
  test('reads shifts + time off for the requested property and date', async () => {
    const calls: Array<[string, string]> = [];
    const reader: CrewScheduleReader = {
      async shiftsForDate(pid, date) {
        calls.push(['shifts', `${pid}:${date}`]);
        return [shift('maria'), shift('brenda')];
      },
      async approvedTimeOffForDate(pid, date) {
        calls.push(['timeoff', `${pid}:${date}`]);
        return ['brenda'];
      },
    };
    const r = await resolveHousekeepingCrewForDate({
      propertyId: 'prop-1', date: DATE, roster: ROSTER,
      defaultShiftMinutes: 480, reader,
    });
    assert.deepEqual(calls.sort(), [
      ['shifts', `prop-1:${DATE}`],
      ['timeoff', `prop-1:${DATE}`],
    ]);
    assert.equal(r.degraded, false);
    assert.equal(r.source, 'scheduled');
    assert.deepEqual(ids(r), ['maria']);
  });

  test('minutesByStaffId only covers people actually on the crew', async () => {
    const reader: CrewScheduleReader = {
      async shiftsForDate() { return [shift('maria'), shift('brenda')]; },
      async approvedTimeOffForDate() { return ['brenda']; },
    };
    const r = await resolveHousekeepingCrewForDate({
      propertyId: 'p', date: DATE, roster: ROSTER, reader,
    });
    assert.equal(r.minutesByStaffId.has('brenda'), false);
    assert.equal(r.minutesByStaffId.get('maria'), 480);
  });
});
