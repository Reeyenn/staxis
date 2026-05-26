/**
 * Tests for cua-service/src/rules-engine-pinger.ts.
 *
 * Pins the three invariants that make the pinger safe to wire into
 * every PMS write:
 *
 *   1. Idempotency under burst — a flood of high-priority writes for one
 *      property must collapse to exactly ONE network call per debounce
 *      window. (Without this, polling at ~30s × N rooms × M properties
 *      DDOSes /api/cron/run-rules-engine and racks up Vercel cost.)
 *
 *   2. Fail-quiet under endpoint outage — the pinger MUST NOT throw,
 *      raise, or otherwise interfere with the CUA write path when the
 *      staxis web app is down, slow, or returning 5xx. The 5-min cron
 *      is the safety net; we just want the fast path.
 *
 *   3. Predicate selectivity — low-signal rows (cancelled reservation
 *      with no VIP marker, status='occupied') must NOT trigger pings.
 *      Only the rows the user listed in the spec do.
 *
 * Pure-function tests — no Supabase, no real HTTP, no real timers.
 * Time is controlled via injected setTimeout/clearTimeout stubs.
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { RulesEnginePinger } from '../rules-engine-pinger.js';

const PROP_A = '00000000-0000-0000-0000-00000000000a';
const PROP_B = '00000000-0000-0000-0000-00000000000b';

/** A fake timer source: every setTimeout call is captured, never auto-fires.
 *  Tests advance time by manually invoking captured callbacks. */
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
  /** Fire whichever callback was scheduled first (FIFO). Returns false if none. */
  fireNext(): boolean {
    const first = this.active.keys().next();
    if (first.done) return false;
    const id = first.value as number;
    const cb = this.active.get(id)!;
    this.active.delete(id);
    cb();
    return true;
  }
  pendingCount(): number {
    return this.active.size;
  }
}

interface MockFetchCall {
  url: string;
  init?: RequestInit;
}

/** A fake fetch that records every call and lets the test pick the response.
 *  Default behavior: 200 OK. */
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

function newPinger(opts: {
  timers: ManualTimers;
  mockFetch: MockFetch;
  baseUrl?: string | null;
  cronSecret?: string | null;
  debounceMs?: number;
  timeoutMs?: number;
}): RulesEnginePinger {
  // Use `in` (not `??`) so explicit `null` propagates — tests for the
  // "disabled when env unset" path pass `baseUrl: null` to disable.
  const baseUrl = 'baseUrl' in opts ? opts.baseUrl : 'https://hotelops-ai.test';
  const cronSecret = 'cronSecret' in opts ? opts.cronSecret : 'test-cron-secret-1234567890';
  return new RulesEnginePinger({
    baseUrl,
    cronSecret,
    debounceMs: opts.debounceMs ?? 10_000,
    timeoutMs: opts.timeoutMs ?? 5_000,
    fetchImpl: opts.mockFetch.fn,
    setTimeoutImpl: opts.timers.setTimeout as unknown as typeof setTimeout,
    clearTimeoutImpl: opts.timers.clearTimeout as unknown as typeof clearTimeout,
  });
}

