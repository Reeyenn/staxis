/**
 * WHAT THE STAXIS LIST PUTS ON A SCREEN.
 *
 * Three things, none of which the ordering tests can reach:
 *
 *   1. THE COMPOSER'S DEFAULTS. "Type and press Enter" has to mean you, today,
 *      once. Every extra decision the composer forces is a to-do somebody does
 *      not bother writing down, and defaults are exactly the kind of thing that
 *      drifts silently.
 *
 *   2. THE COPY. No em dashes anywhere a person reads (founder ruling,
 *      2026-07-28), English only (2026-07-29), and "who it is from" is part of
 *      the SENTENCE rather than a tag. Walks the real producers over a fixture
 *      matrix built to reach their branches, the same shape as
 *      findings-copy-rules.test.ts — a grep of the source would pass on a dash
 *      arriving through an interpolation and fail on a harmless rename.
 *
 *   3. THE ROWS THEMSELVES. The suite runs under `--conditions=react-server`,
 *      so react-dom/server will not load; every view in list-rows.tsx is
 *      hook-free and controlled precisely so its element tree can be walked.
 *      What is checked here is the behaviour a person would notice: a to-do
 *      offers Done and "Can't do this", the reason box refuses to send empty,
 *      and a failed read is never drawn as "nothing outstanding".
 */

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-min-20-chars';

import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';
import Module from 'node:module';
import type React from 'react';

import {
  ASSIGNED_COPY,
  assignedMoreLine,
  assignedNote,
  assignedStateLine,
  cadenceLine,
  completionNotice,
  COMPOSER_COPY,
  COMPOSER_OTHER,
  dueLine,
  emptyListNote,
  enterTakesNote,
  EVENT_COPY,
  intervalHint,
  otherHint,
  pickedDaysLine,
  PROMPT_EXAMPLES,
  repeatLabel,
  repeatWord,
  ROW_MENU_COPY,
  rowFrom,
  rowKindLabel,
  rowMenuOptions,
  stalenessLine,
  waitingLine,
  WEEKDAYS,
  whenWord,
  whichDayQuestion,
  whoWord,
} from '@/lib/feed/one-list-copy';
import {
  isTemplateDueOn,
  normalizeCadence,
  RECURRING_CADENCES,
} from '@/lib/recurring-tasks/store';
import {
  MonthOverlay,
  dayOf,
  dayStamp,
  dayTitle,
  draftRange,
  draftReady,
  emptyEventDraft,
  monthCells,
  weekCells,
  weekRangeLabel,
  type EventDraft,
} from '@/components/concourse/list-calendar';
import type { AssignedByMeItem, WorklistItem, WorklistSourceType } from '@/lib/worklist/types';
import { WORKLIST_SOURCE_TYPES } from '@/lib/worklist/types';
import { WORKLIST_DEEPLINK } from '@/lib/worklist/core';

const EM_DASH = '—';
const NOW = new Date('2026-07-30T15:00:00.000Z');

// ── the React shim ──────────────────────────────────────────────────────────
// Same shim, same reasons, as concourse-queue-honesty.test.ts: React 19's
// react-server build exports no createContext, and list-rows.tsx pulls the
// concourse icon module. Nothing here mounts a hooks-using component.
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

// ── fixtures ────────────────────────────────────────────────────────────────

function item(over: Partial<WorklistItem> & { id: string }): WorklistItem {
  return {
    sourceType: 'task', sourceId: over.id, title: 'a task', location: null,
    assigneeStaffId: null, assigneeName: null, dept: null, dueDate: null,
    status: 'open', priority: 'normal', propertyId: 'p1', overdue: false,
    canComplete: true, canAssign: true, deepLink: '/feed',
    createdAt: '2026-07-29T00:00:00.000Z', fromLabel: null, amountCents: null,
    ...over,
  } as WorklistItem;
}

function assigned(over: Partial<AssignedByMeItem> = {}): AssignedByMeItem {
  return {
    taskId: 't', title: 'Change the lobby filters', assigneeStaffId: 'm',
    assigneeName: 'Marcus', assignedDepartment: null, state: 'waiting',
    dueDate: null, createdAt: '2026-07-24T00:00:00.000Z',
    settledByName: null, settledByStaffId: null, settledAt: null, reason: null,
    completedForDate: null, ageDays: 6,
    ...over,
  };
}

/** Every string an element tree renders, flattened. */
function textOf(node: unknown, out: string[] = []): string[] {
  if (node === null || node === undefined || typeof node === 'boolean') return out;
  if (typeof node === 'string') { out.push(node); return out; }
  if (typeof node === 'number') { out.push(String(node)); return out; }
  if (Array.isArray(node)) { for (const n of node) textOf(n, out); return out; }
  const el = node as { props?: Record<string, unknown> };
  if (el.props) {
    for (const [key, value] of Object.entries(el.props)) {
      if (key === 'children') { textOf(value, out); continue; }
      // Placeholders, aria-labels and titles are read by a person too.
      if (/^(placeholder|title|aria-label)$/.test(key) && typeof value === 'string') out.push(value);
    }
  }
  return out;
}

