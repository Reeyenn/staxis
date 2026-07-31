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
  assignedStateLine,
  completionNotice,
  dueLine,
  emptyListNote,
  repeatLabel,
  rowFrom,
  rowKindLabel,
  stalenessLine,
  WEEKDAYS,
} from '@/lib/feed/one-list-copy';
import { dayOf, monthCells } from '@/components/concourse/list-calendar';
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
    settledByName: null, settledByStaffId: null, settledAt: null, reason: null, ageDays: 6,
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
    assert.deepEqual(
      rows.REPEAT_CHOICES.map((r) => r.value),
      ['once', 'daily', 'weekly', 'biweekly', 'monthly'],
    );
  });

  test('housekeeping is not a role the composer can target', () => {
    // The exclusion is enforced server-side too (listAssignees). Both, because
    // a task nobody can see is worse than a task nobody can create.
    assert.ok(!rows.COMPOSER_ROLES.some((r) => r.value.includes('housekeeping')));
    assert.match(rows.HOUSEKEEPER_NOTE, /housekeeping board/i);
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

    for (const repeat of ['once', 'daily', 'weekdays', 'weekly', 'biweekly', 'monthly']) {
      for (const weekday of [null, 0, 3, 6]) {
        for (const dayOfMonth of [null, 1, 2, 3, 11, 22]) {
          out.push(repeatLabel(repeat, { weekday, dayOfMonth }));
        }
      }
    }

    out.push(emptyListNote({ canSeeFindings: true }));
    out.push(emptyListNote({ canSeeFindings: false }));
    out.push(rows.HOUSEKEEPER_NOTE);
    for (const r of rows.REPEAT_CHOICES) out.push(r.label);
    for (const r of rows.COMPOSER_ROLES) out.push(r.label);
    for (const d of WEEKDAYS) out.push(d);

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
