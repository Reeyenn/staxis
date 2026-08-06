/**
 * THE COMPOSER CLOSES WHEN SOMEBODY IS DONE WITH IT.
 *
 * Two ways out that the row itself cannot see, and that no amount of walking a
 * hook-free element tree can reach: a click anywhere else on the page, and
 * Escape pressed while focus is on one of the chips rather than in the field.
 * Both are document-level listeners in StaxisList, so they need a real DOM and
 * real events, which is why this is a client test and not a surface one.
 *
 * The failure they guard against is not subtle to a person and completely
 * invisible to every other test: a composer whose chip rows stay open forever
 * sits on top of the first two rows of the list, so the work is behind it.
 *
 * Mounts the REAL StaxisList with stubbed reads, same shape as
 * feed-logbook-merge.client.test.tsx.
 */

import assert from 'node:assert/strict';
import { describe, test, type TestContext } from 'node:test';

import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';

// Before jsdom is installed, so the singleton Supabase client stays in its
// quiet non-browser test mode.
import { supabase } from '@/lib/supabase';

// react-dom is imported LAZILY, after these are in place. It reads the DOM
// globals at module init to build its event system and its controlled-input
// value tracker; loaded first, clicks still work (they are delegated on the
// root container) but typing into a controlled input silently does nothing,
// which is a very long afternoon to debug.
const DOM_GLOBALS = [
  'window', 'document', 'navigator', 'localStorage',
  'Element', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement', 'HTMLTextAreaElement',
  'Node', 'Event', 'EventTarget', 'KeyboardEvent', 'MouseEvent', 'PointerEvent',
  'MutationObserver', 'requestAnimationFrame', 'cancelAnimationFrame', 'getComputedStyle',
] as const;

type SessionReader = { getSession(): Promise<{ data: { session: null }; error: null }> };

const PID = 'cc000003-0000-4000-8000-000000000003';

function installBrowser(): () => void {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    pretendToBeVisual: true,
    url: 'http://localhost/feed',
  });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const key of [...DOM_GLOBALS, 'IS_REACT_ACT_ENVIRONMENT'] as const) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  }
  for (const key of DOM_GLOBALS) {
    const candidate = dom.window[key as keyof typeof dom.window];
    const value = typeof candidate === 'function' && (
      key === 'requestAnimationFrame' || key === 'cancelAnimationFrame' || key === 'getComputedStyle'
    ) ? candidate.bind(dom.window) : candidate;
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
    configurable: true, writable: true, value: true,
  });
  return () => {
    dom.window.close();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  };
}

function envelope(data: unknown): Response {
  return new Response(JSON.stringify({ ok: true, requestId: 'composer-close-test', data }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
}

function wire(context: TestContext): void {
  context.mock.method(
    supabase.auth as unknown as SessionReader,
    'getSession',
    async () => ({ data: { session: null }, error: null }),
  );
  context.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (init?.method && init.method !== 'GET') return envelope({});
    if (url.includes('view=assignees')) {
      return envelope({ me: { staffId: 's1' }, people: [{ staffId: 's2', name: 'Marcus Webb' }] });
    }
    if (url.includes('view=assigned-by-me')) return envelope({ assigned: [] });
    if (url.includes('/api/worklist')) return envelope({ items: [], notices: [] });
    if (url.includes('/api/feed/prefs')) {
      return envelope({ prefs: { logbookInList: false, assignedSeenAt: null, listSeenAt: null, companionMemory: null } });
    }
    if (url.includes('/api/comms/logbook')) return envelope({ entries: [] });
    if (url.includes('/api/knowledge/events')) return envelope({ events: [] });
    if (url.includes('/api/findings')) return envelope({ findings: [], run: null, cap: 6 });
    return envelope({});
  });
}

async function settle(rounds = 30): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await act(async () => { await Promise.resolve(); });
}

/** Mount, run, and ALWAYS tear down: StaxisList holds six polling reads. */
async function withList(
  context: TestContext,
  body: (ctx: { host: HTMLElement; outside: HTMLElement }) => Promise<void>,
): Promise<void> {
  const restore = installBrowser();
  let root: Root | null = null;
  try {
    wire(context);
    const { createRoot } = await import('react-dom/client');
    const { StaxisList } = await import('@/components/concourse/StaxisList');
    const host = document.createElement('div');
    document.body.appendChild(host);
    // Somewhere else on the page to click. A real page always has one.
    const outside = document.createElement('button');
    outside.textContent = 'somewhere else';
    document.body.appendChild(outside);
    root = createRoot(host);
    await act(async () => {
      root!.render(React.createElement(StaxisList, {
        propertyId: PID, lang: 'en' as const, focusId: null,
        canSeeFindings: true, hotelName: 'Comfort Suites Beaumont',
      }));
    });
    await settle();
    await body({ host, outside });
  } finally {
    if (root) await act(async () => { root!.unmount(); });
    restore();
  }
}

// ── driving the row the way a person does ───────────────────────────────────

function field(host: HTMLElement): HTMLInputElement {
  const input = host.querySelector<HTMLInputElement>('input.fx-comptitle');
  assert.ok(input, 'the composer has no sentence field');
  return input;
}

/** The chip rows are open when the composer has rendered any of them. */
function chipRowsOpen(host: HTMLElement): boolean {
  return host.querySelector('.fx-compopen') !== null;
}

