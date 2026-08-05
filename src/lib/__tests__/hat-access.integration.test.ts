/**
 * CAN THE PEOPLE WHO OWN A MANAGEMENT COMPANY ACTUALLY GET INTO IT?
 *
 * Against a real Postgres holding two companies, because none of this is
 * provable against a mock. A fake client can show that a query carried a
 * filter; it cannot show that the woman who runs four hotels can open one.
 *
 * The bug this suite exists for: `properties` RLS (0002/0003) answers from
 * `accounts.property_access` and knows nothing about company hats (0364). A
 * company person's legacy array is EMPTY by design — every hotel they reach
 * comes from a hat — so the browser read returned zero rows with a 200 and no
 * error. The hotel list went empty, no property became active, `/home` bounced
 * to `/company`, and `/company` said "No active access grant". The entire
 * company rulebook — including the cross-hotel-chat switch, which only a
 * company-scope job may touch — was unreachable for exactly the people who own
 * it.
 *
 * What each block below would catch:
 *
 *   PROPERTIES     the app-shell read. Hat-only coverage resolves; a legacy
 *                  account is byte-identical; both walls hold; the propertyId
 *                  parameter can only narrow.
 *   ENTERING       one hotel at a time, which is what a command-centre card
 *                  click does — and the reason clicking one used to do nothing.
 *   RULEBOOK       reachable, editable, and the chat switch actually flips —
 *                  for a hats-only person and for a finance hat that the old
 *                  manager gate refused before her hats were ever read.
 *   FINANCE        the picker and the queue agree. She reads the portfolio,
 *                  `canAct` is false, and her verdict is refused by the same
 *                  route that drew the screen.
 *   HUB            a company VP's hotels and people are counted; a front-desk
 *                  hat sees its own hotel and NOT its siblings; a legacy
 *                  account at a company hotel is told who runs it.
 *   CONTROL GROUP  Wanda and Hank, who are every account in the product today.
 *                  If anything about them moves, the fix broke the product.
 *
 * PGlite runs as the table owner, exactly as the service-role key bypasses RLS
 * in production. What is under test is the app's own scoping — which for
 * `/api/properties` is now the whole of the boundary.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-min-20-chars';
process.env.CRON_SECRET ??= 'placeholder-cron-secret-min-16';
process.env.OPENAI_API_KEY ??= 'sk-placeholder';
process.env.ANTHROPIC_API_KEY ??= 'sk-ant-placeholder';
// Device-trust is a separate boundary with its own suite. Honored only outside
// production — this is what lets the tests drive the REAL route handlers.
process.env.DISABLE_SERVER_2FA_ENFORCEMENT = 'true';

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { NextRequest } from 'next/server';
import type { PGlite } from '@electric-sql/pglite';

import { supabaseAdmin } from '@/lib/supabase-admin';
import { accessibleProperties, resolveHatCoverage } from '@/lib/company/access';
import { accessProfileForHat } from '@/lib/company/roles';
import { clearPortfolioAccessCache } from '@/lib/company/portfolio';
import { fromPropertyRow } from '@/lib/db-mappers';

import { GET as propertiesGet } from '@/app/api/properties/route';
import { GET as bootstrapGet } from '@/app/api/property-selector/bootstrap/route';
import { GET as portfolioGet, POST as portfolioPost } from '@/app/api/company/queue/route';
import { GET as rulebookGet, POST as rulebookPost } from '@/app/api/company/rulebook/route';
import { GET as companyAccessGet } from '@/app/api/company-access/route';
import { POST as accountsPost } from '@/app/api/auth/accounts/route';

import { applyMigrationsToPglite } from '../../../tests/fixtures/pglite-migrate';
import { createPglitePostgrest, loadCatalog, type PglitePostgrest } from '../../../tests/fixtures/postgrest-pglite';
import {
  ACCOUNT_ADMIN,
  ACCOUNT_ANA,
  ACCOUNT_FIONA,
  ACCOUNT_FRANK,
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
  UID_ADMIN,
  UID_ANA,
  UID_FIONA,
  UID_FRANK,
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
type CreateUserFn = typeof supabaseAdmin.auth.admin.createUser;
const originalCreateUser: CreateUserFn = supabaseAdmin.auth.admin.createUser.bind(supabaseAdmin.auth.admin);

let signedInAs: string | null = null;

/**
 * A LEGACY front-desk account at Beaumont — a hotel a real management company
 * operates. No hat, no membership: her access is the `accounts.property_access`
 * array and nothing else, which is what every account in the product looked
 * like before the spine. She is the person the Company Hub told that her hotel
 * was "not grouped under a management company".
 */
const ACCOUNT_DOLORES = 'aaaa1111-0000-4000-8000-0000000000d1';
const UID_DOLORES = 'aaaa2222-0000-4000-8000-0000000000d1';
const UID_POST_INDEPENDENT = 'aaaa2222-0000-4000-8000-0000000000d2';
const UID_POST_COMPANY = 'aaaa2222-0000-4000-8000-0000000000d3';

// ─── Request helpers ────────────────────────────────────────────────────────

