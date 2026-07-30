/**
 * The focus-teardown bug, pinned at its source.
 *
 * `useAuthorizationRefreshKey` used to return ONE key that changed at every
 * browser boundary. PropertyContext both stamps its retained hotel list with
 * that key and masks anything not matching it, so a single window focus blanked
 * the hotel list, nulled the active hotel, flipped the shell back to loading and
 * remounted every consumer keyed on it. Hotel staff click back into the tab all
 * shift long, so they watched the page blank and refetch all day.
 *
 * The two concerns are now separate values and THAT is what these tests hold
 * still:
 *
 *   - `authorizationKey` is what consumers mask on. A browser boundary must
 *     NEVER move it, or the teardown is back.
 *   - `revalidationToken` is what consumers reload on. A browser boundary MUST
 *     move it, or coverage silently goes stale and a revoked company hat keeps
 *     working until a hard refresh.
 *   - an authoritative same-tab grant/revoke moves BOTH — it is real new
 *     information, so masking immediately is correct and must survive.
 */

import assert from 'node:assert/strict';
import { describe, test, type TestContext } from 'node:test';

import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import {
  notifyAuthorizationChanged,
  useAuthorizationRefreshKey,
  type AuthorizationRefreshKey,
} from '@/lib/hooks/use-authorization-refresh-key';

const REFRESH_DEDUP_MS = 250;

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

async function flushMicrotasks(rounds = 8): Promise<void> {
  for (let index = 0; index < rounds; index += 1) await Promise.resolve();
}

interface Probe {
  current(): AuthorizationRefreshKey;
  /** Runs `fire` inside act() and reports the key before and after. */
  boundary(fire: () => void): Promise<{
    before: AuthorizationRefreshKey;
    after: AuthorizationRefreshKey;
  }>;
  rerender(identityKey: string | null, enabled?: boolean): Promise<void>;
}

async function mountProbe(
  context: TestContext,
  identityKey: string | null,
  enabled = true,
): Promise<Probe> {
  const restoreBrowser = installBrowser();
  const container = document.createElement('div');
  document.body.append(container);
  const root: Root = createRoot(container);
  let latest: AuthorizationRefreshKey | null = null;

  function Harness(props: { identityKey: string | null; enabled: boolean }) {
    latest = useAuthorizationRefreshKey(props.identityKey, props.enabled);
    return null;
  }

  async function rerender(nextIdentityKey: string | null, nextEnabled = true): Promise<void> {
    await act(async () => {
      root.render(<Harness identityKey={nextIdentityKey} enabled={nextEnabled} />);
      await flushMicrotasks();
    });
  }

  await rerender(identityKey, enabled);

  context.after(async () => {
    await act(async () => { root.unmount(); });
    container.remove();
    restoreBrowser();
  });

  const current = (): AuthorizationRefreshKey => {
    assert.ok(latest, 'the probe never rendered');
    return latest;
  };

  return {
    current,
    rerender,
    async boundary(fire: () => void) {
      const before = current();
      await act(async () => {
        fire();
        await flushMicrotasks();
      });
      return { before, after: current() };
    },
  };
}

const IDENTITY = 'uid-1:acct-1:general_manager:pid-a:legacy-shell';

describe('authorization refresh key — a browser boundary must not re-key', () => {
  test('window focus revalidates without moving the key consumers mask on', async (t) => {
    const probe = await mountProbe(t, IDENTITY);

    const { before, after } = await probe.boundary(() => {
      window.dispatchEvent(new Event('focus'));
    });

    assert.equal(
      after.authorizationKey,
      before.authorizationKey,
      'a refocus must not mask the coverage already on screen',
    );
    assert.equal(
      after.revalidationToken,
      before.revalidationToken + 1,
      'a refocus must still ask consumers to re-check coverage',
    );
  });

  test('returning to a hidden tab revalidates without re-keying', async (t) => {
    const probe = await mountProbe(t, IDENTITY);
    let visibility = 'visible';
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => visibility,
    });

    await probe.boundary(() => {
      visibility = 'hidden';
      document.dispatchEvent(new Event('visibilitychange'));
    });
    const { before, after } = await probe.boundary(() => {
      visibility = 'visible';
      document.dispatchEvent(new Event('visibilitychange'));
    });

    assert.equal(after.authorizationKey, before.authorizationKey);
    assert.equal(after.revalidationToken, before.revalidationToken + 1);
  });

  test('network recovery revalidates without re-keying', async (t) => {
    const probe = await mountProbe(t, IDENTITY);

    const { before, after } = await probe.boundary(() => {
      window.dispatchEvent(new Event('online'));
    });

    assert.equal(after.authorizationKey, before.authorizationKey);
    assert.equal(after.revalidationToken, before.revalidationToken + 1);
  });

  test('a bfcache restore revalidates, an ordinary pageshow does not', async (t) => {
    const probe = await mountProbe(t, IDENTITY);

    const fresh = await probe.boundary(() => {
      const event = new Event('pageshow') as Event & { persisted?: boolean };
      Object.defineProperty(event, 'persisted', { value: false });
      window.dispatchEvent(event);
    });
    assert.equal(
      fresh.after.revalidationToken,
      fresh.before.revalidationToken,
      'a normal load is not a restore boundary',
    );

    const restored = await probe.boundary(() => {
      const event = new Event('pageshow') as Event & { persisted?: boolean };
      Object.defineProperty(event, 'persisted', { value: true });
      window.dispatchEvent(event);
    });
    assert.equal(restored.after.revalidationToken, restored.before.revalidationToken + 1);
    assert.equal(restored.after.authorizationKey, restored.before.authorizationKey);
  });
});

