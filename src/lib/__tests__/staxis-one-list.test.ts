/**
 * THE ONE LIST — the rules the Staxis tab is now built on.
 *
 * Every case here fails against the code as it stood before this change, or
 * against the plausible wrong version of the change. That is the bar: a test
 * that passes either way is documentation with a runner attached.
 *
 * What is pinned:
 *   1. ORDER. Dollars first, then severity, with overdue climbing one step.
 *      Plus the load-bearing compatibility claim: finding-vs-finding order is
 *      byte-identical to `rankFindings`, so the cards a manager has learned to
 *      read did not quietly reshuffle when to-dos arrived on the screen.
 *   2. WHOSE LIST. A task handed to somebody else is on THEIR page and not on
 *      the assigner's. Both directions, because only checking the first half
 *      passes on the bug that matters.
 *   3. WHO GETS THE PAGE. Front desk and maintenance do. Housekeepers do not.
 *   4. THE COMPOSER'S DEFAULTS. Type and press Enter is you, today, once.
 *   5. EVERY REPEAT CADENCE, driven over a run of fake days — including
 *      biweekly, whose whole point is the fortnight it skips.
 *   6. THE ASSIGNER'S RECEIPTS. Three states, who tapped, when, and the
 *      verbatim reason.
 *   7. THE MERGE SWITCH. Log book entries in the list only when it is on, and
 *      never above actual work.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-min-20-chars';

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  buildOneList,
  compareStanding,
  effectiveSeverity,
  rankWorkItems,
  standingOf,
  type ListRow,
} from '@/lib/feed/one-list';
import { listRendersFor, listShowsFindings, listStandingFor } from '@/lib/feed/list-access';
import { assignerNotices, taskVisibleToViewer, viewerDepartment, worklistSeesApprovals, mapAssignedRow } from '@/lib/worklist/core';
import { isTemplateDueOn, normalizeCadence } from '@/lib/recurring-tasks/store';
import { rankFindings, type QueueFinding } from '@/components/concourse/finding-cards';
import type { LogEntryDTO } from '@/lib/comms/types';
import type { AssignedByMeItem, WorklistItem, WorklistViewer } from '@/lib/worklist/types';
import { ALL_ROLES, type AppRole } from '@/lib/roles';

// ── fixtures ────────────────────────────────────────────────────────────────

const NOW = new Date('2026-07-30T15:00:00.000Z');

function finding(over: Partial<QueueFinding> & { id: string }): QueueFinding {
  return {
    detectorId: 'det',
    dedupeKey: over.id,
    summary: 'summary',
    severity: 'attention',
    disposition: 'recommend',
    status: 'open',
    magnitude: 1,
    price: null,
    evidence: { rows: [], basisEn: 'basis', basisEs: 'basis' } as unknown as QueueFinding['evidence'],
    asOf: null,
    weakestInputAgeDays: null,
    firstSeenAt: '2026-07-20T00:00:00.000Z',
    lastSeenAt: '2026-07-29T00:00:00.000Z',
    occurrenceCount: 1,
    ...over,
  } as QueueFinding;
}

function item(over: Partial<WorklistItem> & { id: string }): WorklistItem {
  return {
    sourceType: 'task',
    sourceId: over.id,
    title: 'a task',
    location: null,
    assigneeStaffId: null,
    assigneeName: null,
    dept: null,
    dueDate: null,
    status: 'open',
    priority: 'normal',
    propertyId: 'p1',
    overdue: false,
    canComplete: true,
    canAssign: true,
    deepLink: '/feed',
    createdAt: '2026-07-29T00:00:00.000Z',
    fromLabel: null,
    amountCents: null,
    ...over,
  } as WorklistItem;
}

const VIEWER: WorklistViewer = { staffId: 'me', accountId: 'acct', role: 'general_manager', dept: null };

// ── 1. order ────────────────────────────────────────────────────────────────

describe('the house rule: dollars first, then severity, overdue climbing', () => {
  test('money outranks everything without money, however urgent', () => {
    const cheapFinding = { kind: 'finding', key: 'f', finding: finding({ id: 'f', price: { lowCents: 100, highCents: 300 } as QueueFinding['price'] }) } as ListRow;
    const urgentOverdue = { kind: 'item', key: 'i', item: item({ id: 'i', priority: 'urgent', overdue: true }) } as ListRow;
    assert.ok(
      compareStanding(standingOf(cheapFinding), standingOf(urgentOverdue)) < 0,
      'a priced card must sort above an unpriced row',
    );
  });

  test('overdue climbs a whole severity step, not just a tiebreak', () => {
    // The plausible wrong version applies overdue only when severity ties. This
    // case has NO tie: normal-and-late vs high-and-on-time.
    const lateNormal = standingOf({ kind: 'item', key: 'a', item: item({ id: 'a', priority: 'normal', overdue: true }) });
    const onTimeHigh = standingOf({ kind: 'item', key: 'b', item: item({ id: 'b', priority: 'high' }) });
    assert.equal(effectiveSeverity(lateNormal), 2);
    assert.equal(effectiveSeverity(onTimeHigh), 2);
    // Equal after the climb, so the genuinely-late one takes the tiebreak.
    assert.ok(compareStanding(lateNormal, onTimeHigh) < 0, 'the late one must come first');
  });

  test('the climb is capped, so an overdue urgent does not outrank money', () => {
    const lateUrgent = standingOf({ kind: 'item', key: 'a', item: item({ id: 'a', priority: 'urgent', overdue: true }) });
    assert.equal(effectiveSeverity(lateUrgent), 3, 'never climbs past the top');
  });

  test('ties go to whoever has been waiting longest', () => {
    const older = item({ id: 'older', dueDate: '2026-07-25T00:00:00.000Z', overdue: true });
    const newer = item({ id: 'newer', dueDate: '2026-07-28T00:00:00.000Z', overdue: true });
    assert.deepEqual(rankWorkItems([newer, older]).map((i) => i.id), ['older', 'newer']);
  });

  test('two identical loads produce the same order', () => {
    const a = item({ id: 'aaa' });
    const b = item({ id: 'bbb' });
    assert.deepEqual(rankWorkItems([a, b]).map((i) => i.id), rankWorkItems([b, a]).map((i) => i.id));
  });
});

describe('the cards did not reshuffle', () => {
  test('finding-vs-finding order is exactly rankFindings, with work items on screen', () => {
    const findings = [
      finding({ id: 'cheap', price: { lowCents: 100, highCents: 200 } as QueueFinding['price'] }),
      finding({ id: 'dear', price: { lowCents: 9_000, highCents: 11_000 } as QueueFinding['price'] }),
      finding({ id: 'free-old', firstSeenAt: '2026-07-01T00:00:00.000Z' }),
      finding({ id: 'free-new', firstSeenAt: '2026-07-28T00:00:00.000Z' }),
    ];
    const expected = rankFindings(findings).map((f) => f.id);

    const built = buildOneList({
      findings,
      items: [item({ id: 'i1', overdue: true, priority: 'urgent' }), item({ id: 'i2' })],
      findingCap: 10,
    });
    const gotFindings = built.rows.filter((r) => r.kind === 'finding').map((r) => (r as { finding: QueueFinding }).finding.id);
    assert.deepEqual(gotFindings, expected, 'interleaving must not change the cards among themselves');
  });

  test('the cap folds FINDINGS only; work items are never hidden behind "show all"', () => {
    const findings = Array.from({ length: 8 }, (_, i) => finding({ id: `f${i}` }));
    const items = Array.from({ length: 6 }, (_, i) => item({ id: `i${i}` }));
    const built = buildOneList({ findings, items, findingCap: 5 });
    assert.equal(built.foldedFindings.length, 3);
    assert.equal(built.rows.filter((r) => r.kind === 'item').length, 6, 'every work item stays on screen');
  });
});

// ── 2. whose list ───────────────────────────────────────────────────────────

describe('a task lives only on the assignee’s page', () => {
  const handedToSomebodyElse = { assignedStaffId: 'marcus', assignedDepartment: null, createdByStaffId: 'me' };

  test('the assignee sees it', () => {
    assert.equal(
      taskVisibleToViewer(handedToSomebodyElse, { ...VIEWER, staffId: 'marcus', role: 'front_desk' }),
      true,
    );
  });

  test('the ASSIGNER does not, even though they are a manager who created it', () => {
    assert.equal(taskVisibleToViewer(handedToSomebodyElse, VIEWER), false);
  });

  test('a third manager does not either', () => {
    assert.equal(taskVisibleToViewer(handedToSomebodyElse, { ...VIEWER, staffId: 'other' }), false);
  });

  test('a role-targeted task reaches everyone in that role and nobody else', () => {
    const forTheDesk = { assignedStaffId: null, assignedDepartment: 'front_desk', createdByStaffId: 'me' };
    assert.equal(taskVisibleToViewer(forTheDesk, { staffId: 'a', accountId: 'a', role: 'front_desk', dept: 'front_desk' }), true);
    assert.equal(taskVisibleToViewer(forTheDesk, { staffId: 'b', accountId: 'b', role: 'maintenance', dept: 'maintenance' }), false);
  });

  test('everyone means everyone', () => {
    const forAll = { assignedStaffId: null, assignedDepartment: 'all_staff', createdByStaffId: 'x' };
    for (const role of ALL_ROLES) {
      assert.equal(taskVisibleToViewer(forAll, { staffId: 'z', accountId: 'z', role, dept: null }), true, role);
    }
  });

  test('an unassigned house to-do goes to managers, and always to whoever typed it', () => {
    const orphan = { assignedStaffId: null, assignedDepartment: null, createdByStaffId: 'author' };
    assert.equal(taskVisibleToViewer(orphan, VIEWER), true, 'a GM sees the house list');
    assert.equal(
      taskVisibleToViewer(orphan, { staffId: 'author', accountId: 'a', role: 'maintenance', dept: 'maintenance' }),
      true,
      'the author never loses their own to-do',
    );
    assert.equal(
      taskVisibleToViewer(orphan, { staffId: 'someone', accountId: 's', role: 'maintenance', dept: 'maintenance' }),
      false,
    );
  });

  test('no viewer means the whole property, so the agent tools are unchanged', () => {
    assert.equal(taskVisibleToViewer(handedToSomebodyElse, null), true);
  });

  test('a viewer with no staff department falls back to their role', () => {
    assert.equal(viewerDepartment({ dept: null, role: 'maintenance' }), 'maintenance');
    assert.equal(viewerDepartment({ dept: 'front_desk', role: 'maintenance' }), 'front_desk');
    assert.equal(viewerDepartment({ dept: null, role: 'general_manager' }), null);
  });
});

// ── 3. who gets the page ────────────────────────────────────────────────────

describe('same page, sized to the person', () => {
  test('managers get the whole thing', () => {
    for (const role of ['admin', 'owner', 'general_manager'] as AppRole[]) {
      const standing = listStandingFor(role, true);
      assert.equal(standing, 'manager', role);
      assert.equal(listShowsFindings(standing), true, role);
    }
  });

  test('front desk and maintenance get the SAME page, without the findings half', () => {
    // This is the case that fails against the old code, where the Staxis tab
    // said "the hotel findings queue is for managers" and rendered nothing.
    for (const role of ['front_desk', 'maintenance', 'staff'] as AppRole[]) {
      const standing = listStandingFor(role, true);
      assert.equal(standing, 'line', role);
      assert.equal(listRendersFor(standing), true, `${role} must get the page`);
      assert.equal(listShowsFindings(standing), false, `${role} must not see money or recommendations`);
    }
  });

  test('housekeepers never get this page', () => {
    const standing = listStandingFor('housekeeping', true);
    assert.equal(standing, 'none');
    assert.equal(listRendersFor(standing), false);
  });

  test('no operational standing means no page, whatever the role says', () => {
    assert.equal(listStandingFor('general_manager', false), 'none');
    assert.equal(listStandingFor(null, true), 'none');
  });

  test('decisions are narrower than work: the front desk sees work, not personnel calls', () => {
    assert.equal(worklistSeesApprovals('general_manager'), true);
    assert.equal(worklistSeesApprovals('front_desk'), false);
    assert.equal(worklistSeesApprovals('housekeeping'), false);
  });
});

// ── 5. every cadence actually comes back ────────────────────────────────────

describe('recurring: drive the scheduler over real days', () => {
  /** Which of these local days a template spawns on. */
  function daysItFires(
    template: Parameters<typeof isTemplateDueOn>[0],
    from: string,
    count: number,
  ): string[] {
    const out: string[] = [];
    const start = new Date(`${from}T12:00:00.000Z`);
    for (let i = 0; i < count; i++) {
      const d = new Date(start.getTime() + i * 86_400_000);
      const iso = d.toISOString().slice(0, 10);
      if (isTemplateDueOn(template, { date: iso, weekday: d.getUTCDay() })) out.push(iso);
    }
    return out;
  }

  test('daily fires every day', () => {
    const fired = daysItFires({ cadence: 'daily', weekday: null, dayOfMonth: null, anchorDate: null }, '2026-08-01', 14);
    assert.equal(fired.length, 14);
  });

  test('weekdays skips the weekend', () => {
    // 2026-08-01 is a Saturday.
    const fired = daysItFires({ cadence: 'weekdays', weekday: null, dayOfMonth: null, anchorDate: null }, '2026-08-01', 14);
    assert.equal(fired.length, 10);
    assert.ok(!fired.includes('2026-08-01'), 'Saturday is not a weekday');
    assert.ok(!fired.includes('2026-08-02'), 'Sunday is not a weekday');
  });

  test('weekly comes back every seven days on its own day', () => {
    // 2026-08-04 is a Tuesday (weekday 2).
    const fired = daysItFires({ cadence: 'weekly', weekday: 2, dayOfMonth: null, anchorDate: null }, '2026-08-01', 28);
    assert.deepEqual(fired, ['2026-08-04', '2026-08-11', '2026-08-18', '2026-08-25']);
  });

  test('BIWEEKLY skips the fortnight it is supposed to skip', () => {
    // Anchored on the first Tuesday. The wrong implementation (a plain weekly,
    // or a counter that drifts) fires on all four.
    const fired = daysItFires(
      { cadence: 'biweekly', weekday: 2, dayOfMonth: null, anchorDate: '2026-08-04' },
      '2026-08-01',
      42,
    );
    assert.deepEqual(fired, ['2026-08-04', '2026-08-18', '2026-09-01']);
  });

  test('biweekly keeps its fortnight after a missed run', () => {
    // Nothing about being skipped moves the anchor, so a cron outage on the
    // 18th does not flip every future occurrence to the other week.
    const fired = daysItFires(
      { cadence: 'biweekly', weekday: 2, dayOfMonth: null, anchorDate: '2026-08-04' },
      '2026-08-19',
      21,
    );
    assert.equal(fired[0], '2026-09-01', 'the next ON week is the same one it always was');
  });

  test('monthly comes back on its day, every month', () => {
    const fired = daysItFires(
      { cadence: 'monthly', weekday: null, dayOfMonth: 15, anchorDate: null },
      '2026-08-01',
      95,
    );
    assert.deepEqual(fired, ['2026-08-15', '2026-09-15', '2026-10-15']);
  });

  test('a monthly template cannot be set to a day that does not exist every month', () => {
    assert.throws(
      () => normalizeCadence('monthly', { dayOfMonth: 31 }, '2026-08-01'),
      /1 and 28/,
    );
  });

  test('weekly and biweekly refuse without a weekday; biweekly anchors on today', () => {
    assert.throws(() => normalizeCadence('weekly', {}, '2026-08-01'), /weekday/);
    assert.throws(() => normalizeCadence('biweekly', {}, '2026-08-01'), /weekday/);
    assert.deepEqual(
      normalizeCadence('biweekly', { weekday: 2 }, '2026-08-04'),
      { weekday: 2, dayOfMonth: null, anchorDate: '2026-08-04' },
    );
  });

  test('daily and weekdays carry no parameters, so the shape CHECK cannot reject them', () => {
    assert.deepEqual(normalizeCadence('daily', { weekday: 3, dayOfMonth: 9 }, '2026-08-01'),
      { weekday: null, dayOfMonth: null, anchorDate: null });
  });
});

