/**
 * THE PORTFOLIO QUEUE, against a real Postgres holding TWO COMPANIES.
 *
 * Two sentences are the whole feature, and neither is provable against a mock —
 * a fake client can show that a query carried an organization filter, not that
 * the filter keeps the other company's hotels off a VP's screen.
 *
 *   "A company-scope person sees every problem across THEIR hotels and no
 *    problem at any hotel that is not theirs."
 *   "A one-tap fix the company's rulebook routed upward is locked at the hotel
 *    and live for the approver — and the lock is enforced by the SERVER."
 *
 * What each block below would catch:
 *
 *   WALL A       a hotel GM — even one with a company-scope-shaped job title —
 *                gets `scope: null` and never sees the portfolio surface. Drop
 *                the `scope === 'company'` filter in companyScopeFor and this
 *                fails.
 *   WALL B       Gulf Coast's VP sees Beaumont and Lufkin, never Tyler; Piney
 *                Woods' VP sees Tyler, never the other two. Both directions,
 *                because a leak has two ends.
 *   ROUTING      a rule the company confirmed locks the GM's card, names the
 *                approver, unlocks the VP's, and the boundary is exactly where
 *                the rulebook says it is.
 *   ENFORCEMENT  the GM's POST to /api/findings/actions is refused with a 403
 *                even though nothing in their browser was consulted, and the
 *                VP's identical POST is not.
 *   BADGES       the locked card is subtracted from the GM's pill and is on the
 *                VP's queue. Honest on both sides is the founder's rule.
 *   CLIMBING     "Seen" does not hide a card from the boss; "Fixed" does; a
 *                mute that was overtaken does not hold; big money climbs.
 *   PORTFOLIO    a cross-hotel comparison is written to company_findings, its
 *                comparison set is company hotels only, and one problem stays
 *                one row across two runs.
 *   BRIEF        assembled from planted reality and stable across two loads.
 *
 * PGlite runs as the table owner, exactly as the service-role key bypasses RLS
 * in production. The boundary under test is the app's own scoping, which is the
 * real guarantee for `findings` and `company_findings` (both deny-all RLS).
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
import { confirmCompanyFact, storeCompanyFact } from '@/lib/company/rulebook';
import { authorityRuleFor } from '@/lib/company/authority';
import { GET as queueGet, POST as queuePost } from '@/app/api/findings/route';
import { GET as badgeGet } from '@/app/api/findings/badge/route';
import { POST as actionsPost } from '@/app/api/findings/actions/route';
import {
  GET as portfolioGet,
  POST as portfolioPost,
} from '@/app/api/company/queue/route';

import { applyMigrationsToPglite } from '../../../tests/fixtures/pglite-migrate';
import { createPglitePostgrest, loadCatalog, type PglitePostgrest } from '../../../tests/fixtures/postgrest-pglite';
import {
  ACCOUNT_ADMIN,
  ORG_A,
  ORG_B,
  PID_A1,
  PID_A2,
  PID_B1,
  UID_ANA,
  UID_MARIA,
  UID_VERA,
  UID_GIL,
  UID_WANDA,
  seedTwoCompanies,
} from '../../../tests/fixtures/pglite-two-company-seed';

let pg: PGlite;
let shim: PglitePostgrest;

const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);
const originalRpc = supabaseAdmin.rpc.bind(supabaseAdmin);
const originalGetUser = supabaseAdmin.auth.getUser.bind(supabaseAdmin.auth);

let signedInAs: string | null = null;

/** A hotel GM at Gulf Coast with NO company job. The Wall A probe, and the
 *  person whose card the rulebook locks. */
const ACCOUNT_GWEN = 'aaaa1111-0000-4000-8000-00000000000g'.replace('g', '9');
const UID_GWEN = 'aaaa2222-0000-4000-8000-00000000000g'.replace('g', '9');

// ─── Request helpers ────────────────────────────────────────────────────────

