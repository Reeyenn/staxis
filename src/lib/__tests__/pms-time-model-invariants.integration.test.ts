/**
 * The time-model invariants, exercised against the REAL migrations in PGlite.
 *
 * Migrations 0343/0344 are almost entirely enforcement: triggers, CHECKs,
 * unique keys and generated columns whose whole job is to make a certain class
 * of write impossible. A unit test cannot show that — only the database can.
 * So this file applies production migrations and then tries to do each
 * forbidden thing.
 *
 * PGLITE PREREQUISITES. The runner skips 0340 (needs storage.buckets) and 0342
 * (needs the extensions schema), so two of their artefacts are supplied here
 * before the migrations that depend on them: pms_ingest_runs/pms_report_files
 * (0340) and the append-table unique indexes (0342). Everything under test is
 * still the real 0343/0344 SQL. If the stub ever drifts from the real thing,
 * 0343 fails to apply and the `before` hook below says so loudly.
 */

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { PGlite } from '@electric-sql/pglite';
import { applyMigrationsToPgliteWithHook } from '../../../tests/fixtures/pglite-migrate';

const OWNER = '81000000-0000-4000-8000-000000000001';
const PROP = '82000000-0000-4000-8000-000000000001';
const PROP_CUTOFF = '82000000-0000-4000-8000-000000000002';
const PROP_DOOMED = '82000000-0000-4000-8000-000000000003';

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

let pg: PGlite;
let runId: string;

async function scalar<T>(sql: string, params: unknown[] = []): Promise<T> {
  const result = await pg.query(sql, params) as { rows: Array<Record<string, unknown>> };
  return Object.values(result.rows[0] ?? {})[0] as T;
}

async function rows<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const result = await pg.query(sql, params) as { rows: T[] };
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

