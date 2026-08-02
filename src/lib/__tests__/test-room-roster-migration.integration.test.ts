import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import type { PGlite } from '@electric-sql/pglite';
import { applyMigrationsToPgliteWithHook } from '../../../tests/fixtures/pglite-migrate';
import { buildStandardTestRoomNumbers } from '@/lib/test-room-roster';

const OWNER = 'b1000000-0000-4000-8000-000000000001';
const ZERO_TEST = '96a26a7f-7129-47db-8855-b7b34407b843';
const PARTIAL_TEST = 'c7ec4be3-ba00-4ff0-bc69-c7e09d8e4f8f';
const MALFORMED_TEST = 'b2000000-0000-4000-8000-000000000003';
const REAL_PROPERTY = 'b2000000-0000-4000-8000-000000000004';
const LEGACY_RUN = 'b3000000-0000-4000-8000-000000000001';
const MALFORMED_RUN = 'b3000000-0000-4000-8000-000000000002';
const ZERO_TEST_74 = 'cc000003-0000-4000-8000-000000000003';
const OUTSIDE_ALLOWLIST_TEST = 'b2000000-0000-4000-8000-000000000006';
const OVERLAP_TEST = 'b2000000-0000-4000-8000-000000000007';

type JsonRow = Record<string, unknown>;

let pg: PGlite;
let partialCanonicalBefore: JsonRow[] = [];
let partialStatusBefore: JsonRow[] = [];

async function rows<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const result = (await pg.query(sql, params)) as { rows: T[] };
  return result.rows;
}

async function scalar<T>(sql: string, params: unknown[] = []): Promise<T> {
  const result = await rows<Record<string, unknown>>(sql, params);
  assert.ok(result[0], 'expected one database row');
  return Object.values(result[0])[0] as T;
}

