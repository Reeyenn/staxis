import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { isUsableJoinCode, withJoinCodeHotelLock } from '@/lib/join-codes';

describe('join-code usability', () => {
  const now = Date.parse('2026-07-20T12:00:00.000Z');

  test('requires a future expiry, an available use, and no revocation', () => {
    assert.equal(isUsableJoinCode({
      expires_at: '2026-07-20T12:00:00.001Z',
      used_count: 99,
      max_uses: 100,
      revoked_at: null,
    }, now), true);
    assert.equal(isUsableJoinCode({
      expires_at: '2026-07-20T12:00:00.000Z',
      used_count: 99,
      max_uses: 100,
      revoked_at: null,
    }, now), false);
    assert.equal(isUsableJoinCode({
      expires_at: '2026-07-21T12:00:00.000Z',
      used_count: 100,
      max_uses: 100,
      revoked_at: null,
    }, now), false);
    assert.equal(isUsableJoinCode({
      expires_at: '2026-07-21T12:00:00.000Z',
      used_count: 0,
      max_uses: 100,
      revoked_at: '2026-07-20T11:00:00.000Z',
    }, now), false);
  });
});

describe('join-code hotel lock', () => {
  test('serializes concurrent get-or-create work for the same hotel', async () => {
    const order: string[] = [];
    let releaseFirst = () => {};
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });

    const first = withJoinCodeHotelLock('hotel-a', async () => {
      order.push('first:start');
      await firstGate;
      order.push('first:end');
      return 'first';
    });
    await Promise.resolve();

    const second = withJoinCodeHotelLock('hotel-a', async () => {
      order.push('second:start');
      order.push('second:end');
      return 'second';
    });
    await Promise.resolve();

    assert.deepEqual(order, ['first:start']);
    releaseFirst();
    assert.deepEqual(await Promise.all([first, second]), ['first', 'second']);
    assert.deepEqual(order, [
      'first:start',
      'first:end',
      'second:start',
      'second:end',
    ]);
  });

  test('does not block independent hotels behind one another', async () => {
    let releaseHotelA = () => {};
    const hotelAGate = new Promise<void>((resolve) => { releaseHotelA = resolve; });
    let hotelBStarted = false;

    const hotelA = withJoinCodeHotelLock('hotel-a-independent', async () => {
      await hotelAGate;
    });
    const hotelB = withJoinCodeHotelLock('hotel-b-independent', async () => {
      hotelBStarted = true;
    });
    await hotelB;
    assert.equal(hotelBStarted, true);
    releaseHotelA();
    await hotelA;
  });
});
