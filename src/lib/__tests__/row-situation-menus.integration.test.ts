/**
 * EVERY SITUATION IN THE ROW MENU, AGAINST A REAL POSTGRES.
 *
 * The menu's whole promise is that each option is a REAL state: it writes to a
 * column that already meant this, and it leaves a trace somebody can find
 * afterwards. That promise cannot be checked against a stub, because a stub
 * returns whatever the test told it to and the write could be missing entirely.
 * So this drives the actual route handlers over the actual schema.
 *
 * The four things that would be silent if they broke:
 *
 *   1. A REST THAT DOES NOT REST. "Somebody's been called" writes `called_at`,
 *      which the nightly card has honoured since 0366 — but the LIST ignored it
 *      completely, so the button silenced the card and left the row sitting
 *      there saying the same thing. That is the bug this feature was built on
 *      top of, and it is pinned here in both directions: gone while resting,
 *      back afterwards.
 *
 *   2. A SKIP THAT RECORDS A SERVICE. The one genuinely dangerous failure. If
 *      "Skip this one" ever moved `last_completed_at`, this hotel's maintenance
 *      record would say a job nobody performed was performed, and the schedule
 *      would then stay silent for a full cadence about it.
 *
 *   3. A DEFERRED TICKET THAT VANISHES. "Waiting on parts" must leave the row
 *      ON the list. A defer that removed it would turn a stalled job into a
 *      forgotten one, which is worse than the nagging it was meant to stop.
 *
 *   4. A NON-ISSUE FILED AS A REPAIR. `closed` and `resolved` are two words on
 *      purpose. Closing one that came from an upkeep schedule must NOT stamp
 *      that schedule as done (the 0366 trigger fires only on `resolved`).
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
// Pinned BEFORE the first Date is constructed. Chicago is the customer's zone.
process.env.TZ = 'America/Chicago';

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { NextRequest } from 'next/server';
import type { PGlite } from '@electric-sql/pglite';

import { supabaseAdmin } from '@/lib/supabase-admin';
import { POST as worklistAssignPost } from '@/app/api/worklist/assign/route';
import { POST as worklistCompletePost } from '@/app/api/worklist/complete/route';
import { gatherWorklist } from '@/lib/worklist/core';
import { fromWorkOrderRow, fromPreventiveRow } from '@/lib/db-mappers';
import { PREVENTIVE_FOLLOW_UP_DAYS } from '@/lib/maintenance/preventive-rest';
import type { WorklistItem } from '@/lib/worklist/types';

import { applyMigrationsToPglite } from '../../../tests/fixtures/pglite-migrate';
import {
  createPglitePostgrest,
  loadCatalog,
  type PglitePostgrest,
} from '../../../tests/fixtures/postgrest-pglite';
import { PID_A1, PID_B1, UID_MARIA, seedTwoCompanies } from '../../../tests/fixtures/pglite-two-company-seed';

const DAY = 86_400_000;

let pg: PGlite;
let shim: PglitePostgrest;

const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);
const originalRpc = supabaseAdmin.rpc.bind(supabaseAdmin);
const originalGetUser = supabaseAdmin.auth.getUser.bind(supabaseAdmin.auth);

let currentUser: string | null = UID_MARIA;
let housekeeper = '';
let tech = '';

async function one<T extends Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T | null> {
  const r = await pg.query<T>(sql, params);
  return r.rows[0] ?? null;
}

async function addStaff(pid: string, name: string, department: string): Promise<string> {
  const row = await one<{ id: string }>(
    `insert into staff (property_id, name, department, is_active)
     values ($1, $2, $3, true) returning id`,
    [pid, name, department],
  );
  return row!.id;
}

function postReq(url: string, body: Record<string, unknown>): NextRequest {
  return new NextRequest(url, {
    method: 'POST',
    headers: {
      authorization: 'Bearer row-menu-test-token',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

interface Envelope { ok: boolean; error?: string; data?: Record<string, unknown> }

async function settle(
  sourceType: string, sourceId: string, outcome: string,
  extra: Record<string, unknown> = {}, pid = PID_A1,
): Promise<{ status: number; body: Envelope }> {
  const res = await worklistCompletePost(postReq('http://t/api/worklist/complete', {
    pid, sourceType, sourceId, outcome, ...extra,
  }));
  return { status: res.status, body: (await res.json()) as Envelope };
}

async function change(
  sourceType: string, sourceId: string,
  patch: Record<string, unknown>, pid = PID_A1,
): Promise<{ status: number; body: Envelope }> {
  const res = await worklistAssignPost(postReq('http://t/api/worklist/assign', {
    pid, sourceType, sourceId, ...patch,
  }));
  return { status: res.status, body: (await res.json()) as Envelope };
}

/** A preventive schedule that is already overdue by a wide margin. */
async function overdueSchedule(name = 'Fire panel inspection', frequencyDays = 90, pid = PID_A1): Promise<string> {
  const row = await one<{ id: string }>(
    `insert into preventive_tasks (property_id, name, area, frequency_days, last_completed_at)
     values ($1, $2, 'Building', $3, now() - ($4 || ' days')::interval) returning id`,
    [pid, name, frequencyDays, String(frequencyDays + 36)],
  );
  return row!.id;
}