/** Walk an element tree collecting every node that matches. */
function findAll(node: unknown, match: (el: { type: unknown; props: Record<string, unknown> }) => boolean, out: Array<{ type: unknown; props: Record<string, unknown> }> = []) {
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

// ── 1. the composer's defaults ──────────────────────────────────────────────

describe('the composer: type and press Enter', () => {
  test('the defaults are you, today, once', () => {
    const state = rows.composerDefaults('2026-07-30', 4);
    assert.equal(state.who, 'me');
    assert.equal(state.when, '2026-07-30');
    assert.equal(state.repeat, 'once');
    assert.equal(state.title, '');
  });

  test('typing a sentence and sending produces exactly that: mine, due today, no template', () => {
    const state = { ...rows.composerDefaults('2026-07-30', 4), title: 'Check the pool chemicals' };
    const payload = rows.composerPayload(state, 'my-staff-id');
    assert.ok(payload);
    assert.equal(payload.title, 'Check the pool chemicals');
    assert.equal(payload.assignedStaffId, 'my-staff-id');
    assert.equal(payload.assignedDepartment, null);
    assert.equal(payload.repeat, 'once');
    assert.equal(payload.dueDate, '2026-07-30', 'sends the calendar day, not an instant');
    assert.equal(payload.weekday, undefined);
    assert.equal(payload.dayOfMonth, undefined);
  });

  test('an empty or whitespace title sends nothing at all', () => {
    assert.equal(rows.composerPayload(rows.composerDefaults('2026-07-30', 4), 'me'), null);
    assert.equal(rows.composerPayload({ ...rows.composerDefaults('2026-07-30', 4), title: '   ' }, 'me'), null);
  });

  test('picking a person assigns to them and to nobody else', () => {
    const payload = rows.composerPayload(
      { ...rows.composerDefaults('2026-07-30', 4), title: 'x', who: 'marcus' },
      'me',
    );
    assert.equal(payload?.assignedStaffId, 'marcus');
    assert.equal(payload?.assignedDepartment, null);
  });

  test('picking a role assigns to the role and to no individual', () => {
    const payload = rows.composerPayload(
      { ...rows.composerDefaults('2026-07-30', 4), title: 'x', who: 'dept:front_desk' },
      'me',
    );
    assert.equal(payload?.assignedStaffId, null);
    assert.equal(payload?.assignedDepartment, 'front_desk');
  });

  test('a repeating to-do carries its cadence and NO single due date', () => {
    // A template decides each day; a stored dueAt would be a second, disagreeing
    // opinion about when the first one is due.
    const weekly = rows.composerPayload(
      { ...rows.composerDefaults('2026-07-30', 4), title: 'x', repeat: 'weekly', weekday: 2 },
      'me',
    );
    assert.equal(weekly?.repeat, 'weekly');
    assert.equal(weekly?.weekday, 2);
    assert.equal(weekly?.dueDate, null);

    const monthly = rows.composerPayload(
      { ...rows.composerDefaults('2026-07-30', 4), title: 'x', repeat: 'monthly', dayOfMonth: 15 },
      'me',
    );
    assert.equal(monthly?.dayOfMonth, 15);
    assert.equal(monthly?.weekday, undefined, 'a monthly template must not also claim a weekday');
  });

  test('every repeat the chip offers is one the server understands', () => {
    // 'once' is this file's own word for "no template at all"; everything else
    // has to be a cadence recurring_task_templates can actually store, or the
    // chip creates a to-do that never comes back and nothing says why.
    for (const choice of rows.REPEAT_CHOICES) {
      if (choice.value === 'once') continue;
      assert.ok(
        (RECURRING_CADENCES as readonly string[]).includes(choice.value),
        `the chip offers "${choice.label}", which the server cannot store`,
      );
    }
    assert.deepEqual(
      rows.REPEAT_CHOICES.map((r) => r.label),
      ['Once', 'Every day', 'Every 3 days', 'Every 4 days', 'Every week', 'Every 2 weeks', 'Every month'],
    );
  });

  test('an every-N-days chip carries the gap it advertises', () => {
    for (const choice of rows.REPEAT_CHOICES.filter((c) => c.value === 'every_n_days')) {
      const payload = rows.composerPayload(
        {
          ...rows.composerDefaults('2026-07-30', 4),
          title: 'Flush the water heater',
          repeat: 'every_n_days',
          intervalDays: String(choice.intervalDays),
        },
        'me',
      );
      assert.equal(payload?.repeat, 'every_n_days');
      assert.equal(payload?.intervalDays, choice.intervalDays);
      assert.equal(payload?.dueDate, null, 'a repeating to-do has no single due day');
      assert.equal(payload?.weekday, undefined);
      assert.equal(payload?.dayOfMonth, undefined);
      assert.match(choice.label, new RegExp(`Every ${choice.intervalDays} days`));
    }
  });

  test('a typed gap round-trips into a cadence the scheduler actually fires on', () => {
    const payload = rows.composerPayload(
      { ...rows.composerDefaults('2026-07-30', 4), title: 'Backwash the sand filter', repeat: 'every_n_days', intervalDays: '5' },
      'me',
    );
    assert.equal(payload?.intervalDays, 5);
    // The server's own validator accepts it...
    const params = normalizeCadence('every_n_days', { intervalDays: payload!.intervalDays! }, '2026-07-30');
    assert.equal(params.intervalDays, 5);
    assert.equal(params.anchorDate, '2026-07-30');
    // ...and the spawner then fires on exactly those days.
    const fires = (iso: string) => isTemplateDueOn(
      { cadence: 'every_n_days', weekday: null, dayOfMonth: null, anchorDate: params.anchorDate, intervalDays: params.intervalDays },
      { date: iso, weekday: 0 },
    );
    assert.equal(fires('2026-07-30'), true);
    assert.equal(fires('2026-08-04'), true);
    assert.equal(fires('2026-08-03'), false);
  });

  test('a gap the cadence cannot carry falls back to a one-off rather than a dead template', () => {
    // A template with no believable gap never spawns anything, and the person
    // who typed it would never learn why. A plain to-do due today is the
    // smallest honest thing to do with those words instead.
    for (const typed of ['', '0', '1', '900', 'abc']) {
      const payload = rows.composerPayload(
        { ...rows.composerDefaults('2026-07-30', 4), title: 'x', repeat: 'every_n_days', intervalDays: typed },
        'me',
      );
      assert.equal(payload?.repeat, 'once', `"${typed}" produced a repeat with no gap in it`);
      assert.equal(payload?.intervalDays, undefined);
      assert.equal(payload?.dueDate, '2026-07-30');
    }
  });

  test('housekeeping is not a role the composer can target', () => {
    // The exclusion is enforced server-side too (listAssignees). Both, because
    // a task nobody can see is worse than a task nobody can create.
    assert.ok(!rows.COMPOSER_ROLES.some((r) => r.value.includes('housekeeping')));
  });

  test('"Other" is a pointer at the sentence and can never become an assignee', () => {
    // The chip exists to say that typing a name works. A to-do actually
    // ASSIGNED to the word "other" is a to-do nobody has.
    const payload = rows.composerPayload(
      { ...rows.composerDefaults('2026-07-30', 4), title: 'x', who: COMPOSER_OTHER },
      'my-staff-id',
    );
    assert.equal(payload?.assignedStaffId, 'my-staff-id', 'it fell back to the person adding it');
    assert.equal(payload?.assignedDepartment, null);
    // And it cannot get into `who` through the one door that sets it either.
    const chosen = rows.withChoice(
      rows.composerDefaults('2026-07-30', 4), { who: COMPOSER_OTHER }, '2026-07-30', 4,
    );
    assert.equal(chosen.who, 'me');
  });
});

// ── 2. the copy ─────────────────────────────────────────────────────────────

describe('the copy rules', () => {
  /** Every sentence the list can produce, over a matrix built to hit branches. */
  function everySentence(): string[] {
    const out: string[] = [];

    for (const sourceType of WORKLIST_SOURCE_TYPES) {
      for (const fromLabel of [null, 'Marcus']) {
        const line = rowFrom({ sourceType, fromLabel });
        if (line) out.push(line);
      }
      out.push(rowKindLabel(sourceType));
    }

    for (const iso of [
      '2026-07-30T10:00:00.000Z', '2026-07-29T10:00:00.000Z', '2026-07-24T10:00:00.000Z',
      '2026-07-31T10:00:00.000Z', '2026-08-02T10:00:00.000Z', '2026-09-30T10:00:00.000Z',
    ]) {
      const line = dueLine(iso, NOW);
      if (line) out.push(line);
    }

    for (const state of ['waiting', 'done', 'cant'] as const) {
      for (const settledAt of [null, '2026-07-30T09:00:00.000Z', '2026-07-29T09:00:00.000Z', '2026-07-20T09:00:00.000Z']) {
        const entry = assigned({ state, settledAt, settledByName: state === 'waiting' ? null : 'Marcus' });
        out.push(assignedStateLine(entry, NOW));
        out.push(completionNotice(entry));
      }
      for (const ageDays of [0, 1, 2, 9]) {
        const line = stalenessLine({ state, ageDays });
        if (line) out.push(line);
      }
    }

    for (const repeat of ['once', 'daily', 'weekdays', 'weekly', 'biweekly', 'monthly', 'every_n_days']) {
      for (const weekday of [null, 0, 3, 6]) {
        for (const dayOfMonth of [null, 1, 2, 3, 11, 22]) {
          for (const intervalDays of [null, 2, 3, 45, 365]) {
            out.push(repeatLabel(repeat, { weekday, dayOfMonth, intervalDays }));
          }
        }
      }
    }

    out.push(emptyListNote({ canSeeFindings: true }));
    out.push(emptyListNote({ canSeeFindings: false }));
    for (const r of rows.REPEAT_CHOICES) out.push(r.label);
    out.push(otherHint('Marcus Webb'), otherHint(''), otherHint(null));
    out.push(intervalHint(2, 365));
    out.push(...PROMPT_EXAMPLES);
    out.push(...Object.values(ASSIGNED_COPY));
    out.push(...Object.values(EVENT_COPY));
    out.push(assignedMoreLine(9, 3) ?? '', assignedMoreLine(4, 3) ?? '');
    out.push(pickedDaysLine('2026-08-12', null), pickedDaysLine('2026-08-12', '2026-08-15'),
      pickedDaysLine(null, null), pickedDaysLine('nonsense', null));
    for (const r of rows.COMPOSER_ROLES) out.push(r.label);
    for (const d of WEEKDAYS) out.push(d);

    // The "add a to-do" row: its three words, its one question, and every fixed
    // sentence it can say. Walked HERE and not only in the composer's own file
    // because this is the guard that already exists for this screen's copy, and
    // a second one would be a second thing to remember to extend.
    const people = [{ staffId: 'p1', name: 'Marcus Webb' }];
    out.push(...Object.values(COMPOSER_COPY));
    for (const who of ['me', 'p1', 'dept:front_desk', 'dept:maintenance', 'dept:all_staff', 'gone']) {
      out.push(whoWord(who, people));
    }
    for (const iso of ['2026-07-30', '2026-07-31', '2026-08-01', '2026-09-30', null]) {
      out.push(whenWord(iso, NOW));
      out.push(whenWord(iso, NOW, { repeating: true }));
    }
    for (const repeat of ['once', 'daily', 'weekdays', 'weekly', 'biweekly', 'monthly', 'every_n_days']) {
      for (const weekday of [null, 0, 5]) {
        for (const dayOfMonth of [null, 3, 11]) {
          for (const intervalDays of [null, 3, 90]) {
            out.push(repeatWord(repeat, { weekday, dayOfMonth, intervalDays }));
          }
        }
      }
    }
    const question = whichDayQuestion('Friday', '2026-07-31', 5);
    out.push(question.prompt, ...question.choices.map((c) => c.label));
    out.push(enterTakesNote(question.choices[0].label));
    out.push(assignedNote('Marcus Webb'), assignedNote(''));

    // The per-row situation menu: its fixed words, and every option label AND
    // hint on every row type that has one. The hints are walked deliberately —
    // they are the half of each option that says what it costs, they are the
    // longest strings on the row, and a rule that only checked labels would
    // have covered the short half of the copy.
    out.push(...Object.values(ROW_MENU_COPY));
    for (const sourceType of WORKLIST_SOURCE_TYPES) {
      for (const option of rowMenuOptions({ sourceType, canComplete: true })) {
        out.push(option.label, option.hint);
      }
    }
    out.push(waitingLine('the compressor is back ordered') ?? '');
    out.push(cadenceLine(1) ?? '', cadenceLine(90) ?? '');

    return out;
  }

  test('no em dash reaches a person', () => {
    for (const line of everySentence()) {
      assert.ok(!line.includes(EM_DASH), `em dash in: ${line}`);
    }
  });

  test('nothing is empty or whitespace', () => {
    for (const line of everySentence()) {
      assert.ok(line.trim().length > 0, 'a blank line is a blank space on the screen');
    }
  });

  test('the sentences stay short enough to glance at', () => {
    for (const line of everySentence()) {
      assert.ok(line.length <= 120, `too long to glance at: ${line}`);
    }
  });

  test('no Spanish creeps back in', () => {
    // English-only, founder ruling 2026-07-29. A cheap shape check on the
    // characters Spanish copy would bring with it.
    for (const line of everySentence()) {
      assert.ok(!/[¿¡ñáéíóú]/i.test(line), `looks like Spanish: ${line}`);
    }
  });

  test('who it is from reads as a sentence, not a tag', () => {
    assert.equal(rowFrom({ sourceType: 'task', fromLabel: 'Marcus' }), 'Marcus asked you to');
    assert.equal(rowFrom({ sourceType: 'complaint', fromLabel: null }), 'A guest reported this');
    // A work order is a fact about the hotel. Nobody asked, so nobody is named.
    assert.equal(rowFrom({ sourceType: 'workorder', fromLabel: null }), null);
    assert.equal(rowFrom({ sourceType: 'inspection', fromLabel: null }), null);
  });

  test('a to-do you typed for yourself is not introduced to you', () => {
    assert.equal(rowFrom({ sourceType: 'task', fromLabel: null }), null);
  });

  test('the due line never makes a person do arithmetic', () => {
    assert.equal(dueLine('2026-07-30T23:00:00.000Z', NOW), 'Due today');
    assert.equal(dueLine('2026-07-31T10:00:00.000Z', NOW), 'Due tomorrow');
    assert.equal(dueLine('2026-07-29T10:00:00.000Z', NOW), 'Late since yesterday');
    assert.equal(dueLine('2026-07-27T10:00:00.000Z', NOW), '3 days late');
    assert.equal(dueLine(null, NOW), null);
    assert.equal(dueLine('not a date', NOW), null);
  });

  test('the staleness line stays quiet until it is worth saying', () => {
    assert.equal(stalenessLine({ state: 'waiting', ageDays: 0 }), null);
    assert.equal(stalenessLine({ state: 'waiting', ageDays: 1 }), null);
    assert.equal(stalenessLine({ state: 'waiting', ageDays: 6 }), 'Assigned 6 days ago, still open');
    assert.equal(stalenessLine({ state: 'done', ageDays: 40 }), null, 'a finished task is not stale');
  });

  test('every source type still has an absolute deep link', () => {
    for (const t of WORKLIST_SOURCE_TYPES) {
      const link = WORKLIST_DEEPLINK[t as WorklistSourceType];
      assert.equal(typeof link, 'string');
      assert.ok(link.startsWith('/'), `${t} deep link must be absolute`);
    }
  });
});

// ── 3. the rows ─────────────────────────────────────────────────────────────

describe('a work row on the screen', () => {
  test('a to-do offers Done and Can’t do this', () => {
    const tree = rows.WorkRowView({ item: item({ id: 'a' }), now: NOW }) as React.ReactElement;
    const text = textOf(tree).join(' | ');
    assert.match(text, /Done/);
    assert.match(text, /Can.t do this/);
  });

  test('a to-do that slipped offers the three honest endings instead', () => {
    // Before this the row offered "Done", which stamped the moment of the TAP,
    // so work done yesterday went into the record as today's. There was no way
    // at all to say a thing had stopped needing doing except to delete it.
    const tree = rows.WorkRowView({
      item: item({ id: 'late', overdue: true, missedSince: '2026-07-29', supersededIds: [] }),
      now: NOW,
    }) as React.ReactElement;
    const text = textOf(tree).join(' | ');
    assert.match(text, /Done/);
    assert.match(text, /Did it yesterday/, 'the day it is crediting is named on the button');
    assert.match(text, /Not needed/);
    assert.match(text, /Missed yesterday/, 'and the row says how far back it goes');
  });

  test('the day button names the day it will actually credit, not a generic yesterday', () => {
    const tree = rows.WorkRowView({
      item: item({ id: 'mon', overdue: true, missedSince: '2026-07-27', supersededIds: [] }),
      now: NOW,
    }) as React.ReactElement;
    const text = textOf(tree).join(' | ');
    assert.match(text, /Did it Monday/);
    assert.ok(!/Did it yesterday/.test(text), 'a button that says yesterday and files Monday is a lie');
  });

  test('a collapsed repeat run does not offer a day it would not actually credit', () => {
    // The row's identity is today's instance while the missed day belongs to an
    // older one, so "Did it Monday" would credit today. The refusal takes the
    // slot back, which keeps the reason reachable and keeps it to three.
    const tree = rows.WorkRowView({
      item: item({ id: 'run', overdue: true, missedSince: '2026-07-27', supersededIds: ['x', 'y'] }),
      now: NOW,
    }) as React.ReactElement;
    const text = textOf(tree).join(' | ');
    assert.ok(!/Did it/.test(text), 'a day it cannot credit must not be offered');
    assert.match(text, /Done/);
    assert.match(text, /Not needed/);
    assert.match(text, /Can.t do this/, 'and the reason is still reachable');
  });

  test('a to-do that has not slipped is unchanged', () => {
    const tree = rows.WorkRowView({ item: item({ id: 'ontime' }), now: NOW }) as React.ReactElement;
    const text = textOf(tree).join(' | ');
    assert.ok(!/Not needed/.test(text), '"not needed" is an answer to a row that slipped');
    assert.ok(!/Did it/.test(text));
    assert.match(text, /Can.t do this/);
  });

  test('a row that arrived since this person last looked is marked, quietly', () => {
    const marked = rows.WorkRowView({ item: item({ id: 'n' }), now: NOW, isNew: true }) as React.ReactElement;
    const dots = findAll(marked, (el) => el.props.className === 'fx-new');
    assert.equal(dots.length, 1, 'nothing marked it as new');
    // A dot and a spoken label, no word on the screen: it answers a question
    // people ask with their eyes.
    assert.match(textOf(marked).join(' | '), /New since you last looked/);

    const plain = rows.WorkRowView({ item: item({ id: 'o' }), now: NOW }) as React.ReactElement;
    assert.equal(findAll(plain, (el) => el.props.className === 'fx-new').length, 0);
  });

  test('a time of day reaches the row, and only while the day is still ahead', () => {
    const soon = rows.WorkRowView({
      item: item({ id: 'timed', dueDate: '2026-07-30T23:59:59.000Z', dueTime: '15:00' }),
      now: NOW,
    }) as React.ReactElement;
    assert.match(textOf(soon).join(' | '), /by 3pm/);
  });

  test('something that cannot be completed here offers a way to its own screen instead', () => {
    const tree = rows.WorkRowView({
      item: item({ id: 'b', sourceType: 'inspection', canComplete: false, deepLink: '/housekeeping?tab=quality' }),
      now: NOW,
    }) as React.ReactElement;
    const text = textOf(tree).join(' | ');
    assert.match(text, /Open/);
    assert.ok(!/Can.t do this/.test(text), 'only a to-do can be refused');
  });

  test('a decision waiting on a manager cannot be settled from the row', () => {
    const tree = rows.WorkRowView({
      item: item({ id: 'c', sourceType: 'approval', canComplete: false, fromLabel: 'Ana', title: 'Ana wants to join the team' }),
      now: NOW,
    }) as React.ReactElement;
    const text = textOf(tree).join(' | ');
    assert.match(text, /Ana is waiting on you/);
    assert.ok(!/\bDone\b/.test(text));
  });

  test('the refusal box refuses to send until there is a reason', () => {
    const empty = rows.WorkRowView({ item: item({ id: 'd' }), now: NOW, askingReason: true, reasonDraft: '  ' }) as React.ReactElement;
    const sendDisabled = findAll(empty, (el) => el.type === 'button' && String(el.props.children) === 'Send');
    assert.equal(sendDisabled.length, 1);
    assert.equal(sendDisabled[0].props.disabled, true, 'a reasonless refusal must not be sendable');

    const filled = rows.WorkRowView({ item: item({ id: 'd' }), now: NOW, askingReason: true, reasonDraft: 'The part has not arrived' }) as React.ReactElement;
    const sendEnabled = findAll(filled, (el) => el.type === 'button' && String(el.props.children) === 'Send');
    assert.equal(sendEnabled[0].props.disabled, false);
  });

  test('who it is from and when it is due are both on the row', () => {
    const tree = rows.WorkRowView({
      item: item({ id: 'e', fromLabel: 'Marcus', dueDate: '2026-07-27T10:00:00.000Z', overdue: true }),
      now: NOW,
    }) as React.ReactElement;
    const text = textOf(tree).join(' | ');
    assert.match(text, /Marcus asked you to/);
    assert.match(text, /3 days late/);
  });
});

describe('the assigned-by-me drawer', () => {
  test('a failed read is never drawn as "nothing outstanding"', () => {
    const tree = rows.AssignedByMeView({ entries: [], now: NOW, readFailed: true }) as React.ReactElement;
    const text = textOf(tree).join(' | ');
    assert.match(text, /could not read/i);
    assert.ok(!/have not handed anything/i.test(text), 'an error is not an empty drawer');
  });

  test('an empty drawer says so plainly', () => {
    const tree = rows.AssignedByMeView({ entries: [], now: NOW }) as React.ReactElement;
    assert.match(textOf(tree).join(' | '), /have not handed anything/i);
  });

  test('a refusal shows the reason in the assignee’s own words', () => {
    const tree = rows.AssignedByMeView({
      entries: [assigned({ state: 'cant', reason: 'The part has not arrived', settledByName: 'Marcus', settledAt: '2026-07-30T09:00:00.000Z' })],
      now: NOW,
    }) as React.ReactElement;
    const text = textOf(tree).join(' | ');
    assert.match(text, /Marcus could not do it today/);
    assert.match(text, /The part has not arrived/);
  });

  test('a waiting task carries its staleness line', () => {
    const tree = rows.AssignedByMeView({ entries: [assigned({ ageDays: 6 })], now: NOW }) as React.ReactElement;
    assert.match(textOf(tree).join(' | '), /Assigned 6 days ago, still open/);
  });
});

/**
 * Invoke the hook-free components a tree nests, so the walk reaches their rows.
 *
 * `findAll` only descends through `props.children`, so a panel that renders
 * `<AssignedByMeView />` looks empty to it. Every view in list-rows.tsx is
 * hook-free and fully controlled precisely so it can be called like this.
 */
function expand(node: unknown, depth = 6): unknown {
  if (depth <= 0 || !node || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map((n) => expand(n, depth));
  const el = node as { type?: unknown; props?: Record<string, unknown> };
  if (!el.props) return node;
  if (typeof el.type === 'function') {
    const drawn = (el.type as (p: unknown) => unknown)(el.props);
    return expand(drawn, depth - 1);
  }
  return { ...el, props: { ...el.props, children: expand(el.props.children, depth - 1) } };
}

// ── three on the face, the rest behind one button ───────────────────────────
//
// The rail panel used to say "nothing has come back since you last looked" over
// eleven live assignments: true about the last hour, useless about the work.
// It now carries the three most recent, and everything else is one click away
// in a popup, newest first.

describe('assigned by me: three, then the door', () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) =>
    assigned({ taskId: `t${i}`, title: `Task ${i}` }));

  function panel(entries: readonly AssignedByMeItem[], over: Record<string, unknown> = {}) {
    let opened = false;
    const tree = expand(rows.AssignedRailPanel({
      notices: [], entries, now: NOW, onOpen: () => { opened = true; }, ...over,
    } as Parameters<typeof rows.AssignedRailPanel>[0]));
    return { tree, open: () => opened, text: () => textOf(tree).join(' | ') };
  }

  test('the face shows the three most recent and no more', () => {
    const face = panel(many(11));
    const titles = findAll(face.tree, (el) => el.props.className === 'fx-drt')
      .map((el) => textOf(el.props.children).join(''));
    assert.deepEqual(titles, ['Task 0', 'Task 1', 'Task 2'],
      'the panel is not showing the three newest, in the read\'s own order');
  });

  test('the read\'s order is kept, never re-sorted', () => {
    // gatherAssignedByMe returns newest first. Two sort orders for one list is
    // how the panel and the popup drift.
    const entries = many(5);
    const face = panel(entries);
    const first = findAll(face.tree, (el) => el.props.className === 'fx-drt')[0];
    assert.equal(textOf(first.props.children).join(''), entries[0].title);
  });

  test('"Show more" appears only when there is more, and says how much', () => {
    assert.match(panel(many(11)).text(), /Show more/);
    assert.match(panel(many(11)).text(), /8 more/);
    assert.match(panel(many(4)).text(), /1 more/);
    assert.ok(!/Show more/.test(panel(many(3)).text()), 'a door to nothing');
    assert.ok(!/Show more/.test(panel([]).text()), 'a door to nothing');
  });

  test('news you can never open is news you carry forever', () => {
    // Opening the popup is what marks the notices seen. Somebody with two
    // assignments and one that just came back has nothing over three, so the
    // door has to be there anyway, under its own name.
    const view = panel(many(2), { notices: [assigned({ taskId: 'n1', state: 'done' })] });
    assert.match(view.text(), /See what you assigned/);
    assert.ok(!/Show more/.test(view.text()), 'it promised more than it has');
    const door = findAll(view.tree, (el) => el.type === 'button'
      && textOf(el.props.children).join('').includes('See what you assigned'));
    assert.equal(door.length, 1);
    (door[0].props.onClick as () => void)();
    assert.equal(view.open(), true);
  });

  test('"Show more" opens the popup rather than growing the panel', () => {
    const face = panel(many(11));
    const more = findAll(face.tree, (el) => el.type === 'button'
      && textOf(el.props.children).join('').includes('Show more'));
    assert.equal(more.length, 1);
    (more[0].props.onClick as () => void)();
    assert.equal(face.open(), true);
  });

  test('the popup lists EVERYTHING, in the same order', () => {
    const entries = many(11);
    const tree = expand(rows.AssignedPopupView({
      open: true, entries, now: NOW, onClose: () => {},
    }));
    const titles = findAll(tree, (el) => el.props.className === 'fx-drt')
      .map((el) => textOf(el.props.children).join(''));
    assert.equal(titles.length, 11, 'the popup is truncating the list it exists to show');
    assert.deepEqual(titles, entries.map((e) => e.title));
  });

  test('the popup is nothing at all until it is opened', () => {
    assert.equal(rows.AssignedPopupView({ open: false, entries: many(4), now: NOW, onClose: () => {} }), null);
  });

  test('a failed read is still never drawn as "nothing outstanding" on the face', () => {
    assert.match(panel([], { readFailed: true }).text(), /could not read/i);
  });
});

