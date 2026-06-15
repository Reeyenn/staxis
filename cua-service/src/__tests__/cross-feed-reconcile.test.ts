/**
 * Cross-feed reconciliation tests (feature/cua-bestclass-verify, Task 1).
 *
 * PURE module — no bootstrapping needed.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  reconcileCrossFeed,
  parseCounter,
  CROSS_FEED_CHECKS,
  DASHBOARD_FEED,
  type CrossFeedInput,
} from '../cross-feed-reconcile.js';

describe('parseCounter', () => {
  test('plain integers, thousands separators, embedded labels', () => {
    assert.equal(parseCounter('42'), 42);
    assert.equal(parseCounter('1,234'), 1234);
    assert.equal(parseCounter('Occupied: 17'), 17);
    assert.equal(parseCounter(8), 8);
  });
  test('non-numeric → null', () => {
    assert.equal(parseCounter('—'), null);
    assert.equal(parseCounter(''), null);
    assert.equal(parseCounter(null), null);
    assert.equal(parseCounter({}), null);
  });
});

describe('reconcileCrossFeed — wrong-row-set detection (the hero case)', () => {
  test('an EMPTY/wrong getArrivals feed vs a non-zero dashboard arrivals counter → FAIL', () => {
    const input: CrossFeedInput = {
      feeds: { getArrivals: { rowCount: 0 } },
      dashboardCounters: { arrivals_remaining_today: 9 },
    };
    const r = reconcileCrossFeed(input);
    assert.equal(r.signal, 'fail');
    const arr = r.checks.find((c) => c.counter === 'arrivals_remaining_today')!;
    assert.equal(arr.verdict, 'mismatch');
    assert.equal(arr.mode, 'lower_bound');
    assert.match(arr.reason, /lower_bound_violated/);
  });

  test('a too-SMALL room-status feed vs dashboard occupied count → FAIL (lower bound)', () => {
    // 5 rooms scraped but the dashboard reports 30 occupied — impossible: the
    // feed learned the wrong / a partial table.
    const r = reconcileCrossFeed({
      feeds: { getRoomStatus: { rowCount: 5 } },
      dashboardCounters: { total_occupied_rooms: 30 },
    });
    assert.equal(r.signal, 'fail');
  });
});

describe('reconcileCrossFeed — correct recipes pass / abstain (no false fails)', () => {
  test('a correct superset arrivals feed (rowCount ≥ remaining) → PASS via lower bound', () => {
    const r = reconcileCrossFeed({
      feeds: { getArrivals: { rowCount: 30 }, getDepartures: { rowCount: 25 } },
      dashboardCounters: { arrivals_remaining_today: 12, departures_remaining_today: 8 },
    });
    assert.equal(r.signal, 'pass');
    assert.equal(r.mismatched, 0);
    assert.ok(r.matched >= 2);
  });

  test('small drift within tolerance still passes (a guest checked in mid-scrape)', () => {
    // counter 10, feed shows 9 — within max(2, 10%) tolerance.
    const r = reconcileCrossFeed({
      feeds: { getArrivals: { rowCount: 9 } },
      dashboardCounters: { arrivals_remaining_today: 10 },
    });
    assert.equal(r.signal, 'pass');
  });

  test('no dashboard feed at all → no_signal (legacy / dashboard-less PMS, never penalised)', () => {
    const r = reconcileCrossFeed({
      feeds: { getArrivals: { rowCount: 30 }, getRoomStatus: { rowCount: 80 } },
      dashboardCounters: {},
    });
    assert.equal(r.signal, 'no_signal');
    assert.equal(r.mismatched, 0);
    assert.equal(r.matched, 0);
  });

  test('a zero counter is uninformative → abstain, not a spurious pass', () => {
    const r = reconcileCrossFeed({
      feeds: { getArrivals: { rowCount: 0 } },
      dashboardCounters: { arrivals_remaining_today: 0 },
    });
    assert.equal(r.signal, 'no_signal');
    const arr = r.checks.find((c) => c.counter === 'arrivals_remaining_today')!;
    assert.equal(arr.verdict, 'abstain');
    assert.match(arr.reason, /uninformative/);
  });

  test('missing the witnessed feed → abstain for that counter', () => {
    const r = reconcileCrossFeed({
      feeds: {}, // no getArrivals observation
      dashboardCounters: { arrivals_remaining_today: 5 },
    });
    const arr = r.checks.find((c) => c.counter === 'arrivals_remaining_today')!;
    assert.equal(arr.verdict, 'abstain');
    assert.equal(arr.reason, 'feed_unavailable');
  });
});

describe('reconcileCrossFeed — exact occupancy from a COMPLETE room-status set', () => {
  const rooms = (statuses: string[]) =>
    statuses.map((s, i) => ({ room_number: String(100 + i), status: s }));

  test('exact occupied count matches → match (exact mode)', () => {
    const r = reconcileCrossFeed({
      feeds: { getRoomStatus: { rowCount: 5, rows: rooms(['occupied', 'occupied_clean', 'vacant_clean', 'vacant_dirty', 'occupied']), rowsComplete: true } },
      dashboardCounters: { total_occupied_rooms: 3, total_vacant_clean: 1 },
    });
    assert.equal(r.signal, 'pass');
    const occ = r.checks.find((c) => c.counter === 'total_occupied_rooms')!;
    assert.equal(occ.mode, 'exact');
    assert.equal(occ.verdict, 'match');
    assert.equal(occ.observed, 3);
  });

  test('exact occupied count contradicts dashboard → mismatch (catches a wrong status column)', () => {
    const r = reconcileCrossFeed({
      feeds: { getRoomStatus: { rowCount: 5, rows: rooms(['vacant_clean', 'vacant_clean', 'vacant_clean', 'vacant_clean', 'vacant_clean']), rowsComplete: true } },
      dashboardCounters: { total_occupied_rooms: 4 },
    });
    assert.equal(r.signal, 'fail');
    const occ = r.checks.find((c) => c.counter === 'total_occupied_rooms')!;
    assert.equal(occ.mode, 'exact');
    assert.equal(occ.verdict, 'mismatch');
  });

  test('an incomplete sample (rowsComplete=false) does NOT exact-count — falls back to lower bound', () => {
    // 3 sampled rows of an 80-room feed: the predicate would undercount, so the
    // exact path must be skipped; lower bound (80 ≥ 40) passes.
    const r = reconcileCrossFeed({
      feeds: { getRoomStatus: { rowCount: 80, rows: rooms(['vacant_clean', 'vacant_clean', 'vacant_clean']), rowsComplete: false } },
      dashboardCounters: { total_occupied_rooms: 40 },
    });
    const occ = r.checks.find((c) => c.counter === 'total_occupied_rooms')!;
    assert.equal(occ.mode, 'lower_bound');
    assert.equal(occ.verdict, 'match');
  });
});

describe('cross-feed structural invariants', () => {
  test('getDashboardCounts is the SOURCE, never itself a witnessed row feed', () => {
    assert.equal(DASHBOARD_FEED, 'getDashboardCounts');
    assert.ok(!CROSS_FEED_CHECKS.some((c) => c.feed === 'getDashboardCounts'),
      'getDashboardCounts must never be a row feed in a cross-feed check (it is not a CORE reconcile target)');
  });
});
