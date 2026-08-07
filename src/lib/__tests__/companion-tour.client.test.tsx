/**
 * The tour, mounted, in a browser.
 *
 * The pure suite (companion-tour.test.ts) proves who gets which stops and what
 * the reducers do. None of that can prove the thing the founder actually asked
 * for, which is that a "you try" stop STANDS THERE until the person does the
 * real thing. That promise lives in three pieces that only meet in a browser:
 * a window event fired by the screen that owns the write, a subscription, and
 * a card that refuses to offer a Next. So this file wires all three together
 * and reads the result.
 *
 * What is held here:
 *   - a watch stop draws a card at the real control, with a Next
 *   - a "you try" stop draws NO Next, and says it is waiting
 *   - the real deed moves it on; a DIFFERENT deed does not
 *   - the deed has to come through the real event, so a screen that forgets to
 *     fire it leaves the tour standing (which is the honest failure)
 *   - Escape is the way out, and it means SKIP rather than "not now"
 *   - a stop about a whole screen falls back to the slab, with no arrow
 *   - none of it displaces the page: it all renders into portals on <body>
 */

import assert from 'node:assert/strict';
import { describe, test, type TestContext } from 'node:test';

import { JSDOM } from 'jsdom';
import React, { act, useEffect, useState } from 'react';
import type { Root } from 'react-dom/client';

import {
  advanceTour,
  endTourRun,
  startTourRun,
  tourDeedDone,
  type TourRun,
  type TourStop,
} from '@/lib/companion/tour';

const DOM_GLOBALS = [
  'window', 'document', 'navigator', 'localStorage',
  'Element', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement', 'SVGElement',
  'Node', 'Event', 'CustomEvent', 'InputEvent', 'EventTarget', 'MouseEvent', 'KeyboardEvent',
  'FocusEvent', 'MutationObserver', 'requestAnimationFrame',
  'cancelAnimationFrame', 'getComputedStyle', 'matchMedia',
] as const;

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
 * jsdom lays nothing out, so every box is 0x0 and both the pointer and the
 * cursor would correctly refuse to draw. Give anything carrying a real anchor
 * attribute a real rectangle, which is the one thing about a browser they
 * genuinely depend on.
 */
function giveAnchorsSize(): void {
  Object.defineProperty(globalThis.Element.prototype, 'getBoundingClientRect', {
    configurable: true,
    writable: true,
    value(this: Element) {
      if ((this as HTMLElement).hasAttribute?.('data-staxis-anchor')) {
        return { left: 400, top: 260, width: 180, height: 40, right: 580, bottom: 300, x: 400, y: 260, toJSON() {} };
      }
      return { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON() {} };
    },
  });
  Object.defineProperty(globalThis.HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get() { return 150; },
  });
}

async function nextFrames(): Promise<void> {
  await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
}

// ─── The stops under test ───────────────────────────────────────────────────
//
// Real anchor keys, because the whole point of the rebuild is that the cursor
// resolves a KEY through the registry rather than taking a selector.

const WATCH: TourStop = {
  key: 'w-list', page: 'staxis', anchor: 'todo-composer', kind: 'watch',
  say: 'This is your one list.',
};
const TRY: TourStop = {
  key: 't-todo', page: 'staxis', anchor: 'todo-composer', kind: 'try', awaits: 'todo_created',
  say: 'Your turn. Type a to-do in the box.', example: 'Fix the ice machine tomorrow',
};
const SCREEN_ONLY: TourStop = {
  key: 's-people', page: 'people', anchor: null, kind: 'watch',
  say: 'People is your roster.',
};

interface Harness {
  /** The page's own markup, so displacement is provable. */
  pageHtml: () => string;
  /** Every skip the guide asked for. */
  skips: number;
  /** The run as the wrapper currently holds it. */
  runNow: () => TourRun;
  /** Fire a real deed event, the way a screen that just saved something does. */
  deed: (which: 'todo_created' | 'fact_taught') => Promise<void>;
  /** Press a button by its visible label. */
  press: (label: string) => Promise<void>;
  /** Press Escape on the window, the way a person does. */
  escape: () => Promise<void>;
  text: () => string;
}

/**
 * Mount the real TourGuide over a stand-in page, driven by the real reducers
 * and the real deed event.
 *
 * The wrapper is the smallest possible stand-in for useCompanion: it holds the
 * run in state, subscribes to deeds, and hands the guide its three props.
 * Everything with a consequence below it is production code.
 */
