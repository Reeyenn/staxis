/**
 * "INCLUDE LOG BOOK IN STAXIS" ACTUALLY INCLUDES IT.
 *
 * The switch is the only thing that puts shift notes onto the day timeline, and
 * every part of the path it depends on is invisible when it breaks: the
 * preference read, the log read, the merge into the ranked list, and the
 * partition that decides which half of the spine a note lands in. A note that
 * quietly fails to appear looks exactly like a hotel that wrote nothing down.
 *
 * The 2026-08-01 redesign broke the CONTROL rather than the path: it moved the
 * row geometry out of LIST_CSS into FEED_CSS and dropped `.sl-sw` / `.sl-swl`
 * on the way, while the log book popup still asked for both. The switch lost
 * its layout entirely and rendered as a bare checkbox trailing a label at the
 * foot of a long scrolling pane. It still worked; almost nobody would have
 * found it. Both switches now use `.fx-sw`, which FEED_CSS does define.
 *
 * These mount the REAL StaxisList against the REAL useApiResource with stubbed
 * responses, so the whole chain is exercised rather than the pure middle of it.
 */

import assert from 'node:assert/strict';
import { describe, test, type TestContext } from 'node:test';

import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

// Before jsdom is installed, so the singleton Supabase client stays in its
// quiet non-browser test mode.
import { supabase } from '@/lib/supabase';
import { LIST_CSS } from '@/components/concourse/list-rows';
import { FEED_CSS_FOR_TEST_ONLY } from '@/components/concourse/concourse-css';

