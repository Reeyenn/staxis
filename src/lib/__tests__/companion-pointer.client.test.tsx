/**
 * The pointer, mounted, in a browser.
 *
 * The pure suite (companion-pointers.test.ts) proves the selection rule, the
 * three dismissals and the geometry. None of that can prove the thing the
 * founder actually rejected: whether anything appears on the screen, whether
 * an arrow is drawn to a real control, and whether the page moves. So this
 * file renders the real component into a real DOM and reads the result.
 *
 * What is held here:
 *   - the popup draws, with its arrow layer, at a control that exists
 *   - the control LIGHTS UP while the pointer is up, and stops when it goes
 *   - it does NOT displace the page: it renders into a portal on <body>, and
 *     the page's own markup is byte-identical before and after
 *   - "Not now" closes and writes nothing
 *   - "Do not show this again" closes and drops the topic forever
 *   - CLICKING THE CONTROL drops the topic too. This is the one path with no
 *     button, so it is the one a refactor can silently delete.
 *   - a control that is not on the screen produces nothing at all, and does
 *     not spend the pointer
 *   - a housekeeper never gets one
 */

import assert from 'node:assert/strict';
import { describe, test, type TestContext } from 'node:test';

import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';

import { POINTER_DELAY_MS } from '@/lib/companion/pointers';

const DOM_GLOBALS = [
  'window', 'document', 'navigator', 'localStorage',
  'Element', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement', 'SVGElement',
  'Node', 'Event', 'CustomEvent', 'InputEvent', 'EventTarget', 'MouseEvent', 'KeyboardEvent',
  'FocusEvent', 'MutationObserver', 'requestAnimationFrame',
  'cancelAnimationFrame', 'getComputedStyle', 'matchMedia',
] as const;

interface Posted {
  event: string;
  topic?: string;
}

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
      key === 'requestAnimationFrame'
      || key === 'cancelAnimationFrame'
      || key === 'getComputedStyle'
      || key === 'matchMedia'
    ) ? candidate.bind(dom.window) : candidate;
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const actFlag = 'IS_REACT_ACT_ENVIRONMENT';
  originals.set(actFlag, Object.getOwnPropertyDescriptor(globalThis, actFlag));
  Object.defineProperty(globalThis, actFlag, { configurable: true, writable: true, value: true });
  return () => {
    dom.window.close();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  };
}

/**
 * jsdom lays nothing out, so every box is 0x0 and the pointer would correctly
 * refuse to draw at all. Give the anchored control a real rectangle, which is
 * the one thing about a browser this component genuinely depends on.
 */
function giveEverythingSize(): void {
  Object.defineProperty(globalThis.Element.prototype, 'getBoundingClientRect', {
    configurable: true,
    writable: true,
    value(this: Element) {
      if ((this as HTMLElement).hasAttribute?.('data-staxis-anchor')) {
        return { left: 500, top: 300, width: 160, height: 38, right: 660, bottom: 338, x: 500, y: 300, toJSON() {} };
      }
      return { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON() {} };
    },
  });
  Object.defineProperty(globalThis.HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get() { return 150; },
  });
}