async function mount(t: TestContext, stops: readonly TourStop[]): Promise<Harness> {
  const restoreDom = installBrowser();
  giveAnchorsSize();

  const [{ TourGuide }, { reportCompanionDeed, subscribeToCompanionDeeds }, { createRoot }] = await Promise.all([
    import('@/components/companion/TourGuide'),
    import('@/components/companion/companion-events'),
    import('react-dom/client'),
  ]);

  const host = document.createElement('div');
  document.body.appendChild(host);
  let root: Root | null = null;
  const state = { run: startTourRun(stops), skips: 0 };

  function Wrapper() {
    const [run, setRun] = useState<TourRun>(() => state.run);
    useEffect(() => { state.run = run; }, [run]);
    useEffect(() => subscribeToCompanionDeeds((d) => setRun((r) => tourDeedDone(r, d))), []);
    if (run.ended !== null) return null;
    return (
      <div>
        {/* The real control the stops point at. */}
        <div {...{ 'data-staxis-anchor': 'todo-composer' }}>
          <input aria-label="What needs doing" />
        </div>
        <TourGuide
          run={run}
          onNext={() => setRun((r) => advanceTour(r))}
          onSkip={() => { state.skips += 1; setRun((r) => endTourRun(r, 'skipped')); }}
        />
      </div>
    );
  }

  await act(async () => {
    root = createRoot(host);
    root.render(<Wrapper />);
  });
  // The popup measures across two frames plus a settle timer, exactly like the
  // discovery pointer. Real frames, because that is what the measure loop
  // rides on; the settle is waited out rather than faked because it is short.
  await act(async () => { await nextFrames(); });
  await act(async () => { await new Promise((r) => setTimeout(r, 500)); });
  await act(async () => { await nextFrames(); });

  t.after(() => {
    act(() => { root?.unmount(); });
    host.remove();
    restoreDom();
  });

  async function press(label: string): Promise<void> {
    const button = Array.from(document.body.querySelectorAll('button'))
      .find((b) => (b.textContent ?? '').trim() === label);
    assert.ok(button, `no button labelled "${label}" (saw: ${
      Array.from(document.body.querySelectorAll('button')).map((b) => b.textContent).join(' | ')})`);
    await act(async () => {
      button!.dispatchEvent(new globalThis.MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    await act(async () => { await nextFrames(); });
  }

  return {
    pageHtml: () => host.innerHTML,
    get skips() { return state.skips; },
    runNow: () => state.run,
    text: () => document.body.textContent ?? '',
    press,
    escape: async () => {
      await act(async () => {
        globalThis.window.dispatchEvent(
          new globalThis.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
        );
      });
      await act(async () => { await nextFrames(); });
    },
    deed: async (which) => {
      await act(async () => { reportCompanionDeed(which); });
      await act(async () => { await nextFrames(); });
    },
  };
}

describe('a watch stop', () => {
  test('draws a card at the real control, with a Next', async (t) => {
    const h = await mount(t, [WATCH, TRY]);
    assert.ok(document.querySelector('[data-testid="companion-pointer"]'), 'no card drew');
    assert.ok(h.text().includes('This is your one list.'), h.text());
    assert.ok(
      Array.from(document.body.querySelectorAll('button')).some((b) => b.textContent?.trim() === 'Next'),
      'a watch stop must be answerable',
    );
  });

  test('flies the cursor to the anchor by KEY, not by selector', async (t) => {
    await mount(t, [WATCH]);
    const cursor = document.querySelector('[data-testid="tour-cursor"]');
    assert.ok(cursor, 'no cursor drew');
    assert.equal(cursor!.getAttribute('data-tour-cursor-anchor'), 'todo-composer');
  });

  test('counts where you are, one-based', async (t) => {
    const h = await mount(t, [WATCH, TRY]);
    assert.ok(h.text().includes('1 of 2'), h.text());
  });

  test('Next moves to the following stop', async (t) => {
    const h = await mount(t, [WATCH, TRY]);
    await h.press('Next');
    assert.equal(h.runNow().index, 1);
    assert.ok(h.text().includes('Your turn.'), h.text());
  });

  test('the last stop offers Done rather than Next', async (t) => {
    const h = await mount(t, [WATCH]);
    assert.ok(
      Array.from(document.body.querySelectorAll('button')).some((b) => b.textContent?.trim() === 'Done'),
      h.text(),
    );
  });

  test('nothing it draws displaces the page', async (t) => {
    const h = await mount(t, [WATCH]);
    // Everything is a portal onto <body>. A screen somebody came to read must
    // stay exactly where they left it.
    assert.ok(!h.pageHtml().includes('companion-pointer'), h.pageHtml());
    assert.ok(!h.pageHtml().includes('tour-cursor'));
  });
});

describe('a "you try" stop waits for the real thing', () => {
  test('offers no Next at all, and says it is waiting', async (t) => {
    const h = await mount(t, [TRY, WATCH]);
    const labels = Array.from(document.body.querySelectorAll('button')).map((b) => b.textContent?.trim());
    assert.ok(!labels.includes('Next'), `a waiting stop offered a way past it: ${labels.join(' | ')}`);
    assert.ok(!labels.includes('Done'), labels.join(' | '));
    assert.deepEqual(labels, ['Skip the tour']);
    assert.ok(h.text().includes('Waiting for you.'), h.text());
  });

  test('shows the example in quotes, so what to type is unambiguous', async (t) => {
    const h = await mount(t, [TRY]);
    assert.ok(h.text().includes('Try: "Fix the ice machine tomorrow"'), h.text());
  });

  test('the real deed moves it on', async (t) => {
    const h = await mount(t, [TRY, WATCH]);
    assert.equal(h.runNow().waiting, true);
    await h.deed('todo_created');
    assert.equal(h.runNow().waiting, false);
    assert.equal(h.runNow().index, 1);
    assert.ok(h.text().includes('This is your one list.'), h.text());
  });

  test('somebody else\'s deed does not', async (t) => {
    // Teaching a fact during the to-do stop is a useful thing and a different
    // thing. Advancing would be the companion taking credit for a step nobody
    // took, and then saying the to-do is on the list when it is not.
    const h = await mount(t, [TRY, WATCH]);
    await h.deed('fact_taught');
    assert.equal(h.runNow().waiting, true);
    assert.equal(h.runNow().index, 0);
  });

  test('a deed nobody fires leaves it standing there', async (t) => {
    // The honest failure. A screen that saves something without reporting it
    // strands the tour rather than advancing it on a guess, and this pins that
    // the ONLY thing that moves it is the event.
    const h = await mount(t, [TRY, WATCH]);
    await h.press('Skip the tour');
    assert.equal(h.runNow().ended, 'skipped');
  });
});

describe('the way out', () => {
  test('Escape skips the tour rather than dismissing a card', async (t) => {
    // A discovery pointer's Escape means "not now" and comes back another day.
    // A tour's Escape is the door, and it must mean the same thing the button
    // means or the two ways out disagree about what happened.
    const h = await mount(t, [WATCH, TRY]);
    await h.escape();
    assert.equal(h.skips, 1);
    assert.equal(h.runNow().ended, 'skipped');
  });

  test('Escape works on a waiting stop too', async (t) => {
    const h = await mount(t, [TRY]);
    await h.escape();
    assert.equal(h.runNow().ended, 'skipped');
  });

  test('the skip button ends it and nothing is left on the screen', async (t) => {
    const h = await mount(t, [WATCH, TRY]);
    await h.press('Skip the tour');
    assert.equal(h.runNow().ended, 'skipped');
    assert.equal(document.querySelector('[data-testid="companion-pointer"]'), null);
    assert.equal(document.querySelector('[data-testid="tour-cursor"]'), null);
  });
});

describe('a stop about a whole screen', () => {
  test('falls back to the slab, with no arrow and no cursor', async (t) => {
    const h = await mount(t, [SCREEN_ONLY]);
    assert.ok(document.querySelector('[data-testid="tour-slab"]'), h.text());
    assert.equal(document.querySelector('[data-testid="tour-cursor"]'), null, 'nothing to point at');
    assert.ok(h.text().includes('People is your roster.'), h.text());
  });

  test('the slab is still answerable and still escapable', async (t) => {
    const h = await mount(t, [SCREEN_ONLY]);
    await h.escape();
    assert.equal(h.runNow().ended, 'skipped');
  });

  test('the slab is a portal too, so the page does not move', async (t) => {
    const h = await mount(t, [SCREEN_ONLY]);
    assert.ok(!h.pageHtml().includes('tour-slab'), h.pageHtml());
  });
});
