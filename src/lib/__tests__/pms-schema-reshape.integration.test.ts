/**
 * Migrations 0345 / 0346 / 0347 against a REAL Postgres (pglite), applied from
 * the actual migration files.
 *
 * These are the invariants the reshape claims to have made structural. A claim
 * like "one name string maps to at most one person" is worth nothing unless the
 * database refuses the second one, so each test tries to violate the rule and
 * asserts Postgres says no.
 */

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { PGlite } from '@electric-sql/pglite';
import { applyMigrationsToPglite } from '../../../tests/fixtures/pglite-migrate';

const OWNER = 'b0000000-0000-4000-8000-000000000001';
const PROPERTY = 'b1000000-0000-4000-8000-000000000001';
const OTHER_PROPERTY = 'b1000000-0000-4000-8000-000000000002';
const MARIA = 'b2000000-0000-4000-8000-000000000001';
const FOREIGN_STAFF = 'b2000000-0000-4000-8000-000000000002';

let pg: PGlite;

/** Run `sql`, return the error message, or null if it succeeded. */
async function rejects(sql: string, params: unknown[] = []): Promise<string | null> {
  try {
    await pg.query(sql, params);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

after(async () => {
  // The fixture is memoized across integration tests in a run; closing it
  // here is what lets this file's process exit.
  await pg?.close().catch(() => undefined);
});

before(async () => {
  ({ pg } = await applyMigrationsToPglite());

  await pg.query(`insert into auth.users(id, email) values ($1,'owner@example.com')
                  on conflict (id) do nothing`, [OWNER]);
  await pg.query(
    `insert into public.properties(id,owner_id,name,total_rooms,timezone) values
       ($1,$3,'Reshape Hotel',20,'UTC'),
       ($2,$3,'Other Hotel',10,'UTC')
     on conflict (id) do nothing`,
    [PROPERTY, OTHER_PROPERTY, OWNER],
  );
  await pg.query(
    `insert into public.staff(id, property_id, name) values ($1,$3,'Maria Garcia'),($2,$4,'Outsider')
     on conflict (id) do nothing`,
    [MARIA, FOREIGN_STAFF, PROPERTY, OTHER_PROPERTY],
  );
  await pg.query(
    `insert into public.pms_rooms_inventory(property_id, room_number) values ($1,'101'),($1,'102')
     on conflict do nothing`,
    [PROPERTY],
  );
});

describe('0345 — one reservation, one row', () => {
  test('the three satellite tables are gone', async () => {
    const { rows } = await pg.query(`
      select table_name from information_schema.tables
       where table_schema='public'
         and table_name in ('pms_future_bookings','pms_no_shows','pms_cancellations')
    `) as { rows: unknown[] };
    assert.deepEqual(rows, [], 'a booking must not be able to live in two tables at once');
  });

  test('nights_derived is computed from the reservation’s own dates', async () => {
    await pg.query(
      `insert into public.pms_reservations(property_id, pms_reservation_id, arrival_date, departure_date, num_nights, status)
       values ($1,'R-NIGHTS','2026-08-01','2026-08-04', 99, 'booked')`,
      [PROPERTY],
    );
    const { rows } = await pg.query(
      `select nights_derived, num_nights from public.pms_reservations where pms_reservation_id='R-NIGHTS'`,
    ) as { rows: Array<{ nights_derived: number; num_nights: number }> };
    assert.equal(rows[0]!.nights_derived, 3);
    assert.equal(rows[0]!.num_nights, 99, 'the PMS claim is kept, it is just never the truth');
  });

  test('a cancelled reservation must carry a cancellation date', async () => {
    const err = await rejects(
      `insert into public.pms_reservations(property_id, pms_reservation_id, status)
       values ($1,'R-BADCANCEL','cancelled')`,
      [PROPERTY],
    );
    assert.match(String(err), /pms_res_cancel_coherent/);
  });

  test('a cancellation date must carry the cancelled status', async () => {
    const err = await rejects(
      `insert into public.pms_reservations(property_id, pms_reservation_id, status, cancelled_date)
       values ($1,'R-BADSTATUS','booked','2026-07-01')`,
      [PROPERTY],
    );
    assert.match(String(err), /pms_res_cancel_coherent/);
  });

  test('a cancellation fee cannot exist without a cancellation', async () => {
    const err = await rejects(
      `insert into public.pms_reservations(property_id, pms_reservation_id, status, cancellation_fee_cents)
       values ($1,'R-BADFEE','checked_out', 5000)`,
      [PROPERTY],
    );
    assert.match(String(err), /pms_res_fee_requires_cancel/);
  });

  test('a reservation cannot depart before it arrives', async () => {
    const err = await rejects(
      `insert into public.pms_reservations(property_id, pms_reservation_id, arrival_date, departure_date)
       values ($1,'R-BADDATES','2026-08-10','2026-08-02')`,
      [PROPERTY],
    );
    assert.match(String(err), /pms_res_date_order/);
  });

  test('a booking cannot be created after the guest arrived', async () => {
    const err = await rejects(
      `insert into public.pms_reservations(property_id, pms_reservation_id, arrival_date, booked_at)
       values ($1,'R-BADBOOKED','2026-08-01','2026-09-01')`,
      [PROPERTY],
    );
    assert.match(String(err), /pms_res_booked_before_arrival/);
  });

  // THE reconciliation the four-table design never needed. Three report feeds
  // now upsert the same row; an arrivals report re-listing yesterday's booking
  // must not resurrect a cancellation.
  test('a stale report cannot un-cancel a cancelled reservation', async () => {
    await pg.query(
      `insert into public.pms_reservations(property_id, pms_reservation_id, status, cancelled_date, status_changed_at)
       values ($1,'R-TERMINAL','cancelled','2026-07-01','2026-07-01T12:00:00Z')`,
      [PROPERTY],
    );
    await pg.query(
      `update public.pms_reservations
          set status='booked', cancelled_date=null, guest_name='Re-listed By Arrivals Report'
        where pms_reservation_id='R-TERMINAL'`,
    );
    const { rows } = await pg.query(
      `select status, cancelled_date, guest_name from public.pms_reservations where pms_reservation_id='R-TERMINAL'`,
    ) as { rows: Array<{ status: string; cancelled_date: string | null; guest_name: string | null }> };
    assert.equal(rows[0]!.status, 'cancelled');
    assert.ok(rows[0]!.cancelled_date, 'the coherent date is restored with the status');
    assert.equal(
      rows[0]!.guest_name, 'Re-listed By Arrivals Report',
      'only the status is guarded — everything else stays last-write-wins, by design',
    );
  });

  test('a genuinely newer report CAN reinstate a booking', async () => {
    await pg.query(
      `insert into public.pms_reservations(property_id, pms_reservation_id, status, cancelled_date, status_changed_at)
       values ($1,'R-REINSTATE','cancelled','2026-07-01','2026-07-01T12:00:00Z')`,
      [PROPERTY],
    );
    await pg.query(
      `update public.pms_reservations
          set status='booked', cancelled_date=null, status_changed_at='2026-07-05T09:00:00Z'
        where pms_reservation_id='R-REINSTATE'`,
    );
    const { rows } = await pg.query(
      `select status from public.pms_reservations where pms_reservation_id='R-REINSTATE'`,
    ) as { rows: Array<{ status: string }> };
    assert.equal(rows[0]!.status, 'booked', 'the PMS really did reinstate it');
  });
});

describe('0346 — the ingest cannot reach Staxis room state', () => {
  test('the app-owned columns are physically gone from the PMS mirror', async () => {
    const { rows } = await pg.query(`
      select column_name from information_schema.columns
       where table_schema='public' and table_name='pms_housekeeping_assignments'
         and column_name in ('status','checklist_progress','manager_notes','is_rush','started_at','help_requested')
    `) as { rows: unknown[] };
    assert.deepEqual(rows, [], 'this is the enforcement — not a convention');
  });

  test('the mirror still owns what the PMS actually reports', async () => {
    const { rows } = await pg.query(`
      select column_name from information_schema.columns
       where table_schema='public' and table_name='pms_housekeeping_assignments'
         and column_name in ('housekeeper_name','cleaning_type','dnd_active','scheduled_time')
    `) as { rows: Array<{ column_name: string }> };
    assert.equal(rows.length, 4);
  });

  test('housekeeping work must belong to a room this property has', async () => {
    const err = await rejects(
      `insert into public.room_work(property_id, date, room_number) values ($1,'2026-07-24','999')`,
      [PROPERTY],
    );
    assert.match(String(err), /room_work_room_fk|foreign key/i);
  });

  test('a room cannot be assigned to another hotel’s staff', async () => {
    const err = await rejects(
      `insert into public.room_work(property_id, date, room_number, assigned_staff_id, assigned_source)
       values ($1,'2026-07-24','101',$2,'manager')`,
      [PROPERTY, FOREIGN_STAFF],
    );
    assert.match(String(err), /room_work_staff_fk|foreign key/i);
  });

  test('an assignment cannot exist without saying how it was resolved', async () => {
    const err = await rejects(
      `insert into public.room_work(property_id, date, room_number, assigned_staff_id)
       values ($1,'2026-07-25','101',$2)`,
      [PROPERTY, MARIA],
    );
    assert.match(String(err), /room_work_assigned_source_chk/);
  });

  test('provenance cannot linger after the assignment is cleared', async () => {
    const err = await rejects(
      `insert into public.room_work(property_id, date, room_number, assigned_source)
       values ($1,'2026-07-26','101','manager')`,
      [PROPERTY],
    );
    assert.match(String(err), /room_work_assigned_source_chk/);
  });

  test('a valid assignment is accepted', async () => {
    const err = await rejects(
      `insert into public.room_work(property_id, date, room_number, assigned_staff_id, assigned_source, status)
       values ($1,'2026-07-27','101',$2,'manager','in_progress')`,
      [PROPERTY, MARIA],
    );
    assert.equal(err, null);
  });

  test('the mirror write function exists and accepts only mirror columns', async () => {
    const written = await pg.query(
      `select public.staxis_apply_hk_mirror($1, $2::jsonb) as n`,
      [PROPERTY, JSON.stringify([
        { date: '2026-07-24', room_number: '101', housekeeper_name: 'Maria Garcia', cleaning_type: 'departure' },
        // What a knowledge file might learn. There is no column list for it to
        // reach — the function names the mirror columns and nothing else.
        { date: '2026-07-24', room_number: '102', housekeeper_name: 'Ana', status: 'Dirty', manager_notes: 'clobber me' },
        // No date → not usable, and not counted as written.
        { room_number: '103' },
      ])],
    ) as { rows: Array<{ n: number }> };
    assert.equal(written.rows[0]!.n, 2, 'an unusable row is not reported as written');

    const { rows } = await pg.query(
      `select room_number, housekeeper_name, cleaning_type from public.pms_housekeeping_assignments
        where property_id=$1 and date='2026-07-24' order by room_number`,
      [PROPERTY],
    ) as { rows: Array<{ room_number: string; housekeeper_name: string; cleaning_type: string | null }> };
    assert.deepEqual(rows.map(r => r.room_number), ['101', '102']);
    assert.equal(rows[0]!.cleaning_type, 'departure');
  });

  test('the descriptor names the function the writer will call', async () => {
    const { rows } = await pg.query(
      `select write_via_rpc from public.pms_table_schemas where table_name='pms_housekeeping_assignments'`,
    ) as { rows: Array<{ write_via_rpc: string | null }> };
    assert.equal(rows[0]!.write_via_rpc, 'staxis_apply_hk_mirror');
    // Drift here is the failure the plan review named: the feed writes zero
    // rows and looks exactly like a healthy quiet poll.
    const { rows: fn } = await pg.query(
      `select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.proname='staxis_apply_hk_mirror'`,
    ) as { rows: unknown[] };
    assert.equal(fn.length, 1, 'the descriptor names a function that exists');
  });
});

describe('0347 — identity instead of spelling', () => {
  test('two spellings of the same name collide on one alias', async () => {
    await pg.query(
      `insert into public.staff_aliases(property_id, alias_raw, source) values ($1,'  Maria   Garcia ','pms_import')`,
      [PROPERTY],
    );
    const { rows } = await pg.query(
      `select alias_norm from public.staff_aliases where property_id=$1`, [PROPERTY],
    ) as { rows: Array<{ alias_norm: string }> };
    assert.equal(rows[0]!.alias_norm, 'maria garcia', 'normalization is the database’s job now');

    const err = await rejects(
      `insert into public.staff_aliases(property_id, alias_raw, source) values ($1,'maria garcia','manager')`,
      [PROPERTY],
    );
    assert.match(String(err), /staff_aliases_norm_unique|duplicate key/i);
  });

  test('an alias cannot point at another hotel’s staff', async () => {
    const err = await rejects(
      `insert into public.staff_aliases(property_id, alias_raw, staff_id, source) values ($1,'Outsider',$2,'manager')`,
      [PROPERTY, FOREIGN_STAFF],
    );
    assert.match(String(err), /staff_aliases_staff_fk|foreign key/i);
  });

  test('an unmapped alias is a normal state, not an error', async () => {
    const err = await rejects(
      `insert into public.staff_aliases(property_id, alias_raw, source) values ($1,'Someone New','pms_import')`,
      [PROPERTY],
    );
    assert.equal(err, null);
  });

  test('one raw dimension value maps to at most one canonical code per property', async () => {
    await pg.query(
      `insert into public.pms_dimension_values(property_id, pms_family, dimension, raw_value)
       values ($1,'choice_advantage','channel','  Booking.Com ')`,
      [PROPERTY],
    );
    const err = await rejects(
      `insert into public.pms_dimension_values(property_id, pms_family, dimension, raw_value)
       values ($1,'choice_advantage','channel','booking.com')`,
      [PROPERTY],
    );
    assert.match(String(err), /pms_dimension_values_unique|duplicate key/i);
  });

  test('the same string in two different dimensions is two different facts', async () => {
    const err = await rejects(
      `insert into public.pms_dimension_values(property_id, pms_family, dimension, raw_value)
       values ($1,'choice_advantage','rate_plan','booking.com')`,
      [PROPERTY],
    );
    assert.equal(err, null);
  });

  test('a made-up dimension is refused', async () => {
    const err = await rejects(
      `insert into public.pms_dimension_values(property_id, pms_family, dimension, raw_value)
       values ($1,'choice_advantage','vibes','whatever')`,
      [PROPERTY],
    );
    assert.match(String(err), /pms_dimension_values_dimension_chk/);
  });

  test('a resolution cannot exist without saying when it happened', async () => {
    const err = await rejects(
      `insert into public.pms_dimension_values(property_id, pms_family, dimension, raw_value, canonical_code)
       values ($1,'choice_advantage','channel','Expedia','EXPEDIA')`,
      [PROPERTY],
    );
    assert.match(String(err), /pms_dimension_values_resolution_chk/);
  });
});

describe('0348 — the dead tables are gone', () => {
  test('every dropped table is absent', async () => {
    const { rows } = await pg.query(`
      select table_name from information_schema.tables
       where table_schema='public' and table_name in (
         'compliance_anomaly_alerts','compliance_readings','compliance_pm_checks',
         'compliance_pm_tasks','compliance_reading_types','mapping_takeover_steps',
         'sms_jobs','processed_twilio_webhooks','pull_metrics','pms_sync_alert_state'
       )
    `) as { rows: unknown[] };
    assert.deepEqual(rows, []);
  });

  test('the last voice remnants are off the pms_* schema', async () => {
    const { rows } = await pg.query(`
      select column_name from information_schema.columns
       where table_schema='public' and table_name='pms_work_orders_v2'
         and column_name in ('voice_session_id','voice_metadata')
    `) as { rows: unknown[] };
    assert.deepEqual(rows, []);
  });

  test('the alive-but-robot-pointed tables are deliberately still here', async () => {
    // Removing these is a code-deletion project (the CUA retirement
    // workstream), not a schema reshape — every one has live callers.
    for (const t of ['property_sessions', 'workflow_jobs', 'scraper_session',
                     'scraper_credentials', 'pull_jobs', 'pms_sync_echo',
                     'pms_writeback_recipes', 'cleaning_tasks', 'hk_assignments',
                     'plan_snapshots']) {
      const { rows } = await pg.query(
        `select to_regclass($1) is not null as present`, [`public.${t}`],
      ) as { rows: Array<{ present: boolean }> };
      assert.equal(rows[0]!.present, true, `${t} must NOT be dropped by this workstream`);
    }
  });
});