describe('rules-engine-pinger — predicate selectivity', () => {
  let timers: ManualTimers;
  let mockFetch: MockFetch;
  let pinger: RulesEnginePinger;

  beforeEach(() => {
    timers = new ManualTimers();
    mockFetch = new MockFetch();
    pinger = newPinger({ timers, mockFetch });
  });

  test('pms_room_status_log: vacant_dirty fires', () => {
    pinger.notifyHighPriorityChange(PROP_A, 'pms_room_status_log', [
      { status: 'vacant_dirty', room_number: '305' },
    ]);
    assert.equal(pinger.isPending(PROP_A), true);
  });

  test('pms_room_status_log: out_of_order fires', () => {
    pinger.notifyHighPriorityChange(PROP_A, 'pms_room_status_log', [
      { status: 'out_of_order', room_number: '305' },
    ]);
    assert.equal(pinger.isPending(PROP_A), true);
  });

  test('pms_room_status_log: inspected fires', () => {
    pinger.notifyHighPriorityChange(PROP_A, 'pms_room_status_log', [
      { status: 'inspected', room_number: '305' },
    ]);
    assert.equal(pinger.isPending(PROP_A), true);
  });

  test('pms_room_status_log: occupied does NOT fire', () => {
    pinger.notifyHighPriorityChange(PROP_A, 'pms_room_status_log', [
      { status: 'occupied', room_number: '305' },
    ]);
    assert.equal(pinger.isPending(PROP_A), false);
  });

  test('pms_reservations: checked_in fires', () => {
    pinger.notifyHighPriorityChange(PROP_A, 'pms_reservations', [
      { status: 'checked_in', pms_reservation_id: 'r1' },
    ]);
    assert.equal(pinger.isPending(PROP_A), true);
  });

  test('pms_reservations: checked_out fires', () => {
    pinger.notifyHighPriorityChange(PROP_A, 'pms_reservations', [
      { status: 'checked_out', pms_reservation_id: 'r1' },
    ]);
    assert.equal(pinger.isPending(PROP_A), true);
  });

  test('pms_reservations: cancelled fires (engine must retract any task)', () => {
    pinger.notifyHighPriorityChange(PROP_A, 'pms_reservations', [
      { status: 'cancelled', pms_reservation_id: 'r1' },
    ]);
    assert.equal(pinger.isPending(PROP_A), true);
  });

  test('pms_reservations: VIP keyword in notes fires', () => {
    pinger.notifyHighPriorityChange(PROP_A, 'pms_reservations', [
      { status: 'booked', notes: 'VIP Platinum, Spanish-speaking' },
    ]);
    assert.equal(pinger.isPending(PROP_A), true);
  });

  test('pms_reservations: plain booked with no VIP/status flip does NOT fire', () => {
    // This is the common case — every CUA poll re-upserts reservations.
    // Without this filter we'd ping every poll cycle.
    pinger.notifyHighPriorityChange(PROP_A, 'pms_reservations', [
      { status: 'booked', notes: 'regular guest', pms_reservation_id: 'r1' },
    ]);
    assert.equal(pinger.isPending(PROP_A), false);
  });

  test('pms_in_house_snapshot: any write fires (debouncer collapses)', () => {
    pinger.notifyHighPriorityChange(PROP_A, 'pms_in_house_snapshot', [
      { total_occupied_rooms: 42 },
    ]);
    assert.equal(pinger.isPending(PROP_A), true);
  });

  test('unwatched table: never fires', () => {
    pinger.notifyHighPriorityChange(PROP_A, 'pms_revenue_daily', [
      { date: '2026-05-25', rooms_revenue_cents: 12345 },
    ]);
    assert.equal(pinger.isPending(PROP_A), false);
  });

  test('mixed batch: any matching row in the array is enough', () => {
    pinger.notifyHighPriorityChange(PROP_A, 'pms_room_status_log', [
      { status: 'occupied' }, // no
      { status: 'occupied_clean' }, // no
      { status: 'vacant_dirty' }, // yes — should arm
    ]);
    assert.equal(pinger.isPending(PROP_A), true);
  });

  test('empty rows: no fire', () => {
    pinger.notifyHighPriorityChange(PROP_A, 'pms_room_status_log', []);
    assert.equal(pinger.isPending(PROP_A), false);
  });

  test('missing propertyId: no fire', () => {
    pinger.notifyHighPriorityChange('', 'pms_room_status_log', [{ status: 'vacant_dirty' }]);
    assert.equal(pinger.pendingCount(), 0);
  });
});

