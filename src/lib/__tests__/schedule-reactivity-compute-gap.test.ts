import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  computeGapFor,
  computeGapsForAllDepts,
  timeWindowMinutes,
  ALERTABLE_DEPTS,
} from '../schedule-reactivity/compute-gap';
import type { ComputeGapReader } from '../schedule-reactivity/compute-gap';
import type { AlertDepartment } from '../schedule-reactivity/types';

function makeReader(overrides: Partial<ComputeGapReader> = {}): ComputeGapReader {
  return {
    housekeepingRoomMinutes: async () => null,
    housekeepingMlMinutes: async () => null,
    scheduledMinutes: async () => 0,
    propertyConfig: async () => ({
      frontDeskCoverageHours: null,
      maintenanceShiftsPerDay: null,
      housemanShiftsPerDay: null,
      breakfastWindowStart: null,
      breakfastWindowEnd: null,
      shiftMinutes: null,
    }),
    ...overrides,
  };
}

test('timeWindowMinutes handles HH:MM, HH:MM:SS, zero, negative', () => {
  assert.equal(timeWindowMinutes('07:00', '10:00'), 180);
  assert.equal(timeWindowMinutes('06:30', '09:45'), 195);
  assert.equal(timeWindowMinutes('07:00:00', '10:00:00'), 180);
  assert.equal(timeWindowMinutes('10:00', '07:00'), 0);          // negative → 0
  assert.equal(timeWindowMinutes('not-a-time', '08:00'), 0);      // bad input → 0
  assert.equal(timeWindowMinutes('07:00', '07:00'), 0);
});

test('housekeeping: ml supply path wins when available', async () => {
  const reader = makeReader({
    housekeepingMlMinutes: async () => 500,
    housekeepingRoomMinutes: async () => 999,  // would lose
    scheduledMinutes: async () => 200,
  });
  const gap = await computeGapFor('p1', '2026-06-01', 'housekeeping', reader);
  assert.ok(gap);
  assert.equal(gap.demandMinutes, 500);
  assert.equal(gap.scheduledMinutes, 200);
  assert.equal(gap.gapMinutes, 300);
  assert.equal(gap.context.demandModel, 'ml_supply');
});

test('housekeeping: rule fallback when ml null', async () => {
  const reader = makeReader({
    housekeepingMlMinutes: async () => null,
    housekeepingRoomMinutes: async () => 480,
    scheduledMinutes: async () => 480,
  });
  const gap = await computeGapFor('p1', '2026-06-01', 'housekeeping', reader);
  assert.ok(gap);
  assert.equal(gap.demandMinutes, 480);
  assert.equal(gap.gapMinutes, 0);
  assert.equal(gap.context.demandModel, 'rule_today_room_work');
});

test('housekeeping: no demand model returns null gap', async () => {
  const reader = makeReader({
    housekeepingMlMinutes: async () => null,
    housekeepingRoomMinutes: async () => null,
  });
  const gap = await computeGapFor('p1', '2026-06-01', 'housekeeping', reader);
  assert.equal(gap, null);
});

test('front_desk: zero hours config = no demand = null gap', async () => {
  const reader = makeReader({
    propertyConfig: async () => ({
      frontDeskCoverageHours: 0,
      maintenanceShiftsPerDay: null,
      housemanShiftsPerDay: null,
      breakfastWindowStart: null,
      breakfastWindowEnd: null,
      shiftMinutes: null,
    }),
    scheduledMinutes: async () => 0,
  });
  const gap = await computeGapFor('p1', '2026-06-01', 'front_desk', reader);
  assert.equal(gap, null);
});

test('front_desk: 24h coverage produces 1440 minutes demand', async () => {
  const reader = makeReader({
    propertyConfig: async () => ({
      frontDeskCoverageHours: 24,
      maintenanceShiftsPerDay: null,
      housemanShiftsPerDay: null,
      breakfastWindowStart: null,
      breakfastWindowEnd: null,
      shiftMinutes: null,
    }),
    scheduledMinutes: async (_p, _d, dept) => (dept === 'front_desk' ? 480 : 0),
  });
  const gap = await computeGapFor('p1', '2026-06-01', 'front_desk', reader);
  assert.ok(gap);
  assert.equal(gap.demandMinutes, 24 * 60);
  assert.equal(gap.scheduledMinutes, 480);
  assert.equal(gap.gapMinutes, 24 * 60 - 480);
});

