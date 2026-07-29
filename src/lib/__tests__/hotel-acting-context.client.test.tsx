import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, test, type TestContext } from 'node:test';

import type { AuthChangeEvent, Session } from '@supabase/supabase-js';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  PathnameContext,
  SearchParamsContext,
} from 'next/dist/shared/lib/hooks-client-context.shared-runtime';

// Keep Supabase in its quiet, non-browser mode. Each test replaces only the
// auth/account surface used by AuthProvider and fetchWithAuth.
import { AuthProvider } from '@/contexts/AuthContext';
import {
  HotelActingProvider,
  useHotelActingContext,
  type HotelActingContextValue,
} from '@/contexts/HotelActingContext';
import { SessionEndedError } from '@/lib/api-fetch';
import { supabase } from '@/lib/supabase';
import type { HotelActingContextV1 } from '@/lib/portfolio-ui/hotel-acting-contract';

type ActingBoundaryModule = typeof import('@/components/layout/ActingContextBoundary');

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason?: unknown): void;
};

type PendingRequest = {
  url: string;
  signal: AbortSignal | null;
  response: Deferred<Response>;
};

type AccountRow = {
  id: string;
  username: string;
  display_name: string;
  role: string;
  property_access: string[];
  data_user_id: string;
  staff_id: string | null;
  skip_2fa: boolean;
};

type AccountQuery = {
  select(...columns: string[]): AccountQuery;
  eq(column: string, value: unknown): AccountQuery;
  maybeSingle(): Promise<{ data: AccountRow | null; error: unknown | null }>;
};

type AuthCallback = (event: AuthChangeEvent, session: Session | null) => void;
type AuthSurface = {
  getSession(): Promise<{ data: { session: Session | null }; error: null }>;
  onAuthStateChange(callback: AuthCallback): {
    data: { subscription: { unsubscribe(): void } };
  };
  signOut(): Promise<{ error: null }>;
};

type DatabaseSurface = {
  from(table: string): AccountQuery;
};

type RealtimeSurface = {
  channel(name: string): unknown;
  removeChannel(channel: unknown): Promise<'ok'>;
};

const ORGANIZATION_ID = '11111111-1111-4111-8111-111111111111';
const PROPERTY_ID = '22222222-2222-4222-8222-222222222222';

const DOM_GLOBALS = [
  'window',
  'document',
  'navigator',
  'localStorage',
  'sessionStorage',
  'Element',
  'HTMLElement',
  'HTMLButtonElement',
  'Node',
  'Event',
  'EventTarget',
  'MutationObserver',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'getComputedStyle',
] as const;

const auth = supabase.auth as unknown as AuthSurface;
const database = supabase as unknown as DatabaseSurface;
const realtime = supabase as unknown as RealtimeSurface;
let boundaryModulePromise: Promise<ActingBoundaryModule> | null = null;

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function session(uid = 'viewer-a'): Session {
  return {
    access_token: `access-${uid}`,
    refresh_token: `refresh-${uid}`,
    expires_in: 3_600,
    expires_at: Math.floor(Date.now() / 1_000) + 3_600,
    token_type: 'bearer',
    user: { id: uid },
  } as Session;
}

function account(overrides: Partial<AccountRow> = {}): AccountRow {
  return {
    id: 'account-viewer-a',
    username: 'viewer-a',
    display_name: 'Viewer A',
    role: 'owner',
    property_access: [PROPERTY_ID],
    data_user_id: 'viewer-a',
    staff_id: null,
    skip_2fa: false,
    ...overrides,
  };
}

function sectionAvailability(): HotelActingContextV1['sectionAvailability'] {
  return {
    dashboard: true,
    housekeeping: true,
    communications: true,
    maintenance: true,
    inventory: true,
    staff: true,
    financials: true,
    staxis: true,
  };
}

function localContext(
  operationalRole: HotelActingContextV1['standing']['operationalRole'] = 'owner',
): HotelActingContextV1 {
  return {
    version: 'hotel-acting-context.v1',
    verifiedAt: '2026-07-28T12:00:00.000Z',
    source: 'local',
    organization: null,
    parentScope: null,
    property: {
      id: PROPERTY_ID,
      name: 'Hotel A',
      region: 'North',
      totalRooms: 84,
      timezone: 'America/Chicago',
    },
    standing: {
      operationalRole,
      localHotelAccess: true,
      hotelDetailRead: true,
      hotelMutationAllowed: operationalRole === 'owner' || operationalRole === 'general_manager',
      seesFinancials: operationalRole === 'owner' || operationalRole === 'general_manager',
      portfolioIntelligenceRead: false,
    },
    portfolioFeatures: { queueAvailable: false },
    sectionAvailability: sectionAvailability(),
  };
}

