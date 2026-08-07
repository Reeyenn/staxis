/**
 * THE PER-ROW SITUATION MENU.
 *
 * A preventive schedule and a work order used to carry ONE button: Done. Every
 * other situation a manager was actually in — the vendor is coming Thursday, the
 * part is on back order, somebody looked and it was fine, this schedule fires
 * far too often — had to be entered by pressing a button that says the work
 * happened. That is not a missing feature, it is a button that files a fiction
 * into the hotel's own maintenance record.
 *
 * What is pinned here, and why each one would be silent if it broke:
 *
 *   1. THE SETS DO NOT BLEED. A work order must never be offered "Somebody's
 *      been called" and a schedule must never be offered "Waiting on parts".
 *      Both would render perfectly and then be refused by the server, so the
 *      only symptom would be a menu item that does nothing.
 *
 *   2. THE MENU IS NOT THE GUARD. Every action the menu offers has to be an
 *      ending the route accepts FOR THAT SOURCE. This is the pin that keeps the
 *      two tables in step: they are edited in different files, months apart.
 *
 *   3. THE ROWS RENDER IT. The suite runs under `--conditions=react-server`, so
 *      every view in list-rows.tsx is hook-free and controlled precisely so its
 *      element tree can be walked without a browser.
 *
 *   4. THE RESTS ARE ARITHMETIC, NOT VIBES. Seven days for a call, one cadence
 *      for a skip, and both self-expiring. An off-by-one here is a schedule
 *      that comes back a day early (reads as a nag) or never (reads as lost).
 *
 * The copy rules (no em dash, English only, short enough to glance at) are
 * enforced over these same producers in staxis-list-surface.test.ts, which is
 * the corpus guard this screen already had. A second one would be a second
 * thing to remember to extend.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-min-20-chars';
process.env.CRON_SECRET ??= 'placeholder-cron-secret-min-16';
process.env.OPENAI_API_KEY ??= 'sk-placeholder-test-key-min-20-chars';

import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';
import Module from 'node:module';
import type React from 'react';

import {
  cadenceLine,
  ROW_MENU_COPY,
  rowMenuOptions,
  waitingLine,
  type RowMenuAction,
} from '@/lib/feed/one-list-copy';
import {
  PREVENTIVE_FOLLOW_UP_DAYS,
  preventiveRestOf,
  preventiveSkipRestDays,
} from '@/lib/maintenance/preventive-rest';
import { workOrderIsSettled, WORK_ORDER_SETTLED_STATUSES } from '@/lib/db-mappers';
import { WORKLIST_SOURCE_TYPES, type WorklistItem, type WorklistSourceType } from '@/lib/worklist/types';
import { OUTCOME_SOURCES } from '@/app/api/worklist/complete/route';
import { readCadenceDays, MIN_CADENCE_DAYS, MAX_CADENCE_DAYS } from '@/app/api/worklist/assign/route';
import { FEED_CSS_FOR_TEST_ONLY } from '@/components/concourse/concourse-css';

const NOW = new Date('2026-08-07T15:00:00.000Z');
const DAY = 86_400_000;

// ── the React shim ──────────────────────────────────────────────────────────
// React 19's react-server build exports no createContext, and list-rows.tsx
// pulls the concourse icon module. Nothing here mounts a hooks-using component.
const nodeRequire = Module.createRequire(`${process.cwd()}/package.json`);

type RowsModule = typeof import('@/components/concourse/list-rows');
let rows: RowsModule;

before(async () => {
  const react = nodeRequire('react') as Record<string, unknown>;
  if (typeof react.createContext !== 'function') {
    react.createContext = (defaultValue: unknown) => ({
      Provider: () => null,
      Consumer: () => null,
      _currentValue: defaultValue,
    });
  }
  rows = await import('@/components/concourse/list-rows');
});

function item(over: Partial<WorklistItem> & { id: string }): WorklistItem {
  return {
    sourceType: 'task', sourceId: over.id, title: 'a task', location: null,
    assigneeStaffId: null, assigneeName: null, dept: null, dueDate: null,
    status: 'open', priority: 'normal', propertyId: 'p1', overdue: false,
    canComplete: true, canAssign: true, deepLink: '/feed',
    createdAt: '2026-08-06T00:00:00.000Z', fromLabel: null, amountCents: null,
    createdByStaffId: null,
    ...over,
  } as WorklistItem;
}

const pmRow = (over: Partial<WorklistItem> = {}) => item({
  id: 'pm:1', sourceType: 'pm', sourceId: 'pm-1', title: 'Fire panel inspection',
  status: 'overdue', overdue: true, canAssign: false, deepLink: '/maintenance?tab=preventive',
  cadenceDays: 90, ...over,
});

const woRow = (over: Partial<WorklistItem> = {}) => item({
  id: 'workorder:1', sourceType: 'workorder', sourceId: 'wo-1', title: 'Pool light out',
  dept: 'maintenance', deepLink: '/maintenance?tab=work', ...over,
});

/** Every string an element tree renders, flattened. Placeholders and
 *  aria-labels count: a person reads those too. */
