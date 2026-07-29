import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { PGlite } from '@electric-sql/pglite';

import { applyMigrationsToPglite } from '../../../tests/fixtures/pglite-migrate';
import {
  PID_A1,
  PID_B1,
  UID_ANA,
  seedTwoCompanies,
} from '../../../tests/fixtures/pglite-two-company-seed';

const BUSINESS_DATE = '2026-07-27';

let pg: PGlite;

async function asRole(
  role: 'authenticated' | 'anon' | 'service_role',
  userId: string | null,
  sql: string,
  params: unknown[] = [],
): Promise<Array<Record<string, unknown>>> {
  await pg.exec('begin');
  try {
    await pg.exec(`set local role ${role}`);
    if (userId) await pg.query(`select set_config('request.jwt.claim.sub', $1, true)`, [userId]);
    await pg.query(`select set_config('request.jwt.claim.role', $1, true)`, [role]);
    await pg.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({
      ...(userId ? { sub: userId } : {}),
      role,
      mfa_verified: true,
    })]);
    const result = await pg.query(sql, params) as { rows: Array<Record<string, unknown>> };
    await pg.exec('commit');
    return result.rows;
  } catch (error) {
    await pg.exec('rollback').catch(() => undefined);
    throw error;
  }
}

async function seedPmsProperty(propertyId: string, roomNumber: string, housekeeper: string) {
  const run = await pg.query<{ id: string }>(
    `insert into public.pms_ingest_runs(
       property_id,source_kind,mode,parser_name,parser_version,
       source_captured_at,finished_at,status
     ) values ($1,'cua','live','tenant-boundary-test','v1',
       '2026-07-27T08:00:00Z','2026-07-27T08:01:00Z','succeeded')
     returning id`,
    [propertyId],
  );
  const ingestRunId = run.rows[0].id;
  await pg.query(
    `insert into public.pms_rooms_inventory(property_id,room_number,ingest_run_id)
     values ($1,$2,$3)`,
    [propertyId, roomNumber, ingestRunId],
  );
  await pg.query(
    `insert into public.pms_room_status_log(
       property_id,room_number,status,changed_at,source,ingest_run_id
     ) values ($1,$2,'occupied','2026-07-27T08:00:00Z','cua',$3)`,
    [propertyId, roomNumber, ingestRunId],
  );
  await pg.query(
    `insert into public.pms_reservations(
       property_id,pms_reservation_id,room_number,arrival_date,departure_date,status,
       ingest_run_id
     ) values ($1,$2,$3,'2026-07-26','2026-07-29','checked_in',$4)`,
    [propertyId, `reservation-${roomNumber}`, roomNumber, ingestRunId],
  );
  await pg.query(
    `insert into public.pms_housekeeping_assignments(
       property_id,date,room_number,housekeeper_name,ingest_run_id
     ) values ($1,$2,$3,$4,$5)`,
    [propertyId, BUSINESS_DATE, roomNumber, housekeeper, ingestRunId],
  );
  await pg.query(
    `insert into public.pms_occupancy_observation(
       property_id,total_occupied_rooms,total_vacant_clean,total_vacant_dirty,total_ooo,
       observed_at,observed_at_source,business_date,ingest_run_id
     ) values ($1,1,0,0,0,'2026-07-27T08:00:00Z','robot_capture',$2,$3)`,
    [propertyId, BUSINESS_DATE, ingestRunId],
  );
}

before(async () => {
  const migrated = await applyMigrationsToPglite();
  assert.equal(
    migrated.report.failedAtRuntime.some((failure) => failure.file.startsWith('0398_')),
    false,
    `0398 must apply: ${JSON.stringify(migrated.report.failedAtRuntime)}`,
  );
  pg = migrated.pg;
  await seedTwoCompanies(pg);
  await seedPmsProperty(PID_A1, '101', 'Authorized Housekeeper');
  await seedPmsProperty(PID_B1, '901', 'Secret Housekeeper');
});

after(async () => {
  await pg?.close();
});

describe('0398 privileged RPC tenant boundaries', () => {
  test('authenticated today bridges return own-hotel data and zero rows for direct-ID tampering', async () => {
    const ownRooms = await asRole(
      'authenticated',
      UID_ANA,
      `select room_number,housekeeper from public.today_room_work_v1($1,$2)`,
      [PID_A1, BUSINESS_DATE],
    );
    assert.deepEqual(ownRooms, [{ room_number: '101', housekeeper: 'Authorized Housekeeper' }]);
    const foreignRooms = await asRole(
      'authenticated',
      UID_ANA,
      `select room_number,housekeeper from public.today_room_work_v1($1,$2)`,
      [PID_B1, BUSINESS_DATE],
    );
    assert.deepEqual(foreignRooms, []);

    const ownCounts = await asRole(
      'authenticated',
      UID_ANA,
      `select total_rooms,in_house from public.today_property_counts_v1($1,$2)`,
      [PID_A1, BUSINESS_DATE],
    );
    assert.deepEqual(ownCounts, [{ total_rooms: 1, in_house: 1 }]);
    const foreignCounts = await asRole(
      'authenticated',
      UID_ANA,
      `select total_rooms,in_house from public.today_property_counts_v1($1,$2)`,
      [PID_B1, BUSINESS_DATE],
    );
    assert.deepEqual(foreignCounts, []);
  });

  test('service role retains today bridge access and anonymous callers cannot execute', async () => {
    const service = await asRole(
      'service_role',
      null,
      `select room_number,housekeeper from public.today_room_work_v1($1,$2)`,
      [PID_B1, BUSINESS_DATE],
    );
    assert.deepEqual(service, [{ room_number: '901', housekeeper: 'Secret Housekeeper' }]);
    await assert.rejects(
      asRole(
        'anon',
        null,
        `select * from public.today_room_work_v1($1,$2)`,
        [PID_A1, BUSINESS_DATE],
      ),
      /permission denied/i,
    );
  });

  test('fleet/global mutation functions are not executable by browser roles', async () => {
    const signatures = [
      'public.project_property_counts_v1(uuid,date)',
      'public.staxis_active_property_ids_for_nudges(integer)',
      'public.staxis_install_demand_supply_cold_start(uuid,text,text,jsonb,jsonb)',
      'public.staxis_walkthrough_start(uuid,uuid,text)',
      'public.staxis_walkthrough_step(uuid,uuid,uuid)',
      'public.staxis_walkthrough_end(uuid,text)',
      'public.staxis_walkthrough_heal_stale(boolean)',
      'public.cleanup_idempotency_log()',
    ];
    for (const signature of signatures) {
      const result = await pg.query<{ browser: boolean; anonymous: boolean; service: boolean }>(
        `select has_function_privilege('authenticated',$1,'EXECUTE') as browser,
                has_function_privilege('anon',$1,'EXECUTE') as anonymous,
                has_function_privilege('service_role',$1,'EXECUTE') as service`,
        [signature],
      );
      assert.deepEqual(result.rows[0], {
        browser: false,
        anonymous: false,
        service: true,
      }, signature);
    }
  });
});
