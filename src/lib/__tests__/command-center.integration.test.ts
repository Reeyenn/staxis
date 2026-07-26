/**
 * THE COMMAND CENTRE BOOTSTRAP, against a real Postgres holding two companies.
 *
 * Four sentences are the whole feature, and not one of them is provable against
 * a mock — a fake client can show that a query carried a filter, not that the
 * screen a VP opens at 6am tells them the truth about twelve buildings.
 *
 *   "Everybody who can sign in sees the hotels they can actually open, resolved
 *    from their jobs RIGHT NOW rather than from the array stamped on their
 *    account the day they were invited."
 *   "A company-scope person sees a health chip per hotel, and a hotel Staxis
 *    has never checked never claims to be quiet."
 *   "Company A's VP never sees company B's hotel, in either direction."
 *   "Cross-hotel chat is offered only to a company job at a company that
 *    switched it on."
 *
 * What each block below would catch:
 *
 *   AUTH          no session, no payload. A non-manager (housekeeping) is
 *                 SERVED, because a picker that refuses housekeepers is a
 *                 picker that shows a housekeeper nothing.
 *   COVERAGE      legacy-only, hat-only, and the union. The stale-snapshot fix
 *                 is proven by planting a hotel into the company AFTER the hats
 *                 exist and asserting it appears with `accounts.property_access`
 *                 still empty.
 *   CHIPS         every state the rule can reach, each from planted reality:
 *                 needs-you, N waiting, quiet, stale, and the honest silence.
 *   ORDERING      need first, alphabetical inside a band.
 *   ISOLATION     both directions, because a leak has two ends.
 *   CHAT          three refusals and one yes.
 *   RATE LIMIT    the cap is real and the 429 carries Retry-After.
 *
 * PGlite runs as the table owner, exactly as the service-role key bypasses RLS
 * in production. The boundary under test is the app's own scoping, which is the
 * real guarantee for `findings` (deny-all RLS).
 */

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-min-20-chars';
process.env.CRON_SECRET ??= 'placeholder-cron-secret-min-16';
process.env.OPENAI_API_KEY ??= 'sk-placeholder';
process.env.ANTHROPIC_API_KEY ??= 'sk-ant-placeholder';
process.env.DISABLE_SERVER_2FA_ENFORCEMENT = 'true';

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { NextRequest } from 'next/server';
import type { PGlite } from '@electric-sql/pglite';

import { supabaseAdmin } from '@/lib/supabase-admin';
import { saveCompanyAccessSettings } from '@/lib/company/rulebook-access';
import { clearPortfolioAccessCache } from '@/lib/company/portfolio';
import { GET as bootstrapGet } from '@/app/api/property-selector/bootstrap/route';

import { applyMigrationsToPglite } from '../../../tests/fixtures/pglite-migrate';
import { createPglitePostgrest, loadCatalog, type PglitePostgrest } from '../../../tests/fixtures/postgrest-pglite';
import {
  ACCOUNT_ADMIN,
  ACCOUNT_ANA,
  ORG_A,
  ORG_B,
  PID_A1,
  PID_A2,
  PID_A3,
  PID_B1,
  PID_L1,
  UID_ANA,
  UID_FIONA,
  UID_FRANK,
  UID_GIL,
  UID_HANK,
  UID_MARIA,
  UID_VERA,
  UID_WANDA,
  seedTwoCompanies,
} from '../../../tests/fixtures/pglite-two-company-seed';

let pg: PGlite;
let shim: PglitePostgrest;
let seed: Awaited<ReturnType<typeof seedTwoCompanies>>;

const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);
const originalRpc = supabaseAdmin.rpc.bind(supabaseAdmin);
const originalGetUser = supabaseAdmin.auth.getUser.bind(supabaseAdmin.auth);

let signedInAs: string | null = null;

/** Two more Gulf Coast hotels, so "ranked by need, alphabetical inside" has
 *  something to rank. Named at the ends of the alphabet on purpose. */
