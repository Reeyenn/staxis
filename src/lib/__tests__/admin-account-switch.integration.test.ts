/**
 * The account switcher against a REAL Postgres, with the real migrations.
 *
 * The unit tests (admin-account-switch.test.ts) prove the policy with injected
 * dependencies. This proves the two claims that only a real database can
 * settle, because both of them are decisions the DATABASE makes:
 *
 *   • WHO IS A DEMO PERSON. The rule is "every hotel this account reaches is a
 *     properties.is_test hotel", and "reaches" is answered by the canonical
 *     resolver RPC (staxis_list_account_authorized_properties, migration 0426)
 *     evaluated over real membership hats, grants and topology. The fixture
 *     puts a demo hotel and a real hotel inside the SAME company, so the
 *     verdict cannot come from company membership, a name pattern, or the
 *     legacy accounts.property_access array. Frank, who reaches only the demo
 *     hotel, is switchable. Ana, who owns both, is not. That is the exact
 *     shape of "a Comfort Suites account must be unswitchable".
 *
 *   • THE RETURN TOKEN REDEEMS EXACTLY ONCE. Single use is enforced by an
 *     atomic claim against idempotency_log (claim_idempotency_key, migration
 *     0243) rather than by anything in the browser or in memory. A replay has
 *     to lose to Postgres, so Postgres is what runs here.
 *
 * The whole round trip runs end to end: an admin switches into a demo person,
 * gets a signed cookie back, redeems it, becomes the admin again, and a second
 * redeem of the same cookie is refused.
 *
 * Only Supabase Auth itself is modeled (there is no local GoTrue): generateLink
 * and getUserById are stubbed with a token store that consumes on first use,
 * which is exactly the property the real service provides.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-min-20-chars';
process.env.CRON_SECRET ??= 'placeholder-cron-secret-min-16';

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { PGlite } from '@electric-sql/pglite';

import { supabaseAdmin } from '@/lib/supabase-admin';
import {
  listSwitchableDemoAccounts,
  liveSwitchableListDeps,
  livePerformReturnDeps,
  livePerformSwitchDeps,
  performAccountSwitch,
  performAdminReturn,
  resolveSwitchableDemoAccount,
  ROBOT_ACCOUNT_USERNAME,
  verifyReturnToken,
  liveSigningKey,
} from '@/lib/admin-account-switch';

import { applyMigrationsToPglite } from '../../../tests/fixtures/pglite-migrate';
import { createPglitePostgrest, loadCatalog } from '../../../tests/fixtures/postgrest-pglite';
import {
  ACCOUNT_ADMIN,
  ACCOUNT_ANA,
  ACCOUNT_FRANK,
  ACCOUNT_GIL,
  ORG_A,
  PID_A1,
  PID_A2,
  UID_ADMIN,
  seedTwoCompanies,
} from '../../../tests/fixtures/pglite-two-company-seed';

let pg: PGlite;

const ROBOT_ACCOUNT = 'cccc1111-0000-4000-8000-00000000000r'.replace('r', '9');
const ROBOT_UID = 'cccc2222-0000-4000-8000-000000000009';

/** Stand-in for Supabase Auth: mints one-time tokens and consumes them once. */
const authWorld = {
  emails: new Map<string, string>(),
  live: new Set<string>(),
  minted: 0,
};

function installAuthStubs(): void {
  supabaseAdmin.auth.admin.getUserById = (async (uid: string) => {
    const email = authWorld.emails.get(uid);
    return email
      ? { data: { user: { id: uid, email } }, error: null }
      : { data: { user: null }, error: { message: 'no user' } };
  }) as unknown as typeof supabaseAdmin.auth.admin.getUserById;

  supabaseAdmin.auth.admin.generateLink = (async ({ email }: { email: string }) => {
    authWorld.minted += 1;
    const hashed = `hashed-${email}-${authWorld.minted}`;
    authWorld.live.add(hashed);
    return { data: { properties: { hashed_token: hashed } }, error: null };
  }) as unknown as typeof supabaseAdmin.auth.admin.generateLink;
}

