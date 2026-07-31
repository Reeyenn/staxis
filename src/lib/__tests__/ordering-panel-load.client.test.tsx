/**
 * THE ORDERING SCREEN WHEN THE READ DOES NOT COME BACK.
 *
 * Two bugs, one render path, and both of them are silent in production.
 *
 *   1. A FAILED FIRST LOAD RENDERED NOTHING. The panel swallowed the error and
 *      left its own empty container on screen, so "we could not reach the
 *      server" and "this hotel has nothing to order" looked identical. The
 *      only recovery was closing and reopening the overlay, which nothing told
 *      the manager to do.
 *   2. IT CALLED THE BARE `fetch`. No Authorization header, none of the house
 *      401 recovery, so a session that expired while the overlay sat open
 *      turned every control on the screen into a silent no-op. Every sibling
 *      panel in that folder already goes through fetchWithAuth.
 *
 * Both are pinned against the REAL component and the REAL fetchWithAuth, with
 * only the network and the Supabase session replaced. The last test is the
 * teeth on the second one: it expires the token, makes the first attempt 401,
 * and asserts the panel still ends up showing the list, which is only possible
 * if the read went through the wrapper that refreshes and retries.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-min-20-chars';

import assert from 'node:assert/strict';
import Module from 'node:module';
import { after, before, describe, test } from 'node:test';

import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

// Imported before jsdom is installed so the singleton Supabase client stays in
// its quiet non-browser test mode. Its getSession is the only thing replaced.
import { supabase } from '@/lib/supabase';
import { fetchWithAuth } from '@/lib/api-fetch';
import { orderingFetch } from '@/app/inventory/_components/overlays/ordering-actions';

// The overlay imports a CSS module, which node cannot parse. Class names are
// not what these tests are about, so the stylesheet becomes a proxy that
// answers every class name with its own key. Installed BEFORE the panel is
// pulled in, which is why that import is dynamic.
// `__esModule` and `default` MUST answer undefined. The compiler's CJS interop
// checks `__esModule` first, and a proxy that answers every key would report a
// truthy string there, sending it down the branch that expects real own
// properties — which a proxy has none of, so `styles` came back undefined and
// the overlay crashed on its first class name.
const styleSheetStub = new Proxy({}, {
  get: (_target, key) => (
    typeof key === 'string' && key !== '__esModule' && key !== 'default' ? key : undefined
  ),
});
(Module as unknown as { _extensions: Record<string, unknown> })._extensions['.css'] =
  (m: { exports: unknown }) => { m.exports = styleSheetStub; };

type PanelModule = typeof import('@/app/inventory/_components/overlays/OrderingPanel');
let OrderingPanel: PanelModule['OrderingPanel'];

const PID = 'a1a1a1a1-0000-4000-8000-000000000001';

// ─── The browser ────────────────────────────────────────────────────────────

const DOM_GLOBALS = [
  'window', 'document', 'navigator', 'HTMLElement', 'Node', 'Event', 'EventTarget',
  'MutationObserver', 'requestAnimationFrame', 'cancelAnimationFrame', 'getComputedStyle',
] as const;

let restoreDom: (() => void) | null = null;

function installBrowser(): () => void {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    pretendToBeVisual: true,
    url: 'http://localhost/inventory',
  });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const key of DOM_GLOBALS) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    const candidate = dom.window[key as keyof typeof dom.window];
    const value = typeof candidate === 'function' && (
      key === 'requestAnimationFrame' || key === 'cancelAnimationFrame' || key === 'getComputedStyle'
    ) ? candidate.bind(dom.window) : candidate;
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const actFlag = 'IS_REACT_ACT_ENVIRONMENT';
  originals.set(actFlag, Object.getOwnPropertyDescriptor(globalThis, actFlag));
  Object.defineProperty(globalThis, actFlag, { configurable: true, writable: true, value: true });

  // jsdom has no Web Animations API and the overlay's entrance uses it. The
  // return value is never read, so a no-op is enough: what is under test is
  // what the panel puts inside the overlay, not how the overlay slides in.
  const ElementCtor = dom.window.Element as unknown as { prototype: Record<string, unknown> };
  if (typeof ElementCtor.prototype.animate !== 'function') {
    ElementCtor.prototype.animate = () => ({
      cancel() {}, finish() {}, play() {}, pause() {},
      finished: Promise.resolve(),
    });
  }

  return () => {
    dom.window.close();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  };
}

// ─── The network and the session ────────────────────────────────────────────

interface Seen { url: string; auth: string | null }

/** One screen's worth of payload: a single supplier with one short item. */
function payload() {
  return {
    introDismissedAt: '2026-07-01T00:00:00Z',
    hasInventory: true,
    vendors: [],
    suggestions: [],
    categories: [],
    categoryMap: [],
    groups: [{
      vendorId: 'v-1',
      vendorName: 'Sysco',
      orderMethod: 'store',
      vendorEmail: null,
      vendorPhone: null,
      websiteUrl: null,
      reviewState: 'confirmed',
      items: [{
        itemId: 'i-1', name: 'Bath towels', unit: 'each', bucketKey: 'general',
        onHand: 12, par: 100, status: 'critical', suggestedQty: 88,
        burnPerDay: null, burnConfidence: 'none', daysLeft: null,
        lastPriceCents: null, lastPriceAt: null, lineTotalCents: null,
        openOrder: null,
        vendor: { kind: 'category', vendorId: 'v-1', vendorName: 'Sysco', bucketKey: 'general' },
      }],
      knownSubtotalCents: 0,
      itemsWithoutPrice: 1,
      blocked: null,
    }],
    burnBasis: { source: 'none', daysOfData: 0, mlItems: 0 },
  };
}