function textOf(node: unknown, out: string[] = []): string[] {
  if (node === null || node === undefined || typeof node === 'boolean') return out;
  if (typeof node === 'string') { out.push(node); return out; }
  if (typeof node === 'number') { out.push(String(node)); return out; }
  if (Array.isArray(node)) { for (const n of node) textOf(n, out); return out; }
  const el = node as { props?: Record<string, unknown> };
  if (el.props) {
    for (const [key, value] of Object.entries(el.props)) {
      if (key === 'children') { textOf(value, out); continue; }
      if (/^(placeholder|title|aria-label)$/.test(key) && typeof value === 'string') out.push(value);
    }
  }
  return out;
}

function findAll(
  node: unknown,
  match: (el: { type: unknown; props: Record<string, unknown> }) => boolean,
  out: Array<{ type: unknown; props: Record<string, unknown> }> = [],
) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) { for (const n of node) findAll(n, match, out); return out; }
  const el = node as { type?: unknown; props?: Record<string, unknown> };
  if (el.props) {
    const candidate = { type: el.type, props: el.props };
    if (match(candidate)) out.push(candidate);
    findAll(el.props.children, match, out);
  }
  return out;
}

type RowProps = Parameters<RowsModule['WorkRowView']>[0];
const render = (props: Omit<RowProps, 'now'> & { now?: Date }) =>
  rows.WorkRowView({ now: NOW, ...props } as RowProps) as React.ReactElement;

// ═══════════════════════════════════════════════════════════════════════════
// 1. Which situations belong to which row
// ═══════════════════════════════════════════════════════════════════════════

