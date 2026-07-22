/**
 * Tests for the weekly-load aggregation that powers the (previously inert)
 * overtime / weekly-day caps. See src/lib/schedule/weekly-load.ts.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { aggregateWeeklyLoad } from '@/lib/schedule/weekly-load';

describe('aggregateWeeklyLoad', () => {
  test('sums hours and counts distinct days per staff', () => {
    const m = aggregateWeeklyLoad([
      { staff_id: 'a', shift_date: '2026-07-20', start_time: '09:00:00', end_time: '17:00:00' }, // 8h
      { staff_id: 'a', shift_date: '2026-07-21', start_time: '09:00:00', end_time: '15:00:00' }, // 6h
      { staff_id: 'b', shift_date: '2026-07-20', start_time: '08:00:00', end_time: '12:00:00' }, // 4h
    ]);
    assert.deepEqual(m.get('a'), { hours: 14, days: 2 });
    assert.deepEqual(m.get('b'), { hours: 4, days: 1 });
  });

  test('two shifts on the same day count hours twice but only one day', () => {
    const m = aggregateWeeklyLoad([
      { staff_id: 'a', shift_date: '2026-07-20', start_time: '06:00:00', end_time: '10:00:00' }, // 4h
      { staff_id: 'a', shift_date: '2026-07-20', start_time: '14:00:00', end_time: '18:00:00' }, // 4h
    ]);
    assert.deepEqual(m.get('a'), { hours: 8, days: 1 });
  });

  test('ignores rows with a null staff_id (open slots)', () => {
    const m = aggregateWeeklyLoad([
      { staff_id: null, shift_date: '2026-07-20', start_time: '09:00:00', end_time: '17:00:00' },
    ]);
    assert.equal(m.size, 0);
  });

  test('overnight shift wraps past midnight', () => {
    const m = aggregateWeeklyLoad([
      { staff_id: 'a', shift_date: '2026-07-20', start_time: '22:00:00', end_time: '06:00:00' }, // 8h
    ]);
    assert.deepEqual(m.get('a'), { hours: 8, days: 1 });
  });
});
