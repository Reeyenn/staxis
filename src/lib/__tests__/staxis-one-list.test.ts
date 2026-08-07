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
  countNewSince,
  effectiveSeverity,
  filterMine,
  isNewSince,
  partitionTimeline,
  rankWorkItems,
  rowIsMine,
  standingOf,
  type ListRow,
} from '@/lib/feed/one-list';
import {
  assignedStateLine,
  completionNotice,
  dueLine,
  missedLine,
  overdueAnswers,
  timeWord,
  whenWord,
} from '@/lib/feed/one-list-copy';
import { listRendersFor, listShowsFindings, listStandingFor } from '@/lib/feed/list-access';
import { assignerNotices, collapseRepeatInstances, taskVisibleToViewer, viewerDepartment, worklistSeesApprovals, mapAssignedRow, mayActOnItem, keepForAssigner } from '@/lib/worklist/core';
import { isTemplateDueOn, normalizeCadence } from '@/lib/recurring-tasks/store';
import { rankFindings, type QueueFinding } from '@/components/concourse/finding-cards';
import type { LogEntryDTO } from '@/lib/comms/types';
import type { KnowledgeEventDTO } from '@/lib/knowledge/types';
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

  test('a role-targeted task reaches everyone in that role, and nobody on the floor outside it', () => {
    const forTheDesk = { assignedStaffId: null, assignedDepartment: 'front_desk', createdByStaffId: 'me' };
    assert.equal(taskVisibleToViewer(forTheDesk, { staffId: 'a', accountId: 'a', role: 'front_desk', dept: 'front_desk' }), true);
    assert.equal(taskVisibleToViewer(forTheDesk, { staffId: 'b', accountId: 'b', role: 'maintenance', dept: 'maintenance' }), false);
  });

  // ── the hole a department route used to fall through ──────────────────────
  //
  // The composer offers "Maintenance" and "Whoever's on front desk"; the chat
  // door's log_complaint add-on files its follow-up to `maintenance` and says
  // so out loud. Both saved a row and returned success, and the row was then
  // on no screen the person who asked for it could reach: not their list (the
  // department branch returned before the author clause), and not their
  // Assigned-by-me panel (keepForAssigner drops a waiting department row).
  // At a hotel with nobody in that department it reached zero screens.
  test('a department to-do stays on the list of whoever asked for it', () => {
    const forMaintenance = { assignedStaffId: null, assignedDepartment: 'maintenance', createdByStaffId: 'author' };
    assert.equal(
      taskVisibleToViewer(forMaintenance, { staffId: 'author', accountId: 'a', role: 'front_desk', dept: 'front_desk' }),
      true,
      'the person who wrote it must not lose it to a department they are not in',
    );
  });

  test('a department to-do is also the hotel’s work, so a manager sees it', () => {
    // The page charter is "owner / VP / GM: findings + approvals + the whole
    // hotel's work + theirs". A to-do routed to Maintenance is the hotel's
    // work, and a GM whose staff row carries no department matched nothing.
    for (const dept of ['maintenance', 'front_desk', 'housekeeping']) {
      const row = { assignedStaffId: null, assignedDepartment: dept, createdByStaffId: 'somebody_else' };
      assert.equal(taskVisibleToViewer(row, VIEWER), true, `a GM must see the ${dept} row`);
    }
  });

  test('a department to-do does NOT reach floor staff outside that department', () => {
    // The widening above must not become "everybody sees everything": a
    // maintenance tech has no business holding the front desk's work.
    const forTheDesk = { assignedStaffId: null, assignedDepartment: 'front_desk', createdByStaffId: 'gm' };
    for (const role of ['maintenance', 'housekeeping', 'staff'] as AppRole[]) {
      assert.equal(
        taskVisibleToViewer(forTheDesk, { staffId: 'nobody', accountId: 'n', role, dept: role }),
        false,
        `${role} must not be handed the desk's work`,
      );
    }
  });

  test('handing work to a PERSON still takes it off the assigner’s list', () => {
    // The widening is about departments only. If it had leaked into the
    // person branch, every delegated to-do would come straight back onto the
    // manager's list and the assignment loop would be pointless.
    const handedOver = { assignedStaffId: 'marcus', assignedDepartment: 'front_desk', createdByStaffId: 'me' };
    assert.equal(taskVisibleToViewer(handedOver, VIEWER), false, 'the assigner still does not keep a copy');
    assert.equal(
      taskVisibleToViewer(handedOver, { staffId: 'marcus', accountId: 'm', role: 'front_desk', dept: 'front_desk' }),
      true,
    );
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
    template: Partial<Parameters<typeof isTemplateDueOn>[0]> & { cadence: Parameters<typeof isTemplateDueOn>[0]['cadence'] },
    from: string,
    count: number,
  ): string[] {
    const full = {
      weekday: null, dayOfMonth: null, anchorDate: null, intervalDays: null, ...template,
    } as Parameters<typeof isTemplateDueOn>[0];
    const out: string[] = [];
    const start = new Date(`${from}T12:00:00.000Z`);
    for (let i = 0; i < count; i++) {
      const d = new Date(start.getTime() + i * 86_400_000);
      const iso = d.toISOString().slice(0, 10);
      if (isTemplateDueOn(full, { date: iso, weekday: d.getUTCDay() })) out.push(iso);
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
      { weekday: 2, dayOfMonth: null, anchorDate: '2026-08-04', intervalDays: null },
    );
  });

  test('daily and weekdays carry no parameters, so the shape CHECK cannot reject them', () => {
    assert.deepEqual(normalizeCadence('daily', { weekday: 3, dayOfMonth: 9 }, '2026-08-01'),
      { weekday: null, dayOfMonth: null, anchorDate: null, intervalDays: null });
  });

  // ── every N days ──────────────────────────────────────────────────────────
  // The open-ended cadence. Anchored, not counted, which is the whole of what
  // can go wrong with it: a gap kept as "days since the last spawn" drifts one
  // day forward every time the cron misses a tick.

  test('every 3 days comes back every third day from the day it started', () => {
    const fired = daysItFires(
      { cadence: 'every_n_days', intervalDays: 3, anchorDate: '2026-08-04' },
      '2026-08-01',
      14,
    );
    assert.deepEqual(fired, ['2026-08-04', '2026-08-07', '2026-08-10', '2026-08-13']);
  });

  test('it claims nothing before the day it started', () => {
    const fired = daysItFires(
      { cadence: 'every_n_days', intervalDays: 5, anchorDate: '2026-08-10' },
      '2026-08-01',
      12,
    );
    assert.deepEqual(fired, ['2026-08-10']);
  });

  test('a missed run does not shift the rhythm', () => {
    // The cron is down on the 7th. The 10th is still an ON day, because the
    // gap is measured from the anchor and not from the last spawn.
    const fired = daysItFires(
      { cadence: 'every_n_days', intervalDays: 3, anchorDate: '2026-08-04' },
      '2026-08-08',
      9,
    );
    assert.equal(fired[0], '2026-08-10', 'the rhythm walked forward after a missed day');
  });

  test('a gap of 90 days is a real cadence and fires four times a year', () => {
    const fired = daysItFires(
      { cadence: 'every_n_days', intervalDays: 90, anchorDate: '2026-01-01' },
      '2026-01-01',
      366,
    );
    assert.deepEqual(fired, ['2026-01-01', '2026-04-01', '2026-06-30', '2026-09-28', '2026-12-27']);
  });

  test('a template with no gap in it spawns nothing rather than spawning daily', () => {
    // The database forbids this shape, but a row that got past it must not
    // manufacture a fresh to-do every single day for the rest of time.
    for (const broken of [
      { cadence: 'every_n_days' as const, intervalDays: null, anchorDate: '2026-08-04' },
      { cadence: 'every_n_days' as const, intervalDays: 3, anchorDate: null },
      { cadence: 'every_n_days' as const, intervalDays: 1, anchorDate: '2026-08-04' },
      { cadence: 'every_n_days' as const, intervalDays: 0, anchorDate: '2026-08-04' },
    ]) {
      assert.deepEqual(daysItFires(broken, '2026-08-01', 30), []);
    }
  });

  test('the gap has to be a number the cadence can carry', () => {
    for (const bad of [undefined, null, 0, 1, 366, 2.5, -3]) {
      assert.throws(
        () => normalizeCadence('every_n_days', { intervalDays: bad as number }, '2026-08-01'),
        /between 2 and 365/,
        `${String(bad)} was accepted as a gap`,
      );
    }
    assert.deepEqual(
      normalizeCadence('every_n_days', { intervalDays: 3 }, '2026-08-04'),
      { weekday: null, dayOfMonth: null, anchorDate: '2026-08-04', intervalDays: 3 },
    );
    // It starts today unless somebody said otherwise, exactly like biweekly.
    assert.deepEqual(
      normalizeCadence('every_n_days', { intervalDays: 7, anchorDate: '2026-09-01' }, '2026-08-04').anchorDate,
      '2026-09-01',
    );
    // And it never carries a weekday or a day of the month, which the shape
    // CHECK on the table would reject outright.
    const params = normalizeCadence('every_n_days', { intervalDays: 4, weekday: 3, dayOfMonth: 9 }, '2026-08-01');
    assert.equal(params.weekday, null);
    assert.equal(params.dayOfMonth, null);
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
      settledByName: 'Marcus', settledByStaffId: 'm', settledAt: '2026-07-30T09:00:00.000Z', reason: null,
      completedForDate: null, ageDays: 6,
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


// ═══════════════════════════════════════════════════════════════════════════
// The WRITE seam.
//
// The list narrowed to "what is on my screen" while the complete handler still
// accepted any id in the property. Filtering a read has never stopped a request
// that names an id directly, so the two rules have to agree.
// ═══════════════════════════════════════════════════════════════════════════

describe('who may close a to-do', () => {
  const clerk: WorklistViewer = { staffId: 'clerk', accountId: 'a1', role: 'front_desk', dept: 'front_desk' };
  const housekeeper: WorklistViewer = { staffId: 'hk', accountId: 'a2', role: 'housekeeping', dept: 'housekeeping' };
  const gm: WorklistViewer = { staffId: 'gm', accountId: 'a3', role: 'general_manager', dept: null };

  const handedTo = (staffId: string, createdBy: string | null = 'gm') => ({
    assignedStaffId: staffId, assignedDepartment: null, createdByStaffId: createdBy,
  });

  test('the person holding it may close it', () => {
    assert.equal(mayActOnItem(handedTo('clerk'), clerk), true);
  });

  test('somebody else on the floor may NOT close it', () => {
    // The bug: this returned true for any id in the property, so a housekeeper
    // with an id could close work handed to the front desk.
    assert.equal(mayActOnItem(handedTo('clerk'), housekeeper), false);
  });

  test('the person who asked for it may call it off', () => {
    const askedByTheClerk = handedTo('hk', 'clerk');
    assert.equal(mayActOnItem(askedByTheClerk, clerk), true);
  });

  test('a manager may close out anything, including what they delegated', () => {
    // Load-bearing: a delegated to-do deliberately LEAVES the manager's list,
    // so gating the write on visibility alone would take away their ability to
    // close out their own hand-off.
    assert.equal(taskVisibleToViewer(handedTo('clerk'), gm), false, 'not on their list');
    assert.equal(mayActOnItem(handedTo('clerk'), gm), true, 'still theirs to close');
  });

  test('a department reminder is not one stranger\'s to cancel for everyone', () => {
    const forHousekeeping = {
      assignedStaffId: null, assignedDepartment: 'housekeeping', createdByStaffId: 'gm',
    };
    assert.equal(mayActOnItem(forHousekeeping, housekeeper), true, 'in the department');
    assert.equal(mayActOnItem(forHousekeeping, clerk), false, 'not in the department');
  });

  test('an all-staff item stays everybody\'s', () => {
    const everyone = { assignedStaffId: null, assignedDepartment: 'all_staff', createdByStaffId: 'gm' };
    assert.equal(mayActOnItem(everyone, housekeeper), true);
    assert.equal(mayActOnItem(everyone, clerk), true);
  });

  test('no viewer means a server-side caller, which is unrestricted', () => {
    assert.equal(mayActOnItem(handedTo('clerk'), null), true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The receipt reaches the person who asked.
//
// "Can't do this" flips one shared row to blocked, so a department to-do that
// one housekeeper refuses leaves EVERY housekeeper's list at once. Because it
// named no person, it reached no drawer either, and the refusal reason (the
// whole justification for the blocked state) was written where nobody would
// read it.
// ═══════════════════════════════════════════════════════════════════════════

describe('what comes back to the person who asked', () => {
  const item = (over: Partial<AssignedByMeItem> = {}): AssignedByMeItem => ({
    taskId: 't', title: 'Check the pool chemicals', assigneeStaffId: null, assigneeName: null,
    assignedDepartment: null, state: 'waiting', dueDate: null,
    createdAt: '2026-07-28T00:00:00.000Z', settledByName: null, settledByStaffId: null,
    settledAt: null, reason: null, completedForDate: null, ageDays: 2, ...over,
  });

  test('a to-do handed to a person is tracked from the moment it is handed over', () => {
    assert.equal(keepForAssigner(item({ assigneeStaffId: 'ana', state: 'waiting' }), 'gm'), true);
  });

  test('a department to-do somebody REFUSED comes back with its reason', () => {
    const refused = item({
      assignedDepartment: 'housekeeping', state: 'cant',
      settledByStaffId: 'hk', settledByName: 'Ana', reason: 'The pump is locked out',
    });
    assert.equal(keepForAssigner(refused, 'gm'), true);
  });

  test('a department to-do still WAITING does not, because nobody is being waited on', () => {
    const waiting = item({ assignedDepartment: 'housekeeping', state: 'waiting' });
    assert.equal(keepForAssigner(waiting, 'gm'), false);
  });

  test('an unassigned to-do somebody else finished comes back', () => {
    const done = item({ state: 'done', settledByStaffId: 'hk', settledByName: 'Ana' });
    assert.equal(keepForAssigner(done, 'gm'), true);
  });

  test('closing your own to-do is not news to yourself', () => {
    const selfClosed = item({ state: 'done', settledByStaffId: 'gm', settledByName: 'Marcus' });
    assert.equal(keepForAssigner(selfClosed, 'gm'), false);
  });
});

// ── 8. the day timeline ─────────────────────────────────────────────────────
//
// The 2026-08-01 redesign put the clock back on the screen: the top of the
// spine is what is STILL OWED, and everything that has already happened
// unwinds under an "Earlier today" rule, ending with the morning brief.
//
// The split is a second pass on purpose. `buildOneList`'s ranking is untouched
// by it, and the cases below are what would go wrong if somebody folded a
// clock term into the comparator instead.

function logEntry(id: string, createdAt: string): LogEntryDTO {
  return {
    id, title: 'a note', body: '', category: 'front_desk',
    authorStaffId: 's', authorName: 'Sam', replyCount: 0,
    createdAt, updatedAt: createdAt,
  };
}

function hotelEvent(over: Partial<KnowledgeEventDTO> & { id: string }): KnowledgeEventDTO {
  return {
    title: 'Ecolab vendor visit',
    eventDate: '2026-07-30',
    endDate: null,
    notes: null,
    createdByName: null,
    createdAt: '2026-07-20T00:00:00.000Z',
    ...over,
  };
}

describe('the day splits into what is still owed and what already happened', () => {
  // Mutation: partition on a timestamp comparison instead of the row kind. A
  // finding stamped five minutes ago would then climb into the owed cluster and
  // sit above a to-do that is two days late.
  test('work and events are owed; findings and notes have already happened', () => {
    const built = buildOneList({
      findings: [finding({ id: 'f1' })],
      items: [item({ id: 't1', overdue: true, dueDate: '2026-07-27T00:00:00.000Z' })],
      events: [hotelEvent({ id: 'e1' })],
      logEntries: [logEntry('l1', '2026-07-30T07:00:00.000Z')],
      findingCap: 5,
    });

    const split = partitionTimeline(built.rows);
    assert.deepEqual(split.owed.map((r) => r.kind), ['item', 'event']);
    assert.deepEqual(split.past.map((r) => r.kind), ['finding', 'log']);
    assert.equal(split.showDivider, true);
  });

  // Mutation: draw the divider unconditionally. A morning with nothing owed
  // would then grow an "Earlier today" heading with empty space above it.
  test('the divider is only drawn when there is something on both sides', () => {
    const findingsOnly = partitionTimeline(
      buildOneList({ findings: [finding({ id: 'f1' })], items: [], findingCap: 5 }).rows,
    );
    assert.equal(findingsOnly.showDivider, false);
    assert.equal(findingsOnly.owed.length, 0);

    const workOnly = partitionTimeline(
      buildOneList({ findings: [], items: [item({ id: 't1' })], findingCap: 5 }).rows,
    );
    assert.equal(workOnly.showDivider, false);
    assert.equal(workOnly.past.length, 0);
  });

  // Mutation: re-sort inside the partition. Each side must keep the exact
  // relative order the house rule already gave it, or the expensive card stops
  // being the top card for reasons no commit explains.
  test('each side keeps the order the ranking already gave it', () => {
    const cheap = finding({ id: 'cheap', price: { currency: 'USD', lowCents: 10_000, highCents: 20_000 } as QueueFinding['price'] });
    const dear = finding({ id: 'dear', price: { currency: 'USD', lowCents: 90_000, highCents: 99_000 } as QueueFinding['price'] });
    const built = buildOneList({ findings: [cheap, dear], items: [], findingCap: 5 });
    const rankedIds = built.rows.map((r) => (r.kind === 'finding' ? r.finding.id : r.key));

    const split = partitionTimeline(built.rows);
    assert.deepEqual(split.past.map((r) => (r.kind === 'finding' ? r.finding.id : r.key)), rankedIds);
    assert.equal(rankedIds[0], 'dear', 'the ranking itself moved, which this test cannot mask');
  });

  // Mutation: give an event a severity or a price so it outranks real work. A
  // vendor visit is on the clock, not on the ladder.
  test('a hotel event never outranks a late to-do', () => {
    const built = buildOneList({
      findings: [],
      items: [item({ id: 't1', overdue: true, dueDate: '2026-07-27T00:00:00.000Z' })],
      events: [hotelEvent({ id: 'e1', eventDate: '2026-07-20' })],
      findingCap: 0,
    });
    assert.deepEqual(built.rows.map((r) => r.kind), ['item', 'event']);
  });

  // Mutation: always build event rows. Every caller that is not the day
  // timeline passes no events, and their rows must be what they always were.
  test('a caller that passes no events gets no event rows', () => {
    const built = buildOneList({ findings: [], items: [item({ id: 't1' })], findingCap: 0 });
    assert.deepEqual(built.rows.map((r) => r.kind), ['item']);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// FOLLOW-THROUGH — the rules the list gained on 2026-08-05
//
//   8.  A repeating to-do that was missed is ONE row, however many days it has
//       been missed for.
//   9.  "Just mine" means assigned to me OR asked for by me. Filtering on the
//       assignee alone was the obvious version and it hides a manager's own
//       house to-dos, which is the exact work they typed in themselves.
//   10. A time of day sorts inside its own day and cannot reorder anything
//       across days, across severities or across money.
//   11. New-since-you-looked is measured against one cursor, with a floor, so
//       a first-ever visit is not a wall of markers.
//   12. The overdue row's three answers name the day they are crediting.
// ═══════════════════════════════════════════════════════════════════════════

describe('a repeating to-do that was missed is one row', () => {
  const inst = (id: string, templateId: string | null, day: string | null) => ({ id, templateId, day });

  test('five open instances collapse to the newest, which speaks for the rest', () => {
    const runs = collapseRepeatInstances([
      inst('a', 'tpl', '2026-07-26'),
      inst('b', 'tpl', '2026-07-27'),
      inst('c', 'tpl', '2026-07-28'),
      inst('d', 'tpl', '2026-07-29'),
      inst('e', 'tpl', '2026-07-30'),
    ]);
    assert.equal(runs.size, 1, 'one survivor, not five');
    const run = runs.get('e');
    assert.ok(run, 'the newest instance is the one that survives');
    assert.deepEqual(run.supersededIds, ['a', 'b', 'c', 'd']);
    assert.equal(run.missedSince, '2026-07-26', 'reaching back to the oldest still open');
  });

  test('one instance on its own is not "missed" anything', () => {
    const runs = collapseRepeatInstances([inst('a', 'tpl', '2026-07-30')]);
    assert.equal(runs.get('a')?.missedSince, null);
    assert.deepEqual(runs.get('a')?.supersededIds, []);
  });

  test('two templates are two runs, never merged into one', () => {
    const runs = collapseRepeatInstances([
      inst('a', 'coffee', '2026-07-29'), inst('b', 'coffee', '2026-07-30'),
      inst('c', 'halls', '2026-07-30'),
    ]);
    assert.equal(runs.size, 2);
    assert.deepEqual(runs.get('b')?.supersededIds, ['a']);
    assert.deepEqual(runs.get('c')?.supersededIds, []);
  });

  test('a to-do that does not repeat is never collapsed with anything', () => {
    const runs = collapseRepeatInstances([
      inst('a', null, null), inst('b', null, null), inst('c', null, '2026-07-30'),
    ]);
    assert.equal(runs.size, 0, 'nothing here is an instance of anything');
  });

  test('an instance with no day cannot win the run and take today\'s row off the screen', () => {
    const runs = collapseRepeatInstances([
      inst('dated', 'tpl', '2026-07-30'),
      inst('undated', 'tpl', null),
    ]);
    assert.ok(runs.get('dated'), 'the row that knows which day it is for survives');
    assert.deepEqual(runs.get('dated')?.supersededIds, ['undated']);
  });
});

describe('just mine', () => {
  const row = (over: Partial<WorklistItem> & { id: string }): ListRow =>
    ({ kind: 'item', key: over.id, item: item(over) });

  test('work assigned to me is mine', () => {
    assert.equal(rowIsMine(row({ id: '1', assigneeStaffId: 'me' }), 'me'), true);
  });

  test('work I asked for is mine too, even when it names nobody', () => {
    // The half that filtering on the assignee alone gets wrong. A manager's own
    // house to-dos carry no assignee at all, so "just mine" would have hidden
    // the work they typed into the composer two minutes earlier.
    assert.equal(
      rowIsMine(row({ id: '2', assigneeStaffId: null, createdByStaffId: 'me' }), 'me'),
      true,
    );
  });

  test('work I handed to somebody else is not mine, even though I wrote it', () => {
    // The founder's assignment rule, applied to the narrowing. Delegated work
    // lives on THEIR page; what I handed out is answered by the Assigned-by-me
    // drawer. A "just mine" that quietly pulled it back would undo the loop.
    assert.equal(rowIsMine(row({ id: '3', assigneeStaffId: 'dana', createdByStaffId: 'me' }), 'me'), false);
  });

  test('a to-do I wrote for the shift is the shift\'s, not mine', () => {
    assert.equal(rowIsMine(row({ id: '3b', dept: 'front_desk', createdByStaffId: 'me' }), 'me'), false);
  });

  test('the shift\'s work is not any one person\'s', () => {
    assert.equal(rowIsMine(row({ id: '4', dept: 'front_desk' }), 'me'), false);
  });

  test('nothing the AI noticed is anybody\'s personally', () => {
    const finding0: ListRow = { kind: 'finding', key: 'f', finding: finding({ id: 'f' }) };
    assert.equal(rowIsMine(finding0, 'me'), false);
  });

  test('narrowing removes rows and never reorders the ones that stay', () => {
    const rows: ListRow[] = [
      row({ id: 'a', assigneeStaffId: 'me' }),
      row({ id: 'b', assigneeStaffId: 'dana' }),
      row({ id: 'c', createdByStaffId: 'me' }),
      row({ id: 'd', dept: 'front_desk' }),
    ];
    assert.deepEqual(filterMine(rows, 'me').map((r) => r.key), ['a', 'c']);
  });

  test('with no idea who I am, nothing is claimed as mine', () => {
    assert.deepEqual(filterMine([row({ id: 'a', assigneeStaffId: 'me' })], null), []);
  });
});

describe('a time of day orders inside its own day and nowhere else', () => {
  const due = '2026-07-30T23:59:59.000Z';

  test('a timed to-do comes before an untimed one due the same day', () => {
    const timed = standingOf({ kind: 'item', key: 't', item: item({ id: 't', dueDate: due, dueTime: '15:00' }) });
    const untimed = standingOf({ kind: 'item', key: 'u', item: item({ id: 'u', dueDate: due }) });
    assert.ok(compareStanding(timed, untimed) < 0, 'the one with a clock on it goes first');
    assert.ok(compareStanding(untimed, timed) > 0, 'and the comparison is symmetric');
  });

  test('the earlier clock goes before the later one', () => {
    const nine = standingOf({ kind: 'item', key: 'a', item: item({ id: 'a', dueDate: due, dueTime: '09:00' }) });
    const three = standingOf({ kind: 'item', key: 'b', item: item({ id: 'b', dueDate: due, dueTime: '15:00' }) });
    assert.ok(compareStanding(nine, three) < 0);
  });

  test('a clock cannot lift a row over money, severity or an earlier day', () => {
    const timedCheap = standingOf({ kind: 'item', key: 'a', item: item({ id: 'a', dueDate: due, dueTime: '06:00' }) });
    const pricey = standingOf({ kind: 'item', key: 'b', item: item({ id: 'b', dueDate: due, amountCents: 40_000 }) });
    assert.ok(compareStanding(pricey, timedCheap) < 0, 'dollars still come first');

    const urgent = standingOf({ kind: 'item', key: 'c', item: item({ id: 'c', dueDate: due, priority: 'urgent' }) });
    assert.ok(compareStanding(urgent, timedCheap) < 0, 'severity still outranks the clock');

    const yesterday = standingOf({
      kind: 'item', key: 'd', item: item({ id: 'd', dueDate: '2026-07-29T23:59:59.000Z' }),
    });
    assert.ok(compareStanding(yesterday, timedCheap) < 0, 'and an earlier day still comes first');
  });

  test('two untimed rows are still a tie, so nothing reshuffles between loads', () => {
    const a = standingOf({ kind: 'item', key: 'a', item: item({ id: 'a', dueDate: due }) });
    const b = standingOf({ kind: 'item', key: 'b', item: item({ id: 'b', dueDate: due }) });
    assert.equal(compareStanding(a, b), 0);
  });
});

describe('what is new since this person last looked', () => {
  const at = (iso: string) => item({ id: iso, createdAt: iso });

  test('a row that arrived after the cursor is new', () => {
    assert.equal(isNewSince(at('2026-07-30T10:00:00.000Z'), '2026-07-30T09:00:00.000Z', NOW), true);
  });

  test('a row that was already there when they looked is not', () => {
    assert.equal(isNewSince(at('2026-07-30T08:00:00.000Z'), '2026-07-30T09:00:00.000Z', NOW), false);
  });

  test('a first-ever visit is not a wall of markers', () => {
    // The floor. Without it, "everything newer than never" is the hotel's whole
    // history, and somebody's first look would light up every row they own,
    // which teaches them immediately that the marker means nothing.
    assert.equal(isNewSince(at('2026-07-29T10:00:00.000Z'), null, NOW), true, 'this week counts');
    assert.equal(isNewSince(at('2026-05-01T10:00:00.000Z'), null, NOW), false, 'the spring does not');
  });

  test('the floor applies to a real cursor too, so a long absence is not a flood', () => {
    assert.equal(isNewSince(at('2026-01-01T10:00:00.000Z'), '2025-12-31T10:00:00.000Z', NOW), false);
  });

  test('a row with no arrival time is never claimed as new', () => {
    assert.equal(isNewSince(item({ id: 'x', createdAt: null }), null, NOW), false);
    assert.equal(isNewSince(item({ id: 'y', createdAt: 'not a date' }), null, NOW), false);
  });

  test('the count is the number of rows the markers would go on', () => {
    const rows = [
      at('2026-07-30T10:00:00.000Z'),
      at('2026-07-30T11:00:00.000Z'),
      at('2026-07-30T08:00:00.000Z'),
    ];
    assert.equal(countNewSince(rows, '2026-07-30T09:00:00.000Z', NOW), 2);
  });

  test('looking is what clears it: a cursor at now leaves nothing new', () => {
    const rows = [at('2026-07-30T10:00:00.000Z'), at('2026-07-30T11:00:00.000Z')];
    assert.equal(countNewSince(rows, NOW.toISOString(), NOW), 0);
  });
});

describe('the three answers on a row that slipped', () => {
  test('the middle one names the day it is crediting, never a generic yesterday', () => {
    // A button that says "yesterday" and files Monday is the same dishonesty
    // the whole control exists to remove.
    assert.equal(overdueAnswers('2026-07-29', NOW).onDay, 'Did it yesterday');
    assert.equal(overdueAnswers('2026-07-27', NOW).onDay, 'Did it Monday');
    assert.equal(overdueAnswers('2026-07-01', NOW).onDay, 'Did it on Jul 1');
  });

  test('the other two never change, because they mean the same thing every time', () => {
    const answers = overdueAnswers('2026-07-29', NOW);
    assert.equal(answers.done, 'Done');
    assert.equal(answers.notNeeded, 'Not needed');
  });

  test('a row that has not slipped says nothing about a missed day', () => {
    assert.equal(missedLine(null, NOW), null);
    assert.equal(missedLine('2026-07-30', NOW), null, 'today is not a day that was missed');
    assert.equal(missedLine('2026-08-05', NOW), null, 'nor is a day still to come');
  });

  test('a run says how far back it goes, not how many copies were folded away', () => {
    assert.equal(missedLine('2026-07-29', NOW), 'Missed yesterday');
    assert.equal(missedLine('2026-07-27', NOW), 'Missed since Monday');
    assert.equal(missedLine('2026-07-01', NOW), 'Missed since Jul 1');
  });
});

describe('the clock, in words a person would say out loud', () => {
  test('a stored 24-hour time comes back as the time somebody speaks', () => {
    assert.equal(timeWord('15:00'), 'by 3pm');
    assert.equal(timeWord('09:30'), 'by 9:30am');
    assert.equal(timeWord('12:00'), 'by noon');
    assert.equal(timeWord('00:00'), 'by midnight');
    assert.equal(timeWord('23:59'), 'by 11:59pm');
  });

  test('postgres hands back seconds, and they change nothing', () => {
    assert.equal(timeWord('15:00:00'), 'by 3pm');
  });

  test('no time is no words at all', () => {
    for (const bad of [null, undefined, '', 'half past three', '99:99']) {
      assert.equal(timeWord(bad as string | null), null, `${bad} produced words`);
    }
  });

  test('the due line carries the clock while the day is still ahead', () => {
    assert.equal(dueLine('2026-07-30T23:59:59.000Z', NOW, '15:00'), 'Due today by 3pm');
    assert.equal(dueLine('2026-07-31T23:59:59.000Z', NOW, '15:00'), 'Due tomorrow by 3pm');
  });

  test('and drops it once the row is late, because how late is the only part that matters', () => {
    assert.equal(dueLine('2026-07-29T23:59:59.000Z', NOW, '15:00'), 'Late since yesterday');
    assert.equal(dueLine('2026-07-27T23:59:59.000Z', NOW, '15:00'), '3 days late');
  });

  test('the composer says the day and the clock as one word', () => {
    assert.equal(whenWord('2026-07-30', NOW, { atTime: '15:00' }), 'today by 3pm');
    assert.equal(whenWord('2026-07-30', NOW, {}), 'today', 'and says nothing extra without one');
    assert.equal(whenWord('2026-07-30', NOW, { repeating: true, atTime: '09:00' }), 'from today by 9am');
  });
});

describe('the receipts an assigner reads', () => {
  const settled = (over: Partial<AssignedByMeItem>): AssignedByMeItem => ({
    taskId: 't', title: 'Change the lobby filters', assigneeStaffId: 'm', assigneeName: 'Marcus',
    assignedDepartment: null, state: 'done', dueDate: '2026-07-29T23:59:59.000Z',
    createdAt: '2026-07-28T00:00:00.000Z', settledByName: 'Marcus', settledByStaffId: 'm',
    settledAt: '2026-07-30T09:00:00.000Z', reason: null, completedForDate: null, ageDays: 2, ...over,
  });

  test('done late says so, rather than reading like it landed on time', () => {
    assert.match(assignedStateLine(settled({}), NOW), /after it was due/);
  });

  test('done on the day it was due says that day, not the day it was reported', () => {
    // The whole point. Before this the assigner read "marked it done today" for
    // work that happened yesterday, and had no way to know the difference.
    assert.match(
      assignedStateLine(settled({ completedForDate: '2026-07-29' }), NOW),
      /did it yesterday/i,
    );
  });

  test('done on time is still just done', () => {
    const onTime = settled({ dueDate: '2026-07-30T23:59:59.000Z' });
    assert.doesNotMatch(assignedStateLine(onTime, NOW), /after it was due/);
  });

  test('not needed is its own ending and is never dressed up as done', () => {
    const skipped = settled({ state: 'skipped', settledAt: '2026-07-30T09:00:00.000Z' });
    assert.match(assignedStateLine(skipped, NOW), /not needed/i);
    assert.doesNotMatch(assignedStateLine(skipped, NOW), /done/i);
    assert.match(completionNotice(skipped), /not needed/i);
  });

  test('a refusal still reads as a refusal', () => {
    const cant = settled({ state: 'cant', reason: 'the part is on order' });
    assert.match(assignedStateLine(cant, NOW), /could not do it/);
  });

  test('none of the four endings carries an em dash', () => {
    for (const state of ['waiting', 'done', 'cant', 'skipped'] as const) {
      const entry = settled({ state, completedForDate: state === 'done' ? '2026-07-29' : null });
      assert.doesNotMatch(assignedStateLine(entry, NOW), /—/, `${state} line has an em dash`);
      assert.doesNotMatch(completionNotice(entry), /—/, `${state} notice has an em dash`);
    }
  });

  test('nor does anything the overdue row or the clock says', () => {
    const answers = overdueAnswers('2026-07-27', NOW);
    for (const s of [answers.done, answers.onDay, answers.notNeeded, missedLine('2026-07-27', NOW)!, timeWord('15:00')!]) {
      assert.doesNotMatch(s, /—/, `"${s}" has an em dash`);
    }
  });
});
