/**
 * The "Staxis found" card's `···` menu, mounted, in a browser.
 *
 * ─── THE BUG ────────────────────────────────────────────────────────────────
 *
 * The menu was `position:absolute; top:calc(100% + 7px)` on the card's action
 * row. That row is the LAST row of `.fx-ink-card`, whose own rule is
 * `overflow:hidden`. So the menu opened downward into space the card does not
 * have and was clipped away: the founder saw a sliver of its top edge under the
 * following card and could not reach a single item. Every verdict behind it,
 * in practice, was gone.
 *
 * ─── WHY THIS TEST AND NOT ONLY THE UNIT ONE ───────────────────────────────
 *
 * findings-cards.test.ts proves `placeCardMenu` never returns coordinates that
 * leave the menu off the screen. It cannot prove the half that actually bit:
 * WHERE IN THE DOM the menu ends up. A perfectly-placed menu that is still a
 * descendant of an `overflow:hidden` card is still invisible, and that is
 * exactly the state that shipped. So this mounts the real component inside a
 * real clipping ancestor and reads the result.
 *
 * What is held here:
 *   - the menu is NOT a descendant of the clipping card
 *   - it renders onto <body>, in fixed coordinates that sit inside the viewport
 *   - Escape closes it
 *   - a click outside closes it
 *   - choosing an item closes it and reports the choice
 *   - a card near the bottom of the screen opens the menu UPWARD, which is the
 *     founder's case
 */

import assert from 'node:assert/strict';
import { describe, test, type TestContext } from 'node:test';

import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';

import { menuPlacementIsOnScreen, placeCardMenu } from '@/components/concourse/finding-cards';

// ─── Load the Supabase browser client BEFORE any fake DOM exists ───────────
//
// FindingCards pulls in `fetchWithAuth`, which imports the Supabase browser
// client, which is CONSTRUCTED at module scope. GoTrue arms its token-refresh
// ticker in that constructor whenever it decides it is in a browser, and the
// ticker is a bare interval that outlives every teardown: it then fires against
// a closed jsdom window forever, holding the whole client suite open rather
// than failing it.
//
// Importing it here, at the top of the file, means it is constructed while
// `window` is still undefined, so it never decides it is in a browser and the
// ticker is never armed. The later dynamic import gets the same cached module.
// Same trap, same fix, as companion-pointer.client.test.tsx.
import '@/lib/supabase';

const DOM_GLOBALS = [
  'window', 'document', 'navigator', 'localStorage',
  'Element', 'HTMLElement', 'HTMLButtonElement', 'HTMLDivElement', 'SVGElement',
  'Node', 'Event', 'CustomEvent', 'EventTarget', 'MouseEvent', 'KeyboardEvent',
  'FocusEvent', 'MutationObserver', 'requestAnimationFrame',
  'cancelAnimationFrame', 'getComputedStyle', 'matchMedia',
] as const;

const VIEWPORT = { width: 1024, height: 768 };

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
 * jsdom lays nothing out, so every box is 0x0 and the menu would be placed at
 * the origin whatever the code did. The `···` button gets a real rectangle,
 * which is the one thing about a browser this component genuinely depends on.
 * `anchorTop` is what puts the card near the bottom of the screen.
 */
function giveTheButtonSize(anchorTop: number): void {
  Object.defineProperty(globalThis.Element.prototype, 'getBoundingClientRect', {
    configurable: true,
    writable: true,
    value(this: Element) {
      if ((this as HTMLElement).dataset?.testAnchor !== undefined) {
        return {
          left: 700, top: anchorTop, width: 36, height: 36,
          right: 736, bottom: anchorTop + 36, x: 700, y: anchorTop, toJSON() {},
        };
      }
      return { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON() {} };
    },
  });
  Object.defineProperty(globalThis.HTMLElement.prototype, 'scrollHeight', {
    configurable: true, get() { return 132; },
  });
  Object.defineProperty(globalThis.HTMLElement.prototype, 'scrollWidth', {
    configurable: true, get() { return 206; },
  });
  Object.defineProperty(globalThis.window, 'innerWidth', {
    configurable: true, writable: true, value: VIEWPORT.width,
  });
  Object.defineProperty(globalThis.window, 'innerHeight', {
    configurable: true, writable: true, value: VIEWPORT.height,
  });
}

