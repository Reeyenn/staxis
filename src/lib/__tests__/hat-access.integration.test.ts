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

import { applyMigrationsToPglite } from '../../../tests/fixtures/pglite-migrate';
import { createPglitePostgrest, loadCatalog, type PglitePostgrest } from '../../../tests/fixtures/postgrest-pglite';
import {
  ACCOUNT_ADMIN,
  ACCOUNT_FIONA,
  ACCOUNT_MARIA,
  ORG_A,
  PID_A1,
  PID_A2,
  PID_A3,
  PID_B1,
  PID_L1,
  UID_ADMIN,
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

async function portfolioFor(authUserId: string): Promise<{ status: number; data: PortfolioWire }> {
  signedInAs = authUserId;
  const res = await portfolioGet(req('https://staxis.test/api/company/queue'));
  const parsed = await res.json().catch(() => ({})) as { data?: PortfolioWire };
  return { status: res.status, data: parsed.data ?? { scope: null, cards: [], canAct: undefined } };
}

async function portfolioVerdict(authUserId: string, findingId: string): Promise<number> {
  signedInAs = authUserId;
  const res = await portfolioPost(req('https://staxis.test/api/company/queue', {
    method: 'POST',
    body: { findingId, action: 'known_problem' },
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
  propertyId: string,
): Promise<{ status: number; data: RulebookWire | null }> {
  signedInAs = authUserId;
  const res = await rulebookGet(
    req(`https://staxis.test/api/company/rulebook?propertyId=${propertyId}`),
  );
  const parsed = await res.json().catch(() => ({})) as { data?: RulebookWire };
  return { status: res.status, data: parsed.data ?? null };
}

async function flipChatSwitch(
  authUserId: string,
  propertyId: string,
  value: 'true' | 'false',
): Promise<number> {
  signedInAs = authUserId;
  const res = await rulebookPost(req('https://staxis.test/api/company/rulebook', {
    method: 'POST',
    body: { propertyId, action: 'settings', settings: { cross_hotel_ai_chat: value } },
  }));
  return res.status;
}

interface HubWire {
  organizations: Array<{ id: string; name: string; type: string }>;
  properties: Array<{ id: string; name: string; organizationId?: string | null; operatingCompanyName?: string | null }>;
  memberships: Array<{ accountId: string; status: string; accessProfile: string | null }>;
  effectiveAccess: Array<{ id: string; accessProfile: string; propertyIds: string[] }>;
  permissions: { viewHotels: boolean; viewPeople: boolean };
}

async function hubFor(authUserId: string): Promise<{ status: number; data: HubWire | null }> {
  signedInAs = authUserId;
  const res = await companyAccessGet(req('https://staxis.test/api/company-access'));
  const parsed = await res.json().catch(() => ({})) as { data?: HubWire };
  return { status: res.status, data: parsed.data ?? null };
}

async function legacyAccessOf(accountId: string): Promise<string[]> {
  const row = await pg.query<{ property_access: string[] | null }>(
    'select property_access from public.accounts where id = $1', [accountId],
  );
  return row.rows[0]?.property_access ?? [];
}

/** A company-scope finding, the only kind the portfolio POST accepts. */
async function plantCompanyFinding(organizationId: string): Promise<string> {
  const row = await pg.query<{ id: string }>(
    `insert into public.company_findings
       (organization_id, detector_id, dedupe_key, summary, severity, disposition, status,
        receipt_query_id, evidence, magnitude, first_seen_at, last_seen_at, status_changed_at)
     values ($1, 'probe', 'probe:portfolio', 'Two hotels pay different laundry rates.',
             'attention', 'fyi', 'open', 'probe_receipt', $2::jsonb, 3, now(), now(), now())
     returning id`,
    [organizationId, JSON.stringify({ queryId: 'probe_receipt', params: {}, values: {}, basis: 'planted' })],
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
    const maria = await rulebookFor(UID_MARIA, PID_A1);
    assert.equal(maria.status, 200, 'the person who owns the book could not open it');
    assert.equal(maria.data?.organizationId, ORG_A);
    assert.equal(maria.data?.canEdit, true, 'rulebook_editors names the VP and she was refused');
  });

  // The switch itself — the control the finding said was unreachable.
  test('and the cross-hotel-chat switch actually flips', async () => {
    assert.equal(
      (await rulebookFor(UID_MARIA, PID_A1)).data?.settings.cross_hotel_ai_chat ?? 'false',
      'false',
      'fixture drift: chat was already on',
    );
    assert.equal(await flipChatSwitch(UID_MARIA, PID_A1, 'true'), 200);
    assert.equal((await rulebookFor(UID_MARIA, PID_A1)).data?.settings.cross_hotel_ai_chat, 'true');
    assert.equal(await flipChatSwitch(UID_MARIA, PID_A1, 'false'), 200, 'and back off');
  });

  // Mutation: gate on loadManagerCaller. Fiona's legacy role is `front_desk`,
  // so she was 404'd out of the book her own company governs her by.
  test("a finance hat may READ the book and may not write it", async () => {
    const fiona = await rulebookFor(UID_FIONA, PID_A1);
    assert.equal(fiona.status, 200, 'the finance lead was refused the company book');
    assert.equal(fiona.data?.companyRole, 'finance');
    assert.equal(fiona.data?.canEdit, false, 'finance was handed the pen');
    assert.equal(await flipChatSwitch(UID_FIONA, PID_A1, 'true'), 403, 'finance flipped a company switch');
  });

  // The wall did not move when the gate did.
  test('a legacy account with no hat is still refused, and the other company is still refused', async () => {
    assert.equal((await rulebookFor(UID_WANDA, PID_L1)).status, 404, 'an independent hotel grew a rulebook');
    assert.equal((await rulebookFor(UID_VERA, PID_A1)).status, 403, "company B read company A's book");
    assert.equal((await rulebookFor(UID_DOLORES, PID_A1)).status, 403, 'a hatless legacy account read the book');
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

  // The other half of "coherent": whoever IS drawn with buttons must be taken.
  test('the VP is drawn with buttons and her verdict lands', async () => {
    const queue = await portfolioFor(UID_MARIA);
    assert.equal(queue.status, 200);
    assert.equal(queue.data.canAct, true, 'the VP was drawn read-only');
    assert.equal(await portfolioVerdict(UID_MARIA, PORTFOLIO_FINDING), 200);
    const row = await pg.query<{ status: string }>(
      'select status from public.company_findings where id = $1', [PORTFOLIO_FINDING],
    );
    assert.equal(row.rows[0]?.status, 'known_problem', 'the verdict was accepted and not saved');
  });

  // Wall A on this surface, unchanged by the wider gate.
  test('a hotel-only person still has no portfolio at all', async () => {
    const frank = await portfolioFor(UID_FRANK);
    assert.equal(frank.status, 200, 'a refusal became an error the client shows as broken');
    assert.equal(frank.data.scope, null, 'a front-desk hat was handed a portfolio');
    assert.equal(frank.data.canAct, false);

    const hank = await portfolioFor(UID_HANK);
    assert.equal(hank.data.scope, null, 'a legacy housekeeper was handed a portfolio');
  });

  test("company B's finding is not company A's to silence", async () => {
    assert.equal(
      await portfolioVerdict(UID_VERA, PORTFOLIO_FINDING), 404,
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
    const others = (hub.data?.memberships ?? []).filter((m) => m.accountId !== ACCOUNT_MARIA);
    assert.ok(
      !others.some((m) => m.accountId === ACCOUNT_FIONA),
      "a front-desk person was shown the company's finance lead",
    );
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
    const hub = await hubFor(UID_WANDA);
    assert.equal(hub.status, 200);
    const waco = (hub.data?.properties ?? []).find((p) => p.id === PID_L1);
    assert.ok(waco, 'the legacy owner lost her own hotel');
    assert.equal(waco?.operatingCompanyName ?? null, null, 'a company was invented for an independent hotel');
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
