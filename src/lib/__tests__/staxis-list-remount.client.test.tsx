import assert from 'node:assert/strict';
import { describe, test, type TestContext } from 'node:test';

import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

// Imported before jsdom is installed so the singleton Supabase client stays in
// its quiet non-browser test mode. Only the one auth method fetchWithAuth
// exercises is replaced below.
import { supabase } from '@/lib/supabase';
import { useApiResource } from '@/lib/hooks/use-api-resource';
import { hotelQueueChildKeys } from '@/components/concourse/hotel-queue-keys';

// ═══════════════════════════════════════════════════════════════════════════
// The Staxis tab bled DOM until the tab died: the one list remounted itself
// roughly twice every two and a half seconds and left a complete copy of the
// page chrome behind every time, so a long-lived tab accumulated over a
// thousand stacked copies while React's own tree stayed perfectly correct.
//
// The cause was two SIBLINGS SHARING ONE KEY inside HotelQueue: StaxisList and
// DripQuestionCard were both keyed on the bare propertyId. React falls out of
// positional reconciliation the moment a child slot is `false` (HotelQueue has
// one: the drill-down back link), and the keyed-Map fallback it drops into is
// filled by insertion order, so the later sibling overwrites the earlier one.
// The earlier child is then rebuilt from scratch on every parent render AND is
// missing from React's deletion list, so its DOM is never reclaimed.
//
// It is silent in production because React's duplicate-key warning is
// development only and nothing throws.
//
// These tests reproduce that exact composition against a REAL React renderer
// and the REAL useApiResource hook, and pin the fixed behaviour:
//   - the list mounts once and stays mounted across parent re-renders
//   - each endpoint is read exactly once, not once per render
//   - the container's child count never grows
//
// The last test is the teeth: it runs the identical harness with the OLD
// colliding keys and asserts the leak IS observed, so the three above cannot
// quietly start passing for the wrong reason.
// ═══════════════════════════════════════════════════════════════════════════

const DOM_GLOBALS = [
  'window',
  'document',
  'navigator',
  'HTMLElement',
  'Node',
  'Event',
  'EventTarget',
  'MutationObserver',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'getComputedStyle',
] as const;

type SessionReader = {
  getSession(): Promise<{ data: { session: null }; error: null }>;
};

function installBrowser(): () => void {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    pretendToBeVisual: true,
    url: 'http://localhost/feed',
  });
  const originals = new Map<string, PropertyDescriptor | undefined>();

  for (const key of DOM_GLOBALS) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    const candidate = dom.window[key as keyof typeof dom.window];
    const value = typeof candidate === 'function' && (
      key === 'requestAnimationFrame'
      || key === 'cancelAnimationFrame'
      || key === 'getComputedStyle'
    )
      ? candidate.bind(dom.window)
      : candidate;
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  }

  const actFlag = 'IS_REACT_ACT_ENVIRONMENT';
  originals.set(actFlag, Object.getOwnPropertyDescriptor(globalThis, actFlag));
  Object.defineProperty(globalThis, actFlag, {
    configurable: true,
    writable: true,
    value: true,
  });

  return () => {
    dom.window.close();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  };
}

async function flushMicrotasks(rounds = 12): Promise<void> {
  for (let index = 0; index < rounds; index += 1) await Promise.resolve();
}

