/**
 * Tests for src/lib/room-assignment.ts.
 *
 * Run via: npx tsx --test src/lib/__tests__/room-assignment.test.ts
 *
 * smartAssignRooms is the math that decides who cleans which rooms each
 * morning. It runs in two production paths today:
 *   1. /api/morning-resend — daily cron at ~6am rebuilds assignments
 *      after the scraper has refreshed the room list.
 *   2. (planned) /api/send-shift-confirmations — Mario clicks Send
 *      and this builds the per-staff list that goes out by SMS.
 *
 * Regressions here are the kind that quietly text the wrong rooms to
 * the wrong housekeeper. The cases below pin the contract:
 *   - balanced minute distribution
 *   - floor-grouping (so a HK doesn't get rooms across 4 floors)
 *   - checkouts ordered before stayovers within a floor (heavier work
 *     first, gives HK time to settle into the lighter ones late shift)
 *   - empty / degenerate inputs return empty rather than NaN
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  smartAssignRooms,
  CLEANING_TIMES,
  type RoomForAssignment,
} from '../room-assignment';

// ─── helpers ─────────────────────────────────────────────────────────────────

function r(number: string, type: 'checkout' | 'stayover' | 'vacant'): RoomForAssignment {
  return { number, type };
}

// Pluck minute totals out of all slots for asserting balance.
function minutes(slots: ReturnType<typeof smartAssignRooms>): number[] {
  return slots.map(s => s.totalMinutes);
}

// ─── degenerate inputs ───────────────────────────────────────────────────────

describe('smartAssignRooms — degenerate inputs', () => {
  test('returns [] when there are no housekeepers', () => {
    assert.deepEqual(
      smartAssignRooms([r('101', 'checkout'), r('102', 'stayover')], 0),
      [],
    );
  });

  test('returns [] when there are no rooms', () => {
    assert.deepEqual(smartAssignRooms([], 3), []);
  });

  test('returns [] when housekeepers is negative', () => {
    assert.deepEqual(smartAssignRooms([r('101', 'checkout')], -2), []);
  });

  test('returns one slot per housekeeper even when fewer rooms than housekeepers', () => {
    const out = smartAssignRooms([r('101', 'checkout')], 3);
    assert.equal(out.length, 3);
    // The room goes to the first slot (it's the lightest at minute 0).
    assert.deepEqual(out[0].rooms, ['101']);
    assert.deepEqual(out[1].rooms, []);
    assert.deepEqual(out[2].rooms, []);
  });
});

// ─── ordering inside a floor ─────────────────────────────────────────────────

describe('smartAssignRooms — within-floor ordering', () => {
  test('checkouts come before stayovers on the same floor', () => {
    const rooms = [
      r('103', 'stayover'),
      r('101', 'checkout'),
      r('104', 'stayover'),
      r('102', 'checkout'),
    ];
    const out = smartAssignRooms(rooms, 1);
    // All on floor 1, single HK gets all four — order should be
    // checkouts-then-stayovers, each block ascending by number.
    assert.deepEqual(out[0].rooms, ['101', '102', '103', '104']);
  });

  test('two checkouts ordered by ascending room number', () => {
    const rooms = [r('108', 'checkout'), r('105', 'checkout'), r('102', 'checkout')];
    const out = smartAssignRooms(rooms, 1);
    assert.deepEqual(out[0].rooms, ['102', '105', '108']);
  });

  test('two stayovers ordered by ascending room number', () => {
    const rooms = [r('109', 'stayover'), r('103', 'stayover'), r('117', 'stayover')];
    const out = smartAssignRooms(rooms, 1);
    assert.deepEqual(out[0].rooms, ['103', '109', '117']);
  });
});

// ─── floor-grouping ──────────────────────────────────────────────────────────

describe('smartAssignRooms — floor grouping', () => {
  test('a single floor goes to one housekeeper as a block', () => {
    const rooms = [
      r('101', 'checkout'), r('102', 'checkout'), r('103', 'checkout'),
    ];
    const out = smartAssignRooms(rooms, 2);
    // All on floor 1 → all to slot 0; slot 1 stays empty.
    assert.deepEqual(out[0].rooms, ['101', '102', '103']);
    assert.deepEqual(out[1].rooms, []);
  });

  test('two floors split across two housekeepers (one floor each)', () => {
    const rooms = [
      // Floor 1
      r('101', 'checkout'), r('102', 'checkout'),
      // Floor 2
      r('201', 'checkout'), r('202', 'checkout'),
    ];
    const out = smartAssignRooms(rooms, 2);
    // Slot 0 picked up floor 1 first (lightest at start). Slot 1 then
    // becomes lightest and picks up floor 2.
    assert.deepEqual(out[0].rooms, ['101', '102']);
    assert.deepEqual(out[1].rooms, ['201', '202']);
  });

  test('three floors and two housekeepers — heaviest floor stays whole', () => {
    const rooms = [
      // Floor 1: 1 checkout (30 min)
      r('101', 'checkout'),
      // Floor 2: 3 stayovers (60 min) — heaviest
      r('201', 'stayover'), r('202', 'stayover'), r('203', 'stayover'),
      // Floor 3: 1 stayover (20 min)
      r('301', 'stayover'),
    ];
    const out = smartAssignRooms(rooms, 2);
    // Floor 1 lands on slot 0 first (lightest at minute 0). Floor 2 then
    // goes to slot 1 (now lightest at minute 0 vs 30). Floor 3 lands on
    // slot 0 (now at 30 vs slot 1 at 60).
    assert.deepEqual(out[0].rooms, ['101', '301']);
    assert.deepEqual(out[1].rooms, ['201', '202', '203']);
  });
});

// ─── minute math ─────────────────────────────────────────────────────────────

describe('smartAssignRooms — minute totals', () => {
  test('checkout minutes match the documented constant', () => {
    const out = smartAssignRooms([r('101', 'checkout')], 1);
    assert.equal(out[0].totalMinutes, CLEANING_TIMES.checkout);
  });

  test('stayover minutes match the documented constant', () => {
    const out = smartAssignRooms([r('101', 'stayover')], 1);
    assert.equal(out[0].totalMinutes, CLEANING_TIMES.stayover);
  });

  test('total minutes balance approximately across housekeepers', () => {
    const rooms: RoomForAssignment[] = [];
    // Floor 1: 4 checkouts = 120 min
    for (let n = 101; n <= 104; n++) rooms.push(r(String(n), 'checkout'));
    // Floor 2: 4 stayovers = 80 min
    for (let n = 201; n <= 204; n++) rooms.push(r(String(n), 'stayover'));
    // Floor 3: 4 checkouts = 120 min
    for (let n = 301; n <= 304; n++) rooms.push(r(String(n), 'checkout'));
    // Floor 4: 4 stayovers = 80 min
    for (let n = 401; n <= 404; n++) rooms.push(r(String(n), 'stayover'));
    // Total work: 400 min.

    const out = smartAssignRooms(rooms, 2);
    const mins = minutes(out);
    const total = mins[0] + mins[1];
    assert.equal(total, 400);
    // Each HK should be within 80 minutes of the average 200 — i.e. the
    // worst-case where one HK gets the two heavy floors and the other
    // gets the two light ones. Tighter balancing is a future
    // optimization; this test just pins "no HK is left idle".
    assert.ok(mins[0] >= 120, `slot 0 too low: ${mins[0]}`);
    assert.ok(mins[1] >= 120, `slot 1 too low: ${mins[1]}`);
  });
});

// ─── slot identity ────────────────────────────────────────────────────────────

describe('smartAssignRooms — slot identity', () => {
  test('slots are returned in index order regardless of fill order', () => {
    const rooms = [
      r('201', 'checkout'), r('301', 'checkout'),
    ];
    const out = smartAssignRooms(rooms, 3);
    assert.equal(out[0].index, 0);
    assert.equal(out[1].index, 1);
    assert.equal(out[2].index, 2);
  });

  test('output length always equals numHousekeepers when input is non-empty', () => {
    const rooms = [r('101', 'checkout')];
    for (let n = 1; n <= 8; n++) {
      assert.equal(smartAssignRooms(rooms, n).length, n);
    }
  });
});

// ─── deterministic across reruns ─────────────────────────────────────────────

describe('smartAssignRooms — determinism', () => {
  test('same input twice → identical output (no Math.random / Date)', () => {
    const rooms = [
      r('103', 'stayover'), r('101', 'checkout'), r('204', 'checkout'),
      r('202', 'stayover'), r('305', 'checkout'),
    ];
    const a = smartAssignRooms(rooms, 3);
    const b = smartAssignRooms(rooms, 3);
    assert.deepEqual(a, b);
  });
});
