/**
 * Tests for the pure part of useLiveQuery — toCleanup, which decides
 * whether a subscribe factory's return value is a real unsubscribe
 * function (→ becomes the effect cleanup) or a "not ready" sentinel
 * (null / undefined / false / void → no subscription, no cleanup).
 *
 * The hook itself is a single useEffect(() => toCleanup(factory()), deps)
 * and can't run under the node:test runner (react-server condition has no
 * useEffect); all decision logic is in toCleanup, pinned here.
 *
 * NOTE: this file imports use-live-query.ts directly — safe because the
 * module only *references* React's useEffect (undefined binding under
 * react-server) without calling it at load time. If this import ever
 * starts crashing, split toCleanup into a core file like scope-core.ts.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { toCleanup, useLiveQuery, type SubscribeFactoryResult } from '@/lib/hooks/use-live-query';

describe('toCleanup', () => {
  test('passes an unsubscribe function through unchanged', () => {
    let calls = 0;
    const unsub = () => { calls += 1; };
    const cleanup = toCleanup(unsub);
    assert.equal(cleanup, unsub);
    cleanup!();
    assert.equal(calls, 1);
  });

  test('null → undefined (not ready: nothing to clean up)', () => {
    assert.equal(toCleanup(null), undefined);
  });

  test('undefined → undefined', () => {
    assert.equal(toCleanup(undefined), undefined);
  });

  test('false → undefined (the terse `ready && subscribe(...)` guard form)', () => {
    assert.equal(toCleanup(false), undefined);
  });

  test('void factory (guard clause returning nothing) → undefined', () => {
    const factory = (ready: boolean): SubscribeFactoryResult => {
      if (!ready) return;
      return () => {};
    };
    assert.equal(toCleanup(factory(false)), undefined);
    assert.equal(typeof toCleanup(factory(true)), 'function');
  });

  test('guarded factory sequence: not-ready renders subscribe nothing, ready subscribes once', () => {
    // Simulates the deps-change lifecycle a consumer sees:
    // ready=false → no subscription; ready flips true → one subscription;
    // cleanup runs → unsubscribed.
    let subscribed = 0;
    let unsubscribed = 0;
    const subscribeToThing = (): (() => void) => {
      subscribed += 1;
      return () => { unsubscribed += 1; };
    };

    const factoryFor = (ready: boolean) => () => (ready ? subscribeToThing() : null);

    // First "render": not ready.
    const cleanup1 = toCleanup(factoryFor(false)());
    assert.equal(cleanup1, undefined);
    assert.equal(subscribed, 0);

    // Deps change: ready.
    const cleanup2 = toCleanup(factoryFor(true)());
    assert.equal(subscribed, 1);
    assert.equal(unsubscribed, 0);

    // Unmount / next deps change: cleanup fires exactly the helper's unsub.
    cleanup2!();
    assert.equal(unsubscribed, 1);
  });
});

describe('useLiveQuery module', () => {
  test('exports the hook as a function', () => {
    assert.equal(typeof useLiveQuery, 'function');
  });
});