/** What verifyOtp would do in the browser: succeed once, then never again. */
function redeemMagicLink(hashedToken: string): boolean {
  if (!authWorld.live.has(hashedToken)) return false;
  authWorld.live.delete(hashedToken);
  return true;
}

before(async () => {
  const migrated = await applyMigrationsToPglite();
  pg = migrated.pg;
  const catalog = await loadCatalog(pg);
  const shim = createPglitePostgrest(pg, catalog);
  supabaseAdmin.from = shim.from as unknown as typeof supabaseAdmin.from;
  supabaseAdmin.rpc = shim.rpc as unknown as typeof supabaseAdmin.rpc;
  installAuthStubs();

  await seedTwoCompanies(pg);

  // ── The fixture's whole point ──────────────────────────────────────────
  // Beaumont becomes a DEMO hotel; Lufkin, in the SAME company, stays a real
  // one. Nothing about company membership can decide who is switchable now.
  await pg.query('update public.properties set is_test = true where id = $1', [PID_A1]);
  await pg.query('update public.properties set is_test = false where id = $1', [PID_A2]);

  // The robot walker: a demo-hotel account that must still be off limits.
  await pg.query(
    "insert into auth.users (id, email) values ($1, 'robot.manager@staxis.local') on conflict (id) do nothing",
    [ROBOT_UID],
  );
  await pg.query(
    `insert into public.accounts (id, username, password_hash, display_name, role, data_user_id)
     values ($1, $2, 'x', 'Robot Manager', 'general_manager', $3) on conflict (id) do nothing`,
    [ROBOT_ACCOUNT, ROBOT_ACCOUNT_USERNAME, ROBOT_UID],
  );
  await pg.query(
    "select public.staxis_set_membership_hat($1, $2, $3, 'property', 'general_manager', $4, 'Robot')",
    [ACCOUNT_ADMIN, ORG_A, ROBOT_ACCOUNT, JSON.stringify([PID_A1])],
  );

  const emails = await pg.query<{ id: string; email: string }>('select id, email from auth.users');
  for (const row of emails.rows) authWorld.emails.set(row.id, row.email);
});

after(async () => { await pg?.close(); });

describe('who the database says is a demo person', () => {
  test('a person who reaches only the demo hotel is switchable', async () => {
    const resolved = await resolveSwitchableDemoAccount(ACCOUNT_FRANK, liveSwitchableListDeps());
    assert.equal(resolved.ok, true, JSON.stringify(resolved));
    if (resolved.ok) assert.deepEqual(resolved.access.propertyIds, [PID_A1]);
  });

  test('a person in the SAME company who also reaches the real hotel is refused', async () => {
    // Ana owns every Gulf Coast hotel, including Lufkin. Same company as
    // Frank, opposite verdict, decided purely by hotel reach.
    const resolved = await resolveSwitchableDemoAccount(ACCOUNT_ANA, liveSwitchableListDeps());
    assert.equal(resolved.ok, false);
    if (!resolved.ok) assert.equal(resolved.reason, 'reaches_real_hotel');
  });

  test('a person at a different company entirely is refused', async () => {
    const resolved = await resolveSwitchableDemoAccount(ACCOUNT_GIL, liveSwitchableListDeps());
    assert.equal(resolved.ok, false);
    if (!resolved.ok) assert.equal(resolved.reason, 'reaches_real_hotel');
  });

  test('the platform admin is refused as a target', async () => {
    const resolved = await resolveSwitchableDemoAccount(ACCOUNT_ADMIN, liveSwitchableListDeps());
    assert.equal(resolved.ok, false);
    if (!resolved.ok) assert.equal(resolved.reason, 'is_admin');
  });

  test('the robot walker is refused even though its only hotel is a demo hotel', async () => {
    const resolved = await resolveSwitchableDemoAccount(ROBOT_ACCOUNT, liveSwitchableListDeps());
    assert.equal(resolved.ok, false);
    if (!resolved.ok) assert.equal(resolved.reason, 'is_robot');
  });

  test('the menu lists exactly the demo people, out of every account in the database', async () => {
    const listed = await listSwitchableDemoAccounts(liveSwitchableListDeps());
    assert.ok(listed, 'the roster must not be null when the database is readable');
    const ids = listed.map((row) => row.accountId).sort();
    assert.deepEqual(ids, [ACCOUNT_FRANK]);
    assert.match(listed[0].roleLine, /Beaumont/);
  });
});

