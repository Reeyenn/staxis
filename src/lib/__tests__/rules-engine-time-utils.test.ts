/**
 * Tests for src/lib/rules-engine/time-utils.ts.
 *
 * These conversions are load-bearing for tight-turnaround due-by
 * calculations and the day-of-stay math that drives the long-stay /
 * short-stay cadence rules. A DST regression here turns "ready by 1:45pm"
 * into "ready by 12:45pm" — invisible to the type checker.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  computeDayOfStay,
  diffMinutes,
  localDateTimeToUtc,
  minusMinutes,
  propertyLocalDate,
  propertyLocalDayOfWeek,
} from '@/lib/rules-engine/time-utils';

describe('propertyLocalDate', () => {
  test('formats UTC instant in the given timezone (CDT)', () => {
    // 06:00 UTC on 2026-05-26 = 01:00 CDT same day
    const out = propertyLocalDate(
      new Date('2026-05-26T06:00:00Z'),
      'America/Chicago',
    );
    assert.equal(out, '2026-05-26');
  });

  test('crosses midnight correctly (UTC ahead of local)', () => {
    // 04:00 UTC on 2026-05-26 = 23:00 CDT on 2026-05-25
    const out = propertyLocalDate(
      new Date('2026-05-26T04:00:00Z'),
      'America/Chicago',
    );
    assert.equal(out, '2026-05-25');
  });

  test('null timezone falls back to UTC', () => {
    const out = propertyLocalDate(new Date('2026-05-26T04:00:00Z'), null);
    assert.equal(out, '2026-05-26');
  });
});

describe('propertyLocalDayOfWeek', () => {
  test('returns 2 for Tuesday in property local time', () => {
    // 2026-05-26 Tuesday at 12:00 CDT
    const dow = propertyLocalDayOfWeek(
      new Date('2026-05-26T17:00:00Z'),
      'America/Chicago',
    );
    assert.equal(dow, 2);
  });

  test('returns 6 for Saturday', () => {
    // 2026-05-30 Saturday at 12:00 CDT
    const dow = propertyLocalDayOfWeek(
      new Date('2026-05-30T17:00:00Z'),
      'America/Chicago',
    );
    assert.equal(dow, 6);
  });

  test('returns 0 for Sunday', () => {
    const dow = propertyLocalDayOfWeek(
      new Date('2026-05-31T17:00:00Z'),
      'America/Chicago',
    );
    assert.equal(dow, 0);
  });
});

describe('localDateTimeToUtc', () => {
  test('11:00 CDT (May, in DST) returns 16:00 UTC', () => {
    const d = localDateTimeToUtc('2026-05-26', '11:00', 'America/Chicago');
    assert.ok(d);
    assert.equal(d!.toISOString(), '2026-05-26T16:00:00.000Z');
  });

  test('14:00 CDT returns 19:00 UTC (validates Mary arrival case)', () => {
    const d = localDateTimeToUtc('2026-05-26', '14:00', 'America/Chicago');
    assert.ok(d);
    assert.equal(d!.toISOString(), '2026-05-26T19:00:00.000Z');
  });

  test('seconds default to 0 when omitted', () => {
    const d = localDateTimeToUtc('2026-05-26', '14:00', 'America/Chicago');
    assert.equal(d!.toISOString(), '2026-05-26T19:00:00.000Z');
  });

  test('HH:MM:SS form works', () => {
    const d = localDateTimeToUtc('2026-05-26', '14:30:15', 'America/Chicago');
    assert.equal(d!.toISOString(), '2026-05-26T19:30:15.000Z');
  });

  test('11:00 CST (January, non-DST) returns 17:00 UTC', () => {
    const d = localDateTimeToUtc('2026-01-15', '11:00', 'America/Chicago');
    assert.equal(d!.toISOString(), '2026-01-15T17:00:00.000Z');
  });

  test('null timezone falls back to treating local time as UTC', () => {
    const d = localDateTimeToUtc('2026-05-26', '11:00', null);
    assert.equal(d!.toISOString(), '2026-05-26T11:00:00.000Z');
  });

  test('returns null on a malformed date', () => {
    const d = localDateTimeToUtc('not-a-date', '11:00', 'America/Chicago');
    assert.equal(d, null);
  });
});

describe('diffMinutes / minusMinutes', () => {
  test('diffMinutes is end - start, in minutes', () => {
    const a = new Date('2026-05-26T16:00:00Z');
    const b = new Date('2026-05-26T19:00:00Z');
    assert.equal(diffMinutes(a, b), 180);
  });

  test('minusMinutes returns the time N minutes earlier', () => {
    const arrival = new Date('2026-05-26T19:00:00Z');
    const dueBy = minusMinutes(arrival, 15);
    assert.equal(dueBy.toISOString(), '2026-05-26T18:45:00.000Z');
  });
});

describe('computeDayOfStay', () => {
  test('day 1 on arrival date', () => {
    assert.equal(computeDayOfStay('2026-05-26', '2026-05-26'), 1);
  });

  test('day 2 the next day', () => {
    assert.equal(computeDayOfStay('2026-05-26', '2026-05-27'), 2);
  });

  test('day 7 on the seventh day', () => {
    assert.equal(computeDayOfStay('2026-05-26', '2026-06-01'), 7);
  });

  test('day 14 across DST boundary (March)', () => {
    // 2026-03-08 → DST forward — make sure floor() doesn't drift.
    assert.equal(computeDayOfStay('2026-03-01', '2026-03-15'), 15);
  });

  test('defends against business_date before arrival_date', () => {
    assert.equal(computeDayOfStay('2026-05-26', '2026-05-25'), 1);
  });
});
