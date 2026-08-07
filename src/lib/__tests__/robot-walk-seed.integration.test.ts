/**
 * SEEDING THE HOTEL THE ROBOT WALKS.
 *
 * The seed runs by hand, against production, and its whole job is to be safe to
 * run again: the operator reruns it to rotate the robot's password, and a
 * second Robot Hotel or a second Robot Manager would be a mess somebody has to
 * clean up by hand in a live database.
 *
 * So this drives the REAL seed function against a REAL schema — every
 * `supabase/migrations/*.sql` applied to PGlite, through the PostgREST shim —
 * rather than against a mock of the database. That is what makes the checks
 * below about the constraints and access RPCs that actually exist:
 *
 *   • running it twice creates one hotel, one manager, one roster,
 *   • the manager can reach that hotel and nothing else,
 *   • the account carries no `property_access`, which the access cutover's
 *     trigger rejects outright (a seed that wrote it would fail in production
 *     and nowhere else),
 *   • the colleague is somebody a to-do can actually be handed to. Housekeepers
 *     are excluded from the assignee list by design, so a housekeeper here
 *     would leave the walk's assign step failing every night for a reason that
 *     is not a bug.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-min-20-chars';

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { PGlite } from '@electric-sql/pglite';

import { applyMigrationsToPglite } from '../../../tests/fixtures/pglite-migrate';
import { loadCatalog, createPglitePostgrest } from '../../../tests/fixtures/postgrest-pglite';
import { seedTwoCompanies, ORG_A } from '../../../tests/fixtures/pglite-two-company-seed';
import {
  seedRobotHotel,
  ROBOT_COLLEAGUE_NAME,
  ROBOT_HOTEL_NAME,
  ROBOT_MANAGER_DISPLAY,
  ROBOT_MANAGER_USERNAME,
  type SeedAuth,
  type SeedDb,
  type SeedResult,
} from '../../../scripts/robot-walk/seed';
import { isAssignable } from '@/lib/worklist/assignable';

const ROBOT_UID = 'b0b07000-0000-4000-8000-000000000001';
const PASSWORD = 'a-long-enough-robot-password';

let pg: PGlite;
let db: SeedDb;
let auth: SeedAuth;
let authCalls: Array<{ email: string; password: string }> = [];

before(async () => {
  const applied = await applyMigrationsToPglite();
  pg = applied.pg;
  assert.ok(
    applied.report.applied.length > 300,
    `only ${applied.report.applied.length} migrations applied — the schema under test is not the real one`,
  );
  await seedTwoCompanies(pg);

  const catalog = await loadCatalog(pg);
  db = createPglitePostgrest(pg, catalog) as unknown as SeedDb;

  auth = {
    async ensureUser({ email, password }) {
      authCalls.push({ email, password });
      await pg.query(
        `insert into auth.users (id, email) values ($1, $2) on conflict (id) do nothing`,
        [ROBOT_UID, email],
      );
      return ROBOT_UID;
    },
  };
});

async function run(password = PASSWORD): Promise<SeedResult> {
  return seedRobotHotel(db, auth, {
    password,
    organizationId: ORG_A,
    // The fixture's Staxis administrator, who is the actor for every authority
    // change exactly as the real admin is in production.
    adminUsername: 'staxis',
  });
}

// Close it explicitly. An in-memory Postgres left open at process exit takes
// the whole run down with a wasm abort, and the suite then reports a file that
// passed every check as failed.
after(async () => { await pg?.close(); });

async function count(sql: string, params: unknown[] = []): Promise<number> {
  const res = await pg.query<{ n: string }>(sql, params);
  return Number(res.rows[0]?.n ?? 0);
}

describe('seeding the robot hotel', () => {
  let first: SeedResult;

  test('the first run builds the hotel, the manager and the roster', async () => {
    first = await run();

    assert.ok(first.propertyId);
    assert.equal(first.propertyCreated, true);

    const hotel = await pg.query<{ is_test: boolean; enabled_sections: unknown; name: string }>(
      `select is_test, enabled_sections, name from properties where id = $1`,
      [first.propertyId],
    );
    assert.equal(hotel.rows[0]?.name, ROBOT_HOTEL_NAME);
    assert.equal(hotel.rows[0]?.is_test, true, 'a robot hotel that is not a test hotel joins the real fleet');
    assert.equal(
      hotel.rows[0]?.enabled_sections,
      null,
      'a partial section map makes the server gate fail closed with a 503',
    );
  });

  test('the hotel is governed by the management company, not by its own anchor', async () => {
    // The exclusion that keeps scheduled company passes off this hotel is
    // "every hotel this company governs is a test hotel", and it can only apply
    // to a hotel the company actually governs.
    const primary = await pg.query<{ organization_id: string }>(
      `select organization_id from organization_property_relationships
        where property_id = $1 and ends_at is null and is_primary_grouping`,
      [first.propertyId],
    );
    assert.equal(primary.rows.length, 1, 'a hotel must have exactly one primary company');
    assert.equal(primary.rows[0].organization_id, ORG_A);
  });

  test('the manager is a general manager with no legacy access column', async () => {
    const account = await pg.query<{ role: string; property_access: unknown; skip_2fa: boolean; active: boolean }>(
      `select role, property_access, skip_2fa, active from accounts where username = $1`,
      [ROBOT_MANAGER_USERNAME],
    );
    assert.equal(account.rows.length, 1);
    assert.equal(account.rows[0].role, 'general_manager', 'anything less cannot open the staff list');
    assert.equal(account.rows[0].property_access, null, 'the cutover trigger rejects a written property_access');
    assert.equal(account.rows[0].skip_2fa, true);
    assert.equal(account.rows[0].active, true);
  });

  test('the manager can reach the robot hotel and nothing else', async () => {
    // The RPC is what the app itself asks at every request, so this is the
    // same answer a sign-in would get rather than a peek at storage.
    const listed = await pg.query<{ result: unknown }>(
      `select to_jsonb(staxis_list_account_authorized_properties($1)) as result`,
      [first.managerAccountId],
    );
    const answer = JSON.stringify(listed.rows[0]?.result ?? null);
    assert.ok(answer.includes(first.propertyId), `the manager cannot reach the robot hotel: ${answer}`);
    for (const otherHotel of ['a1a1a1a1-0000-4000-8000-000000000001', 'b1b1b1b1-0000-4000-8000-000000000001']) {
      assert.ok(!answer.includes(otherHotel), 'the manager can reach somebody else’s hotel');
    }
  });

  test('there is somebody to hand a to-do to', async () => {
    const roster = await pg.query<{ name: string; department: string; is_active: boolean }>(
      `select name, department, is_active from staff where property_id = $1 order by name`,
      [first.propertyId],
    );
    const names = roster.rows.map((r) => r.name);
    assert.ok(names.includes(ROBOT_MANAGER_DISPLAY));
    assert.ok(names.includes(ROBOT_COLLEAGUE_NAME));

    const colleague = roster.rows.find((r) => r.name === ROBOT_COLLEAGUE_NAME)!;
    assert.equal(
      isAssignable({ department: colleague.department, is_active: colleague.is_active }),
      true,
      `${colleague.department} is excluded from the assignee list, so the walk could never hand anything over`,
    );
  });

  test('the manager is linked to their own roster identity', async () => {
    const linked = await pg.query<{ staff_id: string | null }>(
      `select staff_id from accounts where id = $1`,
      [first.managerAccountId],
    );
    assert.equal(linked.rows[0]?.staff_id, first.managerStaffId);
  });

  test('running it again changes nothing and duplicates nobody', async () => {
    // The operator reruns this to rotate the password. A second hotel or a
    // second manager here is a live database somebody has to repair by hand.
    authCalls = [];
    const second = await run('a-different-robot-password');

    assert.equal(second.propertyId, first.propertyId);
    assert.equal(second.propertyCreated, false);
    assert.equal(second.managerAccountId, first.managerAccountId);
    assert.equal(second.colleagueStaffId, first.colleagueStaffId);

    assert.equal(await count(`select count(*) as n from properties where name = $1`, [ROBOT_HOTEL_NAME]), 1);
    assert.equal(await count(`select count(*) as n from accounts where username = $1`, [ROBOT_MANAGER_USERNAME]), 1);
    assert.equal(await count(`select count(*) as n from staff where property_id = $1`, [first.propertyId]), 2);
    assert.equal(
      await count(
        `select count(*) as n from organization_property_relationships
          where property_id = $1 and ends_at is null and is_primary_grouping`,
        [first.propertyId],
      ),
      1,
      'a second primary grouping breaks every access lookup for this hotel',
    );

    assert.deepEqual(
      authCalls.map((c) => c.password),
      ['a-different-robot-password'],
      'the rerun did not rotate the password, which is the reason to rerun it',
    );
  });

  test('a password too short to be worth having is refused before anything is written', async () => {
    await assert.rejects(
      () => seedRobotHotel(db, auth, { password: 'short', organizationId: ORG_A, adminUsername: 'staxis' }),
      /at least 12 characters/,
    );
  });

  test('every query the seed made was one the shim could actually compile', () => {
    // A silently-unsupported builder call would make the assertions above pass
    // against statements that never ran.
    const shim = db as unknown as { unsupported: string[] };
    assert.deepEqual(shim.unsupported, []);
  });
});
