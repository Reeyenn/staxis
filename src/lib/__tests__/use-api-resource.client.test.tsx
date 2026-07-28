import assert from 'node:assert/strict';
import { describe, test, type TestContext } from 'node:test';

import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

// Import before installing jsdom so the singleton Supabase client remains in
// its quiet non-browser test mode. Each test replaces the only auth method
// exercised by fetchWithAuth.
import { supabase } from '@/lib/supabase';
import {
  useApiResource,
  type UseApiResourceResult,
} from '@/lib/hooks/use-api-resource';

type Row = { id: string };

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
};

type PendingRequest = {
  url: string;
  signal: AbortSignal | null;
  response: Deferred<Response>;
};

type ProbeProps = {
  source: string;
  identityKey: string;
  keepDataOnError?: boolean;
  keepDataOnSourceChange?: boolean;
};

type RenderSnapshot = {
  data: Row[] | null;
  loading: boolean;
  error: string | null;
};

type SessionReader = {
  getSession(): Promise<{ data: { session: null }; error: null }>;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

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

function installBrowser(): () => void {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    pretendToBeVisual: true,
    url: 'http://localhost/property-selector',
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

async function flushMicrotasks(rounds = 8): Promise<void> {
  for (let index = 0; index < rounds; index += 1) await Promise.resolve();
}

function success(data: Row[]): Response {
  return new Response(JSON.stringify({
    ok: true,
    requestId: 'test-request',
    data,
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function failure(message: string): Response {
  return new Response(JSON.stringify({
    ok: false,
    requestId: 'test-request',
    error: message,
  }), {
    status: 503,
    headers: { 'Content-Type': 'application/json' },
  });
}

function installRequests(context: TestContext): PendingRequest[] {
  context.mock.method(
    supabase.auth as unknown as SessionReader,
    'getSession',
    async () => ({ data: { session: null }, error: null }),
  );

  const requests: PendingRequest[] = [];
  context.mock.method(globalThis, 'fetch', (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const response = deferred<Response>();
    requests.push({
      url: typeof input === 'string' ? input : input.toString(),
      signal: init?.signal ?? null,
      response,
    });
    return response.promise;
  });
  return requests;
}

async function mountProbe(context: TestContext, initialProps: ProbeProps): Promise<{
  current(): UseApiResourceResult<Row[]>;
  render(props: ProbeProps): Promise<RenderSnapshot[]>;
  renders: RenderSnapshot[];
}> {
  const restoreBrowser = installBrowser();
  const container = document.createElement('div');
  document.body.append(container);
  const root: Root = createRoot(container);
  let current: UseApiResourceResult<Row[]> | null = null;
  const renders: RenderSnapshot[] = [];

  function Probe(props: ProbeProps) {
    current = useApiResource<Row[]>(props.source, {
      identityKey: props.identityKey,
      keepDataOnError: props.keepDataOnError,
      keepDataOnSourceChange: props.keepDataOnSourceChange,
    });
    renders.push({
      data: current.data,
      loading: current.loading,
      error: current.error,
    });
    return null;
  }

  async function render(props: ProbeProps): Promise<RenderSnapshot[]> {
    const firstNewRender = renders.length;
    await act(async () => {
      root.render(<Probe {...props} />);
      await flushMicrotasks();
    });
    return renders.slice(firstNewRender);
  }

  await render(initialProps);

  context.after(async () => {
    await act(async () => { root.unmount(); });
    container.remove();
    restoreBrowser();
  });

  return {
    current() {
      assert.ok(current, 'resource probe must have rendered');
      return current;
    },
    render,
    renders,
  };
}

async function settleRequest(
  request: PendingRequest,
  response: Response,
): Promise<void> {
  await act(async () => {
    request.response.resolve(response);
    await flushMicrotasks();
  });
}

describe('useApiResource authorization identity isolation', { concurrency: false }, () => {
  test('same uid with changed role/grants synchronously masks retained data and error', async (context) => {
    const requests = installRequests(context);
    const ownerIdentity = 'uid-1:owner:hotel-a,hotel-b';
    const staffIdentity = 'uid-1:staff:hotel-b';
    const props: ProbeProps = {
      source: '/api/properties',
      identityKey: ownerIdentity,
      keepDataOnError: true,
      // The dangerous combination: a stable URL and an opt-in source hold
      // still must not carry anything across an authorization transition.
      keepDataOnSourceChange: true,
    };
    const probe = await mountProbe(context, props);

    assert.equal(requests.length, 1);
    await settleRequest(requests[0], success([{ id: 'hotel-a' }, { id: 'hotel-b' }]));
    assert.deepEqual(probe.current().data, [{ id: 'hotel-a' }, { id: 'hotel-b' }]);

    let reload!: Promise<void>;
    await act(async () => {
      reload = probe.current().reload();
      await flushMicrotasks();
    });
    assert.equal(requests.length, 2);
    await settleRequest(requests[1], failure('owner grant refresh failed'));
    await reload;
    assert.deepEqual(probe.current().data, [{ id: 'hotel-a' }, { id: 'hotel-b' }]);
    assert.equal(probe.current().error, 'owner grant refresh failed');

    const transition = await probe.render({ ...props, identityKey: staffIdentity });
    assert.ok(transition.length > 0);
    assert.deepEqual(transition[0], {
      data: null,
      loading: true,
      error: null,
    }, 'the render before passive effects must already be tenant-safe');
    assert.equal(
      transition.some((snapshot) => snapshot.data?.some((row) => row.id === 'hotel-a')),
      false,
      'revoked hotel data must not flash for even one render',
    );
    assert.equal(
      transition.some((snapshot) => snapshot.error === 'owner grant refresh failed'),
      false,
      'an error produced under the old grant must also be masked',
    );

    assert.equal(requests.length, 3);
    await settleRequest(requests[2], success([{ id: 'hotel-b' }]));
    assert.deepEqual(probe.current().data, [{ id: 'hotel-b' }]);
    assert.equal(probe.current().loading, false);
    assert.equal(probe.current().error, null);
  });

  test('property source changes mask by default but can hold within the same authorization identity', async (context) => {
    const requests = installRequests(context);
    const identityKey = 'uid-1:owner:hotel-a,hotel-b,hotel-c';
    const initial: ProbeProps = {
      source: '/api/rooms?pid=hotel-a',
      identityKey,
      keepDataOnSourceChange: true,
    };
    const probe = await mountProbe(context, initial);

    assert.equal(requests.length, 1);
    await settleRequest(requests[0], success([{ id: 'room-a' }]));

    const heldTransition = await probe.render({
      ...initial,
      source: '/api/rooms?pid=hotel-b',
    });
    assert.deepEqual(heldTransition[0], {
      data: [{ id: 'room-a' }],
      loading: false,
      error: null,
    }, 'explicit source holds remain available inside one authorization identity');
    assert.equal(requests.length, 2);
    await settleRequest(requests[1], success([{ id: 'room-b' }]));
    assert.deepEqual(probe.current().data, [{ id: 'room-b' }]);

    const maskedTransition = await probe.render({
      ...initial,
      source: '/api/rooms?pid=hotel-c',
      keepDataOnSourceChange: false,
    });
    assert.deepEqual(maskedTransition[0], {
      data: null,
      loading: true,
      error: null,
    });
    assert.equal(
      maskedTransition.some((snapshot) => snapshot.data?.some((row) => row.id === 'room-b')),
      false,
      'default property switches must never render the previous property',
    );
    assert.equal(requests.length, 3);
    await settleRequest(requests[2], success([{ id: 'room-c' }]));
    assert.deepEqual(probe.current().data, [{ id: 'room-c' }]);
  });
});