const DOM_GLOBALS = [
  'window', 'document', 'navigator', 'HTMLElement', 'Node', 'Event', 'EventTarget',
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
  return new Response(JSON.stringify({ ok: true, requestId: 'logbook-merge-test', data }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
}

interface Wired {
  /** Every request the page made, in order. */
  urls: string[];
  /** Every write body, so the switch can be shown to actually save. */
  writes: Array<{ url: string; body: unknown }>;
}

function wire(context: TestContext, options: { logbookInList: boolean; entries: unknown[] }): Wired {
  context.mock.method(
    supabase.auth as unknown as SessionReader,
    'getSession',
    async () => ({ data: { session: null }, error: null }),
  );
  const urls: string[] = [];
  const writes: Array<{ url: string; body: unknown }> = [];

  context.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    urls.push(url);
    if (init?.method && init.method !== 'GET') {
      let body: unknown = null;
      try { body = JSON.parse(String(init.body)); } catch { body = String(init.body); }
      writes.push({ url, body });
      if (url.includes('/api/feed/prefs')) {
        const patch = body as { logbookInList?: boolean };
        return envelope({ prefs: { logbookInList: patch.logbookInList === true, assignedSeenAt: null, companionMemory: null } });
      }
      return envelope({});
    }
    if (url.includes('view=assignees')) return envelope({ me: { staffId: 's1' }, people: [] });
    if (url.includes('view=assigned-by-me')) return envelope({ assigned: [] });
    if (url.includes('/api/worklist')) {
      return envelope({
        items: [{
          id: 'item-1', sourceType: 'task', sourceId: 't1', title: 'Call the plumber',
          dueDate: todayIso(), overdue: false, assigneeName: 'You', status: 'open',
          canComplete: true, canAssign: false, propertyId: PID,
        }],
        notices: [],
      });
    }
    if (url.includes('/api/feed/prefs')) {
      return envelope({ prefs: { logbookInList: options.logbookInList, assignedSeenAt: null, companionMemory: null } });
    }
    if (url.includes('/api/comms/logbook')) return envelope({ entries: options.entries });
    if (url.includes('/api/knowledge/events')) return envelope({ events: [] });
    if (url.includes('/api/findings')) return envelope({ findings: [], run: null, cap: 6 });
    return envelope({});
  });

  return { urls, writes };
}

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${`${d.getMonth() + 1}`.padStart(2, '0')}-${`${d.getDate()}`.padStart(2, '0')}`;
}

function logEntry(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'log-1',
    propertyId: PID,
    title: 'Pool pump restarted',
    body: 'Ran fine afterwards.',
    category: 'maintenance',
    authorName: 'Marcus',
    createdAt: new Date().toISOString(),
    replyCount: 0,
    ...over,
  };
}

async function settle(rounds = 30): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await act(async () => { await Promise.resolve(); });
}

/**
 * Mount, run the assertions, and ALWAYS tear down.
 *
 * The teardown is not hygiene. StaxisList holds six polling reads; a tree left
 * mounted by a failing assertion keeps firing them against a jsdom window that
 * has already been closed, and the whole file then hangs rather than reporting
 * the one assertion that actually failed.
 */
async function withList(
  context: TestContext,
  options: { logbookInList: boolean; entries: unknown[] },
  body: (ctx: { host: HTMLElement; wired: Wired }) => Promise<void>,
): Promise<void> {
  const restore = installBrowser();
  let root: Root | null = null;
  try {
    const wired = wire(context, options);
    const { StaxisList } = await import('@/components/concourse/StaxisList');
    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(React.createElement(StaxisList, {
        propertyId: PID, lang: 'en' as const, focusId: null,
        canSeeFindings: true, hotelName: 'Comfort Suites Beaumont',
      }));
    });
    await settle();
    await body({ host, wired });
  } finally {
    if (root) await act(async () => { root!.unmount(); });
    restore();
  }
}

describe('the log book reaches the timeline when the switch is on', () => {
  test('a shift note becomes a row on the spine', async (t: TestContext) => {
    await withList(t, { logbookInList: true, entries: [logEntry()] }, async ({ host }) => {
      const rows = host.querySelectorAll('[data-row-kind="log"]');
      assert.equal(rows.length, 1, 'the note the switch promised to show is missing');
      assert.match(host.textContent ?? '', /Pool pump restarted/);
      // ...and it lands on the spine, not loose in the page.
      assert.ok(host.querySelector('.fx-lane'), 'the timeline itself did not render');
    });
  });

  test('with the switch off the same note is nowhere on the timeline', async (t: TestContext) => {
    await withList(t, { logbookInList: false, entries: [logEntry()] }, async ({ host }) => {
      assert.equal(host.querySelectorAll('[data-row-kind="log"]').length, 0);
      // The rail panel still shows today's notes on its face: that is what
      // makes it a panel rather than a button, and it is not what the switch
      // controls. So the title IS on the page; it is just not a spine row.
      assert.ok(host.querySelector('.fx-log'), 'the rail panel should still show today');
    });
  });

  test('the work still outranks the diary', async (t: TestContext) => {
    await withList(t, { logbookInList: true, entries: [logEntry()] }, async ({ host }) => {
      const kinds = [...host.querySelectorAll('[data-row-kind]')]
        .map((el) => el.getAttribute('data-row-kind') ?? '');
      const firstLog = kinds.indexOf('log');
      const firstWork = kinds.findIndex((k) => k !== 'log');
      assert.ok(firstLog >= 0, `no note rendered at all: ${kinds.join(',')}`);
      assert.ok(firstWork >= 0, `no work rendered at all: ${kinds.join(',')}`);
      // The whole reason the merge is safe to switch on: a diary never buries
      // something somebody actually has to do.
      assert.ok(firstWork < firstLog, `a note outranked open work: ${kinds.join(',')}`);
    });
  });

  // 2026-08-05: the switch used to sit at the foot of the rail panel AND at the
  // foot of the opened log book. One preference, two controls, one screen. The
  // clean view of the rail is a glance at what got written down today, so the
  // switch now lives only where somebody has already gone looking for the diary.
  test('the rail panel carries no switch', async (t: TestContext) => {
    await withList(t, { logbookInList: false, entries: [logEntry()] }, async ({ host }) => {
      const panels = [...host.querySelectorAll('.fx-panel')]
        .filter((el) => /Log book/.test(el.textContent ?? ''));
      assert.equal(panels.length, 1, 'the log book panel is not on the page at all');
      assert.equal(
        panels[0].querySelector('[role="switch"]'), null,
        'the merge switch came back to the clean view',
      );
      assert.ok(!/Show notes on the timeline/.test(panels[0].textContent ?? ''));
      // ...and the panel still does the two things it is actually for.
      assert.ok(panels[0].querySelector('.fx-log'), 'today\'s notes are missing');
      assert.match(panels[0].textContent ?? '', /Open the log book/);
    });
  });
});

describe('looking at the list is what marks it seen', () => {
  test('opening the page stamps the cursor, so the next visit measures from here', async (t: TestContext) => {
    await withList(t, { logbookInList: false, entries: [] }, async ({ wired }) => {
      const stamp = wired.writes.find(
        (w) => w.url.includes('/api/feed/prefs')
          && (w.body as Record<string, unknown> | undefined)?.markListSeen === true,
      );
      assert.ok(stamp, 'nothing recorded that this person looked at their list');
      // The browser never names the moment. A clock that could stamp itself
      // into the future would never be shown a new row again.
      assert.equal((stamp.body as Record<string, unknown>).listSeenAt, undefined);
    });
  });
});

describe('every class the switches ask for is a class that exists', () => {
  // The exact regression the redesign shipped: LIST_CSS lost `.sl-sw` while
  // LogbookPopup still named it. This is a no-runtime invariant, so it is
  // checked as one rather than by rendering something and squinting.
  const CSS = `${LIST_CSS}\n${FEED_CSS_FOR_TEST_ONLY()}`;

  test('the switch, its label and its error line are all styled somewhere', () => {
    for (const cls of ['fx-sw', 'fx-foot', 'fx-footl', 'sl-err', 'fx-lbhead', 'fx-lbt', 'fx-lbfoot']) {
      assert.ok(CSS.includes(`.${cls}`), `.${cls} is used but never defined`);
    }
  });

  test('the switch reads as on and off, so its state is visible at all', () => {
    assert.ok(CSS.includes('.fx-sw[aria-checked="true"]'), 'an unstyled switch cannot show it is on');
  });

  // The follow-through classes. Same invariant, same reason: an unstyled
  // control is not a subtle bug, it is a raw browser button in the middle of a
  // designed page, and nothing else in the suite would notice.
  test('the mine toggle and the new marker are styled', () => {
    for (const cls of ['fx-seg', 'fx-segb', 'fx-new']) {
      assert.ok(CSS.includes(`.${cls}`), `.${cls} is used but never defined`);
    }
  });

  test('the mine toggle shows which side it is on', () => {
    assert.ok(
      CSS.includes('.fx-segb[aria-pressed="true"]'),
      'a toggle that looks the same in both positions is not a toggle',
    );
  });
});
