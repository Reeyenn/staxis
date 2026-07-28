import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, test, type TestContext } from 'node:test';

import { JSDOM } from 'jsdom';
import React, { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import type {
  ReliableNavigation,
  ReliableNavigationRouter,
} from '@/lib/hooks/use-reliable-navigation';

type NavigationModule = typeof import('@/lib/hooks/use-reliable-navigation');

const DOM_GLOBALS = [
  'window',
  'document',
  'navigator',
  'Element',
  'HTMLElement',
  'HTMLAnchorElement',
  'Node',
  'Event',
  'EventTarget',
  'MutationObserver',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'getComputedStyle',
] as const;

let navigationModulePromise: Promise<NavigationModule> | null = null;

/** The Node client-test runner does not transform CSS modules. Install the
 * narrow loader only while importing the production provider; rendered class
 * names are irrelevant to this state-machine regression.
 */
function loadNavigationModule(): Promise<NavigationModule> {
  if (navigationModulePromise) return navigationModulePromise;

  const nodeRequire = createRequire(import.meta.url);
  const extensions = nodeRequire.extensions as Record<
    string,
    (module: NodeModule, filename: string) => void
  >;
  const originalCssLoader = extensions['.css'];
  extensions['.css'] = (module) => { module.exports = {}; };
  navigationModulePromise = import('@/lib/hooks/use-reliable-navigation')
    .finally(() => {
      if (originalCssLoader) extensions['.css'] = originalCssLoader;
      else delete extensions['.css'];
    });
  return navigationModulePromise;
}

function installBrowser(pathname: string): () => void {
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

async function flushMicrotasks(rounds = 6): Promise<void> {
  for (let index = 0; index < rounds; index += 1) await Promise.resolve();
}

type RouterCalls = {
  push: string[];
  replace: string[];
  prefetch: string[];
  refresh: number;
  documentNavigate: string[];
};

async function mountNavigation(
  context: TestContext,
  initialPathname: string,
): Promise<{
  current(): ReliableNavigation;
  calls: RouterCalls;
  setPathname(pathname: string): Promise<void>;
  markDestinationReady(pathname: string): Promise<void>;
}> {
  const restoreBrowser = installBrowser(initialPathname);
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const navigation = await loadNavigationModule();
  const calls: RouterCalls = {
    push: [],
    replace: [],
    prefetch: [],
    refresh: 0,
    documentNavigate: [],
  };
  const router: ReliableNavigationRouter = {
    push: (href) => { calls.push.push(href); },
    replace: (href) => { calls.replace.push(href); },
    prefetch: (href) => { calls.prefetch.push(href); },
    refresh: () => { calls.refresh += 1; },
  };

  const container = document.createElement('div');
  document.body.append(container);
  const root: Root = createRoot(container);
  let latest: ReliableNavigation | null = null;
  let updatePathname!: React.Dispatch<React.SetStateAction<string>>;
  let updateReadyPathname!: React.Dispatch<React.SetStateAction<string | null>>;

  function Probe() {
    latest = navigation.useReliableNavigation();
    return null;
  }

  function ReadyDestination({ pathname }: { pathname: string }) {
    navigation.useNavigationReadyPathname(pathname);
    return null;
  }

  function Harness() {
    const [pathname, setPathname] = useState(initialPathname);
    const [readyPathname, setReadyPathname] = useState<string | null>(null);
    updatePathname = setPathname;
    updateReadyPathname = setReadyPathname;
    return (
      <navigation.ReliableNavigationRuntimeProvider
        router={router}
        pathname={pathname}
        lang="en"
        documentNavigate={(href) => { calls.documentNavigate.push(href); }}
      >
        <Probe />
        {readyPathname ? <ReadyDestination pathname={readyPathname} /> : null}
      </navigation.ReliableNavigationRuntimeProvider>
    );
  }

  await act(async () => {
    root.render(<Harness />);
    await flushMicrotasks();
  });

  context.after(async () => {
    await act(async () => { root.unmount(); });
    container.remove();
    context.mock.timers.reset();
    restoreBrowser();
  });

  return {
    current() {
      assert.ok(latest, 'navigation probe must have rendered');
      return latest;
    },
    calls,
    async setPathname(pathname) {
      await act(async () => {
        updatePathname(pathname);
        await flushMicrotasks();
      });
    },
    async markDestinationReady(pathname) {
      await act(async () => {
        updateReadyPathname(pathname);
        await flushMicrotasks();
      });
    },
  };
}

async function invoke(action: () => void): Promise<void> {
  await act(async () => {
    action();
    await flushMicrotasks();
  });
}

async function advance(context: TestContext, milliseconds: number): Promise<void> {
  await act(async () => {
    context.mock.timers.tick(milliseconds);
    await flushMicrotasks();
  });
}

describe('ReliableNavigationProvider watchdog behavior', { concurrency: false }, () => {
  test('a committed URL that never renders fails terminally, retries fresh, and can escape directly', async (context) => {
    const navigation = await loadNavigationModule();
    const app = await mountNavigation(context, '/home');

    await invoke(() => {
      app.current().push('/inventory');
      app.current().push('/inventory');
    });
    assert.deepEqual(app.calls.push, ['/inventory'], 'rapid duplicate taps share one attempt');
    assert.equal(app.current().pendingHref, '/inventory');

    window.history.pushState({}, '', '/inventory');
    await app.setPathname('/inventory');
    await advance(context, navigation.NAVIGATION_COMMIT_TIMEOUT_MS - 1);
    assert.equal(app.current().failure, null, 'the watchdog remains bounded, not premature');
    await advance(context, 1);
    assert.deepEqual(app.current().failure, {
      href: '/inventory',
      mode: 'push',
      attempt: 1,
      sourcePathname: '/home',
      trigger: 'hook',
    });
    assert.match(document.body.textContent ?? '', /This page is taking too long/);

    await invoke(() => app.current().retry());
    assert.equal(app.current().failure, null);
    assert.equal(app.current().pendingHref, '/inventory');
    assert.equal(app.calls.refresh, 1, 'a committed destination retry refreshes instead of no-op pushing');

    await advance(context, navigation.NAVIGATION_COMMIT_TIMEOUT_MS);
    assert.equal(app.current().failure?.attempt, 2, 'retry owns a fresh bounded attempt');
    await invoke(() => app.current().openDirectly());
    assert.deepEqual(app.calls.documentNavigate, ['/inventory']);

    await invoke(() => app.current().retry());
    assert.equal(app.calls.refresh, 2);
    await app.markDestinationReady('/inventory');
    assert.equal(app.current().pendingHref, null);
    assert.equal(app.current().failure, null);
    assert.doesNotMatch(document.body.textContent ?? '', /This page is taking too long/);
    await advance(context, navigation.NAVIGATION_COMMIT_TIMEOUT_MS);
    assert.equal(app.current().failure, null, 'destination readiness cancels the active watchdog');
  });

  test('back/forward arms the same watchdog without starting a duplicate router transition', async (context) => {
    const navigation = await loadNavigationModule();
    const app = await mountNavigation(context, '/dashboard');

    window.history.pushState({}, '', '/staff?from=history');
    await invoke(() => window.dispatchEvent(new window.PopStateEvent('popstate')));
    assert.equal(app.current().pendingHref, '/staff?from=history');
    assert.deepEqual(app.calls.push, []);
    assert.deepEqual(app.calls.replace, []);

    await advance(context, navigation.NAVIGATION_COMMIT_TIMEOUT_MS);
    assert.deepEqual(app.current().failure, {
      href: '/staff?from=history',
      mode: 'replace',
      attempt: 1,
      sourcePathname: '/dashboard',
      trigger: 'history',
    });

    await invoke(() => app.current().retry());
    assert.deepEqual(app.calls.replace, ['/staff?from=history']);
    assert.equal(app.current().failure, null);
    window.history.replaceState({}, '', '/staff?from=history');
    await app.setPathname('/staff');
    await app.markDestinationReady('/staff');
    assert.equal(app.current().pendingHref, null);
  });
});