function okBody(): Response {
  return new Response(JSON.stringify({ ok: true, requestId: 'panel-test', data: payload() }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
}

function serverError(): Response {
  return new Response(JSON.stringify({ ok: false, requestId: 'panel-test', error: 'load failed' }), {
    status: 500, headers: { 'Content-Type': 'application/json' },
  });
}

function unauthorized(): Response {
  return new Response(JSON.stringify({ ok: false, requestId: 'panel-test', error: 'nope', code: 'invalid_token' }), {
    status: 401, headers: { 'Content-Type': 'application/json' },
  });
}

/** Replace the network. Each entry answers one request, in order; the last
 *  entry keeps answering once the list runs out. */
function installFetch(answers: Array<() => Response | Promise<Response>>): Seen[] {
  const seen: Seen[] = [];
  let index = 0;
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    writable: true,
    value: async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      seen.push({
        url: typeof input === 'string' ? input : String(input),
        auth: headers.get('Authorization'),
      });
      const answer = answers[Math.min(index, answers.length - 1)];
      index += 1;
      return answer();
    },
  });
  return seen;
}

/** A live session, or one whose token is already past its expiry. */
function installSession(opts: { expired?: boolean } = {}): { refreshes: number } {
  const counter = { refreshes: 0 };
  const nowSec = Math.floor(Date.now() / 1000);
  const auth = supabase.auth as unknown as Record<string, unknown>;
  auth.getSession = async () => ({
    data: {
      session: {
        access_token: opts.expired ? 'stale-token' : 'live-token',
        expires_at: opts.expired ? nowSec - 60 : nowSec + 3600,
      },
    },
    error: null,
  });
  auth.refreshSession = async () => {
    counter.refreshes += 1;
    return { data: { session: { access_token: 'fresh-token', expires_at: nowSec + 3600 } }, error: null };
  };
  return counter;
}

// ─── Rendering ──────────────────────────────────────────────────────────────

let container: HTMLElement | null = null;
let root: Root | null = null;

