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
import { gatherWorklist, listAssignees } from '@/lib/worklist/core';
import {
  assigneeBlockedReason,
  assignmentBlockedReason,
  isAssignable,
} from '@/lib/worklist/assignable';
import { createTask } from '@/lib/comms/core';
import { createTemplate, spawnDueRecurringTodos } from '@/lib/recurring-tasks/store';
import { dayOf } from '@/components/concourse/list-calendar';

import { applyMigrationsToPglite } from '../../../tests/fixtures/pglite-migrate';
import {
  createPglitePostgrest,
  loadCatalog,
  type PglitePostgrest,
} from '../../../tests/fixtures/postgrest-pglite';
import { PID_A1, PID_B1, UID_MARIA, seedTwoCompanies } from '../../../tests/fixtures/pglite-two-company-seed';

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

  test('it still reads as the right day at every US offset', async () => {
    // The product ships to US hotels, which is also the assumption the
    // composer already makes when it stamps a due date. Hawaii through the
    // Atlantic edge covers the whole range.
    const day = '2026-08-14';
    const item = await timeOffItem(day);
    const instant = Date.parse(String(item.dueDate));
    for (const offsetHours of [-10, -9, -8, -7, -6, -5, -4]) {
      const localDay = new Date(instant + offsetHours * 3_600_000).toISOString().slice(0, 10);
      assert.equal(localDay, day, `read at UTC${offsetHours} the request must still be about ${day}`);
    }
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