function portfolioContext(): HotelActingContextV1 {
  return {
    ...localContext('front_desk'),
    source: 'portfolio',
    organization: { id: ORGANIZATION_ID, name: 'Company A' },
    parentScope: { kind: 'company', id: ORGANIZATION_ID, name: 'Company A' },
    standing: {
      operationalRole: 'front_desk',
      localHotelAccess: false,
      hotelDetailRead: true,
      hotelMutationAllowed: false,
      seesFinancials: true,
      portfolioIntelligenceRead: true,
    },
    portfolioFeatures: { queueAvailable: true },
  };
}

function success(context: HotelActingContextV1): Response {
  return new Response(JSON.stringify({
    ok: true,
    requestId: 'acting-context-client-test',
    data: context,
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function loadBoundaryModule(): Promise<ActingBoundaryModule> {
  if (boundaryModulePromise) return boundaryModulePromise;
  const nodeRequire = createRequire(import.meta.url);
  const extensions = nodeRequire.extensions as Record<
    string,
    (module: NodeModule, filename: string) => void
  >;
  const originalCssLoader = extensions['.css'];
  extensions['.css'] = (module) => { module.exports = {}; };
  boundaryModulePromise = import('@/components/layout/ActingContextBoundary')
    .finally(() => {
      if (originalCssLoader) extensions['.css'] = originalCssLoader;
      else delete extensions['.css'];
    });
  return boundaryModulePromise;
}

function installBrowser(pathname: string): {
  restore(): void;
  setVisibility(value: DocumentVisibilityState): void;
} {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    pretendToBeVisual: true,
    url: `http://localhost${pathname}`,
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

  let visibility: DocumentVisibilityState = 'visible';
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => visibility,
  });

  const actFlag = 'IS_REACT_ACT_ENVIRONMENT';
  originals.set(actFlag, Object.getOwnPropertyDescriptor(globalThis, actFlag));
  Object.defineProperty(globalThis, actFlag, {
    configurable: true,
    writable: true,
    value: true,
  });

  return {
    setVisibility(value) { visibility = value; },
    restore() {
      dom.window.close();
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

async function flushMicrotasks(rounds = 8): Promise<void> {
  for (let index = 0; index < rounds; index += 1) await Promise.resolve();
}

async function nextTask(): Promise<void> {
  await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
}

async function waitFor(
  predicate: () => boolean,
  message: string,
  attempts = 20,
): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return;
    await act(async () => {
      await flushMicrotasks();
      await nextTask();
    });
  }
  assert.fail(message);
}

function installDependencies(context: TestContext): {
  requests: PendingRequest[];
  emit(event: AuthChangeEvent, nextSession?: Session | null): void;
  setAccount(next: AccountRow): void;
} {
  const viewerSession = session();
  let activeAccount = account();
  let callback: AuthCallback | null = null;

  context.mock.method(auth, 'getSession', async () => ({
    data: { session: viewerSession },
    error: null,
  }));
  context.mock.method(auth, 'onAuthStateChange', (nextCallback: AuthCallback) => {
    callback = nextCallback;
    return { data: { subscription: { unsubscribe() {} } } };
  });
  context.mock.method(auth, 'signOut', async () => ({ error: null }));
  context.mock.method(database, 'from', (table: string) => {
    assert.equal(table, 'accounts');
    const query: AccountQuery = {
      select: () => query,
      eq: () => query,
      maybeSingle: async () => ({ data: activeAccount, error: null }),
    };
    return query;
  });

  const fakeChannel = {
    on: () => fakeChannel,
    subscribe: () => fakeChannel,
  };
  context.mock.method(realtime, 'channel', () => fakeChannel);
  context.mock.method(realtime, 'removeChannel', async () => 'ok' as const);

  const requests: PendingRequest[] = [];
  context.mock.method(globalThis, 'fetch', (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/api/auth/session-authorization')) {
      const operationalRole = activeAccount.role === 'general_manager'
        ? 'general_manager'
        : activeAccount.role === 'owner'
          ? 'owner'
          : 'front_desk';
      return Promise.resolve(new Response(JSON.stringify({
        ok: true,
        data: {
          active: true,
          role: activeAccount.role,
          propertyAccess: [PROPERTY_ID],
          propertyStandings: [{
            propertyId: PROPERTY_ID,
            operationalRole,
            seesFinancials: operationalRole === 'owner' || operationalRole === 'general_manager',
            hotelMutationAllowed: operationalRole === 'owner' || operationalRole === 'general_manager',
            portfolioIntelligenceRead: false,
          }],
          platformAdmin: false,
          authorizationFingerprint: `client-test:${activeAccount.role}`,
          verifiedAt: '2026-07-28T12:00:00.000Z',
        },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
    }
    const response = deferred<Response>();
    requests.push({
      url,
      signal: init?.signal ?? null,
      response,
    });
    return response.promise;
  });

  return {
    requests,
    emit(event, nextSession = viewerSession) {
      assert.ok(callback, 'AuthProvider must subscribe before an auth event is emitted');
      callback(event, nextSession);
    },
    setAccount(next) { activeAccount = next; },
  };
}

type MountedApp = {
  browser: ReturnType<typeof installBrowser>;
  container: HTMLDivElement;
  current(): HotelActingContextValue;
  childMounts(): number;
  renderLocation(pathname: string, search: string): Promise<void>;
};

async function mountApp(
  context: TestContext,
  initial: { pathname?: string; search?: string } = {},
): Promise<MountedApp> {
  const pathname = initial.pathname ?? '/home';
  const search = initial.search ?? `scope=hotel&propertyId=${PROPERTY_ID}`;
  const browser = installBrowser(`${pathname}?${search}`);
  const { ActingContextBoundary } = await loadBoundaryModule();
  const container = document.createElement('div');
  document.body.append(container);
  const root: Root = createRoot(container);
  let latest: HotelActingContextValue | null = null;
  let childMountCount = 0;
  let setLocation!: React.Dispatch<React.SetStateAction<{ pathname: string; search: string }>>;

  function Probe() {
    latest = useHotelActingContext();
    return null;
  }

  function HotelLocalChild() {
    React.useEffect(() => { childMountCount += 1; }, []);
    return (
      <main>
        <h1 data-staxis-page-heading>Hotel local workspace</h1>
        <div data-hotel-secret>hotel-local-secret</div>
      </main>
    );
  }

  function Harness() {
    const [location, updateLocation] = React.useState({ pathname, search });
    setLocation = updateLocation;
    return (
      <PathnameContext.Provider value={location.pathname}>
        <SearchParamsContext.Provider value={new URLSearchParams(location.search)}>
          <AuthProvider>
            <HotelActingProvider>
              <Probe />
              <ActingContextBoundary>
                <HotelLocalChild />
              </ActingContextBoundary>
            </HotelActingProvider>
          </AuthProvider>
        </SearchParamsContext.Provider>
      </PathnameContext.Provider>
    );
  }

  await act(async () => {
    root.render(<Harness />);
    await flushMicrotasks();
  });

  context.after(async () => {
    await act(async () => { root.unmount(); });
    container.remove();
    browser.restore();
  });

  return {
    browser,
    container,
    current() {
      assert.ok(latest, 'acting-context probe must have rendered');
      return latest;
    },
    childMounts: () => childMountCount,
    async renderLocation(nextPathname, nextSearch) {
      await act(async () => {
        setLocation({ pathname: nextPathname, search: nextSearch });
        await flushMicrotasks();
      });
    },
  };
}

async function settle(request: PendingRequest, response: Response): Promise<void> {
  await act(async () => {
    request.response.resolve(response);
    await flushMicrotasks();
  });
}

describe('Hotel acting-context client boundary', { concurrency: false }, () => {
  test('retry owns the verdict and a stale response cannot republish', async (context) => {
    const dependencies = installDependencies(context);
    const app = await mountApp(context);
    await waitFor(() => dependencies.requests.length === 1, 'initial acting-context request did not start');

    await act(async () => {
      app.current().retry();
      await flushMicrotasks();
    });
    await waitFor(() => dependencies.requests.length === 2, 'retry did not start a fresh request');
    assert.equal(dependencies.requests[0].signal?.aborted, true);

    await settle(dependencies.requests[1], success(localContext()));
    assert.equal(app.current().status, 'allowed');
    assert.match(app.container.textContent ?? '', /hotel-local-secret/);

    await settle(dependencies.requests[0], new Response(null, { status: 403 }));
    assert.equal(app.current().status, 'allowed');
    assert.match(app.container.textContent ?? '', /hotel-local-secret/);
    assert.equal(app.childMounts(), 1, 'stale completion must not remount or replace the winner');
  });

  test('foreground masks synchronously, coalesces duplicate signals, and restores page-heading focus', async (context) => {
    const dependencies = installDependencies(context);
    const app = await mountApp(context);
    await waitFor(() => dependencies.requests.length === 1, 'initial acting-context request did not start');
    await settle(dependencies.requests[0], success(localContext()));
    assert.match(app.container.textContent ?? '', /hotel-local-secret/);

    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      assert.doesNotMatch(
        app.container.textContent ?? '',
        /hotel-local-secret/,
        'the first foreground event must synchronously remove the hotel subtree',
      );
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('pageshow'));
      await flushMicrotasks();
    });
    await waitFor(() => dependencies.requests.length === 2, 'foreground did not reauthorize');
    assert.equal(dependencies.requests.length, 2, 'one foreground transition must issue one request');

    await settle(dependencies.requests[1], success(localContext()));
    assert.match(app.container.textContent ?? '', /hotel-local-secret/);
    assert.equal(
      document.activeElement?.textContent,
      'Hotel local workspace',
      'the reauthorized destination heading receives the focus handoff',
    );
  });

  test('pagehide commits a BFCache-safe mask and hidden route effects cannot start work', async (context) => {
    const dependencies = installDependencies(context);
    const app = await mountApp(context);
    await waitFor(() => dependencies.requests.length === 1, 'initial acting-context request did not start');
    await settle(dependencies.requests[0], success(localContext()));

    app.browser.setVisibility('hidden');
    await act(async () => {
      window.dispatchEvent(new Event('pagehide'));
      assert.doesNotMatch(app.container.textContent ?? '', /hotel-local-secret/);
      await flushMicrotasks();
    });

    await app.renderLocation('/staff', `scope=hotel&propertyId=${PROPERTY_ID}`);
    assert.equal(dependencies.requests.length, 1, 'a hidden pending effect must refuse to start a request');
    assert.doesNotMatch(app.container.textContent ?? '', /hotel-local-secret/);

    app.browser.setVisibility('visible');
    await act(async () => {
      window.dispatchEvent(new Event('pageshow'));
      await flushMicrotasks();
    });
    await waitFor(() => dependencies.requests.length === 2, 'BFCache restore did not reauthorize');
    assert.equal(dependencies.requests[1].url.includes('/api/portfolio/v1/hotel-context'), true);
  });

  test('SessionEndedError leaves the subtree masked without replacing the sign-in transition', async (context) => {
    const dependencies = installDependencies(context);
    const app = await mountApp(context);
    await waitFor(() => dependencies.requests.length === 1, 'initial acting-context request did not start');

    await act(async () => {
      dependencies.requests[0].response.reject(new SessionEndedError());
      await flushMicrotasks();
    });

    assert.equal(app.current().status, 'checking');
    assert.match(app.container.textContent ?? '', /Opening hotel/);
    assert.doesNotMatch(app.container.textContent ?? '', /could not be checked|Try again|hotel-local-secret/);
  });

  test('same-uid role changes synchronously mask the old grant and fetch a new verdict', async (context) => {
    const dependencies = installDependencies(context);
    const app = await mountApp(context);
    await waitFor(() => dependencies.requests.length === 1, 'initial acting-context request did not start');
    await settle(dependencies.requests[0], success(localContext('owner')));
    assert.match(app.container.textContent ?? '', /hotel-local-secret/);

    dependencies.setAccount(account({ role: 'front_desk' }));
    await act(async () => {
      dependencies.emit('TOKEN_REFRESHED');
      await nextTask();
      await flushMicrotasks();
    });
    await waitFor(() => dependencies.requests.length === 2, 'changed authorization did not recheck');
    assert.doesNotMatch(
      app.container.textContent ?? '',
      /hotel-local-secret/,
      'the old same-uid grant must not remain visible during reauthorization',
    );

    await settle(dependencies.requests[1], success(localContext('front_desk')));
    assert.equal(app.current().status, 'allowed');
    assert.match(app.container.textContent ?? '', /hotel-local-secret/);
  });

  test('return targets and filters do not churn the authorization request identity', async (context) => {
    const dependencies = installDependencies(context);
    const app = await mountApp(context);
    await waitFor(() => dependencies.requests.length === 1, 'initial acting-context request did not start');
    await settle(dependencies.requests[0], success(localContext()));
    const identity = app.current().request.requestKey;

    await app.renderLocation(
      '/home',
      `scope=hotel&propertyId=${PROPERTY_ID}&returnTo=%2Fportfolio%3Fstatus%3Dattention&status=attention`,
    );

    assert.equal(app.current().request.requestKey, identity);
    assert.equal(dependencies.requests.length, 1);
    assert.match(app.container.textContent ?? '', /hotel-local-secret/);
    assert.equal(app.childMounts(), 1, 'filter-only changes must not remount the hotel subtree');
  });

  test('a portfolio-origin verdict mounts the authorized hotel view without local write elevation', async (context) => {
    const dependencies = installDependencies(context);
    const app = await mountApp(context, {
      search: `scope=hotel&organizationId=${ORGANIZATION_ID}&propertyId=${PROPERTY_ID}`,
    });
    await waitFor(() => dependencies.requests.length === 1, 'portfolio acting-context request did not start');
    await settle(dependencies.requests[0], success(portfolioContext()));

    assert.equal(app.current().status, 'allowed');
    assert.equal(app.current().context?.source, 'portfolio');
    assert.equal(app.current().context?.standing.localHotelAccess, false);
    assert.equal(app.current().context?.standing.hotelMutationAllowed, false);
    assert.equal(app.childMounts(), 1);
    assert.match(app.container.textContent ?? '', /hotel-local-secret/);
    assert.match(app.container.textContent ?? '', /Read only/);
  });
});