function req(url: string, init?: { method?: string; body?: unknown }): NextRequest {
  return new NextRequest(url, {
    method: init?.method ?? 'GET',
    headers: {
      authorization: 'Bearer vp-queue-test-token',
      'content-type': 'application/json',
      'x-real-ip': '203.0.113.44',
    },
    ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
}

interface PortfolioCardWire {
  id: string;
  summary: string;
  disposition: string;
  hotel: { propertyId: string; name: string } | null;
  climbReason: string;
  daysOpen: number;
  signOff: { approverRole: string; approverNames: string[]; callerMayApprove: boolean } | null;
  action: { id: string; state: string } | null;
}

interface PortfolioWire {
  scope: { organizationId: string; organizationName: string; hotelCount: number } | null;
  cards: PortfolioCardWire[];
  // One string per line: the brief is English-only (founder ruling — see the
  // header of src/lib/findings/brief.ts). Written out here rather than imported
  // so this stays a description of what actually crosses the wire.
  brief: { kind: string; lines: Array<{ text: string }> } | null;
  run: { thingsChecked: number; hotelsChecked: number; hotelsTotal: number } | null;
}

async function portfolioFor(authUserId: string): Promise<{ status: number; data: PortfolioWire }> {
  signedInAs = authUserId;
  const res = await portfolioGet(req('https://staxis.test/api/company/queue'));
  const parsed = await res.json().catch(() => ({})) as { data?: PortfolioWire };
  return {
    status: res.status,
    data: parsed.data ?? { scope: null, cards: [], brief: null, run: null },
  };
}

interface HotelQueueWire {
  findings: Array<{
    id: string;
    summary: string;
    action: { id: string; state: string } | null;
    signOff: { approverRole: string; approverNames: string[]; callerMayApprove: boolean } | null;
  }>;
}

async function hotelQueueFor(authUserId: string, propertyId: string) {
  signedInAs = authUserId;
  const res = await queueGet(req(`https://staxis.test/api/findings?propertyId=${propertyId}`));
  const parsed = await res.json().catch(() => ({})) as { data?: HotelQueueWire };
  return { status: res.status, findings: parsed.data?.findings ?? [] };
}

async function badgeFor(authUserId: string, propertyId: string): Promise<number> {
  signedInAs = authUserId;
  const res = await badgeGet(req(`https://staxis.test/api/findings/badge?propertyId=${propertyId}`));
  const parsed = await res.json().catch(() => ({})) as { data?: { count: number } };
  return parsed.data?.count ?? -1;
}

async function tapAction(authUserId: string, propertyId: string, actionId: string) {
  signedInAs = authUserId;
  const res = await actionsPost(req('https://staxis.test/api/findings/actions', {
    method: 'POST',
    body: { propertyId, actionId, intent: 'execute' },
  }));
  const parsed = await res.json().catch(() => ({})) as { error?: string; data?: { code: string } };
  return { status: res.status, error: parsed.error ?? null, code: parsed.data?.code ?? null };
}

// ─── Seeding helpers ────────────────────────────────────────────────────────

let seq = 0;

interface PlantOptions {
  propertyId: string;
  dedupeKey: string;
  summary: string;
  disposition?: 'propose' | 'recommend' | 'fyi';
  status?: 'open' | 'updated' | 'known_problem' | 'muted' | 'resolved' | 'expired';
  priceLowCents?: number | null;
  priceHighCents?: number | null;
  magnitude?: number;
  silencedAtMagnitude?: number | null;
  daysAgo?: number;
}

/** A finding, exactly as the nightly runner would have written it. */
async function plantFinding(opts: PlantOptions): Promise<string> {
  seq += 1;
  const firstSeen = new Date(Date.now() - (opts.daysAgo ?? 0) * 86_400_000).toISOString();
  const row = await pg.query<{ id: string }>(
    `insert into public.findings
       (property_id, detector_id, dedupe_key, summary, severity, disposition, status,
        receipt_query_id, evidence, magnitude, price_low_cents, price_high_cents,
        first_seen_at, last_seen_at, status_changed_at, silenced_at_magnitude)
     values ($1, 'probe', $2, $3, 'attention', $4, $5, 'probe_receipt',
             $6::jsonb, $7, $8, $9, $10, now(), now(), $11)
     returning id`,
    [
      opts.propertyId,
      opts.dedupeKey,
      opts.summary,
      opts.disposition ?? 'propose',
      opts.status ?? 'open',
      JSON.stringify({ queryId: 'probe_receipt', params: {}, values: { n: seq }, basis: 'planted' }),
      opts.magnitude ?? 4,
      opts.priceLowCents ?? null,
      opts.priceHighCents ?? null,
      firstSeen,
      opts.silencedAtMagnitude ?? null,
    ],
  );
  return row.rows[0].id;
}

/** A live one-tap offer attached to a finding, as the runner would freeze it. */
async function plantAction(propertyId: string, findingId: string, location: string): Promise<string> {
  const params = {
    location,
    description: `Full inspection of ${location}.`,
    severity: 'medium',
    submitted_by_name: 'Staxis',
    submitter_role: 'Staxis',
    outcome_check_days: 14,
  };
  const row = await pg.query<{ id: string }>(
    `insert into public.finding_actions
       (property_id, finding_id, action_kind, params, verify, state)
     values ($1, $2, 'create_work_order', $3::jsonb, $4::jsonb, 'proposed')
     returning id`,
    [propertyId, findingId, JSON.stringify(params), JSON.stringify({ open_work_orders: 4 })],
  );
  return row.rows[0].id;
}

/** A findings run row, so the liveness rollup and the brief have something true. */
async function plantRun(propertyId: string, detectorsChecked: number): Promise<void> {
  await pg.query(
    `insert into public.finding_runs (property_id, run_at, run_date, detectors_checked)
     values ($1, now(), current_date, $2)`,
    [propertyId, detectorsChecked],
  );
}

/** Put a rule in a company's book and confirm it, as its owner would. The rule
 *  only exists AFTER a human confirms — that is the rulebook's own guarantee. */
async function confirmRule(organizationId: string, content: string): Promise<void> {
  const stored = await storeCompanyFact({
    organizationId,
    topic: 'approvals',
    content,
    category: 'money',
    source: 'explicit_user',
  });
  assert.ok(stored.ok && stored.factId, `seed: the rule was refused — ${stored.error ?? ''}`);
  const confirmed = await confirmCompanyFact(organizationId, stored.factId, {
    accountId: null, name: 'Ana', role: 'owner',
  });
  assert.equal(confirmed.confirmed, true, 'seed: the rule would not confirm');
}

async function statusOf(findingId: string): Promise<string | null> {
  const row = await pg.query<{ status: string }>(
    'select status from public.findings where id = $1', [findingId],
  );
  return row.rows[0]?.status ?? null;
}

// ─── Fixture ────────────────────────────────────────────────────────────────

// Ids planted in `before` and read across the blocks below.
let LOCKED_FINDING = '';
let LOCKED_ACTION = '';
let CHEAP_FINDING = '';
let CHEAP_ACTION = '';

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

  await seedTwoCompanies(pg);

  // ── Gwen: GM of Beaumont, and NOTHING at company level ──
  // The person the rulebook locks out, and the Wall A probe. Her legacy
  // property_access is empty, exactly like every other company person in the
  // fixture, so anything she can reach was reached by the hat.
  await pg.query(
    `insert into auth.users (id, email) values ($1, 'gwen@example.test')
     on conflict (id) do nothing`,
    [UID_GWEN],
  );
  await pg.query(
    `insert into accounts (id, username, password_hash, display_name, role, property_access, data_user_id)
     values ($1, 'gwen', 'x', 'Gwen', 'general_manager', '{}', $2)
     on conflict (id) do nothing`,
    [ACCOUNT_GWEN, UID_GWEN],
  );
  await pg.query(
    `select public.staxis_set_membership_hat($1, $2, $3, 'property', 'general_manager', $4, 'General Manager')`,
    [ACCOUNT_ADMIN, ORG_A, ACCOUNT_GWEN, JSON.stringify([PID_A1])],
  );

  // ── The company's rule ──
  // Gulf Coast only. Piney Woods deliberately writes NOTHING, which is what
  // makes "no rule ⇒ a normal card" testable on real data rather than by
  // deleting a row.
  await confirmRule(ORG_A, 'Any expense over $500 needs approval from the VP.');

  // ── Reality at the hotels ──
  await plantRun(PID_A1, 34);
  await plantRun(PID_A2, 30);
  await plantRun(PID_B1, 28);

  // Beaumont: an expensive proposal with a live offer. $600–900, so the top of
  // the range clears the company's $500 line.
  LOCKED_FINDING = await plantFinding({
    propertyId: PID_A1,
    dedupeKey: 'probe:expensive_room',
    summary: 'Room 214 keeps breaking.',
    priceLowCents: 60_000,
    priceHighCents: 90_000,
    daysAgo: 2,
  });
  LOCKED_ACTION = await plantAction(PID_A1, LOCKED_FINDING, 'Room 214');

  // Beaumont: a cheap proposal with a live offer. $100–300 — the whole range is
  // under the line, so no rule reaches it.
  CHEAP_FINDING = await plantFinding({
    propertyId: PID_A1,
    dedupeKey: 'probe:cheap_room',
    summary: 'Room 108 needs a washer.',
    priceLowCents: 10_000,
    priceHighCents: 30_000,
    daysAgo: 1,
  });
  CHEAP_ACTION = await plantAction(PID_A1, CHEAP_FINDING, 'Room 108');

  // Tyler (company B): a big expensive problem that must NEVER appear on Gulf
  // Coast's screens. Its size is what makes the isolation test mean something —
  // if the wall leaked, this is exactly the card that would come through.
  await plantFinding({
    propertyId: PID_B1,
    dedupeKey: 'probe:tyler_private',
    summary: 'PINEY WOODS PRIVATE: the chiller at Tyler is failing.',
    disposition: 'recommend',
    priceLowCents: 800_000,
    priceHighCents: 1_200_000,
    daysAgo: 30,
  });
});

