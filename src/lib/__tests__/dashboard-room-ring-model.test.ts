import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  buildRoomRingTicks,
  ringStatusForRoom,
} from '@/app/dashboard/_components/room-ring-model';
import type { Room } from '@/types';

const baseRoom = (number: string, overrides: Partial<Room> = {}): Room => ({
  id: `2026-07-31:${number}`,
  number,
  type: 'vacant',
  priority: 'standard',
  status: 'clean',
  date: '2026-07-31',
  propertyId: 'hotel-a',
  ...overrides,
});

describe('Dashboard room ring truthfulness', () => {
  test('keeps real room identities and never distributes aggregate statuses', () => {
    const ticks = buildRoomRingTicks([
      baseRoom('101', { status: 'dirty', statusSource: 'assignment' }),
      baseRoom('205', { status: 'in_progress', statusSource: 'assignment' }),
    ], ['101', '102', '205']);

    assert.deepEqual(ticks, [
      { idx: 0, num: '101', status: 'dirty' },
      { idx: 1, num: '102', status: 'none' },
      { idx: 2, num: '205', status: 'inprog' },
    ]);
  });

  test('uses room-level reservation context without making up a room number', () => {
    assert.equal(ringStatusForRoom(baseRoom('301', {
      status: 'clean',
      statusSource: 'pms',
      type: 'stayover',
    })), 'occupied');
    assert.equal(ringStatusForRoom(baseRoom('302', {
      status: 'clean',
      statusSource: 'pms',
      arrival: '7/31/26',
    })), 'arriving');
    assert.equal(ringStatusForRoom(baseRoom('303', {
      status: 'clean',
      statusSource: 'assignment',
      type: 'checkout',
    })), 'departing');
  });

  test('keeps active housekeeping work ahead of reservation context', () => {
    assert.equal(ringStatusForRoom(baseRoom('304', {
      status: 'dirty',
      statusSource: 'assignment',
      type: 'checkout',
    })), 'dirty');
    assert.equal(ringStatusForRoom(baseRoom('305', {
      status: 'in_progress',
      statusSource: 'assignment',
      type: 'stayover',
    })), 'inprog');
  });

  test('keeps no-signal and out-of-service rooms distinct', () => {
    assert.equal(ringStatusForRoom(baseRoom('401', {
      status: 'dirty',
      statusSource: 'default',
    })), 'none');
    assert.equal(ringStatusForRoom(baseRoom('402', {
      status: 'clean',
      arrival: '7/31/26',
    })), 'none');
    assert.equal(ringStatusForRoom({
      ...baseRoom('403'),
      isOutOfService: true,
    }), 'ooo');
  });

  test('prefers an observed duplicate over a missing-provenance duplicate', () => {
    assert.deepEqual(buildRoomRingTicks([
      baseRoom('404', { status: 'clean' }),
      baseRoom('404', { status: 'dirty', statusSource: 'pms' }),
    ]), [
      { idx: 0, num: '404', status: 'dirty' },
    ]);
  });

  test('does not manufacture placeholder identities when no roster exists', () => {
    assert.deepEqual(buildRoomRingTicks([], []), []);
  });
});
