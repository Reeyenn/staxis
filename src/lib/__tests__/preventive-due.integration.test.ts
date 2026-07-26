/**
 * PROOF, against a real Postgres, that the upkeep loop actually closes.
 *
 * WHY NONE OF THIS CAN BE A UNIT TEST
 * The promises this feature makes to a hotel are database promises, and a fake
 * would only prove that this code MEANS to keep them:
 *
 *   • "closing the ticket marks the job done"  — an AFTER UPDATE trigger on
 *                                                work_orders (0366)
 *   • "and it can only move the date forward"  — that trigger's monotonic guard
 *   • "marking it done clears the follow-up"   — a BEFORE UPDATE trigger, so
 *                                                that EVERY writer inherits it
 *   • "Staxis declines if you already did it"  — a re-verify branch inside the
 *                                                same transaction as the write
 *   • "one hotel cannot touch another's"       — the property filter, on every
 *                                                read and write in the path
 *
 * So the real migrations are applied to PGlite, the PostgREST shim compiles the
 * real query builder into real SQL, and the real detector, the real feed loader,
 * the real runner and the real API routes run unmodified against two seeded
 * hotels — hotel B's rows deliberately reachable, every hotel-B uuid starting
 * `bbbbbbbb-`, so a forgotten filter has something to hit.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-min-20-chars';
process.env.CRON_SECRET ??= 'placeholder-cron-secret-min-16';
process.env.ANTHROPIC_API_KEY ??= 'sk-ant-placeholder';
process.env.DISABLE_SERVER_2FA_ENFORCEMENT = 'true';

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { NextRequest } from 'next/server';
import type { PGlite } from '@electric-sql/pglite';

import { supabaseAdmin } from '@/lib/supabase-admin';
import { GET as QUEUE_GET, POST as QUEUE_POST } from '@/app/api/findings/route';
import { POST as ACTIONS_POST } from '@/app/api/findings/actions/route';
import { GET as TARGET_GET } from '@/app/api/findings/for-target/route';
import { runFindingsForProperty } from '@/lib/findings/runner';
import { FOLLOW_UP_DAYS } from '@/lib/findings/detectors/preventive-due';

import { applyMigrationsToPglite } from '../../../tests/fixtures/pglite-migrate';
import {
  createPglitePostgrest,
  loadCatalog,
  type Catalog,
  type PglitePostgrest,
} from '../../../tests/fixtures/postgrest-pglite';
import { seedTwoHotels, PID_A, PID_B } from '../../../tests/fixtures/pglite-two-hotel-seed';

const GM_A_UID = 'aaaaaaaa-0000-4000-8000-0000000000f1';
const GM_B_UID = 'bbbbbbbb-0000-4000-8000-0000000000f1';
let currentUser: string | null = GM_A_UID;

let pg: PGlite;
let catalog: Catalog;
let shim: PglitePostgrest;

const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);
const originalRpc = supabaseAdmin.rpc.bind(supabaseAdmin);
const originalGetUser = supabaseAdmin.auth.getUser.bind(supabaseAdmin.auth);

const ONLY_PM = {
  detectorIds: ['preventive_due'] as const,
  skipJudge: true,
  skipDemotion: true,
};

// ─── Helpers ────────────────────────────────────────────────────────────────

const DAY = 86_400_000;

/** A schedule whose last-done sits `agoDays` in the past. */
async function addSchedule(
  propertyId: string,
  name: string,
  frequencyDays: number,
  lastDoneAgoDays: number | null,
  area = 'Building',
): Promise<string> {
  const r = await pg.query<{ id: string }>(
    `insert into public.preventive_tasks (property_id, name, area, frequency_days, last_completed_at)
     values ($1,$2,$3,$4,$5) returning id`,
    [
      propertyId,
      name,
      area,
      frequencyDays,
      lastDoneAgoDays === null ? null : new Date(Date.now() - lastDoneAgoDays * DAY).toISOString(),
    ],
  );
  return r.rows[0].id;
}

/**
 * One schedule's two dates, as comparable primitives.
 *
 * PGlite hands timestamps back as `Date` OBJECTS, and `assert.equal` on two
 * distinct Dates fails on reference equality even when they are the same
 * instant — which reads as "the date moved" when nothing moved at all. Every
 * "it must not have changed" assertion below depends on this normalisation, so
 * it happens once, here.
 */