describe('pms time model — migrations 0343 / 0344', () => {
  before(async () => {
    const migrated = await applyMigrationsToPgliteWithHook(async ({ pg: db, file }) => {
      if (file.startsWith('0341_')) await db.exec(INGEST_STUB);
      if (file.startsWith('0343_')) await db.exec(APPEND_UNIQUE_STUB);
    });
    pg = migrated.pg;
    for (const version of ['0343_pms_time_model.sql', '0344_daily_logs_closing_photo.sql']) {
      assert.ok(
        migrated.report.applied.includes(version),
        `${version} must apply: ${JSON.stringify(migrated.report.failedAtRuntime.filter((e) => e.file.startsWith('034')))}`,
      );
    }

    await pg.query(`insert into auth.users(id, email) values ($1, 'time@example.test') on conflict (id) do nothing`, [OWNER]);
    await pg.query(
      `insert into public.properties(id, owner_id, name, total_rooms, timezone, business_date_cutoff_hour)
       values ($1, $4, 'Midnight Inn', 60, 'America/Chicago', 0),
              ($2, $4, 'Night Audit Inn', 60, 'America/Chicago', 3),
              ($3, $4, 'Doomed Inn', 60, 'UTC', 0)
       on conflict (id) do nothing`,
      [PROP, PROP_CUTOFF, PROP_DOOMED, OWNER],
    );
    runId = await scalar<string>(
      `insert into public.pms_ingest_runs(property_id, source_kind, mode, source_captured_at, finished_at)
       values ($1, 'report_email', 'live', now(), now()) returning id`,
      [PROP],
    );
  });

  // This fixture is its own PGlite instance (not the memoized one), so it has
  // to close it or the WASM handle keeps the test process alive.
  after(async () => {
    await pg.close();
  });

  // ─── The registry cannot lie ─────────────────────────────────────────────

  describe('staxis_pms_registry_matches_reality', () => {
    test('the shipped registry is consistent with the shipped schema', async () => {
      const violations = await rows(`select * from public.staxis_pms_registry_violations()`);
      assert.deepEqual(violations, [], 'a fresh database must have zero registry violations');
    });

    test('a descriptor naming a table that does not exist is refused', async () => {
      const msg = await failsWith(
        `insert into public.pms_table_schemas(table_name, write_strategy, snapshot_scope_default, natural_key, columns, time_grain)
         values ('pms_imaginary', 'upsert', 'full', array['property_id'], '[]'::jsonb, 'entity')`,
      );
      assert.match(msg, /does not exist/i);
    });

    test('a natural_key with no unique index behind it is refused', async () => {
      // pms_guests exists, but (property_id, guest_name) has no unique index —
      // declaring it would make every poll append duplicates instead of upsert.
      const msg = await failsWith(
        `update public.pms_table_schemas set natural_key = array['property_id','guest_name'] where table_name = 'pms_guests'`,
      );
      assert.match(msg, /no matching UNIQUE index/i);
    });

    test('an observation table cannot declare an overwriting write strategy', async () => {
      const msg = await failsWith(
        `update public.pms_table_schemas set write_strategy = 'upsert' where table_name = 'pms_occupancy_observation'`,
      );
      assert.match(msg, /observation grain requires write_strategy=append/i);
    });

    test('a daily fact without as_of in its key is refused — that is the double-count', async () => {
      const msg = await failsWith(
        `update public.pms_table_schemas set natural_key = array['property_id','business_date'] where table_name = 'pms_revenue_daily'`,
      );
      assert.match(msg, /no matching UNIQUE index|requires as_of/i);
    });

    test('a table cannot be reclassified daily_fact without a business_date column', async () => {
      const msg = await failsWith(
        `update public.pms_table_schemas set time_grain = 'daily_fact' where table_name = 'pms_guests'`,
      );
      assert.match(msg, /requires a business_date column|requires business_date in natural_key/i);
    });

    test('the descriptor cannot point at the compat VIEW, which no writer can write', async () => {
      const msg = await failsWith(
        `update public.pms_table_schemas set table_name = 'pms_in_house_snapshot' where table_name = 'pms_occupancy_observation'`,
      );
      assert.match(msg, /not a base table/i);
    });
  });

  // ─── Occupancy history ───────────────────────────────────────────────────

  describe('occupancy is never overwritten', () => {
    test('three readings are three rows, and the compat view shows the newest one', async () => {
      for (const [ts, occupied] of [
        ['2026-06-09T14:00:00Z', 30],
        ['2026-06-09T18:00:00Z', 41],
        ['2026-06-09T22:00:00Z', 47],
      ] as Array<[string, number]>) {
        await pg.query(
          `insert into public.pms_occupancy_observation
             (property_id, observed_at, observed_at_source, total_occupied_rooms, ingest_run_id)
           values ($1, $2::timestamptz, 'report_printed', $3, $4)`,
          [PROP, ts, occupied, runId],
        );
      }

      const kept = await scalar<number>(
        `select count(*)::int from public.pms_occupancy_observation where property_id = $1`, [PROP],
      );
      assert.equal(kept, 3, 'every reading survives — this is the whole point of 0343');

      const view = await rows<{ total_occupied_rooms: number; captured_at: string; has_error: boolean }>(
        `select total_occupied_rooms, captured_at, has_error from public.pms_in_house_snapshot where property_id = $1`,
        [PROP],
      );
      assert.equal(view.length, 1, 'the compat view is still one row per hotel');
      assert.equal(view[0].total_occupied_rooms, 47, 'and it is the newest reading');
      assert.equal(view[0].has_error, false);
    });

    test('the view derives health from the observation, not from a stale feed row', async () => {
      // The reviewer caught this: joining pms_feed_values would either never
      // match (live feed keys are getter names) or resurrect a stale
      // has_error=true and permanently fail seal-daily's evidence gate.
      const r = await rows<{ last_good_at: Date; captured_at: Date; last_error: string | null }>(
        `select last_good_at, captured_at, last_error from public.pms_in_house_snapshot where property_id = $1`,
        [PROP],
      );
      assert.equal(
        new Date(r[0].last_good_at).getTime(),
        new Date(r[0].captured_at).getTime(),
        'an observation exists only because a good reading landed',
      );
      assert.equal(r[0].last_error, null);
    });

    test('business_date is derived from observed_at through the hotel\'s own cutoff', async () => {
      // 02:15 America/Chicago on 2026-06-10 is 07:15Z. The cutoff-0 hotel calls
      // that the 10th; the 3am-night-audit hotel is still working on the 9th.
      const midnightRun = await scalar<string>(
        `insert into public.pms_ingest_runs(property_id, source_kind, mode, source_captured_at, finished_at)
         values ($1, 'report_email', 'live', now(), now()) returning id`, [PROP],
      );
      const cutoffRun = await scalar<string>(
        `insert into public.pms_ingest_runs(property_id, source_kind, mode, source_captured_at, finished_at)
         values ($1, 'report_email', 'live', now(), now()) returning id`, [PROP_CUTOFF],
      );
      for (const [pid, rid] of [[PROP, midnightRun], [PROP_CUTOFF, cutoffRun]] as Array<[string, string]>) {
        await pg.query(
          `insert into public.pms_occupancy_observation
             (property_id, observed_at, observed_at_source, total_occupied_rooms, ingest_run_id)
           values ($1, '2026-06-10T07:15:00Z'::timestamptz, 'email_received', 12, $2)`,
          [pid, rid],
        );
      }
      const plain = await scalar<string>(
        `select business_date::text from public.pms_occupancy_observation
          where property_id = $1 and observed_at = '2026-06-10T07:15:00Z'::timestamptz`, [PROP],
      );
      const nightAudit = await scalar<string>(
        `select business_date::text from public.pms_occupancy_observation
          where property_id = $1 and observed_at = '2026-06-10T07:15:00Z'::timestamptz`, [PROP_CUTOFF],
      );
      assert.equal(plain, '2026-06-10');
      assert.equal(nightAudit, '2026-06-09', '02:15 belongs to the business day that is closing');
    });

    test('observed_at is stamped from the ingest run, so it cannot disagree with the receipt', async () => {
      const capturedAt = '2026-06-11T15:45:00Z';
      const stampedRun = await scalar<string>(
        `insert into public.pms_ingest_runs(property_id, source_kind, mode, source_captured_at, finished_at)
         values ($1, 'report_email', 'live', $2::timestamptz, now()) returning id`,
        [PROP, capturedAt],
      );
      await pg.query(
        `insert into public.pms_occupancy_observation
           (property_id, observed_at_source, total_occupied_rooms, ingest_run_id)
         values ($1, 'report_printed', 51, $2)`,
        [PROP, stampedRun],
      );
      const observed = await scalar<Date>(
        `select observed_at from public.pms_occupancy_observation where ingest_run_id = $1`, [stampedRun],
      );
      assert.equal(
        new Date(observed).toISOString(),
        new Date(capturedAt).toISOString(),
        "observed_at must mirror the run's source_captured_at, not a second clock",
      );
    });
  });

  // ─── Booking pace ────────────────────────────────────────────────────────

  describe('booking pace is stored as-of', () => {
    test('thirty vantage points on one stay night produce a complete pickup curve', async () => {
      for (let i = 0; i < 30; i++) {
        const day = String(1 + i).padStart(2, '0');
        await pg.query(
          `insert into public.pms_booking_pace
             (property_id, as_of_date, stay_date, rooms_otb, rooms_available, ingest_run_id)
           values ($1, $2::date, '2026-08-15'::date, $3, 60, $4)`,
          [PROP, `2026-07-${day}`, i * 2, runId],
        );
      }
      const curve = await rows<{ as_of_date: string; rooms_otb: number }>(
        `select as_of_date::text as as_of_date, rooms_otb from public.pms_booking_pace
          where property_id = $1 and stay_date = '2026-08-15'::date order by as_of_date`,
        [PROP],
      );
      assert.equal(curve.length, 30, 'the old (property_id, pms_reservation_id) shape could only ever hold one');
      assert.equal(curve[0].rooms_otb, 0);
      assert.equal(curve[29].rooms_otb, 58);
    });

    test('the same vantage point twice is refused — a re-delivered report cannot fork the curve', async () => {
      const msg = await failsWith(
        `insert into public.pms_booking_pace (property_id, as_of_date, stay_date, rooms_otb, ingest_run_id)
         values ($1, '2026-07-01'::date, '2026-08-15'::date, 999, $2)`,
        [PROP, runId],
      );
      assert.match(msg, /pms_booking_pace_natural_key|duplicate key/i);
    });

    test('a stay night before the vantage point is refused, with one day of night-audit slack', async () => {
      // as_of - 1 is allowed on purpose: a pace report printed just after night
      // audit can legitimately still carry the day that closed.
      await pg.query(
        `insert into public.pms_booking_pace (property_id, as_of_date, stay_date, rooms_otb, ingest_run_id)
         values ($1, '2026-09-02'::date, '2026-09-01'::date, 5, $2)`,
        [PROP, runId],
      );
      const msg = await failsWith(
        `insert into public.pms_booking_pace (property_id, as_of_date, stay_date, rooms_otb, ingest_run_id)
         values ($1, '2026-09-10'::date, '2026-09-01'::date, 5, $2)`,
        [PROP, runId],
      );
      assert.match(msg, /pms_booking_pace_stay_after_as_of/i);
    });
  });

  // ─── Restatement ─────────────────────────────────────────────────────────

  describe('a correction never destroys the report it corrects', () => {
    test('two generations coexist; _current is the newest', async () => {
      await pg.query(
        `insert into public.pms_revenue_daily
           (property_id, business_date, as_of, business_date_source, total_revenue_cents, ingest_run_id)
         values ($1, '2026-06-09'::date, '2026-06-10T08:00:00Z'::timestamptz, 'report_printed', 100000, $2),
                ($1, '2026-06-09'::date, '2026-06-10T16:00:00Z'::timestamptz, 'report_printed', 120000, $2)`,
        [PROP, runId],
      );
      const kept = await scalar<number>(
        `select count(*)::int from public.pms_revenue_daily where property_id = $1 and business_date = '2026-06-09'`, [PROP],
      );
      assert.equal(kept, 2, 'the morning report survives the afternoon correction');

      const current = await rows<{ total_revenue_cents: string }>(
        `select total_revenue_cents from public.pms_revenue_daily_current
          where property_id = $1 and business_date = '2026-06-09'`, [PROP],
      );
      assert.equal(current.length, 1, 'exactly one row per business day — this is what stops the double-count');
      assert.equal(Number(current[0].total_revenue_cents), 120000);
    });

    test('a range sum over _current counts the restated day once', async () => {
      await pg.query(
        `insert into public.pms_revenue_daily
           (property_id, business_date, as_of, business_date_source, total_revenue_cents, ingest_run_id)
         values ($1, '2026-06-10'::date, '2026-06-11T08:00:00Z'::timestamptz, 'report_printed', 90000, $2)`,
        [PROP, runId],
      );
      const viaView = await scalar<string>(
        `select coalesce(sum(total_revenue_cents), 0) from public.pms_revenue_daily_current
          where property_id = $1 and business_date >= '2026-06-01' and business_date < '2026-07-01'`, [PROP],
      );
      const viaBase = await scalar<string>(
        `select coalesce(sum(total_revenue_cents), 0) from public.pms_revenue_daily
          where property_id = $1 and business_date >= '2026-06-01' and business_date < '2026-07-01'`, [PROP],
      );
      assert.equal(Number(viaView), 210000, '$1,200 corrected + $900');
      assert.equal(Number(viaBase), 310000, 'the base table really does double-count — that is why readers moved');
    });

    test('a daily fact cannot be written without saying where its business date came from', async () => {
      const msg = await failsWith(
        `insert into public.pms_revenue_daily (property_id, business_date, total_revenue_cents, ingest_run_id)
         values ($1, '2026-06-12'::date, 1000, $2)`,
        [PROP, runId],
      );
      assert.match(msg, /business_date_source/i);
    });

    test('there is no "derived" business date for a daily fact — the value does not exist', async () => {
      const msg = await failsWith(
        `insert into public.pms_revenue_daily
           (property_id, business_date, business_date_source, total_revenue_cents, ingest_run_id)
         values ($1, '2026-06-12'::date, 'derived', 1000, $2)`,
        [PROP, runId],
      );
      assert.match(msg, /business_date_source_check/i);
    });

    test('a daily fact cannot be written without a business date at all', async () => {
      const msg = await failsWith(
        `insert into public.pms_revenue_daily (property_id, business_date_source, total_revenue_cents, ingest_run_id)
         values ($1, 'report_printed', 1000, $2)`,
        [PROP, runId],
      );
      assert.match(msg, /business_date/i);
    });

    test('as_of is stamped from the ingest run when the writer omits it', async () => {
      const capturedAt = '2026-06-13T09:30:00Z';
      const lateRun = await scalar<string>(
        `insert into public.pms_ingest_runs(property_id, source_kind, mode, source_captured_at, finished_at)
         values ($1, 'report_email', 'live', $2::timestamptz, now()) returning id`, [PROP, capturedAt],
      );
      await pg.query(
        `insert into public.pms_revenue_daily
           (property_id, business_date, business_date_source, total_revenue_cents, ingest_run_id)
         values ($1, '2026-06-13'::date, 'report_printed', 5000, $2)`,
        [PROP, lateRun],
      );
      const asOf = await scalar<Date>(
        `select as_of from public.pms_revenue_daily where ingest_run_id = $1`, [lateRun],
      );
      assert.equal(new Date(asOf).toISOString(), new Date(capturedAt).toISOString());
    });

    test('the rate grid keeps its STAY date and gains a vantage point', async () => {
      // The reviewer caught the original plan renaming this to business_date:
      // it is a future stay night, never an accounting day.
      const hasStayDate = await scalar<number>(
        `select count(*)::int from information_schema.columns
          where table_schema='public' and table_name='pms_rates_and_inventory' and column_name='stay_date'`,
      );
      const hasBusinessDate = await scalar<number>(
        `select count(*)::int from information_schema.columns
          where table_schema='public' and table_name='pms_rates_and_inventory' and column_name='business_date'`,
      );
      assert.equal(hasStayDate, 1);
      assert.equal(hasBusinessDate, 0, 'a rate for a future night is not an accounting day');
      const grain = await scalar<string>(
        `select time_grain from public.pms_table_schemas where table_name='pms_rates_and_inventory'`,
      );
      assert.equal(grain, 'as_of_grid');
    });
  });

  // ─── Entity change history ───────────────────────────────────────────────

  describe('changes to upsert-in-place entities are recorded before the old value is lost', () => {
    before(async () => {
      await pg.query(
        `insert into public.pms_reservations
           (property_id, pms_reservation_id, guest_name, arrival_date, rate_per_night_cents, status, ingest_run_id)
         values ($1, 'RES-1', 'Ada', '2026-07-01', 12000, 'booked', $2)`,
        [PROP, runId],
      );
    });

    test('re-upserting the identical row writes nothing — the poll cadence stays free', async () => {
      const before0 = await scalar<number>(`select count(*)::int from public.pms_entity_change_log`);
      await pg.query(
        `update public.pms_reservations set guest_name = 'Ada', rate_per_night_cents = 12000
          where property_id = $1 and pms_reservation_id = 'RES-1'`, [PROP],
      );
      const after = await scalar<number>(`select count(*)::int from public.pms_entity_change_log`);
      assert.equal(after, before0, 'an unchanged re-upsert must not log');
    });

    test('a bookkeeping-only touch writes nothing', async () => {
      const before0 = await scalar<number>(`select count(*)::int from public.pms_entity_change_log`);
      await pg.query(
        `update public.pms_reservations set last_synced_at = now()
          where property_id = $1 and pms_reservation_id = 'RES-1'`, [PROP],
      );
      const after = await scalar<number>(`select count(*)::int from public.pms_entity_change_log`);
      assert.equal(after, before0, 'last_synced_at moving every 30s must not fill the log');
    });

    test('a rate change is logged once, with both values', async () => {
      await pg.query(
        `update public.pms_reservations set rate_per_night_cents = 15000
          where property_id = $1 and pms_reservation_id = 'RES-1'`, [PROP],
      );
      const logged = await rows<{ changed_fields: string[]; before: Record<string, unknown>; after: Record<string, unknown>; entity_key: string }>(
        `select changed_fields, before, after, entity_key from public.pms_entity_change_log
          where table_name = 'pms_reservations' and entity_key = 'RES-1' order by changed_at desc limit 1`,
      );
      assert.equal(logged.length, 1);
      assert.deepEqual(logged[0].changed_fields, ['rate_per_night_cents']);
      assert.equal(Number(logged[0].before.rate_per_night_cents), 12000);
      assert.equal(Number(logged[0].after.rate_per_night_cents), 15000);
      assert.equal(logged[0].entity_key, 'RES-1');
    });
  });

  // ─── Append-only ─────────────────────────────────────────────────────────

  describe('observations are append-only', () => {
    test('an observation cannot be edited', async () => {
      const msg = await failsWith(
        `update public.pms_occupancy_observation set total_occupied_rooms = 0 where property_id = $1`, [PROP],
      );
      assert.match(msg, /append-only/i);
    });

    test('an observation cannot be casually deleted', async () => {
      const msg = await failsWith(
        `delete from public.pms_occupancy_observation where property_id = $1`, [PROP],
      );
      assert.match(msg, /append-only/i);
    });

    test('service_role has no UPDATE or DELETE privilege either', async () => {
      for (const table of ['pms_occupancy_observation', 'pms_booking_pace', 'pms_room_status_log', 'pms_activity_log', 'pms_entity_change_log']) {
        const canUpdate = await scalar<boolean>(
          `select has_table_privilege('service_role', $1, 'UPDATE')`, [`public.${table}`],
        );
        const canDelete = await scalar<boolean>(
          `select has_table_privilege('service_role', $1, 'DELETE')`, [`public.${table}`],
        );
        assert.equal(canUpdate, false, `${table} must not be updatable by service_role`);
        assert.equal(canDelete, false, `${table} must not be deletable by service_role`);
      }
    });

    test('the sanctioned purge removes only rows before the cutoff', async () => {
      const totalBefore = await scalar<number>(
        `select count(*)::int from public.pms_occupancy_observation where property_id = $1`, [PROP],
      );
      const purged = await scalar<string>(
        `select public.staxis_pms_purge_observations('pms_occupancy_observation', '2026-06-10'::date)`,
      );
      const totalAfter = await scalar<number>(
        `select count(*)::int from public.pms_occupancy_observation where property_id = $1`, [PROP],
      );
      assert.ok(Number(purged) > 0, 'the June 9th readings should have gone');
      assert.equal(totalAfter, totalBefore - Number(purged));
      const remainingOld = await scalar<number>(
        `select count(*)::int from public.pms_occupancy_observation
          where property_id = $1 and observed_at < '2026-06-10'::date`, [PROP],
      );
      assert.equal(remainingOld, 0);
      const survived = await scalar<number>(
        `select count(*)::int from public.pms_occupancy_observation
          where property_id = $1 and observed_at >= '2026-06-10'::date`, [PROP],
      );
      assert.ok(survived > 0, 'rows after the cutoff must survive');
    });

    test('the purge refuses a table that is not an observation table', async () => {
      const msg = await failsWith(`select public.staxis_pms_purge_observations('pms_reservations', '2030-01-01'::date)`);
      assert.match(msg, /not an observation table/i);
    });

    test('deleting a hotel still cascades — append-only must not brick delete-hotel', async () => {
      const doomedRun = await scalar<string>(
        `insert into public.pms_ingest_runs(property_id, source_kind, mode, source_captured_at, finished_at)
         values ($1, 'report_email', 'live', now(), now()) returning id`, [PROP_DOOMED],
      );
      await pg.query(
        `insert into public.pms_occupancy_observation
           (property_id, observed_at, observed_at_source, total_occupied_rooms, ingest_run_id)
         values ($1, now(), 'robot_capture', 5, $2)`,
        [PROP_DOOMED, doomedRun],
      );
      await pg.query(`delete from public.properties where id = $1`, [PROP_DOOMED]);
      const left = await scalar<number>(
        `select count(*)::int from public.pms_occupancy_observation where property_id = $1`, [PROP_DOOMED],
      );
      assert.equal(left, 0, 'the 129-FK delete-hotel cascade must still work');
    });
  });

  // ─── The closing photo ───────────────────────────────────────────────────

  describe('daily_logs closing photo (0344)', () => {
    test('ADR / RevPAR / occupancy %% are computed by Postgres from the counts', async () => {
      await pg.query(
        `insert into public.daily_logs
           (property_id, date, rooms_available, rooms_sold, occupancy_source, rooms_revenue_cents, revenue_source)
         values ($1, '2026-06-09'::date, 100, 80, 'pms_report', 1000000, 'pms_report')`,
        [PROP],
      );
      const r = await rows<{ occupancy_pct: string; adr_cents: string; revpar_cents: string; day_of_week: number }>(
        `select occupancy_pct, adr_cents, revpar_cents, day_of_week from public.daily_logs
          where property_id = $1 and date = '2026-06-09'`, [PROP],
      );
      assert.equal(Number(r[0].occupancy_pct), 80);
      assert.equal(Number(r[0].adr_cents), 12500);
      assert.equal(Number(r[0].revpar_cents), 10000);
      assert.equal(Number(r[0].day_of_week), 2, '2026-06-09 is a Tuesday');
    });

    test('no client can write a derived number, so it can never disagree with its inputs', async () => {
      const msg = await failsWith(
        `insert into public.daily_logs (property_id, date, revpar_cents) values ($1, '2026-06-20'::date, 999999)`,
        [PROP],
      );
      assert.match(msg, /generated column|cannot insert/i);
    });

    test('a value without a stated source cannot exist — the fabricated-zero class', async () => {
      const msg = await failsWith(
        `insert into public.daily_logs (property_id, date, total_revenue_cents) values ($1, '2026-06-21'::date, 500000)`,
        [PROP],
      );
      assert.match(msg, /revenue_source_required/i);
    });

    test('a report that genuinely arrived empty is a real state and is allowed', async () => {
      await pg.query(
        `insert into public.daily_logs (property_id, date, revenue_source) values ($1, '2026-06-22'::date, 'pms_report')`,
        [PROP],
      );
      const src = await scalar<string>(
        `select revenue_source from public.daily_logs where property_id = $1 and date = '2026-06-22'`, [PROP],
      );
      assert.equal(src, 'pms_report');
    });

    test('an invented source label is refused', async () => {
      const msg = await failsWith(
        `insert into public.daily_logs (property_id, date, revenue_source) values ($1, '2026-06-23'::date, 'vibes')`,
        [PROP],
      );
      assert.match(msg, /revenue_source_domain/i);
    });

    test('the 87 pre-0344 rows stay legal: everything NULL, including the sources', async () => {
      await pg.query(
        `insert into public.daily_logs (property_id, date, occupied, checkouts) values ($1, '2026-05-01'::date, 42, 9)`,
        [PROP],
      );
      const r = await rows<{ occupancy_source: string | null; seal_version: number }>(
        `select occupancy_source, seal_version from public.daily_logs where property_id = $1 and date = '2026-05-01'`, [PROP],
      );
      assert.equal(r[0].occupancy_source, null, 'provenance is not invented for rows sealed before labels existed');
      assert.equal(Number(r[0].seal_version), 1);
    });
  });

  // ─── Tenant isolation for the new surfaces ───────────────────────────────

  describe('the new tables and views expose nothing to the browser', () => {
    test('RLS is on and deny-all for anon/authenticated', async () => {
      for (const table of ['pms_booking_pace', 'pms_entity_change_log']) {
        const rlsOn = await scalar<boolean>(
          `select relrowsecurity from pg_class where oid = to_regclass($1)`, [`public.${table}`],
        );
        assert.equal(rlsOn, true, `${table} must have RLS enabled`);
        for (const role of ['anon', 'authenticated']) {
          const canSelect = await scalar<boolean>(
            `select has_table_privilege($1, $2, 'SELECT')`, [role, `public.${table}`],
          );
          assert.equal(canSelect, false, `${role} must not be able to read ${table}`);
        }
      }
    });

    test('the compat + _current views are service-role only', async () => {
      for (const view of [
        'pms_in_house_snapshot', 'pms_revenue_daily_current', 'pms_payments_daily_current',
        'pms_channel_performance_current', 'pms_rates_and_inventory_current', 'pms_forecast_daily_current',
      ]) {
        for (const role of ['anon', 'authenticated']) {
          const canSelect = await scalar<boolean>(
            `select has_table_privilege($1, $2, 'SELECT')`, [role, `public.${view}`],
          );
          assert.equal(canSelect, false, `${role} must not be able to read ${view}`);
        }
      }
    });

    test('the views are security_invoker, so they inherit the base table\'s RLS', async () => {
      // A view created WITHOUT security_invoker runs as its owner and would
      // hand every hotel's rows to anyone who could reach it.
      for (const view of [
        'pms_in_house_snapshot', 'pms_revenue_daily_current', 'pms_payments_daily_current',
        'pms_channel_performance_current', 'pms_rates_and_inventory_current', 'pms_forecast_daily_current',
      ]) {
        const invoker = await scalar<boolean>(
          `select coalesce(array_to_string(c.reloptions, ',') like '%security_invoker=true%', false)
             from pg_class c where c.oid = to_regclass($1)`,
          [`public.${view}`],
        );
        assert.equal(invoker, true, `${view} must be security_invoker`);
      }
    });
  });
});