/**
 * A card exactly as the real one is styled: the two properties that made the
 * old menu unreachable, and nothing else.
 *
 * `overflow:hidden` is the clipper. The `transform` matters just as much and is
 * easier to forget: a transformed ancestor becomes the containing block for
 * `position:fixed` descendants too, so even switching the old menu to `fixed`
 * without moving it out of the card would still have left it trapped.
 */
function ClippingCard({ children }: { children: React.ReactNode }) {
  return (
    <div id="the-card" style={{ overflow: 'hidden', transform: 'translateY(-1px)', position: 'relative' }}>
      {children}
    </div>
  );
}

interface Harness {
  root: Root;
  container: HTMLElement;
  chosen: string[];
  closes: number;
}

async function mountMenu(t: TestContext, anchorTop: number): Promise<Harness> {
  const restore = installBrowser();
  giveTheButtonSize(anchorTop);

  // Imported AFTER the fake DOM exists: the module reaches for `document` at
  // render time through createPortal, and a module graph loaded against the
  // previous test's closed window would portal into a dead document.
  const { CardMenuForTest } = await import('@/components/concourse/FindingCards');
  const { createRoot } = await import('react-dom/client');

  const container = globalThis.document.createElement('div');
  globalThis.document.body.appendChild(container);
  const root = createRoot(container);
  const harness: Harness = { root, container, chosen: [], closes: 0 };

  function Host() {
    const anchorRef = React.useRef<HTMLButtonElement | null>(null);
    const [ready, setReady] = React.useState(false);
    React.useEffect(() => setReady(true), []);
    return (
      <ClippingCard>
        <button ref={anchorRef} type="button" data-test-anchor="" id="the-more-button">···</button>
        {ready && (
          <CardMenuForTest
            anchorRef={anchorRef}
            closeLabel="Cancel"
            onClose={() => { harness.closes += 1; }}
          >
            <button type="button" role="menuitem" onClick={() => harness.chosen.push('muted')}>
              Mute
            </button>
            <button type="button" role="menuitem" onClick={() => harness.chosen.push('resolved')}>
              Fixed
            </button>
          </CardMenuForTest>
        )}
      </ClippingCard>
    );
  }

  await act(async () => { root.render(<Host />); });
  // ONE teardown, in order. React's unmount reaches for `window`, so a separate
  // hook that tore the fake DOM down first would fail every test in this file
  // after its assertions had already passed, which is the most confusing shape
  // a green test suite can have.
  t.after(() => {
    act(() => { root.unmount(); });
    container.remove();
    restore();
  });
  return harness;
}

function menuNode(): HTMLElement {
  const node = globalThis.document.querySelector<HTMLElement>('[role="menu"]');
  assert.ok(node, 'the menu did not render at all');
  return node;
}