test('maintenance: uses property shift_minutes when set, else 420 default', async () => {
  const reader1 = makeReader({
    propertyConfig: async () => ({
      frontDeskCoverageHours: null,
      maintenanceShiftsPerDay: 1,
      housemanShiftsPerDay: null,
      breakfastWindowStart: null,
      breakfastWindowEnd: null,
      shiftMinutes: 480,
    }),
  });
  const g1 = await computeGapFor('p1', '2026-06-01', 'maintenance', reader1);
  assert.equal(g1!.demandMinutes, 480);

  const reader2 = makeReader({
    propertyConfig: async () => ({
      frontDeskCoverageHours: null,
      maintenanceShiftsPerDay: 1,
      housemanShiftsPerDay: null,
      breakfastWindowStart: null,
      breakfastWindowEnd: null,
      shiftMinutes: null,
    }),
  });
  const g2 = await computeGapFor('p1', '2026-06-01', 'maintenance', reader2);
  assert.equal(g2!.demandMinutes, 420);
});

test('breakfast: null window → null gap; valid window → demand=window minutes', async () => {
  const r1 = makeReader({
    propertyConfig: async () => ({
      frontDeskCoverageHours: null,
      maintenanceShiftsPerDay: null,
      housemanShiftsPerDay: null,
      breakfastWindowStart: null,
      breakfastWindowEnd: null,
      shiftMinutes: null,
    }),
  });
  assert.equal(await computeGapFor('p1', '2026-06-01', 'breakfast', r1), null);

  const r2 = makeReader({
    propertyConfig: async () => ({
      frontDeskCoverageHours: null,
      maintenanceShiftsPerDay: null,
      housemanShiftsPerDay: null,
      breakfastWindowStart: '06:00',
      breakfastWindowEnd: '10:30',
      shiftMinutes: null,
    }),
    scheduledMinutes: async () => 60,
  });
  const g = await computeGapFor('p1', '2026-06-01', 'breakfast', r2);
  assert.equal(g!.demandMinutes, 270);  // 4h30m
  assert.equal(g!.scheduledMinutes, 60);
  assert.equal(g!.gapMinutes, 210);
});

test('other: never alerts (returns null)', async () => {
  const reader = makeReader();
  const gap = await computeGapFor('p1', '2026-06-01', 'other', reader);
  assert.equal(gap, null);
});

test('computeGapsForAllDepts catches per-dept failures without breaking the rest', async () => {
  const reader = makeReader({
    housekeepingRoomMinutes: async () => { throw new Error('boom'); },
    housekeepingMlMinutes: async () => { throw new Error('boom'); },
    propertyConfig: async () => ({
      frontDeskCoverageHours: 24,
      maintenanceShiftsPerDay: 1,
      housemanShiftsPerDay: null,
      breakfastWindowStart: null,
      breakfastWindowEnd: null,
      shiftMinutes: null,
    }),
    scheduledMinutes: async (_p, _d, dept) =>
      dept === 'front_desk' ? 480 : 0,
  });
  const gaps = await computeGapsForAllDepts('p1', '2026-06-01', reader);
  // housekeeping threw → no gap. front_desk + maintenance produce gaps.
  const depts = gaps.map((g) => g.department);
  assert.ok(depts.includes('front_desk'));
  assert.ok(depts.includes('maintenance'));
  assert.ok(!depts.includes('housekeeping'));
});

test('ALERTABLE_DEPTS excludes other', () => {
  assert.ok(!ALERTABLE_DEPTS.includes('other' as AlertDepartment));
  assert.equal(ALERTABLE_DEPTS.length, 5);
});