describe('the option sets do not bleed between row types', () => {
  test('a preventive schedule offers exactly the three upkeep answers', () => {
    const actions = rowMenuOptions(pmRow()).map((o) => o.action);
    assert.deepEqual(actions, ['called', 'reschedule', 'skip']);
  });

  test('a work order offers exactly the three ticket answers', () => {
    const actions = rowMenuOptions(woRow()).map((o) => o.action);
    assert.deepEqual(actions, ['waiting', 'reassign', 'not_an_issue']);
  });

  test('a work order is never offered a preventive answer, and the reverse', () => {
    // The bug this exists for is silent: the menu item renders, the person taps
    // it, and the server refuses. Nothing looks broken and nothing happens.
    const pm = new Set(rowMenuOptions(pmRow()).map((o) => o.action));
    const wo = new Set(rowMenuOptions(woRow()).map((o) => o.action));
    for (const action of wo) assert.ok(!pm.has(action), `a schedule must not offer "${action}"`);
    for (const action of pm) assert.ok(!wo.has(action), `a work order must not offer "${action}"`);
  });

  test('every other row type has no menu at all', () => {
    // Including a to-do, deliberately: its overdue row already grew three
    // honest endings of its own, and a menu over the top would be two ways to
    // say the same four things.
    const withMenus: WorklistSourceType[] = ['pm', 'workorder'];
    for (const sourceType of WORKLIST_SOURCE_TYPES) {
      if (withMenus.includes(sourceType)) continue;
      assert.deepEqual(
        rowMenuOptions({ sourceType, canComplete: true }),
        [],
        `${sourceType} must not grow a situation menu`,
      );
    }
  });

  test('a row this person cannot settle has no situations either', () => {
    // Same question in different words. Somebody who cannot close a ticket from
    // the list cannot defer it from there either.
    assert.deepEqual(rowMenuOptions({ sourceType: 'pm', canComplete: false }), []);
    assert.deepEqual(rowMenuOptions({ sourceType: 'workorder', canComplete: false }), []);
  });

  test('every option says what it costs, and none of them says "Adjust"', () => {
    // The founder banned "Adjust" by name. An option that does not say what it
    // does is a question mark, and a manager who taps one and cannot predict
    // the result stops tapping any of them.
    for (const sourceType of WORKLIST_SOURCE_TYPES) {
      for (const option of rowMenuOptions({ sourceType, canComplete: true })) {
        assert.ok(option.hint.trim().length > 0, `${option.action} has no hint`);
        assert.doesNotMatch(option.label, /\badjust\b/i, `"${option.label}" is the banned word`);
        assert.doesNotMatch(option.label, /\bAI\b/, 'the interface never says AI');
        assert.doesNotMatch(option.hint, /\bAI\b/, 'the interface never says AI');
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. The menu is not the guard
// ═══════════════════════════════════════════════════════════════════════════

describe('every option the menu offers is an ending the server accepts', () => {
  /** The four options that settle a row. The other two change something about
   *  it instead and go through /api/worklist/assign. */
  const SETTLING: readonly RowMenuAction[] = ['called', 'skip', 'waiting', 'not_an_issue'];

  test('each settling option is allowed for the row type that offers it', () => {
    for (const sourceType of WORKLIST_SOURCE_TYPES) {
      for (const option of rowMenuOptions({ sourceType, canComplete: true })) {
        if (!SETTLING.includes(option.action)) continue;
        const rule = OUTCOME_SOURCES[option.action as keyof typeof OUTCOME_SOURCES];
        assert.ok(rule, `the route has no rule for "${option.action}"`);
        assert.ok(
          rule.sources.includes(sourceType),
          `the menu offers "${option.action}" on a ${sourceType} row that the route refuses`,
        );
      }
    }
  });

  test('and the route refuses it on every row type that does not offer it', () => {
    for (const action of SETTLING) {
      const rule = OUTCOME_SOURCES[action as keyof typeof OUTCOME_SOURCES];
      for (const sourceType of WORKLIST_SOURCE_TYPES) {
        const offered = rowMenuOptions({ sourceType, canComplete: true })
          .some((o) => o.action === action);
        if (offered) continue;
        // 'skip' is the one that is genuinely shared: a to-do can be skipped
        // through its own overdue row, which is not this menu.
        if (action === 'skip' && sourceType === 'task') continue;
        assert.ok(
          !rule.sources.includes(sourceType),
          `the route accepts "${action}" on a ${sourceType} that nothing offers it on`,
        );
      }
    }
  });

  test('every refusal names what may do it instead, without an em dash', () => {
    for (const rule of Object.values(OUTCOME_SOURCES)) {
      assert.ok(rule.refusal.trim().length > 0);
      assert.ok(!rule.refusal.includes('—'), `em dash in: ${rule.refusal}`);
      assert.ok(rule.sources.length > 0, 'an ending nothing may be given is dead code');
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. What the row actually draws
// ═══════════════════════════════════════════════════════════════════════════

describe('the row renders the situations, and nothing it should not', () => {
  test('a schedule grows a quiet trigger beside Done', () => {
    const tree = render({ item: pmRow() });
    const trigger = findAll(tree, (el) => el.props['aria-haspopup'] === 'menu');
    assert.equal(trigger.length, 1, 'exactly one way in');
    assert.equal(trigger[0].props['aria-expanded'], false);
    assert.equal(trigger[0].props['aria-label'], ROW_MENU_COPY.open, 'the glyph alone is not a label');
    // Done is still the one big button.
    const primary = findAll(tree, (el) => String(el.props.className ?? '').includes('fx-primary'));
    assert.equal(primary.length, 1);
  });

  test('a plain to-do grows nothing', () => {
    const tree = render({ item: item({ id: 't1' }) });
    assert.equal(findAll(tree, (el) => el.props['aria-haspopup'] === 'menu').length, 0);
  });

  test('opening it shows the three upkeep answers and their hints', () => {
    const text = textOf(render({ item: pmRow(), menuOpen: true })).join(' | ');
    assert.match(text, /Somebody's been called/);
    assert.match(text, /Change the schedule/);
    assert.match(text, /Skip this one/);
    assert.match(text, /goes quiet for a week/i, 'the rest is named out loud');
    assert.match(text, /Nothing is marked done/i);
    assert.doesNotMatch(text, /Waiting on parts/, 'a schedule is not a ticket');
  });

  test('a work order shows the three ticket answers and no upkeep ones', () => {
    const text = textOf(render({ item: woRow(), menuOpen: true })).join(' | ');
    assert.match(text, /Waiting on parts/);
    assert.match(text, /Give it to someone else/);
    assert.match(text, /Not actually a problem/);
    assert.match(text, /not recorded as a repair/i, 'the honest half of the closing option');
    assert.doesNotMatch(text, /Somebody's been called/);
    assert.doesNotMatch(text, /Skip this one/);
  });

  test('a closed menu draws no menu', () => {
    const text = textOf(render({ item: pmRow(), menuOpen: false })).join(' | ');
    assert.doesNotMatch(text, /Skip this one/);
  });

  test('there is always a way out that is not one of its own items', () => {
    const tree = render({ item: pmRow(), menuOpen: true });
    const escapes = findAll(tree, (el) => el.props['aria-label'] === ROW_MENU_COPY.cancel);
    assert.ok(escapes.length >= 1, 'a menu with no exit is a trap');
  });

  test('"Waiting on parts" opens a box that refuses to send empty', () => {
    const empty = render({ item: woRow(), menuAsking: 'waiting', menuDraft: '   ' });
    const send = findAll(empty, (el) => el.type === 'button'
      && String(el.props.children ?? '') === ROW_MENU_COPY.send);
    assert.equal(send.length, 1);
    assert.equal(send[0].props.disabled, true, 'a reasonless deferral is a row that just went quiet');

    const said = render({ item: woRow(), menuAsking: 'waiting', menuDraft: 'compressor is back ordered' });
    const ready = findAll(said, (el) => el.type === 'button'
      && String(el.props.children ?? '') === ROW_MENU_COPY.send);
    assert.equal(ready[0].props.disabled, false);
  });

  test('"Change the schedule" opens on the cadence it is changing', () => {
    // A cadence editor that starts blank is one where somebody has to remember
    // what it was, and the commonest edit is nudging 30 to 60.
    const tree = render({ item: pmRow({ cadenceDays: 90 }), menuAsking: 'reschedule', menuDraft: '90' });
    const box = findAll(tree, (el) => el.props['aria-label'] === ROW_MENU_COPY.daysAria);
    assert.equal(box.length, 1);
    assert.equal(box[0].props.value, '90');
  });

  test('a half-typed cadence is not saveable', () => {
    for (const draft of ['', '0', '9999', 'x']) {
      const tree = render({ item: pmRow(), menuAsking: 'reschedule', menuDraft: draft });
      const save = findAll(tree, (el) => el.type === 'button'
        && String(el.props.children ?? '') === ROW_MENU_COPY.save);
      assert.equal(save[0].props.disabled, true, `"${draft}" must not be sendable as a cadence`);
    }
    const ok = render({ item: pmRow(), menuAsking: 'reschedule', menuDraft: '60' });
    const save = findAll(ok, (el) => el.type === 'button'
      && String(el.props.children ?? '') === ROW_MENU_COPY.save);
    assert.equal(save[0].props.disabled, false);
  });

  test('"Give it to someone else" offers the roster, and says so when it is empty', () => {
    const withPeople = render({
      item: woRow(), menuAsking: 'reassign',
      menuPeople: [{ staffId: 's1', name: 'Dana Pike' }, { staffId: 's2', name: 'Marcus Webb' }],
    });
    const text = textOf(withPeople).join(' | ');
    assert.match(text, /Dana Pike/);
    assert.match(text, /Marcus Webb/);

    const alone = textOf(render({ item: woRow(), menuAsking: 'reassign', menuPeople: [] })).join(' | ');
    assert.match(alone, new RegExp(ROW_MENU_COPY.noPeople.replace(/\./g, '\\.')));
  });

  test('a deferred ticket says why, on the row, in the words somebody used', () => {
    const tree = render({ item: woRow({ status: 'waiting', priority: 'low', waitingReason: 'compressor back ordered until Friday' }) });
    const text = textOf(tree).join(' | ');
    assert.match(text, /Waiting on parts: compressor back ordered until Friday/);
    // And it is still a row anybody can finish: a defer is not a removal.
    assert.equal(findAll(tree, (el) => String(el.props.className ?? '').includes('fx-primary')).length, 1);
  });

  test('the busy row cannot be tapped twice', () => {
    const tree = render({ item: pmRow(), busy: true });
    const trigger = findAll(tree, (el) => el.props['aria-haspopup'] === 'menu');
    assert.equal(trigger[0].props.disabled, true);
  });

  test('the menu is not offered while the row is already asking something', () => {
    // Two open questions on one row is a row nobody can answer.
    const refusing = render({ item: item({ id: 't1' }), askingReason: true });
    assert.equal(findAll(refusing, (el) => el.props['aria-haspopup'] === 'menu').length, 0);
    const asking = render({ item: woRow(), menuAsking: 'waiting', menuDraft: '' });
    assert.equal(findAll(asking, (el) => el.props['aria-haspopup'] === 'menu').length, 0);
  });

  test('nothing it names is undefined in the stylesheet', () => {
    // A no-runtime invariant, checked as one. The regression it guards: a class
    // that exists only in the component silently loses its layout, and a menu
    // with no position is a menu drawn in the middle of the page.
    const css = `${rows.LIST_CSS}\n${FEED_CSS_FOR_TEST_ONLY()}`;
    const named = new Set<string>();
    const states: Array<Partial<RowProps>> = [
      { item: pmRow() },
      { item: pmRow(), menuOpen: true },
      { item: pmRow(), menuAsking: 'reschedule', menuDraft: '90' },
      { item: woRow(), menuOpen: true },
      { item: woRow(), menuAsking: 'waiting', menuDraft: 'a reason' },
      { item: woRow(), menuAsking: 'reassign', menuPeople: [{ staffId: 's1', name: 'Dana' }] },
      { item: woRow({ status: 'waiting', waitingReason: 'back ordered' }) },
    ];
    for (const state of states) {
      const tree = render(state as Omit<RowProps, 'now'>);
      for (const el of findAll(tree, (node) => typeof node.props.className === 'string')) {
        for (const token of String(el.props.className).split(/\s+/)) if (token) named.add(token);
      }
    }
    assert.ok(named.size > 8, `expected the walk to reach the menu, saw ${named.size} classes`);
    const missing = [...named].filter((token) => !css.includes(`.${token}`)).sort();
    assert.deepEqual(missing, [], `classes used but never defined: ${missing.join(', ')}`);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. The two rests, as arithmetic
// ═══════════════════════════════════════════════════════════════════════════

describe('a schedule rests for exactly as long as it says it will', () => {
  const at = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();
  const rest = (over: Partial<Parameters<typeof preventiveRestOf>[0]>) => preventiveRestOf({
    calledAt: null, skippedAt: null, frequencyDays: 90, nowMs: NOW.getTime(), ...over,
  });

  test('a call goes quiet for a week and then asks again', () => {
    assert.equal(rest({ calledAt: at(0) }), 'called');
    assert.equal(rest({ calledAt: at(PREVENTIVE_FOLLOW_UP_DAYS - 1) }), 'called');
    // The boundary is the whole feature: a day early reads as a nag, and never
    // coming back reads as the schedule having been lost.
    assert.equal(rest({ calledAt: at(PREVENTIVE_FOLLOW_UP_DAYS) }), null);
  });

  test('a skip goes quiet for one full cadence, whatever the cadence is', () => {
    assert.equal(rest({ skippedAt: at(1), frequencyDays: 90 }), 'skipped');
    assert.equal(rest({ skippedAt: at(89), frequencyDays: 90 }), 'skipped');
    assert.equal(rest({ skippedAt: at(90), frequencyDays: 90 }), null);
    // A daily schedule skipped today is back tomorrow, which is what skipping
    // ONE occurrence of a daily job has to mean.
    assert.equal(rest({ skippedAt: at(0), frequencyDays: 1 }), 'skipped');
    assert.equal(rest({ skippedAt: at(1), frequencyDays: 1 }), null);
  });

  test('a skip outranks a call when a row somehow carries both', () => {
    assert.equal(rest({ calledAt: at(1), skippedAt: at(1) }), 'skipped');
  });

  test('a rest dated in the future is not a rest anybody asked for', () => {
    // The database refuses one (0366, 0462). This is the belt to those braces.
    const future = new Date(NOW.getTime() + 3 * DAY).toISOString();
    assert.equal(rest({ calledAt: future }), null);
    assert.equal(rest({ skippedAt: future }), null);
  });

  test('an unreadable date rests nothing rather than resting forever', () => {
    assert.equal(rest({ calledAt: 'not a date' }), null);
    assert.equal(rest({ skippedAt: '' }), null);
  });

  test('a cadence the database could not have stored still produces a finite rest', () => {
    for (const bad of [0, -5, Number.NaN]) {
      assert.ok(preventiveSkipRestDays(bad) >= 1, `${bad} must not produce an instant or eternal rest`);
    }
    assert.equal(preventiveSkipRestDays(90), 90);
  });

  test('a row written before 0462 has no skip and rests only on its call', () => {
    // The column is absent on a hotel whose migration has not been applied yet.
    assert.equal(preventiveRestOf({
      calledAt: at(1), frequencyDays: 90, nowMs: NOW.getTime(),
    }), 'called');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. The two endings a work order can have, and the words on the row
// ═══════════════════════════════════════════════════════════════════════════

describe('a closed ticket is off the board, a deferred one is not', () => {
  test('resolved and closed are both endings, deferred is not', () => {
    assert.equal(workOrderIsSettled('resolved'), true);
    assert.equal(workOrderIsSettled('closed'), true);
    for (const live of ['submitted', 'assigned', 'in_progress', 'deferred', null, undefined, '']) {
      assert.equal(workOrderIsSettled(live), false, `"${String(live)}" is still live work`);
    }
  });

  test('the two endings stay two words', () => {
    // Folding "not a problem" into `resolved` would put a repair into this
    // hotel's history that never happened.
    assert.deepEqual([...WORK_ORDER_SETTLED_STATUSES].sort(), ['closed', 'resolved']);
  });

  test('the waiting line is prefixed, so it reads as a person speaking', () => {
    assert.equal(waitingLine('back ordered'), 'Waiting on parts: back ordered');
    assert.equal(waitingLine('  '), null, 'a blank reason says nothing and should draw nothing');
    assert.equal(waitingLine(null), null);
  });

  test('the cadence line says days, and says "Every day" rather than "Every 1 days"', () => {
    assert.equal(cadenceLine(1), 'Every day');
    assert.equal(cadenceLine(90), 'Every 90 days');
    assert.equal(cadenceLine(0), null);
    assert.equal(cadenceLine(null), null);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. The cadence bounds, on both sides of the wire
// ═══════════════════════════════════════════════════════════════════════════

describe('a cadence is a whole number of days inside the bounds', () => {
  test('the server accepts a real cadence and nothing else', () => {
    assert.equal(readCadenceDays(1), 1);
    assert.equal(readCadenceDays('365'), 365);
    assert.equal(readCadenceDays(MAX_CADENCE_DAYS), MAX_CADENCE_DAYS);
    for (const bad of [0, -1, 1.5, MAX_CADENCE_DAYS + 1, 'many', '', null, undefined, {}]) {
      assert.equal(readCadenceDays(bad), null, `${JSON.stringify(bad)} is not a cadence`);
    }
  });

  test('a daily schedule is allowed, because a daily walk is a real schedule', () => {
    assert.equal(MIN_CADENCE_DAYS, 1);
  });

  test('the button and the server agree about what is sendable', () => {
    // Two spellings of the same bound is how a Save button ends up enabled for
    // a value the route then refuses.
    for (const draft of ['1', '30', '3650']) {
      assert.equal(rows.readCadenceDraft(draft) !== null, readCadenceDays(draft) !== null, draft);
    }
    for (const draft of ['0', '3651', '', 'x', '1.5']) {
      assert.equal(rows.readCadenceDraft(draft) !== null, readCadenceDays(draft) !== null, draft);
    }
  });
});
