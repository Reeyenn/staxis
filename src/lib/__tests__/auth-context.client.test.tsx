import assert from 'node:assert/strict';
import { describe, test, type TestContext } from 'node:test';

import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Session } from '@supabase/supabase-js';

// Import the singleton before installing jsdom. That keeps GoTrue in its
// non-browser test mode (no background refresh timer); each test replaces the
// small auth/database surface AuthProvider uses before mounting the provider.
import { supabase } from '@/lib/supabase';
import {
  AuthProvider,
  useAuth,
  type AppUser,
  type AuthSignInResult,
} from '@/contexts/AuthContext';
import { AUTH_SESSION_OPERATION_TIMEOUT_MS } from '@/lib/api-fetch';

type AuthSnapshot = {
  user: AppUser | null;
  loading: boolean;
  sessionError: string | null;
  sessionErrorKind: 'transient' | 'ended' | null;
  retrySession: () => void;
  signIn: (email: string, password: string) => Promise<AuthSignInResult>;
  isAuthSessionCurrent: (session: Session) => boolean;
  discardAuthSession: (session: Session) => boolean;
  resetForFreshSignIn: () => Promise<void>;
  signOut: () => Promise<void>;
};

type SessionResult = {
  data: { session: Session | null };
  error: unknown | null;
};

type AuthCallback = Parameters<typeof supabase.auth.onAuthStateChange>[0];
type SignOutOptions = { scope?: 'global' | 'local' | 'others' };

