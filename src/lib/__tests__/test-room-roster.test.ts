import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { buildStandardTestRoomNumbers } from '@/lib/test-room-roster';

describe('standard test room roster', () => {
  test('uses the proven 101-410 prefix and appends the next floor', () => {
    const roster = buildStandardTestRoomNumbers(50);

    assert.equal(roster.length, 50);
    assert.deepEqual(roster.slice(0, 3), ['101', '102', '103']);
    assert.deepEqual(roster.slice(37, 43), ['408', '409', '410', '501', '502', '503']);
    assert.deepEqual(roster.slice(-10), [
      '501', '502', '503', '504', '505',
      '506', '507', '508', '509', '510',
    ]);
    assert.equal(new Set(roster).size, roster.length);
  });

  test('matches the configured count for the restored test properties', () => {
    for (const totalRooms of [62, 74]) {
      const roster = buildStandardTestRoomNumbers(totalRooms);
      assert.equal(roster.length, totalRooms);
      assert.equal(roster[totalRooms - 1], totalRooms === 62 ? '702' : '804');
      assert.equal(new Set(roster).size, totalRooms);
    }
  });

  test('rejects counts outside the property-create contract', () => {
    assert.throws(() => buildStandardTestRoomNumbers(0), RangeError);
    assert.throws(() => buildStandardTestRoomNumbers(1.5), RangeError);
    assert.throws(() => buildStandardTestRoomNumbers(2001), RangeError);
  });
});