async function openWorkOrder(description = 'Pool light out', pid = PID_A1): Promise<string> {
  const row = await one<{ id: string }>(
    `insert into work_orders (property_id, room_number, description, severity, status)
     values ($1, 'Pool', $2, 'medium', 'submitted') returning id`,
    [pid, description],
  );
  return row!.id;
}

/** The rows the Staxis list would actually draw for the general manager. */
async function listRows(pid = PID_A1): Promise<WorklistItem[]> {
  return gatherWorklist(pid, {
    viewer: { staffId: tech, accountId: 'a', role: 'general_manager', dept: null },
  });
}

const rowFor = (items: readonly WorklistItem[], sourceId: string) =>
  items.find((i) => i.sourceId === sourceId) ?? null;

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
      ? { data: { user: { id: currentUser, email: `${currentUser}@rowmenu.test` } }, error: null }
      : { data: { user: null }, error: { message: 'invalid token', status: 401, name: 'AuthApiError' } }
  ) as unknown as typeof supabaseAdmin.auth.getUser;

  await seedTwoCompanies(pg);
  housekeeper = await addStaff(PID_A1, 'Rosa Delgado', 'housekeeping');
  tech = await addStaff(PID_A1, 'Marcus Webb', 'maintenance');

  // The columns this whole feature rests on. If 0462 did not replay, every
  // assertion below would fail in a confusing way; this fails in a clear one.
  const col = await one<{ n: string }>(
    `select count(*)::text as n from information_schema.columns
      where table_name = 'preventive_tasks' and column_name in ('skipped_at','skipped_by')`,
  );
  assert.equal(col?.n, '2', 'migration 0462 did not apply to the test database');
});

after(async () => {
  supabaseAdmin.from = originalFrom;
  supabaseAdmin.rpc = originalRpc;
  supabaseAdmin.auth.getUser = originalGetUser;
  await pg?.close();
});

beforeEach(async () => {
  currentUser = UID_MARIA;
  await pg.query('delete from work_orders');
  await pg.query('delete from preventive_tasks');
  await pg.query('delete from comms_tasks');
});

// ═══════════════════════════════════════════════════════════════════════════
// 1. The upkeep schedule's three answers
// ═══════════════════════════════════════════════════════════════════════════

describe('"Somebody\'s been called" on a schedule', () => {
  test('records the call, moves no completion date, and takes the row off the list', async () => {
    const id = await overdueSchedule();
    assert.ok(rowFor(await listRows(), id), 'an overdue schedule starts on the list');

    const before_ = await one<{ last_completed_at: Date }>(
      'select last_completed_at from preventive_tasks where id = $1', [id],
    );
    const res = await settle('pm', id, 'called');
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const row = await one<{ called_at: Date | null; called_by: string | null; last_completed_at: Date }>(
      'select called_at, called_by, last_completed_at from preventive_tasks where id = $1', [id],
    );
    assert.ok(row?.called_at, 'the call has to be recorded somewhere a person can find it');
    assert.ok(row?.called_by, 'and by whom');
    assert.equal(
      new Date(row!.last_completed_at).getTime(),
      new Date(before_!.last_completed_at).getTime(),
      'a call is the opposite of done: the clock must not restart',
    );
    assert.equal(rowFor(await listRows(), id), null, 'the row rests instead of repeating itself');
  });

  test('and the row comes back once the week is up', async () => {
    const id = await overdueSchedule();
    await settle('pm', id, 'called');
    await pg.query(
      `update preventive_tasks set called_at = now() - ($2 || ' days')::interval where id = $1`,
      [id, String(PREVENTIVE_FOLLOW_UP_DAYS + 1)],
    );
    assert.ok(rowFor(await listRows(), id), 'a rest that never ends is a schedule that was lost');
  });
});

