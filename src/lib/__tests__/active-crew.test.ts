/**
 * Tests for the canonical crew-eligibility helper.
 *
 * The whole point of this file is to lock in the rules that the Round 17
 * schedule-auto-fill cron MISSED:
 *   - vacationDates (cron assigned rooms to housekeepers on vacation)
 *   - weeklyHours >= maxWeeklyHours (cron pushed seniors into overtime)
 *   - daysWorkedThisWeek >= maxDaysPerWeek
 * If any of these checks regress, the cron will silently overschedule.
 * These tests fail loudly.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  checkCrewEligibility,
  selectActiveCrew,
  selectActiveCrewWithReasons,
} from '@/lib/schedule/active-crew';
import type { StaffMember } from '@/types';

function makeStaff(over: Partial<StaffMember> = {}): StaffMember {
  return {
    id: 'sm-1',
    name: 'Rosa',
    phone: '+15551234567',
    language: 'en',
    isSenior: false,
    department: 'housekeeping',
    scheduledToday: true,
    weeklyHours: 20,
    maxWeeklyHours: 40,
    maxDaysPerWeek: 5,
    daysWorkedThisWeek: 2,
    vacationDates: undefined,
    isActive: true,
    schedulePriority: 'normal',
    ...over,
  };
}

const opts = { targetDate: '2026-05-16', respectSchedulePriority: true };

describe('checkCrewEligibility — happy path', () => {
  it('default housekeeper is eligible', () => {
    const r = checkCrewEligibility(makeStaff(), opts);
    assert.deepEqual(r, { eligible: true });
  });
});

describe('checkCrewEligibility — rejection paths', () => {
  it('rejects inactive staff', () => {
    const r = checkCrewEligibility(makeStaff({ isActive: false }), opts);
    assert.deepEqual(r, { eligible: false, reason: 'inactive' });
  });

  it('rejects non-housekeeping department', () => {
    const r = checkCrewEligibility(makeStaff({ department: 'maintenance' }), opts);
    assert.deepEqual(r, { eligible: false, reason: 'wrong_department' });
  });

  it('rejects staff with no phone when requirePhone=true', () => {
    const r = checkCrewEligibility(
      makeStaff({ phone: '' }),
      { ...opts, requirePhone: true },
    );
    assert.deepEqual(r, { eligible: false, reason: 'no_phone' });
  });

  it('accepts staff with no phone when requirePhone=false (cron default)', () => {
    const r = checkCrewEligibility(makeStaff({ phone: '' }), opts);
    assert.deepEqual(r, { eligible: true });
  });

  it('rejects schedule_priority=excluded when respected', () => {
    const r = checkCrewEligibility(makeStaff({ schedulePriority: 'excluded' }), opts);
    assert.deepEqual(r, { eligible: false, reason: 'priority_excluded' });
  });

  it('Round 18 regression — rejects staff on vacation for targetDate', () => {
    const r = checkCrewEligibility(
      makeStaff({ vacationDates: ['2026-05-15', '2026-05-16', '2026-05-17'] }),
      opts,
    );
    assert.deepEqual(r, { eligible: false, reason: 'on_vacation' });
  });

  it('accepts staff whose vacation list does not include targetDate', () => {
    const r = checkCrewEligibility(
      makeStaff({ vacationDates: ['2026-05-10', '2026-05-11'] }),
      opts,
    );
    assert.deepEqual(r, { eligible: true });
  });

  it('Round 18 regression — rejects staff at weekly hour cap', () => {
    const r = checkCrewEligibility(
      makeStaff({ weeklyHours: 40, maxWeeklyHours: 40 }),
      opts,
    );
    assert.deepEqual(r, { eligible: false, reason: 'weekly_hour_cap_reached' });
  });

  it('accepts staff one hour under their weekly cap', () => {
    const r = checkCrewEligibility(
      makeStaff({ weeklyHours: 39, maxWeeklyHours: 40 }),
      opts,
    );
    assert.deepEqual(r, { eligible: true });
  });

  it('Round 18 regression — rejects staff at weekly day cap', () => {
    const r = checkCrewEligibility(
      makeStaff({ daysWorkedThisWeek: 5, maxDaysPerWeek: 5 }),
      opts,
    );
    assert.deepEqual(r, { eligible: false, reason: 'weekly_day_cap_reached' });
  });
});

describe('selectActiveCrew', () => {
  it('filters the roster to eligible housekeepers only', () => {
    const roster: StaffMember[] = [
      makeStaff({ id: '1', name: 'Eligible Eva' }),
      makeStaff({ id: '2', name: 'Vacation Vic', vacationDates: ['2026-05-16'] }),
      makeStaff({ id: '3', name: 'Excluded Ed', schedulePriority: 'excluded' }),
      makeStaff({ id: '4', name: 'Maxed Max', weeklyHours: 41 }),
      makeStaff({ id: '5', name: 'Maintenance Mo', department: 'maintenance' }),
      makeStaff({ id: '6', name: 'Eligible Erin' }),
    ];
    const active = selectActiveCrew(roster, opts);
    assert.deepEqual(active.map((s) => s.id), ['1', '6']);
  });

  it('returns empty when nobody is eligible', () => {
    const roster: StaffMember[] = [
      makeStaff({ id: '1', vacationDates: ['2026-05-16'] }),
      makeStaff({ id: '2', isActive: false }),
    ];
    const active = selectActiveCrew(roster, opts);
    assert.deepEqual(active, []);
  });
});

describe('selectActiveCrewWithReasons', () => {
  it('groups rejected staff by reason for telemetry', () => {
    const roster: StaffMember[] = [
      makeStaff({ id: '1', name: 'Yes' }),
      makeStaff({ id: '2', name: 'Vac', vacationDates: ['2026-05-16'] }),
      makeStaff({ id: '3', name: 'Hours', weeklyHours: 40, maxWeeklyHours: 40 }),
    ];
    const { eligible, excluded } = selectActiveCrewWithReasons(roster, opts);
    assert.deepEqual(eligible.map((s) => s.id), ['1']);
    assert.deepEqual(
      excluded.map((e) => ({ id: e.staff.id, reason: e.reason })),
      [
        { id: '2', reason: 'on_vacation' },
        { id: '3', reason: 'weekly_hour_cap_reached' },
      ],
    );
  });
});
