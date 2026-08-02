import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import type { PGlite } from '@electric-sql/pglite';
import { applyMigrationsToPgliteWithHook } from '../../../tests/fixtures/pglite-migrate';
import { buildStandardTestRoomNumbers } from '@/lib/test-room-roster';

const OWNER = 'b1000000-0000-4000-8000-000000000001';
const ZERO_TEST = 'b2000000-0000-4000-8000-000000000001';
const PARTIAL_TEST = 'b2000000-0000-4000-8000-000000000002';
const MALFORMED_TEST = 'b2000000-0000-4000-8000-000000000003';
const REAL_PROPERTY = 'b2000000-0000-4000-8000-000000000004';
const LEGACY_RUN = 'b3000000-0000-4000-8000-000000000001';
const MALFORMED_RUN = 'b3000000-0000-4000-8000-000000000002';
const ZERO_TEST_74 = 'b2000000-0000-4000-8000-000000000005';

let pg: PGlite;

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
           ($6, $5, 'Zero Test Hotel 74', 74, 'America/Chicago', true, '{}')
         on conflict (id) do nothing`,
        [ZERO_TEST, PARTIAL_TEST, MALFORMED_TEST, REAL_PROPERTY, OWNER, ZERO_TEST_74],
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

  test('extends the 40-room prefix to exactly 50 without changing existing status data', async () => {
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
      await rows<{ status: string; source: string }>(
        "select status, source from public.pms_room_status_log where property_id = $1 and room_number = '103'",
        [PARTIAL_TEST],
      ),
      [{ status: 'vacant_dirty', source: 'manual' }],
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
});
