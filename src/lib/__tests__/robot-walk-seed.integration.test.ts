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
 *
 * ─── AND IT RUNS AS service_role, WHICH IS THE WHOLE POINT ─────────────────
 *
 * The first version of this file ran as the PGlite superuser, which owns every
 * table. Owners are not subject to GRANTs, so the suite was structurally unable
 * to see a permission denial — and the first real run against production died
 * partway through with `42501: permission denied for table
 * account_authorization_state`, having already created a hotel, an auth user
 * and an account. Stage C leaves service_role with no direct access to the
 * authority tables; everything goes through SECURITY DEFINER functions.
 *
 * The seed therefore runs here under `set role service_role`, the same role the
 * service key has in production, and `the tables Stage C keeps to itself` below
 * pins the denial itself so nobody quietly reintroduces a direct read.
 *
 * ─── AND IT RESUMES ────────────────────────────────────────────────────────
 *
 * `resuming after the run that died at the access grant` rebuilds the exact
 * partial state that failure left behind and reruns from it. That state is not
 * hypothetical: it is in production right now, and the rerun has to adopt it
 * rather than build a second copy of everything.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-min-20-chars';

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { PGlite } from '@electric-sql/pglite';

import { applyMigrationsToPglite } from '../../../tests/fixtures/pglite-migrate';
import { loadCatalog, createPglitePostgrest } from '../../../tests/fixtures/postgrest-pglite';
import { seedTwoCompanies, ACCOUNT_ADMIN, ORG_A } from '../../../tests/fixtures/pglite-two-company-seed';
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
/** The fixture's Staxis administrator, the actor for every authority change. */
const adminAccountId = ACCOUNT_ADMIN;

// ═══════════════════════════════════════════════════════════════════════════
// Giving PGlite production's grants
// ═══════════════════════════════════════════════════════════════════════════
//
// Supabase hands `service_role` everything in `public` by default, and each
// migration then takes specific things back — 0378 revokes
// `account_authorization_state`, and Stage C hands out SECURITY DEFINER
// functions in its place. PGlite has the migrations but not the default, so
// without this every table is denied and the simulation is useless in the
// opposite direction: it would "catch" denials production does not have, and
// the real ones would be invisible in the noise.
//
// So: apply the baseline, then replay every grant and revoke the migrations
// aim at service_role, in file order. The end state is the production one, and
// it is DERIVED from the migrations rather than transcribed from them, so a
// future migration that moves a grant travels into this file for free.

/** Strip dollar-quoted function bodies and line comments. */
function executableSql(sql: string): string {
  return sql
    .replace(/\$([a-zA-Z_]*)\$[\s\S]*?\$\1\$/g, "''")
    .replace(/--[^\n]*/g, '');
}

function serviceRolePermissionStatements(): string[] {
  const dir = 'supabase/migrations';
  const out: string[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    for (const raw of executableSql(readFileSync(join(dir, file), 'utf8')).split(';')) {
      const statement = raw.trim();
      if (!/^(grant|revoke)\b/i.test(statement)) continue;
      if (!/\bservice_role\b/.test(statement)) continue;
      out.push(`${statement};`);
    }
  }
  return out;
}

async function applyProductionGrants(target: PGlite): Promise<void> {
  await target.exec(`
    grant usage on schema public to service_role;
    grant all on all tables in schema public to service_role;
    grant all on all sequences in schema public to service_role;
    grant execute on all functions in schema public to service_role;
  `);
  for (const statement of serviceRolePermissionStatements()) {
    // A statement naming an object a runtime-failed migration never created is
    // not a drift signal, it is that migration's failure showing up twice.
    await target.exec(statement).catch(() => undefined);
  }
}

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
  await applyProductionGrants(pg);

  const catalog = await loadCatalog(pg);
  db = createPglitePostgrest(pg, catalog) as unknown as SeedDb;

  auth = {
    async ensureUser({ email, password }) {
      authCalls.push({ email, password });
      // In production this is the Auth Admin API over HTTP, not a database
      // write, so it is deliberately not subject to service_role's table
      // grants. Stepping out of the role here keeps the simulation honest in
      // BOTH directions: the seed's own SQL stays constrained, and this does
      // not fail for a reason production would never hit.
      await pg.exec('reset role;');
      await pg.query(
        `insert into auth.users (id, email) values ($1, $2) on conflict (id) do nothing`,
        [ROBOT_UID, email],
      );
      await pg.exec('set role service_role;');
      return ROBOT_UID;
    },
  };
});

/**
 * Run something as the role the service key actually has.
 *
 * PGlite's default user OWNS every table, and an owner is not subject to
 * GRANTs. That is not a detail: it is why the first version of this file could
 * not have caught the 42501 that killed the first production run. Everything
 * the seed does runs in here.
 */
async function asServiceRole<T>(fn: () => Promise<T>): Promise<T> {
  await pg.exec('set role service_role;');
  try {
    return await fn();
  } finally {
    await pg.exec('reset role;').catch(() => undefined);
  }
}

