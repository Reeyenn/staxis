// Occupancy import: month parsing, wide and tall shapes, the per-day spread,
// and the honesty rules around what may be derived from what.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  datesInMonth,
  daysInMonthOf,
  monthLabel,
  monthRangeLabel,
  normalizeOccupancyMonths,
  parseCount,
  parseMonthStart,
  parseOccupancyPct,
  planOccupancyDayWrites,
  OCCUPANCY_IMPORT_MAX_AGE_MONTHS,
  type ExistingDay,
} from '@/lib/inventory-import/occupancy';
import { findLopsidedHistory, lopsidedTopic, LOPSIDED_MIN_MONTHS } from '@/lib/inventory-import/lopsided';

const TODAY = '2026-08-03';
const ROOMS = 60;

describe('reading a month out of whatever the sheet called it', () => {
  test('accepts the spellings hotels actually use', () => {
    assert.equal(parseMonthStart('2026-03'), '2026-03-01');
    assert.equal(parseMonthStart('2026-03-17'), '2026-03-01');
    assert.equal(parseMonthStart('March 2026'), '2026-03-01');
    assert.equal(parseMonthStart('Mar 2026'), '2026-03-01');
    assert.equal(parseMonthStart('MARCH 2026'), '2026-03-01');
    assert.equal(parseMonthStart('Mar-26'), '2026-03-01');
    assert.equal(parseMonthStart('03/2026'), '2026-03-01');
    assert.equal(parseMonthStart('2026/03'), '2026-03-01');
  });

  test('refuses what it cannot pin to a year rather than guessing one', () => {
    assert.equal(parseMonthStart('March'), null);
    assert.equal(parseMonthStart('Q1'), null);
    assert.equal(parseMonthStart('03/04'), null);
    assert.equal(parseMonthStart('Total'), null);
    assert.equal(parseMonthStart(''), null);
    assert.equal(parseMonthStart('2026-13'), null);
  });

  test('knows how long each month is, leap year included', () => {
    assert.equal(daysInMonthOf('2026-02-01'), 28);
    assert.equal(daysInMonthOf('2028-02-01'), 29);
    assert.equal(daysInMonthOf('2026-04-01'), 30);
    assert.equal(datesInMonth('2026-02-01').length, 28);
    assert.equal(datesInMonth('2026-02-01')[0], '2026-02-01');
    assert.equal(datesInMonth('2026-02-01')[27], '2026-02-28');
  });

  test('labels months in words for the confirm screen', () => {
    assert.equal(monthLabel('2026-03-01'), 'March 2026');
    assert.equal(monthRangeLabel(['2026-06-01', '2026-03-01']), 'March 2026 to June 2026');
    assert.equal(monthRangeLabel(['2026-03-01']), 'March 2026');
    assert.equal(monthRangeLabel([]), '');
  });
});

describe('reading the numbers', () => {
  test('a percentage is read the way it was written', () => {
    assert.equal(parseOccupancyPct('71.4%'), 71.4);
    assert.equal(parseOccupancyPct('71.4'), 71.4);
    assert.equal(parseOccupancyPct(71.4), 71.4);
    assert.equal(parseOccupancyPct('0.714'), 71.4);
    assert.equal(parseOccupancyPct('100%'), 100);
  });

  test('a bare 1 stays one percent, because that is what somebody typed', () => {
    assert.equal(parseOccupancyPct('1'), 1);
    assert.equal(parseOccupancyPct(1), 1);
    // Only a decimal with no percent sign is read as a fraction.
    assert.equal(parseOccupancyPct('1.0'), 100);
  });

  test('impossible or unreadable percentages become nothing, not a number', () => {
    assert.equal(parseOccupancyPct('142%'), null);
    assert.equal(parseOccupancyPct('n/a'), null);
    assert.equal(parseOccupancyPct(''), null);
    assert.equal(parseOccupancyPct(null), null);
  });

  test('counts tolerate thousands separators', () => {
    assert.equal(parseCount('1,240'), 1240);
    assert.equal(parseCount('1240'), 1240);
    assert.equal(parseCount(1240.4), 1240);
    assert.equal(parseCount('none'), null);
  });
});

