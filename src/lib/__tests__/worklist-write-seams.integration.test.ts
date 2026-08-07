/**
 * THE TO-DO LIST'S TWO HONESTY RULES, AGAINST A REAL POSTGRES.
 *
 * Both bugs here were silent. Neither threw, neither logged, and both produced
 * a screen that looked completely normal while being wrong.
 *
 * 1. WHO MAY BE HANDED A TO-DO. The founder's rule is that housekeepers never
 *    receive to-dos: they work from the housekeeping board and never open the
 *    list, so a to-do assigned to one is not late, it is invisible forever.
 *    That rule existed ONLY in `listAssignees`, which fills a dropdown. Every
 *    WRITE path accepted a housekeeper's id: the two API routes, the two chat
 *    tools, the message add-on, and the recurring spawner. A dropdown is not a
 *    guard, so this pins the rule at the seams that actually write.
 *
 * 2. WHEN A TIME-OFF REQUEST IS DUE. The row said "Ana asked for the 14th off"
 *    and the calendar put it on the 13th, because the due date was built as
 *    `${day}T00:00:00.000Z` and UTC midnight is the PREVIOUS local day in every
 *    US timezone. The row contradicted itself and nothing failed.
 *
 * WHY A REAL DATABASE. The guard has to hold on the row Postgres actually
 * returns, across a foreign-key'd staff table, an is_active flag, and a
 * property boundary. A stub would return whatever the test told it to and the
 * check could be missing entirely.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-min-20-chars';
process.env.CRON_SECRET ??= 'placeholder-cron-secret-min-16';
process.env.OPENAI_API_KEY ??= 'sk-placeholder';
process.env.ANTHROPIC_API_KEY ??= 'sk-ant-placeholder';
// Local-dev/test break-glass: skips the trusted-device half of requireSession so
// these tests exercise the ROUTE's own checks, not the 2FA plumbing.
process.env.DISABLE_SERVER_2FA_ENFORCEMENT = 'true';
// Pinned BEFORE the first Date is constructed. Chicago is the customer's
// timezone and the one the day-early bug was reproduced in.
process.env.TZ = 'America/Chicago';

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { NextRequest } from 'next/server';
import type { PGlite } from '@electric-sql/pglite';

import { supabaseAdmin } from '@/lib/supabase-admin';
import { POST as commsTasksPost } from '@/app/api/comms/tasks/route';
import { POST as worklistAssignPost } from '@/app/api/worklist/assign/route';
import { POST as worklistCompletePost } from '@/app/api/worklist/complete/route';
import {
  assignerNotices,
  countNewOnList,
  gatherAssignedByMe,
  gatherWorklist,
  listAssignees,
} from '@/lib/worklist/core';
import { assignedStateLine, completionNotice, dueLine } from '@/lib/feed/one-list-copy';
import {
  assigneeBlockedReason,
  assignmentBlockedReason,
  departmentBlockedReason,
  isAssignable,
} from '@/lib/worklist/assignable';
import { createTask } from '@/lib/comms/core';
import { createTemplate, isTemplateDueOn, spawnDueRecurringTodos } from '@/lib/recurring-tasks/store';
import { dayOf } from '@/components/concourse/list-calendar';

import { applyMigrationsToPglite } from '../../../tests/fixtures/pglite-migrate';
import {
  createPglitePostgrest,
  loadCatalog,
  type PglitePostgrest,
} from '../../../tests/fixtures/postgrest-pglite';
import { ACCOUNT_MARIA, PID_A1, PID_B1, UID_MARIA, seedTwoCompanies } from '../../../tests/fixtures/pglite-two-company-seed';

let pg: PGlite;
let shim: PglitePostgrest;

const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);
const originalRpc = supabaseAdmin.rpc.bind(supabaseAdmin);
const originalGetUser = supabaseAdmin.auth.getUser.bind(supabaseAdmin.auth);

/** Which auth user the next requireSession call resolves to. */
let currentUser: string | null = UID_MARIA;

// Staff ids created in `before`, so assertions can name them.
let housekeeper = '';
let frontDesk = '';
let retired = '';
let hotelBHousekeeper = '';

async function one<T extends Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T | null> {
  const r = await pg.query<T>(sql, params);
  return r.rows[0] ?? null;
}

async function addStaff(pid: string, name: string, department: string, active = true): Promise<string> {
  const row = await one<{ id: string }>(
    `insert into staff (property_id, name, department, is_active)
     values ($1, $2, $3, $4) returning id`,
    [pid, name, department, active],
  );
  return row!.id;
}

/** Whatever was thrown, as a readable string. The data layer re-throws
 *  PostgREST error OBJECTS, which are not Errors, so a bare assert.rejects
 *  with a regex matches against "[object Object]" and passes for the wrong
 *  reason. */
async function refusalMessage(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (e) {
    return String((e as { message?: unknown })?.message ?? e);
  }
  throw new assert.AssertionError({ message: 'expected the call to be refused, but it succeeded' });
}

