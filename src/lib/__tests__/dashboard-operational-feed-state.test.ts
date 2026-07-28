import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  beginScopedFeed,
  emptyScopedFeed,
  failScopedFeed,
  publishScopedFeed,
  scopedFeedView,
} from '@/app/dashboard/_components/operational-feed-state';

type Row = { id: string };

const HOTEL_A = 'hotel-a';
const HOTEL_B = 'hotel-b';
const MONDAY = '2026-07-27';
const TUESDAY = '2026-07-28';

describe('Dashboard operational feed readiness', () => {
  test('a failed first read stays unknown instead of becoming a legitimate empty snapshot', () => {
    const failed = failScopedFeed(emptyScopedFeed<Row>(), HOTEL_A, MONDAY);

    assert.deepEqual(scopedFeedView(failed, HOTEL_A, MONDAY), {
      rows: [],
      hasSnapshot: false,
      error: true,
    });
  });

  test('a successful empty response is a terminal, legitimate zero', () => {
    const empty = publishScopedFeed<Row>(HOTEL_A, MONDAY, []);

    assert.deepEqual(scopedFeedView(empty, HOTEL_A, MONDAY), {
      rows: [],
      hasSnapshot: true,
      error: false,
    });
  });

  test('a later error retains last-good rows and remains stale throughout retry', () => {
    const live = publishScopedFeed<Row>(HOTEL_A, MONDAY, [{ id: 'room-101' }]);
    const stale = failScopedFeed(live, HOTEL_A, MONDAY);
    const retrying = beginScopedFeed(stale, HOTEL_A, MONDAY);

    assert.deepEqual(retrying, {
      propertyId: HOTEL_A,
      date: MONDAY,
      rows: [{ id: 'room-101' }],
      hasSnapshot: true,
      error: true,
    });

    const refreshed = publishScopedFeed<Row>(HOTEL_A, MONDAY, [{ id: 'room-102' }]);
    assert.deepEqual(scopedFeedView(refreshed, HOTEL_A, MONDAY), {
      rows: [{ id: 'room-102' }],
      hasSnapshot: true,
      error: false,
    });
  });

  test('retrying an initial failure returns to loading until a real snapshot lands', () => {
    const failed = failScopedFeed(emptyScopedFeed<Row>(), HOTEL_A, MONDAY);

    assert.deepEqual(beginScopedFeed(failed, HOTEL_A, MONDAY), {
      propertyId: HOTEL_A,
      date: MONDAY,
      rows: [],
      hasSnapshot: false,
      error: false,
    });
  });

  test('another hotel or day is synchronously masked before effect cleanup', () => {
    const hotelAMonday = publishScopedFeed<Row>(HOTEL_A, MONDAY, [{ id: 'private-a' }]);

    assert.deepEqual(scopedFeedView(hotelAMonday, HOTEL_B, MONDAY), {
      rows: [],
      hasSnapshot: false,
      error: false,
    });
    assert.deepEqual(scopedFeedView(hotelAMonday, HOTEL_A, TUESDAY), {
      rows: [],
      hasSnapshot: false,
      error: false,
    });
  });
});
