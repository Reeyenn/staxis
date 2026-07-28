import assert from 'node:assert/strict';
import { describe, test, type TestContext } from 'node:test';

import type { RealtimeChannel } from '@supabase/supabase-js';

import { subscribeTable, supabase } from '@/lib/db/_common';
import { subscribeToRooms } from '@/lib/db/rooms';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

interface RealtimeSurface {
  channel: (name: string) => RealtimeChannel;
  removeChannel: (channel: RealtimeChannel) => Promise<unknown>;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function installVisibleDocument(context: TestContext): EventTarget {
  const documentTarget = new EventTarget();
  Object.defineProperties(documentTarget, {
    hidden: { configurable: true, value: false },
    visibilityState: { configurable: true, value: 'visible' },
  });

  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: documentTarget,
  });
  context.after(() => {
    if (previous) Object.defineProperty(globalThis, 'document', previous);
    else Reflect.deleteProperty(globalThis, 'document');
  });
  return documentTarget;
}

function installRealtime(context: TestContext): void {
  const database = supabase as unknown as RealtimeSurface;
  context.mock.method(database, 'channel', () => {
    const channel = {
      state: 'joined',
      on: () => channel,
      subscribe: () => channel,
    };
    return channel as unknown as RealtimeChannel;
  });
  context.mock.method(database, 'removeChannel', async () => 'ok');
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe('Dashboard subscription request ordering', () => {
  test('a slow older table success cannot clear the newest request failure', async (context) => {
    const documentTarget = installVisibleDocument(context);
    installRealtime(context);
    context.mock.method(console, 'error', () => undefined);

    const older = deferred<Array<{ id: string }>>();
    const newer = deferred<Array<{ id: string }>>();
    const reads = [older, newer];
    let readIndex = 0;
    const published: string[][] = [];
    const errors: unknown[] = [];

    const unsubscribe = subscribeTable(
      'dashboard-ordering',
      'work_orders',
      'property_id=eq.hotel-a',
      () => reads[readIndex++].promise,
      (rows) => published.push(rows.map((row) => row.id)),
      undefined,
      undefined,
      (error) => errors.push(error),
    );
    assert.equal(readIndex, 1, 'initial request starts immediately');

    documentTarget.dispatchEvent(new Event('visibilitychange'));
    assert.equal(readIndex, 2, 'foreground recovery starts the newer request');

    newer.reject(new Error('newest request failed'));
    await flushPromises();
    assert.equal(errors.length, 1);
    assert.deepEqual(published, []);

    older.resolve([{ id: 'stale-row' }]);
    await flushPromises();
    assert.deepEqual(published, [], 'the late older success cannot clear the error verdict');

    unsubscribe();
  });

  test('a slow older room poll success cannot clear the newest poll failure', async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    context.after(() => context.mock.timers.reset());
    const documentTarget = installVisibleDocument(context);
    context.mock.method(console, 'error', () => undefined);

    const auth = supabase.auth as unknown as {
      getSession: () => Promise<{ data: { session: null }; error: null }>;
    };
    context.mock.method(auth, 'getSession', async () => ({
      data: { session: null },
      error: null,
    }));

    const older = deferred<Response>();
    const newer = deferred<Response>();
    const requests = [older, newer];
    let requestIndex = 0;
    context.mock.method(globalThis, 'fetch', () => requests[requestIndex++].promise);

    const published: string[][] = [];
    const errors: unknown[] = [];
    const unsubscribe = subscribeToRooms(
      'user-a',
      'hotel-a',
      '2026-07-27',
      (rows) => published.push(rows.map((row) => row.id)),
      (error) => errors.push(error),
    );
    await flushPromises();
    assert.equal(requestIndex, 1, 'initial room request reaches fetch');

    documentTarget.dispatchEvent(new Event('visibilitychange'));
    context.mock.timers.tick(300);
    await flushPromises();
    assert.equal(requestIndex, 2, 'foreground recovery starts the newer room request');

    newer.resolve(new Response('temporary outage', { status: 503 }));
    await flushPromises();
    assert.equal(errors.length, 1);
    assert.deepEqual(published, []);

    older.resolve(new Response(JSON.stringify({
      ok: true,
      data: [{ id: 'stale-room', propertyId: 'hotel-a', number: '101', status: 'dirty' }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    await flushPromises();
    assert.deepEqual(published, [], 'the late older room snapshot cannot clear the error verdict');

    unsubscribe();
  });
});