describe('the round trip: become someone, and get back', () => {
  test('an admin switches in, returns, and the same cookie cannot be replayed', async () => {
    const now = Date.now();

    // ── Switch ────────────────────────────────────────────────────────────
    const switched = await performAccountSwitch(
      {
        callerAccountId: ACCOUNT_ADMIN,
        callerAuthUserId: UID_ADMIN,
        targetAccountId: ACCOUNT_FRANK,
        deviceCookieValue: null,
        nowMs: now,
      },
      livePerformSwitchDeps(),
    );
    assert.equal(switched.ok, true, JSON.stringify(switched));
    if (!switched.ok) return;

    // The browser becomes Frank.
    assert.equal(redeemMagicLink(switched.targetTokenHash), true);
    assert.equal(switched.targetDisplayName, 'Frank');

    // The cookie the server set is a real, verifiable token bound to the admin.
    const parsed = verifyReturnToken(switched.returnToken, liveSigningKey(), now + 1000);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.equal(parsed.payload.adminAccountId, ACCOUNT_ADMIN);
    assert.equal(parsed.payload.targetAccountId, ACCOUNT_FRANK);

    // ── Return ────────────────────────────────────────────────────────────
    const returned = await performAdminReturn(
      { rawToken: switched.returnToken, nowMs: now + 5_000 },
      livePerformReturnDeps(),
    );
    assert.equal(returned.ok, true, JSON.stringify(returned));
    if (!returned.ok) return;
    assert.equal(returned.adminAccountId, ACCOUNT_ADMIN);
    // The browser becomes the admin again.
    assert.equal(redeemMagicLink(returned.adminTokenHash), true);

    // ── Replay ────────────────────────────────────────────────────────────
    // Postgres, not memory, is what refuses the second redeem.
    const replayed = await performAdminReturn(
      { rawToken: switched.returnToken, nowMs: now + 6_000 },
      livePerformReturnDeps(),
    );
    assert.equal(replayed.ok, false);
    if (!replayed.ok) assert.equal(replayed.reason, 'token_already_used');

    // And the one-time login token behind it is spent too, so even a bypass of
    // the claim above would hand back a token Supabase Auth already consumed.
    assert.equal(redeemMagicLink(returned.adminTokenHash), false);

    const claimed = await pg.query<{ n: string }>(
      "select count(*)::text as n from public.idempotency_log where route = 'admin-account-switch-return'",
    );
    assert.equal(claimed.rows[0].n, '1');
  });

  test('a forged switch naming the real-hotel owner is refused and mints no session', async () => {
    const before = authWorld.minted;
    const result = await performAccountSwitch(
      {
        callerAccountId: ACCOUNT_ADMIN,
        callerAuthUserId: UID_ADMIN,
        targetAccountId: ACCOUNT_ANA,
        deviceCookieValue: null,
        nowMs: Date.now(),
      },
      livePerformSwitchDeps(),
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'not_switchable:reaches_real_hotel');
    assert.equal(authWorld.minted, before, 'a refused switch must not mint any login token');
  });

  test('a non-admin caller cannot switch, even naming a genuine demo person', async () => {
    const result = await performAccountSwitch(
      {
        callerAccountId: ACCOUNT_FRANK,
        callerAuthUserId: UID_ADMIN,
        targetAccountId: ACCOUNT_FRANK,
        deviceCookieValue: null,
        nowMs: Date.now(),
      },
      livePerformSwitchDeps(),
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.status, 403);
      assert.equal(result.reason, 'not_platform_admin');
    }
  });
});