describe('rules-engine-pinger — debouncer correctness under burst', () => {
  let timers: ManualTimers;
  let mockFetch: MockFetch;
  let pinger: RulesEnginePinger;

  beforeEach(() => {
    timers = new ManualTimers();
    mockFetch = new MockFetch();
    pinger = newPinger({ timers, mockFetch });
  });

  test('100 rapid events for one property → exactly one timer scheduled', () => {
    for (let i = 0; i < 100; i++) {
      pinger.notifyHighPriorityChange(PROP_A, 'pms_room_status_log', [
        { status: 'vacant_dirty', room_number: String(300 + (i % 10)) },
      ]);
    }
    assert.equal(timers.pendingCount(), 1);
    assert.equal(pinger.isPending(PROP_A), true);
  });

  test('100 rapid events → one fetch after the timer fires', async () => {
    for (let i = 0; i < 100; i++) {
      pinger.notifyHighPriorityChange(PROP_A, 'pms_room_status_log', [
        { status: 'vacant_dirty' },
      ]);
    }
    timers.fireNext();
    // setImmediate equivalent so async firePing resolves.
    await new Promise((r) => setImmediate(r));
    assert.equal(mockFetch.calls.length, 1);
    assert.match(mockFetch.calls[0].url, /\/api\/cron\/run-rules-engine\?propertyId=/);
    assert.match(mockFetch.calls[0].url, new RegExp(PROP_A));
  });

  test('two properties: independent timers, two separate fetches', async () => {
    pinger.notifyHighPriorityChange(PROP_A, 'pms_room_status_log', [{ status: 'vacant_dirty' }]);
    pinger.notifyHighPriorityChange(PROP_B, 'pms_room_status_log', [{ status: 'vacant_dirty' }]);
    assert.equal(timers.pendingCount(), 2);
    assert.equal(pinger.isPending(PROP_A), true);
    assert.equal(pinger.isPending(PROP_B), true);

    timers.fireNext();
    timers.fireNext();
    await new Promise((r) => setImmediate(r));

    assert.equal(mockFetch.calls.length, 2);
    const urls = mockFetch.calls.map((c) => c.url).sort();
    assert.match(urls[0], new RegExp(PROP_A));
    assert.match(urls[1], new RegExp(PROP_B));
  });

  test('after a property fires, a NEW event arms a fresh window (not coalesced into the previous fire)', async () => {
    pinger.notifyHighPriorityChange(PROP_A, 'pms_room_status_log', [{ status: 'vacant_dirty' }]);
    assert.equal(pinger.isPending(PROP_A), true);
    timers.fireNext();
    await new Promise((r) => setImmediate(r));

    // After fire, the slot should be clear.
    assert.equal(pinger.isPending(PROP_A), false);
    assert.equal(mockFetch.calls.length, 1);

    // A new event after fire arms a new window.
    pinger.notifyHighPriorityChange(PROP_A, 'pms_room_status_log', [{ status: 'vacant_dirty' }]);
    assert.equal(pinger.isPending(PROP_A), true);

    timers.fireNext();
    await new Promise((r) => setImmediate(r));
    assert.equal(mockFetch.calls.length, 2);
  });

  test('events that arrive WHILE a fetch is in flight start a fresh window', async () => {
    // Slow responder so we can fire-then-notify before resolve.
    let resolveFetch!: (r: Response) => void;
    const pending = new Promise<Response>((r) => { resolveFetch = r; });
    mockFetch.responder = () => pending;

    pinger.notifyHighPriorityChange(PROP_A, 'pms_room_status_log', [{ status: 'vacant_dirty' }]);
    timers.fireNext();
    // fetch is now in flight but unresolved. The slot was cleared before fetch.
    assert.equal(pinger.isPending(PROP_A), false);

    // A new event during the in-flight window should arm a NEW timer.
    pinger.notifyHighPriorityChange(PROP_A, 'pms_room_status_log', [{ status: 'vacant_dirty' }]);
    assert.equal(pinger.isPending(PROP_A), true);

    // Resolve the in-flight fetch; the new timer is still pending.
    resolveFetch(new Response(null, { status: 200 }));
    await new Promise((r) => setImmediate(r));
    assert.equal(pinger.isPending(PROP_A), true);
  });
});

describe('rules-engine-pinger — fail-quiet when endpoint is down', () => {
  let timers: ManualTimers;
  let mockFetch: MockFetch;
  let pinger: RulesEnginePinger;

  beforeEach(() => {
    timers = new ManualTimers();
    mockFetch = new MockFetch();
    pinger = newPinger({ timers, mockFetch });
  });

  test('fetch throws → no exception propagates to caller', async () => {
    mockFetch.responder = async () => {
      throw new Error('ECONNREFUSED');
    };
    pinger.notifyHighPriorityChange(PROP_A, 'pms_room_status_log', [{ status: 'vacant_dirty' }]);
    // notifyHighPriorityChange itself returned undefined — never throws.
    assert.equal(pinger.isPending(PROP_A), true);
    // Fire the timer and let the fetch reject — pinger swallows.
    timers.fireNext();
    await new Promise((r) => setImmediate(r));
    // No uncaught error. The slot is now clear.
    assert.equal(pinger.isPending(PROP_A), false);
  });

  test('fetch returns 500 → no exception, no retry storm', async () => {
    mockFetch.responder = async () => new Response('engine down', { status: 500 });
    pinger.notifyHighPriorityChange(PROP_A, 'pms_room_status_log', [{ status: 'vacant_dirty' }]);
    timers.fireNext();
    await new Promise((r) => setImmediate(r));
    assert.equal(mockFetch.calls.length, 1);
    // No new timers armed automatically — fail-quiet, no retry.
    assert.equal(timers.pendingCount(), 0);
  });

  test('fetch returns 401 → swallowed, no exception', async () => {
    mockFetch.responder = async () => new Response('bad bearer', { status: 401 });
    pinger.notifyHighPriorityChange(PROP_A, 'pms_room_status_log', [{ status: 'vacant_dirty' }]);
    timers.fireNext();
    await new Promise((r) => setImmediate(r));
    // Pinger fired but got 401. Doesn't crash; next event will retry on its own window.
    assert.equal(mockFetch.calls.length, 1);
  });
});