describe('"Skip this one" on a schedule', () => {
  test('records the skip WITHOUT recording a service', async () => {
    const id = await overdueSchedule('Water heater flush', 180);
    const before_ = await one<{ last_completed_at: Date }>(
      'select last_completed_at from preventive_tasks where id = $1', [id],
    );

    const res = await settle('pm', id, 'skip');
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const row = await one<{
      skipped_at: Date | null; skipped_by: string | null; last_completed_at: Date; last_completed_by: string | null;
    }>('select skipped_at, skipped_by, last_completed_at, last_completed_by from preventive_tasks where id = $1', [id]);
    assert.ok(row?.skipped_at);
    assert.ok(row?.skipped_by, 'somebody decided this, and the record says who');
    assert.equal(
      new Date(row!.last_completed_at).getTime(),
      new Date(before_!.last_completed_at).getTime(),
      'THE dangerous failure: a skip must never be filed as a completion',
    );
    assert.equal(row?.last_completed_by, null, 'and must not put a name against work nobody did');
  });

  test('never deletes the schedule, and it comes back a cadence later', async () => {
    const id = await overdueSchedule('Water heater flush', 30);
    await settle('pm', id, 'skip');

    const still = await one<{ n: string }>('select count(*)::text as n from preventive_tasks where id = $1', [id]);
    assert.equal(still?.n, '1', 'the schedule survives the occurrence');
    assert.equal(rowFor(await listRows(), id), null, 'this one is put down');

    await pg.query(`update preventive_tasks set skipped_at = now() - interval '31 days' where id = $1`, [id]);
    const back = rowFor(await listRows(), id);
    assert.ok(back, 'and the next one comes round');
    assert.equal(back!.overdue, true, 'still late, measured from the real last-done date');
  });

  test('retires a pending call, so a schedule never rests for two reasons at once', async () => {
    const id = await overdueSchedule();
    await settle('pm', id, 'called');
    await settle('pm', id, 'skip');
    const row = await one<{ called_at: Date | null; skipped_at: Date | null }>(
      'select called_at, skipped_at from preventive_tasks where id = $1', [id],
    );
    assert.equal(row?.called_at, null, 'nobody is waiting on that call any more');
    assert.ok(row?.skipped_at);
  });

  test('and a fresh call retires a skip, in the other direction', async () => {
    const id = await overdueSchedule();
    await settle('pm', id, 'skip');
    await pg.query(`update preventive_tasks set skipped_at = now() - interval '95 days' where id = $1`, [id]);
    await settle('pm', id, 'called');
    const row = await one<{ called_at: Date | null; skipped_at: Date | null }>(
      'select called_at, skipped_at from preventive_tasks where id = $1', [id],
    );
    assert.ok(row?.called_at);
    assert.equal(row?.skipped_at, null);
  });

  test('marking it done later clears the rest and restarts the clock', async () => {
    const id = await overdueSchedule();
    await settle('pm', id, 'called');
    await settle('pm', id, 'done');
    const row = await one<{ called_at: Date | null; last_completed_at: Date; last_completed_by: string | null }>(
      'select called_at, last_completed_at, last_completed_by from preventive_tasks where id = $1', [id],
    );
    assert.equal(row?.called_at, null, 'the 0366 trigger retires the follow-up');
    assert.ok(row?.last_completed_by, 'and a completion names a person you can ask');
    assert.equal(rowFor(await listRows(), id), null, 'not due again for a full cadence');
  });
});

