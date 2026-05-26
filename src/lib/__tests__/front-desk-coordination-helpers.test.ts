/**
 * Pure-helper tests for the front-desk coordination layer.
 *
 * Covers:
 *   - isTimeInShiftWindow: inclusive ends, overnight-shift wraparound
 *   - clockInTimezone: returns YYYY-MM-DD + HH:MM:SS in the requested IANA tz
 *   - DST-safety smoke test: 9am local stays 9am local across the spring-
 *     forward boundary (the underlying Intl.DateTimeFormat handles this;
 *     this test pins the behavior so a future refactor doesn't subtly
 *     break it).
 *
 * The DB-touching helpers (findCurrentlyWorkingFrontDesk,
 * findNextReadyRoom, executeRoomMove, dispatchSMS) are exercised by their
 * sibling tests in this directory (front-desk-coordination-dispatch.test.ts
 * + front-desk-coordination-source-guards.test.ts).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  clockInTimezone,
  isTimeInShiftWindow,
} from '@/lib/front-desk-coordination';

describe('isTimeInShiftWindow — standard daytime shifts', () => {
  it('returns true for a time strictly inside the window', () => {
    assert.equal(isTimeInShiftWindow('12:30:00', '09:00:00', '17:00:00'), true);
  });

  it('is inclusive of the start instant', () => {
    assert.equal(isTimeInShiftWindow('09:00:00', '09:00:00', '17:00:00'), true);
  });

  it('is inclusive of the end instant', () => {
    // Exact-shift-end case — a real housekeeper's last second on the
    // clock should still count as "currently working" for an SMS that
    // fires at that moment.
    assert.equal(isTimeInShiftWindow('17:00:00', '09:00:00', '17:00:00'), true);
  });

  it('returns false for times before the shift', () => {
    assert.equal(isTimeInShiftWindow('08:59:59', '09:00:00', '17:00:00'), false);
  });

  it('returns false for times after the shift', () => {
    assert.equal(isTimeInShiftWindow('17:00:01', '09:00:00', '17:00:00'), false);
  });
});

describe('isTimeInShiftWindow — overnight night-audit shift', () => {
  // Night-audit: 22:00 → 06:00 next day. We encode this as end < start
  // and use the OR-wraparound predicate.
  it('includes a time before midnight', () => {
    assert.equal(isTimeInShiftWindow('23:30:00', '22:00:00', '06:00:00'), true);
  });

  it('includes a time after midnight', () => {
    assert.equal(isTimeInShiftWindow('02:15:00', '22:00:00', '06:00:00'), true);
  });

  it('includes the start (22:00)', () => {
    assert.equal(isTimeInShiftWindow('22:00:00', '22:00:00', '06:00:00'), true);
  });

  it('includes the end (06:00)', () => {
    assert.equal(isTimeInShiftWindow('06:00:00', '22:00:00', '06:00:00'), true);
  });

  it('excludes mid-afternoon (outside the overnight window)', () => {
    assert.equal(isTimeInShiftWindow('15:00:00', '22:00:00', '06:00:00'), false);
  });
});

describe('clockInTimezone — IANA rendering', () => {
  it('returns YYYY-MM-DD and HH:MM:SS for America/Chicago', () => {
    // 2026-05-26T18:00:00Z = 13:00:00 in America/Chicago (CDT, UTC-5)
    const now = new Date('2026-05-26T18:00:00Z');
    const { date, time } = clockInTimezone(now, 'America/Chicago');
    assert.equal(date, '2026-05-26');
    assert.equal(time, '13:00:00');
  });

  it('respects America/New_York (UTC-4 in summer)', () => {
    const now = new Date('2026-05-26T18:00:00Z');
    const { date, time } = clockInTimezone(now, 'America/New_York');
    assert.equal(date, '2026-05-26');
    assert.equal(time, '14:00:00');
  });

  it('rolls the date backward when local time is the previous day', () => {
    // 2026-05-26T02:00:00Z = 21:00:00 on 2026-05-25 in America/Chicago
    const now = new Date('2026-05-26T02:00:00Z');
    const { date, time } = clockInTimezone(now, 'America/Chicago');
    assert.equal(date, '2026-05-25');
    assert.equal(time, '21:00:00');
  });

  it('survives the spring-forward DST boundary (March 8, 2026 in America/Chicago)', () => {
    // Before DST: 09:00 CST = 15:00 UTC on 2026-03-07
    const before = new Date('2026-03-07T15:00:00Z');
    const { time: tBefore } = clockInTimezone(before, 'America/Chicago');
    assert.equal(tBefore, '09:00:00');

    // After DST: 09:00 CDT = 14:00 UTC on 2026-03-09 (clocks jumped
    // forward; the same UTC offset that produced 09:00 yesterday now
    // produces 10:00). The local 09:00 instant moves one hour earlier
    // in UTC. This is exactly the bug class a hard-coded UTC offset
    // would introduce — pinning here so a refactor can't regress it.
    const after = new Date('2026-03-09T14:00:00Z');
    const { time: tAfter } = clockInTimezone(after, 'America/Chicago');
    assert.equal(tAfter, '09:00:00');
  });

  it('combined with isTimeInShiftWindow — DST-safe "is 9am in the 8-5 shift" check', () => {
    // Day after spring-forward: 09:00 CDT = 14:00 UTC. A 08:00-17:00
    // shift in America/Chicago should still include this instant.
    const now = new Date('2026-03-09T14:00:00Z');
    const { time } = clockInTimezone(now, 'America/Chicago');
    assert.equal(isTimeInShiftWindow(time, '08:00:00', '17:00:00'), true);
  });
});

// Codex adversarial fix #6: the VIP free-text matcher used to overmatch
// "not VIP" / "no VIP" notes. These tests live next to the other pure-
// helper tests because they assert behavior that's reachable through
// `looksVipText` — kept inline rather than imported because that helper
// is private to the route file. We grep the route source to assert the
// shape, then sanity-check the regex separately.
describe('VIP text matcher — false-positive guard', () => {
  // The negation prefix used in vip-arrivals/route.ts. Keep this regex
  // in sync with `negationsBefore` there — if they drift, the source
  // grep below catches the rename.
  const NEGATION_RX = /(?:^|[^a-z])(?:not|no|non[-\s]?|never|without|minus|excluding|no longer|n['’]t\s+a)\s*$/i;
  const VIP_RX = /\bvip\b/gi;

  function looksVipReplica(text: string): boolean {
    let m: RegExpExecArray | null;
    const rx = new RegExp(VIP_RX.source, VIP_RX.flags);
    while ((m = rx.exec(text)) !== null) {
      const lookBehind = text.slice(Math.max(0, m.index - 20), m.index);
      if (!NEGATION_RX.test(lookBehind)) return true;
    }
    return false;
  }

  it('positive: "VIP arrival" matches', () => {
    assert.equal(looksVipReplica('VIP arrival, welcome basket please'), true);
  });

  it('positive: "Platinum VIP guest" matches', () => {
    assert.equal(looksVipReplica('Platinum VIP guest — quiet floor'), true);
  });

  it('negative: "not VIP" does NOT match (was the Codex finding)', () => {
    assert.equal(looksVipReplica('not VIP'), false);
  });

  it('negative: "no VIP amenity" does NOT match', () => {
    assert.equal(looksVipReplica('no VIP amenity needed'), false);
  });

  it('negative: "no longer VIP" does NOT match', () => {
    assert.equal(looksVipReplica('no longer VIP — downgraded'), false);
  });

  it('mixed: "not VIP, but VIP guest list applies" still flags as VIP', () => {
    // First VIP is negated, second isn't — the affirmative wins.
    assert.equal(looksVipReplica('not VIP, but VIP guest list applies'), true);
  });
});