function postReq(url: string, body: Record<string, unknown>): NextRequest {
  return new NextRequest(url, {
    method: 'POST',
    headers: {
      authorization: 'Bearer worklist-write-seam-test-token',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

interface Envelope { ok: boolean; error?: string; data?: Record<string, unknown> }

before(async () => {
  const migrated = await applyMigrationsToPglite();
  pg = migrated.pg;
  const catalog = await loadCatalog(pg);
  shim = createPglitePostgrest(pg, catalog);
  // @ts-expect-error installing the pglite-backed client on the singleton
  supabaseAdmin.from = shim.from;
  // @ts-expect-error installing the pglite-backed client on the singleton
  supabaseAdmin.rpc = shim.rpc;
  supabaseAdmin.auth.getUser = (async () =>
    currentUser
      ? { data: { user: { id: currentUser, email: `${currentUser}@worklist.test` } }, error: null }
      : { data: { user: null }, error: { message: 'invalid token', status: 401, name: 'AuthApiError' } }) as unknown as typeof supabaseAdmin.auth.getUser;

  await seedTwoCompanies(pg);

  housekeeper = await addStaff(PID_A1, 'Rosa Delgado', 'housekeeping');
  frontDesk = await addStaff(PID_A1, 'Dana Pike', 'front_desk');
  retired = await addStaff(PID_A1, 'Sam Older', 'front_desk', false);
  hotelBHousekeeper = await addStaff(PID_B1, 'Tyler Housekeeper', 'housekeeping');
});

after(async () => {
  supabaseAdmin.from = originalFrom;
  supabaseAdmin.rpc = originalRpc;
  supabaseAdmin.auth.getUser = originalGetUser;
  await pg?.close();
});

beforeEach(async () => {
  currentUser = UID_MARIA;
  await pg.query('delete from comms_tasks');
  await pg.query('delete from recurring_task_templates');
  await pg.query('delete from time_off_requests');
});

// ═══════════════════════════════════════════════════════════════════════════
// 1. The rule, stated once
// ═══════════════════════════════════════════════════════════════════════════

describe('who may be handed a to-do', () => {
  test('a housekeeper is refused, and told where the work does belong', () => {
    const reason = assigneeBlockedReason({ department: 'housekeeping', is_active: true });
    assert.ok(reason, 'a housekeeper must be refused');
    assert.match(reason, /housekeeping board/i, 'a refusal that does not say what to do instead is just a wall');
    assert.equal(isAssignable({ department: 'housekeeping', is_active: true }), false);
  });

  test('somebody who no longer works here is refused', () => {
    assert.ok(assigneeBlockedReason({ department: 'front_desk', is_active: false }));
  });

  test('somebody who is not on the staff list at all is refused', () => {
    assert.ok(assigneeBlockedReason(null));
  });

  test('an active front-desk person is allowed', () => {
    assert.equal(assigneeBlockedReason({ department: 'front_desk', is_active: true }), null);
    assert.equal(isAssignable({ department: 'front_desk', is_active: true }), true);
  });

  test('a missing department is allowed, because it is not housekeeping', () => {
    // Plenty of real staff rows carry no department. Refusing them would break
    // ordinary delegation to prove a point about a different department.
    assert.equal(assigneeBlockedReason({ department: null, is_active: true }), null);
    assert.equal(assigneeBlockedReason({}), null);
  });

  test('no refusal text carries an em dash', () => {
    for (const row of [
      { department: 'housekeeping', is_active: true },
      { department: 'front_desk', is_active: false },
      null,
    ]) {
      const reason = assigneeBlockedReason(row);
      assert.ok(reason && !reason.includes('—'), `refusal copy must not use an em dash: ${reason}`);
    }
  });

  test('naming the whole DEPARTMENT is refused for exactly the same reason', () => {
    // The half the person-level guard left open. A department row reaches only
    // viewers in that department, so routing one at housekeeping put it on zero
    // screens while every door reported success.
    const reason = departmentBlockedReason('housekeeping');
    assert.ok(reason, 'the housekeeping department must be refused');
    assert.match(reason, /housekeeping board/i);
    assert.match(reason, /named person|unassigned/i, 'a refusal must offer the way through');
    assert.ok(!reason.includes('—'), 'refusal copy must not use an em dash');
  });

  test('every department that does read the list is still allowed', () => {
    for (const dept of ['front_desk', 'maintenance', 'general', 'all_staff', null, undefined]) {
      assert.equal(departmentBlockedReason(dept), null, String(dept));
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. The rule against real rows
// ═══════════════════════════════════════════════════════════════════════════

describe('the guard, reading real staff rows', () => {
  test('no assignee at all is allowed: the shared list is a real place', async () => {
    assert.equal(await assignmentBlockedReason(PID_A1, null), null);
  });

  test('a housekeeper at this hotel is refused', async () => {
    assert.match(String(await assignmentBlockedReason(PID_A1, housekeeper)), /housekeeping board/i);
  });

  test('somebody from another hotel is refused, not silently accepted', async () => {
    // The lookup is scoped by property, so a foreign id reads as "not on this
    // staff list" rather than resolving to a stranger's row.
    assert.ok(await assignmentBlockedReason(PID_A1, hotelBHousekeeper));
  });

  test('an active front-desk person is allowed', async () => {
    assert.equal(await assignmentBlockedReason(PID_A1, frontDesk), null);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Every write seam
// ═══════════════════════════════════════════════════════════════════════════

describe('the write seams refuse what the dropdown never offered', () => {
  test('the to-do route answers 400 and says why, rather than writing a ghost', async () => {
    const res = await commsTasksPost(postReq('https://staxis.test/api/comms/tasks', {
      pid: PID_A1,
      title: 'Restock the linen closet',
      assignedStaffId: housekeeper,
    }));
    const body = (await res.json()) as Envelope;
    assert.equal(res.status, 400, 'this is a bad request, not a server fault');
    assert.match(String(body.error), /housekeeping board/i);

    const rows = await pg.query('select id from comms_tasks');
    assert.equal(rows.rows.length, 0, 'a refused assignment must not leave a to-do behind');
  });

  test('the to-do route refuses somebody who no longer works here', async () => {
    const res = await commsTasksPost(postReq('https://staxis.test/api/comms/tasks', {
      pid: PID_A1,
      title: 'Count the towels',
      assignedStaffId: retired,
    }));
    assert.equal(res.status, 400);
    assert.match(String(((await res.json()) as Envelope).error), /no longer active/i);
  });

  test('the to-do route still works for somebody who can see the list', async () => {
    const res = await commsTasksPost(postReq('https://staxis.test/api/comms/tasks', {
      pid: PID_A1,
      title: 'Chase the Sysco invoice',
      assignedStaffId: frontDesk,
    }));
    const body = (await res.json()) as Envelope;
    assert.equal(res.status, 201, JSON.stringify(body));
    const row = await one<{ assigned_staff_id: string }>('select assigned_staff_id from comms_tasks');
    assert.equal(row?.assigned_staff_id, frontDesk);
  });

  test('the reassign route refuses to move an existing to-do onto a housekeeper', async () => {
    const task = await one<{ id: string }>(
      `insert into comms_tasks (property_id, title, status) values ($1, 'Fix the ice machine', 'open') returning id`,
      [PID_A1],
    );
    const res = await worklistAssignPost(postReq('https://staxis.test/api/worklist/assign', {
      pid: PID_A1,
      sourceType: 'task',
      sourceId: task!.id,
      assigneeStaffId: housekeeper,
    }));
    const body = (await res.json()) as Envelope;
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.match(String(body.error), /housekeeping board/i);

    const after_ = await one<{ assigned_staff_id: string | null }>(
      'select assigned_staff_id from comms_tasks where id = $1', [task!.id],
    );
    assert.equal(after_?.assigned_staff_id, null, 'the to-do must stay where somebody can still see it');
  });

  test('the reassign route still hands work to somebody who can see it', async () => {
    const task = await one<{ id: string }>(
      `insert into comms_tasks (property_id, title, status) values ($1, 'Call the elevator company', 'open') returning id`,
      [PID_A1],
    );
    const res = await worklistAssignPost(postReq('https://staxis.test/api/worklist/assign', {
      pid: PID_A1,
      sourceType: 'task',
      sourceId: task!.id,
      assigneeStaffId: frontDesk,
    }));
    const body = (await res.json()) as Envelope;
    assert.equal(res.status, 200, JSON.stringify(body));
    const after_ = await one<{ assigned_staff_id: string | null; assigned_department: string | null }>(
      'select assigned_staff_id, assigned_department from comms_tasks where id = $1', [task!.id],
    );
    assert.equal(after_?.assigned_staff_id, frontDesk);
    assert.equal(after_?.assigned_department, 'front_desk', 'the department is still derived server-side');
  });

  test('the insert helper itself refuses, so a caller that forgets cannot slip through', async () => {
    // This is the backstop under the chat tools and the message add-on, which
    // never go near either route.
    assert.match(
      await refusalMessage(() => createTask(PID_A1, { title: 'Deep clean 214', assignedStaffId: housekeeper })),
      /housekeeping board/i,
    );
    assert.equal((await pg.query('select id from comms_tasks')).rows.length, 0);
  });

  test('the recurring-template helper refuses too', async () => {
    assert.match(
      await refusalMessage(() => createTemplate({
        propertyId: PID_A1,
        createdByStaffId: frontDesk,
        title: 'Wipe down the lobby',
        assignedStaffId: housekeeper,
        cadence: 'daily',
      })),
      /housekeeping board/i,
    );
    assert.equal((await pg.query('select id from recurring_task_templates')).rows.length, 0);
  });

  test('an unassigned to-do is still perfectly legal', async () => {
    const { id } = await createTask(PID_A1, { title: 'Somebody please order coffee' });
    assert.ok(id);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3b. Every N days, against the real CHECK constraints
//
// The shape rules for this cadence live in migration 0455 as much as they do
// in normalizeCadence, and the database is the half nothing else in the suite
// exercises: a template with a cadence but no gap in it would spawn nothing,
// forever, and a gap on a WEEKLY template would be a parameter nothing reads.
// ═══════════════════════════════════════════════════════════════════════════

describe('a to-do that repeats every so many days', () => {
  test('is stored with its gap and its start day, and comes back on the gap', async () => {
    const { id } = await createTemplate({
      propertyId: PID_A1,
      createdByStaffId: frontDesk,
      title: 'Flush the water heater',
      cadence: 'every_n_days',
      intervalDays: 3,
      anchorDate: '2026-08-04',
    });
    const row = await one<{
      cadence: string; interval_days: number | null; anchor_date: string | null;
      weekday: number | null; day_of_month: number | null;
    }>(
      'select cadence, interval_days, anchor_date, weekday, day_of_month from recurring_task_templates where id = $1',
      [id],
    );
    assert.equal(row?.cadence, 'every_n_days');
    assert.equal(Number(row?.interval_days), 3);
    assert.ok(row?.anchor_date, 'a counted cadence with no start day drifts on the first missed tick');
    assert.equal(row?.weekday, null);
    assert.equal(row?.day_of_month, null);

    // And the spawner agrees with the row: third day yes, second day no.
    const template = {
      cadence: 'every_n_days' as const, weekday: null, dayOfMonth: null,
      anchorDate: '2026-08-04', intervalDays: 3,
    };
    assert.equal(isTemplateDueOn(template, { date: '2026-08-07', weekday: 5 }), true);
    assert.equal(isTemplateDueOn(template, { date: '2026-08-06', weekday: 4 }), false);
  });

  test('the database refuses the shapes that would spawn nothing', async () => {
    // Straight to Postgres, bypassing normalizeCadence, because the constraint
    // is the backstop for every writer that ever skips it.
    for (const [label, cols, vals] of [
      ['no gap at all', 'cadence, anchor_date', `'every_n_days', '2026-08-04'`],
      ['no start day', 'cadence, interval_days', `'every_n_days', 3`],
      ['a gap of one day', 'cadence, interval_days, anchor_date', `'every_n_days', 1, '2026-08-04'`],
      ['a gap past a year', 'cadence, interval_days, anchor_date', `'every_n_days', 400, '2026-08-04'`],
      ['a weekday it cannot use', 'cadence, interval_days, anchor_date, weekday', `'every_n_days', 3, '2026-08-04', 2`],
      ['a gap on a weekly template', 'cadence, weekday, interval_days', `'weekly', 2, 3`],
      ['a gap on a daily template', 'cadence, interval_days', `'daily', 3`],
    ] as const) {
      await assert.rejects(
        () => pg.query(
          `insert into recurring_task_templates (property_id, title, ${cols})
           values ($1, 'nope', ${vals})`,
          [PID_A1],
        ),
        `the database accepted ${label}`,
      );
    }
  });

  test('the five older cadences still store exactly what they always did', async () => {
    // 0455 restates the shape CHECK in full, so a mistake in it would break
    // every cadence at once rather than only the new one.
    const cases = [
      { cadence: 'daily' as const },
      { cadence: 'weekly' as const, weekday: 2 },
      { cadence: 'biweekly' as const, weekday: 2, anchorDate: '2026-08-04' },
      { cadence: 'monthly' as const, dayOfMonth: 15 },
    ];
    for (const c of cases) {
      const { id } = await createTemplate({
        propertyId: PID_A1, createdByStaffId: frontDesk, title: `still works: ${c.cadence}`, ...c,
      });
      const row = await one<{ interval_days: number | null }>(
        'select interval_days from recurring_task_templates where id = $1', [id],
      );
      assert.equal(row?.interval_days, null, `${c.cadence} picked up a gap it does not use`);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. The templates that predate the rule
// ═══════════════════════════════════════════════════════════════════════════

describe('a standing to-do aimed at somebody who cannot see it', () => {
  test('spawns onto the shared list rather than into nothing, every day', async () => {
    // Written straight to Postgres, exactly as a template created before the
    // guard existed would look. Left alone this manufactured one invisible
    // task per day, forever, and nobody notices work that was never visible.
    const template = await one<{ id: string }>(
      `insert into recurring_task_templates
         (property_id, title, assigned_staff_id, cadence, active)
       values ($1, 'Check the pool chemicals', $2, 'daily', true) returning id`,
      [PID_A1, housekeeper],
    );

    const result = await spawnDueRecurringTodos(new Date());
    assert.equal(result.spawned, 1, 'the hotel still gets its standing work');

    const spawnedRow = await one<{ title: string; assigned_staff_id: string | null }>(
      'select title, assigned_staff_id from comms_tasks where recurring_template_id = $1',
      [template!.id],
    );
    assert.equal(spawnedRow?.title, 'Check the pool chemicals');
    assert.equal(
      spawnedRow?.assigned_staff_id,
      null,
      'the work must land somewhere people look, not on a list its assignee never opens',
    );
  });

  test('a template aimed at somebody who can see it keeps its assignee', async () => {
    await pg.query(
      `insert into recurring_task_templates
         (property_id, title, assigned_staff_id, cadence, active)
       values ($1, 'Reconcile the shift float', $2, 'daily', true)`,
      [PID_A1, frontDesk],
    );
    await spawnDueRecurringTodos(new Date());
    const spawnedRow = await one<{ assigned_staff_id: string | null }>(
      `select assigned_staff_id from comms_tasks where title = 'Reconcile the shift float'`,
    );
    assert.equal(spawnedRow?.assigned_staff_id, frontDesk);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. The read path has not drifted from the write path
// ═══════════════════════════════════════════════════════════════════════════

describe('the assignee list', () => {
  test('offers the people the write seams would actually accept', async () => {
    const names = (await listAssignees(PID_A1)).map((p) => p.name);
    assert.ok(names.includes('Dana Pike'), 'front desk can be handed work');
    assert.ok(!names.includes('Rosa Delgado'), 'a housekeeper is never offered');
    assert.ok(!names.includes('Sam Older'), 'somebody who left is never offered');
    assert.ok(!names.includes('Tyler Housekeeper'), 'another hotel is another hotel');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. The day a time-off request is about
// ═══════════════════════════════════════════════════════════════════════════

describe('a time-off request lands on the day it is about', () => {
  async function requestOff(day: string): Promise<void> {
    await pg.query(
      `insert into time_off_requests (property_id, staff_id, request_date, status)
       values ($1, $2, $3::date, 'pending')`,
      [PID_A1, frontDesk, day],
    );
  }

  async function timeOffItem(day: string) {
    await requestOff(day);
    const items = await gatherWorklist(PID_A1);
    const item = items.find((i) => i.sourceType === 'approval' && i.id.includes('timeoff'));
    assert.ok(item, 'a pending time-off request belongs on the approvals list');
    return item;
  }

  test('the calendar square matches the day the row names', async () => {
    // THE BUG: dueDate was `${day}T00:00:00.000Z`. In Chicago that instant is
    // 7pm the PREVIOUS evening, so "Dana asked for the 14th off" was filed
    // under the 13th and the row contradicted its own text.
    const day = '2026-08-14';
    const item = await timeOffItem(day);
    assert.match(item.title, /2026-08-14/, 'the row says which day it is about');
    assert.equal(dayOf(item), day, 'and the calendar must agree with it');
  });

  test('the day ends when the HOTEL\'s day ends, not when Greenwich\'s does', async () => {
    // This test used to check that the instant read as the right calendar day
    // at every US offset, which was the best available check while the code did
    // not know the hotel's timezone: it had to pick one instant that looked
    // acceptable everywhere, and `T23:59:59Z` was it. That stamp expires at
    // 6:59pm in Texas, so a request for today went stale while the front desk
    // was still on shift.
    //
    // Now the row is dated in the hotel's own zone, so the real invariant is
    // sharper: it is the LAST instant of the named day where the hotel is.
    const day = '2026-08-14';
    const item = await timeOffItem(day);
    const instant = new Date(String(item.dueDate));

    const inHotelZone = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Chicago',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(instant);
    const part = (t: string) => inHotelZone.find((p) => p.type === t)?.value;
    assert.equal(`${part('year')}-${part('month')}-${part('day')}`, day, 'the named day, at the hotel');
    assert.equal(`${part('hour')}:${part('minute')}`, '23:59', 'and the very end of it');

    // One minute later is already the next day at the hotel, so the boundary is
    // where it claims to be rather than merely somewhere inside the right day.
    const justAfter = new Date(instant.getTime() + 60_000);
    assert.notEqual(
      new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(justAfter),
      day,
    );
  });

  test('a request for a day still to come is not overdue', async () => {
    const future = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
    const item = await timeOffItem(future);
    assert.equal(item.overdue, false);
    assert.equal(dayOf(item), future);
  });

  test('a request for a day already gone is overdue', async () => {
    // Unanswered by the time the day itself has passed is a person who never
    // found out whether to come in.
    const past = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10);
    const item = await timeOffItem(past);
    assert.equal(item.overdue, true);
    assert.equal(dayOf(item), past);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// FOLLOW-THROUGH: what happens to a to-do that slipped
//
// Every bug in this section is silent by construction, which is why they are
// pinned against a real Postgres rather than a stub:
//
//   NO-STACKING     the recurrence engine spawns a row per day whether or not
//                   yesterday's got done. Nothing errors. The list just grows a
//                   second identical row, then a third, and a daily to-do
//                   nobody did for a week is a screen of the same sentence.
//
//   DATED HONESTY   "Done" stamps the moment of the TAP. Work done Tuesday and
//                   reported Thursday went into the record as Thursday's, and
//                   every pattern the product learns from this table was being
//                   taught a date nobody chose. Nothing looked wrong.
//
//   FLOW-BACK       the assigner's drawer only knew done and can't. A
//                   completion credited to another day, a completion that
//                   landed late, and work that stopped needing doing were all
//                   either shown as a plain "done" or not shown at all.
// ═══════════════════════════════════════════════════════════════════════════

/** The staff id the routes resolve for the signed-in test user. */
async function callerStaffId(): Promise<string> {
  const res = await commsTasksPost(postReq('http://t/api/comms/tasks', {
    pid: PID_A1, title: 'whoami probe',
  }));
  const body = (await res.json()) as Envelope;
  const row = await one<{ created_by_staff_id: string }>(
    'select created_by_staff_id from comms_tasks where id = $1',
    [String(body.data!.id)],
  );
  await pg.query('delete from comms_tasks where id = $1', [String(body.data!.id)]);
  return row!.created_by_staff_id;
}

/** Settle a to-do through the real route, and hand back the envelope. */
async function settle(
  taskId: string,
  outcome: 'done' | 'cant' | 'done_on_due' | 'skip',
  reason?: string,
): Promise<Envelope> {
  const res = await worklistCompletePost(postReq('http://t/api/worklist/complete', {
    pid: PID_A1, sourceType: 'task', sourceId: taskId, outcome,
    ...(reason ? { reason } : {}),
  }));
  return (await res.json()) as Envelope;
}

async function taskRow(id: string) {
  return one<{
    status: string;
    completed_at: string | null;
    completed_for_date: string | null;
    skipped_at: string | null;
    skipped_by_staff_id: string | null;
    due_time: string | null;
  }>(
    // Cast to text on the way out. Raw pglite hands a `date` back as a JS Date
    // at UTC midnight, which in the hotel's timezone prints as the PREVIOUS
    // day — so an assertion that read it as a string would fail on correct code
    // and, worse, could be "fixed" by backdating the write.
    `select status, completed_at, completed_for_date::text as completed_for_date,
            skipped_at, skipped_by_staff_id, due_time::text as due_time
     from comms_tasks where id = $1`,
    [id],
  );
}

/** Today at the hotel, and the days behind it, as the spawner writes them. */
function localDay(offset: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(d);
}

describe('a repeating to-do that was missed does not stack up', () => {
  test('five missed days are ONE row on the list, not five', async () => {
    const me = await callerStaffId();
    const tpl = await createTemplate({
      propertyId: PID_A1,
      createdByStaffId: me,
      title: 'Restock the coffee station',
      assignedStaffId: me,
      cadence: 'daily',
    });
    // What the spawner leaves behind after five days when nobody ticks it off:
    // five independent open rows, each stamped for its own day.
    for (let back = 4; back >= 0; back -= 1) {
      await pg.query(
        `insert into comms_tasks
           (property_id, title, assigned_staff_id, created_by_staff_id, status,
            recurring_template_id, recurring_instance_date)
         values ($1, $2, $3, $3, 'open', $4, $5)`,
        [PID_A1, 'Restock the coffee station', me, tpl.id, localDay(-back)],
      );
    }
    const open = await one<{ n: string }>(
      `select count(*) as n from comms_tasks where recurring_template_id = $1 and status = 'open'`,
      [tpl.id],
    );
    assert.equal(Number(open!.n), 5, 'the database really does hold five rows');

    const items = await gatherWorklist(PID_A1, { tasksOnly: true });
    const coffee = items.filter((i) => i.title === 'Restock the coffee station');
    assert.equal(coffee.length, 1, 'but the list says it once');
    assert.equal(coffee[0].supersededIds?.length, 4, 'and it speaks for the other four');
    assert.equal(coffee[0].missedSince, localDay(-4), 'reaching back to the oldest one still open');
    assert.equal(coffee[0].overdue, true, 'a run with missed days behind it is late');
  });

  test('answering the one row closes the whole run, so it cannot come back tomorrow', async () => {
    const me = await callerStaffId();
    const tpl = await createTemplate({
      propertyId: PID_A1, createdByStaffId: me, title: 'Walk the halls',
      assignedStaffId: me, cadence: 'daily',
    });
    for (let back = 2; back >= 0; back -= 1) {
      await pg.query(
        `insert into comms_tasks
           (property_id, title, assigned_staff_id, created_by_staff_id, status,
            recurring_template_id, recurring_instance_date)
         values ($1, 'Walk the halls', $2, $2, 'open', $3, $4)`,
        [PID_A1, me, tpl.id, localDay(-back)],
      );
    }
    const [survivor] = (await gatherWorklist(PID_A1, { tasksOnly: true }))
      .filter((i) => i.title === 'Walk the halls');
    const body = await settle(survivor.sourceId, 'done');
    assert.equal(body.ok, true);

    const stillOpen = await one<{ n: string }>(
      `select count(*) as n from comms_tasks where recurring_template_id = $1 and status = 'open'`,
      [tpl.id],
    );
    assert.equal(Number(stillOpen!.n), 0, 'nothing is left to reappear tomorrow');

    // NOT all marked done. The person said they did it TODAY; claiming they
    // also did Monday's and Tuesday's would be the fiction this whole change
    // exists to remove. Every one of them is still a real row with a real
    // recorded outcome, which is the difference from deleting them.
    const done = await one<{ n: string }>(
      `select count(*) as n from comms_tasks where recurring_template_id = $1 and status = 'done'`,
      [tpl.id],
    );
    const skipped = await one<{ n: string }>(
      `select count(*) as n from comms_tasks where recurring_template_id = $1 and status = 'skipped'`,
      [tpl.id],
    );
    assert.equal(Number(done!.n), 1, 'one day was actually done');
    assert.equal(Number(skipped!.n), 2, 'the two that had already gone by are recorded as not done');
  });
});

describe('a completion is recorded on the day the work happened', () => {
  test('"Did it yesterday" credits the day it was due, and still says when it was reported', async () => {
    const me = await callerStaffId();
    const yesterday = localDay(-1);
    const row = await one<{ id: string }>(
      `insert into comms_tasks
         (property_id, title, assigned_staff_id, created_by_staff_id, status, due_at)
       values ($1, 'Change the lobby filters', $2, $2, 'open', $3) returning id`,
      [PID_A1, me, `${yesterday}T23:59:59-05:00`],
    );
    const body = await settle(row!.id, 'done_on_due');
    assert.equal(body.ok, true);

    const after = await taskRow(row!.id);
    assert.equal(after!.status, 'done');
    assert.equal(
      after!.completed_for_date,
      yesterday,
      'the record says the work happened on the day it was due',
    );
    // And completed_at is NOT backdated. When somebody told us is its own fact,
    // and losing it would mean nobody could ever tell a same-day completion
    // from one reported three days later. Compared as DAYS at the hotel, which
    // is the grain the claim is actually about.
    const reportedOn = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' })
      .format(new Date(after!.completed_at!));
    assert.equal(reportedOn, localDay(0), 'it was reported today');
    assert.notEqual(reportedOn, after!.completed_for_date, 'and credited to a different day');
  });

  test('a plain "Done" claims today and credits no other day', async () => {
    const me = await callerStaffId();
    const row = await one<{ id: string }>(
      `insert into comms_tasks
         (property_id, title, assigned_staff_id, created_by_staff_id, status, due_at)
       values ($1, 'Check the pool', $2, $2, 'open', $3) returning id`,
      [PID_A1, me, `${localDay(-2)}T23:59:59-05:00`],
    );
    await settle(row!.id, 'done');
    const after = await taskRow(row!.id);
    assert.equal(after!.status, 'done');
    assert.equal(after!.completed_for_date, null, 'no day was credited, because none was claimed');
  });

  test('the credited day comes from the row, so a caller cannot name its own', async () => {
    const me = await callerStaffId();
    const row = await one<{ id: string }>(
      `insert into comms_tasks
         (property_id, title, assigned_staff_id, created_by_staff_id, status, due_at)
       values ($1, 'Test the generator', $2, $2, 'open', $3) returning id`,
      [PID_A1, me, `${localDay(-1)}T23:59:59-05:00`],
    );
    const res = await worklistCompletePost(postReq('http://t/api/worklist/complete', {
      pid: PID_A1, sourceType: 'task', sourceId: row!.id, outcome: 'done_on_due',
      // A body that could write history. It is simply not read.
      completedForDate: '2019-01-01',
    }));
    assert.equal(((await res.json()) as Envelope).ok, true);
    const after = await taskRow(row!.id);
    assert.equal(after!.completed_for_date, localDay(-1));
  });

  test('"Not needed" records the decision instead of deleting the row', async () => {
    const me = await callerStaffId();
    const row = await one<{ id: string }>(
      `insert into comms_tasks
         (property_id, title, assigned_staff_id, created_by_staff_id, status, due_at)
       values ($1, 'Order the spare filters', $2, $2, 'open', $3) returning id`,
      [PID_A1, me, `${localDay(-1)}T23:59:59-05:00`],
    );
    const body = await settle(row!.id, 'skip');
    assert.equal(body.ok, true);
    const after = await taskRow(row!.id);
    assert.equal(after!.status, 'skipped', 'the row is still there, and it says what happened');
    assert.ok(after!.skipped_at, 'stamped with when somebody decided');
    assert.equal(after!.skipped_by_staff_id, me, 'and with who decided it');
    // The one thing "not needed" must NOT require, or people go back to
    // deleting rows to get out of writing a sentence.
    assert.equal(body.error, undefined);
  });

  test('a refusal still needs its reason, unchanged', async () => {
    const me = await callerStaffId();
    const row = await one<{ id: string }>(
      `insert into comms_tasks (property_id, title, assigned_staff_id, created_by_staff_id, status)
       values ($1, 'Fix the ice machine', $2, $2, 'open') returning id`,
      [PID_A1, me],
    );
    const body = await settle(row!.id, 'cant');
    assert.equal(body.ok, false, 'a reasonless refusal is still refused');
  });
});

describe('the assigner is told the true story, whichever ending it had', () => {
  /** A to-do Maria handed to Dana, already past its day. */
  async function handedToDana(title: string): Promise<{ id: string; me: string }> {
    const me = await callerStaffId();
    const row = await one<{ id: string }>(
      `insert into comms_tasks
         (property_id, title, assigned_staff_id, created_by_staff_id, status, due_at)
       values ($1, $2, $3, $4, 'open', $5) returning id`,
      [PID_A1, title, frontDesk, me, `${localDay(-1)}T23:59:59-05:00`],
    );
    return { id: row!.id, me };
  }

  test('done late reaches the drawer as done, with the day it was reported', async () => {
    const { id, me } = await handedToDana('Count the linen');
    await settle(id, 'done');
    const [entry] = await gatherAssignedByMe(PID_A1, me);
    assert.equal(entry.state, 'done');
    assert.equal(entry.completedForDate, null);
    assert.match(assignedStateLine(entry, new Date()), /after it was due/);
  });

  test('done yesterday reaches the drawer as the day the work happened', async () => {
    const { id, me } = await handedToDana('Deep clean the vents');
    await settle(id, 'done_on_due');
    const [entry] = await gatherAssignedByMe(PID_A1, me);
    assert.equal(entry.state, 'done');
    assert.equal(String(entry.completedForDate).slice(0, 10), localDay(-1));
    // The whole point: the assigner reads the day the work happened, not the
    // day somebody got round to telling them.
    assert.match(assignedStateLine(entry, new Date()), /did it yesterday/i);
  });

  test('not needed reaches the drawer as its own ending, not as done', async () => {
    const { id, me } = await handedToDana('Replace the lobby mats');
    await settle(id, 'skip');
    const [entry] = await gatherAssignedByMe(PID_A1, me);
    assert.equal(entry.state, 'skipped');
    assert.match(assignedStateLine(entry, new Date()), /not needed/i);
    assert.match(completionNotice(entry), /not needed/i);
  });

  test('all three endings are news, so none of them is silently swallowed', async () => {
    const me = await callerStaffId();
    for (const [title, outcome] of [
      ['A', 'done'], ['B', 'done_on_due'], ['C', 'skip'],
    ] as const) {
      const row = await one<{ id: string }>(
        `insert into comms_tasks
           (property_id, title, assigned_staff_id, created_by_staff_id, status, due_at)
         values ($1, $2, $3, $4, 'open', $5) returning id`,
        [PID_A1, title, frontDesk, me, `${localDay(-1)}T23:59:59-05:00`],
      );
      await settle(row!.id, outcome);
    }
    const assigned = await gatherAssignedByMe(PID_A1, me);
    const news = assignerNotices(assigned, null, new Date());
    assert.equal(news.length, 3, 'every ending comes back to the person who asked');
  });
});

describe('an optional time of day survives the round trip', () => {
  test('a to-do keeps the time it was given, and says it back', async () => {
    const res = await commsTasksPost(postReq('http://t/api/comms/tasks', {
      pid: PID_A1, title: 'Set up the meeting room', dueDate: localDay(0), dueTime: '15:00',
    }));
    const body = (await res.json()) as Envelope;
    assert.equal(body.ok, true);
    const row = await taskRow(String(body.data!.id));
    assert.equal(String(row!.due_time).slice(0, 5), '15:00');

    const [item] = (await gatherWorklist(PID_A1, { tasksOnly: true }))
      .filter((i) => i.title === 'Set up the meeting room');
    assert.equal(item.dueTime, '15:00', 'and it comes back in the one shape the UI reads');
    assert.match(dueLine(item.dueDate, new Date(), item.dueTime)!, /by 3pm/);
  });

  test('a malformed time is refused rather than silently dropped', async () => {
    const res = await commsTasksPost(postReq('http://t/api/comms/tasks', {
      pid: PID_A1, title: 'Nonsense hour', dueDate: localDay(0), dueTime: '25:99',
    }));
    assert.equal(((await res.json()) as Envelope).ok, false);
  });

  test('a repeating to-do carries its time onto every instance it spawns', async () => {
    const me = await callerStaffId();
    const created = await commsTasksPost(postReq('http://t/api/comms/tasks', {
      pid: PID_A1, title: 'Check the boiler room', repeat: 'daily', dueTime: '09:30',
      assignedStaffId: me,
    }));
    const body = (await created.json()) as Envelope;
    assert.equal(body.ok, true);
    await spawnDueRecurringTodos();
    const spawned = await one<{ due_time: string | null }>(
      `select due_time::text as due_time from comms_tasks where recurring_template_id = $1`,
      [String(body.data!.templateId)],
    );
    assert.equal(
      String(spawned!.due_time).slice(0, 5),
      '09:30',
      'without this the time survives one day and then quietly disappears',
    );
  });
});

describe('what is new since this person last looked', () => {
  test('nothing is new once the cursor has moved past it', async () => {
    const me = await callerStaffId();
    await pg.query(
      `insert into comms_tasks (property_id, title, assigned_staff_id, created_by_staff_id, status)
       values ($1, 'Something that arrived', $2, $2, 'open')`,
      [PID_A1, me],
    );
    const viewer = { staffId: me, accountId: ACCOUNT_MARIA, role: 'general_manager', dept: null };

    const beforeLooking = await countNewOnList(PID_A1, viewer, null);
    assert.ok(beforeLooking >= 1, 'a to-do that just arrived is new to somebody who never looked');

    // Looking is what moves the cursor. Stamped a moment ahead so the test is
    // not racing the row's own created_at inside the same millisecond.
    const looked = new Date(Date.now() + 1000).toISOString();
    const afterLooking = await countNewOnList(PID_A1, viewer, looked);
    assert.equal(afterLooking, 0, 'and it is not new to somebody who just read it');
  });

  test('work handed to somebody else is not new to me', async () => {
    const me = await callerStaffId();
    await pg.query(
      `insert into comms_tasks (property_id, title, assigned_staff_id, created_by_staff_id, status)
       values ($1, 'Dana''s own job', $2, $3, 'open')`,
      [PID_A1, frontDesk, me],
    );
    const dana = { staffId: frontDesk, accountId: ACCOUNT_MARIA, role: 'front_desk', dept: 'front_desk' };
    const mine = { staffId: me, accountId: ACCOUNT_MARIA, role: 'general_manager', dept: null };
    assert.equal(await countNewOnList(PID_A1, dana, null), 1, 'it is new on the list it landed on');
    assert.equal(
      await countNewOnList(PID_A1, mine, null),
      0,
      'and it is not on the assigner\'s list at all, so it cannot be new there',
    );
  });
});