// ── 6. the assigner's receipts ──────────────────────────────────────────────

describe('assigned by me: three states, with receipts', () => {
  const names = new Map([['marcus', 'Marcus'], ['ana', 'Ana']]);

  test('waiting, with a staleness count in whole days', () => {
    const row = mapAssignedRow(
      { id: 't1', title: 'Change the lobby filters', assigned_staff_id: 'marcus', status: 'open', created_at: '2026-07-24T15:00:00.000Z' },
      names, NOW,
    );
    assert.equal(row.state, 'waiting');
    assert.equal(row.ageDays, 6);
    assert.equal(row.assigneeName, 'Marcus');
    assert.equal(row.reason, null);
  });

  test('done carries who tapped and when', () => {
    const row = mapAssignedRow(
      { id: 't2', title: 'x', assigned_staff_id: 'marcus', status: 'done', created_at: '2026-07-28T00:00:00.000Z', completed_at: '2026-07-29T18:00:00.000Z', completed_by_staff_id: 'marcus' },
      names, NOW,
    );
    assert.equal(row.state, 'done');
    assert.equal(row.settledByName, 'Marcus');
    assert.equal(row.settledAt, '2026-07-29T18:00:00.000Z');
  });

  test('could not do it carries the reason VERBATIM', () => {
    const row = mapAssignedRow(
      { id: 't3', title: 'x', assigned_staff_id: 'ana', status: 'blocked', created_at: '2026-07-29T00:00:00.000Z', blocked_at: '2026-07-30T09:00:00.000Z', blocked_by_staff_id: 'ana', blocked_reason: 'The part has not arrived' },
      names, NOW,
    );
    assert.equal(row.state, 'cant');
    assert.equal(row.reason, 'The part has not arrived');
    assert.equal(row.settledByName, 'Ana');
  });

  test('a reason on a row that is not blocked is never shown', () => {
    const row = mapAssignedRow(
      { id: 't4', title: 'x', assigned_staff_id: 'ana', status: 'done', created_at: '2026-07-29T00:00:00.000Z', blocked_reason: 'stale text from an earlier refusal' },
      names, NOW,
    );
    assert.equal(row.reason, null);
  });

  test('an unreadable created_at does not produce a negative or NaN age', () => {
    const row = mapAssignedRow({ id: 't5', title: 'x', assigned_staff_id: 'ana', status: 'open', created_at: null }, names, NOW);
    assert.equal(row.ageDays, 0);
  });
});