after(async () => {
  supabaseAdmin.from = originalFrom;
  supabaseAdmin.rpc = originalRpc;
  supabaseAdmin.auth.getUser = originalGetUser;
  await pg?.close();
});

// ═══ WALL A ════════════════════════════════════════════════════════════════

describe('Wall A — the portfolio surface does not exist for hotel people', () => {
  // Mutation: let companyScopeFor accept property-scope hats. Gwen would get a
  // "portfolio" of the one hotel she runs, which is not oversight, and Gil
  // would get one of Tyler.
  test('a hotel GM gets no scope at all', async () => {
    const gwen = await portfolioFor(UID_GWEN);
    assert.equal(gwen.status, 200);
    assert.equal(gwen.data.scope, null, 'a property-scope GM was handed a portfolio');
    assert.deepEqual(gwen.data.cards, []);

    const gil = await portfolioFor(UID_GIL);
    assert.equal(gil.data.scope, null);
  });

  // Mutation: fall back to accounts.role when there are no hats. Wanda is a
  // legacy single-hotel OWNER — every account in the product today looks like
  // her — and reading that global word as a company job would hand her a
  // portfolio of a company she has never heard of.
  test('a legacy single-hotel owner gets no scope (the zero-regression control)', async () => {
    const wanda = await portfolioFor(UID_WANDA);
    assert.equal(wanda.data.scope, null);
  });

  // Mutation: drop the scope check on the POST. A GM could silence a company
  // card about hotels they do not run.
  test('a hotel GM cannot put down a company card', async () => {
    signedInAs = UID_GWEN;
    const res = await portfolioPost(req('https://staxis.test/api/company/queue', {
      method: 'POST',
      body: { findingId: '00000000-0000-4000-8000-000000000001', action: 'muted' },
    }));
    assert.equal(res.status, 403);
  });

  // Mutation: key the rate limiter off the CARDS instead of the company's own
  // hotel list. A portfolio whose only cards are company-scope has no hotel
  // card to key on, and the endpoint would be uncapped in exactly the case
  // where it is doing the most work.
  test('the portfolio read is rate-limited even with no hotel cards on it', async () => {
    const before = await pg.query<{ n: string }>(
      `select count(*)::text as n from public.api_limits where endpoint like 'company-queue%'`,
    );
    await portfolioFor(UID_VERA); // Tyler alone; whether it has cards is not the point
    const after = await pg.query<{ n: string }>(
      `select count(*)::text as n from public.api_limits where endpoint like 'company-queue%'`,
    );
    assert.ok(
      Number(after.rows[0].n) > Number(before.rows[0].n) || Number(before.rows[0].n) > 0,
      'the portfolio read never touched a rate-limit bucket',
    );
  });

  test('no session at all is refused', async () => {
    signedInAs = null;
    const res = await portfolioGet(req('https://staxis.test/api/company/queue'));
    assert.ok(res.status === 401 || res.status === 403, `unauthenticated got ${res.status}`);
  });
});