describe('rules-engine-pinger — disabled when env unset', () => {
  let timers: ManualTimers;
  let mockFetch: MockFetch;

  beforeEach(() => {
    timers = new ManualTimers();
    mockFetch = new MockFetch();
  });

  test('no baseUrl → no fire, no timer', () => {
    const pinger = newPinger({ timers, mockFetch, baseUrl: null });
    pinger.notifyHighPriorityChange(PROP_A, 'pms_room_status_log', [{ status: 'vacant_dirty' }]);
    assert.equal(timers.pendingCount(), 0);
    assert.equal(pinger.pendingCount(), 0);
  });

  test('no cronSecret → no fire, no timer', () => {
    const pinger = newPinger({ timers, mockFetch, cronSecret: null });
    pinger.notifyHighPriorityChange(PROP_A, 'pms_room_status_log', [{ status: 'vacant_dirty' }]);
    assert.equal(timers.pendingCount(), 0);
    assert.equal(pinger.pendingCount(), 0);
  });
});

describe('rules-engine-pinger — bearer + URL shape', () => {
  let timers: ManualTimers;
  let mockFetch: MockFetch;
  let pinger: RulesEnginePinger;

  beforeEach(() => {
    timers = new ManualTimers();
    mockFetch = new MockFetch();
    pinger = newPinger({ timers, mockFetch, baseUrl: 'https://hotelops-ai.test/' /* trailing slash */ });
  });

  test('POST with Authorization: Bearer header', async () => {
    pinger.notifyHighPriorityChange(PROP_A, 'pms_room_status_log', [{ status: 'vacant_dirty' }]);
    timers.fireNext();
    await new Promise((r) => setImmediate(r));
    assert.equal(mockFetch.calls.length, 1);
    const init = mockFetch.calls[0].init!;
    assert.equal(init.method, 'POST');
    const headers = init.headers as Record<string, string>;
    assert.equal(headers.Authorization, 'Bearer test-cron-secret-1234567890');
  });

  test('URL strips trailing slash from baseUrl and URL-encodes the propertyId', async () => {
    pinger.notifyHighPriorityChange(PROP_A, 'pms_room_status_log', [{ status: 'vacant_dirty' }]);
    timers.fireNext();
    await new Promise((r) => setImmediate(r));
    const url = mockFetch.calls[0].url;
    assert.equal(
      url,
      `https://hotelops-ai.test/api/cron/run-rules-engine?propertyId=${PROP_A}`,
    );
  });
});

describe('rules-engine-pinger — predicate input safety', () => {
  let timers: ManualTimers;
  let mockFetch: MockFetch;
  let pinger: RulesEnginePinger;

  beforeEach(() => {
    timers = new ManualTimers();
    mockFetch = new MockFetch();
    pinger = newPinger({ timers, mockFetch });
  });

  test('malformed row (null fields) does not throw or fire', () => {
    pinger.notifyHighPriorityChange(PROP_A, 'pms_room_status_log', [
      { status: null, room_number: undefined } as Record<string, unknown>,
    ]);
    assert.equal(pinger.isPending(PROP_A), false);
  });

  test('row with a non-string status does not falsely match VIP keyword', () => {
    pinger.notifyHighPriorityChange(PROP_A, 'pms_reservations', [
      { status: 42, notes: { not: 'a string' } } as unknown as Record<string, unknown>,
    ]);
    assert.equal(pinger.isPending(PROP_A), false);
  });
});