async function mountPanel(): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container as HTMLElement);
    root.render(
      <OrderingPanel lang="en" open onClose={() => {}} propertyId={PID} />,
    );
  });
  await settle();
}

async function settle(rounds = 20): Promise<void> {
  await act(async () => {
    for (let i = 0; i < rounds; i += 1) await Promise.resolve();
  });
}

function unmount(): void {
  if (root) act(() => { root!.unmount(); });
  container?.remove();
  root = null;
  container = null;
}

function screenText(): string {
  return container?.textContent ?? '';
}

function buttonSaying(text: string): HTMLButtonElement | null {
  const buttons = Array.from(container?.querySelectorAll('button') ?? []);
  return (buttons.find((b) => (b.textContent ?? '').includes(text)) as HTMLButtonElement) ?? null;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

before(async () => {
  restoreDom = installBrowser();
  ({ OrderingPanel } = await import('@/app/inventory/_components/overlays/OrderingPanel'));
});

after(() => {
  restoreDom?.();
});

describe('ordering panel — a read that does not come back', () => {
  test('a failed first load says so and offers the way out', async () => {
    installSession();
    installFetch([serverError, okBody]);
    await mountPanel();

    // The bug: an empty container that reads as "nothing to order".
    assert.match(
      screenText(),
      /Could not load/i,
      'a failure has to look like a failure, not like an empty list',
    );
    assert.ok(buttonSaying('Try again'), 'and it has to offer the tap that fixes it');
    assert.ok(
      !screenText().includes('Bath towels'),
      'nothing is invented while the read is failing',
    );

    // The way out actually works.
    await act(async () => { buttonSaying('Try again')!.click(); });
    await settle();
    assert.match(screenText(), /Bath towels/, 'the retry loads the real list');
    assert.ok(!/Could not load/i.test(screenText()), 'and the failure notice clears');

    unmount();
  });

  test('a load that works is never mistaken for a failure', async () => {
    installSession();
    installFetch([okBody]);
    await mountPanel();
    assert.match(screenText(), /Bath towels/);
    assert.ok(!/Could not load/i.test(screenText()));
    unmount();
  });

  test('the screen reads with the session attached, not as a stranger', async () => {
    // The bare `fetch` this replaced sent no Authorization header at all.
    installSession();
    const seen = installFetch([okBody]);
    await mountPanel();

    const read = seen.find((s) => s.url.includes('/api/inventory/ordering'));
    assert.ok(read, 'the panel read the ordering screen');
    assert.equal(read!.auth, 'Bearer live-token', 'and it carried the signed-in session');

    unmount();
  });

  test('an expired session recovers instead of dead-ending the screen', async () => {
    // THE TEETH. A stale token is refreshed before the request goes out, so the
    // manager never sees a screen where nothing works and nothing explains why.
    // Only a read that goes through the house wrapper can do this.
    const session = installSession({ expired: true });
    const seen = installFetch([okBody]);
    await mountPanel();

    assert.ok(session.refreshes > 0, 'the stale token was refreshed rather than sent');
    const read = seen.find((s) => s.url.includes('/api/inventory/ordering'));
    assert.equal(read!.auth, 'Bearer fresh-token');
    assert.match(screenText(), /Bath towels/, 'and the screen still loaded');

    unmount();
  });

  test('a 401 is retried, not surfaced as an empty screen', async () => {
    const session = installSession();
    const seen = installFetch([unauthorized, okBody]);
    await mountPanel();

    assert.ok(session.refreshes > 0, 'the 401 triggered a refresh');
    assert.ok(seen.length >= 2, 'and the read was tried again with the new token');
    assert.match(screenText(), /Bath towels/);

    unmount();
  });

  test('the panel\'s fetch IS the house authed fetch', () => {
    // The identity, not the source text: if someone swaps the default back to
    // the bare `fetch`, every test above still passes on its own injected
    // impl, and only this one fails.
    assert.equal(orderingFetch, fetchWithAuth);
  });
});