describe('0425 test-property canonical roster restoration', () => {
  before(async () => {
    const migrated = await applyMigrationsToPgliteWithHook(async ({ pg: db, file }) => {
      if (file !== '0425_test_property_room_roster_backfill.sql') return;

      await db.query(
        "insert into auth.users(id, email) values ($1, 'room-roster-owner@example.test') on conflict (id) do nothing",
        [OWNER],
      );
      await db.query(
        `insert into public.properties(id, owner_id, name, total_rooms, timezone, is_test, room_inventory)
         values
           ($1, $5, 'Zero Test Hotel', 62, 'America/Chicago', true, '{}'),
           ($2, $5, 'Partial Test Hotel', 50, 'America/Chicago', true, '{}'),
           ($3, $5, 'Malformed Test Hotel', 2, 'America/Chicago', true, '{}'),
           ($4, $5, 'Real Customer Hotel', 103, 'America/Chicago', false, '{}'),
           ($6, $5, 'Zero Test Hotel 74', 74, 'America/Chicago', true, '{}'),
           ($7, $5, 'Outside Allowlist Test Hotel', 62, 'America/Chicago', true, '{}')
         on conflict (id) do nothing`,
        [ZERO_TEST, PARTIAL_TEST, MALFORMED_TEST, REAL_PROPERTY, OWNER, ZERO_TEST_74, OUTSIDE_ALLOWLIST_TEST],
      );
      await db.query(
        `insert into public.pms_ingest_runs(
           id, property_id, source_kind, mode, parser_name, parser_version,
           source_captured_at, started_at, finished_at, status
         ) values ($1, $2, 'legacy', 'live', 'fixture', 'fixture-v1', now(), now(), now(), 'succeeded')
         on conflict (id) do nothing`,
        [LEGACY_RUN, PARTIAL_TEST],
      );
      await db.query(
        `insert into public.pms_ingest_runs(
           id, property_id, source_kind, mode, parser_name, parser_version,
           source_captured_at, started_at, finished_at, status
         ) values ($1, $2, 'legacy', 'live', 'fixture', 'fixture-v1', now(), now(), now(), 'succeeded')
         on conflict (id) do nothing`,
        [MALFORMED_RUN, MALFORMED_TEST],
      );
      await db.query(
        `insert into public.pms_rooms_inventory(property_id, room_number, last_synced_at, ingest_run_id)
         select $1, ((ordinal / 10 + 1)::text || lpad((ordinal % 10 + 1)::text, 2, '0')), now(), $2
           from generate_series(0, 39) as generated(ordinal)`,
        [PARTIAL_TEST, LEGACY_RUN],
      );
      await db.query(
        `insert into public.pms_room_status_log(
           property_id, room_number, status, changed_at, source, last_synced_at, ingest_run_id
         ) values ($1, '103', 'vacant_dirty', now(), 'manual', now(), $2)`,
        [PARTIAL_TEST, LEGACY_RUN],
      );
      await db.query(
        `insert into public.pms_rooms_inventory(property_id, room_number, last_synced_at, ingest_run_id)
         values ($1, 'Z9', now(), $2)`,
        [MALFORMED_TEST, MALFORMED_RUN],
      );
      await db.query(
        `update public.properties
            set room_inventory = (
              select array_agg(
                       ((ordinal / 10 + 1)::text || lpad((ordinal % 10 + 1)::text, 2, '0'))
                       order by ordinal
                     )
                from generate_series(0, 39) as generated(ordinal)
            )
          where id = $1`,
        [PARTIAL_TEST],
      );
      await db.query(
        'update public.properties set total_rooms = 50 where id = $1',
        [PARTIAL_TEST],
      );
      const canonicalBefore = await db.query<{ row: JsonRow }>(
        `select to_jsonb(inventory) as row
           from public.pms_rooms_inventory inventory
          where property_id = $1
          order by room_number`,
        [PARTIAL_TEST],
      );
      partialCanonicalBefore = canonicalBefore.rows.map(({ row }) => row);
      const statusBefore = await db.query<{ row: JsonRow }>(
        `select to_jsonb(status_row) as row
           from public.pms_room_status_log status_row
          where property_id = $1
          order by room_number, changed_at, id`,
        [PARTIAL_TEST],
      );
      partialStatusBefore = statusBefore.rows.map(({ row }) => row);
    });
    pg = migrated.pg;
    assert.ok(
      migrated.report.applied.includes('0425_test_property_room_roster_backfill.sql'),
      JSON.stringify(migrated.report.failedAtRuntime.filter((entry) => entry.file.startsWith('0425'))),
    );
    assert.deepEqual(
      migrated.report.failedAtRuntime.filter((entry) => entry.file.startsWith('0425')),
      [],
    );
  });

  after(async () => {
    await pg.close();
  });

  test('restores exact deterministic count, lineage, and mirror for an empty test hotel', async () => {
    for (const [propertyId, totalRooms] of [[ZERO_TEST, 62], [ZERO_TEST_74, 74]] as const) {
      assert.equal(
        await scalar<number>(
          'select count(*)::integer from public.pms_rooms_inventory where property_id = $1',
          [propertyId],
        ),
        totalRooms,
      );
      assert.deepEqual(
        await rows<{ room_number: string }>(
          "select room_number from public.pms_rooms_inventory where property_id = $1 order by room_number",
          [propertyId],
        ),
        buildStandardTestRoomNumbers(totalRooms).sort().map((room_number) => ({ room_number })),
      );
      assert.deepEqual(
        await rows<{ room_inventory: string[] }>(
          'select room_inventory from public.properties where id = $1',
          [propertyId],
        ),
        [{ room_inventory: buildStandardTestRoomNumbers(totalRooms) }],
      );
      assert.equal(
        await scalar<number>(
          `select count(*)::integer
             from public.pms_rooms_inventory inventory
             join public.pms_ingest_runs run on run.id = inventory.ingest_run_id
            where inventory.property_id = $1
              and run.source_kind = 'manual_backfill'
              and run.parser_version = '0425-v1'`,
          [propertyId],
        ),
        totalRooms,
      );
    }
  });

  test('extends the proven non-empty 40-room prefix to exactly 50', async () => {
    assert.equal(
      await scalar<number>(
        'select count(*)::integer from public.pms_rooms_inventory where property_id = $1',
        [PARTIAL_TEST],
      ),
      50,
    );
    assert.deepEqual(
      await rows<{ room_number: string }>(
        "select room_number from public.pms_rooms_inventory where property_id = $1 and room_number >= '501' order by room_number",
        [PARTIAL_TEST],
      ),
      buildStandardTestRoomNumbers(50).slice(-10).map((room_number) => ({ room_number })),
    );
    assert.deepEqual(
      await rows<{ row: JsonRow }>(
        `select to_jsonb(inventory) as row
           from public.pms_rooms_inventory inventory
          where property_id = $1
            and room_number < '501'
          order by room_number`,
        [PARTIAL_TEST],
      ),
      partialCanonicalBefore.map((row) => ({ row })),
    );
    assert.deepEqual(
      await rows<{ row: JsonRow }>(
        `select to_jsonb(status_row) as row
           from public.pms_room_status_log status_row
          where property_id = $1
          order by room_number, changed_at, id`,
        [PARTIAL_TEST],
      ),
      partialStatusBefore.map((row) => ({ row })),
    );
    assert.deepEqual(
      await rows<{ room_inventory: string[] }>(
        'select room_inventory from public.properties where id = $1',
        [PARTIAL_TEST],
      ),
      [{ room_inventory: buildStandardTestRoomNumbers(50) }],
    );
  });

  test('leaves non-generated test data and every real property untouched', async () => {
    assert.deepEqual(
      await rows<{ room_number: string }>(
        'select room_number from public.pms_rooms_inventory where property_id = $1',
        [MALFORMED_TEST],
      ),
      [{ room_number: 'Z9' }],
    );
    assert.equal(
      await scalar<number>(
        'select count(*)::integer from public.pms_rooms_inventory where property_id = $1',
        [REAL_PROPERTY],
      ),
      0,
    );
    assert.deepEqual(
      await rows<{ room_inventory: string[]; total_rooms: number }>(
        'select room_inventory, total_rooms from public.properties where id = $1',
        [REAL_PROPERTY],
      ),
      [{ room_inventory: [], total_rooms: 103 }],
    );
    assert.equal(
      await scalar<number>(
        "select count(*)::integer from public.pms_ingest_runs where property_id = $1 and parser_version = '0425-v1'",
        [OUTSIDE_ALLOWLIST_TEST],
      ),
      0,
    );
    assert.deepEqual(
      await rows<{ room_inventory: string[]; total_rooms: number }>(
        'select room_inventory, total_rooms from public.properties where id = $1',
        [OUTSIDE_ALLOWLIST_TEST],
      ),
      [{ room_inventory: [], total_rooms: 62 }],
    );
  });

  test('is idempotent and does not create another receipt on replay', async () => {
    const result = await rows<{ inserted: number }>(
      'select public.staxis_restore_test_room_roster($1, $2::text[]) as inserted',
      [ZERO_TEST, buildStandardTestRoomNumbers(62)],
    );
    assert.deepEqual(result, [{ inserted: 0 }]);
    assert.equal(
      await scalar<number>(
        "select count(*)::integer from public.pms_ingest_runs where property_id = $1 and parser_version = '0425-v1'",
        [ZERO_TEST],
      ),
      1,
    );
  });

  test('creates an explicit test property and its canonical roster atomically', async () => {
    const createdRows = await rows<{
      created: { id: string; name: string; created_at: string };
    }>(
      `select public.staxis_create_test_property_with_roster(
         $1, $2, $3, $4, $5, $6, $7, $8::text[]
       ) as created`,
      [
        OWNER,
        'Atomic Test Hotel',
        50,
        'America/Chicago',
        null,
        null,
        'limited_service',
        buildStandardTestRoomNumbers(50),
      ],
    );
    const atomicPropertyId = createdRows[0]?.created.id;
    assert.ok(atomicPropertyId, 'atomic creation must return the property id');
    assert.deepEqual(
      await rows<{ room_inventory: string[]; is_test: boolean }>(
        'select room_inventory, is_test from public.properties where id = $1',
        [atomicPropertyId],
      ),
      [{ room_inventory: buildStandardTestRoomNumbers(50), is_test: true }],
    );
    assert.equal(
      await scalar<number>(
        'select count(*)::integer from public.pms_rooms_inventory where property_id = $1',
        [atomicPropertyId],
      ),
      50,
    );
    assert.equal(
      await scalar<number>(
        `select count(*)::integer
           from public.pms_rooms_inventory inventory
           join public.pms_ingest_runs run on run.id = inventory.ingest_run_id
          where inventory.property_id = $1
            and run.parser_version = '0425-v1'`,
        [atomicPropertyId],
      ),
      50,
    );
  });

  test('rolls back an atomic test-property shell when the roster is invalid', async () => {
    await assert.rejects(() => pg.query(
      `select public.staxis_create_test_property_with_roster(
         $1, $2, $3, $4, $5, $6, $7, $8::text[]
       )`,
      [OWNER, 'Rejected Atomic Test Hotel', 50, 'America/Chicago', null, null, 'limited_service', ['501']],
    ));
    assert.equal(
      await scalar<number>(
        "select count(*)::integer from public.properties where name = 'Rejected Atomic Test Hotel'",
      ),
      0,
    );
    assert.equal(
      await scalar<number>(
        "select count(*)::integer from public.pms_ingest_runs where parser_version = '0425-v1' and property_id not in (select id from public.properties)",
      ),
      0,
    );
  });

  test('keeps the service-only capabilities closed to ordinary clients', async () => {
    const privileges = await rows<{
      anon_execute: boolean;
      authenticated_execute: boolean;
      service_execute: boolean;
    }>(
      `select
         has_function_privilege('anon', $1, 'execute') as anon_execute,
         has_function_privilege('authenticated', $1, 'execute') as authenticated_execute,
         has_function_privilege('service_role', $1, 'execute') as service_execute`,
      ['public.staxis_create_test_property_with_roster(uuid,text,integer,text,text,text,text,text[])'],
    );
    assert.deepEqual(privileges, [{ anon_execute: false, authenticated_execute: false, service_execute: true }]);
  });

  test('overlapping restore calls converge to one canonical set and one receipt', async () => {
    // PGlite exposes one SQL session, so Promise.all exercises overlapping
    // application calls but cannot prove two-session lock blocking. The
    // production function uses the property-row FOR UPDATE lock; a live
    // PostgreSQL two-session check remains a release-environment validation.
    await pg.query(
      `insert into public.properties(id, owner_id, name, total_rooms, timezone, is_test, room_inventory)
       values ($1, $2, 'Overlap Test Hotel', 62, 'America/Chicago', true, '{}')`,
      [OVERLAP_TEST, OWNER],
    );
    const results = await Promise.all([
      pg.query<{ inserted: number }>(
        'select public.staxis_restore_test_room_roster($1, $2::text[]) as inserted',
        [OVERLAP_TEST, buildStandardTestRoomNumbers(62)],
      ),
      pg.query<{ inserted: number }>(
        'select public.staxis_restore_test_room_roster($1, $2::text[]) as inserted',
        [OVERLAP_TEST, buildStandardTestRoomNumbers(62)],
      ),
    ]);
    assert.deepEqual(
      results.map((result) => Number(result.rows[0]?.inserted)).sort((a, b) => a - b),
      [0, 62],
    );
    assert.equal(
      await scalar<number>(
        'select count(*)::integer from public.pms_rooms_inventory where property_id = $1',
        [OVERLAP_TEST],
      ),
      62,
    );
    assert.equal(
      await scalar<number>(
        "select count(*)::integer from public.pms_ingest_runs where property_id = $1 and parser_version = '0425-v1'",
        [OVERLAP_TEST],
      ),
      1,
    );
  });
});
