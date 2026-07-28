import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { JSDOM } from 'jsdom';
import React, { act, useEffect, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { shouldAutoRedirectExistingSession } from '@/lib/auth/signin-navigation-policy';
import {
  useFreshSignInRecovery,
  type FreshSignInRecoveryState,
} from '@/lib/auth/use-fresh-signin-recovery';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

interface ProbeProps {
  authLoading: boolean;
  hasUser: boolean;
  attemptInFlight: boolean;
}

interface RecoverySnapshot {
  state: FreshSignInRecoveryState;
  ready: boolean;
  submit: () => Promise<boolean>;
}

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
    url: 'http://localhost/signin?reason=auth-retry',
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

describe('fresh Sign In recovery', { concurrency: false }, () => {
  test('late Session A never redirects, is reset again, and explicit Attempt B can start', async () => {
    const restoreBrowser = installBrowser();
    const container = document.createElement('div');
    document.body.append(container);
    const root: Root = createRoot(container);
    const resets: Array<Deferred<void>> = [];
    let latest: RecoverySnapshot | null = null;
    let redirects = 0;
    let explicitBAttempts = 0;

    const current = (): RecoverySnapshot => {
      assert.ok(latest, 'recovery probe must have rendered');
      return latest as RecoverySnapshot;
    };

    const resetLocalSession = () => {
      const reset = deferred<void>();
      resets.push(reset);
      return reset.promise;
    };

    function Probe(props: ProbeProps) {
      const explicitAttemptStartedRef = useRef(false);
      const recovery = useFreshSignInRecovery({
        required: true,
        authLoading: props.authLoading,
        hasUser: props.hasUser,
        attemptInFlight: props.attemptInFlight,
        resetLocalSession,
      });

      useEffect(() => {
        if (shouldAutoRedirectExistingSession({
          handoffResolved: true,
          explicitAttemptStarted: explicitAttemptStartedRef.current,
          freshRetry: true,
          loading: props.authLoading,
          hasUser: props.hasUser,
          signing: false,
        })) redirects += 1;
      }, [props.authLoading, props.hasUser]);

      latest = {
        state: recovery.state,
        ready: recovery.ready,
        submit: async () => {
          if (!recovery.ready) return false;
          const reset = await recovery.resetBeforeSubmit();
          if (!reset) return false;
          explicitAttemptStartedRef.current = true;
          explicitBAttempts += 1;
          return true;
        },
      };
      return null;
    }

    const render = async (props: ProbeProps) => {
      await act(async () => {
        root.render(<Probe {...props} />);
        await flushMicrotasks();
      });
    };

    try {
      // The fresh document hydrates the late ambiguous Session A. It must be
      // reset rather than treated as an ordinary existing login.
      await render({ authLoading: false, hasUser: true, attemptInFlight: false });
      assert.equal(resets.length, 1);
      assert.equal(current().state, 'resetting');
      assert.equal(current().ready, false);
      assert.equal(redirects, 0);

      await act(async () => {
        root.render(<Probe authLoading={false} hasUser={false} attemptInFlight={false} />);
        resets[0].resolve();
        await flushMicrotasks();
      });
      assert.equal(current().state, 'ready');
      assert.equal(current().ready, true);

      // Session A appears again after the first pass. Recovery becomes
      // non-interactive immediately and runs the same reset a second time.
      await render({ authLoading: false, hasUser: true, attemptInFlight: false });
      assert.equal(resets.length, 2);
      assert.equal(current().state, 'resetting');
      assert.equal(current().ready, false);
      assert.equal(redirects, 0);

      await act(async () => {
        root.render(<Probe authLoading={false} hasUser={false} attemptInFlight={false} />);
        resets[1].resolve();
        await flushMicrotasks();
      });
      assert.equal(current().ready, true);

      // The click boundary performs one final reset. Only after it settles is
      // the explicit-attempt latch set and Attempt B permitted to start.
      let submit!: Promise<boolean>;
      await act(async () => {
        submit = current().submit();
        await flushMicrotasks();
      });
      assert.equal(resets.length, 3);
      assert.equal(current().ready, false);
      assert.equal(explicitBAttempts, 0);

      let submitted = false;
      await act(async () => {
        resets[2].resolve();
        submitted = await submit;
        await flushMicrotasks();
      });
      assert.equal(submitted, true);
      assert.equal(explicitBAttempts, 1);

      // B's own SIGNED_IN state is owned by the active explicit attempt and
      // must not be mistaken for another late A event. It is synchronously
      // non-ready, but no fourth reset starts while B is in flight.
      await render({ authLoading: false, hasUser: true, attemptInFlight: true });
      assert.equal(resets.length, 3);
      assert.equal(current().ready, false);
      assert.equal(redirects, 0);

      // If B ends/fails without leaving this page, the permanent redirect
      // latch remains set, but recovery resumes. A remaining/later session is
      // masked in the very render that ends the attempt and reset again.
      await render({ authLoading: false, hasUser: true, attemptInFlight: false });
      assert.equal(current().ready, false);
      assert.equal(resets.length, 4);
      assert.equal(redirects, 0);

      await act(async () => {
        root.render(<Probe authLoading={false} hasUser={false} attemptInFlight={false} />);
        resets[3].resolve();
        await flushMicrotasks();
      });
      assert.equal(current().ready, true);
    } finally {
      await act(async () => { root.unmount(); });
      container.remove();
      restoreBrowser();
    }
  });
});