describe('a month becomes the days the model reads', () => {
  test('a percentage plus the hotel room count gives a per-day figure', () => {
    const { months } = normalizeOccupancyMonths({
      rows: [{ month: '2026-03', occupancy_pct: '75%' }],
      propertyTotalRooms: ROOMS,
      todayLocal: TODAY,
    });
    assert.equal(months.length, 1);
    assert.equal(months[0].occupancyPct, 75);
    assert.equal(months[0].perDay.roomsAvailable, 60);
    assert.equal(months[0].perDay.roomsSold, 45);
    // The legacy column the Python trainer reads first.
    assert.equal(months[0].perDay.occupied, 45);
    assert.equal(months[0].roomsSoldMonth, 45 * 31);
  });

  test('a month total of room-nights is recognized and divided', () => {
    const { months } = normalizeOccupancyMonths({
      rows: [{ month: '2026-06', rooms_sold: '1,240', rooms_available: '1,800' }],
      propertyTotalRooms: ROOMS,
      todayLocal: TODAY,
    });
    assert.equal(months[0].perDay.roomsAvailable, 60);
    assert.equal(months[0].perDay.roomsSold, Math.round(1240 / 30));
    assert.equal(months[0].roomsSoldMonth, 1240);
  });

  test('a per-day room count is not mistaken for a month total', () => {
    const { months } = normalizeOccupancyMonths({
      rows: [{ month: '2026-06', rooms_sold: '45', rooms_available: '60' }],
      propertyTotalRooms: ROOMS,
      todayLocal: TODAY,
    });
    assert.equal(months[0].perDay.roomsSold, 45);
    assert.equal(months[0].roomsSoldMonth, 45 * 30);
    assert.equal(months[0].occupancyPct, 75);
  });

  test('a day can never sell more rooms than the hotel has', () => {
    const { months } = normalizeOccupancyMonths({
      rows: [{ month: '2026-06', rooms_sold: '80', rooms_available: '60' }],
      propertyTotalRooms: ROOMS,
      todayLocal: TODAY,
    });
    assert.ok((months[0].perDay.roomsSold ?? 0) <= 60);
  });

  test('a month with no usable number is reported, not invented', () => {
    const { months, issues } = normalizeOccupancyMonths({
      rows: [{ month: '2026-06', occupancy_pct: 'n/a', rooms_sold: null }],
      propertyTotalRooms: ROOMS,
      todayLocal: TODAY,
    });
    assert.equal(months.length, 0);
    assert.equal(issues[0].reason, 'no_numbers');
  });

  test('a month too old to be this hotel is refused', () => {
    const { months, issues } = normalizeOccupancyMonths({
      rows: [{ month: '2015-06', occupancy_pct: '75%' }],
      propertyTotalRooms: ROOMS,
      todayLocal: TODAY,
    });
    assert.equal(months.length, 0);
    assert.equal(issues[0].reason, 'out_of_range');
    assert.equal(OCCUPANCY_IMPORT_MAX_AGE_MONTHS, 36);
  });

  test('a month in the future is refused', () => {
    const { months, issues } = normalizeOccupancyMonths({
      rows: [{ month: '2026-12', occupancy_pct: '75%' }],
      propertyTotalRooms: ROOMS,
      todayLocal: TODAY,
    });
    assert.equal(months.length, 0);
    assert.equal(issues[0].reason, 'out_of_range');
  });

  test('the same month twice keeps the first and says so', () => {
    const { months, issues } = normalizeOccupancyMonths({
      rows: [
        { month: '2026-06', occupancy_pct: '75%' },
        { month: 'June 2026', occupancy_pct: '80%' },
      ],
      propertyTotalRooms: ROOMS,
      todayLocal: TODAY,
    });
    assert.equal(months.length, 1);
    assert.equal(months[0].occupancyPct, 75);
    assert.equal(issues[0].reason, 'duplicate_month');
  });

  test('an unreadable month label is reported rather than dropped', () => {
    const { issues } = normalizeOccupancyMonths({
      rows: [{ month: 'YTD', occupancy_pct: '75%' }],
      propertyTotalRooms: ROOMS,
      todayLocal: TODAY,
    });
    assert.equal(issues[0].reason, 'unreadable_month');
  });
});