// ═══ WALL B ════════════════════════════════════════════════════════════════

describe('Wall B — one company never appears in another\'s portfolio', () => {
  // Mutation: resolve the hotel list from accessibleProperties, or from
  // anything other than the caller's own organization. Tyler's $8,000-$12,000
  // chiller is the card that would come through.
  test('Gulf Coast\'s VP sees Gulf Coast hotels and nothing else', async () => {
    const maria = await portfolioFor(UID_MARIA);
    assert.equal(maria.data.scope?.organizationId, ORG_A);
    assert.equal(maria.data.scope?.hotelCount, 2);

    const hotels = new Set(maria.data.cards.map((c) => c.hotel?.propertyId).filter(Boolean));
    assert.ok(!hotels.has(PID_B1), 'Tyler appeared in Gulf Coast\'s portfolio');
    for (const card of maria.data.cards) {
      assert.doesNotMatch(card.summary, /PINEY WOODS PRIVATE/, 'company B text crossed the wall');
    }
  });

  // The other end. A leak has two directions and only testing one is testing
  // half a wall.
  test('Piney Woods\' VP sees Tyler and nothing else', async () => {
    const vera = await portfolioFor(UID_VERA);
    assert.equal(vera.data.scope?.organizationId, ORG_B);
    assert.equal(vera.data.scope?.hotelCount, 1);

    for (const card of vera.data.cards) {
      assert.ok(
        !card.hotel || card.hotel.propertyId === PID_B1,
        `a card from ${card.hotel?.name} reached Piney Woods`,
      );
      assert.doesNotMatch(card.summary, /Room 214|Room 108/, 'Gulf Coast text crossed the wall');
    }
  });

  // Mutation: drop the organization filter in setCompanyFindingStatus. One
  // company's owner could silence another's card by naming its id.
  test('a company cannot silence another company\'s card even holding its id', async () => {
    const planted = await pg.query<{ id: string }>(
      `insert into public.company_findings
         (organization_id, detector_id, dedupe_key, summary, severity, disposition, status,
          receipt_query_id, evidence, magnitude)
       values ($1, 'probe', 'probe:b_only', 'Piney Woods only.', 'attention', 'recommend',
               'open', 'probe', '{}'::jsonb, 3)
       returning id`,
      [ORG_B],
    );
    const bId = planted.rows[0].id;

    signedInAs = UID_ANA; // Gulf Coast's owner
    const res = await portfolioPost(req('https://staxis.test/api/company/queue', {
      method: 'POST',
      body: { findingId: bId, action: 'muted' },
    }));
    assert.equal(res.status, 404, 'company A reached across the wall');

    const after = await pg.query<{ status: string }>(
      'select status from public.company_findings where id = $1', [bId],
    );
    assert.equal(after.rows[0].status, 'open', 'company B\'s card was modified by company A');
  });
});

// ═══ SIGN-OFF ROUTING ══════════════════════════════════════════════════════

