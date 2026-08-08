import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';

import { AppRouterContext, type AppRouterInstance } from 'next/dist/shared/lib/app-router-context.shared-runtime';
import { PathParamsContext } from 'next/dist/shared/lib/hooks-client-context.shared-runtime';

const TOKEN = 'invite-token-for-tests';

const DOM_GLOBALS = [
  'window', 'document', 'navigator', 'Element', 'HTMLElement', 'HTMLInputElement',
  'HTMLButtonElement', 'HTMLFormElement', 'Node', 'Event', 'InputEvent', 'MouseEvent',
  'MutationObserver', 'requestAnimationFrame', 'cancelAnimationFrame', 'getComputedStyle',
] as const;

function installBrowser(): () => void {
  const dom = new JSDOM('<!doctype html><html><body /></html>', {
    pretendToBeVisual: true,
    url: `http://localhost/invite/${TOKEN}`,
  });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const key of DOM_GLOBALS) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    const candidate = dom.window[key as keyof typeof dom.window];
    const value = typeof candidate === 'function'
      && (key === 'requestAnimationFrame' || key === 'cancelAnimationFrame' || key === 'getComputedStyle')
      ? candidate.bind(dom.window)
      : candidate;
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  originals.set('IS_REACT_ACT_ENVIRONMENT', Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT'));
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, writable: true, value: true });
  return () => {
    dom.window.close();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  };
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 18; index += 1) await Promise.resolve();
  });
}

async function setValue(element: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  assert.ok(setter);
  await act(async () => {
    setter.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    for (let index = 0; index < 6; index += 1) await Promise.resolve();
  });
}

const router: AppRouterInstance = {
  back: () => {},
  forward: () => {},
  refresh: () => {},
  push: () => {},
  replace: () => {},
  prefetch: async () => {},
};

describe('mounted invite acceptance accessibility', { concurrency: false }, () => {
  test('keeps credentials out of the tree while preview loads, then exposes labelled fields and announced errors', async (context) => {
    const restoreBrowser = installBrowser();
    const { default: AcceptInvitePage } = await import('@/app/(public)/invite/[token]/page');
    const { createRoot } = await import('react-dom/client');
    const originalFetch = globalThis.fetch;
    let resolvePreview!: (value: Response) => void;
    const previewPending = new Promise<Response>((resolve) => { resolvePreview = resolve; });
    let acceptCalls = 0;
    context.mock.method(globalThis, 'fetch', (input: RequestInfo | URL) => {
      if (String(input).includes('invite-preview')) return previewPending;
      acceptCalls += 1;
      return Promise.resolve(response({ ok: false, error: 'This invitation is no longer usable.' }, 409));
    });

    const container = document.createElement('div');
    document.body.append(container);
    const root: Root = createRoot(container);
    context.after(async () => {
      Object.defineProperty(globalThis, 'fetch', { configurable: true, writable: true, value: originalFetch });
      await act(async () => { root.unmount(); });
      container.remove();
      restoreBrowser();
    });
    await act(async () => {
      root.render(
        <AppRouterContext.Provider value={router}>
          <PathParamsContext.Provider value={{ token: TOKEN }}>
            <AcceptInvitePage />
          </PathParamsContext.Provider>
        </AppRouterContext.Provider>,
      );
    });
    await flush();
    const loading = container.querySelector('[role="status"]');
    assert.equal(loading?.getAttribute('aria-busy'), 'true');
    assert.equal(container.querySelector('form'), null, 'credentials must not mount before preview');
    assert.equal(container.querySelectorAll('input').length, 0);

    resolvePreview(response({
      ok: true,
      data: {
        email: 'new-person@example.com',
        roleLabel: 'Owner',
        scope: 'company',
        companyName: 'Example Company',
        hotelNames: ['First Hotel'],
        coversAllIncludingFuture: false,
        invitedByName: 'Example Owner',
      },
    }));
    await flush();
    assert.match(container.textContent ?? '', /Example Company/);
    assert.equal(container.querySelector('[role="status"]'), null);
    assert.deepEqual(
      [...container.querySelectorAll('label')].map((label) => label.getAttribute('for')),
      ['invite-display-name', 'invite-password', 'invite-confirm-password'],
    );

    const name = container.querySelector<HTMLInputElement>('#invite-display-name');
    const password = container.querySelector<HTMLInputElement>('#invite-password');
    const confirm = container.querySelector<HTMLInputElement>('#invite-confirm-password');
    assert.ok(name && password && confirm);
    await setValue(name, 'New Person');
    await setValue(password, 'secret-password');
    await setValue(confirm, 'different-password');
    const form = container.querySelector('form');
    assert.ok(form);
    await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    await flush();
    assert.equal(acceptCalls, 0, 'client validation must block a mismatched password before the accept request');
    assert.ok(container.querySelector('[role="alert"]'));
    assert.match(container.textContent ?? '', /Passwords do not match/);

    await setValue(confirm, 'secret-password');
    await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    await flush();
    assert.equal(acceptCalls, 1);
    assert.ok(container.querySelector('[role="alert"]'));
    assert.match(container.textContent ?? '', /no longer usable/);
  });

  test('renders an unusable invite without mounting credential controls', async (context) => {
    const restoreBrowser = installBrowser();
    const { default: AcceptInvitePage } = await import('@/app/(public)/invite/[token]/page');
    const { createRoot } = await import('react-dom/client');
    const originalFetch = globalThis.fetch;
    context.mock.method(globalThis, 'fetch', () => Promise.resolve(response({ ok: false }, 410)));
    const container = document.createElement('div');
    document.body.append(container);
    const root: Root = createRoot(container);
    context.after(async () => {
      Object.defineProperty(globalThis, 'fetch', { configurable: true, writable: true, value: originalFetch });
      await act(async () => { root.unmount(); });
      container.remove();
      restoreBrowser();
    });
    await act(async () => {
      root.render(
        <AppRouterContext.Provider value={router}>
          <PathParamsContext.Provider value={{ token: TOKEN }}>
            <AcceptInvitePage />
          </PathParamsContext.Provider>
        </AppRouterContext.Provider>,
      );
    });
    await flush();
    assert.match(container.textContent ?? '', /not usable/);
    assert.equal(container.querySelector('form'), null);
    assert.equal(container.querySelectorAll('input').length, 0);
  });
});