async function type(host: HTMLElement, text: string): Promise<void> {
  const input = field(host);
  // React keeps its own tracker of an input's value; going through the native
  // setter is what stops it treating the synthetic event as a no-op. Same
  // helper shape as add-hotel-create-and-invite.client.test.tsx.
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  assert.ok(setter, 'the jsdom value setter must exist');
  await act(async () => {
    setter.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    for (let i = 0; i < 4; i += 1) await Promise.resolve();
  });
  await settle(5);
  assert.equal(field(host).value, text, 'the test could not type into the row');
  // The mono hint only appears once the ROW knows there are words in it, which
  // is the difference between React having taken the change and the DOM merely
  // holding a value the test wrote onto it.
  assert.ok(host.querySelector('.fx-compkey'), 'the row did not register the words');
}

/** Tap the word on the right of the row that opens a chip row. */
async function tapWord(host: HTMLElement, index: number): Promise<void> {
  const words = host.querySelectorAll<HTMLButtonElement>('.fx-compword');
  assert.ok(words.length >= index + 1, 'the readback words are missing from the row');
  await act(async () => {
    words[index].dispatchEvent(new globalThis.MouseEvent('click', { bubbles: true }));
  });
  await settle(5);
}

async function clickOutside(outside: HTMLElement): Promise<void> {
  await act(async () => {
    outside.dispatchEvent(new globalThis.MouseEvent('mousedown', { bubbles: true }));
  });
  await settle(5);
}

async function pressEscapeOn(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new globalThis.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
  await settle(5);
}

describe('clicking somewhere else closes the composer', () => {
  test('the chip rows shut, and the words that were typed survive', async (t: TestContext) => {
    await withList(t, async ({ host, outside }) => {
      await type(host, 'Fix the ice machine');
      await tapWord(host, 0);
      assert.equal(chipRowsOpen(host), true, 'tapping a word did not open its row');

      await clickOutside(outside);

      assert.equal(chipRowsOpen(host), false, 'the row stayed open over the list');
      // A glance at something else is not "delete what I was writing".
      assert.equal(field(host).value, 'Fix the ice machine', 'a stray click ate somebody\'s sentence');
    });
  });

  test('an empty row goes back to its defaults outright', async (t: TestContext) => {
    await withList(t, async ({ host, outside }) => {
      await tapWord(host, 0);
      assert.equal(chipRowsOpen(host), true);
      await clickOutside(outside);
      assert.equal(chipRowsOpen(host), false);
      assert.equal(field(host).value, '');
    });
  });

  test('clicking INSIDE the row leaves it alone', async (t: TestContext) => {
    // The bug this catches is the obvious one: a listener that closes on every
    // click makes the chips unusable, because tapping one closes the row it is
    // in before the choice registers.
    await withList(t, async ({ host }) => {
      await type(host, 'Fix the ice machine');
      await tapWord(host, 0);
      const chip = host.querySelector<HTMLButtonElement>('.fx-compb');
      assert.ok(chip, 'the chip row rendered no chips');
      await act(async () => {
        chip.dispatchEvent(new globalThis.MouseEvent('mousedown', { bubbles: true }));
      });
      await settle(5);
      assert.equal(chipRowsOpen(host), true, 'clicking a chip closed the row it lives in');
    });
  });
});

describe('Escape closes it too, from wherever focus happens to be', () => {
  test('from a chip: the first Escape shuts the buttons, the second gives up the row', async (t: TestContext) => {
    await withList(t, async ({ host }) => {
      await type(host, 'Fix the ice machine');
      await tapWord(host, 0);
      const chip = host.querySelector<HTMLButtonElement>('.fx-compb');
      assert.ok(chip, 'the chip row rendered no chips');

      await pressEscapeOn(chip);
      assert.equal(chipRowsOpen(host), false, 'Escape on a chip did nothing at all');
      assert.equal(field(host).value, 'Fix the ice machine', 'the first Escape threw the sentence away');

      await pressEscapeOn(host.querySelector('[data-testid="composer"]')!);
      assert.equal(field(host).value, '', 'the second Escape did not give up the row');
    });
  });

  test('from the field itself, which owns its own Escape, it is not handled twice', async (t: TestContext) => {
    await withList(t, async ({ host }) => {
      await type(host, 'Fix the ice machine');
      await tapWord(host, 0);
      // One keypress, one stage. Double-handling would close the buttons AND
      // wipe the sentence in a single press.
      await pressEscapeOn(field(host));
      assert.equal(chipRowsOpen(host), false);
      assert.equal(field(host).value, 'Fix the ice machine', 'one Escape did the work of two');
    });
  });

  test('Escape does nothing to a row nobody has touched', async (t: TestContext) => {
    await withList(t, async ({ host }) => {
      await pressEscapeOn(document.body);
      assert.ok(field(host), 'the composer went away');
      assert.equal(chipRowsOpen(host), false);
    });
  });
});

describe('the composer carries a stable handle for anything pointing at it', () => {
  test('the outer box is findable by attribute, without reaching inside it', async (t: TestContext) => {
    await withList(t, async ({ host }) => {
      const anchored = host.querySelectorAll('[data-staxis-anchor="todo-composer"]');
      assert.equal(anchored.length, 1, 'the composer anchor is missing or duplicated');
      assert.ok(anchored[0].querySelector('input.fx-comptitle'), 'the anchor is not on the row it names');
    });
  });
});