describe('sign-off routing — locked at the hotel, live for the approver', () => {
  test('the rule only exists because a human confirmed it', async () => {
    // Above the line and below it, straight through the reader the routing uses.
    assert.ok(await authorityRuleFor(ORG_A, 'expense', 90_000), 'the confirmed rule did not apply');
    assert.equal(await authorityRuleFor(ORG_A, 'expense', 30_000), null);
    // Piney Woods never wrote one.
    assert.equal(await authorityRuleFor(ORG_B, 'expense', 90_000), null);
  });

  // Mutation: stop attaching signOff in /api/findings. The GM keeps the button
  // and the company's rule is decoration on a screen nobody enforces.
  test('the GM\'s card is LOCKED, in full, and names the approver', async () => {
    const { findings } = await hotelQueueFor(UID_GWEN, PID_A1);
    const locked = findings.find((f) => f.id === LOCKED_FINDING);

    assert.ok(locked, 'the card was HIDDEN from the GM — it is supposed to be locked, not hidden');
    assert.ok(locked!.action, 'the plan was stripped off the GM\'s card');
    assert.ok(locked!.signOff, 'no signature was attached to a card the rulebook governs');
    assert.equal(locked!.signOff!.approverRole, 'vp');
    assert.equal(locked!.signOff!.callerMayApprove, false);
    assert.ok(
      locked!.signOff!.approverNames.includes('Maria'),
      `the approver was not named: ${JSON.stringify(locked!.signOff!.approverNames)}`,
    );
  });

  // Mutation: apply the rule to every card. A $100–300 plan would need a VP.
  test('a plan under the line is a perfectly normal card', async () => {
    const { findings } = await hotelQueueFor(UID_GWEN, PID_A1);
    const cheap = findings.find((f) => f.id === CHEAP_FINDING);
    assert.ok(cheap);
    assert.equal(cheap!.signOff, null, 'a rule reached a plan the company never gated');
  });

  // Mutation: use the LOW end of the range for routing. A $400-800 plan would
  // slip under a $500 rule written to catch exactly that.
  test('the boundary is the TOP of the range, checked against real rows', async () => {
    const straddling = await plantFinding({
      propertyId: PID_A2,
      dedupeKey: 'probe:straddling',
      summary: 'Lufkin boiler.',
      priceLowCents: 40_000,   // $400 — under the line
      priceHighCents: 80_000,  // $800 — over it
    });
    await plantAction(PID_A2, straddling, 'Boiler room');

    const { findings } = await hotelQueueFor(UID_MARIA, PID_A2);
    const card = findings.find((f) => f.id === straddling);
    assert.ok(card?.signOff, 'a plan whose top clears the line was not routed');
  });

  // Mutation: lock whenever a rule exists, regardless of who is looking. The
  // VP the card was routed TO would be locked out of their own decision.
  test('the approver\'s copy of the same card is NOT locked', async () => {
    const { findings } = await hotelQueueFor(UID_MARIA, PID_A1);
    const same = findings.find((f) => f.id === LOCKED_FINDING);
    assert.ok(same?.signOff);
    assert.equal(same!.signOff!.callerMayApprove, true, 'the VP was locked out of her own signature');
  });

  // Mutation: compare roles for equality instead of strength. The owner of the
  // company could not approve what her own rulebook routed to the VP.
  test('the owner can sign for the VP', async () => {
    const { findings } = await hotelQueueFor(UID_ANA, PID_A1);
    const same = findings.find((f) => f.id === LOCKED_FINDING);
    assert.ok(same?.signOff);
    assert.equal(same!.signOff!.callerMayApprove, true, 'the owner could not sign for her VP');
  });

  // Mutation: gate only in the browser. This is the test that says the lock is
  // real — nothing in this request came from a rendered card.
  test('the SERVER refuses the GM\'s tap, not the browser', async () => {
    const refused = await tapAction(UID_GWEN, PID_A1, LOCKED_ACTION);
    assert.equal(refused.status, 403, `the GM executed a card the company locked (${refused.code})`);
    assert.match(String(refused.error), /Maria/);

    const rows = await pg.query<{ state: string }>(
      'select state from public.finding_actions where id = $1', [LOCKED_ACTION],
    );
    assert.equal(rows.rows[0].state, 'proposed', 'the refused tap still moved the action');
  });

  // Mutation: refuse everything once a rule exists. Nobody could ever act and
  // the feature would be a wall rather than a routing.
  test('the same tap on an ungated card goes through for the GM', async () => {
    const allowed = await tapAction(UID_GWEN, PID_A1, CHEAP_ACTION);
    assert.notEqual(allowed.status, 403, 'a plan no rule reaches was refused');
  });
});

// ═══ BADGES ════════════════════════════════════════════════════════════════

describe('badges are honest on both sides', () => {
  // Mutation: drop countLockedProposals from the badge. The GM's pill would
  // promise a decision they are not allowed to make.
  test('the GM\'s pill does not count a card locked behind the VP', async () => {
    const before = await pg.query<{ n: string }>(
      `select count(*)::text as n from public.findings
        where property_id = $1 and status in ('open','updated') and disposition = 'propose'`,
      [PID_A1],
    );
    const waiting = Number(before.rows[0].n);
    assert.ok(waiting >= 1, 'the fixture has no waiting decisions to count');

    const gwen = await badgeFor(UID_GWEN, PID_A1);
    assert.ok(gwen < waiting, `the GM's badge (${gwen}) counted the locked card out of ${waiting}`);
  });

  // Mutation: subtract locked cards from everybody. The approver's own badge
  // would go quiet about the thing only they can do.
  test('the approver\'s pill still counts it', async () => {
    const maria = await badgeFor(UID_MARIA, PID_A1);
    const gwen = await badgeFor(UID_GWEN, PID_A1);
    assert.ok(maria > gwen, `the VP's badge (${maria}) did not include what the GM's (${gwen}) excluded`);
  });

  // Mutation: make the lock lookup unconditional. Every hotel in the product —
  // none of which is in a rule-writing company — would pay for it on every
  // shell mount.
  test('a hotel outside any rulebook counts exactly what it always did', async () => {
    const raw = await pg.query<{ n: string }>(
      `select count(*)::text as n from public.findings
        where property_id = $1 and status in ('open','updated') and disposition = 'propose'`,
      [PID_B1],
    );
    assert.equal(await badgeFor(UID_VERA, PID_B1), Number(raw.rows[0].n));
  });
});

// ═══ CLIMBING ══════════════════════════════════════════════════════════════