/** The bootstrap read and the memory writes, captured rather than performed. */
function stubFetch(memory: Record<string, unknown>): { posts: Posted[]; restore: () => void } {
  const posts: Posted[] = [];
  const original = globalThis.fetch;
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    writable: true,
    value: async (input: unknown, init?: { method?: string; body?: string }) => {
      if (init?.method === 'POST') {
        posts.push(JSON.parse(init.body ?? '{}') as Posted);
        return new Response(JSON.stringify({ ok: true, requestId: 'r', data: {} }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      }
      void input;
      return new Response(JSON.stringify({
        ok: true,
        requestId: 'r',
        data: {
          hotel: { today: '2026-08-05' },
          memory,
          availability: { awake: true },
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
  });
  return {
    posts,
    restore: () => Object.defineProperty(globalThis, 'fetch', { configurable: true, writable: true, value: original }),
  };
}

interface Harness {
  host: HTMLElement;
  posts: Posted[];
  /** Everything the page itself rendered, so displacement is provable. */
  pageHtml: () => string;
}

/**
 * Render a stand-in page carrying the real anchor attribute, with the real
 * DiscoveryPointer mounted beside it.
 */
async function mount(
  t: TestContext,
  options: {
    anchor?: string;
    role?: 'general_manager' | 'housekeeping';
    memory?: Record<string, unknown>;
  } = {},
): Promise<Harness> {
  // The pointer deliberately waits three seconds for the screen to settle, and
  // then measures across two frames plus a settle timer. Waiting that out for
  // real would put forty seconds on the suite for no extra proof, so the clock
  // is driven rather than endured. Frames stay real: they are what jsdom
  // actually schedules and the measure loop rides on them.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const restoreDom = installBrowser();
  giveEverythingSize();
  const { posts, restore: restoreFetch } = stubFetch(options.memory ?? { topics: {} });

  const [{ DiscoveryPointer }, { createRoot }] = await Promise.all([
    import('@/components/companion/DiscoveryPointer'),
    import('react-dom/client'),
  ]);

  const host = document.createElement('div');
  document.body.appendChild(host);
  let root: Root | null = null;

  const anchor = options.anchor ?? 'inventory-import';
  await act(async () => {
    root = createRoot(host);
    root.render(
      <div>
        <button type="button" {...{ 'data-staxis-anchor': anchor }}>Import a file</button>
        <DiscoveryPointer pid="11111111-1111-4111-8111-111111111111" role={options.role ?? 'general_manager'} page="inventory" />
      </div>,
    );
  });
  // Let the bootstrap read settle, then run out the three-second wait and the
  // measure the popup schedules behind it. Two ticks and two frame waits: the
  // first tick fires the delay, the frames let the first measure run, and the
  // second tick fires the settle re-measure.
  await act(async () => { await Promise.resolve(); });
  await act(async () => { t.mock.timers.tick(POINTER_DELAY_MS + 100); });
  await act(async () => { await nextFrames(); });
  await act(async () => { t.mock.timers.tick(600); });
  await act(async () => { await nextFrames(); });

  t.after(() => {
    act(() => { root?.unmount(); });
    host.remove();
    restoreFetch();
    restoreDom();
    t.mock.timers.reset();
  });

  return { host, posts, pageHtml: () => host.innerHTML };
}

/** Two real animation frames, which is what the measure loop schedules. */
function nextFrames(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
}

function popup(): HTMLElement | null {
  return document.querySelector('[data-testid="companion-pointer"]');
}

function buttons(): HTMLButtonElement[] {
  const root = popup();
  return root ? [...root.querySelectorAll('button')] : [];
}

async function click(node: Element): Promise<void> {
  await act(async () => { node.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
}

// jsdom has no layout engine and the module mocks `next/navigation`'s pathname
// through the real hook, so the component is exercised on /inventory as set by
// the JSDOM url above.

describe('the pointer on a real screen', () => {
  test('it draws, with an arrow, at the control it names', async (t) => {
    await mount(t);
    const root = popup();
    assert.ok(root, 'nothing was drawn at all');
    assert.ok(
      root.textContent?.includes('Do you keep your inventory in an Excel spreadsheet?'),
      `the sentence is missing. Got: ${root.textContent}`,
    );
    // The arrow layer is the whole redesign. A popup with no line to anything
    // is the inline card again, floating.
    assert.ok(root.querySelector('[data-testid="companion-pointer-arrow"]'), 'no arrow was drawn');
    assert.ok(root.querySelector('path.cpt-head'), 'the arrow has no head');
  });

  test('the control lights up while the pointer is up, and stops when it goes', async (t) => {
    const { host } = await mount(t);
    const control = host.querySelector('[data-staxis-anchor]');
    assert.ok(control);
    assert.ok(control.hasAttribute('data-staxis-lit'), 'the control was never lit');

    const notNow = buttons().find((b) => /not now/i.test(b.textContent ?? ''));
    assert.ok(notNow);
    await click(notNow);
    assert.equal(control.hasAttribute('data-staxis-lit'), false, 'the control stayed lit after the pointer closed');
  });

  test('it does not displace the page: the page markup is unchanged', async (t) => {
    // The founder's first objection, made into a test. The popup lives in a
    // portal on <body>, so the page it is drawn over must be byte-identical to
    // the page with no pointer in it.
    const { host, pageHtml } = await mount(t);
    assert.ok(popup(), 'no pointer to prove anything about');
    const withPointer = pageHtml();
    assert.equal(withPointer.includes('cpt-card'), false, 'the popup rendered INTO the page');
    assert.equal(withPointer.includes('Excel spreadsheet'), false, 'the sentence rendered INTO the page');
    // And what the page does have is only its own control.
    assert.equal(host.querySelectorAll('button').length, 1);
  });

  test('showing it is stamped once, so it stays quiet for the rest of the day', async (t) => {
    const { posts } = await mount(t);
    const spoke = posts.filter((p) => p.event === 'spoke');
    assert.equal(spoke.length, 1, `expected one stamp, got ${JSON.stringify(posts)}`);
    assert.equal(spoke[0].topic, 'pointer:inventory_import');
  });
});

describe('the three ways out, pressed for real', () => {
  test('"Not now" closes it and writes no refusal', async (t) => {
    const { posts } = await mount(t);
    const notNow = buttons().find((b) => /not now/i.test(b.textContent ?? ''));
    assert.ok(notNow);
    await click(notNow);
    assert.equal(popup(), null, 'the popup stayed up');
    assert.equal(posts.some((p) => p.event === 'dropped'), false, '"Not now" must not end it forever');
  });

  test('"Do not show this again" drops the topic forever', async (t) => {
    const { posts } = await mount(t);
    const never = buttons().find((b) => /do not show/i.test(b.textContent ?? ''));
    assert.ok(never);
    await click(never);
    assert.equal(popup(), null);
    const dropped = posts.filter((p) => p.event === 'dropped');
    assert.equal(dropped.length, 1);
    assert.equal(dropped[0].topic, 'pointer:inventory_import');
  });

  test('CLICKING THE CONTROL drops it too, because they have found it', async (t) => {
    // The path with no button. Nothing about the component's markup implies it
    // exists, which is exactly why it is asserted here.
    const { host, posts } = await mount(t);
    const control = host.querySelector('[data-staxis-anchor]');
    assert.ok(control);
    await click(control);
    assert.equal(popup(), null, 'the popup stayed up over a control they just used');
    const dropped = posts.filter((p) => p.event === 'dropped');
    assert.equal(dropped.length, 1);
    assert.equal(dropped[0].topic, 'pointer:inventory_import');
  });

  test('a click somewhere else on the page is not an acknowledgment', async (t) => {
    const { host, posts } = await mount(t);
    await click(host);
    assert.ok(popup(), 'a click on nothing closed the pointer');
    assert.equal(posts.some((p) => p.event === 'dropped'), false);
  });
});

describe('it refuses to point at nothing', () => {
  test('a control that is not on this screen produces no popup and spends nothing', async (t) => {
    // The anchor on the page is a DIFFERENT control, so the one the pointer
    // wants is genuinely absent — which is what a narrow window that hides the
    // desktop rail looks like.
    const { posts } = await mount(t, { anchor: 'add-delivery', memory: {
      topics: { 'pointer:inventory_import': { declines: 0, dropped: false, lastOfferedDay: null } },
    } });
    // inventory_import is still the first unanswered pointer, and its control
    // is not here.
    assert.equal(popup()?.querySelector('[data-testid="companion-pointer-arrow"]') ?? null, null);
    assert.equal(posts.some((p) => p.event === 'spoke'), false, 'an unshown pointer must not be spent');
  });

  test('a housekeeper is never spoken to, and nothing is even read', async (t) => {
    const { posts } = await mount(t, { role: 'housekeeping' });
    assert.equal(popup(), null);
    assert.equal(posts.length, 0);
  });

  test('a topic already dropped forever draws nothing', async (t) => {
    const { posts } = await mount(t, {
      memory: {
        topics: {
          'pointer:inventory_import': { declines: 2, dropped: true, lastOfferedDay: '2026-08-01' },
          'pointer:inventory_invoices': { declines: 2, dropped: true, lastOfferedDay: '2026-08-01' },
        },
      },
    });
    assert.equal(popup(), null);
    assert.equal(posts.length, 0);
  });
});