async function scheduleRow(id: string) {
  const r = await pg.query<{
    last_completed_at: Date | string | null;
    last_completed_by: string | null;
    called_at: Date | string | null;
    called_by: string | null;
  }>(
    'select last_completed_at, last_completed_by, called_at, called_by from public.preventive_tasks where id = $1',
    [id],
  );
  const row = r.rows[0];
  if (!row) return null;
  const ms = (v: Date | string | null): number | null =>
    v === null ? null : new Date(v).getTime();
  return {
    lastDoneMs: ms(row.last_completed_at),
    lastDoneBy: row.last_completed_by,
    calledMs: ms(row.called_at),
    calledBy: row.called_by,
  };
}

async function findingsFor(propertyId: string) {
  const r = await pg.query<{
    id: string;
    dedupe_key: string;
    status: string;
    disposition: string;
    magnitude: number;
    summary: string;
    occurrence_count: number;
  }>(
    `select id, dedupe_key, status, disposition, magnitude, summary, occurrence_count
       from public.findings
      where property_id = $1 and detector_id = 'preventive_due'
      order by dedupe_key`,
    [propertyId],
  );
  return r.rows;
}

async function liveFindings(propertyId: string) {
  return (await findingsFor(propertyId)).filter(
    (f) => f.status === 'open' || f.status === 'updated',
  );
}

