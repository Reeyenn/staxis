import assert from 'node:assert/strict';
import { describe, test, type TestContext } from 'node:test';

import type { RealtimeChannel } from '@supabase/supabase-js';

import { subscribeToDashboardByDate, type DashboardNumbers } from '@/lib/db/dashboard';
import { supabase } from '@/lib/db/_common';
import { subscribeToPlanSnapshot, type PlanSnapshot } from '@/lib/db/plan-snapshots';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

interface QueryResult<T> {
  data: T;
  error: unknown | null;
}

interface QueryBuilder<T> {
  select: (...columns: string[]) => QueryBuilder<T>;
  eq: (column: string, value: unknown) => QueryBuilder<T>;
  maybeSingle: () => Promise<QueryResult<T>>;
}

interface DatabaseSurface {
  rpc: (name: string, args: unknown) => Promise<QueryResult<unknown>>;
  from: (table: string) => QueryBuilder<unknown>;
  channel: (name: string) => RealtimeChannel;
  removeChannel: (channel: RealtimeChannel) => Promise<unknown>;
}

interface FakeChannel {
  emitChange: () => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function query<T>(result: Deferred<QueryResult<T>>): QueryBuilder<T> {
  const builder: QueryBuilder<T> = {
    select: () => builder,
    eq: () => builder,
    maybeSingle: () => result.promise,
  };
  return builder;
}

function installRealtime(context: TestContext): FakeChannel[] {
  const database = supabase as unknown as DatabaseSurface;
  const channels: FakeChannel[] = [];
  context.mock.method(database, 'channel', () => {
    let onChange: (() => void) | null = null;
    const channel = {
      state: 'joined',
      on: (...args: unknown[]) => {
        onChange = args[2] as () => void;
        return channel;
      },
      subscribe: () => channel,
      emitChange: () => { onChange?.(); },
    };
    channels.push(channel);
    return channel as unknown as RealtimeChannel;
  });
  context.mock.method(database, 'removeChannel', async () => 'ok');
  return channels;
}

async function flushPromises(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

const counts = (value: number) => ({
  checkouts: value,
  stayovers: value,
  vacant_clean: value,
  vacant_dirty: value,
  ooo: value,
  total_rooms: value,
  total_checkouts_today: value,
  in_house: value,
});

describe('today-derived subscription ordering', () => {
  test('a deferred initial dashboard read cannot overwrite a newer realtime read', async (context) => {
    const database = supabase as unknown as DatabaseSurface;
    const channels = installRealtime(context);
    const countReads = [
      deferred<QueryResult<unknown>>(),
      deferred<QueryResult<unknown>>(),
    ];
    const snapshotReads = [
      deferred<QueryResult<unknown>>(),
      deferred<QueryResult<unknown>>(),
    ];
    let countReadIndex = 0;
    let snapshotReadIndex = 0;
    context.mock.method(database, 'rpc', (name: string) => {
      assert.equal(name, 'today_property_counts_v1');
      return countReads[countReadIndex++].promise;
    });
    context.mock.method(database, 'from', (table: string) => {
      assert.equal(table, 'pms_in_house_snapshot');
      return query(snapshotReads[snapshotReadIndex++]) as QueryBuilder<unknown>;
    });

    const published: Array<DashboardNumbers | null> = [];
    const unsubscribe = subscribeToDashboardByDate(
      'property-1',
      '2026-07-28',
      (value) => published.push(value),
    );
    assert.equal(channels.length, 4);
    assert.equal(countReadIndex, 1);
    channels[0].emitChange();
    assert.equal(countReadIndex, 2);

    countReads[1].resolve({ data: [counts(22)], error: null });
    snapshotReads[1].resolve({
      data: {
        arrivals_remaining_today: 22,
        departures_remaining_today: 22,
        captured_at: null,
        has_error: false,
        last_error: null,
      },
      error: null,
    });
    await flushPromises();
    assert.equal(published.length, 1);
    assert.equal(published[0]?.inHouse, 22);

    countReads[0].resolve({ data: [counts(11)], error: null });
    snapshotReads[0].resolve({
      data: {
        arrivals_remaining_today: 11,
        departures_remaining_today: 11,
        captured_at: null,
        has_error: false,
        last_error: null,
      },
      error: null,
    });
    await flushPromises();
    assert.equal(published.length, 1, 'late initial result is discarded');
    assert.equal(published[0]?.inHouse, 22);
    unsubscribe();
  });

  test('a deferred initial plan build cannot overwrite a newer realtime build', async (context) => {
    const database = supabase as unknown as DatabaseSurface;
    const channels = installRealtime(context);
    const roomReads = [
      deferred<QueryResult<unknown>>(),
      deferred<QueryResult<unknown>>(),
    ];
    const countReads = [
      deferred<QueryResult<unknown>>(),
      deferred<QueryResult<unknown>>(),
    ];
    const propertyReads = [
      deferred<QueryResult<unknown>>(),
      deferred<QueryResult<unknown>>(),
    ];
    let roomReadIndex = 0;
    let countReadIndex = 0;
    let propertyReadIndex = 0;
    context.mock.method(database, 'rpc', (name: string) => {
      if (name === 'today_room_work_v1') return roomReads[roomReadIndex++].promise;
      assert.equal(name, 'today_property_counts_v1');
      return countReads[countReadIndex++].promise;
    });
    context.mock.method(database, 'from', (table: string) => {
      assert.equal(table, 'properties');
      return query(propertyReads[propertyReadIndex++]) as QueryBuilder<unknown>;
    });

    const published: Array<PlanSnapshot | null> = [];
    const unsubscribe = subscribeToPlanSnapshot(
      'user-1',
      'property-1',
      '2026-07-28',
      (value) => published.push(value),
    );
    assert.equal(channels.length, 4);
    assert.equal(roomReadIndex, 1);
    channels[0].emitChange();
    assert.equal(roomReadIndex, 2);

    roomReads[1].resolve({
      data: [{
        room_number: 'B-22',
        stay_type: 'C/O',
        housekeeper: 'New',
        stayover_day: null,
      }],
      error: null,
    });
    countReads[1].resolve({ data: [counts(22)], error: null });
    propertyReads[1].resolve({
      data: {
        checkout_minutes: 30,
        stayover_day1_minutes: 20,
        stayover_day2_minutes: 15,
        shift_minutes: 420,
      },
      error: null,
    });
    await flushPromises();
    assert.equal(published.length, 1);
    assert.equal(published[0]?.totalRooms, 22);
    assert.equal(published[0]?.rooms[0]?.number, 'B-22');

    roomReads[0].resolve({
      data: [{
        room_number: 'A-11',
        stay_type: 'C/O',
        housekeeper: 'Old',
        stayover_day: null,
      }],
      error: null,
    });
    countReads[0].resolve({ data: [counts(11)], error: null });
    propertyReads[0].resolve({
      data: {
        checkout_minutes: 30,
        stayover_day1_minutes: 20,
        stayover_day2_minutes: 15,
        shift_minutes: 420,
      },
      error: null,
    });
    await flushPromises();
    assert.equal(published.length, 1, 'late initial build is discarded');
    assert.equal(published[0]?.totalRooms, 22);
    assert.equal(published[0]?.rooms[0]?.number, 'B-22');
    unsubscribe();
  });

  test('a failed property-settings read cannot publish fallback cleaning times as success', async (context) => {
    const database = supabase as unknown as DatabaseSurface;
    installRealtime(context);
    context.mock.method(database, 'rpc', async (name: string) => {
      if (name === 'today_room_work_v1') {
        return { data: [], error: null };
      }
      assert.equal(name, 'today_property_counts_v1');
      return { data: [counts(0)], error: null };
    });
    context.mock.method(database, 'from', (table: string) => {
      assert.equal(table, 'properties');
      const failed = deferred<QueryResult<unknown>>();
      failed.resolve({ data: null, error: { message: 'property read failed' } });
      return query(failed) as QueryBuilder<unknown>;
    });

    const published: Array<PlanSnapshot | null> = [];
    const unsubscribe = subscribeToPlanSnapshot(
      'user-1',
      'property-1',
      '2026-07-28',
      (value) => published.push(value),
    );
    await flushPromises();

    assert.deepEqual(published, [null], 'a one-API settings failure must reach the terminal unavailable state');
    unsubscribe();
  });
});
