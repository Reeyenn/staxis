/**
 * THE COMPANY SPINE, against a real Postgres holding TWO COMPANIES.
 *
 * A management company owns 5-50 hotels and the same person wears different
 * hats at different ones. Everything below is a question you can only answer
 * honestly against real SQL: who does this person become at THIS hotel, which
 * hotels can they reach at all, and — the two that matter most — what happens
 * when they ask about a hotel they were never given.
 *
 * WALL A (inside one company): visibility strictly by job. A front-desk person
 * at Beaumont must not learn Lufkin exists. A GM sees their own hotels fully
 * and nothing sideways.
 *
 * WALL B (across companies): nothing crosses, ever. Gulf Coast's VP is refused
 * Piney Woods' hotel through every read path.
 *
 * THE CONTROL GROUP is Waco Inn. Wanda and Hank have no company, no membership,
 * and no hat — they are exactly what every account in the product looks like
 * today. If the spine ever answers differently for them, the spine broke the
 * product, and these tests say so.
 *
 * NOTE ON RLS: PGlite runs as the table owner, exactly as the service-role key
 * bypasses policies in production. What is under test is app-level scoping.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-min-20-chars';
process.env.CRON_SECRET ??= 'placeholder-cron-secret-min-16';
// Device-trust is a separate boundary with its own suite. Honored only outside
// production (see validateDeviceTrust) — this is what lets the tests below
// drive the REAL route handlers instead of re-implementing their gates.
process.env.DISABLE_SERVER_2FA_ENFORCEMENT = 'true';

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';
import type { PGlite } from '@electric-sql/pglite';

import { supabaseAdmin } from '@/lib/supabase-admin';
import {
  accessibleProperties,
  accountReachesProperty,
  companyForProperty,
  effectiveRole,
  loadHats,
  propertiesOfOrganization,
} from '@/lib/company/access';
import { loadManagerCaller, managerManagesHotel } from '@/lib/team-auth';
import { GET as homeSummary } from '@/app/api/home/summary/route';
import { POST as createInvite } from '@/app/api/auth/invites/route';
import { POST as acceptInvite } from '@/app/api/auth/accept-invite/route';
import {
  DELETE as removeHat,
  GET as listHats,
  POST as addHat,
} from '@/app/api/auth/team/hats/route';
import { applyMigrationsToPgliteThrough } from '../../../tests/fixtures/pglite-migrate';
import { createPglitePostgrest, loadCatalog, type PglitePostgrest } from '../../../tests/fixtures/postgrest-pglite';
import {
  ACCOUNT_ADMIN,
  ACCOUNT_ANA,
  ACCOUNT_BO,
  ACCOUNT_FIONA,
  ACCOUNT_FRANK,
  ACCOUNT_GIL,
  ACCOUNT_HANK,
  ACCOUNT_MARIA,
  ACCOUNT_VERA,
  ACCOUNT_WANDA,
  ORG_A,
  ORG_B,
  PID_A1,
  PID_A2,
  PID_A3,
  PID_B1,
  PID_L1,
  UID_FRANK,
  UID_GIL,
  UID_HANK,
  UID_MARIA,
  UID_VERA,
  UID_WANDA,
  seedTwoCompanies,
  type TwoCompanySeed,
} from '../../../tests/fixtures/pglite-two-company-seed';

let pg: PGlite;
let shim: PglitePostgrest;
let seed: TwoCompanySeed;

const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);
const originalRpc = supabaseAdmin.rpc.bind(supabaseAdmin);
const originalGetUser = supabaseAdmin.auth.getUser.bind(supabaseAdmin.auth);
const originalCreateUser = supabaseAdmin.auth.admin.createUser.bind(supabaseAdmin.auth.admin);
const originalListUsers = supabaseAdmin.auth.admin.listUsers.bind(supabaseAdmin.auth.admin);
const originalDeleteUser = supabaseAdmin.auth.admin.deleteUser.bind(supabaseAdmin.auth.admin);

/** Whoever the next request is signed in as. */
let signedInAs: string | null = null;

