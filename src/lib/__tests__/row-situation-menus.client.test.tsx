/**
 * OPENING AND CLOSING THE PER-ROW SITUATION MENU.
 *
 * The element-tree tests in row-situation-menus.test.ts can prove what the menu
 * DRAWS in each state. They cannot reach any of the ways it goes away, because
 * every one of those is a document-level listener or a real click on a real
 * element: the click-anywhere-else scrim, Escape at either stage, and the rule
 * that the composer's own Escape must not fire at the same time.
 *
 * The failures this guards are invisible to every other test and obvious to a
 * person:
 *
 *   1. A MENU THAT WILL NOT SHUT sits over the two rows underneath it, so the
 *      work is behind it.
 *   2. AN ANSWER FIELD WITH NO WAY OUT BUT ITS OWN BUTTON is the same trap one
 *      layer deeper, and it is the layer the scrim does not cover: the panel is
 *      gone by then.
 *   3. ONE KEYPRESS DOING TWO THINGS. The composer already closes on Escape.
 *      If a menu is open over a half-typed to-do, Escape must close the menu
 *      and leave the sentence alone.
 *
 * Mounts the REAL StaxisList with stubbed reads, same shape as
 * feed-composer-close.client.test.tsx.
 */

import assert from 'node:assert/strict';
import { describe, test, type TestContext } from 'node:test';

import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';

// Before jsdom is installed, so the singleton Supabase client stays in its
// quiet non-browser test mode.
import { supabase } from '@/lib/supabase';

// react-dom is imported LAZILY, after these are in place. See the note in
// feed-composer-close.client.test.tsx: loaded first, typing into a controlled
// input silently does nothing.
const DOM_GLOBALS = [
  'window', 'document', 'navigator', 'localStorage',
  'Element', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement', 'HTMLTextAreaElement',
  'Node', 'Event', 'EventTarget', 'KeyboardEvent', 'MouseEvent', 'PointerEvent',
  'MutationObserver', 'requestAnimationFrame', 'cancelAnimationFrame', 'getComputedStyle',
] as const;

type SessionReader = { getSession(): Promise<{ data: { session: null }; error: null }> };

const PID = 'cc000004-0000-4000-8000-000000000004';
const PM_ID = 'dd000001-0000-4000-8000-000000000001';
const WO_ID = 'dd000002-0000-4000-8000-000000000002';

/** Every write the menu can make, in the order they arrived. */
let writes: Array<{ url: string; body: Record<string, unknown> }> = [];

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
  return new Response(JSON.stringify({ ok: true, requestId: 'row-menu-test', data }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
}

/** One schedule and one ticket, which is exactly the two row types with menus. */
function worklistItems() {
  const base = {
    location: null, assigneeStaffId: null, assigneeName: null, dueDate: null,
    priority: 'normal', propertyId: PID, canComplete: true, canAssign: true,
    createdAt: '2026-08-06T00:00:00.000Z', fromLabel: null, amountCents: null,
    createdByStaffId: null,
  };
  return [
    {
      ...base, id: `pm:${PM_ID}`, sourceType: 'pm', sourceId: PM_ID,
      title: 'Fire panel inspection', dept: null, status: 'overdue', overdue: true,
      canAssign: false, deepLink: '/maintenance?tab=preventive', cadenceDays: 90,
    },
    {
      ...base, id: `workorder:${WO_ID}`, sourceType: 'workorder', sourceId: WO_ID,
      title: 'Pool light out', dept: 'maintenance', status: 'open', overdue: false,
      deepLink: '/maintenance?tab=work',
    },
  ];
}

function wire(context: TestContext): void {
  writes = [];
  context.mock.method(
    supabase.auth as unknown as SessionReader,
    'getSession',
    async () => ({ data: { session: null }, error: null }),
  );
  context.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (init?.method && init.method !== 'GET') {
      // Only the two worklist seams are counted. StaxisList also PUTs the
      // list-seen cursor on mount, and a recorder that swept that up would make
      // "nothing was sent" impossible to assert.
      if (/\/api\/worklist\/(complete|assign)/.test(url)) {
        let body: Record<string, unknown> = {};
        try { body = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>; } catch { /* not json */ }
        writes.push({ url, body });
      }
      return envelope({ recorded: true });
    }
    if (url.includes('view=assignees')) {
      return envelope({ me: { staffId: 's1' }, people: [{ staffId: 's2', name: 'Marcus Webb' }] });
    }
    if (url.includes('view=assigned-by-me')) return envelope({ assigned: [] });
    if (url.includes('/api/worklist')) return envelope({ items: worklistItems(), notices: [] });
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

function row(host: HTMLElement, kind: 'pm' | 'workorder'): HTMLElement {
  const el = host.querySelector<HTMLElement>(`[data-row-kind="${kind}"]`);
  assert.ok(el, `the ${kind} row never rendered`);
  return el;
}

function trigger(host: HTMLElement, kind: 'pm' | 'workorder'): HTMLButtonElement {
  const el = row(host, kind).querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]');
  assert.ok(el, `the ${kind} row has no way into its menu`);
  return el;
}

const menuOpen = (host: HTMLElement) => host.querySelector('.fx-rowmenu') !== null;
const askOpen = (host: HTMLElement, which: string) => host.querySelector(`[data-row-ask="${which}"]`) !== null;

async function click(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new globalThis.MouseEvent('click', { bubbles: true }));
  });
  await settle(5);
}

