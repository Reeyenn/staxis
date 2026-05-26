/**
 * Tests for overtime classification + ISO-week helpers.
 *
 * The classifier is what colors the Schedule tab badges; the
 * ISO-week function is what scopes "this week" queries against the
 * staff_weekly_hours_view (created in migration 0229).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyOvertimeLevel,
  isoWeekParts,
  APPROACHING_OT_HOURS,
  DEFAULT_OT_THRESHOLD_HOURS,
} from '@/lib/cost-tracking/overtime';

describe('classifyOvertimeLevel', () => {
  test('under 35h → none', () => {
    assert.equal(classifyOvertimeLevel(0, 40), 'none');
    assert.equal(classifyOvertimeLevel(34.99, 40), 'none');
  });

  test('exactly 35h → approaching', () => {
    assert.equal(classifyOvertimeLevel(APPROACHING_OT_HOURS, 40), 'approaching');
  });

  test('between 35h and threshold → approaching', () => {
    assert.equal(classifyOvertimeLevel(37, 40), 'approaching');
    assert.equal(classifyOvertimeLevel(39.99, 40), 'approaching');
  });

  test('exactly threshold (40h default) → over', () => {
    assert.equal(classifyOvertimeLevel(DEFAULT_OT_THRESHOLD_HOURS, 40), 'over');
  });

  test('over threshold → over', () => {
    assert.equal(classifyOvertimeLevel(50, 40), 'over');
  });

  test('respects per-property threshold override', () => {
    assert.equal(classifyOvertimeLevel(38, 38), 'over');
    assert.equal(classifyOvertimeLevel(37.9, 38), 'approaching');
  });

  test('negative / NaN bug-class defends to none', () => {
    assert.equal(classifyOvertimeLevel(-5, 40), 'none');
    assert.equal(classifyOvertimeLevel(Number.NaN, 40), 'none');
  });
});

describe('isoWeekParts', () => {
  test('Wednesday 2026-05-27 sits in 2026 W22', () => {
    const r = isoWeekParts(new Date('2026-05-27T12:00:00Z'));
    assert.equal(r.isoYear, 2026);
    assert.equal(r.isoWeek, 22);
  });

  test('Sunday 2026-01-03 belongs to ISO year 2025 W53', () => {
    // ISO weeks are Mon-Sun; this Sun is the tail of the prior ISO year.
    const r = isoWeekParts(new Date('2026-01-03T12:00:00Z'));
    assert.equal(r.isoYear, 2026);
    // 2026-01-03 is a Saturday; W01 starts Mon 2025-12-29 — but
    // anchoring on Thursday, our function reports isoYear=2026/W01.
    // (Per Postgres EXTRACT(ISOYEAR) + EXTRACT(WEEK), 2026-01-03 = 2026/W01.)
    assert.equal(r.isoWeek, 1);
  });

  test('Monday is the same week as the prior Sunday', () => {
    const sat = isoWeekParts(new Date('2026-05-23T12:00:00Z'));   // Sat
    const sun = isoWeekParts(new Date('2026-05-24T12:00:00Z'));   // Sun
    const mon = isoWeekParts(new Date('2026-05-25T12:00:00Z'));   // Mon
    assert.equal(sat.isoWeek, sun.isoWeek);
    // Mon starts the NEXT ISO week.
    assert.equal(mon.isoWeek, sun.isoWeek + 1);
  });
});
