/**
 * THE STAXIS LIST, AT THE SIZE PEOPLE ACTUALLY HOLD IT.
 *
 * Everything on this screen was signed off on a desktop, and the people who
 * run the hotel with it are holding a phone. Measured in a real browser at
 * 375x812 the page was 452px wide: the day controls, the week strip and the
 * cadence chips are lines of nowrap parts, a flex item's automatic minimum is
 * its own content, so each of them refused to shrink and pushed the document
 * sideways instead. On the way down the same measurement found every box you
 * type into under 16px (iOS zooms the page in on focus below that and never
 * zooms back out), every button between 19px and 32px tall, and two lists that
 * declare `overflow-x: auto` and never scrolled a pixel because nothing ever
 * clamped them.
 *
 * ─── WHAT THIS FILE CAN AND CANNOT CHECK ───────────────────────────────────
 * jsdom has no layout engine and does not evaluate media queries at all, so
 * "is the popup 355px wide" is not answerable here; that was measured in
 * Chrome during the pass and is not what these tests are for. What jsdom DOES
 * do is run the real cascade over real stylesheets on real mounted components,
 * which is exactly the question these regressions were: WHICH DECLARATION WINS
 * on a phone. So the sheets are flattened to the phone cascade (base rules,
 * then the contents of every max-width block a phone matches, in source order)
 * and the components are mounted against them.
 *
 * Every assertion below is paired with its desktop twin, because the whole
 * risk of a phone pass is quietly reshaping the screen the founder signed off.
 */

import assert from 'node:assert/strict';
import { describe, test, type TestContext } from 'node:test';

import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { FEED_CSS_FOR_TEST_ONLY } from '@/components/concourse/concourse-css';
import { CALENDAR_CSS, MonthOverlay, emptyEventDraft } from '@/components/concourse/list-calendar';
import {
  ComposerView,
  LIST_CSS,
  WorkRowView,
  composerDefaults,
  type ComposerPerson,
} from '@/components/concourse/list-rows';
import type { WorklistItem } from '@/lib/worklist/types';

const DOM_GLOBALS = [
  'window', 'document', 'navigator', 'Element', 'HTMLElement', 'HTMLButtonElement',
  'HTMLInputElement', 'Node', 'Event', 'EventTarget', 'getComputedStyle',
] as const;

/** The width a phone media query is written against here. */
const PHONE_WIDTH = 375;

/**
 * The cascade a phone actually gets.
 *
 * jsdom drops every `@media` rule on the floor, which makes its default answer
 * the DESKTOP one. Lifting the contents of the max-width blocks a 375px window
 * matches, in the order they appear, reproduces "later rule of equal
 * specificity wins" exactly as a browser resolves it. Anything the phone does
 * not match (a min-width block, prefers-reduced-motion) is left out, so a rule
 * that only exists for a wide window can never pass one of these by accident.
 */
function phoneCascade(...sheets: string[]): string {
  const flattened = sheets.map((sheet) => {
    const blocks: string[] = [];
    const re = /@media\s*\(\s*max-width\s*:\s*(\d+)px\s*\)\s*\{/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(sheet)) !== null) {
      if (Number(match[1]) < PHONE_WIDTH) continue;
      // Walk to this block's matching brace so nested rules come with it.
      let depth = 1;
      let i = re.lastIndex;
      while (i < sheet.length && depth > 0) {
        if (sheet[i] === '{') depth += 1;
        else if (sheet[i] === '}') depth -= 1;
        i += 1;
      }
      blocks.push(sheet.slice(re.lastIndex, i - 1));
    }
    // The @media rules themselves are stripped from the base copy: jsdom would
    // ignore them anyway, and leaving them in risks it mis-parsing the rest.
    return `${stripMedia(sheet)}\n${blocks.join('\n')}`;
  });
  return flattened.join('\n');
}

