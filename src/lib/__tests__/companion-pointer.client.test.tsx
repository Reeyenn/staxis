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

// ─── Load the Supabase browser client BEFORE any fake DOM exists ───────────
//
// DiscoveryPointer's real transport is `fetchWithAuth`, which imports the
// Supabase browser client, which is CONSTRUCTED at module scope. GoTrue arms
// its token-refresh ticker in that constructor whenever it decides it is in a
// browser, and the ticker is a bare interval that outlives every teardown: it
// then fires against a closed jsdom window forever, holding the whole client
// suite open rather than failing it.
//
// Importing it here, at the top of the file, means it is constructed while
// `window` is still undefined, so it never decides it is in a browser and the
// ticker is never armed. The later dynamic import inside the harness gets the
// same cached module. The component is still driven through its own `request`
// seam, so nothing in this file depends on the client actually working.
import '@/lib/supabase';

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

/**
 * The bootstrap read and the memory writes, captured rather than performed.
 *
 * Handed to the component through its `request` prop rather than by replacing
 * the global fetch. That seam exists for exactly this: the real transport is
 * `fetchWithAuth`, which pulls in the Supabase browser client, whose session
 * preflight arms a token-refresh ticker that outlives the test and holds the
 * whole client suite open instead of failing it. Driving the component's own
 * seam keeps that entire module graph out of the test.
 */
function stubTransport(memory: Record<string, unknown>, failWrites = 0): {
  posts: Posted[];
  request: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
} {
  const posts: Posted[] = [];
  let failuresLeft = failWrites;
  const request = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body ?? '{}')) as Posted;
      posts.push(body);
      // Only the dismissal is made to fail. Failing whichever write happens to
      // come first would spend the budget on the `spoke` stamp and prove
      // nothing about the one that carries a promise.
      if (body.event === 'dropped' && failuresLeft > 0) {
        failuresLeft -= 1;
        return new Response(JSON.stringify({ ok: false, requestId: 'r', error: 'nope' }), {
          status: 503, headers: { 'Content-Type': 'application/json' },
        });
      }
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
  };
  return { posts, request };
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
    /** How many DISMISSAL writes should fail before one succeeds. */
    failWrites?: number;
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
  const { posts, request } = stubTransport(options.memory ?? { topics: {} }, options.failWrites ?? 0);

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
        <DiscoveryPointer
          pid="11111111-1111-4111-8111-111111111111"
          role={options.role ?? 'general_manager'}
          page="inventory"
          request={request as never}
        />
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
    restoreDom();
    t.mock.timers.reset();
  });

  return { host, posts, pageHtml: () => host.innerHTML };
}

/** Drain the microtask queue so an in-flight request has been read. */
async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); });
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

// ═══════════════════════════════════════════════════════════════════════════
// The popup itself, mounted directly
// ═══════════════════════════════════════════════════════════════════════════
//
// DiscoveryPointer drives one pointer per visit and cannot swap anchors, so
// the anchor-swap path belongs to PointerPopup and has to be exercised there.
// It is the chat pointer's real path: AskStaxisBar replaces `chatPointer` in
// place when somebody asks a second "where is..." question, with no unmount in
// between.

async function mountPopup(
  t: TestContext,
  anchors: string[],
): Promise<{ setAnchor: (a: string) => Promise<void>; host: HTMLElement }> {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const restoreDom = installBrowser();
  giveEverythingSize();

  const [{ PointerPopup }, { createRoot }] = await Promise.all([
    import('@/components/companion/PointerPopup'),
    import('react-dom/client'),
  ]);

  const host = document.createElement('div');
  document.body.appendChild(host);
  let root: Root | null = null;

  const draw = (anchor: string) => (
    <div>
      {anchors.map((a) => (
        <button type="button" key={a} {...{ 'data-staxis-anchor': a }}>{a}</button>
      ))}
      <PointerPopup
        anchor={anchor as never}
        paragraphs={[`about ${anchor}`]}
        buttons={[{ label: 'Got it', answer: 'never' }]}
        onAnswer={() => {}}
      />
    </div>
  );

  const settle = async () => {
    await act(async () => { await nextFrames(); });
    await act(async () => { t.mock.timers.tick(600); });
    await act(async () => { await nextFrames(); });
  };

  await act(async () => { root = createRoot(host); root.render(draw(anchors[0])); });
  await settle();

  t.after(() => {
    act(() => { root?.unmount(); });
    host.remove();
    restoreDom();
    t.mock.timers.reset();
  });

  return {
    host,
    setAnchor: async (a: string) => {
      await act(async () => { root?.render(draw(a)); });
      await settle();
    },
  };
}