function req(url: string, init?: { method?: string; body?: unknown }): NextRequest {
  return new NextRequest(url, {
    method: init?.method ?? 'GET',
    headers: {
      authorization: 'Bearer hat-access-test-token',
      'content-type': 'application/json',
      'x-real-ip': '203.0.113.91',
    },
    ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
}

interface PropertiesWire { properties: Record<string, unknown>[] }

/** The app shell's own read: the hotels this person may open. */
async function propertiesFor(
  authUserId: string | null,
  propertyId?: string,
): Promise<{ status: number; ids: string[]; rows: Record<string, unknown>[] }> {
  signedInAs = authUserId;
  const url = propertyId
    ? `https://staxis.test/api/properties?propertyId=${propertyId}`
    : 'https://staxis.test/api/properties';
  const res = await propertiesGet(req(url));
  const parsed = await res.json().catch(() => ({})) as { data?: PropertiesWire };
  const rows = parsed.data?.properties ?? [];
  return { status: res.status, ids: rows.map((r) => String(r.id)).sort(), rows };
}

async function pickerHotelIdsFor(authUserId: string): Promise<string[]> {
  signedInAs = authUserId;
  clearPortfolioAccessCache();
  const res = await bootstrapGet(req('https://staxis.test/api/property-selector/bootstrap'));
  const parsed = await res.json().catch(() => ({})) as {
    data?: { hotels?: Array<{ propertyId: string }> };
  };
  return (parsed.data?.hotels ?? []).map((h) => h.propertyId).sort();
}

interface PortfolioWire {
  scope: { organizationId: string; companyRole: string; hotelCount: number } | null;
  cards: Array<{ id: string }>;
  canAct?: boolean;
}

async function portfolioFor(
  authUserId: string,
  organizationId = ORG_A,
): Promise<{ status: number; data: PortfolioWire }> {
  signedInAs = authUserId;
  const res = await portfolioGet(req(
    `https://staxis.test/api/company/queue?organizationId=${organizationId}`,
  ));
  const parsed = await res.json().catch(() => ({})) as { data?: PortfolioWire };
  return { status: res.status, data: parsed.data ?? { scope: null, cards: [], canAct: undefined } };
}

async function portfolioVerdict(
  authUserId: string,
  findingId: string,
  organizationId = ORG_A,
): Promise<number> {
  signedInAs = authUserId;
  const res = await portfolioPost(req('https://staxis.test/api/company/queue', {
    method: 'POST',
    body: { organizationId, findingId, action: 'known_problem' },
  }));
  return res.status;
}

interface RulebookWire {
  organizationId: string;
  canEdit: boolean;
  companyRole: string | null;
  settings: Record<string, string | null>;
}

async function rulebookFor(
  authUserId: string,
  scopeId: string,
  scope: 'organization' | 'property' = 'organization',
): Promise<{ status: number; data: RulebookWire | null }> {
  signedInAs = authUserId;
  const res = await rulebookGet(
    req(`https://staxis.test/api/company/rulebook?${scope === 'organization' ? 'organizationId' : 'propertyId'}=${scopeId}`),
  );
  const parsed = await res.json().catch(() => ({})) as { data?: RulebookWire };
  return { status: res.status, data: parsed.data ?? null };
}

async function flipChatSwitch(
  authUserId: string,
  organizationId: string,
  value: 'true' | 'false',
): Promise<number> {
  signedInAs = authUserId;
  const res = await rulebookPost(req('https://staxis.test/api/company/rulebook', {
    method: 'POST',
    body: { organizationId, action: 'settings', settings: { cross_hotel_ai_chat: value } },
  }));
  return res.status;
}

interface HubWire {
  organizations: Array<{ id: string; name: string; type: string }>;
  portfolios: Array<{ id: string; propertyIds: string[] }>;
  properties: Array<{ id: string; name: string; organizationId?: string | null; operatingCompanyName?: string | null }>;
  memberships: Array<{
    accountId: string;
    status: string;
    accessProfile: string | null;
    grants?: Array<{
      accessProfile: string;
      scopeType: string;
      propertyIds: string[];
      source?: string;
      status?: string;
      isMembershipAccess?: boolean;
    }>;
  }>;
  effectiveAccess: Array<{ id: string; accessProfile: string; scopeType: string; propertyIds: string[] }>;
  accessHistory?: Array<{
    accountId: string;
    record: { status?: string; propertyIds: string[]; source?: string };
  }>;
  permissions: {
    viewHotels: boolean;
    viewPeople: boolean;
    manageInvitations?: boolean;
    accountInvitePropertyIds?: string[];
    delegationPolicies?: Array<{
      organizationId: string;
      profiles: Array<{ accessProfile: string; portfolioIds: string[]; propertyIds: string[] }>;
    }>;
  };
  legacyFallback?: boolean;
}

async function hubFor(authUserId: string): Promise<{ status: number; data: HubWire | null }> {
  signedInAs = authUserId;
  const res = await companyAccessGet(req('https://staxis.test/api/company-access'));
  const parsed = await res.json().catch(() => ({})) as { data?: HubWire };
  return { status: res.status, data: parsed.data ?? null };
}

async function createAccountViaPost(args: {
  authUserId: string;
  username: string;
  email: string;
  propertyAccess: string[];
}): Promise<string> {
  // The route uses Supabase Auth for the first half of creation. This shim
  // persists the real auth identity into the same PGlite database, then the
  // route's own canonical scope RPC handles the accounts row and bridges.
  supabaseAdmin.auth.admin.createUser = (async (input: { email: string }) => {
    await pg.query(
      `insert into auth.users (id, email) values ($1, $2)`,
      [args.authUserId, input.email],
    );
    return {
      data: {
        user: {
          id: args.authUserId,
          email: input.email,
          created_at: new Date().toISOString(),
        },
      },
      error: null,
    };
  }) as CreateUserFn;
  try {
    signedInAs = UID_ADMIN;
    const response = await accountsPost(new NextRequest('https://staxis.test/api/auth/accounts', {
      method: 'POST',
      headers: {
        authorization: 'Bearer hat-access-test-token',
        'content-type': 'application/json',
        'x-account-id': ACCOUNT_ADMIN,
      },
      body: JSON.stringify({
        username: args.username,
        email: args.email,
        password: 'stage-b-password-123',
        displayName: args.username,
        role: 'owner',
        propertyAccess: args.propertyAccess,
      }),
    }));
    const body = await response.json() as { data?: { accountId?: string }; error?: unknown };
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.ok(body.data?.accountId, JSON.stringify(body));
    return body.data.accountId;
  } finally {
    supabaseAdmin.auth.admin.createUser = originalCreateUser;
  }
}

async function legacyAccessOf(accountId: string): Promise<string[]> {
  const row = await pg.query<{ property_access: string[] | null }>(
    'select property_access from public.accounts where id = $1', [accountId],
  );
  return row.rows[0]?.property_access ?? [];
}

// ─── The BROWSER's own path ─────────────────────────────────────────────────
//
// Every helper above drives a SERVER route: `supabaseAdmin` is shimmed onto
// pglite, and pglite runs those queries as the table owner — exactly as the
// service-role key bypasses RLS in production. That is the right model for a
// route, and it is why none of those tests can see the bug this block is for.
//
// A signed-in browser is a different caller. It holds the ANON key, Postgres
// sees the `authenticated` role, and RLS is the whole of the boundary. So this
// helper stops being the owner: it drops to `authenticated` and plants the JWT
// claims a real session carries, transaction-locally, so the policies run for
// real. What comes back is what the screen would render.
async function runAs(
  authUserId: string | null,
  sql: string,
  params: unknown[] = [],
): Promise<Record<string, unknown>[]> {
  await pg.exec('begin');
  try {
    await pg.exec('set local role authenticated');
    // `mfa_verified` because every policy below is also gated on
    // `mfa_verified_or_grace()`. Leaving it out would make every assertion here
    // pass for the wrong reason — an empty read proving the MFA gate works
    // rather than the reach gate failing.
    await pg.query('select set_config($1, $2, true)', [
      'request.jwt.claims',
      JSON.stringify({ sub: authUserId, role: 'authenticated', mfa_verified: true }),
    ]);
    await pg.query('select set_config($1, $2, true)', [
      'request.jwt.claim.sub', authUserId ?? '',
    ]);
    await pg.query('select set_config($1, $2, true)', [
      'request.jwt.claim.role', 'authenticated',
    ]);
    const result = await pg.query<Record<string, unknown>>(sql, params);
    await pg.exec('commit');
    return result.rows;
  } catch (e) {
    await pg.exec('rollback').catch(() => undefined);
    throw e;
  }
}

/** The hotels this person's BROWSER can actually see, straight out of RLS. */
async function hotelsVisibleToBrowser(authUserId: string | null): Promise<string[]> {
  const rows = await runAs(authUserId, 'select id from public.properties');
  return rows.map((r) => String(r.id)).sort();
}

/**
 * The hotels a company GOVERNS right now, read from the ledger rather than
 * from the test's memory of what it seeded. `is_primary_grouping` +
 * operator/owner is the one live link that means "this company runs this
 * building"; a brand or franchisor row, or an operator row stood down when
 * somebody else took the hotel over, is not coverage.
 */
async function hotelsGovernedBy(organizationId: string): Promise<string[]> {
  const rows = await pg.query<{ property_id: string }>(
    `select property_id from public.organization_property_relationships
      where organization_id = $1
        and is_primary_grouping
        and relationship_type in ('operator', 'owner')
        and starts_at <= now()
        and (ends_at is null or ends_at > now())`,
    [organizationId],
  );
  return rows.rows.map((r) => String(r.property_id)).sort();
}

/** A company-scope finding, the only kind the portfolio POST accepts. */
async function plantCompanyFinding(organizationId: string): Promise<string> {
  const row = await pg.query<{ id: string }>(
    `insert into public.company_findings
       (organization_id, detector_id, dedupe_key, summary, severity, disposition, status,
        receipt_query_id, evidence, magnitude, affected_property_ids,
        first_seen_at, last_seen_at, status_changed_at)
     values ($1, 'portfolio_supply_spend_gap', 'probe:portfolio',
             'One hotel has a verified laundry supply gap.',
             'attention', 'recommend', 'open', 'probe_receipt', $2::jsonb, 3,
             array[$3::uuid], now(), now(), now())
     returning id`,
    [
      organizationId,
      JSON.stringify({
        queryId: 'probe_receipt',
        params: { hotel_ids: [PID_A1] },
        values: {},
        basis: 'planted',
      }),
      PID_A1,
    ],
  );
  return row.rows[0].id;
}

// ─── Fixture ────────────────────────────────────────────────────────────────

let PORTFOLIO_FINDING = '';

before(async () => {
  const migrated = await applyMigrationsToPglite();
  pg = migrated.pg;
  const catalog = await loadCatalog(pg);
  shim = createPglitePostgrest(pg, catalog);
  // @ts-expect-error installing the pglite-backed client on the singleton
  supabaseAdmin.from = shim.from;
  // @ts-expect-error installing the pglite-backed client on the singleton
  supabaseAdmin.rpc = shim.rpc;
  // @ts-expect-error the tests only need the id the session gate reads
  supabaseAdmin.auth.getUser = async () => (
    signedInAs
      ? { data: { user: { id: signedInAs, email: 'someone@example.test' } }, error: null }
      : { data: { user: null }, error: { message: 'no session', status: 401, name: 'AuthApiError' } }
  );

  seed = await seedTwoCompanies(pg);

  await pg.query(
    `insert into auth.users (id, email) values ($1, 'dolores@example.test')
     on conflict (id) do nothing`,
    [UID_DOLORES],
  );
  await pg.query(
    `insert into accounts (id, username, password_hash, display_name, role, property_access, data_user_id)
     values ($1, 'dolores', 'x', 'Dolores', 'front_desk', $2, $3)
     on conflict (id) do nothing`,
    [ACCOUNT_DOLORES, [PID_A1], UID_DOLORES],
  );

  PORTFOLIO_FINDING = await plantCompanyFinding(ORG_A);

  // Supabase's stock grants, which the migrations assume rather than state:
  // `authenticated` holds table privileges and RLS decides the rows. Without
  // them the reads in the RLS-DEPTH block below would fail with "permission
  // denied for table" — a different code path that would go red whether the
  // reach rule was right or wrong, and therefore prove nothing.
  await pg.exec(`
    do $$
    declare t record;
    begin
      for t in select tablename from pg_tables where schemaname = 'public'
      loop
        execute format(
          'grant select, insert, update, delete on public.%I to authenticated', t.tablename);
      end loop;
    end $$;
  `);

  // One housekeeper per hotel. The hotel ROW is only the doorway — the reason
  // the empty screen was app-wide is that `staff` is read by PropertyContext on
  // every authenticated page, so a reach rule that stops at `properties` would
  // let a VP in and then show her a hotel with nobody working at it.
  await pg.query(
    `insert into public.staff (property_id, name) values
       ($1, 'Beaumont Housekeeper'), ($2, 'Lufkin Housekeeper'),
       ($3, 'Tyler Housekeeper'),    ($4, 'Waco Housekeeper')`,
    [PID_A1, PID_A2, PID_B1, PID_L1],
  );
});

after(async () => {
  supabaseAdmin.from = originalFrom;
  supabaseAdmin.rpc = originalRpc;
  supabaseAdmin.auth.getUser = originalGetUser;
  await pg?.close();
});

// ═══ THE COVERAGE RULE, ONCE ════════════════════════════════════════════════

describe('the coverage rule has exactly one implementation', () => {
  // Mutation: make a property hat fall back to its listed hotels when the
  // company no longer operates them. A GM would keep a hotel their company sold.
  test('a property hat is intersected with what the company operates, never unioned', () => {
    assert.deepEqual(
      resolveHatCoverage('property', ['h1', 'h2'], ['h1']),
      ['h1'],
      'a hotel the company no longer operates survived on the hat',
    );
  });

  // Mutation: resolve a company hat from covered_property_ids. Every hotel the
  // company bought after the hat was written would vanish.
  test('a company hat reaches every hotel the company operates right now', () => {
    assert.deepEqual(
      resolveHatCoverage('company', [], ['h2', 'h1']).sort(),
      ['h1', 'h2'],
      'a company hat did not reach the company',
    );
  });

  // Mutation: map finance to property_manager, or line staff to department_lead.
  // Either hands somebody the company's people list to look at their own hotel.
  test('the hat -> access-profile degradation is least privilege', () => {
    assert.equal(accessProfileForHat('company', 'owner'), 'organization_owner');
    assert.equal(accessProfileForHat('company', 'vp'), 'portfolio_manager');
    assert.equal(accessProfileForHat('company', 'finance'), 'contributor');
    assert.equal(accessProfileForHat('property', 'general_manager'), 'property_manager');
    assert.equal(accessProfileForHat('property', 'front_desk'), 'viewer');
    assert.equal(accessProfileForHat('property', 'housekeeping'), 'viewer');
  });
});

// ═══ THE APP SHELL'S HOTEL LIST ═════════════════════════════════════════════

describe('/api/properties — the read that decides whether anyone gets in', () => {
  test('no session, no hotels', async () => {
    const anon = await propertiesFor(null);
    assert.equal(anon.status, 401, 'an unauthenticated caller was served the fleet');
  });

  // THE FLAGGED BUG. Mutation: read `properties` through the anon client, or
  // filter the result by `accounts.property_access` — either one returns [] and
  // Maria cannot enter a single hotel.
  test('a dual-hat GM+VP with an EMPTY legacy array gets her hotels', async () => {
    assert.deepEqual(
      await legacyAccessOf(ACCOUNT_MARIA), [],
      'fixture drift: Maria grew a legacy array, so this proves nothing',
    );
    const maria = await propertiesFor(UID_MARIA);
    assert.equal(maria.status, 200);
    assert.deepEqual(maria.ids, [PID_A1, PID_A2].sort(), 'the hats did not resolve to hotels');
  });

  // The rows have to be USABLE, not merely present: the app shell reads timezone,
  // enabled_sections and the onboarding fields off every one of them. Mutation:
  // narrow the route's select list and this fails on the mapper's own contract.
  test('the rows carry every column the app shell maps', async () => {
    const maria = await propertiesFor(UID_MARIA, PID_A1);
    assert.equal(maria.rows.length, 1);
    const property = fromPropertyRow(maria.rows[0]);
    assert.equal(property.id, PID_A1);
    assert.equal(property.name, 'Beaumont Suites');
    assert.equal(property.totalRooms, 60);
    assert.equal(property.timezone, 'America/Chicago');
    assert.equal(property.onboardingCompletedAt, null);
  });

  // What a command-centre card click actually needs: this exact hotel, resolved.
  // Mutation: drop the membership half of the union and BOTH of these go empty,
  // which is precisely why clicking a card used to do nothing at all.
  test('every hotel her hats cover opens one at a time', async () => {
    for (const propertyId of [PID_A1, PID_A2]) {
      const one = await propertiesFor(UID_MARIA, propertyId);
      assert.equal(one.status, 200);
      assert.deepEqual(one.ids, [propertyId], `${propertyId} would not open`);
    }
  });

  // Mutation: substitute the propertyId parameter for the coverage set instead
  // of intersecting with it. This is the whole tenant wall on this route.
  test('the propertyId parameter can only narrow — company A cannot ask for company B', async () => {
    const acrossTheWall = await propertiesFor(UID_MARIA, PID_B1);
    assert.equal(acrossTheWall.status, 200, 'a refusal must not be an error the client retries');
    assert.deepEqual(acrossTheWall.ids, [], "company B's hotel crossed the wall");
  });

  test('and the wall holds from the other side too', async () => {
    const vera = await propertiesFor(UID_VERA);
    assert.deepEqual(vera.ids, [PID_B1], "company B's VP reached past her company");
    assert.deepEqual((await propertiesFor(UID_VERA, PID_A1)).ids, []);
  });

  // Wall A, inside one company. Mutation: resolve a property hat as a company
  // hat and Frank learns Lufkin exists.
  test('a front-desk hat sees its own hotel and never its siblings', async () => {
    const frank = await propertiesFor(UID_FRANK);
    assert.deepEqual(frank.ids, [PID_A1], 'a front-desk person was handed the company');
  });

  // Mutation: read the legacy array only, or the hats only. Wanda is every
  // account in the product today; if she moves, the fix broke the product.
  test('a legacy single-hotel owner is byte-identical (zero-regression control)', async () => {
    const wanda = await propertiesFor(UID_WANDA);
    assert.equal(wanda.status, 200);
    assert.deepEqual(wanda.ids, [PID_L1]);
    const property = fromPropertyRow(wanda.rows[0]);
    assert.equal(property.name, 'Waco Inn');
    assert.deepEqual((await propertiesFor(UID_WANDA, PID_A1)).ids, [], 'a legacy owner reached a company hotel');
  });

  test('a legacy housekeeper is served, and served exactly her hotel', async () => {
    const hank = await propertiesFor(UID_HANK);
    assert.deepEqual(hank.ids, [PID_L1], 'the manager gate got into the app shell');
  });

  test('a Staxis administrator still reaches the fleet', async () => {
    const admin = await propertiesFor(UID_ADMIN);
    assert.ok(admin.ids.includes(PID_A1) && admin.ids.includes(PID_B1) && admin.ids.includes(PID_L1));
  });

  test('a bad propertyId is a validation error, not an empty hotel list', async () => {
    signedInAs = UID_MARIA;
    const res = await propertiesGet(req('https://staxis.test/api/properties?propertyId=not-a-uuid'));
    assert.equal(res.status, 400);
  });

  // Mutation: re-stamp coverage at invite time instead of resolving it. The
  // hotel the company bought this morning would need everyone re-invited.
  test('a hotel added to the company later appears with no re-invite', async () => {
    assert.ok(!(await propertiesFor(UID_MARIA)).ids.includes(PID_A3), 'fixture drift');
    await seed.attachPropertyToOrganization(pg, ORG_A, PID_A3, 'Port Arthur Suites');

    const after = await propertiesFor(UID_MARIA);
    assert.ok(after.ids.includes(PID_A3), 'the new hotel never reached the app shell');
    assert.deepEqual(
      await legacyAccessOf(ACCOUNT_MARIA), [],
      'coverage was re-stamped onto the account instead of resolved',
    );
    // Wall A again, now that the company is bigger: Frank was not widened.
    assert.deepEqual((await propertiesFor(UID_FRANK)).ids, [PID_A1]);
  });
});

// ═══ THE COMPANY RULEBOOK, REACHABLE AT LAST ════════════════════════════════

describe('the rulebook and the cross-hotel-chat switch', () => {
  // Mutation: gate the rulebook route on loadManagerCaller. Restores the 404
  // that made the panel render null for the only people allowed to edit it.
  test('a hats-only VP reaches her company book and may edit it', async () => {
    const maria = await rulebookFor(UID_MARIA, ORG_A);
    assert.equal(maria.status, 200, 'the person who owns the book could not open it');
    assert.equal(maria.data?.organizationId, ORG_A);
    assert.equal(maria.data?.canEdit, true, 'rulebook_editors names the VP and she was refused');
  });

  // The switch itself — the control the finding said was unreachable.
  test('and the cross-hotel-chat switch actually flips', async () => {
    assert.equal(
      (await rulebookFor(UID_MARIA, ORG_A)).data?.settings.cross_hotel_ai_chat ?? 'false',
      'false',
      'fixture drift: chat was already on',
    );
    assert.equal(await flipChatSwitch(UID_MARIA, ORG_A, 'true'), 200);
    assert.equal((await rulebookFor(UID_MARIA, ORG_A)).data?.settings.cross_hotel_ai_chat, 'true');
    assert.equal(await flipChatSwitch(UID_MARIA, ORG_A, 'false'), 200, 'and back off');
  });

  // Mutation: gate on loadManagerCaller. Fiona's legacy role is `front_desk`,
  // so she was 404'd out of the book her own company governs her by.
  test("a finance hat may READ the book and may not write it", async () => {
    const fiona = await rulebookFor(UID_FIONA, ORG_A);
    assert.equal(fiona.status, 200, 'the finance lead was refused the company book');
    assert.equal(fiona.data?.companyRole, 'finance');
    assert.equal(fiona.data?.canEdit, false, 'finance was handed the pen');
    assert.equal(await flipChatSwitch(UID_FIONA, ORG_A, 'true'), 403, 'finance flipped a company switch');
  });

  // The wall did not move when the gate did.
  test('a legacy account with no hat is still refused, and the other company is still refused', async () => {
    assert.equal(
      (await rulebookFor(UID_WANDA, PID_L1, 'property')).status,
      404,
      'an independent hotel grew a rulebook',
    );
    assert.equal((await rulebookFor(UID_VERA, ORG_A)).status, 404, "company B read company A's book");
    assert.equal((await rulebookFor(UID_DOLORES, ORG_A)).status, 404, 'a hatless legacy account read the book');
  });
});

// ═══ FINANCE: ONE COHERENT ANSWER ═══════════════════════════════════════════

describe('the finance lead — the picker and the queue now agree', () => {
  // The incoherence, stated as a test: the same person, the same session, two
  // routes. Mutation: gate the queue GET on loadManagerCaller and this fails
  // exactly the way the tour agent found it.
  test('the picker admits her AND the queue serves her', async () => {
    const picker = await pickerHotelIdsFor(UID_FIONA);
    assert.ok(picker.length > 0, 'the picker stopped admitting the finance lead');

    const queue = await portfolioFor(UID_FIONA);
    assert.equal(queue.status, 200, 'the door she was shown was locked');
    assert.equal(queue.data.scope?.companyRole, 'finance');
    assert.ok((queue.data.scope?.hotelCount ?? 0) > 0, 'her portfolio was empty');
  });

  // Mutation: default canAct to true, or read it off `accounts.role`. She would
  // be shown three verdict buttons that the POST below refuses.
  test('she is drawn read-only, and the route refuses the verdict she cannot cast', async () => {
    const queue = await portfolioFor(UID_FIONA);
    assert.equal(queue.data.canAct, false, 'finance was offered verdict buttons');
    assert.equal(
      await portfolioVerdict(UID_FIONA, PORTFOLIO_FINDING), 403,
      'finance silenced a hotel problem',
    );
  });

  test('a VP with explicit hotel standing can act only on that hotel-scoped finding', async () => {
    const queue = await portfolioFor(UID_MARIA);
    assert.equal(queue.status, 200);
    assert.equal(queue.data.canAct, true, 'the exact hotel standing was not reflected in the card');
    assert.equal(await portfolioVerdict(UID_MARIA, PORTFOLIO_FINDING), 200);
    const row = await pg.query<{ status: string }>(
      'select status from public.company_findings where id = $1', [PORTFOLIO_FINDING],
    );
    assert.equal(row.rows[0]?.status, 'known_problem', 'the authorized verdict was not saved');
  });

  // Wall A on this surface, unchanged by the wider gate.
  test('a hotel-only person still has no portfolio at all', async () => {
    const frank = await portfolioFor(UID_FRANK);
    assert.equal(frank.status, 404, 'a property-only actor was handed an aggregate queue');
    assert.equal(frank.data.scope, null, 'a front-desk hat was handed a portfolio');

    const hank = await portfolioFor(UID_HANK);
    assert.equal(hank.data.scope, null, 'a legacy housekeeper was handed a portfolio');
  });

  test("company B's finding is not company A's to silence", async () => {
    assert.equal(
      await portfolioVerdict(UID_VERA, PORTFOLIO_FINDING, ORG_B), 404,
      "company B's VP reached into company A's ledger",
    );
  });
});

// ═══ THE COMPANY HUB ════════════════════════════════════════════════════════

describe('the Company Hub reads the spine', () => {
  // Mutation: drop the hat fold-in of actorPropertyIds / actorCapabilities.
  // Restores "Hotels in scope 0", "Active people 0", "No active access grant".
  test("a company VP's hotels and people are counted, and her access has a receipt", async () => {
    const hub = await hubFor(UID_MARIA);
    assert.equal(hub.status, 200);
    const ids = (hub.data?.properties ?? []).map((p) => p.id).sort();
    assert.ok(ids.includes(PID_A1) && ids.includes(PID_A2), `the hub found ${ids.length} hotels`);
    assert.equal(hub.data?.permissions.viewHotels, true);
    assert.equal(hub.data?.permissions.viewPeople, true, 'the VP could not see her own people');
    assert.equal(hub.data?.permissions.manageInvitations, true);
    assert.deepEqual(
      hub.data?.permissions.accountInvitePropertyIds,
      await hotelsGovernedBy(ORG_A),
      'the company VP was not offered the guarded invitation flow at her exact hotels',
    );

    const active = (hub.data?.memberships ?? []).filter((m) => m.status === 'active');
    assert.ok(active.length > 1, `the people panel found ${active.length} people at a five-person company`);
    assert.ok(
      active.some((m) => m.accountId === ACCOUNT_FIONA),
      'a hat-only colleague was invisible on the company people panel',
    );

    assert.ok(
      (hub.data?.effectiveAccess ?? []).length > 0,
      '"No active access grant" — the dead end the tour agent hit',
    );
    assert.ok(
      (hub.data?.effectiveAccess ?? []).some((r) => r.accessProfile === 'portfolio_manager'),
      "the VP's hat produced no receipt",
    );
    const mariaGrants = (hub.data?.memberships ?? [])
      .filter((membership) => membership.accountId === ACCOUNT_MARIA)
      .flatMap((membership) => membership.grants ?? []);
    assert.ok(
      mariaGrants.some((grant) => grant.source === 'direct' && grant.scopeType === 'property'),
      "Maria's hotel role lost its direct source",
    );
    assert.ok(
      mariaGrants.some((grant) => grant.source === 'company' && grant.accessProfile === 'portfolio_manager'),
      "Maria's company role lost its inherited source",
    );
    assert.ok(
      mariaGrants.every((grant) => grant.propertyIds.every((propertyId) => ids.includes(propertyId))),
      'an access row named a hotel outside the selected company topology',
    );
  });

  // Wall A on the hub. Mutation: fold a property hat in as organization scope.
  test('a front-desk hat sees its own hotel and no sibling, and no people list', async () => {
    const hub = await hubFor(UID_FRANK);
    assert.equal(hub.status, 200);
    assert.deepEqual(
      (hub.data?.properties ?? []).map((p) => p.id).sort(), [PID_A1],
      'a front-desk person was shown the portfolio',
    );
    assert.equal(hub.data?.permissions.viewPeople, false, 'line staff got the company roster');
    assert.equal(hub.data?.permissions.manageInvitations, false);
    assert.deepEqual(hub.data?.permissions.accountInvitePropertyIds, []);
    const others = (hub.data?.memberships ?? []).filter((m) => m.accountId !== ACCOUNT_MARIA);
    assert.ok(
      !others.some((m) => m.accountId === ACCOUNT_FIONA),
      "a front-desk person was shown the company's finance lead",
    );
  });

  test('a stood-down or non-governing company relationship never enters the service projection', async () => {
    await pg.query(
      `insert into public.organization_property_relationships
         (organization_id, property_id, relationship_type, is_primary_grouping)
       values ($1, $2, 'operator', false), ($1, $3, 'brand', false)`,
      [ORG_B, PID_A1, PID_A2],
    );
    try {
      const hub = await hubFor(UID_VERA);
      assert.equal(hub.status, 200);
      assert.deepEqual(
        (hub.data?.properties ?? []).map((property) => property.id).sort(),
        [PID_B1],
        'the service-role Company Hub exposed a former operator or brand-linked hotel',
      );
    } finally {
      await pg.query(
        `delete from public.organization_property_relationships
          where organization_id = $1 and property_id = any($2::uuid[])
            and not is_primary_grouping`,
        [ORG_B, [PID_A1, PID_A2]],
      );
    }
  });

  test('a root-region grant projects descendant hotels, receipts, and delegation targets', async () => {
    const rootPortfolioId = 'a0a0a0a0-0000-4000-8000-000000000001';
    const childPortfolioId = 'a0a0a0a0-0000-4000-8000-000000000002';
    const assignmentId = 'a0a0a0a0-0000-4000-8000-000000000003';
    const grantId = 'a0a0a0a0-0000-4000-8000-000000000004';
    const membershipId = seed.hats.get(`${ACCOUNT_FRANK}:property:front_desk`);
    assert.ok(membershipId, 'fixture did not record Frank\'s membership');
    const relationship = await pg.query<{ id: string }>(
      `select id from public.organization_property_relationships
        where organization_id = $1 and property_id = $2
          and is_primary_grouping and relationship_type in ('owner', 'operator')`,
      [ORG_A, PID_A2],
    );
    assert.ok(relationship.rows[0]?.id, 'fixture did not govern the descendant hotel');

    await pg.query(
      `insert into public.portfolios
         (id, organization_id, parent_id, name, portfolio_type, status)
       values ($1, $3, null, 'East Region', 'region', 'active'),
              ($2, $3, $1, 'Pine Portfolio', 'portfolio', 'active')`,
      [rootPortfolioId, childPortfolioId, ORG_A],
    );
    await pg.query(
      `insert into public.portfolio_properties
         (id, organization_id, portfolio_id, property_relationship_id, property_id)
       values ($1, $2, $3, $4, $5)`,
      [assignmentId, ORG_A, childPortfolioId, relationship.rows[0].id, PID_A2],
    );
    await pg.query(
      `insert into public.organization_access_grants
         (id, organization_id, membership_id, access_profile, scope_type,
          portfolio_id, source, starts_at)
       values ($1, $2, $3, 'portfolio_manager', 'portfolio', $4, 'manual', now())`,
      [grantId, ORG_A, membershipId, rootPortfolioId],
    );
    try {
      const hub = await hubFor(UID_FRANK);
      assert.equal(hub.status, 200);
      assert.deepEqual(
        (hub.data?.properties ?? []).map((property) => property.id).sort(),
        [PID_A1, PID_A2].sort(),
        'the nested region grant did not reach its child hotel',
      );
      assert.deepEqual(
        (hub.data?.portfolios ?? []).map((portfolio) => portfolio.id).sort(),
        [rootPortfolioId, childPortfolioId].sort(),
        'the route omitted the granted region or its active child',
      );
      assert.deepEqual(
        hub.data?.effectiveAccess.find((receipt) => receipt.id === grantId)?.propertyIds,
        [PID_A2],
        'the effective receipt disagreed with the authoritative nested scope',
      );
      const propertyManagerPolicy = hub.data?.permissions.delegationPolicies
        ?.find((policy) => policy.organizationId === ORG_A)
        ?.profiles.find((profile) => profile.accessProfile === 'property_manager');
      assert.deepEqual(
        propertyManagerPolicy?.propertyIds,
        [PID_A2],
        'the Access UI could not delegate within the exact descendant scope',
      );
    } finally {
      await pg.query('delete from public.organization_access_grants where id = $1', [grantId]);
      await pg.query('delete from public.portfolio_properties where id = $1', [assignmentId]);
      await pg.query('delete from public.portfolios where id = any($1::uuid[])', [[rootPortfolioId, childPortfolioId]]);
    }
  });

  // The MEDIUM finding's second half. Mutation: drop operatingCompanyNames and
  // Dolores is told, on her own hub page, that nobody runs her hotel.
  test('a legacy account at a company hotel is told who runs it', async () => {
    const hub = await hubFor(UID_DOLORES);
    assert.equal(hub.status, 200);
    const beaumont = (hub.data?.properties ?? []).find((p) => p.id === PID_A1);
    assert.ok(beaumont, 'her own hotel was missing from her hub');
    assert.equal(
      beaumont?.operatingCompanyName, 'Gulf Coast Hotels',
      'her hotel was filed under "not grouped under a management company"',
    );
    // And the wall: naming the operator hands her nothing else of theirs.
    assert.deepEqual(
      (hub.data?.properties ?? []).map((p) => p.id), [PID_A1],
      "naming the operator leaked the operator's other hotels",
    );
    assert.equal(hub.data?.permissions.viewPeople, false);
  });

  // Zero regression: an independent hotel has no operator to name, and saying
  // one would be the same lie in the other direction.
  test('an independent hotel is still independent', async () => {
    await pg.query(
      `insert into public.organization_property_relationships
         (organization_id, property_id, relationship_type, is_primary_grouping)
       values ($1, $2, 'brand', false), ($1, $2, 'operator', false)`,
      [ORG_B, PID_L1],
    );
    try {
      const hub = await hubFor(UID_WANDA);
      assert.equal(hub.status, 200);
      const waco = (hub.data?.properties ?? []).find((p) => p.id === PID_L1);
      assert.ok(waco, 'the legacy owner lost her own hotel');
      assert.equal(
        waco?.operatingCompanyName ?? null,
        null,
        'a brand or stood-down operator was presented as the hotel manager',
      );
    } finally {
      await pg.query(
        `delete from public.organization_property_relationships
          where organization_id = $1 and property_id = $2 and not is_primary_grouping`,
        [ORG_B, PID_L1],
      );
    }
  });

  test('account creation projects exact bridge-only independent and multi-hotel Hub scope', async () => {
    const independentAccountId = await createAccountViaPost({
      authUserId: UID_POST_INDEPENDENT,
      username: 'stage-b-independent-owner',
      email: 'stage-b-independent-owner@example.test',
      propertyAccess: [PID_L1],
    });
    const companyAccountId = await createAccountViaPost({
      authUserId: UID_POST_COMPANY,
      username: 'stage-b-company-owner',
      email: 'stage-b-company-owner@example.test',
      propertyAccess: [PID_A1, PID_A2],
    });

    assert.deepEqual(await legacyAccessOf(independentAccountId), []);
    assert.deepEqual(await legacyAccessOf(companyAccountId), []);
    const membershipRows = await pg.query<{ account_id: string }>(
      `select account_id from public.organization_memberships
        where account_id = any($1::uuid[])`,
      [[independentAccountId, companyAccountId]],
    );
    const grantRows = await pg.query<{ membership_id: string }>(
      `select membership_id from public.organization_access_grants
        where membership_id in (
          select id from public.organization_memberships
           where account_id = any($1::uuid[])
        )`,
      [[independentAccountId, companyAccountId]],
    );
    assert.deepEqual(membershipRows.rows, []);
    assert.deepEqual(grantRows.rows, []);

    const independentHub = await hubFor(UID_POST_INDEPENDENT);
    assert.equal(independentHub.status, 200);
    assert.deepEqual(independentHub.data?.properties.map((property) => property.id), [PID_L1]);
    assert.equal(independentHub.data?.memberships.length, 0);
    assert.deepEqual(independentHub.data?.effectiveAccess[0]?.propertyIds, [PID_L1]);
    assert.deepEqual(independentHub.data?.permissions.accountInvitePropertyIds, [PID_L1]);
    assert.equal(independentHub.data?.legacyFallback, false);

    const companyHub = await hubFor(UID_POST_COMPANY);
    assert.equal(companyHub.status, 200);
    assert.deepEqual(
      companyHub.data?.properties.map((property) => property.id).sort(),
      [PID_A1, PID_A2].sort(),
    );
    assert.deepEqual(companyHub.data?.organizations.map((organization) => organization.id), [ORG_A]);
    assert.equal(companyHub.data?.memberships.length, 0);
    assert.deepEqual(
      companyHub.data?.effectiveAccess.flatMap((receipt) => receipt.propertyIds).sort(),
      [PID_A1, PID_A2].sort(),
    );
    assert.deepEqual(companyHub.data?.permissions.accountInvitePropertyIds, [PID_A1, PID_A2].sort());
    assert.equal(companyHub.data?.legacyFallback, false);

    await pg.query(`update public.organizations set status = 'inactive' where id = $1`, [ORG_A]);
    try {
      const suspendedCompanyHub = await hubFor(UID_POST_COMPANY);
      assert.equal(suspendedCompanyHub.status, 200);
      assert.deepEqual(
        suspendedCompanyHub.data?.properties.map((property) => property.id),
        [],
        'a bridge-only account retained Company Hub properties under a suspended topology',
      );
    } finally {
      await pg.query(`update public.organizations set status = 'active' where id = $1`, [ORG_A]);
    }

    assert.deepEqual((await propertiesFor(UID_POST_COMPANY, PID_B1)).ids, []);
    assert.deepEqual((await propertiesFor(UID_POST_INDEPENDENT, PID_A1)).ids, []);
  });
});

// ═══ THE SPINE ITSELF, UNMOVED ══════════════════════════════════════════════

describe('nothing about the spine changed while the readers did', () => {
  test('accessibleProperties still answers exactly as the routes above report', async () => {
    const maria = await accessibleProperties(ACCOUNT_MARIA);
    assert.equal(maria.all, false);
    assert.deepEqual(maria.legacyPropertyIds, [], 'not one hotel of hers came from the legacy array');
    assert.deepEqual(
      maria.propertyIds, (await propertiesFor(UID_MARIA)).ids,
      'the route and the spine disagree about her hotels',
    );
  });

  test('the control group is still the legacy array, verbatim', async () => {
    const wanda = await accessibleProperties('1e6ac41e-0000-4000-8000-000000000002');
    assert.deepEqual(wanda.propertyIds, [PID_L1]);
    assert.deepEqual(wanda.membershipPropertyIds, []);
    assert.deepEqual(wanda.propertyIds, wanda.legacyPropertyIds);
  });
});

// ═══ RLS DEPTH — THE SAME BUG, ONE LAYER DOWN ═══════════════════════════════
//
// Every test above proves a SERVER ROUTE now answers for a hat. That closed the
// door the company owners were standing outside of, and it left the building's
// other twenty-odd doors keyed to the old lock.
//
// `user_owns_property()` — the predicate 52 policies across 46 tables call — has
// answered from `accounts.property_access` since migration 0002. A hat-only
// person's array is EMPTY BY DESIGN. So every read a signed-in BROWSER still
// makes with the anon client came back `[]` with a 200 and no error: the staff
// roster PropertyContext loads on every page, the Schedule tab's clean times,
// Maintenance, Inventory, Quality, Deep Clean. Not one of them would have
// thrown. They would have rendered empty, and looked like a hotel where nothing
// had happened yet.
//
// Migration 0371 moves the rule into `staxis_account_reaches_property` — legacy
// array OR active governing hat — and leaves `user_owns_property` delegating to
// it, so all 52 policies inherit hats without a line of policy churn.
//
// These tests are the only ones in the file that are NOT the owner. They run as
// `authenticated`, which is what a browser is, so RLS is the entire boundary.
describe('RLS itself knows what a hat is (migration 0371)', () => {
  // THE HEADLINE. Mutation: delete branch 2 of staxis_account_reaches_property,
  // or point user_owns_property back at 0003's body, and Maria — who runs four
  // buildings — reads zero hotels from her own browser.
  test('a hats-only VP reads exactly her hotels, through RLS and nothing else', async () => {
    const seen = await hotelsVisibleToBrowser(UID_MARIA);

    // The two she was given, and the two she was not. Stated as containment
    // rather than a fixed list because an earlier block in this file attaches a
    // THIRD hotel to Gulf Coast, and a test that has to run in one order is a
    // test that will one day fail for a reason nobody can read.
    assert.ok(seen.includes(PID_A1) && seen.includes(PID_A2),
      'the woman who runs Gulf Coast could not see her own hotels from her browser');
    assert.ok(!seen.includes(PID_B1), "she reached the other company's hotel");
    assert.ok(!seen.includes(PID_L1), 'she reached a hotel no company operates');

    // And exactly the hotels Gulf Coast governs RIGHT NOW — no more. This is
    // the company-scope clause in full: coverage is drawn live from the
    // governing relationships, so a hotel the company picked up AFTER her hat
    // was written is already hers with nothing re-stamped, and a hotel it never
    // had never becomes hers.
    assert.deepEqual(seen, await hotelsGovernedBy(ORG_A),
      'her browser and the company ledger disagree about which hotels Gulf Coast runs');

    // And the legacy array really is empty, so nothing but the hat did it.
    assert.deepEqual(
      await legacyAccessOf(ACCOUNT_MARIA), [],
      'the fixture leaked legacy access to Maria — this test proves nothing now',
    );
  });

  // WALL A. Mutation: resolve a property hat from the company's whole hotel
  // list (drop `p_property_id = any (m.covered_property_ids)`), and the person
  // on the Beaumont front desk learns Lufkin exists.
  test('a front-desk hat reads its own hotel and never its sibling', async () => {
    assert.deepEqual(
      await hotelsVisibleToBrowser(UID_FRANK), [PID_A1],
      'a front-desk hat reached past its own hotel',
    );
  });

  // WALL B. Mutation: drop `r.organization_id = m.organization_id` from the
  // join and every hat reaches every hotel under any company.
  test('a hat in one company reads nothing of the other company', async () => {
    const vera = await hotelsVisibleToBrowser(UID_VERA);
    assert.deepEqual(vera, [PID_B1], "company B's VP saw outside company B");
    assert.ok(!vera.includes(PID_A1) && !vera.includes(PID_A2), 'Wall B fell');

    const frank = await hotelsVisibleToBrowser(UID_FRANK);
    assert.ok(!frank.includes(PID_B1), "company A's front desk reached company B");
  });

  // ZERO REGRESSION, which is the entire risk of touching this function: 0371
  // rewrote the predicate under 52 live policies. Mutation: add
  // `and a.active` to branch 1, or reorder it behind the hat branch, and every
  // account in the product today changes what it can see.
  test('the legacy control group is byte-identical to before the spine existed', async () => {
    assert.deepEqual(
      await hotelsVisibleToBrowser(UID_WANDA), [PID_L1],
      'the legacy owner lost her own hotel to a migration about hats',
    );
    assert.deepEqual(
      await hotelsVisibleToBrowser(UID_HANK), [PID_L1],
      'the legacy housekeeper lost her own hotel',
    );
  });

  // THE REAL CONTRACT. Everything above is a case; this is the rule. RLS is a
  // SECOND, INDEPENDENT answer to "which hotels does this person reach", and
  // the product is only coherent while it agrees with the app's answer. A
  // divergence in EITHER direction is a bug: RLS narrower is a silent empty
  // screen, RLS wider is a tenant leak.
  //
  // Mutation: any change to accessibleProperties() or to
  // staxis_account_reaches_property that is not made to both.
  test('RLS and accessibleProperties() answer the same question for everyone', async () => {
    const people: Array<[string, string, string]> = [
      ['Ana (company owner)', ACCOUNT_ANA, UID_ANA],
      ['Maria (GM + company VP)', ACCOUNT_MARIA, UID_MARIA],
      ['Frank (front-desk hat)', ACCOUNT_FRANK, UID_FRANK],
      ['Fiona (company finance)', ACCOUNT_FIONA, UID_FIONA],
      ['Vera (company B VP)', ACCOUNT_VERA, UID_VERA],
      ['Wanda (legacy owner)', ACCOUNT_WANDA, UID_WANDA],
      ['Hank (legacy housekeeper)', ACCOUNT_HANK, UID_HANK],
      ['Dolores (legacy, company hotel)', ACCOUNT_DOLORES, UID_DOLORES],
    ];
    for (const [who, accountId, authUserId] of people) {
      const fromApp = (await accessibleProperties(accountId)).propertyIds.slice().sort();
      const fromRls = await hotelsVisibleToBrowser(authUserId);
      assert.deepEqual(
        fromRls, fromApp,
        `${who}: the database and the app disagree about which hotels she reaches`,
      );
    }
  });

  // DEPTH. The point of fixing the PREDICATE rather than the `properties`
  // policy: a hat has to survive the second read too. Mutation: OR a hat clause
  // into the `properties` policy alone and this goes red while the headline
  // test above stays green — which is exactly the half-fix worth catching.
  test('the hat survives past the hotel row into the staff roster', async () => {
    const maria = await runAs(UID_MARIA, 'select property_id from public.staff');
    assert.deepEqual(
      [...new Set(maria.map((r) => String(r.property_id)))].sort(), [PID_A1, PID_A2].sort(),
      'a hats-only VP opened her hotels and found nobody working at them',
    );
    const frank = await runAs(UID_FRANK, 'select property_id from public.staff');
    assert.deepEqual(
      [...new Set(frank.map((r) => String(r.property_id)))], [PID_A1],
      "a front-desk hat read another hotel's roster",
    );
  });

  // THE NAMED LEFTOVER. `src/lib/db/plan-snapshots.ts` reads the hotel's clean
  // times through the ANON client to draw Housekeeping -> Schedule. This is
  // that exact statement. It stays a browser read — the page is signed-in, not
  // a public SMS link, so the RLS bug class does not demand a server route, and
  // adding one to fetch four integers would be a new surface to secure forever.
  test("the Schedule tab's clean-times read answers for a hats-only manager", async () => {
    const rows = await runAs(
      UID_MARIA,
      `select checkout_minutes, stayover_day1_minutes, stayover_day2_minutes, shift_minutes
         from public.properties where id = $1`,
      [PID_A1],
    );
    assert.equal(rows.length, 1, 'the Schedule tab would have fallen back to invented clean times');
    assert.ok(
      Number(rows[0].shift_minutes) > 0,
      'the shift length came back empty, so recommendedHKs would divide by a guess',
    );
  });

  // Mutation: grant the helper to `authenticated`, or gate it on anything other
  // than a matching `accounts.data_user_id`. A caller with no account is the
  // one input that must never find a hotel.
  test('a caller with no account reaches nothing', async () => {
    assert.deepEqual(
      await hotelsVisibleToBrowser('00000000-0000-4000-8000-0000000000ff'), [],
      'an auth user with no Staxis account was served the fleet',
    );
    assert.deepEqual(
      await hotelsVisibleToBrowser(null), [],
      'a session-less caller was served the fleet',
    );
  });

  // THE LEAK THE `is_primary_grouping` FILTER EXISTS FOR. When a hotel changes
  // management company, 0325's attach RPC stands the old operator's row DOWN
  // rather than deleting it — the row stays open, it just stops being the
  // primary grouping. Counting it as coverage hands a building's data to the
  // company that used to run it.
  //
  // Mutation: drop `and r.is_primary_grouping` and this goes red.
  test('an operator row that was stood down grants nothing', async () => {
    await pg.query(
      `insert into public.organization_property_relationships
         (organization_id, property_id, relationship_type, is_primary_grouping)
       values ($1, $2, 'operator', false)`,
      [ORG_B, PID_A1],
    );
    try {
      const vera = await hotelsVisibleToBrowser(UID_VERA);
      assert.ok(
        !vera.includes(PID_A1),
        "a stood-down operator row let the previous company keep reading the hotel it lost",
      );
      assert.deepEqual(vera, [PID_B1], 'company B reached outside company B');
    } finally {
      await pg.query(
        `delete from public.organization_property_relationships
          where organization_id = $1 and property_id = $2 and relationship_type = 'operator'
            and not is_primary_grouping`,
        [ORG_B, PID_A1],
      );
    }
  });

  // A hat is a job somebody currently holds. Suspended and revoked are the two
  // ways it stops being one, and `suspended` is the state worth testing hardest
  // because `ended_at` stays NULL through it — the row still looks open.
  //
  // Mutation: drop `and m.status = 'active'` and the suspended half goes red.
  // (`and m.ended_at is null` is deliberately restated alongside it even though
  // CHECK `organization_memberships_revoked_shape_check` currently makes the
  // two equivalent for revoked rows. It is belt over braces: if that CHECK is
  // ever loosened, the predicate must not widen as a side effect.)
  test('a hat somebody no longer holds grants nothing', async () => {
    const membershipId = seed.hats.get(`${ACCOUNT_VERA}:company:vp`);
    assert.ok(membershipId, "the fixture did not record Vera's hat");

    await pg.query(
      `update public.organization_memberships set status = 'suspended' where id = $1`,
      [membershipId],
    );
    try {
      assert.deepEqual(
        await hotelsVisibleToBrowser(UID_VERA), [],
        'a suspended hat still opened the hotel',
      );
    } finally {
      await pg.query(
        `update public.organization_memberships set status = 'active' where id = $1`,
        [membershipId],
      );
    }

    await pg.query(
      `update public.organization_memberships
          set status = 'revoked', ended_at = now() where id = $1`,
      [membershipId],
    );
    try {
      assert.deepEqual(
        await hotelsVisibleToBrowser(UID_VERA), [],
        'a revoked hat still opened the hotel',
      );
    } finally {
      await pg.query(
        `update public.organization_memberships
            set status = 'active', ended_at = null where id = $1`,
        [membershipId],
      );
    }

    // ...and she is back, so the restore really restored.
    assert.deepEqual(await hotelsVisibleToBrowser(UID_VERA), [PID_B1]);
  });

  // A wound-up company is bookkeeping, not a company. Mutation: drop
  // `and o.status = 'active'`.
  test('a company that is no longer trading grants nothing', async () => {
    await pg.query(`update public.organizations set status = 'inactive' where id = $1`, [ORG_B]);
    try {
      assert.deepEqual(
        await hotelsVisibleToBrowser(UID_VERA), [],
        'a wound-up company still handed out its hotels',
      );
    } finally {
      await pg.query(`update public.organizations set status = 'active' where id = $1`, [ORG_B]);
    }
    assert.deepEqual(await hotelsVisibleToBrowser(UID_VERA), [PID_B1]);
  });

  // A job that starts on the first of next month is not a job today.
  // Mutation: drop `and m.starts_at <= now()`.
  test('a hat that has not started yet grants nothing', async () => {
    const membershipId = seed.hats.get(`${ACCOUNT_VERA}:company:vp`);
    await pg.query(
      `update public.organization_memberships
          set starts_at = now() + interval '30 days' where id = $1`,
      [membershipId],
    );
    try {
      assert.deepEqual(
        await hotelsVisibleToBrowser(UID_VERA), [],
        'a hat that starts next month already opened the hotel',
      );
    } finally {
      await pg.query(
        `update public.organization_memberships set starts_at = now() where id = $1`,
        [membershipId],
      );
    }
    assert.deepEqual(await hotelsVisibleToBrowser(UID_VERA), [PID_B1]);
  });

  // The company sold the hotel. The relationship row stays for history, closed.
  // Mutation: drop `and (r.ends_at is null or r.ends_at > now())`.
  test('a company that has sold the hotel grants nothing', async () => {
    await pg.query(
      `update public.organization_property_relationships
          set ends_at = now()
        where organization_id = $1 and property_id = $2 and ends_at is null`,
      [ORG_B, PID_B1],
    );
    try {
      assert.deepEqual(
        await hotelsVisibleToBrowser(UID_VERA), [],
        'a company kept reading a hotel it no longer operates',
      );
    } finally {
      await pg.query(
        `update public.organization_property_relationships
            set ends_at = null
          where organization_id = $1 and property_id = $2 and ends_at is not null`,
        [ORG_B, PID_B1],
      );
    }
    assert.deepEqual(await hotelsVisibleToBrowser(UID_VERA), [PID_B1]);
  });

  // Widening the reach predicate must not widen anything that was never keyed
  // on reach. `company_findings` is service-role-only by policy (0367), and a
  // company OWNER is the likeliest person to be handed it by accident.
  // Mutation: swap `company_findings_deny_all` for a user_owns_property gate.
  test('deny-all tables stay deny-all, hat or no hat', async () => {
    assert.ok(PORTFOLIO_FINDING, 'the fixture planted no finding to probe with');
    assert.deepEqual(
      await runAs(UID_ANA, 'select id from public.company_findings'), [],
      "a company owner's browser read the service-role-only findings ledger",
    );
  });
});