async function run(password = PASSWORD): Promise<SeedResult> {
  return asServiceRole(() => seedRobotHotel(db, auth, {
    password,
    organizationId: ORG_A,
    // The fixture's Staxis administrator, who is the actor for every authority
    // change exactly as the real admin is in production.
    adminUsername: 'staxis',
  }));
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

  // ─── The failure that actually happened ─────────────────────────────────

  test('resuming after the run that died at the access grant', async () => {
    // The real first production run created the hotel, attached it to the
    // company, created the auth user and the account, and then died on
    // `select authority_version from account_authorization_state` with 42501.
    // What it left behind is what the operator has to rerun against, and the
    // rerun has to ADOPT it rather than build a second copy.
    //
    // Rebuilt as fixture surgery, from the outside, because the state has to be
    // the one the failure produced and not one the product can talk itself
    // into. In particular the account is DELETED and reinserted rather than
    // having its access taken away: retiring a bridge is a durable revoke that
    // can never be resurrected, and the run that died never created a bridge at
    // all. Taking access away would have modelled a state production is not in,
    // and one no rerun could ever recover from.
    await pg.query(`delete from staff where property_id = $1`, [first.propertyId]);
    await pg.query(`delete from accounts where username = $1`, [ROBOT_MANAGER_USERNAME]);
    await pg.query(
      `insert into accounts (username, password_hash, display_name, data_user_id, role, active, skip_2fa)
       values ($1, 'x', $2, $3, 'general_manager', true, true)`,
      [ROBOT_MANAGER_USERNAME, ROBOT_MANAGER_DISPLAY, ROBOT_UID],
    );
    const stranded = await pg.query<{ id: string }>(
      `select id from accounts where username = $1`, [ROBOT_MANAGER_USERNAME],
    );
    const strandedAccountId = stranded.rows[0].id;

    // Preconditions: this test is worthless unless the state really is partial.
    // Hotel, login and account present; roster and access missing.
    assert.equal(await count(`select count(*) as n from properties where name = $1`, [ROBOT_HOTEL_NAME]), 1);
    assert.equal(await count(`select count(*) as n from auth.users where id = $1`, [ROBOT_UID]), 1);
    assert.equal(await count(`select count(*) as n from staff where property_id = $1`, [first.propertyId]), 0);
    const strandedAccess = await pg.query<{ value: unknown }>(
      `select to_jsonb(public.staxis_list_account_authorized_properties($1)) as value`,
      [strandedAccountId],
    );
    assert.ok(
      !JSON.stringify(strandedAccess.rows[0]?.value ?? null).includes(first.propertyId),
      'the partial state was not rebuilt, so the resume below proves nothing',
    );

    const resumed = await run();

    assert.equal(resumed.propertyId, first.propertyId, 'the rerun built a second hotel');
    assert.equal(resumed.propertyCreated, false);
    assert.equal(resumed.managerAccountId, strandedAccountId, 'the rerun built a second manager');
    assert.equal(resumed.managerAuthUserId, ROBOT_UID, 'the rerun built a second login');

    assert.equal(await count(`select count(*) as n from properties where name = $1`, [ROBOT_HOTEL_NAME]), 1);
    assert.equal(await count(`select count(*) as n from accounts where username = $1`, [ROBOT_MANAGER_USERNAME]), 1);
    assert.equal(await count(`select count(*) as n from staff where property_id = $1`, [first.propertyId]), 2);

    const recovered = await pg.query<{ value: unknown }>(
      `select to_jsonb(public.staxis_list_account_authorized_properties($1)) as value`,
      [strandedAccountId],
    );
    assert.ok(
      JSON.stringify(recovered.rows[0]?.value ?? null).includes(first.propertyId),
      'the resumed run finished without giving the manager the hotel',
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The grants themselves
// ═══════════════════════════════════════════════════════════════════════════
//
// This is the class the whole rework is about. Stage C keeps the authority
// tables to itself and hands out SECURITY DEFINER functions instead; a seed or
// a route that reads the table directly works in every test whose role owns it
// and fails on the first real request.

describe('the tables Stage C keeps to itself', () => {
  async function deniedForServiceRole(sql: string, params: unknown[] = []): Promise<string | null> {
    await pg.exec('begin; set local role service_role;');
    let message: string | null = null;
    try {
      await pg.query(sql, params);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    await pg.exec('rollback;').catch(() => undefined);
    return message;
  }

  test('the baseline is production’s, so a denial below means a real revoke', async () => {
    // Without this, a replay that granted nothing would deny EVERYTHING and the
    // denial test underneath would pass for the wrong reason forever.
    for (const table of ['accounts', 'properties', 'staff']) {
      assert.equal(
        await deniedForServiceRole(`select 1 from public.${table} limit 1`),
        null,
        `the service role cannot read ${table}, which it can in production — the grant replay is wrong`,
      );
    }
  });

  test('the service role cannot read the authority state directly', async () => {
    // The exact statement the seed used to make, and the exact error the first
    // production run died on: 42501, permission denied.
    const message = await deniedForServiceRole(
      `select authority_version from public.account_authorization_state limit 1`,
    );
    assert.match(
      message ?? '',
      /permission denied/i,
      'the direct read is allowed again, so the seam this seed depends on has moved',
    );
  });

  test('but the guarded reads it uses instead are allowed', async () => {
    // The other half. A test that only pinned the denial would still pass on a
    // day the RPCs were revoked too, leaving the seed with no way through.
    for (const call of [
      `select public.staxis_list_account_authorization_admin($1)`,
      `select public.staxis_list_account_authorized_properties($1)`,
    ]) {
      assert.equal(
        await deniedForServiceRole(call, [adminAccountId]),
        null,
        `${call} is not callable by the service role, so the seed has no seam left`,
      );
    }
  });

  test('the seed reaches the authority tables through nothing but those functions', () => {
    // A source assertion, deliberately, and one of the few that earns it: the
    // rule is "no direct reference to these tables anywhere in this file", and
    // that is a property of the text rather than of any single run. A future
    // edit that reintroduces one would otherwise only be caught by whichever
    // branch of the seed happens to execute.
    const source = readFileSync('scripts/robot-walk/seed.ts', 'utf8');
    for (const table of [
      'account_authorization_state',
      'account_property_authorization_bridges',
      'account_access_cutover_status',
    ]) {
      const referenced = new RegExp(`from\\(['"]${table}['"]\\)`).test(source);
      assert.equal(referenced, false, `the seed reads ${table} directly, which is 42501 in production`);
    }
  });
});