describe('"Change the schedule"', () => {
  test('changes the cadence and touches nothing else', async () => {
    const id = await overdueSchedule('Filter swap', 30);
    const res = await change('pm', id, { frequencyDays: 120 });
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const row = await one<Record<string, unknown>>('select * from preventive_tasks where id = $1', [id]);
    const task = fromPreventiveRow(row as Record<string, unknown>);
    assert.equal(task.frequencyDays, 120);
    assert.ok(task.lastCompletedAt, 'the last-done date is a claim about the building, not a setting');
    assert.ok(!task.lastCompletedBy, 'and changing a cadence puts nobody against a completion');
  });

  test('a cadence long enough to clear the due date takes the row off the list', async () => {
    // The honest consequence, and the reason this option exists: a schedule
    // that fires far too often stops firing.
    const id = await overdueSchedule('Filter swap', 30);
    assert.ok(rowFor(await listRows(), id));
    await change('pm', id, { frequencyDays: 365 });
    assert.equal(rowFor(await listRows(), id), null);
  });

  test('refuses a cadence that is not one, and says the range', async () => {
    const id = await overdueSchedule('Filter swap', 30);
    for (const bad of [0, -3, 4000, 'soon', 1.5]) {
      const res = await change('pm', id, { frequencyDays: bad });
      assert.equal(res.status, 400, `${JSON.stringify(bad)} should not be a cadence`);
      assert.match(String(res.body.error), /how many days/i);
    }
    const row = await one<{ frequency_days: number }>('select frequency_days from preventive_tasks where id = $1', [id]);
    assert.equal(row?.frequency_days, 30, 'a refused change leaves the schedule alone');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. The work order's three answers
// ═══════════════════════════════════════════════════════════════════════════

describe('"Waiting on parts" on a work order', () => {
  test('keeps the ticket on the list, out of the way, with the reason on it', async () => {
    const id = await openWorkOrder();
    const res = await settle('workorder', id, 'waiting', { reason: 'compressor back ordered until Friday' });
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const row = await one<{ status: string; notes: string | null; resolved_at: Date | null }>(
      'select status, notes, resolved_at from work_orders where id = $1', [id],
    );
    assert.equal(row?.status, 'deferred');
    assert.equal(row?.notes, 'compressor back ordered until Friday');
    assert.equal(row?.resolved_at, null, 'a deferral is not an ending');

    const listed = rowFor(await listRows(), id);
    assert.ok(listed, 'THE failure this guards: a defer that removes the row hides a stalled job');
    assert.equal(listed!.status, 'waiting');
    assert.equal(listed!.waitingReason, 'compressor back ordered until Friday');
    assert.equal(listed!.priority, 'low', 'it stops competing with live work');
    assert.equal(listed!.overdue, false);
    assert.equal(listed!.canComplete, true, 'and anybody can still finish it');
  });

  test('still reads as open on the maintenance board', async () => {
    const id = await openWorkOrder();
    await settle('workorder', id, 'waiting', { reason: 'part on order' });
    const row = await one<Record<string, unknown>>('select * from work_orders where id = $1', [id]);
    assert.equal(fromWorkOrderRow(row as Record<string, unknown>).status, 'open');
  });

  test('refuses to defer without saying what it is waiting on', async () => {
    const id = await openWorkOrder();
    for (const reason of [undefined, '', '   ']) {
      const res = await settle('workorder', id, 'waiting', reason === undefined ? {} : { reason });
      assert.equal(res.status, 400);
      assert.match(String(res.body.error), /what it is waiting on/i);
    }
    const row = await one<{ status: string }>('select status from work_orders where id = $1', [id]);
    assert.equal(row?.status, 'submitted', 'a refused deferral changes nothing');
  });

  test('and can be finished normally afterwards', async () => {
    const id = await openWorkOrder();
    await settle('workorder', id, 'waiting', { reason: 'part on order' });
    const res = await settle('workorder', id, 'done');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const row = await one<{ status: string; resolved_at: Date | null }>(
      'select status, resolved_at from work_orders where id = $1', [id],
    );
    assert.equal(row?.status, 'resolved');
    assert.ok(row?.resolved_at);
    assert.equal(rowFor(await listRows(), id), null);
  });
});

describe('"Give it to someone else" on a work order', () => {
  test('puts a name on the ticket that the list then shows', async () => {
    const id = await openWorkOrder();
    const res = await change('workorder', id, { assigneeStaffId: tech });
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const row = await one<{ assigned_to: string | null; assigned_name: string | null }>(
      'select assigned_to, assigned_name from work_orders where id = $1', [id],
    );
    assert.equal(row?.assigned_to, tech);
    assert.equal(row?.assigned_name, 'Marcus Webb', 'the name is derived server-side, never sent');

    const listed = rowFor(await listRows(), id);
    assert.equal(listed?.assigneeStaffId, tech);
    assert.equal(listed?.assigneeName, 'Marcus Webb');
  });

  test('refuses a housekeeper, and says where that work belongs', async () => {
    // Same wall as a to-do: they work from the housekeeping board, so a ticket
    // handed to one is not late, it is invisible.
    const id = await openWorkOrder();
    const res = await change('workorder', id, { assigneeStaffId: housekeeper });
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.match(String(res.body.error), /housekeeping board/i);
    const row = await one<{ assigned_to: string | null }>('select assigned_to from work_orders where id = $1', [id]);
    assert.equal(row?.assigned_to, null);
  });

  test('refuses somebody from another hotel', async () => {
    const id = await openWorkOrder();
    const stranger = await addStaff(PID_B1, 'Tyler Elsewhere', 'maintenance');
    const res = await change('workorder', id, { assigneeStaffId: stranger });
    assert.equal(res.status, 400);
    assert.match(String(res.body.error), /not found on this property/i);
  });

  test('an explicit null hands it back to nobody', async () => {
    const id = await openWorkOrder();
    await change('workorder', id, { assigneeStaffId: tech });
    const res = await change('workorder', id, { assigneeStaffId: null });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const row = await one<{ assigned_to: string | null; assigned_name: string | null }>(
      'select assigned_to, assigned_name from work_orders where id = $1', [id],
    );
    assert.equal(row?.assigned_to, null);
    assert.equal(row?.assigned_name, null);
  });

  test('the priority lane still works when no assignee is named', async () => {
    // The branch that was already there. Two controls on one route must not
    // have taken each other out.
    const id = await openWorkOrder();
    const res = await change('workorder', id, { priority: 'urgent' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const row = await one<{ severity: string }>('select severity from work_orders where id = $1', [id]);
    assert.equal(row?.severity, 'urgent');
  });
});

describe('"Not actually a problem" on a work order', () => {
  test('closes it as a non issue rather than as a repair', async () => {
    const id = await openWorkOrder();
    const res = await settle('workorder', id, 'not_an_issue');
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const row = await one<{ status: string; resolved_at: Date | null; completed_by_name: string | null }>(
      'select status, resolved_at, completed_by_name from work_orders where id = $1', [id],
    );
    assert.equal(row?.status, 'closed', 'closed and resolved are two words on purpose');
    assert.notEqual(row?.status, 'resolved');
    assert.ok(row?.resolved_at, 'when it was settled is still a fact worth keeping');
    assert.ok(row?.completed_by_name, 'and somebody made that call');

    assert.equal(rowFor(await listRows(), id), null, 'off the board');
    const mapped = fromWorkOrderRow(await one<Record<string, unknown>>('select * from work_orders where id = $1', [id]) as Record<string, unknown>);
    assert.equal(mapped.status, 'done', 'and off the maintenance board too, not open forever');
  });

  test('does NOT stamp the upkeep schedule it came from as done', async () => {
    // The 0366 trigger fires on `resolved`. A ticket somebody judged to be a
    // non issue is not a service that happened, and a schedule that recorded it
    // as one would then go quiet for a full cadence about a job nobody did.
    const scheduleId = await overdueSchedule('Elevator inspection', 90);
    const before_ = await one<{ last_completed_at: Date }>(
      'select last_completed_at from preventive_tasks where id = $1', [scheduleId],
    );
    const wo = await one<{ id: string }>(
      `insert into work_orders (property_id, description, severity, status, preventive_task_id)
       values ($1, 'Elevator inspection due', 'medium', 'submitted', $2) returning id`,
      [PID_A1, scheduleId],
    );

    await settle('workorder', wo!.id, 'not_an_issue');
    const after_ = await one<{ last_completed_at: Date }>(
      'select last_completed_at from preventive_tasks where id = $1', [scheduleId],
    );
    assert.equal(
      new Date(after_!.last_completed_at).getTime(),
      new Date(before_!.last_completed_at).getTime(),
      'a non issue must not restart an upkeep clock',
    );
  });

  test('but finishing the same ticket properly does', async () => {
    // The other side of the same trigger, so the test above cannot pass by the
    // link simply being broken.
    const scheduleId = await overdueSchedule('Elevator inspection', 90);
    const wo = await one<{ id: string }>(
      `insert into work_orders (property_id, description, severity, status, preventive_task_id)
       values ($1, 'Elevator inspection due', 'medium', 'submitted', $2) returning id`,
      [PID_A1, scheduleId],
    );
    await settle('workorder', wo!.id, 'done');
    const row = await one<{ last_completed_by: string | null }>(
      'select last_completed_by from preventive_tasks where id = $1', [scheduleId],
    );
    assert.ok(row?.last_completed_by, 'closing the ticket IS doing the job');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2b. A ticket that is over stays over
//
// The endings above were written with nothing between them and the row but
// "does this id exist at this hotel". The Staxis list is a poll, so a screen is
// routinely a minute or two behind the database, and every one of these is a
// tap somebody would make in complete good faith on a row they can still see.
// ═══════════════════════════════════════════════════════════════════════════

describe('a work order somebody has already settled', () => {
  /** Settle it one way, then try the other three from a screen that has not caught up. */
  async function settledThen(
    first: 'done' | 'not_an_issue',
    second: string,
    extra: Record<string, unknown> = {},
  ) {
    const id = await openWorkOrder();
    await settle('workorder', id, first);
    const before_ = await one<{ status: string; completed_by_name: string | null; notes: string | null }>(
      'select status, completed_by_name, notes from work_orders where id = $1', [id],
    );
    const res = await settle('workorder', id, second, extra);
    const after_ = await one<{ status: string; completed_by_name: string | null; notes: string | null }>(
      'select status, completed_by_name, notes from work_orders where id = $1', [id],
    );
    return { id, res, before_: before_!, after_: after_! };
  }

  test('cannot be put back on the list as waiting on parts', async () => {
    // The worst of the three: `deferred` is LIVE work, so this turns a ticket
    // somebody judged a non issue back into an open job on every screen at the
    // hotel, and overwrites the note that said why it was closed.
    const { res, after_ } = await settledThen('not_an_issue', 'waiting', {
      reason: 'compressor back ordered',
    });
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.match(String(res.body.error), /already answered/i);
    assert.equal(after_.status, 'closed', 'a settled ticket must not come back as live work');
  });

  test('cannot be re-filed as a repair that happened', async () => {
    const { res, after_ } = await settledThen('not_an_issue', 'done');
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.equal(after_.status, 'closed', 'closed and resolved are two words on purpose');
  });

  test('and a repair that DID happen cannot be rewritten as a non issue', async () => {
    const { res, before_, after_ } = await settledThen('done', 'not_an_issue');
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.equal(after_.status, 'resolved');
    assert.equal(
      after_.completed_by_name, before_.completed_by_name,
      'the person who actually fixed it keeps their name on it',
    );
  });

  test('and cannot stamp the upkeep schedule behind it as serviced', async () => {
    // The quietest loss of the four. A ticket raised from an upkeep schedule
    // carries `preventive_task_id`, and the 0366 trigger stamps that schedule
    // done the moment the ticket goes 'resolved'. A stale Done on a ticket
    // already closed as a non issue would therefore write a service nobody
    // performed into this hotel's maintenance record — and then Staxis stays
    // silent about that job for a full cadence.
    const scheduleId = await overdueSchedule('Elevator inspection', 90);
    const before_ = await one<{ last_completed_at: Date; last_completed_by: string | null }>(
      'select last_completed_at, last_completed_by from preventive_tasks where id = $1', [scheduleId],
    );
    const wo = await one<{ id: string }>(
      `insert into work_orders (property_id, description, severity, status, preventive_task_id)
       values ($1, 'Elevator inspection due', 'medium', 'submitted', $2) returning id`,
      [PID_A1, scheduleId],
    );
    await settle('workorder', wo!.id, 'not_an_issue');

    const res = await settle('workorder', wo!.id, 'done');
    assert.equal(res.status, 409, JSON.stringify(res.body));

    const after_ = await one<{ last_completed_at: Date; last_completed_by: string | null }>(
      'select last_completed_at, last_completed_by from preventive_tasks where id = $1', [scheduleId],
    );
    assert.equal(
      new Date(after_!.last_completed_at).getTime(),
      new Date(before_!.last_completed_at).getTime(),
      'a stale tap must never record a service that did not happen',
    );
    assert.equal(after_!.last_completed_by, before_!.last_completed_by);
  });

  test('but a ticket that is still live takes every ending it is offered', async () => {
    // The other side of the guard, so the tests above cannot pass by the whole
    // branch having been broken.
    for (const [outcome, extra, expected] of [
      ['waiting', { reason: 'part on order' }, 'deferred'],
      ['done', {}, 'resolved'],
      ['not_an_issue', {}, 'closed'],
    ] as const) {
      const id = await openWorkOrder();
      const res = await settle('workorder', id, outcome, extra);
      assert.equal(res.status, 200, `${outcome}: ${JSON.stringify(res.body)}`);
      const row = await one<{ status: string }>('select status from work_orders where id = $1', [id]);
      assert.equal(row?.status, expected);
    }
  });

  test('a deferred ticket is not settled: the note can be updated and the job still finished', async () => {
    // The guard must not have made 'deferred' behave like an ending. It is live
    // work with a sentence attached, and both the sentence changing ("now
    // waiting on the electrician") and the job finally getting done are things
    // that happen to a stalled ticket every week.
    const id = await openWorkOrder();
    await settle('workorder', id, 'waiting', { reason: 'compressor back ordered' });
    const again = await settle('workorder', id, 'waiting', { reason: 'now waiting on the electrician' });
    assert.equal(again.status, 200, JSON.stringify(again.body));
    const held = await one<{ notes: string | null }>('select notes from work_orders where id = $1', [id]);
    assert.equal(held?.notes, 'now waiting on the electrician');

    const done = await settle('workorder', id, 'done');
    assert.equal(done.status, 200, JSON.stringify(done.body));
    const row = await one<{ status: string }>('select status from work_orders where id = $1', [id]);
    assert.equal(row?.status, 'resolved');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. The menu is not the guard
// ═══════════════════════════════════════════════════════════════════════════

describe('the route refuses an ending the row was never offered', () => {
  test('a schedule cannot be told it is waiting on parts', async () => {
    const id = await overdueSchedule();
    const res = await settle('pm', id, 'waiting', { reason: 'a part' });
    assert.equal(res.status, 400);
    assert.match(String(res.body.error), /only a work order/i);
  });

  test('a work order cannot be told somebody was called, or skipped', async () => {
    const id = await openWorkOrder();
    for (const outcome of ['called', 'skip']) {
      const res = await settle('workorder', id, outcome);
      assert.equal(res.status, 400, outcome);
    }
    const row = await one<{ status: string }>('select status from work_orders where id = $1', [id]);
    assert.equal(row?.status, 'submitted');
  });

  test('a to-do cannot be told somebody was called', async () => {
    const task = await one<{ id: string }>(
      `insert into comms_tasks (property_id, title, status) values ($1, 'Chase the invoice', 'open') returning id`,
      [PID_A1],
    );
    const res = await settle('task', task!.id, 'called');
    assert.equal(res.status, 400);
    assert.match(String(res.body.error), /only an upkeep schedule/i);
  });

  test('an ending nobody has heard of is refused outright', async () => {
    const id = await openWorkOrder();
    const res = await settle('workorder', id, 'obliterate');
    assert.equal(res.status, 400);
  });

  test('a schedule at another hotel is not found, never acted on', async () => {
    // A foreign id is indistinguishable from a missing one: it 404s rather
    // than revealing that the id exists somewhere.
    const foreign = await overdueSchedule('Their boiler', 90, PID_B1);
    const res = await settle('pm', foreign, 'skip');
    assert.equal(res.status, 404, JSON.stringify(res.body));
    const row = await one<{ skipped_at: Date | null }>('select skipped_at from preventive_tasks where id = $1', [foreign]);
    assert.equal(row?.skipped_at, null);
  });

  test('and neither is a work order at another hotel', async () => {
    const foreign = await openWorkOrder('Their pool light', PID_B1);
    const res = await settle('workorder', foreign, 'not_an_issue');
    assert.equal(res.status, 404, JSON.stringify(res.body));
    const row = await one<{ status: string }>('select status from work_orders where id = $1', [foreign]);
    assert.equal(row?.status, 'submitted');
  });
});