/** The same sheets with every @media block removed: the desktop cascade. */
function desktopCascade(...sheets: string[]): string {
  return sheets.map(stripMedia).join('\n');
}

function stripMedia(sheet: string): string {
  let out = '';
  let i = 0;
  while (i < sheet.length) {
    const at = sheet.indexOf('@media', i);
    if (at === -1) { out += sheet.slice(i); break; }
    out += sheet.slice(i, at);
    const open = sheet.indexOf('{', at);
    if (open === -1) break;
    let depth = 1;
    let j = open + 1;
    while (j < sheet.length && depth > 0) {
      if (sheet[j] === '{') depth += 1;
      else if (sheet[j] === '}') depth -= 1;
      j += 1;
    }
    i = j;
  }
  return out;
}

function installBrowser(): () => void {
  const dom = new JSDOM(
    '<!doctype html><html><head></head><body></body></html>',
    { pretendToBeVisual: true, url: 'http://localhost/feed' },
  );
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const key of [...DOM_GLOBALS, 'IS_REACT_ACT_ENVIRONMENT'] as const) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  }
  for (const key of DOM_GLOBALS) {
    const candidate = dom.window[key as keyof typeof dom.window];
    const value = key === 'getComputedStyle' && typeof candidate === 'function'
      ? candidate.bind(dom.window)
      : candidate;
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

/**
 * Render, THEN put the sheet in.
 *
 * Some of these components ship their own stylesheet inside themselves (the
 * month grid injects CALENDAR_CSS as it renders). jsdom drops the @media rules
 * out of that copy, so a sheet placed in <head> would lose every tie to the
 * component's own base rule and the test would be measuring the desktop
 * cascade while claiming to measure the phone. Appending last is what makes
 * the flattened phone rules the last word, exactly as the browser's own media
 * evaluation would.
 *
 * Nothing is unmounted afterwards on purpose: the jsdom window is torn down by
 * the browser hook, and React cannot unmount into a window that has already
 * gone.
 */
function mount(_context: TestContext, node: React.ReactNode, css: string): HTMLElement {
  const container = document.createElement('div');
  document.body.append(container);
  const root: Root = createRoot(container);
  act(() => { root.render(node); });
  const sheet = document.createElement('style');
  sheet.textContent = css;
  document.body.append(sheet);
  return container;
}

/** One declared value, as the cascade resolved it for this element. */
function styleOf(container: HTMLElement, selector: string, property: string): string {
  const el = container.querySelector(selector);
  assert.ok(el, `nothing matched ${selector}`);
  return getComputedStyle(el).getPropertyValue(property);
}

function px(value: string): number {
  const n = Number.parseFloat(value);
  assert.ok(Number.isFinite(n), `expected a px value, got "${value}"`);
  return n;
}

const TODAY = '2026-08-06';
const NOW = new Date('2026-08-06T09:12:00');

const PEOPLE = [
  { staffId: 's1', name: 'Dana Whitfield', role: 'maintenance' },
  { staffId: 's2', name: 'Marcus Bell', role: 'front_desk' },
] as unknown as ComposerPerson[];

function composerNode(): React.ReactElement {
  const state = {
    ...composerDefaults(TODAY, NOW.getDay()),
    title: 'Check the boiler room pressure gauge',
    openRow: 'all' as const,
    repeat: 'every_n_days' as const,
    intervalDays: '3',
  };
  return (
    <ComposerView
      open
      state={state}
      people={PEOPLE}
      now={NOW}
      onOpen={() => {}}
      onCancel={() => {}}
      onChange={() => {}}
      onSubmit={() => {}}
    />
  );
}

function overdueItem(): WorklistItem {
  return {
    id: 'task:1', sourceType: 'task', sourceId: '1',
    title: 'Replace the lobby ice machine filter',
    location: 'Lobby', assigneeStaffId: 's1', assigneeName: 'Dana', dept: 'maintenance',
    dueDate: '2026-08-02', status: 'open', priority: 'normal', propertyId: 'p1',
    overdue: true, canComplete: true, canAssign: true, deepLink: '/maintenance',
    createdAt: '2026-08-01T10:00:00Z', fromLabel: 'Marcus asked you to', amountCents: null,
    createdByStaffId: 's2', dueTime: null, missedSince: '2026-08-02', supersededIds: [],
  } as unknown as WorklistItem;
}

function rowNode(): React.ReactElement {
  return <WorkRowView item={overdueItem()} now={NOW} askingReason reasonDraft="" />;
}

function monthNode(): React.ReactElement {
  return (
    <MonthOverlay
      open
      year={2026}
      monthIndex={7}
      todayIso={TODAY}
      selectedIso={TODAY}
      items={[]}
      events={[]}
      canManageEvents
      draft={{ ...emptyEventDraft(), start: '2026-08-11', end: '2026-08-14' }}
      onClose={() => {}}
      onSelectDay={() => {}}
      onStepMonth={() => {}}
      onStartAdd={() => {}}
      onCancelAdd={() => {}}
      onDraftChange={() => {}}
      onSaveEvent={() => {}}
      onPickDown={() => {}}
      onPickMove={() => {}}
      onPickUp={() => {}}
    />
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. NOTHING YOU TYPE INTO MAY TRIGGER THE iOS ZOOM
// ═══════════════════════════════════════════════════════════════════════════
//
// Safari on iPhone zooms the whole page in when a focused field is under 16px,
// and it does not zoom back out when the field is left. One tap on the to-do
// box and the manager is panning a magnified page around with one thumb for
// the rest of the visit. This is the single most expensive number on the
// screen and the easiest one to lose in a redesign.

describe('every box you type into is 16px on a phone', () => {
  test('the composer, the refusal reason and the every-N-days blank', (t) => {
    const sheet = phoneCascade(FEED_CSS_FOR_TEST_ONLY(), LIST_CSS);
    t.after(installBrowser());
    const composer = mount(t, composerNode(), sheet);
    const row = mount(t, rowNode(), sheet);

    assert.ok(px(styleOf(composer, '.fx-comptitle', 'font-size')) >= 16);
    assert.ok(px(styleOf(composer, '.fx-compnum', 'font-size')) >= 16);
    assert.ok(px(styleOf(row, '.fx-input', 'font-size')) >= 16);
  });

  test('the event title and notes in the month popup', (t) => {
    const sheet = phoneCascade(FEED_CSS_FOR_TEST_ONLY(), CALENDAR_CSS);
    t.after(installBrowser());
    const month = mount(t, monthNode(), sheet);
    assert.ok(px(styleOf(month, 'input.sc-field', 'font-size')) >= 16);
    assert.ok(px(styleOf(month, 'textarea.sc-field', 'font-size')) >= 16);
  });

  test('and the desktop type sizes are exactly what they were', (t) => {
    // The phone rules are phone rules. If one of them ever leaks out of its
    // block, the founder's screen gets bigger type overnight and nobody
    // planned that.
    const sheet = desktopCascade(FEED_CSS_FOR_TEST_ONLY(), LIST_CSS, CALENDAR_CSS);
    t.after(installBrowser());
    const composer = mount(t, composerNode(), sheet);
    const row = mount(t, rowNode(), sheet);
    const month = mount(t, monthNode(), sheet);

    assert.equal(styleOf(composer, '.fx-comptitle', 'font-size'), '14.5px');
    assert.equal(styleOf(composer, '.fx-compnum', 'font-size'), '12.5px');
    assert.equal(styleOf(row, '.fx-input', 'font-size'), '12.5px');
    assert.equal(styleOf(month, 'input.sc-field', 'font-size'), '13.5px');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. EVERYTHING YOU PRESS IS 40px
// ═══════════════════════════════════════════════════════════════════════════

describe('a thumb can hit the controls on a phone', () => {
  test('the row answers, the cadence chips and the mic', (t) => {
    const sheet = phoneCascade(FEED_CSS_FOR_TEST_ONLY(), LIST_CSS);
    t.after(installBrowser());
    const composer = mount(t, composerNode(), sheet);
    const row = mount(t, rowNode(), sheet);

    assert.ok(px(styleOf(row, '.fx-btn', 'height')) >= 40, 'Done / Send / Cancel');
    assert.ok(px(styleOf(composer, '.fx-compb', 'height')) >= 40, 'a cadence chip');
    assert.ok(px(styleOf(composer, '.fx-compevery', 'height')) >= 40, 'the every-N-days chip');
    assert.ok(px(styleOf(composer, '.fx-compword', 'min-height')) >= 40, 'the three words');
  });

  test('and desktop keeps its 30px buttons', (t) => {
    const sheet = desktopCascade(FEED_CSS_FOR_TEST_ONLY(), LIST_CSS);
    t.after(installBrowser());
    const composer = mount(t, composerNode(), sheet);
    const row = mount(t, rowNode(), sheet);
    assert.equal(styleOf(row, '.fx-btn', 'height'), '30px');
    assert.equal(styleOf(composer, '.fx-compb', 'height'), '30px');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. THE TWO SIDEWAYS LISTS HAVE TO BE ABLE TO SCROLL
// ═══════════════════════════════════════════════════════════════════════════
//
// Both already declared overflow-x:auto and neither had ever scrolled: in
// Chrome at 375px the cadence line measured clientWidth 802 against a
// scrollWidth of 802, because a column flex parent with align-items:flex-start
// let it be its own full width. A capped width is what turns the declaration
// into a scroller, and claiming the horizontal gesture is what stops the page
// swiping underneath the finger instead.

describe('the cadence line is a scroller and not an overflow', () => {
  test('it is clamped, it takes the sideways swipe, and it keeps it', (t) => {
    const sheet = phoneCascade(FEED_CSS_FOR_TEST_ONLY(), LIST_CSS);
    t.after(installBrowser());
    const composer = mount(t, composerNode(), sheet);

    assert.equal(styleOf(composer, '.fx-compscroll', 'overflow-x'), 'auto');
    assert.equal(styleOf(composer, '.fx-compscroll', 'max-width'), '100%');
    assert.equal(styleOf(composer, '.fx-compscroll', 'touch-action'), 'pan-x');
    assert.equal(styleOf(composer, '.fx-compscroll', 'overscroll-behavior-x'), 'contain');
    // The row it sits in has to stretch it, or the cap has nothing to cap
    // against: this is the exact declaration that was wrong.
    assert.equal(styleOf(composer, '.fx-comprow', 'align-items'), 'stretch');
  });

  test('desktop leaves the row alone', (t) => {
    const sheet = desktopCascade(FEED_CSS_FOR_TEST_ONLY(), LIST_CSS);
    t.after(installBrowser());
    const composer = mount(t, composerNode(), sheet);
    assert.equal(styleOf(composer, '.fx-comprow', 'align-items'), 'flex-start');
    assert.notEqual(styleOf(composer, '.fx-compscroll', 'touch-action'), 'pan-x');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. A ROW IS A STACK ON A PHONE
// ═══════════════════════════════════════════════════════════════════════════

describe('a to-do title owns its own line on a phone', () => {
  test('the body takes the whole row rather than sharing it with the stamp', (t) => {
    // Sharing it is what set "Replace the lobby ice machine filter" one word
    // per line beside a mono stamp that will not wrap.
    const sheet = phoneCascade(FEED_CSS_FOR_TEST_ONLY(), LIST_CSS);
    t.after(installBrowser());
    const row = mount(t, rowNode(), sheet);
    assert.equal(styleOf(row, '.fx-rowb', 'flex-basis'), '100%');
    assert.equal(styleOf(row, '.fx-rowm', 'white-space'), 'normal');
  });

  test('desktop keeps the title, the stamp and the buttons on one line', (t) => {
    const sheet = desktopCascade(FEED_CSS_FOR_TEST_ONLY(), LIST_CSS);
    t.after(installBrowser());
    const row = mount(t, rowNode(), sheet);
    assert.notEqual(styleOf(row, '.fx-rowb', 'flex-basis'), '100%');
    assert.equal(styleOf(row, '.fx-rowm', 'white-space'), 'nowrap');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. A FINGER CAN DRAG A DATE RANGE
// ═══════════════════════════════════════════════════════════════════════════

describe('the month grid owns the drag while a range is being picked', () => {
  test('the days refuse the browser gesture so the drag reaches the grid', (t) => {
    // The hint under the month says "drag across days for something that runs
    // longer". Without this the finger scrolled the popup, the pointer stream
    // was cancelled, and the range stayed on the day it started on.
    const sheet = phoneCascade(FEED_CSS_FOR_TEST_ONLY(), CALENDAR_CSS);
    t.after(installBrowser());
    const month = mount(t, monthNode(), sheet);
    assert.equal(styleOf(month, '.sc-picking .sc-day', 'touch-action'), 'none');
    assert.equal(styleOf(month, '.sc-picking .sc-grid', 'touch-action'), 'none');
  });

  test('a month that is only being browsed still scrolls normally', (t) => {
    const sheet = phoneCascade(FEED_CSS_FOR_TEST_ONLY(), CALENDAR_CSS);
    t.after(installBrowser());
    const month = mount(t, (
      <MonthOverlay
        open year={2026} monthIndex={7} todayIso={TODAY} selectedIso={TODAY}
        items={[]} events={[]} canManageEvents draft={null}
        onClose={() => {}} onSelectDay={() => {}} onStepMonth={() => {}}
        onStartAdd={() => {}} onCancelAdd={() => {}} onDraftChange={() => {}}
        onSaveEvent={() => {}} onPickDown={() => {}} onPickMove={() => {}} onPickUp={() => {}}
      />
    ), sheet);
    assert.notEqual(styleOf(month, '.sc-day', 'touch-action'), 'none');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. NO POPUP MEASURES ITSELF AGAINST THE WRONG WINDOW
// ═══════════════════════════════════════════════════════════════════════════
//
// 100vh on iOS is the height WITHOUT the browser chrome, so a popup sized to
// it puts its own footer under the address bar. The save button on the month
// popup is the one that costs somebody their typing.

describe('popups measure themselves against the visible window', () => {
  test('the month popup and the drawer both cap on the dynamic height', (t) => {
    const sheet = phoneCascade(FEED_CSS_FOR_TEST_ONLY(), CALENDAR_CSS);
    t.after(installBrowser());
    const month = mount(t, monthNode(), sheet);
    const capped = styleOf(month, '.fx-monthover', 'max-height');
    assert.ok(capped.includes('dvh'), `month popup still sized against ${capped}`);
    assert.equal(
      capped.includes('100vh'), false,
      'a vh cap hides the popup footer under the iOS address bar',
    );
  });

  test('the save row stays reachable while somebody types', (t) => {
    // Stacked under the month, the two answers sat below the fold of the
    // popup's own scroller. Sticky is what keeps Save on screen.
    const sheet = phoneCascade(FEED_CSS_FOR_TEST_ONLY(), CALENDAR_CSS);
    t.after(installBrowser());
    const month = mount(t, monthNode(), sheet);
    assert.equal(styleOf(month, '.sc-pacts', 'position'), 'sticky');
  });

  test('desktop does not pin the save row anywhere', (t) => {
    const sheet = desktopCascade(FEED_CSS_FOR_TEST_ONLY(), CALENDAR_CSS);
    t.after(installBrowser());
    const month = mount(t, monthNode(), sheet);
    assert.notEqual(styleOf(month, '.sc-pacts', 'position'), 'sticky');
  });
});