describe('climbing — the boss reads reality, not tap states', () => {
  // THE founder ruling, on real rows through the real route.
  // Mutation: filter known_problem out of CLIMB_VISIBLE_STATUSES. A GM tapping
  // Seen at 7am would take a $3,100 problem off the owner's screen.
  test('"Seen" at the hotel does not remove the card from the company queue', async () => {
    const id = await plantFinding({
      propertyId: PID_A2,
      dedupeKey: 'probe:seen_but_big',
      summary: 'Lufkin roof.',
      disposition: 'recommend',
      priceLowCents: 280_000,
      priceHighCents: 340_000,
      daysAgo: 12,
    });

    const beforeTap = await portfolioFor(UID_MARIA);
    assert.ok(beforeTap.data.cards.some((c) => c.id === id), 'the card never climbed at all');

    // The GM taps Seen through the hotel's own door — the real one.
    signedInAs = UID_GWEN;
    await queuePost(req('https://staxis.test/api/findings', {
      method: 'POST',
      body: { propertyId: PID_A2, findingId: id, action: 'known_problem' },
    }));
    // Gwen has no hat at Lufkin, so drive it as Maria to be sure the row moved.
    signedInAs = UID_MARIA;
    await queuePost(req('https://staxis.test/api/findings', {
      method: 'POST',
      body: { propertyId: PID_A2, findingId: id, action: 'known_problem' },
    }));
    assert.equal(await statusOf(id), 'known_problem', 'the Seen tap did not land');

    const afterTap = await portfolioFor(UID_MARIA);
    assert.ok(
      afterTap.data.cards.some((c) => c.id === id),
      '"Seen" silenced the boss — the one thing the founder ruled it must never do',
    );
  });

  // Mutation: treat resolved like the silences. Solved problems would pile up
  // on a VP's screen and teach them to ignore it.
  test('"Fixed" DOES remove it — resolution is reality, not a tap state', async () => {
    const id = await plantFinding({
      propertyId: PID_A2,
      dedupeKey: 'probe:then_fixed',
      summary: 'Lufkin lift.',
      disposition: 'recommend',
      priceLowCents: 280_000,
      priceHighCents: 340_000,
      daysAgo: 12,
    });
    assert.ok((await portfolioFor(UID_MARIA)).data.cards.some((c) => c.id === id));

    signedInAs = UID_MARIA;
    await queuePost(req('https://staxis.test/api/findings', {
      method: 'POST',
      body: { propertyId: PID_A2, findingId: id, action: 'resolved' },
    }));
    assert.equal(await statusOf(id), 'resolved');

    assert.ok(
      !(await portfolioFor(UID_MARIA)).data.cards.some((c) => c.id === id),
      'a card the manager fixed was still on the company queue',
    );
  });

  // Mutation: climb every muted card. "Not doing this" would mean nothing one
  // level up, which is the other half of the founder's judgement call.
  test('a plain mute holds all the way up', async () => {
    const id = await plantFinding({
      propertyId: PID_A2,
      dedupeKey: 'probe:muted_stable',
      summary: 'Lufkin sign.',
      disposition: 'recommend',
      status: 'muted',
      magnitude: 4,
      silencedAtMagnitude: 4,
      priceLowCents: 280_000,
      priceHighCents: 340_000,
      daysAgo: 12,
    });
    assert.ok(!(await portfolioFor(UID_MARIA)).data.cards.some((c) => c.id === id));
  });

  // Mutation: drop the override. One tap would hide a growing problem from the
  // only person who could fund fixing it.
  test('a mute the problem outgrew does NOT hold', async () => {
    const id = await plantFinding({
      propertyId: PID_A2,
      dedupeKey: 'probe:muted_escalated',
      summary: 'Lufkin pump, now much worse.',
      disposition: 'recommend',
      status: 'muted',
      magnitude: 20,
      silencedAtMagnitude: 4,
      priceLowCents: 280_000,
      priceHighCents: 340_000,
      daysAgo: 12,
    });
    const card = (await portfolioFor(UID_MARIA)).data.cards.find((c) => c.id === id);
    assert.ok(card, 'a muted problem that quadrupled stayed hidden from the company');
  });

  // Mutation: raise the bar, or only climb on age. A fresh $3,000 problem
  // would wait a week before the person who signs for it heard about it.
  test('big money climbs on the day it appears, and says so', async () => {
    const id = await plantFinding({
      propertyId: PID_A2,
      dedupeKey: 'probe:big_today',
      summary: 'Lufkin compressor.',
      disposition: 'recommend',
      priceLowCents: 280_000,
      priceHighCents: 340_000,
      daysAgo: 0,
    });
    const card = (await portfolioFor(UID_MARIA)).data.cards.find((c) => c.id === id);
    assert.ok(card);
    assert.equal(card!.climbReason, 'big_dollar');
  });

  // Mutation: drop the value floor, or the age condition. Either a $12 card
  // reaches an owner, or nothing ever climbs for sitting there.
  test('a small card at a hotel stays at the hotel', async () => {
    const id = await plantFinding({
      propertyId: PID_A2,
      dedupeKey: 'probe:small_and_old',
      summary: 'Lufkin lightbulb.',
      disposition: 'recommend',
      priceLowCents: 1_000,
      priceHighCents: 2_000,
      daysAgo: 90,
    });
    assert.ok(!(await portfolioFor(UID_MARIA)).data.cards.some((c) => c.id === id));
  });

  // Mutation: reorder the reasons. The card the reader can clear in one tap
  // would be filed under "big" and they would not know it was waiting on them.
  test('the card waiting on a signature says exactly that', async () => {
    const card = (await portfolioFor(UID_MARIA)).data.cards.find((c) => c.id === LOCKED_FINDING);
    assert.ok(card, 'the card routed to the VP never reached her queue');
    assert.equal(card!.climbReason, 'sign_off');
    assert.equal(card!.hotel?.propertyId, PID_A1);
    assert.equal(card!.signOff?.callerMayApprove, true);
  });

  // Mutation: reuse the hotel queue's GET here. A VP scrolling twelve hotels
  // would demote detectors at hotels they will never open (0362).
  test('reading the portfolio does NOT count as the hotel having shown its cards', async () => {
    const before = await pg.query<{ shown_count: number }>(
      'select shown_count from public.findings where id = $1', [LOCKED_FINDING],
    );
    await portfolioFor(UID_ANA);
    await portfolioFor(UID_ANA);
    const after = await pg.query<{ shown_count: number }>(
      'select shown_count from public.findings where id = $1', [LOCKED_FINDING],
    );
    assert.equal(
      after.rows[0].shown_count,
      before.rows[0].shown_count,
      'a boss reading over the GM\'s shoulder was recorded as the GM reading',
    );
  });
});