async function pressEscapeOn(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new globalThis.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
  await settle(5);
}

/** The option in the open menu whose label starts with this text. */
function option(host: HTMLElement, label: string): HTMLButtonElement {
  const buttons = [...host.querySelectorAll<HTMLButtonElement>('.fx-rowmenu button[role="menuitem"]')];
  const found = buttons.find((b) => (b.textContent ?? '').startsWith(label));
  assert.ok(found, `no menu option reading "${label}" (saw: ${buttons.map((b) => b.textContent).join(' | ')})`);
  return found;
}

async function type(input: HTMLInputElement, text: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  assert.ok(setter, 'the jsdom value setter must exist');
  await act(async () => {
    setter.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    for (let i = 0; i < 4; i += 1) await Promise.resolve();
  });
  await settle(5);
}

describe('the menu opens on the dots and closes again', () => {
  test('it opens on the row that was tapped, and only that row', async (t: TestContext) => {
    await withList(t, async ({ host }) => {
      assert.equal(menuOpen(host), false, 'a menu nobody asked for is on the screen');
      await click(trigger(host, 'pm'));
      assert.equal(menuOpen(host), true);
      assert.equal(host.querySelectorAll('.fx-rowmenu').length, 1, 'two rows opened at once');
      assert.equal(
        row(host, 'pm').querySelector('.fx-rowmenu') !== null, true,
        'the menu opened on the wrong row',
      );
      assert.equal(trigger(host, 'pm').getAttribute('aria-expanded'), 'true');
    });
  });

  test('tapping the dots again shuts it', async (t: TestContext) => {
    await withList(t, async ({ host }) => {
      await click(trigger(host, 'pm'));
      assert.equal(menuOpen(host), true);
      await click(trigger(host, 'pm'));
      assert.equal(menuOpen(host), false);
    });
  });

  test('opening the other row moves the menu rather than making a second one', async (t: TestContext) => {
    await withList(t, async ({ host }) => {
      await click(trigger(host, 'pm'));
      await click(trigger(host, 'workorder'));
      assert.equal(host.querySelectorAll('.fx-rowmenu').length, 1);
      assert.ok(row(host, 'workorder').querySelector('.fx-rowmenu'));
    });
  });

  test('clicking anywhere else shuts it', async (t: TestContext) => {
    await withList(t, async ({ host }) => {
      await click(trigger(host, 'pm'));
      const scrim = host.querySelector<HTMLButtonElement>('.fx-rowa > button[aria-label="Never mind"]');
      assert.ok(scrim, 'a menu with no exit that is not one of its own items is a trap');
      await click(scrim);
      assert.equal(menuOpen(host), false);
    });
  });

  test('Escape shuts it', async (t: TestContext) => {
    await withList(t, async ({ host }) => {
      await click(trigger(host, 'pm'));
      await pressEscapeOn(document.body);
      assert.equal(menuOpen(host), false);
    });
  });

  test('each row offers only its own situations', async (t: TestContext) => {
    await withList(t, async ({ host }) => {
      await click(trigger(host, 'pm'));
      const pmLabels = [...host.querySelectorAll('.fx-rowmenu button[role="menuitem"]')]
        .map((b) => b.textContent ?? '');
      assert.ok(pmLabels.some((l) => l.startsWith("Somebody's been called")));
      assert.ok(!pmLabels.some((l) => l.startsWith('Waiting on parts')), 'a schedule is not a ticket');

      await click(trigger(host, 'workorder'));
      const woLabels = [...host.querySelectorAll('.fx-rowmenu button[role="menuitem"]')]
        .map((b) => b.textContent ?? '');
      assert.ok(woLabels.some((l) => l.startsWith('Waiting on parts')));
      assert.ok(!woLabels.some((l) => l.startsWith('Skip this one')), 'a ticket has no occurrences to skip');
    });
  });
});

