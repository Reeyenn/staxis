import assert from 'node:assert/strict';
import { describe, test, type TestContext } from 'node:test';

import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

// Keep the singleton Supabase client in its non-browser test mode. The test
// replaces the only auth method fetchWithAuth exercises.
import { PortfolioQueueView, type PortfolioPayload } from '@/components/concourse/PortfolioQueueView';
import { supabase } from '@/lib/supabase';

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
};

type PendingRequest = {
  response: Deferred<Response>;
};

type SessionReader = {
  getSession(): Promise<{ data: { session: null }; error: null }>;
};

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

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

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

async function flushMicrotasks(rounds = 8): Promise<void> {
  for (let index = 0; index < rounds; index += 1) await Promise.resolve();
}

function payload(organizationId: string, organizationName: string): PortfolioPayload {
  return {
    scope: {
      organizationId,
      organizationName,
      companyRole: 'owner',
      hotelCount: 2,
    },
    cards: [],
    brief: null,
    run: null,
    coverage: null,
  };
}

function success(data: PortfolioPayload): Response {
  return new Response(JSON.stringify({
    ok: true,
    requestId: 'portfolio-identity-test',
    data,
  }), {
    status: 200,
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
  context.mock.method(globalThis, 'fetch', () => {
    const response = deferred<Response>();
    requests.push({ response });
    return response.promise;
  });
  return requests;
}

async function settle(request: PendingRequest, response: Response): Promise<void> {
  await act(async () => {
    request.response.resolve(response);
    await flushMicrotasks();
  });
}

describe('Portfolio Queue viewer identity isolation', { concurrency: false }, () => {
  test('a custom-source read masks the old company and refetches on authorization change', async (context) => {
    const restoreBrowser = installBrowser();
    const requests = installRequests(context);
    const container = document.createElement('div');
    document.body.append(container);
    const root: Root = createRoot(container);
    const scopes: string[] = [];
    const recordScope = (scope: Parameters<NonNullable<React.ComponentProps<typeof PortfolioQueueView>['onScope']>>[0]) => {
      scopes.push(scope === undefined ? 'loading' : scope?.organizationId ?? 'hotel');
    };

    context.after(async () => {
      await act(async () => { root.unmount(); });
      container.remove();
      restoreBrowser();
    });

    await act(async () => {
      root.render(
        <PortfolioQueueView
          lang="en"
          authorizationKey="viewer-a:owner:hotel-a,hotel-b"
          onScope={recordScope}
        />,
      );
      await flushMicrotasks();
    });
    assert.equal(requests.length, 1);
    assert.equal(container.querySelector('[data-feed-state="loading"]') !== null, true);

    await settle(requests[0], success(payload('org-a', 'Company A')));
    assert.match(container.textContent ?? '', /Company A/);
    assert.deepEqual(scopes, ['loading', 'org-a']);

    await act(async () => {
      root.render(
        <PortfolioQueueView
          lang="en"
          authorizationKey="viewer-b:finance:hotel-c,hotel-d"
          onScope={recordScope}
        />,
      );
      await flushMicrotasks();
    });

    assert.equal(requests.length, 2, 'the stable custom fetcher must refetch for viewer B');
    assert.doesNotMatch(container.textContent ?? '', /Company A/);
    assert.equal(
      container.querySelector('[data-feed-state="loading"]') !== null,
      true,
      'the first render after the switch must mask viewer A behind viewer B\'s real load',
    );

    await settle(requests[1], success(payload('org-b', 'Company B')));
    assert.match(container.textContent ?? '', /Company B/);
    assert.doesNotMatch(container.textContent ?? '', /Company A/);
    assert.deepEqual(scopes, ['loading', 'org-a', 'loading', 'org-b']);
  });
});