// ── the log book switch lives in ONE place now ──────────────────────────────

describe('the log book panel', () => {
  test('the rail panel has no switch on it', () => {
    // "Show notes on the timeline" was on the rail AND in the popup: one
    // preference, two controls, on one screen. The clean view is a glance at
    // what got written down, not a settings row.
    const tree = rows.LogbookRailPanel({
      entries: [{ id: 'l1', title: 'Boiler tripped again', createdAt: '2026-07-30T13:00:00.000Z' } as never],
      onOpen: () => {},
    }) as React.ReactElement;
    assert.equal(findAll(tree, (el) => el.props.role === 'switch').length, 0, 'the switch came back');
    const text = textOf(tree).join(' | ');
    assert.ok(!/Show notes on the timeline/.test(text));
    // ...and it still does the two things it is for.
    assert.match(text, /Boiler tripped again/);
    assert.match(text, /Open the log book/);
  });
});

// ── the calendar is the same list, with dates ───────────────────────────────

describe('the calendar view', () => {
  test('a row with no date is simply not on the calendar', () => {
    assert.equal(dayOf({ dueDate: null }), null);
    // Deliberately NOT falling back to createdAt: "created Tuesday" on Tuesday's
    // square reads as "due Tuesday", and an invented deadline is worse than a gap.
    const cells = monthCells(2026, 7, [item({ id: 'undated' })], []);
    assert.equal(cells.reduce((n, c) => n + c.items.length, 0), 0);
  });

  test('a dated row lands on its own square', () => {
    const cells = monthCells(2026, 7, [item({ id: 'x', dueDate: '2026-08-14T12:00:00.000Z' })], []);
    const aug14 = cells.find((c) => c.iso === '2026-08-14');
    assert.equal(aug14?.items.length, 1);
    assert.equal(cells.filter((c) => c.items.length > 0).length, 1);
  });

  test('the grid is always whole weeks, whatever day the month starts on', () => {
    for (const monthIndex of [0, 1, 4, 7, 10]) {
      const cells = monthCells(2026, monthIndex, [], []);
      assert.equal(cells.length % 7, 0, `month ${monthIndex} is not whole weeks`);
    }
  });

  test('a multi-day event shows on every day it covers', () => {
    const cells = monthCells(2026, 7, [], [{
      id: 'e1', title: 'Brand audit', eventDate: '2026-08-10', endDate: '2026-08-12',
    } as Parameters<typeof monthCells>[3][number]]);
    const covered = cells.filter((c) => c.events.length > 0).map((c) => c.iso);
    assert.deepEqual(covered, ['2026-08-10', '2026-08-11', '2026-08-12']);
  });
});