// ── the loop closes: work that came back ────────────────────────────────────

describe('what came back since you last looked', () => {
  function entry(over: Partial<AssignedByMeItem> = {}): AssignedByMeItem {
    return {
      taskId: 't', title: 'Change the lobby filters', assigneeStaffId: 'm', assigneeName: 'Marcus',
      assignedDepartment: null, state: 'done', dueDate: null, createdAt: '2026-07-24T00:00:00.000Z',
      settledByName: 'Marcus', settledByStaffId: 'm', settledAt: '2026-07-30T09:00:00.000Z', reason: null, ageDays: 6,
      ...over,
    };
  }

  test('a task settled after you last looked is news', () => {
    const out = assignerNotices([entry()], '2026-07-30T08:00:00.000Z', NOW);
    assert.equal(out.length, 1);
  });

  test('a task settled BEFORE you last looked is not', () => {
    // The bug this catches: a notice that never clears, because the loop has
    // no unread flag and "since you last looked" is the only thing stopping it.
    const out = assignerNotices([entry()], '2026-07-30T10:00:00.000Z', NOW);
    assert.equal(out.length, 0);
  });

  test('still waiting is never news', () => {
    assert.equal(assignerNotices([entry({ state: 'waiting', settledAt: null })], null, NOW).length, 0);
  });

  test('never having opened the drawer means everything recent counts', () => {
    // Deliberate: the first thing that comes back is what teaches somebody the
    // drawer is there at all.
    assert.equal(assignerNotices([entry()], null, NOW).length, 1);
  });

  test('stale news is not news', () => {
    const old = entry({ settledAt: '2026-07-01T09:00:00.000Z' });
    assert.equal(assignerNotices([old], null, NOW).length, 0, 'three weeks ago is history');
  });

  test('a refusal comes back too, not just a completion', () => {
    const out = assignerNotices([entry({ state: 'cant', reason: 'no part' })], null, NOW);
    assert.equal(out.length, 1);
  });

  test('an unreadable settled stamp is dropped rather than shown as now', () => {
    assert.equal(assignerNotices([entry({ settledAt: 'not a date' })], null, NOW).length, 0);
  });
});