function envelope(data: unknown): Response {
  return new Response(JSON.stringify({ ok: true, requestId: 'remount-test', data }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

interface PendingRequest {
  url: string;
  resolve(): void;
  settled: boolean;
}

interface Requests {
  /** Every request the page made, in order, including repeats. */
  urls: string[];
  /** Answer everything currently in flight. Returns how many were answered. */
  drain(): number;
}

/**
 * Requests are answered on demand rather than immediately. That is not a
 * stylistic choice: with immediate answers the LEAKING composition never goes
 * quiet inside act(), because every answer causes a remount which issues more
 * requests. Draining explicitly makes each cycle finite, so the leak can be
 * measured instead of hanging the run.
 */
function installRequests(context: TestContext): Requests {
  context.mock.method(
    supabase.auth as unknown as SessionReader,
    'getSession',
    async () => ({ data: { session: null }, error: null }),
  );

  const urls: string[] = [];
  const pending: PendingRequest[] = [];

  context.mock.method(globalThis, 'fetch', (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    urls.push(url);
    return new Promise<Response>((done) => {
      const entry: PendingRequest = {
        url,
        settled: false,
        resolve() {
          if (url.includes('/api/worklist')) done(envelope({ items: [], notices: [] }));
          else if (url.includes('/api/feed/prefs')) done(envelope({ prefs: { logbookInList: false } }));
          else if (url.includes('/api/findings')) done(envelope({ findings: [], run: null }));
          else done(envelope({}));
        },
      };
      pending.push(entry);
    });
  });

  return {
    urls,
    drain() {
      const open = pending.filter((entry) => !entry.settled);
      for (const entry of open) {
        entry.settled = true;
        entry.resolve();
      }
      return open.length;
    },
  };
}

const PID = 'cc000003-0000-4000-8000-000000000003';

interface Lifecycle {
  mounts: number;
  unmounts: number;
}

/**
 * Stands in for StaxisList. What matters for the reconciliation hazard is
 * reproduced faithfully: it is KEYED, it returns a FRAGMENT of several host
 * children (so its DOM lands directly in the container and each orphaned copy
 * is individually visible), it performs its initial reads through the real
 * useApiResource, and it reports its read state back up to the parent, which
 * is the feedback edge that made the defect self-sustaining.
 */
function ListProbe({
  propertyId,
  onReadState,
  lifecycle,
}: {
  propertyId: string;
  onReadState: (state: 'loading' | 'ready') => void;
  lifecycle: Lifecycle;
}) {
  React.useEffect(() => {
    lifecycle.mounts += 1;
    return () => { lifecycle.unmounts += 1; };
  }, [lifecycle]);

  const worklist = useApiResource<{ items: unknown[] }>(
    `/api/worklist?pid=${propertyId}`,
    { keepDataOnError: true },
  );
  useApiResource<{ prefs: unknown }>(
    `/api/feed/prefs?pid=${propertyId}`,
    { keepDataOnError: true },
  );
  const findings = useApiResource<{ findings: unknown[] }>(
    `/api/findings?propertyId=${propertyId}`,
    { keepDataOnError: true },
  );

  const readState = findings.data ? 'ready' : 'loading';
  React.useEffect(() => { onReadState(readState); }, [readState, onReadState]);

  return (
    <>
      <style />
      <div className="sl-toggle" />
      <style />
      <div className="fd-head" />
      <button type="button" className="sl-add" />
      {worklist.data ? <div className="sl-row" /> : null}
    </>
  );
}

/** Stands in for DripQuestionCard: keyed on the same hotel, renders nothing. */
function DripProbe() {
  return null;
}

/**
 * HotelQueue's child list, reproduced slot for slot. The `backLabel` slot is
 * the load-bearing detail: it is absent on an ordinary (non drill-down) load,
 * and that `false` is what pushes React out of positional reconciliation into
 * the keyed Map where a duplicate key does its damage.
 */
function HotelQueueShape({
  propertyId,
  keys,
  lifecycle,
  backLabel,
}: {
  propertyId: string;
  keys: { list: string; drip: string };
  lifecycle: Lifecycle;
  backLabel?: string;
}) {
  const [readState, setReadState] = React.useState<'loading' | 'ready'>('loading');

  return (
    <div className="cx-page cx-swap" data-feed-state={readState}>
      <style />
      <style />
      {backLabel && <div className="qv-back">{backLabel}</div>}
      <div className="cx-ptitle">Staxis</div>
      <div className="cx-psub">What Staxis noticed here.</div>
      <div className="mb-card" />
      <ListProbe
        key={keys.list}
        propertyId={propertyId}
        onReadState={setReadState}
        lifecycle={lifecycle}
      />
      {readState === 'loading' && <div className="qv-wait">One moment</div>}
      <DripProbe key={keys.drip} />
    </div>
  );
}

interface Mounted {
  container: HTMLElement;
  page(): HTMLElement;
  settle(cycles?: number): Promise<void>;
}

async function mountQueue(
  context: TestContext,
  keys: { list: string; drip: string },
  lifecycle: Lifecycle,
  requests: Requests,
  backLabel?: string,
): Promise<Mounted> {
  const restoreBrowser = installBrowser();
  const container = document.createElement('div');
  document.body.append(container);
  const root: Root = createRoot(container);

  context.after(async () => {
    await act(async () => { root.unmount(); });
    // Answer and drain whatever the last cycle left in flight BEFORE the DOM
    // globals go away. A leaking composition can have reads outstanding at
    // teardown, and their continuations would otherwise land on a torn-down
    // window and surface as an unhandled rejection.
    requests.drain();
    await act(async () => { await flushMicrotasks(24); });
    container.remove();
    restoreBrowser();
  });

  await act(async () => {
    root.render(
      <HotelQueueShape
        propertyId={PID}
        keys={keys}
        lifecycle={lifecycle}
        backLabel={backLabel}
      />,
    );
    await flushMicrotasks();
  });

  return {
    container,
    page: () => container.querySelector('.cx-page') as HTMLElement,
    async settle(cycles = 8) {
      // Each pass answers whatever is in flight and lets the resulting state
      // change commit. A stable tree goes quiet after the first pass and every
      // later pass answers nothing; a leaking one keeps remounting and keeps
      // asking, which is exactly what these tests measure.
      for (let index = 0; index < cycles; index += 1) {
        await act(async () => {
          requests.drain();
          await flushMicrotasks();
        });
      }
    },
  };
}

describe('the Staxis one list does not remount itself', { concurrency: false }, () => {
  test('the two hotel-scoped children can never share a key', () => {
    for (const pid of [PID, 'another-hotel', '', null, undefined]) {
      const keys = hotelQueueChildKeys(pid);
      assert.notEqual(
        keys.list,
        keys.drip,
        `the list and the drip question collided on ${String(pid)}, which orphans the list's DOM`,
      );
    }
    // The namespaces must also survive a hotel id that looks like the other
    // namespace, which is why they are prefixes rather than suffixes.
    assert.notEqual(
      hotelQueueChildKeys('drip-question:x').list,
      hotelQueueChildKeys('x').drip,
    );
  });

  test('the list mounts once and each endpoint is read exactly once', async (context) => {
    const requests = installRequests(context);
    const lifecycle: Lifecycle = { mounts: 0, unmounts: 0 };
    const queue = await mountQueue(context, hotelQueueChildKeys(PID), lifecycle, requests);

    await queue.settle();

    const urls = requests.urls;
    assert.equal(lifecycle.mounts, 1, 'the one list must mount exactly once');
    assert.equal(lifecycle.unmounts, 0, 'nothing may unmount the one list mid-session');

    const counted = (fragment: string) => urls.filter((url) => url.includes(fragment)).length;
    assert.equal(counted('/api/worklist'), 1, '/api/worklist must be read once, not once per render');
    assert.equal(counted('/api/feed/prefs'), 1, '/api/feed/prefs has no poll and must be read once');
    assert.equal(counted('/api/findings'), 1, '/api/findings must be read once, not once per render');
  });

  test('the container never accumulates orphaned copies of the page chrome', async (context) => {
    const requests = installRequests(context);
    const lifecycle: Lifecycle = { mounts: 0, unmounts: 0 };
    const queue = await mountQueue(context, hotelQueueChildKeys(PID), lifecycle, requests);

    await queue.settle();
    const settledCount = queue.page().childElementCount;

    await queue.settle(12);

    assert.equal(
      queue.page().childElementCount,
      settledCount,
      'the queue container grew after settling, which is the DOM leak',
    );
    // The production signature was one stacked composer per orphaned copy.
    assert.equal(
      queue.container.querySelectorAll('.sl-add').length,
      1,
      'exactly one composer may exist; more than one means an orphaned subtree',
    );
    assert.equal(
      queue.container.querySelectorAll('.fd-head').length,
      1,
      'exactly one "What Staxis noticed" heading may exist',
    );
    assert.equal(
      queue.container.querySelectorAll('.cx-ptitle').length,
      1,
      'the page title is rendered once',
    );
  });

  test('a drill-down (no false slot) is stable too', async (context) => {
    // The positional walk survives when every slot is filled, so this path
    // never showed the bug. Pinned so the fix is not mistaken for depending on
    // the back link being absent.
    const requests = installRequests(context);
    const lifecycle: Lifecycle = { mounts: 0, unmounts: 0 };
    const queue = await mountQueue(
      context,
      hotelQueueChildKeys(PID),
      lifecycle,
      requests,
      'Back to your hotels',
    );

    await queue.settle();
    const urls = requests.urls;
    const container = queue.container;

    assert.equal(lifecycle.mounts, 1);
    assert.equal(urls.filter((url) => url.includes('/api/findings')).length, 1);
    assert.equal(container.querySelectorAll('.sl-add').length, 1);
  });

  test('the harness detects the defect it was written for', async (context) => {
    // Teeth. The identical composition with the ORIGINAL colliding keys must
    // reproduce the outage, otherwise the assertions above prove nothing.
    //
    // React does warn about this, loudly, in development. Captured here both
    // to keep the run's output clean and to pin the one signal that exists:
    // production strips it, which is why the outage reached a live hotel with
    // an empty console.
    const warnings: string[] = [];
    context.mock.method(console, 'error', (...args: unknown[]) => {
      warnings.push(args.map((arg) => String(arg)).join(' '));
    });

    const requests = installRequests(context);
    const lifecycle: Lifecycle = { mounts: 0, unmounts: 0 };
    const collided = { list: PID, drip: PID };
    const queue = await mountQueue(context, collided, lifecycle, requests);

    await queue.settle();
    const urls = requests.urls;

    assert.ok(
      lifecycle.mounts > 1,
      `colliding keys must remount the list (saw ${lifecycle.mounts} mounts)`,
    );
    assert.ok(
      urls.filter((url) => url.includes('/api/findings')).length > 1,
      'colliding keys must produce the repeated read storm',
    );
    assert.ok(
      queue.container.querySelectorAll('.sl-add').length > 1,
      'colliding keys must leave orphaned copies of the chrome behind',
    );
    // And the leak is silent: React never removed what it orphaned.
    assert.equal(
      lifecycle.unmounts,
      0,
      'the orphaned subtrees were never unmounted, which is why their DOM stayed',
    );
    assert.ok(
      warnings.some((line) => line.includes('two children with the same key')),
      'development React must be the thing that names this defect',
    );
  });
});