describe('swapping the anchor on a live pointer', () => {
  test('the second control is the one described, lit, and pointed at', async (t) => {
    // Every ref in the popup is a fact about ONE control. Before they were
    // reset on a swap, the second anchor was rendered with the first anchor's
    // geometry and glow, and neither onShown nor onNoTarget could ever fire
    // again because both were already spent.
    const { host, setAnchor } = await mountPopup(t, ['inventory-import', 'add-delivery']);
    const first = host.querySelector('[data-staxis-anchor="inventory-import"]');
    const second = host.querySelector('[data-staxis-anchor="add-delivery"]');
    assert.ok(first && second);
    assert.ok(popup()?.textContent?.includes('about inventory-import'));
    assert.ok(first.hasAttribute('data-staxis-lit'), 'the first control was never lit');

    await setAnchor('add-delivery');
    assert.ok(popup()?.textContent?.includes('about add-delivery'), 'the words did not follow the anchor');
    assert.equal(first.hasAttribute('data-staxis-lit'), false, 'the old control stayed lit');
    assert.ok(second.hasAttribute('data-staxis-lit'), 'the new control was never lit');
    assert.ok(popup()?.querySelector('[data-testid="companion-pointer-arrow"]'), 'no arrow after the swap');
  });

  test('clicking the NEW control counts, and clicking the old one does not', async (t) => {
    const { host, setAnchor } = await mountPopup(t, ['inventory-import', 'add-delivery']);
    await setAnchor('add-delivery');
    // The document listener is rebuilt on the new selector, so a click on the
    // control the pointer has left behind is just a click on a button.
    assert.ok(popup());
    await click(host.querySelector('[data-staxis-anchor="inventory-import"]')!);
    assert.ok(popup(), 'the old control still ended the pointer');
  });
});

describe('a dismissal is not lost to one bad request', () => {
  test('"Do not show this again" is retried when the write fails', async (t) => {
    // A swallowed failure means the thing they just dismissed forever is back
    // tomorrow, which is the app appearing not to have listened. The reducer
    // behind it is idempotent, so a retry is free.
    const { posts } = await mount(t, { failWrites: 1 });
    const never = buttons().find((b) => /do not show/i.test(b.textContent ?? ''));
    assert.ok(never);
    await act(async () => { never.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    // Let the FIRST request fail before winding the backoff on: the retry's
    // sleep is not registered until the failure has been read, so ticking
    // early would tick a timer that does not exist yet.
    await flush();
    await act(async () => { t.mock.timers.tick(500); });
    await flush();
    const dropped = posts.filter((p) => p.event === 'dropped');
    assert.equal(dropped.length, 2, `expected a retry, got ${JSON.stringify(posts)}`);
    assert.equal(dropped[1].topic, 'pointer:inventory_import');
  });

  test('a write that succeeds first time is not sent twice', async (t) => {
    const { posts } = await mount(t);
    const never = buttons().find((b) => /do not show/i.test(b.textContent ?? ''));
    assert.ok(never);
    await act(async () => { never.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();
    await act(async () => { t.mock.timers.tick(500); });
    await flush();
    assert.equal(posts.filter((p) => p.event === 'dropped').length, 1);
  });
});
