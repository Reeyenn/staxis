/**
 * The reshape invariants, exercised against the REAL migrations in PGlite.
 *
 * Migrations 0354/0355/0356 are almost entirely enforcement: CHECKs, foreign
 * keys, a trigger and a physical column split whose whole job is to make a
 * class of write impossible. A unit test with a mocked Supabase client cannot
 * show that — only a database can. So this file applies the production
 * migrations and then tries to do each forbidden thing.
 *
 * PGLITE PREREQUISITES. The runner skips 0212 (needs storage.buckets), which
 * takes public.inspections and public.inspection_checklists with it, and 0340
 * (storage.buckets) and 0342 (extensions schema). Their artefacts are stubbed
 * below before the migrations that depend on them. Everything under test is
 * still the real 0354/0355/0356 SQL — if a stub drifts from the real thing,
 * the migration fails to apply and the `before` hook below says so loudly.
 */

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { PGlite } from '@electric-sql/pglite';
import { applyMigrationsToPgliteWithHook } from '../../../tests/fixtures/pglite-migrate';

const OWNER = '91000000-0000-4000-8000-000000000001';
const PROP = '92000000-0000-4000-8000-000000000001';
const PROP_B = '92000000-0000-4000-8000-000000000002';
const MARIA = '93000000-0000-4000-8000-000000000001';
const OTHER_HOTEL_STAFF = '93000000-0000-4000-8000-000000000002';

/** The 0340 half 0341/0343 depend on. */
const INGEST_STUB = `
  create table if not exists public.pms_report_files (
    id uuid primary key default gen_random_uuid(),
    property_id uuid not null references public.properties(id) on delete cascade,
    report_kind text,
    created_at timestamptz not null default now()
  );
  create table if not exists public.pms_ingest_runs (
    id uuid primary key default gen_random_uuid(),
    property_id uuid not null references public.properties(id) on delete cascade,
    report_file_id uuid references public.pms_report_files(id) on delete set null,
    source_kind text not null default 'legacy',
    mode text not null default 'live',
    parser_name text,
    parser_version text,
    source_captured_at timestamptz,
    started_at timestamptz not null default now(),
    finished_at timestamptz,
    status text not null default 'succeeded'
  );
`;

/** The 0342 half 0343's registry trigger depends on. */
const APPEND_UNIQUE_STUB = `
  create unique index if not exists pms_room_status_log_natural_uidx
    on public.pms_room_status_log (property_id, room_number, changed_at);
  create unique index if not exists pms_activity_log_natural_uidx
    on public.pms_activity_log (property_id, captured_at, pms_user, action) nulls not distinct;
`;

/**
 * The 0212 half 0225/0271/0355 depend on. complete_inspection_atomic RETURNS
 * public.inspections, so the type has to exist for the function to compile.
 * Column list copied from 0212; the FK to inspection_checklists is dropped
 * because 0247 (which creates it) is skipped too.
 */
const INSPECTIONS_STUB = `
  create table if not exists public.inspections (
    id uuid primary key default gen_random_uuid(),
    property_id uuid not null references public.properties(id) on delete cascade,
    room_number text not null,
    room_id uuid,
    cleaning_task_id uuid,
    checklist_id uuid,
    inspector_staff_id uuid,
    housekeeper_staff_id uuid,
    started_at timestamptz not null default now(),
    completed_at timestamptz,
    result text not null default 'in_progress'
      check (result in ('in_progress','pass','fail','cancelled')),
    failed_items jsonb not null default '[]'::jsonb,
    passed_items jsonb not null default '[]'::jsonb,
    correction_notice_sent_at timestamptz,
    recheck_inspection_id uuid references public.inspections(id) on delete set null,
    parent_inspection_id uuid references public.inspections(id) on delete set null,
    notes text,
    escalated boolean not null default false,
    escalation_reason text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  );
`;

let pg: PGlite;
let runId: string;
let laterRunId: string;