describe('the card menu escapes the card', () => {
  test('it is not a descendant of the clipping card', async (t) => {
    await mountMenu(t, 200);
    const card = globalThis.document.getElementById('the-card');
    assert.ok(card, 'the fixture card is missing');
    assert.equal(
      card.contains(menuNode()),
      false,
      'the menu is still inside overflow:hidden, so it is still clipped',
    );
  });

  test('it renders as a direct child of <body>', async (t) => {
    await mountMenu(t, 200);
    // Not "somewhere outside the card": specifically on <body>, which is the
    // only ancestor in the document guaranteed to have no overflow, transform
    // or stacking context of its own from a card's styling.
    assert.equal(menuNode().parentElement, globalThis.document.body);
  });

  test('its coordinates put the whole menu inside the viewport', async (t) => {
    await mountMenu(t, 200);
    const style = menuNode().style;
    assert.equal(style.position === '' ? 'fixed' : style.position, 'fixed');
    const left = Number.parseFloat(style.left);
    const top = Number.parseFloat(style.top);
    const maxWidth = Number.parseFloat(style.maxWidth);
    const maxHeight = Number.parseFloat(style.maxHeight);
    for (const [name, value] of Object.entries({ left, top, maxWidth, maxHeight })) {
      assert.ok(Number.isFinite(value), `${name} was not set: ${style.cssText}`);
    }
    assert.ok(
      menuPlacementIsOnScreen({ left, top, maxWidth, maxHeight, side: 'below' }, VIEWPORT),
      `menu at ${left},${top} sized ${maxWidth}x${maxHeight} leaves a ${VIEWPORT.width}x${VIEWPORT.height} screen`,
    );
    // And it is genuinely below the button when there is room, which is where
    // a menu under a control belongs.
    assert.ok(top > 200, `expected it below the button at 200, got ${top}`);
  });

  test('a card at the bottom of the screen opens the menu upward', async (t) => {
    // The founder's case. The old rule was unconditionally downward, into the
    // part of the card that does not exist.
    await mountMenu(t, VIEWPORT.height - 50);
    const style = menuNode().style;
    const top = Number.parseFloat(style.top);
    const maxHeight = Number.parseFloat(style.maxHeight);
    assert.ok(top < VIEWPORT.height - 50, `expected it above the button, got top=${top}`);
    assert.ok(top >= 0);
    assert.ok(top + maxHeight <= VIEWPORT.height);
  });

  test('it is not obscured: it sits above the page it is drawn over', async (t) => {
    await mountMenu(t, 200);
    // The scrim and the menu are siblings on <body>, and the menu paints last.
    // Nothing on the page can cover it, because nothing on the page is a later
    // sibling of <body>'s own children at this z-index.
    const scrim = globalThis.document.querySelector<HTMLElement>('.fx-menu-scrim');
    assert.ok(scrim, 'the outside-click way out is missing');
    assert.equal(scrim.parentElement, globalThis.document.body);
    const children = [...globalThis.document.body.children];
    assert.ok(
      children.indexOf(menuNode()) > children.indexOf(scrim),
      'the scrim paints over the menu, so the items cannot be clicked',
    );
  });
});

describe('the card menu can be got out of', () => {
  test('Escape closes it', async (t) => {
    const h = await mountMenu(t, 200);
    await act(async () => {
      globalThis.window.dispatchEvent(
        new globalThis.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      );
    });
    assert.equal(h.closes, 1);
  });

  test('a click outside closes it', async (t) => {
    const h = await mountMenu(t, 200);
    const scrim = globalThis.document.querySelector<HTMLElement>('.fx-menu-scrim');
    assert.ok(scrim);
    await act(async () => { scrim.click(); });
    assert.equal(h.closes, 1);
  });

  test('choosing an item reports the choice', async (t) => {
    const h = await mountMenu(t, 200);
    const items = [...globalThis.document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    assert.equal(items.length, 2);
    await act(async () => { items[0].click(); });
    assert.deepEqual(h.chosen, ['muted']);
  });

  test('the first item takes focus, so it is usable without a mouse', async (t) => {
    await mountMenu(t, 200);
    const items = [...globalThis.document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    assert.equal(globalThis.document.activeElement, items[0]);
  });
});

describe('the placement the component uses is the one the unit suite proves', () => {
  test('the rendered coordinates match placeCardMenu for the same inputs', async (t) => {
    // The two halves of the fix are tested in two places, and this is the seam
    // between them: if the component ever starts computing its own position,
    // the proof in findings-cards.test.ts stops describing what ships.
    await mountMenu(t, 200);
    const expected = placeCardMenu({
      anchor: { top: 200, bottom: 236, left: 700, right: 736 },
      menu: { width: 206, height: 132 },
      viewport: VIEWPORT,
    });
    const style = menuNode().style;
    assert.equal(Number.parseFloat(style.left), expected.left);
    assert.equal(Number.parseFloat(style.top), expected.top);
    assert.equal(Number.parseFloat(style.maxHeight), expected.maxHeight);
    assert.equal(Number.parseFloat(style.maxWidth), expected.maxWidth);
  });
});