const PID_A_ALPHA = 'a4a4a4a4-0000-4000-8000-000000000001';
const PID_A_ZULU = 'a5a5a5a5-0000-4000-8000-000000000001';

function req(url = 'https://staxis.test/api/property-selector/bootstrap'): NextRequest {
  return new NextRequest(url, {
    method: 'GET',
    headers: {
      authorization: 'Bearer command-center-test-token',
      'content-type': 'application/json',
      'x-real-ip': '203.0.113.77',
    },
  });
}

interface HotelWire {
  propertyId: string;
  name: string;
  totalRooms: number;
  chip: { kind: string; count: number } | null;
}

interface BootstrapWire {
  hotels: HotelWire[];
  company: { organizationId: string; organizationName: string; companyRole: string; hotelCount: number } | null;
  chat: { available: boolean };
  signedInAs: string | null;
}

async function bootstrapFor(authUserId: string | null): Promise<{ status: number; data: BootstrapWire }> {
  signedInAs = authUserId;
  clearPortfolioAccessCache();
  const res = await bootstrapGet(req());
  const parsed = await res.json().catch(() => ({})) as { data?: BootstrapWire };
  return {
    status: res.status,
    data: parsed.data ?? { hotels: [], company: null, chat: { available: false }, signedInAs: null },
  };
}

const namesOf = (wire: BootstrapWire) => wire.hotels.map((h) => h.name);
const idsOf = (wire: BootstrapWire) => wire.hotels.map((h) => h.propertyId);
const chipOf = (wire: BootstrapWire, propertyId: string) =>
  wire.hotels.find((h) => h.propertyId === propertyId)?.chip ?? null;

// ─── Planting reality ───────────────────────────────────────────────────────

let seq = 0;

interface PlantOptions {
  propertyId: string;
  dedupeKey: string;
  summary?: string;
  disposition?: 'propose' | 'recommend' | 'fyi' | 'ask';
  severity?: 'critical' | 'attention' | 'info';
  status?: 'open' | 'updated' | 'known_problem' | 'muted' | 'resolved';
  priceLowCents?: number | null;
  priceHighCents?: number | null;
  daysAgo?: number;
}

async function plantFinding(opts: PlantOptions): Promise<string> {
  seq += 1;
  const firstSeen = new Date(Date.now() - (opts.daysAgo ?? 0) * 86_400_000).toISOString();
  const row = await pg.query<{ id: string }>(
    `insert into public.findings
       (property_id, detector_id, dedupe_key, summary, severity, disposition, status,
        receipt_query_id, evidence, magnitude, price_low_cents, price_high_cents,
        first_seen_at, last_seen_at, status_changed_at)
     values ($1, 'probe', $2, $3, $4, $5, $6, 'probe_receipt', $7::jsonb, 4, $8, $9,
             $10, now(), now())
     returning id`,
    [
      opts.propertyId,
      opts.dedupeKey,
      opts.summary ?? `Planted problem ${seq}`,
      opts.severity ?? 'attention',
      opts.disposition ?? 'propose',
      opts.status ?? 'open',
      JSON.stringify({ queryId: 'probe_receipt', params: {}, values: { n: seq }, basis: 'planted' }),
      opts.priceLowCents ?? null,
      opts.priceHighCents ?? null,
      firstSeen,
    ],
  );
  return row.rows[0].id;
}

/** A run row. `hoursAgo` is what makes "quiet" and "not checked lately" differ. */
async function plantRun(propertyId: string, detectorsChecked: number, hoursAgo = 3): Promise<void> {
  const runAt = new Date(Date.now() - hoursAgo * 3_600_000).toISOString();
  await pg.query(
    `insert into public.finding_runs (property_id, run_at, run_date, detectors_checked)
     values ($1, $2, ($2::timestamptz)::date, $3)`,
    [propertyId, runAt, detectorsChecked],
  );
}