function authorizedRequest(url: string, init?: { method?: string; body?: unknown }): NextRequest {
  return new NextRequest(url, {
    method: init?.method ?? 'GET',
    headers: {
      authorization: 'Bearer company-spine-test-token',
      'content-type': 'application/json',
      'x-real-ip': '203.0.113.7',
    },
    ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
}

async function summaryStatusFor(authUserId: string, propertyId: string): Promise<number> {
  signedInAs = authUserId;
  const response = await homeSummary(
    authorizedRequest(`https://staxis.test/api/home/summary?pid=${propertyId}`),
  );
  return response.status;
}

async function inviteResult(
  authUserId: string,
  body: Record<string, unknown>,
): Promise<{ status: number; error: string | null; token: string | null }> {
  signedInAs = authUserId;
  const response = await createInvite(
    authorizedRequest('https://staxis.test/api/auth/invites', { method: 'POST', body }),
  );
  const parsed = await response.json().catch(() => ({})) as {
    error?: string; data?: { inviteLink?: string };
  };
  const link = parsed.data?.inviteLink ?? '';
  return {
    status: response.status,
    error: parsed.error ?? null,
    token: link ? link.slice(link.lastIndexOf('/') + 1) : null,
  };
}

async function acceptResult(token: string, displayName: string): Promise<number> {
  signedInAs = null;
  const response = await acceptInvite(
    new NextRequest('https://staxis.test/api/auth/accept-invite', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-real-ip': '203.0.113.9' },
      body: JSON.stringify({ token, displayName, password: 'a-safe-password-123' }),
    }),
  );
  return response.status;
}

async function accountByUsername(username: string): Promise<{
  id: string; role: string; property_access: string[];
} | null> {
  const rows = await pg.query<{ id: string; role: string; property_access: string[] }>(
    `select id, role, property_access from accounts where username = $1`, [username],
  );
  return rows.rows[0] ?? null;
}

async function hatsPost(authUserId: string, body: Record<string, unknown>): Promise<number> {
  signedInAs = authUserId;
  const response = await addHat(
    authorizedRequest('https://staxis.test/api/auth/team/hats', { method: 'POST', body }),
  );
  return response.status;
}

before(async () => {
  const migrated = await applyMigrationsToPgliteThrough('0425');
  pg = migrated.pg;
  const catalog = await loadCatalog(pg);
  shim = createPglitePostgrest(pg, catalog);
  // @ts-expect-error installing the pglite-backed client on the singleton
  supabaseAdmin.from = shim.from;
  // @ts-expect-error installing the pglite-backed client on the singleton
  supabaseAdmin.rpc = shim.rpc;
  // @ts-expect-error the tests only need the id/email the session gate reads
  supabaseAdmin.auth.getUser = async () => (
    signedInAs
      ? { data: { user: { id: signedInAs, email: 'someone@example.test' } }, error: null }
      : { data: { user: null }, error: { message: 'no session', status: 401, name: 'AuthApiError' } }
  );
  // Real acceptance creates a login. Land it in the same PGlite so the accounts
  // row the route inserts actually satisfies its FK and the hat can be hung on
  // a real account id.
  // @ts-expect-error only the shape createOrReclaimAuthUser reads is provided
  supabaseAdmin.auth.admin.createUser = async ({ email }: { email: string }) => {
    const created = await pg.query<{ id: string }>(
      `insert into auth.users (id, email) values (gen_random_uuid(), $1) returning id`,
      [email],
    );
    return { data: { user: { id: created.rows[0].id, email } }, error: null };
  };
  // @ts-expect-error the reclaim path only needs an empty page here
  supabaseAdmin.auth.admin.listUsers = async () => ({ data: { users: [] }, error: null });
  // @ts-expect-error rollback path
  supabaseAdmin.auth.admin.deleteUser = async (id: string) => {
    await pg.query(`delete from auth.users where id = $1`, [id]);
    return { data: {}, error: null };
  };

  seed = await seedTwoCompanies(pg);
});

after(async () => {
  supabaseAdmin.from = originalFrom;
  supabaseAdmin.rpc = originalRpc;
  supabaseAdmin.auth.getUser = originalGetUser;
  supabaseAdmin.auth.admin.createUser = originalCreateUser;
  supabaseAdmin.auth.admin.listUsers = originalListUsers;
  supabaseAdmin.auth.admin.deleteUser = originalDeleteUser;
  await pg?.close();
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the control group — an account with no company answers exactly as it always has', () => {
  test('a legacy owner is still the owner of the hotel in her property_access, and nothing else', async () => {
    const atHerHotel = await effectiveRole(ACCOUNT_WANDA, PID_L1);
    assert.equal(atHerHotel.role, 'owner');
    assert.equal(atHerHotel.source, 'legacy', 'no membership answered — the account row did');
    assert.equal(atHerHotel.hatRole, null);

    // The global accounts.role word must NOT be read as her job at a hotel she
    // has no standing at. That is how a company VP would silently become the
    // general manager of a hotel she has never heard of.
    const somewhereElse = await effectiveRole(ACCOUNT_WANDA, PID_A1);
    assert.equal(somewhereElse.source, 'none');
    assert.equal(somewhereElse.role, null);
  });

  test('a legacy housekeeper resolves to housekeeping, and reaches exactly her one hotel', async () => {
    const resolved = await effectiveRole(ACCOUNT_HANK, PID_L1);
    assert.equal(resolved.role, 'housekeeping');
    assert.equal(resolved.source, 'legacy');

    const access = await accessibleProperties(ACCOUNT_HANK);
    assert.deepEqual(access.propertyIds, [PID_L1]);
    assert.deepEqual(access.membershipPropertyIds, [], 'not one hotel came from a company');
    assert.deepEqual(
      access.propertyIds, access.legacyPropertyIds,
      'the answer is the property_access array, verbatim',
    );
  });

  test('the legacy hotel belongs to no company at all', async () => {
    assert.equal(await companyForProperty(PID_L1), null);
    assert.deepEqual(await loadHats(ACCOUNT_WANDA), []);
    assert.deepEqual(await loadHats(ACCOUNT_HANK), []);
  });

  test('loadManagerCaller returns the same manager it always did, plus empty company fields', async () => {
    const caller = await loadManagerCaller(UID_WANDA);
    assert.ok(caller, 'the legacy owner is still a manager');
    assert.equal(caller.role, 'owner');
    assert.deepEqual(caller.propertyAccess, [PID_L1]);
    assert.deepEqual(caller.hats, []);
    assert.deepEqual(caller.accessiblePropertyIds, [PID_L1]);
    assert.equal(managerManagesHotel(caller, PID_L1), true);
    assert.equal(managerManagesHotel(caller, PID_A1), false);

    // The floor is still the floor.
    assert.equal(await loadManagerCaller(UID_HANK), null, 'housekeeping is not a manager');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('Maria wears two hats', () => {
  test('she is the GM at Beaumont and oversight everywhere else in her company', async () => {
    const atBeaumont = await effectiveRole(ACCOUNT_MARIA, PID_A1);
    assert.equal(atBeaumont.hatRole, 'general_manager', 'at her own hotel she is the GM');
    assert.equal(atBeaumont.role, 'general_manager');
    assert.equal(atBeaumont.scope, 'property');
    assert.equal(atBeaumont.source, 'membership');
    assert.equal(atBeaumont.organizationId, ORG_A);

    const atLufkin = await effectiveRole(ACCOUNT_MARIA, PID_A2);
    assert.equal(atLufkin.hatRole, 'vp', 'at the others she oversees');
    assert.equal(atLufkin.scope, 'company');
    assert.equal(atLufkin.role, 'front_desk', 'company oversight remains hotel read-only');
  });

  test('at the other company\'s hotel she is nobody', async () => {
    const atTyler = await effectiveRole(ACCOUNT_MARIA, PID_B1);
    assert.equal(atTyler.source, 'none');
    assert.equal(atTyler.role, null);
    assert.equal(atTyler.hatRole, null);
  });

  test('her two hats show as two lines, each with its own hotels', async () => {
    const hats = await loadHats(ACCOUNT_MARIA);
    assert.equal(hats.length, 2);
    const gm = hats.find((hat) => hat.role === 'general_manager');
    const vp = hats.find((hat) => hat.role === 'vp');
    assert.ok(gm && vp);
    assert.deepEqual(gm.coveredPropertyIds, [PID_A1]);
    assert.deepEqual(vp.coveredPropertyIds, [PID_A1, PID_A2].sort());
    assert.equal(gm.jobTitle, 'General Manager');
    assert.equal(vp.jobTitle, 'VP of Operations');
  });

  test('removing one hat removes exactly that hat', async () => {
    const gmMembershipId = seed.hats.get(`${ACCOUNT_MARIA}:property:general_manager`);
    assert.ok(gmMembershipId);
    await pg.query(`select public.staxis_end_membership_hat($1, $2)`, [ACCOUNT_ADMIN, gmMembershipId]);

    const remaining = await loadHats(ACCOUNT_MARIA);
    assert.deepEqual(remaining.map((hat) => hat.role), ['vp'], 'only the GM hat came off');
    const atBeaumont = await effectiveRole(ACCOUNT_MARIA, PID_A1);
    assert.equal(atBeaumont.hatRole, 'vp', 'she still oversees Beaumont — she just no longer runs it');

    // Put it back so later tests see the seeded world.
    await pg.query(
      `select public.staxis_set_membership_hat($1, $2, $3, 'property', 'general_manager', $4, 'General Manager')`,
      [ACCOUNT_ADMIN, ORG_A, ACCOUNT_MARIA, JSON.stringify([PID_A1])],
    );
    const restored = await effectiveRole(ACCOUNT_MARIA, PID_A1);
    assert.equal(restored.hatRole, 'general_manager');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('WALL A — inside one company, you see only what your job covers', () => {
  test('the front-desk person at Beaumont cannot learn Lufkin exists', async () => {
    assert.equal(await accountReachesProperty(ACCOUNT_FRANK, PID_A1), true);
    assert.equal(await accountReachesProperty(ACCOUNT_FRANK, PID_A2), false);

    // Through the REAL route handler, not a re-implementation of its gate.
    assert.equal(await summaryStatusFor(UID_FRANK, PID_A2), 403);
    assert.notEqual(
      await summaryStatusFor(UID_FRANK, PID_A1), 403,
      'his own hotel is not refused — otherwise this suite would pass on a route that refuses everything',
    );
  });

  test('a GM sees his own hotel fully and nothing sideways', async () => {
    // Gil runs Tyler for Piney Woods. Inside his own company there is nothing
    // else, and Gulf Coast\'s hotels are not his to see.
    const access = await accessibleProperties(ACCOUNT_GIL);
    assert.deepEqual(access.propertyIds, [PID_B1]);
    assert.equal(await summaryStatusFor(UID_GIL, PID_A1), 403);
    assert.equal(await summaryStatusFor(UID_GIL, PID_A2), 403);
    assert.notEqual(await summaryStatusFor(UID_GIL, PID_B1), 403);
  });

  test('the front-desk hat is not a manager, whatever hotel is named', async () => {
    assert.equal(await loadManagerCaller(UID_FRANK), null);
  });

  test('a company job grants nothing through the legacy array — every hotel came from the hat', async () => {
    const access = await accessibleProperties(ACCOUNT_FRANK);
    assert.deepEqual(access.legacyPropertyIds, [], 'his account row lists no hotels at all');
    assert.deepEqual(access.membershipPropertyIds, [PID_A1]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('WALL B — nothing crosses between companies, ever', () => {
  test('Gulf Coast\'s owner and VP reach Gulf Coast and stop there', async () => {
    for (const accountId of [ACCOUNT_ANA, ACCOUNT_FIONA]) {
      const access = await accessibleProperties(accountId);
      assert.deepEqual(access.propertyIds, [PID_A1, PID_A2].sort());
      assert.equal(access.propertyIds.includes(PID_B1), false);
      assert.equal(access.propertyIds.includes(PID_L1), false);
    }
  });

  test('Piney Woods\' VP is refused every Gulf Coast hotel through the real read route', async () => {
    assert.equal(await summaryStatusFor(UID_VERA, PID_A1), 403);
    assert.equal(await summaryStatusFor(UID_VERA, PID_A2), 403);
    assert.equal(await summaryStatusFor(UID_VERA, PID_L1), 403, 'nor the independent hotel');
    assert.notEqual(await summaryStatusFor(UID_VERA, PID_B1), 403, 'her own company still works');
  });

  test('Piney Woods\' VP cannot manage a Gulf Coast hotel', async () => {
    const caller = await loadManagerCaller(UID_VERA);
    // Hotel mutation callers deliberately exclude oversight-only company jobs.
    // People/Access uses the authoritative organization-plane resolver instead
    // (covered by the route tests below), so a VP is not translated into a
    // synthetic hotel GM just to make this legacy helper return true.
    assert.equal(caller, null);
  });

  test('each company\'s hotel list contains only its own hotels', async () => {
    assert.deepEqual(await propertiesOfOrganization(ORG_A), [PID_A1, PID_A2].sort());
    assert.deepEqual(await propertiesOfOrganization(ORG_B), [PID_B1]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('a company-wide job covers hotels the company had not bought yet', () => {
  test('attaching a hotel to the company covers everyone already company-wide, with nothing re-stamped', async () => {
    const before = await accessibleProperties(ACCOUNT_FIONA);
    assert.equal(before.propertyIds.includes(PID_A3), false);

    await seed.attachPropertyToOrganization(pg, ORG_A, PID_A3, 'Port Arthur Inn');

    const after = await accessibleProperties(ACCOUNT_FIONA);
    assert.equal(
      after.propertyIds.includes(PID_A3), true,
      'the finance hat was written before this hotel existed and covers it anyway',
    );
    const resolved = await effectiveRole(ACCOUNT_FIONA, PID_A3);
    assert.equal(resolved.hatRole, 'finance');
    assert.equal(resolved.seesFinancials, true);

    // A PROPERTY hat must NOT widen — Frank was given one hotel and still has
    // one hotel. This is the half that proves the auto-cover is scope-driven
    // rather than company-driven.
    const frank = await accessibleProperties(ACCOUNT_FRANK);
    assert.deepEqual(frank.propertyIds, [PID_A1]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the invite button asks a third question only when the inviter runs a company', () => {
  test('a GM\'s invitation scopes to their own hotel without being asked', async () => {
    const result = await inviteResult(UID_GIL, {
      hotelId: PID_B1,
      email: 'new-housekeeper@example.test',
      role: 'housekeeping',
    });
    assert.equal(result.status, 201, result.error ?? '');

    const stored = await pg.query<{ membership_scope: string; organization_id: string; covered_property_ids: string[] }>(
      `select membership_scope, organization_id, covered_property_ids
         from account_invites where email = 'new-housekeeper@example.test'`,
    );
    assert.equal(stored.rows[0]?.membership_scope, 'property');
    assert.equal(stored.rows[0]?.organization_id, ORG_B);
    assert.deepEqual(stored.rows[0]?.covered_property_ids, [PID_B1], 'his hotel, implied');
  });

  test('a GM cannot mint a peer GM', async () => {
    const result = await inviteResult(UID_GIL, {
      hotelId: PID_B1,
      email: 'rival-gm@example.test',
      role: 'general_manager',
      scope: 'property',
      propertyIds: [PID_B1],
    });
    assert.equal(result.status, 403);
  });

  test('a VP\'s invitation may name several hotels inside their own company', async () => {
    const result = await inviteResult(UID_MARIA, {
      hotelId: PID_A1,
      email: 'roving-maintenance@example.test',
      role: 'maintenance',
      scope: 'property',
      propertyIds: [PID_A1, PID_A2],
    });
    assert.equal(result.status, 201, result.error ?? '');
    const stored = await pg.query<{ covered_property_ids: string[] }>(
      `select covered_property_ids from account_invites where email = 'roving-maintenance@example.test'`,
    );
    assert.deepEqual([...(stored.rows[0]?.covered_property_ids ?? [])].sort(), [PID_A1, PID_A2].sort());
  });

  test('a VP\'s invitation is REFUSED a hotel outside their company', async () => {
    const result = await inviteResult(UID_MARIA, {
      hotelId: PID_A1,
      email: 'cross-company@example.test',
      role: 'maintenance',
      scope: 'property',
      // Tyler belongs to Piney Woods. Pasting its id must not work.
      propertyIds: [PID_A1, PID_B1],
    });
    assert.equal(result.status, 403);
    const stored = await pg.query(
      `select 1 from account_invites where email = 'cross-company@example.test'`,
    );
    assert.equal(stored.rows.length, 0, 'and nothing was written');
  });

  test('a VP cannot create a peer VP', async () => {
    const result = await inviteResult(UID_MARIA, {
      hotelId: PID_A1,
      email: 'peer-vp@example.test',
      role: 'vp',
      scope: 'company',
    });
    assert.equal(result.status, 403);
  });

  test('a company-wide invitation records the company and no hotel list', async () => {
    signedInAs = null;
    // Ana is the owner; she may hire finance company-wide.
    const anaAuth = await pg.query<{ data_user_id: string }>(
      `select data_user_id from accounts where id = $1`, [ACCOUNT_ANA],
    );
    const result = await inviteResult(anaAuth.rows[0].data_user_id, {
      hotelId: PID_A1,
      email: 'new-controller@example.test',
      role: 'finance',
      scope: 'company',
    });
    assert.equal(result.status, 201, result.error ?? '');
    const stored = await pg.query<{ membership_scope: string; covered_property_ids: string[] | null; role: string }>(
      `select membership_scope, covered_property_ids, role
         from account_invites where email = 'new-controller@example.test'`,
    );
    assert.equal(stored.rows[0]?.membership_scope, 'company');
    assert.equal(stored.rows[0]?.covered_property_ids, null, 'company-wide stores no list — that is the point');
    assert.equal(stored.rows[0]?.role, 'finance');
  });

  test('an invitation at the independent hotel stays exactly the invitation it always was', async () => {
    const result = await inviteResult(UID_WANDA, {
      hotelId: PID_L1,
      email: 'waco-front-desk@example.test',
      role: 'front_desk',
    });
    assert.equal(result.status, 201, result.error ?? '');
    const stored = await pg.query<{ membership_scope: string | null; organization_id: string | null }>(
      `select membership_scope, organization_id from account_invites where email = 'waco-front-desk@example.test'`,
    );
    assert.equal(stored.rows[0]?.membership_scope, null);
    assert.equal(stored.rows[0]?.organization_id, null);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('accepting the invitation puts the hat on', () => {
  test('a company-wide finance invitation lands as a finance hat over every hotel', async () => {
    const anaAuth = await pg.query<{ data_user_id: string }>(
      `select data_user_id from accounts where id = $1`, [ACCOUNT_ANA],
    );
    const invite = await inviteResult(anaAuth.rows[0].data_user_id, {
      hotelId: PID_A1,
      email: 'controller-two@example.test',
      role: 'finance',
      scope: 'company',
    });
    assert.equal(invite.status, 201, invite.error ?? '');
    assert.ok(invite.token);

    assert.equal(await acceptResult(invite.token, 'Carla the Controller'), 200);

    const account = await accountByUsername('controller-two');
    assert.ok(account);
    assert.equal(
      account.role, 'front_desk',
      'the LOGIN carries a legacy word — finance is not one accounts.role has ever had',
    );

    const hats = await loadHats(account.id);
    assert.equal(hats.length, 1);
    assert.equal(hats[0].role, 'finance', 'the true job lives on the hat');
    assert.equal(hats[0].scope, 'company');
    assert.deepEqual(hats[0].coveredPropertyIds, (await propertiesOfOrganization(ORG_A)));

    const resolved = await effectiveRole(account.id, PID_A2);
    assert.equal(resolved.hatRole, 'finance');
    assert.equal(resolved.seesFinancials, true, 'she is here for the money and she can see it');

    // Wall B holds for a brand new person too.
    assert.equal(await accountReachesProperty(account.id, PID_B1), false);
  });

  test('a GM\'s invitation lands the new person on that GM\'s hotel and nowhere else', async () => {
    const invite = await inviteResult(UID_GIL, {
      hotelId: PID_B1,
      email: 'tyler-maintenance@example.test',
      role: 'maintenance',
    });
    assert.equal(invite.status, 201, invite.error ?? '');
    assert.ok(invite.token);
    assert.equal(await acceptResult(invite.token, 'Marco'), 200);

    const account = await accountByUsername('tyler-maintenance');
    assert.ok(account);
    assert.equal(account.role, 'maintenance');
    const resolved = await effectiveRole(account.id, PID_B1);
    assert.equal(resolved.hatRole, 'maintenance');
    assert.equal(resolved.scope, 'property');
    assert.equal(await accountReachesProperty(account.id, PID_A1), false);
    assert.equal(await accountReachesProperty(account.id, PID_L1), false);
  });

  test('an invitation at the independent hotel still creates the plain old account', async () => {
    const invite = await inviteResult(UID_WANDA, {
      hotelId: PID_L1,
      email: 'waco-maintenance@example.test',
      role: 'maintenance',
    });
    assert.equal(invite.status, 201, invite.error ?? '');
    assert.ok(invite.token);
    assert.equal(await acceptResult(invite.token, 'Wes'), 200);

    const account = await accountByUsername('waco-maintenance');
    assert.ok(account);
    assert.equal(account.role, 'maintenance');
    assert.deepEqual(account.property_access, [PID_L1]);
    assert.deepEqual(await loadHats(account.id), [], 'no company, so no hat — exactly as before');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('a person\'s card is a list of lines, and each line is editable on its own', () => {
  // Migration 0370. Before it, `staxis_set_membership_hat` validated the target
  // only as "an active account", so an owner could attach a job at their
  // company to ANY account id in the product — a stranger, or a competitor's
  // staff — and that account silently gained their hotels and appeared on their
  // team lists. The person was never told and never consented.
  test('a job cannot be handed to somebody with no tie to the company', async () => {
    const anaAuth = await pg.query<{ data_user_id: string }>(
      `select data_user_id from accounts where id = $1`, [ACCOUNT_ANA],
    );
    // Gil is Piney Woods' GM and has never heard of Gulf Coast.
    assert.equal(await hatsPost(anaAuth.rows[0].data_user_id, {
      hotelId: PID_A1,
      accountId: ACCOUNT_GIL,
      scope: 'property',
      role: 'general_manager',
      propertyIds: [PID_A1],
      jobTitle: 'General Manager',
    }), 403);
    assert.deepEqual(
      (await loadHats(ACCOUNT_GIL)).map((hat) => hat.organizationId), [ORG_B],
      'the refused job was written anyway',
    );
  });

  test('answering "what job, and where" a second time adds a second line', async () => {
    // Gil runs Tyler. Ana INVITES him to Gulf Coast, then gives him Beaumont —
    // the "one GM can run two hotels" case, expressed as a second hat rather
    // than a wider array. The invitation is the consent step 0370 now requires;
    // everything after it is exactly as it was.
    const anaAuth = await pg.query<{ data_user_id: string }>(
      `select data_user_id from accounts where id = $1`, [ACCOUNT_ANA],
    );
    const gilEmail = await pg.query<{ email: string }>(
      `select u.email from accounts a join auth.users u on u.id = a.data_user_id where a.id = $1`,
      [ACCOUNT_GIL],
    );
    await pg.query(
      `insert into account_invites
         (hotel_id, email, role, token_hash, expires_at, invited_by,
          organization_id, membership_scope, covered_property_ids)
       values ($1, $2, 'general_manager', $3, now() + interval '7 days', $4,
               $5, 'property', $6)`,
      [PID_A1, gilEmail.rows[0].email, 'gil-gulf-coast-invite', ACCOUNT_ANA, ORG_A, [PID_A1]],
    );

    assert.equal(await hatsPost(anaAuth.rows[0].data_user_id, {
      hotelId: PID_A1,
      accountId: ACCOUNT_GIL,
      scope: 'property',
      role: 'general_manager',
      propertyIds: [PID_A1],
      jobTitle: 'General Manager',
    }), 201);

    const hats = await loadHats(ACCOUNT_GIL);
    assert.equal(hats.length, 2, 'two companies, two lines');
    assert.deepEqual(
      hats.map((hat) => hat.organizationId).sort(),
      [ORG_A, ORG_B].sort(),
    );
    assert.equal((await effectiveRole(ACCOUNT_GIL, PID_A1)).hatRole, 'general_manager');
    assert.equal((await effectiveRole(ACCOUNT_GIL, PID_B1)).hatRole, 'general_manager');
    // And still nothing sideways: Lufkin was not part of the answer.
    assert.equal(await accountReachesProperty(ACCOUNT_GIL, PID_A2), false);
  });

  test('the card renders each line with its hotels named', async () => {
    signedInAs = UID_MARIA;
    const response = await listHats(authorizedRequest(
      `https://staxis.test/api/auth/team/hats?hotelId=${PID_A1}&accountId=${ACCOUNT_MARIA}`,
    ));
    assert.equal(response.status, 200);
    const body = await response.json() as {
      data: { hats: Array<{ role: string; label: { en: string; es: string }; propertyNames: string[] }> };
    };
    const lines = body.data.hats
      .map((hat) => `${hat.label.en} — ${hat.propertyNames.join(', ')}`)
      .sort();
    assert.deepEqual(lines, [
      'GM — Beaumont Suites',
      'Oversees — Beaumont Suites, Lufkin Inn, Port Arthur Inn',
    ]);
    assert.equal(body.data.hats.every((hat) => hat.label.es.length > 0), true, 'both languages');
  });

  test('removing one line leaves the others standing', async () => {
    const anaAuth = await pg.query<{ data_user_id: string }>(
      `select data_user_id from accounts where id = $1`, [ACCOUNT_ANA],
    );
    const gulfCoastHat = (await loadHats(ACCOUNT_GIL))
      .find((hat) => hat.organizationId === ORG_A);
    assert.ok(gulfCoastHat);

    signedInAs = anaAuth.rows[0].data_user_id;
    const response = await removeHat(authorizedRequest(
      `https://staxis.test/api/auth/team/hats?hotelId=${PID_A1}&membershipId=${gulfCoastHat.membershipId}`,
      { method: 'DELETE' },
    ));
    assert.equal(response.status, 200);

    const remaining = await loadHats(ACCOUNT_GIL);
    assert.deepEqual(remaining.map((hat) => hat.organizationId), [ORG_B]);
    assert.equal(await accountReachesProperty(ACCOUNT_GIL, PID_A1), false, 'Beaumont is gone');
    assert.equal(await accountReachesProperty(ACCOUNT_GIL, PID_B1), true, 'Tyler is not');
  });

  test('a manager at one company cannot touch a person\'s job at another', async () => {
    // Vera runs Piney Woods. Frank works for Gulf Coast.
    assert.equal(await hatsPost(UID_VERA, {
      hotelId: PID_A1,
      accountId: ACCOUNT_FRANK,
      scope: 'property',
      role: 'front_desk',
      propertyIds: [PID_A1],
    }), 403);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the database refuses what the routes refuse', () => {
  test('a hat cannot name a hotel its company does not operate', async () => {
    await assert.rejects(
      pg.query(
        `select public.staxis_set_membership_hat($1, $2, $3, 'property', 'front_desk', $4, null)`,
        [ACCOUNT_ADMIN, ORG_A, ACCOUNT_FRANK, JSON.stringify([PID_B1])],
      ),
      /not (?:operated|governed) by this company/i,
    );
  });

  test('a hat cannot be placed in an independent hotel\'s hidden compatibility anchor', async () => {
    const anchor = await pg.query<{ id: string }>(
      `select id from organizations where legacy_property_id = $1`, [PID_L1],
    );
    assert.ok(anchor.rows[0]?.id, 'the anchor exists — this is the row the legacy model hangs off');
    await assert.rejects(
      pg.query(
        `insert into organization_memberships
           (organization_id, account_id, job_category, status, membership_scope, staxis_role, covered_property_ids)
         values ($1, $2, 'hotel_employee', 'active', 'property', 'front_desk', $3)`,
        [anchor.rows[0].id, ACCOUNT_WANDA, `{${PID_L1}}`],
      ),
      /single-hotel compatibility anchor|active customer organization/i,
    );
  });

  test('a GM cannot hand out a job at a hotel they do not cover', async () => {
    await assert.rejects(
      pg.query(
        `select public.staxis_set_membership_hat($1, $2, $3, 'property', 'front_desk', $4, null)`,
        [ACCOUNT_GIL, ORG_A, ACCOUNT_FRANK, JSON.stringify([PID_A1])],
      ),
      /may not grant this job/i,
    );
  });

  test('a company owner cannot reach into the other company', async () => {
    await assert.rejects(
      pg.query(
        `select public.staxis_set_membership_hat($1, $2, $3, 'company', 'vp', null, null)`,
        [ACCOUNT_BO, ORG_A, ACCOUNT_FRANK],
      ),
      /may not grant this job/i,
    );
  });

  test('the same job at the same scope is one hat with a wider list, never two rows', async () => {
    await pg.query(
      `select public.staxis_set_membership_hat($1, $2, $3, 'property', 'front_desk', $4, null)`,
      [ACCOUNT_ADMIN, ORG_A, ACCOUNT_FRANK, JSON.stringify([PID_A1, PID_A2])],
    );
    const rows = await pg.query<{ count: string }>(
      `select count(*)::text as count from organization_memberships
        where account_id = $1 and staxis_role = 'front_desk' and ended_at is null`,
      [ACCOUNT_FRANK],
    );
    assert.equal(rows.rows[0].count, '1');
    const widened = await accessibleProperties(ACCOUNT_FRANK);
    assert.deepEqual(widened.propertyIds, [PID_A1, PID_A2].sort());

    // Back to one hotel, so the wall tests above keep describing the same world
    // if this file is ever re-ordered.
    await pg.query(
      `select public.staxis_set_membership_hat($1, $2, $3, 'property', 'front_desk', $4, null)`,
      [ACCOUNT_ADMIN, ORG_A, ACCOUNT_FRANK, JSON.stringify([PID_A1])],
    );
    assert.deepEqual((await accessibleProperties(ACCOUNT_FRANK)).propertyIds, [PID_A1]);
  });

  test('the legacy one-membership-per-company rule still holds for employment records', async () => {
    // Two hats are fine. Two EMPLOYMENT records are not, and that invariant is
    // what every pre-company-spine query relies on.
    await assert.rejects(
      pg.query(
        `insert into organization_memberships (organization_id, account_id, job_category, status)
         values ($1, $2, 'other', 'active'), ($1, $2, 'other', 'active')`,
        [ORG_A, ACCOUNT_FRANK],
      ),
      /organization_memberships_one_current_idx|duplicate key/i,
    );
  });

  test('every read the spine itself issues compiles to real SQL', () => {
    // The Home route reaches for two builder features this shim has never
    // supported (an embedded `organizations.status` filter and a non-array
    // `in()`); those predate the company spine and belong to that route's own
    // suite. What must be clean is everything the spine reads.
    const spineTables = [
      'organization_property_relationships',
      'account_invites',
      'accounts',
      'organizations',
    ];
    const mine = shim.unsupported.filter((entry) => (
      spineTables.some((table) => entry.includes(`select ${table}:`))
    ));
    assert.deepEqual(mine, []);
  });
});