// ── picking days ON the month ───────────────────────────────────────────────
//
// The old flow closed the month to open a form with two native date inputs in
// it, so the one screen showing August disappeared the moment somebody wanted
// to put something in August. The month is now the date control, and these are
// the two ways to use it: click a day, or drag across days.

describe('the month overlay: the grid IS the date control', () => {
  const TODAY = '2026-08-06';

  function overlay(draft: EventDraft | null, over: Record<string, unknown> = {}) {
    const acts: string[] = [];
    const tree = expand(MonthOverlay({
      open: true, year: 2026, monthIndex: 7, todayIso: TODAY, selectedIso: TODAY,
      items: [], events: [], canManageEvents: true, draft,
      onClose: () => acts.push('close'),
      onSelectDay: (iso: string) => acts.push(`anchor:${iso}`),
      onStepMonth: () => {},
      onStartAdd: () => acts.push('add'),
      onCancelAdd: () => acts.push('cancel'),
      onDraftChange: (next: EventDraft) => acts.push(`draft:${next.title}`),
      onSaveEvent: () => acts.push('save'),
      onPickDown: (iso: string) => acts.push(`down:${iso}`),
      onPickMove: (iso: string) => acts.push(`move:${iso}`),
      onPickUp: () => acts.push('up'),
      ...over,
    } as Parameters<typeof MonthOverlay>[0]));
    const day = (iso: string) => {
      const found = findAll(tree, (el) => el.props['data-day'] === iso);
      assert.equal(found.length, 1, `no square for ${iso}`);
      return found[0];
    };
    return { tree, acts, day, text: () => textOf(tree).join(' | ') };
  }

  test('it is nothing at all until it is opened', () => {
    assert.equal(MonthOverlay({ open: false } as Parameters<typeof MonthOverlay>[0]), null);
  });

  test('browsing: a day re-anchors the page and picks nothing', () => {
    const view = overlay(null);
    (view.day('2026-08-12').props.onClick as () => void)();
    assert.deepEqual(view.acts, ['anchor:2026-08-12']);
    assert.equal(view.day('2026-08-12').props.onPointerDown, undefined);
  });

  test('adding: a day picks a date and does NOT navigate the page away', () => {
    const view = overlay({ title: '', notes: '', start: null, end: null });
    const square = view.day('2026-08-12');
    assert.equal(square.props.onClick, undefined, 'a click still re-anchored the timeline while picking');
    (square.props.onPointerDown as () => void)();
    (square.props.onPointerUp as () => void)();
    assert.deepEqual(view.acts, ['down:2026-08-12', 'up']);
  });

  test('dragging across days reports every square it crosses', () => {
    const view = overlay({ title: '', notes: '', start: null, end: null });
    (view.day('2026-08-12').props.onPointerDown as () => void)();
    (view.day('2026-08-13').props.onPointerEnter as () => void)();
    (view.day('2026-08-14').props.onPointerEnter as () => void)();
    (view.day('2026-08-14').props.onPointerUp as () => void)();
    assert.deepEqual(view.acts, ['down:2026-08-12', 'move:2026-08-13', 'move:2026-08-14', 'up']);
  });

  test('the days picked are drawn on the grid, ends solid and the middle washed', () => {
    const view = overlay({ title: 'Brand audit', notes: '', start: '2026-08-12', end: '2026-08-15' });
    assert.match(String(view.day('2026-08-12').props.className), /sc-edge/);
    assert.match(String(view.day('2026-08-15').props.className), /sc-edge/);
    assert.match(String(view.day('2026-08-13').props.className), /sc-inrange/);
    assert.ok(!/sc-inrange|sc-edge/.test(String(view.day('2026-08-17').props.className)));
  });

  test('a range dragged BACKWARDS is still the same range', () => {
    const view = overlay({ title: 'x', notes: '', start: '2026-08-15', end: '2026-08-12' });
    assert.match(String(view.day('2026-08-13').props.className), /sc-inrange/);
    assert.deepEqual(draftRange({ title: 'x', notes: '', start: '2026-08-15', end: '2026-08-12' }),
      { eventDate: '2026-08-12', endDate: '2026-08-15' });
  });

  test('the panel reads the days back live, and says so before anything is picked', () => {
    assert.match(overlay({ title: '', notes: '', start: null, end: null }).text(), /Pick a day on the month/);
    assert.match(overlay({ title: '', notes: '', start: '2026-08-12', end: null }).text(), /August 12/);
    const range = overlay({ title: '', notes: '', start: '2026-08-12', end: '2026-08-15' }).text();
    assert.match(range, /August 12 to August 15/);
  });

  test('the drag hint is shown while picking, and not while browsing', () => {
    assert.match(overlay({ title: '', notes: '', start: null, end: null }).text(), /drag across days/i);
    assert.ok(!/drag across days/i.test(overlay(null).text()));
  });

  test('the month stays on screen while the panel is open', () => {
    const view = overlay({ title: 'Brand audit', notes: '', start: '2026-08-12', end: null });
    assert.equal(findAll(view.tree, (el) => el.props['data-testid'] === 'staxis-calendar').length, 1);
    assert.equal(findAll(view.tree, (el) => el.props['data-testid'] === 'event-panel').length, 1);
  });

  test('Save is refused until it says what it is AND when it is', () => {
    const saveOf = (draft: EventDraft) => {
      const found = findAll(overlay(draft).tree, (el) => el.type === 'button'
        && textOf(el.props.children).join('').trim() === 'Save');
      assert.equal(found.length, 1);
      return found[0];
    };
    assert.equal(saveOf({ title: '', notes: '', start: '2026-08-12', end: null }).props.disabled, true);
    assert.equal(saveOf({ title: 'Brand audit', notes: '', start: null, end: null }).props.disabled, true);
    assert.equal(saveOf({ title: '   ', notes: '', start: '2026-08-12', end: null }).props.disabled, true);
    assert.equal(saveOf({ title: 'Brand audit', notes: '', start: '2026-08-12', end: null }).props.disabled, false);
  });

  test('a single day sends no end date, so nothing invents a range', () => {
    assert.deepEqual(draftRange({ title: 'x', notes: '', start: '2026-08-12', end: '2026-08-12' }),
      { eventDate: '2026-08-12', endDate: null });
    assert.deepEqual(draftRange({ title: 'x', notes: '', start: '2026-08-12', end: null }),
      { eventDate: '2026-08-12', endDate: null });
    assert.equal(draftRange(emptyEventDraft()), null);
    assert.equal(draftReady(emptyEventDraft()), false);
  });

  test('"Add event" is offered while browsing and gone once the panel is open', () => {
    const has = (view: ReturnType<typeof overlay>) => findAll(view.tree, (el) => el.type === 'button'
      && textOf(el.props.children).join('').trim() === 'Add event').length;
    assert.equal(has(overlay(null)), 1);
    assert.equal(has(overlay({ title: '', notes: '', start: null, end: null })), 0);
    assert.equal(has(overlay(null, { canManageEvents: false })), 0, 'a reader who cannot add was offered it');
  });
});