describe('authorization refresh key — real access changes still mask instantly', () => {
  test('a same-tab grant or revoke moves the key AND the token', async (t) => {
    const probe = await mountProbe(t, IDENTITY);

    const { before, after } = await probe.boundary(() => {
      notifyAuthorizationChanged();
    });

    assert.notEqual(
      after.authorizationKey,
      before.authorizationKey,
      'an authoritative access change must mask stale coverage immediately',
    );
    assert.equal(after.revalidationToken, before.revalidationToken + 1);
  });

  test('an authoritative change is never swallowed by the focus debounce', async (t) => {
    const probe = await mountProbe(t, IDENTITY);

    await probe.boundary(() => { window.dispatchEvent(new Event('focus')); });
    const { before, after } = await probe.boundary(() => { notifyAuthorizationChanged(); });

    assert.notEqual(after.authorizationKey, before.authorizationKey);
    assert.equal(after.revalidationToken, before.revalidationToken + 1);
  });

  test('a changed identity re-keys on its own', async (t) => {
    const probe = await mountProbe(t, IDENTITY);
    const before = probe.current();

    await probe.rerender('uid-2:acct-2:owner:pid-b:legacy-shell');

    assert.notEqual(probe.current().authorizationKey, before.authorizationKey);
    assert.match(probe.current().authorizationKey ?? '', /^uid-2:acct-2:owner:pid-b:legacy-shell:/);
  });

  test('a signed-out viewer has no key at all', async (t) => {
    const probe = await mountProbe(t, null);

    assert.equal(probe.current().authorizationKey, null);
    assert.equal(probe.current().refreshKey, null);
  });
});

describe('authorization refresh key — the debounce and the strict key', () => {
  test('a burst of boundaries inside the debounce window revalidates once', async (t) => {
    const probe = await mountProbe(t, IDENTITY);
    const before = probe.current();

    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      window.dispatchEvent(new Event('focus'));
      window.dispatchEvent(new Event('online'));
      await flushMicrotasks();
    });

    assert.equal(
      probe.current().revalidationToken,
      before.revalidationToken + 1,
      'focus/blur drumming must not fan out into a burst of refetches',
    );
  });

  test('the debounce expires, so a later boundary revalidates again', async (t) => {
    const probe = await mountProbe(t, IDENTITY);

    const first = await probe.boundary(() => { window.dispatchEvent(new Event('focus')); });
    await new Promise((resolve) => setTimeout(resolve, REFRESH_DEDUP_MS + 20));
    const second = await probe.boundary(() => { window.dispatchEvent(new Event('focus')); });

    assert.equal(first.after.revalidationToken, first.before.revalidationToken + 1);
    assert.equal(second.after.revalidationToken, second.before.revalidationToken + 1);
    assert.equal(second.after.authorizationKey, first.after.authorizationKey);
  });

  test('a disabled hook ignores every boundary', async (t) => {
    const probe = await mountProbe(t, IDENTITY, false);

    const { before, after } = await probe.boundary(() => {
      window.dispatchEvent(new Event('focus'));
      notifyAuthorizationChanged();
    });

    assert.equal(after.authorizationKey, before.authorizationKey);
    assert.equal(after.revalidationToken, before.revalidationToken);
  });

  test('refreshKey is the strict variant: it moves at every boundary', async (t) => {
    const probe = await mountProbe(t, IDENTITY);

    const { before, after } = await probe.boundary(() => {
      window.dispatchEvent(new Event('focus'));
    });

    assert.notEqual(
      after.refreshKey,
      before.refreshKey,
      'the property selector relies on this dropping its payload at every restore',
    );
    assert.equal(after.authorizationKey, before.authorizationKey);
  });
});