describe('both sheet shapes end up the same', () => {
  // The reader normalizes wide to tall, so this covers what arrives after it:
  // a year-by-month grid produces one entry per month, in order.
  const wideAsTall = [
    { month: 'Jan-26', occupancy_pct: '58%' },
    { month: 'Feb-26', occupancy_pct: '61%' },
    { month: 'Mar-26', occupancy_pct: '71.4%' },
  ];
  const tall = [
    { month: '2026-01', occupancy_pct: '58%' },
    { month: '2026-02', occupancy_pct: '61%' },
    { month: '2026-03', occupancy_pct: '71.4%' },
  ];

  test('a wide grid and a tall list normalize identically', () => {
    const a = normalizeOccupancyMonths({ rows: wideAsTall, propertyTotalRooms: ROOMS, todayLocal: TODAY });
    const b = normalizeOccupancyMonths({ rows: tall, propertyTotalRooms: ROOMS, todayLocal: TODAY });
    assert.deepEqual(a.months, b.months);
    assert.equal(a.months.length, 3);
  });

  test('months come back oldest first, whatever order the sheet had them', () => {
    const { months } = normalizeOccupancyMonths({
      rows: [...wideAsTall].reverse(),
      propertyTotalRooms: ROOMS,
      todayLocal: TODAY,
    });
    assert.deepEqual(months.map((m) => m.monthStart), ['2026-01-01', '2026-02-01', '2026-03-01']);
  });

  test('with no known room count we still keep the percentage', () => {
    const { months } = normalizeOccupancyMonths({
      rows: [{ month: '2026-03', occupancy_pct: '71.4%' }],
      propertyTotalRooms: null,
      todayLocal: TODAY,
    });
    assert.equal(months[0].occupancyPct, 71.4);
    assert.equal(months[0].perDay.roomsAvailable, null);
    assert.equal(months[0].perDay.roomsSold, null);
  });
});

describe('the lopsided-history nudge only fires when it is true', () => {
  const inv = ['2026-03-01', '2026-04-01', '2026-05-01', '2026-06-01'];

  test('names the months it is actually missing', () => {
    const found = findLopsidedHistory({ inventoryMonths: inv, occupancyMonths: [] });
    assert.ok(found);
    assert.equal(found.side, 'occupancy_missing');
    assert.match(found.text, /March 2026 to June 2026/);
    assert.match(found.text, /no occupancy/);
    assert.deepEqual(found.missingMonths, inv);
  });

  test('says nothing when the occupancy is already there', () => {
    assert.equal(findLopsidedHistory({ inventoryMonths: inv, occupancyMonths: inv }), null);
  });

  test('says nothing when only one month is missing', () => {
    const occupancy = inv.slice(0, 3);
    assert.equal(findLopsidedHistory({ inventoryMonths: inv, occupancyMonths: occupancy }), null);
    assert.equal(LOPSIDED_MIN_MONTHS, 2);
  });

  test('says nothing about a single lonely sheet', () => {
    assert.equal(findLopsidedHistory({ inventoryMonths: ['2026-03-01'], occupancyMonths: [] }), null);
  });

  test('works the other way round too', () => {
    const found = findLopsidedHistory({ inventoryMonths: [], occupancyMonths: inv });
    assert.ok(found);
    assert.equal(found.side, 'inventory_missing');
    assert.match(found.text, /no inventory counts/);
  });

  test('when both sides are short, the bigger gap is the one raised', () => {
    const found = findLopsidedHistory({
      inventoryMonths: ['2024-01-01', '2024-02-01'],
      occupancyMonths: ['2026-01-01', '2026-02-01', '2026-03-01', '2026-04-01'],
    });
    assert.ok(found);
    assert.equal(found.side, 'inventory_missing');
    assert.equal(found.missingMonths.length, 4);
  });

  test('a malformed month is ignored rather than named to a person', () => {
    const found = findLopsidedHistory({
      inventoryMonths: ['2026-03-01', 'nonsense', '2026-04-01', ''],
      occupancyMonths: [],
    });
    assert.ok(found);
    assert.deepEqual(found.missingMonths, ['2026-03-01', '2026-04-01']);
  });

  test('the sentence carries no em dash and no invented number', () => {
    const found = findLopsidedHistory({ inventoryMonths: inv, occupancyMonths: [] });
    assert.ok(found);
    assert.doesNotMatch(found.text, /—/);
    assert.doesNotMatch(found.question, /—/);
    // Every number in the sentence is a year we were handed.
    for (const n of found.text.match(/\d+/g) ?? []) {
      assert.ok(inv.some((m) => m.startsWith(n)), `${n} was not in the data`);
    }
  });

  test('the topic is stable per side, so a No sticks', () => {
    assert.equal(lopsidedTopic('occupancy_missing'), 'import:lopsided:occupancy_missing');
    assert.notEqual(lopsidedTopic('occupancy_missing'), lopsidedTopic('inventory_missing'));
  });
});