type AuthSurface = {
  getSession: () => Promise<SessionResult>;
  onAuthStateChange: (callback: AuthCallback) => {
    data: { subscription: { unsubscribe: () => void } };
  };
  signInWithPassword: (credentials: { email: string; password: string }) => Promise<{
    data: { session: Session | null; user: Session['user'] | null };
    error: { message: string } | null;
  }>;
  signOut: (options?: SignOutOptions) => Promise<{ error: unknown | null }>;
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

type AccountResult = {
  data: AccountRow | null;
  error: unknown | null;
};

type AccountQuery = {
  select: (...columns: string[]) => AccountQuery;
  eq: (column: string, value: unknown) => AccountQuery;
  maybeSingle: () => Promise<AccountResult>;
};

type DatabaseSurface = {
  from: (table: string) => AccountQuery;
};

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

const auth = supabase.auth as unknown as AuthSurface;
const database = supabase as unknown as DatabaseSurface;
const realtime = supabase as unknown as {
  channel: (name: string) => unknown;
  removeChannel: (channel: unknown) => Promise<'ok'>;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function session(uid: string, tokenIdentity = uid): Session {
  return {
    access_token: `access-${tokenIdentity}`,
    refresh_token: `refresh-${tokenIdentity}`,
    expires_in: 3_600,
    expires_at: Math.floor(Date.now() / 1_000) + 3_600,
    token_type: 'bearer',
    user: { id: uid },
  } as Session;
}

function account(uid: string, options: { isDemo?: boolean } = {}): AccountRow {
  return {
    id: `account-${uid}`,
    username: uid,
    display_name: `User ${uid}`,
    role: 'owner',
    property_access: [`property-${uid}`],
    data_user_id: uid,
    staff_id: null,
    skip_2fa: options.isDemo ?? false,
  };
}

function installAccountResolver(
  context: TestContext,
  resolveAccount: (uid: string) => AccountResult | Promise<AccountResult>,
): void {
  context.mock.method(database, 'from', (table: string) => {
    assert.equal(table, 'accounts');
    let uid = '';
    const query: AccountQuery = {
      select: () => query,
      eq: (_column, value) => {
        uid = String(value);
        return query;
      },
      maybeSingle: async () => resolveAccount(uid),
    };
    return query;
  });
}

function installAuthListener(context: TestContext): {
  emit: (event: Parameters<AuthCallback>[0], nextSession: Session | null) => void;
} {
  let callback: AuthCallback | null = null;
  context.mock.method(auth, 'onAuthStateChange', (nextCallback: AuthCallback) => {
    callback = nextCallback;
    return { data: { subscription: { unsubscribe() {} } } };
  });

  return {
    emit(event, nextSession) {
      assert.ok(callback, 'AuthProvider must subscribe before an auth event is emitted');
      callback(event, nextSession);
    },
  };
}

const DOM_GLOBALS = [
  'window',
  'document',
  'navigator',
  'localStorage',
  'sessionStorage',
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
    url: 'http://localhost/home',
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

async function flushMicrotasks(rounds = 4): Promise<void> {
  for (let index = 0; index < rounds; index += 1) await Promise.resolve();
}

async function advance(context: TestContext, milliseconds: number): Promise<void> {
  await act(async () => {
    context.mock.timers.tick(milliseconds);
    await flushMicrotasks();
  });
}

async function mountProvider(context: TestContext, fakeTimers = false): Promise<{
  current: () => AuthSnapshot;
}> {
  const restoreBrowser = installBrowser();
  if (fakeTimers) context.mock.timers.enable({ apis: ['setTimeout'] });

  // AuthProvider now listens for authorization-version invalidations. These
  // reliability tests exercise auth ordering, not a real socket, so keep the
  // Realtime lifecycle deterministic and network-free.
  const fakeChannel = {
    on: () => fakeChannel,
    subscribe: () => fakeChannel,
  };
  context.mock.method(realtime, 'channel', () => fakeChannel);
  context.mock.method(realtime, 'removeChannel', async () => 'ok' as const);

  const container = document.createElement('div');
  document.body.append(container);
  const root: Root = createRoot(container);
  let latest: AuthSnapshot | null = null;

  function Probe() {
    latest = useAuth();
    return null;
  }

  await act(async () => {
    root.render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await flushMicrotasks();
  });

  context.after(async () => {
    await act(async () => { root.unmount(); });
    container.remove();
    if (fakeTimers) context.mock.timers.reset();
    restoreBrowser();
  });

  return {
    current() {
      assert.ok(latest, 'auth probe must have rendered');
      return latest;
    },
  };
}

describe('AuthProvider client reliability', { concurrency: false }, () => {
  test('hung hydration reaches a retryable state, and retry recovers without a reload', async (context) => {
    const firstSessionRead = deferred<SessionResult>();
    const retrySessionRead = deferred<SessionResult>();
    const accountReads: string[] = [];
    let sessionReads = 0;
    context.mock.method(auth, 'getSession', () => {
      sessionReads += 1;
      if (sessionReads === 1) return firstSessionRead.promise;
      return retrySessionRead.promise;
    });
    installAuthListener(context);
    installAccountResolver(context, (uid) => {
      accountReads.push(uid);
      return { data: account(uid), error: null };
    });
    context.mock.method(auth, 'signOut', async () => ({ error: null }));
    context.mock.method(console, 'warn', () => {});

    const app = await mountProvider(context, true);
    assert.equal(app.current().loading, true);

    await advance(context, 10_000);
    assert.deepEqual(
      {
        loading: app.current().loading,
        errorKind: app.current().sessionErrorKind,
        hasError: Boolean(app.current().sessionError),
      },
      { loading: false, errorKind: 'transient', hasError: true },
    );

    await act(async () => {
      app.current().retrySession();
      await flushMicrotasks();
    });
    assert.equal(app.current().loading, true, 'retry must keep protected children masked');
    assert.equal(app.current().sessionError, null);

    retrySessionRead.resolve({ data: { session: session('B') }, error: null });
    await act(async () => { await flushMicrotasks(); });
    assert.deepEqual(
      {
        user: app.current().user?.uid,
        loading: app.current().loading,
        error: app.current().sessionError,
      },
      { user: 'B', loading: false, error: null },
    );

    firstSessionRead.resolve({ data: { session: session('A') }, error: null });
    await act(async () => { await flushMicrotasks(); });
    assert.equal(app.current().user?.uid, 'B');
    assert.deepEqual(accountReads, ['B'], 'the timed-out hydration must never start an Account A query');
  });

  test('a newer INITIAL_SESSION owns loading until its account lookup finishes', async (context) => {
    const accountA = deferred<AccountResult>();
    const accountB = deferred<AccountResult>();
    context.mock.method(auth, 'getSession', async () => ({
      data: { session: session('A') },
      error: null,
    }));
    const events = installAuthListener(context);
    installAccountResolver(context, (uid) => {
      if (uid === 'A') return accountA.promise;
      if (uid === 'B') return accountB.promise;
      throw new Error(`unexpected account lookup: ${uid}`);
    });
    context.mock.method(auth, 'signOut', async () => ({ error: null }));

    const app = await mountProvider(context, true);
    assert.equal(app.current().loading, true);

    await act(async () => {
      events.emit('INITIAL_SESSION', session('B'));
      await flushMicrotasks();
    });
    await advance(context, 0);

    accountA.resolve({ data: account('A'), error: null });
    await act(async () => { await flushMicrotasks(); });
    assert.equal(app.current().user, null);
    assert.equal(app.current().loading, true, 'stale hydration finally must not reveal protected children');

    accountB.resolve({ data: account('B'), error: null });
    await act(async () => { await flushMicrotasks(); });
    assert.equal(app.current().user?.uid, 'B');
    assert.equal(app.current().loading, false);
  });

  test('account switches mask the old identity and stale loads cannot overwrite the winner', async (context) => {
    const accountB = deferred<AccountResult>();
    context.mock.method(auth, 'getSession', async () => ({
      data: { session: session('A') },
      error: null,
    }));
    const events = installAuthListener(context);
    installAccountResolver(context, (uid) => {
      if (uid === 'B') return accountB.promise;
      return { data: account(uid), error: null };
    });
    context.mock.method(auth, 'signOut', async () => ({ error: null }));

    const app = await mountProvider(context, true);
    assert.equal(app.current().user?.uid, 'A');

    await act(async () => {
      events.emit('SIGNED_IN', session('B'));
      await flushMicrotasks();
    });
    assert.equal(app.current().user, null, 'Account A must disappear before Account B data starts');
    assert.equal(app.current().loading, true);
    await advance(context, 0);

    await act(async () => {
      events.emit('SIGNED_IN', session('C'));
      await flushMicrotasks();
    });
    await advance(context, 0);
    assert.equal(app.current().user?.uid, 'C');
    assert.equal(app.current().loading, false);

    accountB.resolve({ data: account('B'), error: null });
    await act(async () => { await flushMicrotasks(); });
    assert.equal(app.current().user?.uid, 'C', 'late Account B data must not replace Account C');
  });

  test('confirmed account revocation survives GoTrue SIGNED_OUT as an actionable terminal state', async (context) => {
    let accountReads = 0;
    context.mock.method(auth, 'getSession', async () => ({
      data: { session: session('A') },
      error: null,
    }));
    const events = installAuthListener(context);
    installAccountResolver(context, () => {
      accountReads += 1;
      if (accountReads === 1) return { data: account('A'), error: null };
      return { data: null, error: null };
    });
    context.mock.method(auth, 'signOut', async () => {
      events.emit('SIGNED_OUT', null);
      return { error: null };
    });

    const app = await mountProvider(context, true);
    assert.equal(app.current().user?.uid, 'A');

    await act(async () => {
      events.emit('TOKEN_REFRESHED', session('A'));
      await flushMicrotasks();
    });
    await advance(context, 0);
    await advance(context, 400);

    assert.equal(app.current().user, null);
    assert.equal(app.current().loading, false);
    assert.equal(app.current().sessionErrorKind, 'ended');
    assert.match(app.current().sessionError ?? '', /account is no longer available/i);
  });

  test('failed remote sign-out clears cookies and cross-account browser state locally', async (context) => {
    let sessionReads = 0;
    context.mock.method(auth, 'getSession', async () => {
      sessionReads += 1;
      return sessionReads === 1
        ? { data: { session: session('A') }, error: null }
        : { data: { session: null }, error: null };
    });
    installAuthListener(context);
    installAccountResolver(context, () => ({ data: account('A'), error: null }));
    const signOutScopes: Array<SignOutOptions | undefined> = [];
    context.mock.method(auth, 'signOut', async (options?: SignOutOptions) => {
      signOutScopes.push(options);
      return options?.scope === 'local'
        ? { error: null }
        : { error: new Error('logout endpoint unavailable') };
    });
    context.mock.method(console, 'warn', () => {});

    const app = await mountProvider(context);
    assert.equal(app.current().user?.uid, 'A');

    document.cookie = 'sb-placeholder-auth-token=base; Path=/';
    document.cookie = 'sb-placeholder-auth-token.0=chunk; Path=/';
    document.cookie = 'unrelated-cookie=keep; Path=/';
    localStorage.setItem('hotelops-account', 'old-account');
    localStorage.setItem('staxis-auth', 'old-session');
    localStorage.setItem('hotelops-active-property', 'property-A');
    sessionStorage.setItem('hotelops-session-selected', '1');

    await act(async () => { await app.current().signOut(); });

    assert.equal(app.current().user, null);
    assert.deepEqual(signOutScopes, [undefined, { scope: 'local' }]);
    assert.doesNotMatch(document.cookie, /sb-placeholder-auth-token/);
    assert.match(document.cookie, /unrelated-cookie=keep/);
    assert.equal(localStorage.getItem('hotelops-account'), null);
    assert.equal(localStorage.getItem('staxis-auth'), null);
    assert.equal(localStorage.getItem('hotelops-active-property'), null);
    assert.equal(sessionStorage.getItem('hotelops-session-selected'), null);
  });

  test('fresh-sign-in recovery clears hydrated and late sessions without global logout, then allows B', async (context) => {
    context.mock.method(auth, 'getSession', async () => ({
      data: { session: session('A', 'ambiguous-A') },
      error: null,
    }));
    const events = installAuthListener(context);
    installAccountResolver(context, (uid) => ({ data: account(uid), error: null }));
    const signOutScopes: Array<SignOutOptions | undefined> = [];
    context.mock.method(auth, 'signOut', async (options?: SignOutOptions) => {
      signOutScopes.push(options);
      return { error: null };
    });
    context.mock.method(auth, 'signInWithPassword', async () => {
      const accepted = session('B', 'explicit-B');
      return {
        data: { session: accepted, user: accepted.user },
        error: null,
      };
    });

    const app = await mountProvider(context, true);
    assert.equal(app.current().user?.uid, 'A');
    document.cookie = 'sb-placeholder-auth-token=ambiguous-A; Path=/';

    await act(async () => { await app.current().resetForFreshSignIn(); });
    assert.equal(app.current().user, null);
    assert.doesNotMatch(document.cookie, /sb-placeholder-auth-token/);
    assert.deepEqual(signOutScopes, [], 'recovery must never revoke other browser/device sessions');

    // A can still arrive after the first recovery pass (cross-tab event or a
    // late persistence observer). The Sign In recovery hook calls this same
    // reset again before it permits a new password attempt.
    await act(async () => {
      events.emit('SIGNED_IN', session('A', 'late-A'));
      await flushMicrotasks();
    });
    await advance(context, 0);
    assert.equal(app.current().user?.uid, 'A');

    await act(async () => { await app.current().resetForFreshSignIn(); });
    assert.equal(app.current().user, null);

    let result!: AuthSignInResult;
    await act(async () => {
      result = await app.current().signIn('b@example.test', 'password-B');
      await flushMicrotasks();
    });
    assert.equal(result.error, null);
    assert.equal(result.session?.refresh_token, 'refresh-explicit-B');
    assert.equal(app.current().user?.uid, 'B');
    assert.deepEqual(signOutScopes, []);
  });

  test('an accepted password with no account row cannot leave a browser session behind', async (context) => {
    context.mock.method(auth, 'getSession', async () => ({
      data: { session: null },
      error: null,
    }));
    installAuthListener(context);
    installAccountResolver(context, () => ({ data: null, error: null }));
    context.mock.method(auth, 'signInWithPassword', async () => {
      const accepted = session('A');
      return {
        data: { session: accepted, user: accepted.user },
        error: null,
      };
    });
    const signOutScopes: Array<SignOutOptions | undefined> = [];
    context.mock.method(auth, 'signOut', async (options?: SignOutOptions) => {
      signOutScopes.push(options);
      return { error: null };
    });

    const app = await mountProvider(context, true);
    document.cookie = 'sb-placeholder-auth-token=half-session; Path=/';

    const pending = app.current().signIn('a@example.test', 'password');
    await act(async () => { await flushMicrotasks(); });
    await advance(context, 400);
    let result!: AuthSignInResult;
    await act(async () => {
      result = await pending;
      await flushMicrotasks();
    });

    assert.match(result.error ?? '', /no account record/i);
    assert.equal(result.session, null);
    assert.equal(app.current().user, null);
    assert.deepEqual(signOutScopes, [], 'temporary session cleanup must never globally sign out');
    assert.doesNotMatch(document.cookie, /sb-placeholder-auth-token/);
  });

  test('listener and eager login hydration join one account read and settle loading', async (context) => {
    const sharedAccountRead = deferred<AccountResult>();
    let accountReads = 0;
    context.mock.method(auth, 'getSession', async () => ({
      data: { session: null },
      error: null,
    }));
    const events = installAuthListener(context);
    installAccountResolver(context, () => {
      accountReads += 1;
      return sharedAccountRead.promise;
    });
    const signOutScopes: Array<SignOutOptions | undefined> = [];
    context.mock.method(auth, 'signOut', async (options?: SignOutOptions) => {
      signOutScopes.push(options);
      return { error: null };
    });
    context.mock.method(auth, 'signInWithPassword', async () => {
      const accepted = session('A', 'attempt-A');
      events.emit('SIGNED_IN', accepted);
      return {
        data: { session: accepted, user: accepted.user },
        error: null,
      };
    });
    const app = await mountProvider(context, true);
    let pending!: Promise<AuthSignInResult>;
    await act(async () => {
      pending = app.current().signIn('a@example.test', 'password');
      await flushMicrotasks();
    });
    assert.equal(accountReads, 1, 'the eager account read should start');

    await advance(context, 0);
    assert.equal(accountReads, 1, 'the auth listener must join the in-flight account read');
    assert.equal(app.current().loading, true);

    let result!: AuthSignInResult;
    await act(async () => {
      sharedAccountRead.resolve({ data: account('A'), error: null });
      result = await pending;
      await flushMicrotasks();
    });

    assert.equal(result.error, null);
    assert.equal(result.session?.refresh_token, 'refresh-attempt-A');
    assert.equal(app.current().user?.uid, 'A');
    assert.equal(app.current().loading, false);
    assert.deepEqual(signOutScopes, []);
  });

  test('eager sign-in success clears loading even when the listener task is timer-clamped', async (context) => {
    context.mock.method(auth, 'getSession', async () => ({ data: { session: null }, error: null }));
    const events = installAuthListener(context);
    installAccountResolver(context, () => ({ data: account('A'), error: null }));
    context.mock.method(auth, 'signOut', async () => ({ error: null }));
    context.mock.method(auth, 'signInWithPassword', async () => {
      const accepted = session('A', 'foreground-attempt');
      events.emit('SIGNED_IN', accepted);
      return { data: { session: accepted, user: accepted.user }, error: null };
    });

    const app = await mountProvider(context, true);
    let result!: AuthSignInResult;
    await act(async () => {
      result = await app.current().signIn('a@example.test', 'password');
      await flushMicrotasks();
    });

    assert.equal(result.error, null);
    assert.equal(app.current().user?.uid, 'A');
    assert.equal(app.current().loading, false, 'eager success is terminal without waiting for a timer task');
  });

  test('attempt-owned discard cannot clear a newer session for the same account', async (context) => {
    const original = session('A', 'attempt-old');
    const winner = session('A', 'attempt-new');
    context.mock.method(auth, 'getSession', async () => ({
      data: { session: original },
      error: null,
    }));
    const events = installAuthListener(context);
    installAccountResolver(context, () => ({ data: account('A'), error: null }));
    const signOutScopes: Array<SignOutOptions | undefined> = [];
    context.mock.method(auth, 'signOut', async (options?: SignOutOptions) => {
      signOutScopes.push(options);
      return { error: null };
    });

    const app = await mountProvider(context, true);
    assert.equal(app.current().user?.uid, 'A');

    await act(async () => {
      events.emit('SIGNED_IN', winner);
      await flushMicrotasks();
    });
    await advance(context, 0);

    const discarded = app.current().discardAuthSession(original);
    assert.equal(discarded, false);
    assert.equal(app.current().user?.uid, 'A');
    assert.deepEqual(signOutScopes, []);
  });

  test('a synchronous in-flight guard prevents overlapping password attempts', async (context) => {
    const firstAttempt = deferred<Awaited<ReturnType<AuthSurface['signInWithPassword']>>>();
    let signInCalls = 0;
    context.mock.method(auth, 'getSession', async () => ({ data: { session: null }, error: null }));
    installAuthListener(context);
    installAccountResolver(context, () => ({ data: account('A'), error: null }));
    context.mock.method(auth, 'signOut', async () => ({ error: null }));
    context.mock.method(auth, 'signInWithPassword', () => {
      signInCalls += 1;
      return firstAttempt.promise;
    });

    const app = await mountProvider(context);
    const first = app.current().signIn('a@example.test', 'password');
    const second = await app.current().signIn('b@example.test', 'password');

    assert.match(second.error ?? '', /already in progress/i);
    assert.equal(second.session, null);
    assert.equal(signInCalls, 1);

    firstAttempt.resolve({
      data: { session: null, user: null },
      error: { message: 'Invalid login credentials' },
    });
    await first;
  });

  test('a timed-out password attempt makes this provider terminal and late A cannot corrupt retry B', async (context) => {
    const attemptA = deferred<Awaited<ReturnType<AuthSurface['signInWithPassword']>>>();
    let signInCalls = 0;
    let accountReads = 0;
    context.mock.method(auth, 'getSession', async () => ({ data: { session: null }, error: null }));
    const events = installAuthListener(context);
    installAccountResolver(context, (uid) => {
      accountReads += 1;
      return { data: account(uid), error: null };
    });
    const signOutScopes: Array<SignOutOptions | undefined> = [];
    context.mock.method(auth, 'signOut', async (options?: SignOutOptions) => {
      signOutScopes.push(options);
      return { error: null };
    });
    context.mock.method(auth, 'signInWithPassword', () => {
      signInCalls += 1;
      return attemptA.promise;
    });
    context.mock.method(console, 'error', () => {});

    const app = await mountProvider(context, true);
    const first = app.current().signIn('a@example.test', 'password-A');

    await advance(context, AUTH_SESSION_OPERATION_TIMEOUT_MS);
    const firstResult = await first;
    assert.equal(firstResult.requiresFreshSignin, true);
    assert.match(firstResult.error ?? '', /fresh sign-in/i);

    // The form may finish its outer wait, but this provider must not start B
    // while the uncancellable SDK operation for A can still write a session.
    const retryB = await app.current().signIn('b@example.test', 'password-B');
    assert.equal(retryB.requiresFreshSignin, true);
    assert.equal(signInCalls, 1, 'retry B must not reach GoTrue in the ambiguous provider lifetime');

    const lateA = session('A', 'late-attempt-A');
    document.cookie = 'sb-placeholder-auth-token=late-A; Path=/';
    await act(async () => {
      // Supabase publishes SIGNED_IN while its method is settling. The exact
      // late-session observer must invalidate that event before its deferred
      // account read can commit anything.
      events.emit('SIGNED_IN', lateA);
      attemptA.resolve({ data: { session: lateA, user: lateA.user }, error: null });
      await flushMicrotasks(8);
    });
    await advance(context, 0);

    assert.equal(app.current().user, null);
    assert.equal(app.current().loading, false);
    assert.equal(accountReads, 0, 'late Attempt A must not hydrate an account after exact discard');
    assert.doesNotMatch(document.cookie, /sb-placeholder-auth-token/);
    assert.deepEqual(signOutScopes, [], 'late-attempt cleanup must not revoke a different browser session');
  });
});