async function legacyAccessOf(accountId: string): Promise<string[]> {
  const row = await pg.query<{ property_access: string[] | null }>(
    'select property_access from public.accounts where id = $1', [accountId],
  );
  return row.rows[0]?.property_access ?? [];
}

// ─── Fixture ────────────────────────────────────────────────────────────────

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

  // Two more Gulf Coast hotels so the ranking has bands to sort inside.
  await seed.attachPropertyToOrganization(pg, ORG_A, PID_A_ALPHA, 'Alpha Bay Inn');
  await seed.attachPropertyToOrganization(pg, ORG_A, PID_A_ZULU, 'Zulu Point Hotel');

  // ── Reality at Gulf Coast's four hotels ──
  //
  // Beaumont     a $6,000 problem, twelve days old → CLIMBS → "needs you"
  // Lufkin       two live proposals, both small and new → "2 waiting"
  // Alpha Bay    checked three hours ago, nothing wrong → "quiet"
  // Zulu Point   checked nine days ago, nothing wrong → "not checked lately"
  //
  // Tyler (company B) is checked and loud, and must never appear on any Gulf
  // Coast screen.
  await plantRun(PID_A1, 34);
  await plantRun(PID_A2, 30);
  await plantRun(PID_A_ALPHA, 28);
  await plantRun(PID_A_ZULU, 26, 9 * 24);
  await plantRun(PID_B1, 40);

  await plantFinding({
    propertyId: PID_A1,
    dedupeKey: 'probe:beaumont_big',
    summary: 'The Beaumont chiller is failing.',
    priceLowCents: 500_000,
    priceHighCents: 700_000,
    daysAgo: 12,
  });
  await plantFinding({
    propertyId: PID_A2,
    dedupeKey: 'probe:lufkin_one',
    priceLowCents: 4_000,
    priceHighCents: 6_000,
  });
  await plantFinding({
    propertyId: PID_A2,
    dedupeKey: 'probe:lufkin_two',
    priceLowCents: 3_000,
    priceHighCents: 5_000,
  });
  // Neither of these may be counted as a decision waiting at Lufkin: `ask` is a
  // drip question and never renders as a card, and a `recommend` is not a
  // decision. If either leaks into the count Lufkin reads "4 waiting".
  await plantFinding({ propertyId: PID_A2, dedupeKey: 'probe:lufkin_ask', disposition: 'ask' });
  await plantFinding({ propertyId: PID_A2, dedupeKey: 'probe:lufkin_fyi', disposition: 'recommend' });

  await plantFinding({
    propertyId: PID_B1,
    dedupeKey: 'probe:tyler_private',
    summary: 'PINEY WOODS PRIVATE: the Tyler roof is gone.',
    priceLowCents: 900_000,
    priceHighCents: 1_200_000,
    daysAgo: 30,
  });

  // Gulf Coast switched cross-hotel chat ON. Piney Woods deliberately did not,
  // which is what makes "default off" testable on real data rather than by
  // deleting a row.
  const saved = await saveCompanyAccessSettings(ORG_A, { cross_hotel_ai_chat: 'true' }, ACCOUNT_ADMIN);
  assert.ok(saved.ok, `seed: the chat switch would not save — ${saved.error ?? ''}`);
});

after(async () => {
  supabaseAdmin.from = originalFrom;
  supabaseAdmin.rpc = originalRpc;
  supabaseAdmin.auth.getUser = originalGetUser;
  await pg?.close();
});

// ═══ AUTH ═══════════════════════════════════════════════════════════════════

