/**
 * Tests for cua-service/src/schedule-reactivity-pinger.ts. Mirrors the
 * structure of rules-engine-pinger.test.ts and pins the same invariants:
 *
 *   1. Burst coalescing — many writes for one property collapse to ONE
 *      ping per debounce window.
 *   2. Fail-quiet — endpoint 5xx, network error, or thrown predicate
 *      MUST NOT raise into the CUA write path.
 *   3. Predicate selectivity — neutral statuses don't fire; cancel/
 *      no_show / checked_in / OOO / dirty / VIP do.
 *   4. Diff-signal — unchanged snapshot or reservation re-upserts don't
 *      re-arm a window.
 *   5. Cross-property isolation — each property gets its own bucket;
 *      burst on A doesn't suppress B.
 *
 * Pure-function tests — no Supabase, no real HTTP, no real timers.
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { ScheduleReactivityPinger } from '../schedule-reactivity-pinger.js';

const PROP_A = '00000000-0000-0000-0000-00000000000a';
const PROP_B = '00000000-0000-0000-0000-00000000000b';

class ManualTimers {
  private next = 1;
  private active = new Map<number, () => void>();
  setTimeout = (cb: () => void, _ms: number): number => {
    const id = this.next++;
    this.active.set(id, cb);
    return id;
  };
  clearTimeout = (id: number): void => {
    this.active.delete(id);
  };
  fireNext(): boolean {
    const first = this.active.keys().next();
    if (first.done) return false;
    const id = first.value as number;
    const cb = this.active.get(id)!;
    this.active.delete(id);
    cb();
    return true;
  }
  pendingCount(): number { return this.active.size; }
}

interface MockFetchCall { url: string; init?: RequestInit }
class MockFetch {
  calls: MockFetchCall[] = [];
  responder: (call: MockFetchCall) => Promise<Response> = async () =>
    new Response(null, { status: 200 });
  fn: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: String(input), init };
    this.calls.push(call);
    return this.responder(call);
  }) as typeof fetch;
  reset() {
    this.calls = [];
    this.responder = async () => new Response(null, { status: 200 });
  }
}

function makePinger(timers: ManualTimers, fetcher: MockFetch): ScheduleReactivityPinger {
  return new ScheduleReactivityPinger({
    baseUrl: 'https://staxis.test',
    cronSecret: 'test-secret',
    debounceMs: 10_000,
    timeoutMs: 5_000,
    fetchImpl: fetcher.fn,
    setTimeoutImpl: timers.setTimeout as never,
    clearTimeoutImpl: timers.clearTimeout as never,
  });
}

describe('ScheduleReactivityPinger — burst coalescing', () => {
  let timers: ManualTimers;
  let fetcher: MockFetch;
  let pinger: ScheduleReactivityPinger;

  beforeEach(() => {
    timers = new ManualTimers();
    fetcher = new MockFetch();
    pinger = makePinger(timers, fetcher);
  });

  test('collapses 50 cancel events into ONE ping', async () => {
    for (let i = 0; i < 50; i++) {
      pinger.notifyHighPriorityChange(PROP_A, 'pms_reservations', [
        { pms_reservation_id: `r-${i}`, status: 'cancelled' },
      ]);
    }
    assert.equal(timers.pendingCount(), 1);
    timers.fireNext();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(fetcher.calls.length, 1);
    assert.match(fetcher.calls[0].url, new RegExp(PROP_A));
  });

  test('PROP_A burst does not suppress PROP_B ping', async () => {
    pinger.notifyHighPriorityChange(PROP_A, 'pms_reservations', [
      { pms_reservation_id: 'r-a', status: 'cancelled' },
    ]);
    pinger.notifyHighPriorityChange(PROP_B, 'pms_reservations', [
      { pms_reservation_id: 'r-b', status: 'cancelled' },
    ]);
    assert.equal(timers.pendingCount(), 2);
  });

  test('post-fire arrival of new event arms a fresh window', async () => {
    pinger.notifyHighPriorityChange(PROP_A, 'pms_reservations', [
      { pms_reservation_id: 'r-a1', status: 'cancelled' },
    ]);
    timers.fireNext();
    await Promise.resolve();
    pinger.notifyHighPriorityChange(PROP_A, 'pms_reservations', [
      { pms_reservation_id: 'r-a2', status: 'cancelled' },
    ]);
    assert.equal(timers.pendingCount(), 1);
  });
});

describe('ScheduleReactivityPinger — predicate selectivity', () => {
  let timers: ManualTimers;
  let fetcher: MockFetch;
  let pinger: ScheduleReactivityPinger;

  beforeEach(() => {
    timers = new ManualTimers();
    fetcher = new MockFetch();
    pinger = makePinger(timers, fetcher);
  });

  test('reservations: occupied does not fire; cancelled does', () => {
    pinger.notifyHighPriorityChange(PROP_A, 'pms_reservations', [
      { pms_reservation_id: 'r1', status: 'occupied' },
    ]);
    assert.equal(timers.pendingCount(), 0);

    pinger.notifyHighPriorityChange(PROP_A, 'pms_reservations', [
      { pms_reservation_id: 'r2', status: 'cancelled' },
    ]);
    assert.equal(timers.pendingCount(), 1);
  });

  test('reservations: checked_in fires (arrival_surge)', () => {
    pinger.notifyHighPriorityChange(PROP_A, 'pms_reservations', [
      { pms_reservation_id: 'r3', status: 'checked_in' },
    ]);
    assert.equal(timers.pendingCount(), 1);
  });

  test('reservations: VIP note fires even when status neutral', () => {
    pinger.notifyHighPriorityChange(PROP_A, 'pms_reservations', [
      { pms_reservation_id: 'r4', status: 'reserved', notes: 'VIP guest' },
    ]);
    assert.equal(timers.pendingCount(), 1);
  });

  test('room_status_log: out_of_order fires; clean does not', () => {
    pinger.notifyHighPriorityChange(PROP_A, 'pms_room_status_log', [
      { status: 'clean' },
    ]);
    assert.equal(timers.pendingCount(), 0);

    pinger.notifyHighPriorityChange(PROP_A, 'pms_room_status_log', [
      { status: 'out_of_order' },
    ]);
    assert.equal(timers.pendingCount(), 1);
  });

  test('in_house_snapshot: identical counts do NOT re-fire', () => {
    pinger.notifyHighPriorityChange(PROP_A, 'pms_in_house_snapshot', [
      { arrivals_remaining_today: 5, departures_remaining_today: 4 },
    ]);
    assert.equal(timers.pendingCount(), 1);
    timers.fireNext();

    // Same counts → diff signal returns false → no new window.
    pinger.notifyHighPriorityChange(PROP_A, 'pms_in_house_snapshot', [
      { arrivals_remaining_today: 5, departures_remaining_today: 4 },
    ]);
    assert.equal(timers.pendingCount(), 0);

    // Changed count → new window.
    pinger.notifyHighPriorityChange(PROP_A, 'pms_in_house_snapshot', [
      { arrivals_remaining_today: 7, departures_remaining_today: 4 },
    ]);
    assert.equal(timers.pendingCount(), 1);
  });

  test('reservations: same status re-upsert does NOT re-fire', () => {
    pinger.notifyHighPriorityChange(PROP_A, 'pms_reservations', [
      { pms_reservation_id: 'r5', status: 'cancelled' },
    ]);
    assert.equal(timers.pendingCount(), 1);
    timers.fireNext();

    pinger.notifyHighPriorityChange(PROP_A, 'pms_reservations', [
      { pms_reservation_id: 'r5', status: 'cancelled' },
    ]);
    assert.equal(timers.pendingCount(), 0);
  });

  test('unknown table: no ping', () => {
    pinger.notifyHighPriorityChange(PROP_A, 'rooms', [{ status: 'dirty' }]);
    assert.equal(timers.pendingCount(), 0);
  });
});

describe('ScheduleReactivityPinger — fail quiet', () => {
  test('5xx response does not throw', async () => {
    const timers = new ManualTimers();
    const fetcher = new MockFetch();
    fetcher.responder = async () => new Response(null, { status: 503 });
    const pinger = makePinger(timers, fetcher);

    pinger.notifyHighPriorityChange(PROP_A, 'pms_reservations', [
      { pms_reservation_id: 'r-x', status: 'cancelled' },
    ]);
    timers.fireNext();
    await Promise.resolve();
    await Promise.resolve();
    // No assertion needed beyond "didn't throw" — test runner catches.
    assert.equal(fetcher.calls.length, 1);
  });

  test('fetch throw does not throw', async () => {
    const timers = new ManualTimers();
    const fetcher = new MockFetch();
    fetcher.responder = async () => { throw new Error('network'); };
    const pinger = makePinger(timers, fetcher);

    pinger.notifyHighPriorityChange(PROP_A, 'pms_reservations', [
      { pms_reservation_id: 'r-x', status: 'cancelled' },
    ]);
    timers.fireNext();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(fetcher.calls.length, 1);
  });

  test('DISABLED when baseUrl/cronSecret unset — no timers ever arm', () => {
    const timers = new ManualTimers();
    const fetcher = new MockFetch();
    const pinger = new ScheduleReactivityPinger({
      baseUrl: null,
      cronSecret: null,
      setTimeoutImpl: timers.setTimeout as never,
      clearTimeoutImpl: timers.clearTimeout as never,
      fetchImpl: fetcher.fn,
    });
    pinger.notifyHighPriorityChange(PROP_A, 'pms_reservations', [
      { pms_reservation_id: 'r1', status: 'cancelled' },
    ]);
    assert.equal(timers.pendingCount(), 0);
    assert.equal(fetcher.calls.length, 0);
  });
});

describe('ScheduleReactivityPinger — fire body', () => {
  test('POSTs with bearer + JSON {kind} body', async () => {
    const timers = new ManualTimers();
    const fetcher = new MockFetch();
    const pinger = makePinger(timers, fetcher);

    pinger.notifyHighPriorityChange(PROP_A, 'pms_reservations', [
      { pms_reservation_id: 'r-x', status: 'cancelled' },
    ]);
    timers.fireNext();
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(fetcher.calls.length, 1);
    const call = fetcher.calls[0];
    assert.match(call.url, /\/api\/internal\/pms-changed\?propertyId=/);
    const headers = call.init?.headers as Record<string, string> | undefined;
    assert.equal(headers?.Authorization, 'Bearer test-secret');
    assert.equal(headers?.['Content-Type'], 'application/json');
    const body = JSON.parse((call.init?.body as string) ?? '{}');
    assert.equal(body.kind, 'cancellation_wave');
  });
});