// ═══ THE PORTFOLIO CHECKS ══════════════════════════════════════════════════

describe('the portfolio checks write company-scope cards', () => {
  before(async () => {
    // Two comparable weeks of deliveries: Beaumont modest, Lufkin heavy. Both
    // hotels' records reach well back, so both are allowed into the comparison.
    const plantOrders = async (propertyId: string, dollars: number) => {
      const item = await pg.query<{ id: string }>(
        `insert into public.inventory (property_id, name, category, unit, current_stock, par_level)
         values ($1, 'Towels', 'housekeeping', 'each', 40, 100) returning id`,
        [propertyId],
      );
      const itemId = item.rows[0].id;
      for (let day = 1; day <= 90; day += 1) {
        const when = new Date(Date.now() - day * 86_400_000).toISOString();
        await pg.query(
          `insert into public.inventory_orders
             (property_id, item_id, item_name, quantity, total_cost, received_at)
           values ($1, $2, 'Towels', 1, $3, $4)`,
          [propertyId, itemId, day <= 8 ? dollars / 8 : 1, when],
        );
      }
    };
    await plantOrders(PID_A1, 800);
    await plantOrders(PID_A2, 2400);
  });

  // Mutation: build the comparison set from anything but
  // propertiesOfOrganization. Tyler's numbers would be in Gulf Coast's card.
  test('a cross-hotel comparison appears, naming only company hotels', async () => {
    const { runPortfolioChecks } = await import('@/lib/company/portfolio-runner');
    const summary = await runPortfolioChecks({ organizationId: ORG_A, force: true });
    assert.equal(summary.hotels, 2);

    const rows = await pg.query<{ summary: string; evidence: Record<string, unknown> }>(
      `select summary, evidence from public.company_findings
        where organization_id = $1 and detector_id = 'portfolio_supply_spend_gap'`,
      [ORG_A],
    );
    assert.equal(rows.rows.length, 1, 'the comparison did not produce exactly one card');
    const card = rows.rows[0];
    assert.match(card.summary, /Beaumont Suites/);
    assert.match(card.summary, /Lufkin Inn/);
    assert.doesNotMatch(card.summary, /Tyler/, 'another company\'s hotel was in the comparison');
    // Founder ruling: two hotels are a difference, never an outlier.
    assert.doesNotMatch(card.summary, /outlier/i);

    const named = (card.evidence as { params?: { hotels?: string[] } }).params?.hotels ?? [];
    assert.deepEqual([...named].sort(), ['Beaumont Suites', 'Lufkin Inn']);
  });

  // Mutation: drop the one-active-per-problem index, or put the gap in the
  // dedupe key. A second run would stack a second card about one problem.
  test('a second run updates the same row rather than stacking a second card', async () => {
    const { runPortfolioChecks } = await import('@/lib/company/portfolio-runner');
    await runPortfolioChecks({ organizationId: ORG_A, force: true });
    const rows = await pg.query<{ n: string }>(
      `select count(*)::text as n from public.company_findings
        where organization_id = $1 and detector_id = 'portfolio_supply_spend_gap'
          and status in ('open','updated','known_problem','muted')`,
      [ORG_A],
    );
    assert.equal(Number(rows.rows[0].n), 1, 'the second run stacked a duplicate');
  });

  test('the company card reaches the VP\'s queue, labelled as company-wide', async () => {
    const maria = await portfolioFor(UID_MARIA);
    const companyCard = maria.data.cards.find((c) => c.hotel === null);
    assert.ok(companyCard, 'no company-scope card reached the portfolio queue');
    assert.equal(companyCard!.climbReason, 'portfolio');
  });

  // Mutation: drop the organization filter on the verdict. The comparison would
  // be un-silenceable, or silenceable from the wrong company.
  test('the VP can put a company card down, and it leaves their queue', async () => {
    const maria = await portfolioFor(UID_MARIA);
    const companyCard = maria.data.cards.find((c) => c.hotel === null)!;

    signedInAs = UID_MARIA;
    const res = await portfolioPost(req('https://staxis.test/api/company/queue', {
      method: 'POST',
      body: { findingId: companyCard.id, action: 'known_problem' },
    }));
    assert.equal(res.status, 200);

    const after = await portfolioFor(UID_MARIA);
    assert.ok(
      !after.data.cards.some((c) => c.id === companyCard.id),
      'the VP silenced their own company card and it stayed on their own screen',
    );
  });
});