// ── the week strip ──────────────────────────────────────────────────────────
//
// The `List` / `Calendar` toggle is gone (2026-08-01): seven days are now
// permanent chrome in the day header, so the shape of the week is something a
// manager always has rather than something they swap the page to see.
//
// These are the cases the dots are FOR. Getting them wrong is silent: a strip
// with the right numbers and the wrong dots reads as a calm week.

describe('the week strip', () => {
  const TODAY = '2026-07-30'; // a Thursday

  test('the seven cells run Sunday to Saturday around the anchored day', () => {
    const cells = weekCells(TODAY, TODAY, [], []);
    assert.equal(cells.length, 7);
    assert.deepEqual(cells.map((c) => c.label), ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']);
    assert.equal(cells[0].iso, '2026-07-26');
    assert.equal(cells[6].iso, '2026-08-01');
  });

  // Mutation: anchor the week on TODAY rather than on the day being shown. The
  // strip would then stop moving when somebody steps to another week, and the
  // prev/next arrows would do nothing visible.
  test('the strip follows the anchored day, not today', () => {
    const cells = weekCells('2026-08-08', TODAY, [], []);
    assert.equal(cells[0].iso, '2026-08-02');
    assert.equal(cells.some((c) => c.today), false, 'today is not in that week');
  });

  test('exactly one cell is marked today, and only when today is in the week', () => {
    const thisWeek = weekCells(TODAY, TODAY, [], []);
    assert.equal(thisWeek.filter((c) => c.today).length, 1);
    assert.equal(thisWeek.find((c) => c.today)?.iso, TODAY);
  });

  // Mutation: colour every dot the same. Late is the one state the strip exists
  // to make visible from across the header.
  test('a late to-do puts a rust dot on its day, a normal one does not', () => {
    const late = weekCells(TODAY, TODAY, [
      item({ id: 'late', dueDate: '2026-07-31T12:00:00.000Z', overdue: true }),
    ], []);
    assert.deepEqual(late.find((c) => c.iso === '2026-07-31')?.dots, ['late']);

    const plain = weekCells(TODAY, TODAY, [
      item({ id: 'plain', dueDate: '2026-07-31T12:00:00.000Z' }),
    ], []);
    assert.deepEqual(plain.find((c) => c.iso === '2026-07-31')?.dots, ['todo']);
  });

  // Mutation: keep live colours on days that are over. What matters about
  // Monday on Thursday is that it is finished, not that it was busy.
  test('a day that is already gone shows grey dots whatever was on it', () => {
    const cells = weekCells(TODAY, TODAY, [
      item({ id: 'gone', dueDate: '2026-07-27T12:00:00.000Z', overdue: true }),
    ], []);
    assert.deepEqual(cells.find((c) => c.iso === '2026-07-27')?.dots, ['past']);
  });

  test('an event puts a teal dot on every day it covers, and marks it notable', () => {
    const cells = weekCells(TODAY, TODAY, [], [{
      id: 'e1', title: 'Brand audit', eventDate: '2026-07-31', endDate: '2026-08-01',
    } as Parameters<typeof weekCells>[3][number]]);
    assert.deepEqual(cells.find((c) => c.iso === '2026-07-31')?.dots, ['event']);
    assert.deepEqual(cells.find((c) => c.iso === '2026-08-01')?.dots, ['event']);
    assert.equal(cells.find((c) => c.iso === '2026-07-31')?.notable, true);
    assert.equal(cells.find((c) => c.iso === '2026-07-29')?.notable, false);
  });

  // Mutation: drop the cap. A day with eleven to-dos would blow the fixed
  // 5px dot row out and make the whole strip jump.
  test('a busy day never draws more than three dots', () => {
    const many = Array.from({ length: 9 }, (_, i) => item({ id: `t${i}`, dueDate: '2026-07-31T12:00:00.000Z' }));
    assert.equal(weekCells(TODAY, TODAY, many, []).find((c) => c.iso === '2026-07-31')?.dots.length, 3);
  });

  test('the range label names both months only when the week spans two', () => {
    assert.equal(weekRangeLabel(weekCells(TODAY, TODAY, [], [])), 'Jul 26 – Aug 1');
    assert.equal(weekRangeLabel(weekCells('2026-08-12', TODAY, [], [])), 'Aug 9 – 15');
  });

  test('the day title and stamp name the anchored day', () => {
    assert.equal(dayTitle('2026-07-30'), 'Thursday');
    assert.equal(dayStamp('2026-07-30'), 'July 30');
    // A date-only string must not slide a day backwards through UTC.
    assert.equal(dayTitle('2026-08-01'), 'Saturday');
  });
});
