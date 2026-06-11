/**
 * Tests for the unified Schedule tab's pure helpers
 * (src/lib/schedule-board.ts): Sunday-week calendar math, minute/time
 * conversion and display, preset snapping, board range stretching, and the
 * shift-set equality the optimistic-save reconciliation depends on.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  toMin, toHHMM, fmtMin, fmtMinRange, fmtTime, fmtRange,
  addDaysYmd, sundayOf, daysBetween, dayInfo, weekLabel, buildWeeks,
  deptDefaultTimes, presetBoundaries, snapMin, boardRange, boardTicks,
  sameShiftSet, shortName,
  BOARD_START_MIN, BOARD_END_MIN,
  type BoardShift,
} from '../schedule-board';
import type { ShiftPreset } from '@/types';

describe('minutes ↔ HH:MM ↔ display', () => {
  test('toMin / toHHMM round-trip', () => {
    assert.equal(toMin('08:00'), 480);
    assert.equal(toMin('23:45'), 1425);
    assert.equal(toHHMM(480), '08:00');
    assert.equal(toHHMM(1425), '23:45');
    assert.equal(toHHMM(toMin('06:15')), '06:15');
  });

  test('fmtMin uses compact 12h forms', () => {
    assert.equal(fmtMin(480), '8a');
    assert.equal(fmtMin(510), '8:30a');
    assert.equal(fmtMin(720), '12p');
    assert.equal(fmtMin(0), '12a');
    assert.equal(fmtMin(13 * 60), '1p');
  });

  test('range formatting (minutes and strings agree)', () => {
    assert.equal(fmtMinRange(480, 960), '8a–4p');
    assert.equal(fmtRange('08:00', '16:00'), '8a–4p');
    assert.equal(fmtTime('15:30'), '3:30p');
  });
});

describe('Sunday-week calendar', () => {
  test('sundayOf lands on the Sunday on/before the date', () => {
    assert.equal(sundayOf('2026-06-08'), '2026-06-07'); // Mon → prior Sun
    assert.equal(sundayOf('2026-06-07'), '2026-06-07'); // Sun → itself
    assert.equal(sundayOf('2026-06-13'), '2026-06-07'); // Sat → week's Sun
  });

  test('addDaysYmd crosses month/DST boundaries on local dates', () => {
    assert.equal(addDaysYmd('2026-06-30', 1), '2026-07-01');
    assert.equal(addDaysYmd('2026-03-08', 1), '2026-03-09'); // US DST spring-forward day
    assert.equal(daysBetween('2026-06-01', '2026-06-08'), 7);
  });

  test('dayInfo flags today/tomorrow/past relative to a fixed today', () => {
    const today = '2026-06-08';
    assert.equal(dayInfo('2026-06-08', today, 'en').today, true);
    assert.equal(dayInfo('2026-06-09', today, 'en').tomorrow, true);
    assert.equal(dayInfo('2026-06-07', today, 'en').yesterday, true);
    assert.equal(dayInfo('2026-06-01', today, 'en').past, true);
    assert.equal(dayInfo('2026-06-08', today, 'es').dowFull, 'lunes');
  });

  test('weekLabel within and across months', () => {
    assert.equal(weekLabel('2026-06-07', 'en'), 'Jun 7–13');
    assert.equal(weekLabel('2026-06-28', 'en'), 'Jun 28 – Jul 4');
  });

  test('buildWeeks covers the window with Sun-keyed weeks', () => {
    const weeks = buildWeeks('2026-05-24', '2026-06-20', '2026-06-08', 'en');
    assert.equal(weeks[0].start, '2026-05-24');
    assert.equal(weeks[weeks.length - 1].start, '2026-06-14');
    const current = weeks.find(w => w.current);
    assert.ok(current);
    assert.equal(current!.start, '2026-06-07');
    assert.equal(current!.days.length, 7);
    assert.ok(weeks[0].past);
    assert.ok(!weeks[weeks.length - 1].past);
  });
});

const PRESETS = [
  { id: 'p1', propertyId: 'x', name: 'Morning', department: 'housekeeping', startTime: '08:00', endTime: '16:00', sortOrder: 0, createdAt: new Date(), updatedAt: new Date() },
  { id: 'p2', propertyId: 'x', name: 'Mid', department: 'housekeeping', startTime: '10:00', endTime: '18:00', sortOrder: 1, createdAt: new Date(), updatedAt: new Date() },
] as ShiftPreset[];

describe('presets, snapping, board geometry', () => {
  test('deptDefaultTimes prefers the first preset, falls back to static', () => {
    assert.deepEqual(deptDefaultTimes('housekeeping', PRESETS), { s: 480, e: 960 });
    assert.deepEqual(deptDefaultTimes('front_desk', PRESETS), { s: 420, e: 900 });
  });

  test('snapMin pulls toward preset boundaries within 22min, else 15-grid', () => {
    const starts = presetBoundaries('housekeeping', PRESETS, 'start'); // [480, 600]
    assert.deepEqual(starts, [480, 600]);
    assert.equal(snapMin(490, starts), 480);   // 10 min away → snaps to preset
    assert.equal(snapMin(521, starts), 525);   // 41 min away → 15-min grid
    assert.equal(snapMin(607, starts), 600);   // near the Mid preset
    assert.equal(snapMin(700, []), 705);       // no presets → grid only
  });

  test('boardRange stretches to whole hours around out-of-window shifts', () => {
    assert.deepEqual(boardRange([{ startMin: 480, endMin: 960 }]),
      { start: BOARD_START_MIN, end: BOARD_END_MIN });
    assert.deepEqual(boardRange([{ startMin: 480, endMin: 23 * 60 }]),
      { start: BOARD_START_MIN, end: 23 * 60 });
    assert.deepEqual(boardRange([{ startMin: 5 * 60 + 30, endMin: 23 * 60 + 30 }]),
      { start: 5 * 60, end: 24 * 60 });
  });

  test('boardTicks emits 3-hour marks inside the range', () => {
    assert.deepEqual(boardTicks(360, 1320), [360, 540, 720, 900, 1080, 1260]);
  });
});

describe('shift-set equality + names', () => {
  const a: BoardShift[] = [
    { id: '1', staffId: 's1', dept: 'housekeeping', startMin: 480, endMin: 960 },
    { id: '2', staffId: 's2', dept: 'front_desk', startMin: 420, endMin: 900 },
  ];

  test('sameShiftSet ignores ids/order, compares payload', () => {
    const b: BoardShift[] = [
      { id: 'x', staffId: 's2', dept: 'front_desk', startMin: 420, endMin: 900, anim: true, nonce: 5 },
      { id: 'y', staffId: 's1', dept: 'housekeeping', startMin: 480, endMin: 960 },
    ];
    assert.ok(sameShiftSet(a, b));
    assert.ok(!sameShiftSet(a, b.slice(0, 1)));
    assert.ok(!sameShiftSet(a, [{ ...b[0] }, { ...b[1], endMin: 990 }]));
  });

  test('shortName', () => {
    assert.equal(shortName('Brenda Marquez'), 'Brenda M.');
    assert.equal(shortName('Cher'), 'Cher');
    assert.equal(shortName('Ana María López'), 'Ana L.');
  });
});
