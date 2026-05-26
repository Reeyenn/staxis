/**
 * Offline-queue replay tests.
 *
 * The IndexedDB layer is browser-only so we mock indexedDB with the
 * 'fake-indexeddb' module's package, which ships an in-memory shim
 * compatible with the W3C interface. node:test gives us deterministic
 * iteration over the queue, plus we inject `fetchImpl` to simulate
 * server responses without spinning up a real HTTP stack.
 */
import { test, describe, before, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';

// Mock indexedDB before importing the queue (it captures `indexedDB` at
// module load time on the `globalThis`).
import 'fake-indexeddb/auto';

import {
  enqueueAction,
  drainQueue,
  getQueueLength,
  getQueueItems,
  clearQueue,
  clearFailures,
} from '../../lib/offline-sync/queue';

// Helper: a fetchImpl that records every call and returns a fixed status.
function makeFakeFetch(plan: Array<{ status: number; body?: unknown; throwError?: boolean }>) {
  const calls: Array<{ url: string; body: unknown }> = [];
  let i = 0;
  const fn: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    const body = init?.body ? JSON.parse(init.body as string) : null;
    calls.push({ url, body });
    const step = plan[i] ?? { status: 200, body: { ok: true } };
    i += 1;
    if (step.throwError) {
      throw new Error('network error');
    }
    return new Response(JSON.stringify(step.body ?? {}), { status: step.status });
  };
  return { fn, calls };
}

describe('offline action queue', () => {
  before(() => {
    if (typeof window === 'undefined') {
      // node:test runs in a node context — fake-indexeddb sets up
      // globalThis.indexedDB but the queue helper also checks `window`.
      // Stub a minimal `window` so isBrowser() returns true.
      (globalThis as { window?: object }).window = globalThis;
    }
  });

  beforeEach(async () => {
    await clearQueue();
  });

  test('enqueueAction persists with a stable id + actionId', async () => {
    const action = await enqueueAction({
      endpoint: '/api/housekeeper/start-clean',
      body: { pid: 'p', staffId: 's', roomId: 'r' },
      label: 'Start room',
    });
    assert.ok(action.id, 'id minted');
    assert.equal((action.body as { actionId?: string }).actionId, action.id);
    assert.equal(await getQueueLength(), 1);
  });

  test('drainQueue replays queued actions and removes on 200', async () => {
    await enqueueAction({
      endpoint: '/api/housekeeper/add-note',
      body: { pid: 'p', staffId: 's', roomId: 'r', noteText: 'x' },
      label: 'note',
    });
    const { fn, calls } = makeFakeFetch([{ status: 200 }]);
    const result = await drainQueue({ fetchImpl: fn });
    assert.equal(result.total, 1);
    assert.equal(result.done, 1);
    assert.equal(calls.length, 1);
    assert.equal(await getQueueLength(), 0);
  });

  test('drainQueue marks 4xx as permanent failure (not retried)', async () => {
    await enqueueAction({
      endpoint: '/api/housekeeper/mark-for-inspection',
      body: { pid: 'p', staffId: 's', roomId: 'r' },
      label: 'inspection',
    });
    const { fn, calls } = makeFakeFetch([{ status: 400, body: { ok: false, error: 'bad request' } }]);
    const r1 = await drainQueue({ fetchImpl: fn });
    assert.equal(r1.failed, 1, 'failure recorded');
    assert.equal(calls.length, 1);
    const items = await getQueueItems();
    assert.equal(items.length, 1);
    assert.equal(items[0].permanentFailure, true);
    assert.match(items[0].lastError ?? '', /http 400/);

    // Subsequent drain should skip the permanent failure (no additional
    // fetch calls).
    const { fn: fn2, calls: calls2 } = makeFakeFetch([{ status: 200 }]);
    const r2 = await drainQueue({ fetchImpl: fn2 });
    assert.equal(r2.total, 0, 'permanent failures excluded from drain');
    assert.equal(calls2.length, 0);
  });

  test('drainQueue stops on network error so we do not burn retries', async () => {
    await enqueueAction({ endpoint: '/api/a', body: {}, label: 'a' });
    await enqueueAction({ endpoint: '/api/b', body: {}, label: 'b' });
    const { fn, calls } = makeFakeFetch([
      { status: 0, throwError: true },
      { status: 200 },
    ]);
    const r = await drainQueue({ fetchImpl: fn });
    assert.equal(calls.length, 1, 'second item not attempted after network failure');
    assert.equal(r.done, 0);
    // The first item is now bumped to attempts=1 but still in queue.
    const items = await getQueueItems();
    assert.equal(items.length, 2);
  });

  test('clearFailures drops permanent failures only', async () => {
    await enqueueAction({ endpoint: '/api/x', body: {}, label: 'x' });
    await enqueueAction({ endpoint: '/api/y', body: {}, label: 'y' });
    // 4xx the first one, leave the second pending.
    const { fn } = makeFakeFetch([
      { status: 422 },
      { status: 0, throwError: true },
    ]);
    await drainQueue({ fetchImpl: fn });
    const items = await getQueueItems();
    assert.equal(items.length, 2);
    const cleared = await clearFailures();
    assert.equal(cleared, 1);
    assert.equal(await getQueueLength(), 1);
  });

  test('drainQueue treats 5xx as transient (no permanent failure on first try)', async () => {
    await enqueueAction({ endpoint: '/api/x', body: {}, label: 'x' });
    const { fn } = makeFakeFetch([{ status: 503 }]);
    await drainQueue({ fetchImpl: fn });
    const items = await getQueueItems();
    assert.equal(items.length, 1);
    assert.equal(items[0].permanentFailure, false);
    assert.equal(items[0].attempts, 1);
  });

  test('drainQueue marks permanent failure after maxAttempts on 5xx', async () => {
    await enqueueAction({ endpoint: '/api/x', body: {}, label: 'x' });
    for (let i = 0; i < 5; i += 1) {
      const { fn } = makeFakeFetch([{ status: 503 }]);
      await drainQueue({ fetchImpl: fn, maxAttempts: 3 });
    }
    const items = await getQueueItems();
    assert.equal(items.length, 1);
    assert.equal(items[0].permanentFailure, true);
    assert.ok(items[0].attempts >= 3);
  });
});