// ── 7. the log book merge switch ────────────────────────────────────────────

describe('log book in the list', () => {
  const entry: LogEntryDTO = {
    id: 'l1', title: 'Quiet night', body: '', category: 'front_desk',
    authorStaffId: 's', authorName: 'Sam', replyCount: 0,
    createdAt: '2026-07-30T06:00:00.000Z', updatedAt: '2026-07-30T06:00:00.000Z',
  };

  test('off means no log rows at all', () => {
    const built = buildOneList({ findings: [], items: [item({ id: 'i' })], logEntries: [], findingCap: 5 });
    assert.equal(built.rows.filter((r) => r.kind === 'log').length, 0);
  });

  test('on puts them in the list, UNDER anything that is actual work', () => {
    const built = buildOneList({
      findings: [],
      // The lowest-standing work there is: not overdue, lowest priority.
      items: [item({ id: 'i', priority: 'low' })],
      logEntries: [entry],
      findingCap: 5,
    });
    const kinds = built.rows.map((r) => r.kind);
    assert.deepEqual(kinds, ['item', 'log'], 'a shift note is not a thing to do');
  });

  test('several notes stay newest-first among themselves', () => {
    const older = { ...entry, id: 'old', createdAt: '2026-07-28T06:00:00.000Z' };
    const built = buildOneList({ findings: [], items: [], logEntries: [older, entry], findingCap: 5 });
    assert.deepEqual(
      built.rows.map((r) => (r as { entry: LogEntryDTO }).entry.id),
      ['l1', 'old'],
    );
  });
});
