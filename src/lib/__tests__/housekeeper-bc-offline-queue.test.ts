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
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

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
  generateOfflineActionId,
} from '../../lib/offline-sync/queue';

// Helper: a fetchImpl that records every call and returns a fixed status.
function makeFakeFetch(plan: Array<{
  status: number;
  body?: unknown;
  headers?: HeadersInit;
  throwError?: boolean;
}>) {
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
    return new Response(JSON.stringify(step.body ?? {}), {
      status: step.status,
      headers: step.headers,
    });
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

  test('action ID generator returns UUIDs with and without native randomUUID', () => {
    const uuidShape = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    assert.match(generateOfflineActionId(), uuidShape);
    assert.match(generateOfflineActionId(null), uuidShape, 'fallback must also mint a stable UUID');
  });

  test('online-to-offline fallback reuses the actionId from the attempted request', () => {
    // The full test command resolves React's `react-server` condition, so this
    // client hook cannot be rendered in this node:test process. Keep a focused
    // contract check here beside the behavioral IndexedDB replay tests: the
    // network-error branch must pass the already-sent actionId into enqueueAction.
    const hookPath = fileURLToPath(new URL('../offline-sync/use-offline-sync.ts', import.meta.url));
    const source = readFileSync(hookPath, 'utf8');
    assert.match(
      source,
      /enqueueAction\(\{\s*endpoint,\s*body,\s*label,\s*id:\s*actionId\s*\}\)/,
    );
    assert.match(source, /const actionId = generateOfflineActionId\(\)/);
    assert.match(source, /JSON\.stringify\(\{ \.\.\.body, actionId \}\)/);
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

  test('drainQueue keeps 429 retryable and succeeds on a later drain', async () => {
    await enqueueAction({ endpoint: '/api/rate-limited', body: {}, label: 'retry me' });

    const { fn: limitedFetch, calls: limitedCalls } = makeFakeFetch([{
      status: 429,
      headers: { 'Retry-After': '1' },
    }]);
    const limited = await drainQueue({ fetchImpl: limitedFetch, maxAttempts: 1 });
    assert.equal(limitedCalls.length, 1);
    assert.equal(limited.done, 0);
    assert.equal(limited.failed, 0, 'rate limiting is not a permanent failure');
    assert.equal(limited.retryAfterMs, 1000);

    const after429 = await getQueueItems();
    assert.equal(after429.length, 1);
    assert.equal(after429[0].attempts, 1);
    assert.equal(after429[0].permanentFailure, false, '429 remains retryable even at maxAttempts');
    assert.equal(after429[0].lastError, 'http 429');

    const { fn: successFetch, calls: successCalls } = makeFakeFetch([{ status: 200 }]);
    const retried = await drainQueue({ fetchImpl: successFetch, maxAttempts: 1 });
    assert.equal(successCalls.length, 1);
    assert.equal(retried.done, 1);
    assert.equal(await getQueueLength(), 0);
  });

  test('503 with Retry-After stays retryable and requests a scheduled drain', async () => {
    await enqueueAction({ endpoint: '/api/pending-claim', body: {}, label: 'pending' });
    const { fn } = makeFakeFetch([{
      status: 503,
      headers: { 'Retry-After': '1' },
    }]);

    const result = await drainQueue({ fetchImpl: fn, maxAttempts: 1 });
    const [item] = await getQueueItems();
    assert.equal(item.permanentFailure, false);
    assert.equal(item.attempts, 1);
    assert.equal(result.failed, 0);
    assert.equal(result.pending, 1);
    assert.equal(result.retryAfterMs, 1000);
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