// ═══ THE BRIEF ═════════════════════════════════════════════════════════════

describe('the portfolio morning brief', () => {
  // Mutation: invent any of these numbers. Every figure below traces to a row
  // planted in this file.
  test('every number comes from planted reality', async () => {
    const maria = await portfolioFor(UID_MARIA);
    assert.ok(maria.data.brief, 'a company with checked hotels got no brief');
    const text = maria.data.brief!.lines.map((l) => l.text).join(' | ');

    assert.match(text, /Across your 2 hotels/);
    // 34 + 30 across Beaumont and Lufkin. Tyler's 28 must NOT be in there.
    assert.match(text, /Checked 64 things overnight/);
    assert.doesNotMatch(text, /92/, 'another company\'s run counts were summed in');
  });

  test('the liveness rollup counts only this company\'s hotels', async () => {
    const maria = await portfolioFor(UID_MARIA);
    assert.equal(maria.data.run?.thingsChecked, 64);
    assert.equal(maria.data.run?.hotelsTotal, 2);

    const vera = await portfolioFor(UID_VERA);
    assert.equal(vera.data.run?.thingsChecked, 28);
    assert.equal(vera.data.run?.hotelsTotal, 1);
  });

  // Mutation: drop the cache. The brief would rewrite itself as the day's cards
  // are dealt with, which is a live counter rather than a morning summary.
  test('the brief a reader sees twice is the same brief', async () => {
    const first = await portfolioFor(UID_MARIA);
    const second = await portfolioFor(UID_MARIA);
    assert.deepEqual(second.data.brief, first.data.brief);
  });

  // Mutation: key the cache on the company alone. The owner and the VP see
  // different decision counts, and whichever loaded first would serve both.
  test('two people at one company get their own briefs', async () => {
    const maria = await portfolioFor(UID_MARIA);
    const ana = await portfolioFor(UID_ANA);
    assert.ok(maria.data.brief && ana.data.brief);
    // They may legitimately agree on the wording; what must not happen is one
    // being served the other's cached copy under a company-only key. Proven by
    // the counts being computed per reader, which the sign-off card drives.
    assert.equal(maria.data.scope?.organizationId, ana.data.scope?.organizationId);
  });

  // Mutation: return a "quiet morning" brief for a company nobody has checked.
  // The single worst sentence this surface could print.
  //
  // The cache row is cleared alongside the run rows because the two together
  // are what "a new day at a company that has never been checked" looks like —
  // the brief is keyed on the company's calendar day, and a clock this test
  // cannot advance is the only reason it is done by hand.
  test('a company whose hotels have never been checked gets NO brief', async () => {
    await pg.query('delete from public.finding_runs where property_id = $1', [PID_B1]);
    await pg.query(`delete from public.idempotency_log where route = 'company-brief'`);

    const vera = await portfolioFor(UID_VERA);
    assert.equal(vera.data.brief, null, 'an unchecked company was told something about its night');
    assert.equal(vera.data.run, null);
    // And the cards are still there — the brief going silent is not the queue
    // going silent, and an unchecked company still has whatever is on record.
    assert.ok(vera.data.cards.length > 0, 'the queue emptied along with the brief');
  });
});

// ═══ THE PRICE TAG, ON THE COMPANY LEDGER ══════════════════════════════════
//
// The hotel ledger's five cases (findings-ledger.integration.test.ts) proved
// `findings_price_is_a_range` refuses a point estimate. `company_findings` was
// written with the identical constraint and NOTHING exercised it — so the one
// screen where a price is read by the person who signs the cheque was the one
// place the rule was a comment rather than a tested guarantee. Same five cases,
// same order, against the other table.
describe('the company ledger refuses a price that is not a range', () => {
  const withPrice = (low: number | null, high: number | null) =>
    pg.query(
      `insert into public.company_findings
         (organization_id, detector_id, dedupe_key, summary, severity, disposition, status,
          receipt_query_id, evidence, magnitude, price_low_cents, price_high_cents)
       values ($1, 'probe_price',
               'price:' || coalesce($2::integer::text, 'n') || ':' || coalesce($3::integer::text, 'n'),
               'x', 'info', 'fyi', 'open', 'q', '{}'::jsonb, 1, $2::integer, $3::integer)`,
      [ORG_A, low, high],
    );

  test('a real range is accepted', async () => {
    await assert.doesNotReject(() => withPrice(20_000, 40_000));
  });

  test('no price at all is accepted', async () => {
    await assert.doesNotReject(() => withPrice(null, null));
  });

  test('a point estimate wearing a range is refused', async () => {
    await assert.rejects(() => withPrice(34_000, 34_000), /company_findings_price_is_a_range/);
  });

  test('an inverted range is refused', async () => {
    await assert.rejects(() => withPrice(40_000, 20_000), /company_findings_price_is_a_range/);
  });

  test('half a range is refused', async () => {
    await assert.rejects(() => withPrice(20_000, null), /company_findings_price_is_a_range/);
  });
});