async function scalar<T>(sql: string, params: unknown[] = []): Promise<T> {
  const result = (await pg.query(sql, params)) as { rows: Array<Record<string, unknown>> };
  return Object.values(result.rows[0] ?? {})[0] as T;
}

async function rows<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const result = (await pg.query(sql, params)) as { rows: T[] };
  return result.rows;
}

/** Assert a statement fails, and return the message so the test can pin WHY. */
async function failsWith(sql: string, params: unknown[] = []): Promise<string> {
  try {
    await pg.query(sql, params);
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  assert.fail(`expected this to be rejected but it succeeded: ${sql}`);
}

/** Insert a reservation and return its id. */
async function seedReservation(
  pmsId: string,
  extra: Record<string, string | number | null> = {},
): Promise<string> {
  const cols = ['property_id', 'pms_reservation_id', 'ingest_run_id', ...Object.keys(extra)];
  const vals = [PROP, pmsId, runId, ...Object.values(extra)];
  const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
  return scalar<string>(
    `insert into public.pms_reservations (${cols.join(', ')}) values (${placeholders}) returning id`,
    vals,
  );
}

describe('pms reshape — migrations 0354 / 0355 / 0356', () => {
  before(async () => {
    const migrated = await applyMigrationsToPgliteWithHook(async ({ pg: db, file }) => {
      // A migration wrapped in an explicit `begin;` that fails leaves the
      // session in an aborted transaction and poisons everything after it.
      await db.exec('rollback;').catch(() => undefined);
      if (file.startsWith('0225_')) await db.exec(INSPECTIONS_STUB);
      if (file.startsWith('0341_')) await db.exec(INGEST_STUB);
      if (file.startsWith('0343_')) await db.exec(APPEND_UNIQUE_STUB);
    });
    pg = migrated.pg;

    for (const version of [
      '0354_reservation_lifecycle_consolidation.sql',
      '0355_housekeeping_mirror_state_split.sql',
      '0356_canonical_dimensions.sql',
    ]) {
      assert.ok(
        migrated.report.applied.includes(version),
        `${version} must apply: ${JSON.stringify(
          migrated.report.failedAtRuntime.filter((e) => e.file.startsWith('035')),
        )}`,
      );
    }

    await pg.query(
      `insert into auth.users(id, email) values ($1, 'reshape@example.test') on conflict (id) do nothing`,
      [OWNER],
    );
    await pg.query(
      `insert into public.properties(id, owner_id, name, total_rooms, timezone)
       values ($1, $3, 'Reshape Inn', 60, 'America/Chicago'),
              ($2, $3, 'Other Inn', 20, 'America/Chicago')
       on conflict (id) do nothing`,
      [PROP, PROP_B, OWNER],
    );
    await pg.query(
      `insert into public.staff(id, property_id, name, is_active)
       values ($1, $3, 'Maria Garcia', true),
              ($2, $4, 'Someone Else', true)
       on conflict (id) do nothing`,
      [MARIA, OTHER_HOTEL_STAFF, PROP, PROP_B],
    );
    runId = await scalar<string>(
      `insert into public.pms_ingest_runs(property_id, source_kind, mode, source_captured_at, finished_at)
       values ($1, 'report_email', 'live', now() - interval '2 hours', now()) returning id`,
      [PROP],
    );
    laterRunId = await scalar<string>(
      `insert into public.pms_ingest_runs(property_id, source_kind, mode, source_captured_at, finished_at)
       values ($1, 'report_email', 'live', now(), now()) returning id`,
      [PROP],
    );
  });

  after(async () => {
    await pg.close();
  });

  // ─── 0354 — one reservation, one row ─────────────────────────────────────

  describe('a booking exists exactly once', () => {
    test('the satellite tables are gone, so a booking cannot live in three places', async () => {
      const survivors = await rows<{ relname: string }>(
        `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relname in ('pms_no_shows', 'pms_cancellations', 'pms_future_bookings')`,
      );
      assert.deepEqual(survivors, []);
    });

    test('the writer registry no longer names them either', async () => {
      const left = await rows(
        `select table_name from public.pms_table_schemas
          where table_name in ('pms_no_shows', 'pms_cancellations', 'pms_future_bookings')`,
      );
      assert.deepEqual(left, []);
      const violations = await rows(`select * from public.staxis_pms_registry_violations()`);
      assert.deepEqual(violations, [], 'the registry must still match the physical schema');
    });

    test('the cancellations report can land its columns — they are on the descriptor', async () => {
      const declared = await rows<{ name: string }>(
        `select c ->> 'name' as name
           from public.pms_table_schemas t, jsonb_array_elements(t.columns) c
          where t.table_name = 'pms_reservations'`,
      );
      const names = declared.map((d) => d.name);
      for (const c of ['cancelled_date', 'cancellation_fee_cents', 'cancellation_reason', 'no_show_date', 'booked_at']) {
        assert.ok(names.includes(c), `descriptor must declare ${c} or the report cannot write it`);
      }
    });

    test('nights are computed from the reservation\'s own dates, not trusted from the PMS', async () => {
      await seedReservation('R-NIGHTS', {
        arrival_date: '2026-08-01',
        departure_date: '2026-08-04',
        num_nights: 99, // the PMS lying
      });
      const derived = await scalar<number>(
        `select nights_derived from public.pms_reservations where pms_reservation_id = 'R-NIGHTS'`,
      );
      assert.equal(Number(derived), 3);
    });
  });

  describe('the lifecycle cannot contradict itself', () => {
    test('"cancelled" without a cancellation date is not storable', async () => {
      const msg = await failsWith(
        `insert into public.pms_reservations (property_id, pms_reservation_id, ingest_run_id, status)
         values ($1, 'R-BAD-CANCEL', $2, 'cancelled')`,
        [PROP, runId],
      );
      assert.match(msg, /pms_res_cancel_coherent/i);
    });

    test('a cancellation date on a live booking is not storable either', async () => {
      const msg = await failsWith(
        `insert into public.pms_reservations (property_id, pms_reservation_id, ingest_run_id, status, cancelled_date)
         values ($1, 'R-BAD-CANCEL-2', $2, 'booked', '2026-08-01')`,
        [PROP, runId],
      );
      assert.match(msg, /pms_res_cancel_coherent/i);
    });

    test('"no_show" and no_show_date move together', async () => {
      const msg = await failsWith(
        `insert into public.pms_reservations (property_id, pms_reservation_id, ingest_run_id, status)
         values ($1, 'R-BAD-NOSHOW', $2, 'no_show')`,
        [PROP, runId],
      );
      assert.match(msg, /pms_res_noshow_coherent/i);
    });

    test('a cancellation fee cannot be charged on a booking that was never cancelled', async () => {
      const msg = await failsWith(
        `insert into public.pms_reservations (property_id, pms_reservation_id, ingest_run_id, status, cancellation_fee_cents)
         values ($1, 'R-BAD-FEE', $2, 'booked', 5000)`,
        [PROP, runId],
      );
      assert.match(msg, /pms_res_fee_requires_cancel/i);
    });

    test('a stay cannot end before it starts', async () => {
      const msg = await failsWith(
        `insert into public.pms_reservations (property_id, pms_reservation_id, ingest_run_id, arrival_date, departure_date)
         values ($1, 'R-BACKWARDS', $2, '2026-08-10', '2026-08-04')`,
        [PROP, runId],
      );
      assert.match(msg, /pms_res_date_order/i);
    });

    test('a booking cannot have been made after the guest arrived', async () => {
      const msg = await failsWith(
        `insert into public.pms_reservations (property_id, pms_reservation_id, ingest_run_id, arrival_date, booked_at)
         values ($1, 'R-TIME-TRAVEL', $2, '2026-08-01', '2026-08-05')`,
        [PROP, runId],
      );
      assert.match(msg, /pms_res_booked_before_arrival/i);
    });

    test('a reservation with no status at all is still storable — the PMS may not print one', async () => {
      const id = await seedReservation('R-NO-STATUS', { arrival_date: '2026-09-01', departure_date: '2026-09-02' });
      assert.ok(id, 'a null status must not be blocked by the coherence CHECKs');
    });
  });

  describe('a stale report cannot un-cancel a booking', () => {
    test('re-listing a cancelled guest on the arrivals report leaves them cancelled', async () => {
      await seedReservation('R-CANCELLED', {
        guest_name: 'Dana Cancel',
        arrival_date: '2026-08-20',
        departure_date: '2026-08-22',
        status: 'cancelled',
        cancelled_date: '2026-08-15',
        status_changed_at: '2026-08-15T12:00:00Z',
      });

      // The arrivals report, generated before the cancellation was entered,
      // arrives afterwards and still lists the guest as booked.
      await pg.query(
        `update public.pms_reservations
            set status = 'booked', cancelled_date = null, guest_name = 'Dana Cancel-Smith',
                status_changed_at = '2026-08-14T09:00:00Z', ingest_run_id = $2
          where property_id = $1 and pms_reservation_id = 'R-CANCELLED'`,
        [PROP, laterRunId],
      );

      const after = await rows<{ status: string; cancelled_date: string | null; guest_name: string }>(
        `select status, cancelled_date::text as cancelled_date, guest_name
           from public.pms_reservations where pms_reservation_id = 'R-CANCELLED'`,
      );
      assert.equal(after[0].status, 'cancelled', 'the booking must still be cancelled');
      assert.equal(after[0].cancelled_date, '2026-08-15', 'the cancellation evidence must survive');
      assert.equal(
        after[0].guest_name,
        'Dana Cancel-Smith',
        'every OTHER column still updates — the guard protects the lifecycle, not the whole row',
      );
    });

    test('a genuinely newer status change does get through — a guest can rebook', async () => {
      await seedReservation('R-REBOOKED', {
        arrival_date: '2026-08-20',
        departure_date: '2026-08-22',
        status: 'cancelled',
        cancelled_date: '2026-08-15',
        status_changed_at: '2026-08-15T12:00:00Z',
      });
      await pg.query(
        `update public.pms_reservations
            set status = 'booked', cancelled_date = null, status_changed_at = '2026-08-16T08:00:00Z'
          where property_id = $1 and pms_reservation_id = 'R-REBOOKED'`,
        [PROP],
      );
      const after = await rows<{ status: string }>(
        `select status from public.pms_reservations where pms_reservation_id = 'R-REBOOKED'`,
      );
      assert.equal(after[0].status, 'booked');
    });

    test('checked_out does not silently reopen either', async () => {
      await seedReservation('R-DEPARTED', {
        arrival_date: '2026-08-01',
        departure_date: '2026-08-03',
        status: 'checked_out',
        status_changed_at: '2026-08-03T11:00:00Z',
      });
      await pg.query(
        `update public.pms_reservations set status = 'checked_in'
          where property_id = $1 and pms_reservation_id = 'R-DEPARTED'`,
        [PROP],
      );
      assert.equal(
        await scalar<string>(
          `select status from public.pms_reservations where pms_reservation_id = 'R-DEPARTED'`,
        ),
        'checked_out',
      );
    });
  });

  // ─── 0355 — two masters, two tables ──────────────────────────────────────

  describe('a report cannot overwrite a housekeeper', () => {
    test('the app-owned columns are simply not on the table the ingest writes', async () => {
      const leftover = await rows<{ column_name: string }>(
        `select column_name from information_schema.columns
          where table_schema = 'public' and table_name = 'pms_housekeeping_assignments'
            and column_name in ('status','started_at','completed_at','is_paused','paused_at',
                                'total_paused_seconds','checklist_progress','checklist_template_id',
                                'exception_type','exception_note','exception_at','manager_notes',
                                'housekeeper_note','is_rush','rush_due_by','marked_for_inspection_at',
                                'inspected_by','inspected_at','issue_note','help_requested','dnd_note',
                                'time_spent_minutes','manager_notes_at','housekeeper_note_at',
                                'rush_set_at','rush_set_by','rush_requested_by_account_id',
                                'rush_duration_label')`,
      );
      assert.deepEqual(leftover, [], 'these belong to Staxis and must live on room_work');
    });

    test('the mirror keeps exactly what the PMS report tells us', async () => {
      for (const col of ['housekeeper_name', 'cleaning_type', 'dnd_active', 'scheduled_time', 'notes', 'ingest_run_id']) {
        const present = await scalar<number>(
          `select count(*) from information_schema.columns
            where table_schema='public' and table_name='pms_housekeeping_assignments' and column_name=$1`,
          [col],
        );
        assert.equal(Number(present), 1, `${col} is report data and must stay on the mirror`);
      }
    });

    test('a report landing mid-clean leaves the clean untouched', async () => {
      // The housekeeper started at 09:00 and has ticked two checklist items.
      await pg.query(
        `insert into public.room_work (property_id, date, room_number, status, started_at, checklist_progress)
         values ($1, '2026-08-05', '204', 'in_progress', '2026-08-05T09:00:00Z', array['bed','bath'])`,
        [PROP],
      );
      // The 09:30 housekeeping report arrives and says the room is assigned to
      // someone and is a departure clean.
      await pg.query(
        `insert into public.pms_housekeeping_assignments
           (property_id, date, room_number, housekeeper_name, cleaning_type, dnd_active, ingest_run_id)
         values ($1, '2026-08-05', '204', 'Maria Garcia', 'departure', false, $2)
         on conflict (property_id, date, room_number) do update
           set housekeeper_name = excluded.housekeeper_name,
               cleaning_type = excluded.cleaning_type`,
        [PROP, runId],
      );

      const work = await rows<{ status: string; checklist_progress: string[] }>(
        `select status, checklist_progress from public.room_work
          where property_id = $1 and date = '2026-08-05' and room_number = '204'`,
        [PROP],
      );
      assert.equal(work[0].status, 'in_progress', 'the clean must still be in progress');
      assert.deepEqual(work[0].checklist_progress, ['bed', 'bath'], 'the ticked items must survive');
    });

    test('the app can record work without inventing a report receipt', async () => {
      // This is the failure 0341 created and the split fixes: pms_* rows carry
      // a NOT NULL ingest_run_id, and a housekeeper tapping Start has no report
      // to cite. room_work has no such column, on purpose.
      const hasRunId = await scalar<number>(
        `select count(*) from information_schema.columns
          where table_schema='public' and table_name='room_work' and column_name='ingest_run_id'`,
      );
      assert.equal(Number(hasRunId), 0, 'room_work must not require a report receipt');

      await pg.query(
        `insert into public.room_work (property_id, date, room_number, status, started_at)
         values ($1, '2026-08-06', '301', 'in_progress', now())`,
        [PROP],
      );
      assert.equal(
        Number(await scalar(`select count(*) from public.room_work where room_number = '301'`)),
        1,
      );
    });

    test('an app write to the mirror still fails — it has no receipt to give', async () => {
      const msg = await failsWith(
        `insert into public.pms_housekeeping_assignments (property_id, date, room_number, housekeeper_name)
         values ($1, '2026-08-07', '302', 'Maria Garcia')`,
        [PROP],
      );
      assert.match(msg, /ingest_run_id/i, 'the NOT NULL receipt is the app-to-mirror wall');
    });
  });

  describe('a housekeeper is a person, not a spelling', () => {
    test('a room can be assigned to a real staff member by id', async () => {
      await pg.query(
        `insert into public.room_work (property_id, date, room_number, assigned_staff_id, assigned_source)
         values ($1, '2026-08-08', '401', $2, 'manager')`,
        [PROP, MARIA],
      );
      assert.equal(
        await scalar<string>(
          `select assigned_staff_id::text from public.room_work where room_number = '401'`,
        ),
        MARIA,
      );
    });

    test('another hotel\'s housekeeper cannot be assigned here', async () => {
      const msg = await failsWith(
        `insert into public.room_work (property_id, date, room_number, assigned_staff_id, assigned_source)
         values ($1, '2026-08-08', '402', $2, 'manager')`,
        [PROP, OTHER_HOTEL_STAFF],
      );
      assert.match(msg, /room_work_staff_fk|foreign key/i);
    });

    test('an assignment always records how it was decided', async () => {
      const msg = await failsWith(
        `insert into public.room_work (property_id, date, room_number, assigned_staff_id)
         values ($1, '2026-08-08', '403', $2)`,
        [PROP, MARIA],
      );
      assert.match(msg, /room_work_assigned_source_chk/i);
    });

    test('removing a housekeeper unassigns her rooms — it never deletes the work record', async () => {
      const tempStaff = '93000000-0000-4000-8000-00000000000a';
      await pg.query(
        `insert into public.staff(id, property_id, name, is_active) values ($1, $2, 'Temp Helper', true)`,
        [tempStaff, PROP],
      );
      await pg.query(
        `insert into public.room_work (property_id, date, room_number, assigned_staff_id, assigned_source, status)
         values ($1, '2026-08-09', '501', $2, 'manager', 'completed')`,
        [PROP, tempStaff],
      );
      await pg.query(`delete from public.staff where id = $1`, [tempStaff]);

      const left = await rows<{ assigned_staff_id: string | null; status: string }>(
        `select assigned_staff_id, status from public.room_work
          where property_id = $1 and date = '2026-08-09' and room_number = '501'`,
        [PROP],
      );
      assert.equal(left.length, 1, 'the record that the room was cleaned must survive');
      assert.equal(left[0].assigned_staff_id, null);
    });
  });

  describe('inspections write work state, not the mirror', () => {
    test('passing an inspection records the pass even when no work row existed', async () => {
      const inspectionId = await scalar<string>(
        `insert into public.inspections (property_id, room_number, result, started_at)
         values ($1, '601', 'in_progress', '2026-08-10T10:00:00Z') returning id`,
        [PROP],
      );
      await pg.query(
        `select public.complete_inspection_atomic($1, $2, 'pass', '[]'::jsonb, '[]'::jsonb, null, false, null, null, null)`,
        [inspectionId, PROP],
      );
      const work = await rows<{ status: string; inspected_at: string | null }>(
        `select status, inspected_at from public.room_work where property_id = $1 and room_number = '601'`,
        [PROP],
      );
      assert.equal(work.length, 1, 'the pass must be recorded somewhere');
      assert.equal(work[0].status, 'completed');
      assert.ok(work[0].inspected_at);
    });

    test('failing an inspection sends the room back to be re-cleaned, with the reason', async () => {
      await pg.query(
        `insert into public.room_work (property_id, date, room_number, status, completed_at)
         values ($1, '2026-08-11', '602', 'completed', '2026-08-11T11:00:00Z')`,
        [PROP],
      );
      const inspectionId = await scalar<string>(
        `insert into public.inspections (property_id, room_number, result, started_at)
         values ($1, '602', 'in_progress', '2026-08-11T12:00:00Z') returning id`,
        [PROP],
      );
      await pg.query(
        `select public.complete_inspection_atomic($1, $2, 'fail', '[]'::jsonb, '[]'::jsonb, null, false, null, null, 'Mirror smudged')`,
        [inspectionId, PROP],
      );
      const work = await rows<{ status: string; issue_note: string; completed_at: string | null }>(
        `select status, issue_note, completed_at from public.room_work
          where property_id = $1 and date = '2026-08-11' and room_number = '602'`,
        [PROP],
      );
      assert.equal(work[0].status, 'not_started');
      assert.equal(work[0].issue_note, 'Mirror smudged');
      assert.equal(work[0].completed_at, null);
    });

    test('today_room_work_v1 names the person we assigned, not the string the PMS printed', async () => {
      await pg.query(
        `insert into public.pms_room_status_log (property_id, room_number, status, changed_at, source, ingest_run_id)
         values ($1, '701', 'vacant_dirty', '2026-08-12T08:00:00Z', 'cua', $2)`,
        [PROP, runId],
      );
      await pg.query(
        `insert into public.pms_housekeeping_assignments
           (property_id, date, room_number, housekeeper_name, ingest_run_id)
         values ($1, '2026-08-12', '701', 'M GARCIA', $2)`,
        [PROP, runId],
      );
      await pg.query(
        `insert into public.room_work (property_id, date, room_number, assigned_staff_id, assigned_source)
         values ($1, '2026-08-12', '701', $2, 'manager')`,
        [PROP, MARIA],
      );

      const out = await rows<{ room_number: string; housekeeper: string | null }>(
        `select room_number, housekeeper from public.today_room_work_v1($1, '2026-08-12')`,
        [PROP],
      );
      const row = out.find((r) => r.room_number === '701');
      assert.ok(row, 'the room must still be listed');
      assert.equal(row!.housekeeper, 'Maria Garcia');
    });

    test('today_room_work_v1 still reports the PMS name when nobody has assigned the room', async () => {
      await pg.query(
        `insert into public.pms_room_status_log (property_id, room_number, status, changed_at, source, ingest_run_id)
         values ($1, '702', 'vacant_dirty', '2026-08-13T08:00:00Z', 'cua', $2)`,
        [PROP, runId],
      );
      await pg.query(
        `insert into public.pms_housekeeping_assignments
           (property_id, date, room_number, housekeeper_name, ingest_run_id)
         values ($1, '2026-08-13', '702', 'Whoever The Pms Said', $2)`,
        [PROP, runId],
      );
      const out = await rows<{ room_number: string; housekeeper: string | null }>(
        `select room_number, housekeeper from public.today_room_work_v1($1, '2026-08-13')`,
        [PROP],
      );
      assert.equal(out.find((r) => r.room_number === '702')?.housekeeper, 'Whoever The Pms Said');
    });

    test('the RPC that seeded the mirror with app-derived data is gone', async () => {
      const left = await scalar<number>(
        `select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = 'staxis_seed_shift_assignments'`,
      );
      assert.equal(Number(left), 0);
    });
  });

  // ─── 0356 — one name, one meaning ────────────────────────────────────────

  describe('name equality is defined once, by the database', () => {
    test('two spellings of the same name cannot both be recorded', async () => {
      await pg.query(
        `insert into public.staff_aliases (property_id, staff_id, alias_raw, source)
         values ($1, $2, '  Maria   Garcia ', 'manager')`,
        [PROP, MARIA],
      );
      const msg = await failsWith(
        `insert into public.staff_aliases (property_id, staff_id, alias_raw, source)
         values ($1, $2, 'maria garcia', 'pms_import')`,
        [PROP, MARIA],
      );
      assert.match(msg, /staff_aliases_norm_unique|duplicate key/i);
    });

    test('an alias can be recorded before anyone knows who it is', async () => {
      await pg.query(
        `insert into public.staff_aliases (property_id, alias_raw, source)
         values ($1, 'M. GARZA', 'pms_import')`,
        [PROP],
      );
      assert.equal(
        Number(
          await scalar(
            `select count(*) from public.staff_aliases where property_id = $1 and staff_id is null`,
            [PROP],
          ),
        ),
        1,
      );
    });

    test('an alias cannot point at another hotel\'s staff member', async () => {
      const msg = await failsWith(
        `insert into public.staff_aliases (property_id, staff_id, alias_raw, source)
         values ($1, $2, 'Someone Else', 'manager')`,
        [PROP, OTHER_HOTEL_STAFF],
      );
      assert.match(msg, /staff_aliases_staff_fk|foreign key/i);
    });

    test('an unrecognised source is refused — every alias says where it came from', async () => {
      const msg = await failsWith(
        `insert into public.staff_aliases (property_id, alias_raw, source)
         values ($1, 'Whoever', 'vibes')`,
        [PROP],
      );
      assert.match(msg, /staff_aliases_source_chk/i);
    });
  });

  describe('a category value is recorded once and degrades to itself', () => {
    test('the same channel spelled two ways is one row', async () => {
      await pg.query(
        `insert into public.pms_dimension_values (property_id, dimension, raw_value)
         values ($1, 'channel', ' Booking.com ')`,
        [PROP],
      );
      const msg = await failsWith(
        `insert into public.pms_dimension_values (property_id, dimension, raw_value)
         values ($1, 'channel', 'booking.com')`,
        [PROP],
      );
      assert.match(msg, /pms_dimension_values_unique|duplicate key/i);
    });

    test('the same string in a different dimension is a different thing', async () => {
      await pg.query(
        `insert into public.pms_dimension_values (property_id, dimension, raw_value)
         values ($1, 'rate_plan', 'Booking.com')`,
        [PROP],
      );
      assert.equal(
        Number(
          await scalar(
            `select count(*) from public.pms_dimension_values where property_id = $1 and value_norm = 'booking.com'`,
            [PROP],
          ),
        ),
        2,
      );
    });

    test('a dimension nobody agreed on is refused', async () => {
      const msg = await failsWith(
        `insert into public.pms_dimension_values (property_id, dimension, raw_value)
         values ($1, 'astrology', 'Leo')`,
        [PROP],
      );
      assert.match(msg, /pms_dimension_values_dimension_chk/i);
    });

    test('a canonical meaning cannot be set without recording when it was decided', async () => {
      const msg = await failsWith(
        `insert into public.pms_dimension_values (property_id, dimension, raw_value, canonical_code)
         values ($1, 'channel', 'Expedia Group', 'EXPEDIA')`,
        [PROP],
      );
      assert.match(msg, /pms_dimension_values_resolved_chk/i);
    });

    test('unmapped is the normal state and costs nothing', async () => {
      const unmapped = await rows<{ raw_value: string; canonical_code: string | null }>(
        `select raw_value, canonical_code from public.pms_dimension_values
          where property_id = $1 and canonical_code is null`,
        [PROP],
      );
      assert.ok(unmapped.length > 0);
      for (const r of unmapped) {
        assert.equal(r.canonical_code, null);
        assert.ok(r.raw_value, 'the raw value is always there to fall back to');
      }
    });
  });

  // ─── The browser can never reach any of it ───────────────────────────────

  describe('the new tables are server-only', () => {
    for (const table of ['room_work', 'staff_aliases', 'pms_dimension_values']) {
      test(`${table} denies anon and authenticated`, async () => {
        const rls = await scalar<boolean>(
          `select relrowsecurity from pg_class where oid = ('public.' || $1)::regclass`,
          [table],
        );
        assert.equal(rls, true, `${table} must have row level security on`);

        const grants = await rows<{ grantee: string }>(
          `select grantee from information_schema.role_table_grants
            where table_schema = 'public' and table_name = $1 and grantee in ('anon', 'authenticated')`,
          [table],
        );
        assert.deepEqual(grants, [], `${table} must grant the browser roles nothing`);
      });
    }
  });
});