describe('an option that needs nothing fires, and one that needs an answer asks', () => {
  test('"Somebody\'s been called" goes straight through and closes the menu', async (t: TestContext) => {
    await withList(t, async ({ host }) => {
      await click(trigger(host, 'pm'));
      await click(option(host, "Somebody's been called"));
      const sent = writes.find((w) => w.url.includes('/api/worklist/complete'));
      assert.ok(sent, 'nothing was recorded');
      assert.equal(sent.body.outcome, 'called');
      assert.equal(sent.body.sourceType, 'pm');
      assert.equal(sent.body.sourceId, PM_ID);
      assert.equal(menuOpen(host), false, 'the menu stayed open over its own answer');
    });
  });

  test('"Waiting on parts" opens a box, and sends the words in it', async (t: TestContext) => {
    await withList(t, async ({ host }) => {
      await click(trigger(host, 'workorder'));
      await click(option(host, 'Waiting on parts'));
      assert.equal(menuOpen(host), false, 'the list should give way to the question');
      assert.equal(askOpen(host, 'waiting'), true);

      const box = host.querySelector<HTMLInputElement>('[data-row-ask="waiting"] input');
      assert.ok(box, 'the deferral asked for a reason and gave nowhere to write it');
      await type(box, 'compressor back ordered until Friday');

      const send = [...host.querySelectorAll<HTMLButtonElement>('[data-row-ask="waiting"] button')]
        .find((b) => b.textContent === 'Send');
      assert.ok(send);
      assert.equal(send.disabled, false);
      await click(send);

      const sent = writes.find((w) => w.url.includes('/api/worklist/complete'));
      assert.ok(sent);
      assert.equal(sent.body.outcome, 'waiting');
      assert.equal(sent.body.reason, 'compressor back ordered until Friday');
    });
  });

  test('an empty reason cannot be sent at all', async (t: TestContext) => {
    await withList(t, async ({ host }) => {
      await click(trigger(host, 'workorder'));
      await click(option(host, 'Waiting on parts'));
      const send = [...host.querySelectorAll<HTMLButtonElement>('[data-row-ask="waiting"] button')]
        .find((b) => b.textContent === 'Send');
      assert.ok(send);
      assert.equal(send.disabled, true);
      await click(send);
      assert.equal(writes.length, 0, 'a row that went quiet with no reason on it');
    });
  });

  test('"Change the schedule" opens on the cadence it is changing and saves a new one', async (t: TestContext) => {
    await withList(t, async ({ host }) => {
      await click(trigger(host, 'pm'));
      await click(option(host, 'Change the schedule'));
      const box = host.querySelector<HTMLInputElement>('[data-row-ask="reschedule"] input');
      assert.ok(box);
      assert.equal(box.value, '90', 'the box started blank, so somebody has to remember the old cadence');

      await type(box, '120');
      const save = [...host.querySelectorAll<HTMLButtonElement>('[data-row-ask="reschedule"] button')]
        .find((b) => b.textContent === 'Save');
      assert.ok(save);
      await click(save);

      const sent = writes.find((w) => w.url.includes('/api/worklist/assign'));
      assert.ok(sent, 'the cadence never left the browser');
      assert.equal(sent.body.frequencyDays, 120);
      assert.equal(sent.body.sourceType, 'pm');
    });
  });

  test('"Give it to someone else" offers the roster and hands it over', async (t: TestContext) => {
    await withList(t, async ({ host }) => {
      await click(trigger(host, 'workorder'));
      await click(option(host, 'Give it to someone else'));
      const person = [...host.querySelectorAll<HTMLButtonElement>('[data-row-ask="reassign"] button')]
        .find((b) => b.textContent === 'Marcus Webb');
      assert.ok(person, 'the roster never arrived');
      await click(person);

      const sent = writes.find((w) => w.url.includes('/api/worklist/assign'));
      assert.ok(sent);
      assert.equal(sent.body.assigneeStaffId, 's2');
      assert.equal(sent.body.sourceType, 'workorder');
    });
  });

  test('Escape backs out of an open answer without sending anything', async (t: TestContext) => {
    // The layer the scrim does not cover: by now the panel is gone, so without
    // this the only way out is the Never mind button.
    await withList(t, async ({ host }) => {
      await click(trigger(host, 'workorder'));
      await click(option(host, 'Waiting on parts'));
      assert.equal(askOpen(host, 'waiting'), true);
      await pressEscapeOn(document.body);
      assert.equal(askOpen(host, 'waiting'), false);
      assert.equal(writes.length, 0);
    });
  });

  test('and so does Never mind', async (t: TestContext) => {
    await withList(t, async ({ host }) => {
      await click(trigger(host, 'pm'));
      await click(option(host, 'Change the schedule'));
      const cancel = [...host.querySelectorAll<HTMLButtonElement>('[data-row-ask="reschedule"] button')]
        .find((b) => b.textContent === 'Never mind');
      assert.ok(cancel);
      await click(cancel);
      assert.equal(askOpen(host, 'reschedule'), false);
      assert.equal(writes.length, 0);
    });
  });
});

describe('one keypress does one thing', () => {
  test('Escape over an open menu leaves a half-typed to-do alone', async (t: TestContext) => {
    // The composer closes on Escape too. Two things closing on one keypress is
    // a page that feels like it is fighting you, and the one that loses is the
    // sentence somebody was in the middle of writing.
    await withList(t, async ({ host }) => {
      const field = host.querySelector<HTMLInputElement>('input.fx-comptitle');
      assert.ok(field, 'the composer has no sentence field');
      await type(field, 'Fix the ice machine');

      await click(trigger(host, 'pm'));
      assert.equal(menuOpen(host), true);
      await pressEscapeOn(document.body);

      assert.equal(menuOpen(host), false, 'the menu did not take the keypress');
      assert.equal(
        host.querySelector<HTMLInputElement>('input.fx-comptitle')!.value,
        'Fix the ice machine',
        'closing a menu threw away somebody\'s sentence',
      );
    });
  });
});