describe('which days a derived month may be written to', () => {
  const month = normalizeOccupancyMonths({
    rows: [{ month: '2026-06', occupancy_pct: '75%' }],
    propertyTotalRooms: ROOMS,
    todayLocal: TODAY,
  }).months[0];

  const emptyDay = (date: string): ExistingDay => ({
    date, occupied: null, rooms_sold: null, rooms_available: null,
    occupancy_source: null, sealed_at: null,
  });

  test('an empty month is written in full, one row per day', () => {
    const plan = planOccupancyDayWrites({ month, existing: [], mayFeedTraining: true });
    assert.equal(plan.write.length, 30);
    assert.equal(plan.leaveAlone.length, 0);
    assert.equal(plan.write[0].date, '2026-06-01');
    assert.equal(plan.write[0].occupancySource, 'operator');
    assert.equal(plan.write[0].roomsSold, 45);
    assert.equal(plan.write[0].occupied, 45);
  });

  test('a sealed day is never overwritten', () => {
    const plan = planOccupancyDayWrites({
      month,
      existing: [{ ...emptyDay('2026-06-04'), sealed_at: '2026-06-05T07:00:00.000Z' }],
      mayFeedTraining: true,
    });
    assert.equal(plan.write.some((d) => d.date === '2026-06-04'), false);
    assert.deepEqual(plan.leaveAlone.filter((d) => d.date === '2026-06-04'), [
      { date: '2026-06-04', reason: 'sealed' },
    ]);
  });

  test('a day that already names a source is left alone', () => {
    const plan = planOccupancyDayWrites({
      month,
      existing: [{ ...emptyDay('2026-06-04'), occupancy_source: 'pms_report', rooms_sold: 51 }],
      mayFeedTraining: true,
    });
    assert.equal(plan.leaveAlone.find((d) => d.date === '2026-06-04')?.reason, 'has_source');
  });

  test('a day the robot already counted is left alone', () => {
    const plan = planOccupancyDayWrites({
      month,
      existing: [{ ...emptyDay('2026-06-04'), occupied: 52 }],
      mayFeedTraining: true,
    });
    assert.equal(plan.leaveAlone.find((d) => d.date === '2026-06-04')?.reason, 'has_occupied');
  });

  test('a demo hotel writes nothing at all, so it can never feed a real model', () => {
    const plan = planOccupancyDayWrites({ month, existing: [], mayFeedTraining: false });
    assert.equal(plan.write.length, 0);
    assert.equal(plan.leaveAlone.length, 30);
    assert.ok(plan.leaveAlone.every((d) => d.reason === 'demo_hotel'));
  });

  test('the prior values ride along so removing the import restores them', () => {
    const plan = planOccupancyDayWrites({
      month,
      existing: [{ ...emptyDay('2026-06-04'), rooms_available: 60 }],
      mayFeedTraining: true,
    });
    const day = plan.write.find((d) => d.date === '2026-06-04');
    assert.ok(day);
    assert.deepEqual(day.prior, {
      occupied: null, rooms_sold: null, rooms_available: 60,
      occupancy_source: null, sealed_at: null,
    });
  });
});