function req(url: string, body?: Record<string, unknown>): NextRequest {
  return new NextRequest(url, {
    method: body ? 'POST' : 'GET',
    headers: {
      authorization: 'Bearer preventive-route-test-token',
      'content-type': 'application/json',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

interface Envelope<T> {
  ok: boolean;
  error?: string;
  data?: T;
}

async function verdict(
  propertyId: string,
  findingId: string,
  action: string,
): Promise<{ status: number; body: Envelope<{ status: string; preventive?: { taskName: string } }> }> {
  const res = await QUEUE_POST(
    req('https://staxis.test/api/findings', { propertyId, findingId, action }),
  );
  return { status: res.status, body: (await res.json()) as Envelope<never> };
}

async function queueIds(propertyId: string): Promise<string[]> {
  const res = await QUEUE_GET(req(`https://staxis.test/api/findings?propertyId=${propertyId}`));
  const body = (await res.json()) as Envelope<{ findings: Array<{ id: string; detectorId: string }> }>;
  return (body.data?.findings ?? []).filter((f) => f.detectorId === 'preventive_due').map((f) => f.id);
}

async function chipIds(propertyId: string, taskId: string): Promise<string[]> {
  const res = await TARGET_GET(
    req(
      `https://staxis.test/api/findings/for-target?propertyId=${propertyId}&kind=preventive_task&value=${taskId}`,
    ),
  );
  const body = (await res.json()) as Envelope<{ findingIds: string[] }>;
  return body.data?.findingIds ?? [];
}

async function openActionFor(findingId: string): Promise<string | null> {
  const r = await pg.query<{ id: string }>(
    `select id from public.finding_actions where finding_id = $1 and state = 'proposed'`,
    [findingId],
  );
  return r.rows[0]?.id ?? null;
}

async function tap(propertyId: string, actionId: string) {
  const res = await ACTIONS_POST(
    req('https://staxis.test/api/findings/actions', { propertyId, actionId, intent: 'execute' }),
  );
  return {
    status: res.status,
    body: (await res.json()) as Envelope<{
      state: string;
      code: string;
      receipt: { id: string } | null;
      changed: { field: string } | null;
    }>,
  };
}

async function workOrdersForTask(taskId: string) {
  const r = await pg.query<{ id: string; status: string; room_number: string; description: string }>(
    'select id, status, room_number, description from public.work_orders where preventive_task_id = $1',
    [taskId],
  );
  return r.rows;
}

/** Close a ticket exactly the way the Maintenance board's markWorkOrderDone does. */
async function closeWorkOrder(id: string, byName = 'Luis'): Promise<void> {
  await pg.query(
    `update public.work_orders
        set status = 'resolved', completed_by_name = $2, resolved_at = now()
      where id = $1`,
    [id, byName],
  );
}

// ═══════════════════════════════════════════════════════════════════════════

describe('preventive maintenance, proven against a real database', () => {
  before(async () => {
    const migrated = await applyMigrationsToPglite();
    pg = migrated.pg;
    catalog = await loadCatalog(pg);
    await seedTwoHotels(pg, catalog);
    shim = createPglitePostgrest(pg, catalog);

    // @ts-expect-error installing the pglite-backed client on the singleton
    supabaseAdmin.from = shim.from;
    // @ts-expect-error installing the pglite-backed client on the singleton
    supabaseAdmin.rpc = shim.rpc;
    // @ts-expect-error minimal auth stub
    supabaseAdmin.auth.getUser = async () =>
      currentUser
        ? { data: { user: { id: currentUser, email: `${currentUser}@pm.test` } }, error: null }
        : {
            data: { user: null },
            error: { message: 'invalid token', status: 401, name: 'AuthApiError' },
          };

    for (const [uid, email] of [
      [GM_A_UID, 'gm.a@pm.test'],
      [GM_B_UID, 'gm.b@pm.test'],
    ] as const) {
      await pg.query('insert into auth.users (id, email) values ($1,$2) on conflict do nothing', [
        uid,
        email,
      ]);
    }
    await pg.query(
      `insert into public.accounts (username, display_name, role, property_access, data_user_id, password_hash)
       values ('pm.gm.a','Maria (GM)','general_manager',array[$1::uuid],$2,'x'),
              ('pm.gm.b','Bea (GM)','general_manager',array[$3::uuid],$4,'x')`,
      [PID_A, GM_A_UID, PID_B, GM_B_UID],
    );
  });

  after(async () => {
    supabaseAdmin.from = originalFrom;
    supabaseAdmin.rpc = originalRpc;
    supabaseAdmin.auth.getUser = originalGetUser;
    await pg?.close();
  });

  beforeEach(async () => {
    currentUser = GM_A_UID;
    await pg.query('delete from public.finding_actions');
    await pg.query('delete from public.findings');
    await pg.query('delete from public.finding_runs');
    await pg.query('delete from public.work_orders');
    await pg.query('delete from public.preventive_tasks');
  });

  // ─── the migration itself ────────────────────────────────────────────────

  describe('migration 0366 extended the table that already existed', () => {
    test('preventive_tasks grew the called columns rather than being replaced', async () => {
      const r = await pg.query<{ column_name: string }>(
        `select column_name from information_schema.columns
          where table_schema='public' and table_name='preventive_tasks'
            and column_name in ('called_at','called_by','last_completed_at','frequency_days')`,
      );
      assert.equal(r.rows.length, 4);
    });

    test('there is no second schedule table competing with it', async () => {
      const r = await pg.query<{ n: number }>(
        `select count(*)::int n from information_schema.tables
          where table_schema='public' and table_name in ('pm_schedules','upkeep_schedules')`,
      );
      assert.equal(r.rows[0].n, 0, 'a second upkeep list would be two lists that disagree');
    });

    test('a work order can name the schedule it came from', async () => {
      const r = await pg.query<{ n: number }>(
        `select count(*)::int n from information_schema.columns
          where table_schema='public' and table_name='work_orders'
            and column_name='preventive_task_id'`,
      );
      assert.equal(r.rows[0].n, 1);
    });
  });

  // ─── day zero ────────────────────────────────────────────────────────────

  describe('a hotel that has set nothing up', () => {
    test('gets no cards, and the run says WHY rather than implying all-clear', async () => {
      const summary = await runFindingsForProperty(PID_A, ONLY_PM);
      assert.deepEqual(await findingsFor(PID_A), []);
      assert.equal(summary.detectorsChecked, 0);
      assert.equal(summary.detectorsSkipped, 1);
      assert.match(summary.skipped[0].because, /has not put any upkeep jobs on a schedule/);
    });

    test('and the queue is empty rather than lying', async () => {
      await runFindingsForProperty(PID_A, ONLY_PM);
      assert.deepEqual(await queueIds(PID_A), []);
    });
  });

  // ─── due-ness, end to end ────────────────────────────────────────────────

  describe('counting forward from what the hotel typed in', () => {
    test('a schedule not yet due produces nothing', async () => {
      await addSchedule(PID_A, 'PTAC filter clean', 90, 10);
      await runFindingsForProperty(PID_A, ONLY_PM);
      assert.deepEqual(await findingsFor(PID_A), []);
    });

    test('a schedule past its date produces exactly one card, keyed on the task', async () => {
      const id = await addSchedule(PID_A, 'Water heater flush', 180, 200);
      await runFindingsForProperty(PID_A, ONLY_PM);
      const rows = await liveFindings(PID_A);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].dedupe_key, `preventive_due:task:${id}`);
      assert.equal(rows[0].disposition, 'propose');
      assert.match(rows[0].summary, /Water heater flush/);
    });

    test('a schedule nobody has ever done gets one card about the missing date, and no lateness claim', async () => {
      const id = await addSchedule(PID_A, 'Elevator inspection', 365, null);
      await runFindingsForProperty(PID_A, ONLY_PM);
      const rows = await liveFindings(PID_A);
      assert.equal(rows.length, 1, 'one unstarted schedule is one card, not silence and not a nag');
      assert.equal(rows[0].dedupe_key, `preventive_due:task:${id}:never_started`);
      assert.equal(rows[0].disposition, 'fyi');
      assert.equal(Number(rows[0].magnitude), 0);
      const severity = await pg.query<{ severity: string }>(
        'select severity from public.findings where id = $1',
        [rows[0].id],
      );
      assert.equal(severity.rows[0].severity, 'info', 'nothing here is urgent — nothing is even late');
      assert.doesNotMatch(rows[0].summary, /past due|overdue/i);
    });

    test('running twice UPDATES the one card instead of stacking a second', async () => {
      await addSchedule(PID_A, 'Water heater flush', 180, 200);
      await runFindingsForProperty(PID_A, ONLY_PM);
      await runFindingsForProperty(PID_A, ONLY_PM);
      await runFindingsForProperty(PID_A, ONLY_PM);
      const rows = await liveFindings(PID_A);
      assert.equal(rows.length, 1, 'one problem is one card, however many nights run');
      assert.equal(rows[0].occurrence_count, 3);
    });

    test('the card shows up in the queue AND on the schedule’s own record', async () => {
      const id = await addSchedule(PID_A, 'Water heater flush', 180, 200);
      await runFindingsForProperty(PID_A, ONLY_PM);
      const [findingId] = await queueIds(PID_A);
      assert.ok(findingId, 'the Staxis queue must carry the card');
      // The Maintenance-tab half: the chip on this schedule's own modal points
      // at the SAME card, rather than being a second copy of it.
      assert.deepEqual(await chipIds(PID_A, id), [findingId]);
    });
  });

  // ─── Done ────────────────────────────────────────────────────────────────

  describe('"Done" restarts the clock', () => {
    test('the schedule’s last-done moves to now and the card closes', async () => {
      const id = await addSchedule(PID_A, 'Water heater flush', 180, 200);
      await runFindingsForProperty(PID_A, ONLY_PM);
      const [findingId] = await queueIds(PID_A);

      const before = await scheduleRow(id);
      const { status, body } = await verdict(PID_A, findingId, 'pm_done');
      assert.equal(status, 200);
      assert.equal(body.ok, true);

      const after = await scheduleRow(id);
      assert.ok(
        after!.lastDoneMs! > before!.lastDoneMs!,
        'the clock must actually restart in the database',
      );
      assert.equal(after!.lastDoneBy, 'Maria (GM)');
      const rows = await findingsFor(PID_A);
      assert.equal(rows[0].status, 'resolved');
    });

    test('and the next night says nothing, because it is genuinely not due', async () => {
      await addSchedule(PID_A, 'Water heater flush', 180, 200);
      await runFindingsForProperty(PID_A, ONLY_PM);
      const [findingId] = await queueIds(PID_A);
      await verdict(PID_A, findingId, 'pm_done');

      await runFindingsForProperty(PID_A, ONLY_PM);
      assert.deepEqual(await liveFindings(PID_A), []);
    });
  });

  // ─── Somebody's been called ──────────────────────────────────────────────

  describe('"Somebody\'s been called" rests, then follows up', () => {
    test('it records the call WITHOUT pretending the job was done', async () => {
      const id = await addSchedule(PID_A, 'Water heater flush', 180, 200);
      await runFindingsForProperty(PID_A, ONLY_PM);
      const [findingId] = await queueIds(PID_A);
      const before = await scheduleRow(id);

      await verdict(PID_A, findingId, 'pm_called');

      const after = await scheduleRow(id);
      assert.ok(after!.calledMs, 'the call must be recorded');
      assert.equal(after!.calledBy, 'Maria (GM)');
      // THE ONE THAT WOULD HURT MOST IF WRONG: recording a phone call as a
      // completion would restart the clock on a job nobody has performed, and
      // Staxis would then stay silent about it for a full cadence.
      assert.equal(after!.lastDoneMs, before!.lastDoneMs);
    });

    test('the card goes quiet for the whole follow-up window', async () => {
      await addSchedule(PID_A, 'Water heater flush', 180, 200);
      await runFindingsForProperty(PID_A, ONLY_PM);
      const [findingId] = await queueIds(PID_A);
      await verdict(PID_A, findingId, 'pm_called');

      await runFindingsForProperty(PID_A, ONLY_PM);
      assert.deepEqual(await liveFindings(PID_A), [], 'a rested card must not come straight back');
    });

    test('and comes back asking once the window has passed', async () => {
      const id = await addSchedule(PID_A, 'Water heater flush', 180, 200);
      await runFindingsForProperty(PID_A, ONLY_PM);
      const [findingId] = await queueIds(PID_A);
      await verdict(PID_A, findingId, 'pm_called');

      // Time-travel the call itself rather than the clock: the same distance,
      // and it exercises the real column the detector reads.
      await pg.query('update public.preventive_tasks set called_at = $2 where id = $1', [
        id,
        new Date(Date.now() - (FOLLOW_UP_DAYS + 1) * DAY).toISOString(),
      ]);

      await runFindingsForProperty(PID_A, ONLY_PM);
      const rows = await liveFindings(PID_A);
      assert.equal(rows.length, 1);
      assert.match(rows[0].summary, /still has not been done/);
      // A STATEMENT. Ending this in a question mark made the judge sort the
      // card to `ask`, which routed it to a surface with no "Yes, it got done"
      // button — so the one tap that moves this schedule's date vanished.
      assert.doesNotMatch(rows[0].summary, /\?/);
      // A follow-up asks; it does not offer. Nobody should be dispatched twice.
      assert.equal(rows[0].disposition, 'recommend');
      assert.equal(await openActionFor(rows[0].id), null);
    });

    // ═══ A WEEKLY TAP MUST NOT BE A PERMANENT INVISIBLE MUTE ═══
    //
    // "Somebody's been called" closes the card and the follow-up opens a NEW
    // row a week later. That row used to carry a fresh `first_seen_at`, and
    // every aging rule the company screen has — how long has this been true —
    // measures from exactly that column. So a manager who tapped the reminder
    // once a week could keep a year-old overdue job permanently under the climb
    // bar without ever muting anything, and nothing on any screen said so.
    //
    // MUTATION PROOF: drop `occurrenceMarker: 'due_on'` from the declaration (or
    // the carry-forward in store.ts) and the second row's first_seen_at is the
    // day of the follow-up rather than the day Staxis first saw the problem.
    test('a deferral does not restart the clock the company measures from', async () => {
      const id = await addSchedule(PID_A, 'Water heater flush', 180, 200);
      await runFindingsForProperty(PID_A, ONLY_PM);
      const [findingId] = await queueIds(PID_A);
      const firstRow = await pg.query<{ first_seen_at: string; dedupe_key: string }>(
        'select first_seen_at, dedupe_key from public.findings where id = $1',
        [findingId],
      );
      const originally = firstRow.rows[0].first_seen_at;

      // Backdate the first sighting: a real card would have been standing for a
      // fortnight before anybody tapped anything.
      await pg.query(
        `update public.findings set first_seen_at = now() - interval '14 days' where id = $1`,
        [findingId],
      );
      await verdict(PID_A, findingId, 'pm_called');

      await pg.query('update public.preventive_tasks set called_at = $2 where id = $1', [
        id,
        new Date(Date.now() - (FOLLOW_UP_DAYS + 1) * DAY).toISOString(),
      ]);
      await runFindingsForProperty(PID_A, ONLY_PM);

      const rows = await liveFindings(PID_A);
      assert.equal(rows.length, 1, 'the follow-up is one card');
      const followUp = await pg.query<{ first_seen_at: string }>(
        'select first_seen_at from public.findings where id = $1',
        [rows[0].id],
      );
      const ageDays =
        (Date.now() - Date.parse(followUp.rows[0].first_seen_at)) / 86_400_000;
      assert.ok(
        ageDays > 13,
        `the follow-up must keep the original clock; it read ${ageDays.toFixed(1)} days old`,
      );
      assert.notEqual(followUp.rows[0].first_seen_at, originally, 'sanity: the backdate applied');
    });

    test('a completed cycle DOES start a fresh clock — carrying it forward would libel the hotel', async () => {
      const id = await addSchedule(PID_A, 'Water heater flush', 180, 200);
      await runFindingsForProperty(PID_A, ONLY_PM);
      const [findingId] = await queueIds(PID_A);
      await pg.query(
        `update public.findings set first_seen_at = now() - interval '30 days' where id = $1`,
        [findingId],
      );
      // The job was actually done, which moves the due date — a different
      // occurrence of the problem, whenever it next comes round.
      await verdict(PID_A, findingId, 'pm_done');
      // 190 days, not the original 200: the completion moved the due date, which
      // is exactly what tells a finished cycle apart from a deferred one.
      await pg.query(
        `update public.preventive_tasks
            set last_completed_at = now() - interval '190 days' where id = $1`,
        [id],
      );

      await runFindingsForProperty(PID_A, ONLY_PM);
      const rows = await liveFindings(PID_A);
      assert.equal(rows.length, 1);
      const fresh = await pg.query<{ first_seen_at: string }>(
        'select first_seen_at from public.findings where id = $1',
        [rows[0].id],
      );
      const ageDays = (Date.now() - Date.parse(fresh.rows[0].first_seen_at)) / 86_400_000;
      assert.ok(ageDays < 1, `a new cycle starts today, not ${ageDays.toFixed(1)} days ago`);
    });

    test('answering the follow-up "yes it got done" restarts the clock and clears the call', async () => {
      const id = await addSchedule(PID_A, 'Water heater flush', 180, 200);
      await runFindingsForProperty(PID_A, ONLY_PM);
      let [findingId] = await queueIds(PID_A);
      await verdict(PID_A, findingId, 'pm_called');
      await pg.query('update public.preventive_tasks set called_at = $2 where id = $1', [
        id,
        new Date(Date.now() - (FOLLOW_UP_DAYS + 1) * DAY).toISOString(),
      ]);
      await runFindingsForProperty(PID_A, ONLY_PM);
      [findingId] = await queueIds(PID_A);

      await verdict(PID_A, findingId, 'pm_done');

      const row = await scheduleRow(id);
      assert.equal(row!.calledMs, null, 'a finished job has nothing left to follow up');
      assert.ok(Date.now() - row!.lastDoneMs! < 5 * 60_000);
    });
  });

  // ─── the loop closure ────────────────────────────────────────────────────

  describe('closing the work order Staxis raised also marks the upkeep done', () => {
    /** Due schedule → run → tap the offer → the ticket that came out of it. */
    async function raiseTicket(): Promise<{ taskId: string; workOrderId: string }> {
      const taskId = await addSchedule(PID_A, 'Water heater flush', 180, 200);
      await runFindingsForProperty(PID_A, ONLY_PM);
      const [findingId] = await queueIds(PID_A);
      const actionId = await openActionFor(findingId);
      assert.ok(actionId, 'a due card must arrive with the fix attached');
      const { body } = await tap(PID_A, actionId!);
      assert.equal(body.data?.code, 'executed');
      const tickets = await workOrdersForTask(taskId);
      assert.equal(tickets.length, 1, 'the ticket must carry the link back to its schedule');
      return { taskId, workOrderId: tickets[0].id };
    }

    test('one tap puts a linked ticket on the board', async () => {
      const { taskId } = await raiseTicket();
      const [ticket] = await workOrdersForTask(taskId);
      assert.equal(ticket.status, 'submitted');
      assert.match(ticket.description, /Water heater flush/);
      assert.match(ticket.description, /preventive maintenance/);
    });

    test('THE LOOP: closing that ticket stamps the schedule done, with nobody asked twice', async () => {
      const { taskId, workOrderId } = await raiseTicket();
      const before = await scheduleRow(taskId);

      await closeWorkOrder(workOrderId, 'Luis');

      const after = await scheduleRow(taskId);
      assert.ok(
        after!.lastDoneMs! > before!.lastDoneMs!,
        'closing the ticket IS doing the job — the schedule must move',
      );
      assert.equal(after!.lastDoneBy, 'Luis');
    });

    test('and the schedule then reads as not due, so no card comes back', async () => {
      const { workOrderId } = await raiseTicket();
      await closeWorkOrder(workOrderId);
      await pg.query(`update public.findings set status='resolved' where status in ('open','updated')`);
      await runFindingsForProperty(PID_A, ONLY_PM);
      assert.deepEqual(await liveFindings(PID_A), []);
    });

    test('an ordinary work order touches no schedule at all', async () => {
      const taskId = await addSchedule(PID_A, 'Water heater flush', 180, 200);
      const before = await scheduleRow(taskId);
      const r = await pg.query<{ id: string }>(
        `insert into public.work_orders (property_id, room_number, description, severity, status)
         values ($1,'Room 214','broken tap','medium','submitted') returning id`,
        [PID_A],
      );
      await closeWorkOrder(r.rows[0].id);
      const after = await scheduleRow(taskId);
      assert.equal(after!.lastDoneMs, before!.lastDoneMs);
    });

    test('the stamp only ever moves the date FORWARD', async () => {
      // A manager taps Done today, then closes a linked ticket that was resolved
      // with an older timestamp. Dragging last-done backwards would make a
      // current schedule report as overdue again.
      const { taskId, workOrderId } = await raiseTicket();
      await pg.query(
        'update public.preventive_tasks set last_completed_at = now() where id = $1',
        [taskId],
      );
      const current = await scheduleRow(taskId);

      await pg.query(
        `update public.work_orders
            set status='resolved', resolved_at = now() - interval '30 days', completed_by_name='Old'
          where id = $1`,
        [workOrderId],
      );

      const after = await scheduleRow(taskId);
      assert.equal(after!.lastDoneMs, current!.lastDoneMs);
      assert.notEqual(after!.lastDoneBy, 'Old');
    });

    test('re-saving an already-closed ticket does not re-stamp anything', async () => {
      const { taskId, workOrderId } = await raiseTicket();
      await closeWorkOrder(workOrderId);
      const first = await scheduleRow(taskId);
      await pg.query(`update public.work_orders set notes='tidying up' where id=$1`, [workOrderId]);
      await pg.query(`update public.work_orders set status='resolved' where id=$1`, [workOrderId]);
      const second = await scheduleRow(taskId);
      assert.equal(second!.lastDoneMs, first!.lastDoneMs);
    });

    test('marking an upkeep task done from ANYWHERE clears a pending call', async () => {
      // The trigger exists so the Preventive tab's own "Done today" — which
      // writes through the browser client and knows nothing about called_at —
      // cannot leave a stale flag that suppresses the next cycle.
      const taskId = await addSchedule(PID_A, 'Water heater flush', 180, 200);
      await pg.query(
        `update public.preventive_tasks set called_at = now(), called_by = 'Dana' where id = $1`,
        [taskId],
      );
      await pg.query(
        'update public.preventive_tasks set last_completed_at = now() where id = $1',
        [taskId],
      );
      const row = await scheduleRow(taskId);
      assert.equal(row!.calledMs, null);
      assert.equal(row!.calledBy, null);
    });
  });

  // ─── re-verification ─────────────────────────────────────────────────────

  describe('Staxis declines when the job was done between the offer and the tap', () => {
    test('it refuses, explains, and writes no ticket', async () => {
      const taskId = await addSchedule(PID_A, 'Water heater flush', 180, 200);
      await runFindingsForProperty(PID_A, ONLY_PM);
      const [findingId] = await queueIds(PID_A);
      const actionId = await openActionFor(findingId);

      // Somebody marks it done in the Preventive tab while the card is open.
      await pg.query(
        'update public.preventive_tasks set last_completed_at = now() where id = $1',
        [taskId],
      );

      const { body } = await tap(PID_A, actionId!);
      assert.equal(body.data?.code, 'declined_changed');
      assert.equal(body.data?.changed?.field, 'preventive_last_done');
      assert.deepEqual(await workOrdersForTask(taskId), []);
    });

    test('and refuses when the schedule has been deleted outright', async () => {
      const taskId = await addSchedule(PID_A, 'Water heater flush', 180, 200);
      await runFindingsForProperty(PID_A, ONLY_PM);
      const [findingId] = await queueIds(PID_A);
      const actionId = await openActionFor(findingId);

      await pg.query('delete from public.preventive_tasks where id = $1', [taskId]);

      const { body } = await tap(PID_A, actionId!);
      assert.equal(body.data?.code, 'declined_changed');
      assert.equal(body.data?.changed?.field, 'preventive_task');
    });
  });

  // ─── the wall ────────────────────────────────────────────────────────────

  describe('one hotel cannot reach another hotel’s upkeep', () => {
    test('two hotels with identical schedules get their own cards, and only their own', async () => {
      await addSchedule(PID_A, 'Water heater flush', 180, 200);
      await addSchedule(PID_B, 'Water heater flush', 180, 200);
      await runFindingsForProperty(PID_A, ONLY_PM);
      await runFindingsForProperty(PID_B, ONLY_PM);

      assert.equal((await liveFindings(PID_A)).length, 1);
      assert.equal((await liveFindings(PID_B)).length, 1);
      const a = await queueIds(PID_A);
      assert.equal(a.length, 1);

      // Hotel B's own manager still gets hotel B's card — the isolation must be
      // a wall, not a broken read that shows nobody anything.
      currentUser = GM_B_UID;
      assert.equal((await queueIds(PID_B)).length, 1);
    });

    test('a manager cannot mark another hotel’s upkeep done', async () => {
      const taskB = await addSchedule(PID_B, 'Water heater flush', 180, 200);
      await runFindingsForProperty(PID_B, ONLY_PM);
      const bFindings = await liveFindings(PID_B);
      const before = await scheduleRow(taskB);

      // Hotel A's GM, naming hotel B's finding — with hotel A's id (the gate
      // they legitimately hold) and then with hotel B's (which they do not).
      const wrongPid = await verdict(PID_A, bFindings[0].id, 'pm_done');
      assert.equal(wrongPid.status, 404);
      const foreignPid = await verdict(PID_B, bFindings[0].id, 'pm_done');
      assert.equal(foreignPid.status, 403);

      const after = await scheduleRow(taskB);
      assert.equal(after!.lastDoneMs, before!.lastDoneMs);
      assert.equal(after!.calledMs, null);
    });

    test('and cannot see another hotel’s chip for an id it already knows', async () => {
      const taskB = await addSchedule(PID_B, 'Water heater flush', 180, 200);
      await runFindingsForProperty(PID_B, ONLY_PM);
      assert.deepEqual(await chipIds(PID_A, taskB), []);
    });
  });

  // ─── the door ────────────────────────────────────────────────────────────

  describe('the route refuses what it should refuse', () => {
    test('no session at all', async () => {
      await addSchedule(PID_A, 'Water heater flush', 180, 200);
      await runFindingsForProperty(PID_A, ONLY_PM);
      const [findingId] = await queueIds(PID_A);
      currentUser = null;
      const { status } = await verdict(PID_A, findingId, 'pm_done');
      assert.equal(status, 401);
    });

    test('a malformed id never reaches the database', async () => {
      const { status } = await verdict(PID_A, 'not-a-uuid', 'pm_done');
      assert.equal(status, 400);
    });

    test('an unknown verdict is refused rather than guessed at', async () => {
      const { status } = await verdict(PID_A, '11111111-1111-4111-8111-111111111111', 'pm_maybe');
      assert.equal(status, 400);
    });

    test('a card that is not about an upkeep schedule cannot steer a schedule write', async () => {
      // The detector check in logPreventiveOutcome: evidence is a jsonb blob, so
      // without it a finding from another detector whose target happened to be
      // uuid-shaped could aim at a preventive_tasks row.
      const taskId = await addSchedule(PID_A, 'Water heater flush', 180, 200);
      const r = await pg.query<{ id: string }>(
        `insert into public.findings
           (property_id, detector_id, dedupe_key, summary, severity, disposition, status,
            receipt_query_id, evidence, magnitude)
         values ($1,'room_needs_attention','imposter','not about upkeep','attention','propose',
                 'open','probe', jsonb_build_object('target',
                   jsonb_build_object('kind','preventive_task','value',$2::text)), 1)
         returning id`,
        [PID_A, taskId],
      );
      const before = await scheduleRow(taskId);

      const { status } = await verdict(PID_A, r.rows[0].id, 'pm_done');
      assert.equal(status, 400);
      const after = await scheduleRow(taskId);
      assert.equal(after!.lastDoneMs, before!.lastDoneMs);
    });
  });
});