describe('who the picker answers', () => {
  // Mutation: drop requireSession. An unauthenticated request would be handed
  // a hotel list.
  test('no session, no payload', async () => {
    const anon = await bootstrapFor(null);
    assert.equal(anon.status, 401);
  });

  // Mutation: swap loadSessionAccount for loadManagerCaller. Hank is a
  // housekeeper — canManageTeam says no — and his picker would go empty, which
  // is the bug this route was split to avoid.
  test('a housekeeper is served, not refused', async () => {
    const hank = await bootstrapFor(UID_HANK);
    assert.equal(hank.status, 200);
    assert.deepEqual(idsOf(hank.data), [PID_L1], 'the housekeeper lost his hotel');
    assert.equal(hank.data.company, null, 'a housekeeper was handed a company');
    assert.equal(hank.data.chat.available, false);
  });

  // Mutation: same swap, from the other end. Fiona's legacy accounts.role is
  // `front_desk` — the manager gate refuses her — but her HAT is company
  // finance, so she must get the command centre.
  test("a company's finance lead gets the command centre despite a front-desk legacy role", async () => {
    const fiona = await bootstrapFor(UID_FIONA);
    assert.equal(fiona.status, 200);
    assert.equal(fiona.data.company?.companyRole, 'finance');
    assert.ok(fiona.data.hotels.length >= 4, 'the controller could not see the company hotels');
  });
});

// ═══ COVERAGE ═══════════════════════════════════════════════════════════════

describe('which hotels — resolved now, not stamped at invite time', () => {
  // Mutation: drop the legacy half of the union in accessibleProperties. Wanda
  // is every account in the product today; she must be untouched.
  test('a legacy single-hotel owner sees exactly her hotel (zero-regression control)', async () => {
    const wanda = await bootstrapFor(UID_WANDA);
    assert.deepEqual(idsOf(wanda.data), [PID_L1]);
    assert.equal(wanda.data.company, null, 'a legacy owner was read as a company job');
    assert.equal(chipOf(wanda.data, PID_L1), null, 'a hotel person was shown a chip');
  });

  // Mutation: drop the membership half of the union. Ana's legacy array is
  // empty, so she would see nothing at all.
  test('a company owner with an EMPTY legacy array sees every company hotel', async () => {
    const ana = await bootstrapFor(UID_ANA);
    assert.deepEqual(await legacyAccessOf(ACCOUNT_ANA), [], 'fixture drift: Ana grew a legacy array');
    const ids = idsOf(ana.data);
    assert.ok(ids.includes(PID_A1) && ids.includes(PID_A2), 'the hats did not resolve to hotels');
    assert.equal(ana.data.company?.organizationId, ORG_A);
  });

  // Mutation: read accounts.property_access instead of accessibleProperties.
  // THE FLAGGED BUG. A hotel the company picked up after the invitations were
  // accepted would be invisible until every person was re-invited.
  test('a hotel added to the company AFTER the hats exist appears with no re-invite', async () => {
    const before = await bootstrapFor(UID_ANA);
    assert.ok(!idsOf(before.data).includes(PID_A3), 'fixture drift: Port Arthur was already there');

    await seed.attachPropertyToOrganization(pg, ORG_A, PID_A3, 'Port Arthur Suites');

    const after = await bootstrapFor(UID_ANA);
    assert.ok(idsOf(after.data).includes(PID_A3), 'the new hotel never reached the picker');
    // And the proof it came from the spine rather than a re-stamp: nothing
    // touched the snapshot the old screen used to read.
    assert.deepEqual(
      await legacyAccessOf(ACCOUNT_ANA),
      [],
      'the fix worked by writing property_access, which is the bug wearing a hat',
    );
    // A brand-new hotel has never been checked, so it makes NO claim.
    assert.equal(chipOf(after.data, PID_A3), null, 'an unchecked hotel was given a chip');
  });
});

// ═══ THE CHIPS ══════════════════════════════════════════════════════════════

describe('the health chip, from planted reality', () => {
  // Mutation: return climbReasonFor(...) === null as needs-you (invert the
  // test), or drop the climb check. Beaumont's $6,000 twelve-day-old problem is
  // exactly what "needs you" is for.
  test('a big, old problem makes its hotel need you', async () => {
    const ana = await bootstrapFor(UID_ANA);
    assert.deepEqual(chipOf(ana.data, PID_A1), { kind: 'needs_you', count: 0 });
  });

  // Mutation: count `ask` or `recommend` findings as decisions. Lufkin has four
  // live findings and exactly two of them are decisions.
  test('live proposals — and only proposals — are counted as waiting', async () => {
    const ana = await bootstrapFor(UID_ANA);
    assert.deepEqual(chipOf(ana.data, PID_A2), { kind: 'waiting', count: 2 });
  });

  // Mutation: let a run older than the freshness window still say "quiet".
  test('a hotel checked hours ago with nothing wrong is quiet', async () => {
    const ana = await bootstrapFor(UID_ANA);
    assert.deepEqual(chipOf(ana.data, PID_A_ALPHA), { kind: 'quiet', count: 0 });
  });

  test('a hotel last checked nine days ago says so instead', async () => {
    const ana = await bootstrapFor(UID_ANA);
    assert.deepEqual(chipOf(ana.data, PID_A_ZULU), { kind: 'stale', count: 0 });
  });

  // Mutation: default an unknown hotel to `quiet` — the single most tempting
  // one-line "improvement" on this screen, and the one that turns the chip into
  // a lie. A hotel nobody has ever scanned is not calm; it is unknown.
  test('a hotel that has never been checked claims NOTHING', async () => {
    const noRuns = 'a6a6a6a6-0000-4000-8000-000000000001';
    await seed.attachPropertyToOrganization(pg, ORG_A, noRuns, 'Bolivar Rest House');

    const ana = await bootstrapFor(UID_ANA);
    const chip = chipOf(ana.data, noRuns);
    assert.equal(chip, null, 'an unchecked hotel was handed a status');
    assert.notEqual(
      (chip as { kind?: string } | null)?.kind,
      'quiet',
      'an unchecked hotel was called quiet',
    );
  });

  // Mutation: let a critical finding fall through to `waiting`. Severity is the
  // one route to "needs you" that does not need money on the card.
  test('a critical finding needs you even with no dollars on it', async () => {
    const scary = 'a7a7a7a7-0000-4000-8000-000000000001';
    await seed.attachPropertyToOrganization(pg, ORG_A, scary, 'Crystal Beach Motor Inn');
    await plantRun(scary, 12);
    await plantFinding({
      propertyId: scary,
      dedupeKey: 'probe:scary',
      severity: 'critical',
      disposition: 'recommend',
    });

    const ana = await bootstrapFor(UID_ANA);
    assert.deepEqual(chipOf(ana.data, scary), { kind: 'needs_you', count: 0 });
  });
});

// ═══ ORDERING ═══════════════════════════════════════════════════════════════

describe('ranked by need, alphabetical inside', () => {
  // Mutation: sort by name only, or rank quiet above waiting. A VP scanning
  // twelve hotels reads the top of the list and stops.
  test('needs-you first, then waiting, then quiet, then the silent ones', async () => {
    const ana = await bootstrapFor(UID_ANA);
    const kinds = ana.data.hotels.map((h) => h.chip?.kind ?? 'none');
    const rank: Record<string, number> = { needs_you: 0, waiting: 1, quiet: 2, stale: 3, none: 4 };
    for (let i = 1; i < kinds.length; i += 1) {
      assert.ok(
        rank[kinds[i - 1]] <= rank[kinds[i]],
        `hotel ${i} (${kinds[i]}) outranked ${kinds[i - 1]}: ${kinds.join(' > ')}`,
      );
    }

    // Two hotels need Ana — Beaumont Suites and Crystal Beach Motor Inn — and
    // inside that band the alphabet decides.
    const needy = ana.data.hotels.filter((h) => h.chip?.kind === 'needs_you').map((h) => h.name);
    assert.deepEqual(needy, [...needy].sort((a, b) => a.localeCompare(b)), 'the needs-you band is not alphabetical');
    assert.ok(needy.length >= 2, 'the ordering test lost its second needy hotel');
  });
});

// ═══ ISOLATION ══════════════════════════════════════════════════════════════

describe('two companies, and a leak has two ends', () => {
  // Mutation: resolve coverage from `propertiesOfOrganization` on an id taken
  // from anywhere but the caller's own hats.
  test("Gulf Coast's owner never sees Tyler", async () => {
    const ana = await bootstrapFor(UID_ANA);
    assert.ok(!idsOf(ana.data).includes(PID_B1), 'company B leaked into company A');
    assert.ok(
      !namesOf(ana.data).some((n) => n.includes('Tyler')),
      'company B leaked into company A by name',
    );
  });

  test("Piney Woods' VP sees Tyler and nothing else", async () => {
    const vera = await bootstrapFor(UID_VERA);
    assert.deepEqual(idsOf(vera.data), [PID_B1]);
    assert.equal(vera.data.company?.organizationId, ORG_B);
  });

  // Mutation: let a property-scope hat satisfy companyScopeFor. Gil runs one
  // hotel; a "portfolio" of the building you manage is not oversight.
  test('a hotel GM gets no company at all', async () => {
    const gil = await bootstrapFor(UID_GIL);
    assert.deepEqual(idsOf(gil.data), [PID_B1]);
    assert.equal(gil.data.company, null, 'a property-scope GM was handed a company');
    assert.equal(chipOf(gil.data, PID_B1), null, 'a hotel person was shown a chip');
  });

  // Maria wears both hats. At Beaumont she is the GM; across Gulf Coast she is
  // the VP — and it is the company hat that decides which screen she gets.
  test('a GM who ALSO oversees the company gets the command centre', async () => {
    const maria = await bootstrapFor(UID_MARIA);
    assert.equal(maria.data.company?.companyRole, 'vp');
    assert.ok(idsOf(maria.data).includes(PID_A2), 'her company hat did not reach past her own hotel');
  });
});

// ═══ THE CHAT DOOR ══════════════════════════════════════════════════════════

describe('cross-hotel chat is offered only where it was switched on', () => {
  // Mutation: offer the ask line to everybody with a company. The default is
  // OFF and a company that never opened the setup screen has not opted in.
  test("a company that never switched it on is not offered it", async () => {
    const vera = await bootstrapFor(UID_VERA);
    assert.equal(vera.data.company?.organizationId, ORG_B);
    assert.equal(vera.data.chat.available, false, 'default-off was not respected');
  });

  test('a company that switched it on IS offered it', async () => {
    const ana = await bootstrapFor(UID_ANA);
    assert.equal(ana.data.chat.available, true);
  });

  // Mutation: gate the ask line on the setting alone. A GM at a company with
  // the switch on would get portfolio chat, which is the whole thing the door
  // exists to prevent.
  test('a hotel GM at a switched-on company is still not offered it', async () => {
    // Gwen-shaped: a property hat at Gulf Coast and nothing above it. Frank is
    // already exactly that — front desk at Beaumont only.
    const frank = await bootstrapFor(UID_FRANK);
    assert.equal(frank.data.company, null);
    assert.equal(frank.data.chat.available, false);
    assert.deepEqual(idsOf(frank.data), [PID_A1], 'Wall A leaked: front desk saw the company');
  });

  test('a hotel person at a company-less hotel is never offered it', async () => {
    const wanda = await bootstrapFor(UID_WANDA);
    assert.equal(wanda.data.chat.available, false);
  });
});

// ═══ THE CAP ════════════════════════════════════════════════════════════════

describe('the read is capped', () => {
  // Mutation: delete the checkAndIncrementRateLimit call. A scripted loop would
  // read a dozen findings ledgers per request, unbounded.
  test('past the hourly cap the route says 429 and when to come back', async () => {
    signedInAs = UID_WANDA;
    let last: Response | null = null;
    // The cap is 240/hr; 241 requests in a row is the smallest proof it is real.
    for (let i = 0; i < 242; i += 1) {
      last = await bootstrapGet(req());
      if (last.status === 429) break;
    }
    assert.equal(last?.status, 429, 'the picker never hit its cap');
    assert.ok(Number(last?.headers.get('Retry-After')) > 0, 'a 429 with no way to know when to retry');
  });
});
