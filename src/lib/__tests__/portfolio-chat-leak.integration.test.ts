/**
 * CROSS-HOTEL CHAT, AGAINST A REAL POSTGRES HOLDING TWO COMPANIES.
 *
 * The product is one sentence: a VP whose company turned cross-hotel chat on can
 * ask the copilot about their own hotels. Every risk in it is the same sentence
 * read backwards — somebody who is not a VP, a company that did not turn it on,
 * or a hotel that is not theirs.
 *
 * So this file drives the REAL portfolio tools and the REAL route against the
 * two-company fixture, with company B planted LOUDER than company A by an order
 * of magnitude (`PORTFOLIO_FACTS`): Tyler alone has 99 work orders, $99,999 of
 * supply spend and 40 open findings, against Gulf Coast's 7, $900 and 4. Any
 * cross-company sum, ranking or average is therefore dominated by Tyler, and
 * every one of its free-text columns carries `ZZLEAKB`, so a leak shows up in
 * the tool's own output rather than only in an arithmetic check.
 *
 * WHAT IS PROVED HERE
 *   1. company A's VP gets company A's numbers, exactly, and never company B's;
 *   2. no STATEMENT any portfolio tool ran returned a company-B row — caught at
 *      the database boundary even if the handler dropped it on the floor;
 *   3. every statement against a hotel-scoped table carried the hotel filter,
 *      so the loop-over-scopedDb shape is real and not just intended;
 *   4. a property-scope person is refused at the route;
 *   5. a company whose switch is off is refused at the route, from the ABSENCE
 *      of a settings row (the state every company is actually in);
 *   6. a cross-company probe — naming the other company's id — is refused;
 *   7. a hotel id outside coverage, passed as a TOOL ARGUMENT, is refused
 *      INSIDE the tool, which is the layer a wrong route would not protect;
 *   8. an org-scoped conversation is read back only while the caller still
 *      passes the gate;
 *   9. no portfolio tool mutates, and no portfolio tool is reachable from the
 *      per-hotel chat surface.
 *
 * NOTE ON RLS: PGlite runs as the table owner, exactly as the service-role key
 * bypasses policies in production. What is under test is app-level scoping.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-min-20-chars';
process.env.CRON_SECRET ??= 'placeholder-cron-secret-min-16';
process.env.OPENAI_API_KEY ??= 'sk-placeholder';
process.env.ANTHROPIC_API_KEY ??= 'sk-ant-placeholder';
process.env.DISABLE_SERVER_2FA_ENFORCEMENT = 'true';

import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';
import type { PGlite } from '@electric-sql/pglite';

import { supabaseAdmin } from '@/lib/supabase-admin';
import {
  executeTool,
  getToolsForRole,
  listAllTools,
  type ToolContext,
} from '@/lib/agent/tools';
import '@/lib/agent/tools/index';
import { scopeColumnFor } from '@/lib/agent/scoped-db';
import {
  clearPortfolioAccessCache,
  resolvePortfolioAccessUncached,
} from '@/lib/company/portfolio';
import { clearPortfolioHotelCache } from '@/lib/agent/portfolio/hotels';
import { createConversation } from '@/lib/agent/memory';
import { PROMPT_VERSION } from '@/lib/agent/prompts';
import { GET as portfolioProbe, POST as portfolioTurn } from '@/app/api/agent/portfolio/route';
import { GET as conversationGet } from '@/app/api/agent/conversations/[id]/route';

import { applyMigrationsToPglite } from '../../../tests/fixtures/pglite-migrate';
import {
  createPglitePostgrest,
  loadCatalog,
  type PglitePostgrest,
  type RecordedStatement,
} from '../../../tests/fixtures/postgrest-pglite';
import {
  ACCOUNT_FRANK,
  ACCOUNT_GIL,
  ACCOUNT_MARIA,
  ACCOUNT_VERA,
  ORG_A,
  ORG_B,
  PID_A1,
  PID_A2,
  PID_B1,
  PORTFOLIO_FACTS,
  PORTFOLIO_LEAK_MARKER,
  UID_FRANK,
  UID_GIL,
  UID_MARIA,
  UID_VERA,
  seedPortfolioData,
  seedTwoCompanies,
  setCrossHotelChat,
} from '../../../tests/fixtures/pglite-two-company-seed';

let pg: PGlite;
let shim: PglitePostgrest;

const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);
const originalRpc = supabaseAdmin.rpc.bind(supabaseAdmin);
const originalGetUser = supabaseAdmin.auth.getUser.bind(supabaseAdmin.auth);

let signedInAs: string | null = null;

/** Company B's fingerprints. Any of these in company A's answer is a leak. */
const LEAK_NEEDLES = [PORTFOLIO_LEAK_MARKER, PID_B1, ORG_B, 'b1b1b1b1-', 'bbbb0000-'];

function leaksIn(value: unknown): string[] {
  const text = JSON.stringify(value ?? null) ?? '';
  return LEAK_NEEDLES.filter((needle) => text.includes(needle));
}

/** Every portfolio tool, from the registry — never a hand-kept list. */
function portfolioToolNames(): string[] {
  return listAllTools()
    .filter((t) => (t.surfaces ?? ['chat']).includes('portfolio'))
    .map((t) => t.name)
    .sort();
}

function authorizedRequest(url: string, init?: { method?: string; body?: unknown }): NextRequest {
  return new NextRequest(url, {
    method: init?.method ?? 'GET',
    headers: {
      authorization: 'Bearer portfolio-leak-test-token',
      'content-type': 'application/json',
      'x-real-ip': '203.0.113.11',
    },
    ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
}

async function postTurn(
  authUserId: string,
  body: Record<string, unknown>,
): Promise<{ status: number; error: string | null; details: unknown }> {
  signedInAs = authUserId;
  const response = await portfolioTurn(
    authorizedRequest('https://staxis.test/api/agent/portfolio', { method: 'POST', body }),
  );
  // A refusal is JSON; an ALLOWED turn is an SSE stream and is never driven here
  // (it would call Anthropic). Every case below is expected to refuse.
  const parsed = await response.json().catch(() => ({})) as {
    error?: string; details?: unknown;
  };
  return { status: response.status, error: parsed.error ?? null, details: parsed.details ?? null };
}

async function probe(authUserId: string, organizationId?: string): Promise<{
  status: number;
  data: Record<string, unknown>;
}> {
  signedInAs = authUserId;
  const url = new URL('https://staxis.test/api/agent/portfolio');
  if (organizationId) url.searchParams.set('organizationId', organizationId);
  const response = await portfolioProbe(authorizedRequest(url.toString()));
  const parsed = await response.json().catch(() => ({})) as { data?: Record<string, unknown> };
  return { status: response.status, data: parsed.data ?? {} };
}

/**
 * Build the tool context EXACTLY as the route builds it, by going through the
 * same spine call. A test that hand-wrote `portfolio: { propertyIds: [...] }`
 * would be testing its own fixture, not the door.
 */
async function portfolioContextFor(accountId: string, authUserId: string): Promise<ToolContext> {
  const access = await resolvePortfolioAccessUncached(accountId);
  assert.ok(access.ok, 'fixture: this person is supposed to reach the portfolio surface');
  return {
    user: {
      uid: authUserId,
      accountId,
      username: 'probe',
      displayName: 'Probe',
      role: 'general_manager',
      propertyAccess: access.access.propertyIds,
    },
    propertyId: access.access.propertyIds[0],
    staffId: null,
    requestId: 'portfolio-leak-test',
    surface: 'portfolio',
    portfolio: {
      organizationId: access.access.organizationId,
      organizationName: access.access.organizationName,
      propertyIds: access.access.propertyIds,
    },
  };
}

before(async () => {
  const migrated = await applyMigrationsToPglite();
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

  await seedTwoCompanies(pg);
  await seedPortfolioData(pg);
});

after(async () => {
  supabaseAdmin.from = originalFrom;
  supabaseAdmin.rpc = originalRpc;
  supabaseAdmin.auth.getUser = originalGetUser;
  await pg?.close();
});

beforeEach(() => {
  // Both gates and both hotel lists are cached in-process. A stale yes from the
  // previous case is exactly the bug this file exists to catch, so nothing is
  // allowed to survive between cases.
  clearPortfolioAccessCache();
  clearPortfolioHotelCache();
  shim.reset();
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the door', () => {
  test('company A\'s VP is let in, with exactly company A\'s hotels', async () => {
    const access = await resolvePortfolioAccessUncached(ACCOUNT_MARIA);
    assert.ok(access.ok, 'Maria wears a company VP hat at Gulf Coast');
    assert.equal(access.access.organizationId, ORG_A);
    assert.equal(access.access.companyRole, 'vp');
    assert.deepEqual(access.access.propertyIds, [PID_A1, PID_A2].sort());
    assert.equal(
      access.access.propertyIds.includes(PID_B1), false,
      'the other company\'s hotel is not in her portfolio',
    );
  });

  test('a property-scope GM is refused — a hotel job is not a seat at the company', async () => {
    const access = await resolvePortfolioAccessUncached(ACCOUNT_GIL);
    assert.equal(access.ok, false);
    assert.equal(access.ok === false && access.reason, 'no_company_job');

    const refused = await postTurn(UID_GIL, { message: 'compare my hotels' });
    assert.equal(refused.status, 403);
    assert.match(refused.error ?? '', /company-wide job/i);
  });

  test('a front-desk person at one hotel is refused', async () => {
    const access = await resolvePortfolioAccessUncached(ACCOUNT_FRANK);
    assert.equal(access.ok, false);
    const refused = await postTurn(UID_FRANK, { message: 'compare my hotels' });
    assert.equal(refused.status, 403);
  });

  test('a company VP whose company never switched it on is refused', async () => {
    // Company B has NO settings row at all — the state every company in the
    // product is in until somebody chooses. The refusal comes from the
    // documented default, not from a stored 'false'.
    const rows = await pg.query<{ n: number }>(
      `select count(*)::int as n from company_access_settings
        where organization_id = $1 and setting_key = 'cross_hotel_ai_chat'`,
      [ORG_B],
    );
    assert.equal(rows.rows[0].n, 0, 'fixture: company B chose nothing');

    const access = await resolvePortfolioAccessUncached(ACCOUNT_VERA);
    assert.equal(access.ok, false);
    assert.equal(access.ok === false && access.reason, 'cross_hotel_chat_off');

    const refused = await postTurn(UID_VERA, { message: 'compare my hotels' });
    assert.equal(refused.status, 403);
    assert.equal(refused.details, 'cross_hotel_chat_off');
  });

  test('naming the OTHER company is refused, in both directions', async () => {
    const veraReachingIntoA = await postTurn(UID_VERA, {
      message: 'compare the Gulf Coast hotels',
      organizationId: ORG_A,
    });
    assert.equal(veraReachingIntoA.status, 403);
    assert.equal(veraReachingIntoA.details, 'no_company_job');

    const mariaReachingIntoB = await postTurn(UID_MARIA, {
      message: 'compare the Piney Woods hotels',
      organizationId: ORG_B,
    });
    assert.equal(mariaReachingIntoB.status, 403);
    assert.equal(mariaReachingIntoB.details, 'no_company_job');
  });

  test('the switch closes the door again', async () => {
    await setCrossHotelChat(pg, ORG_A, false);
    clearPortfolioAccessCache();
    try {
      const refused = await postTurn(UID_MARIA, { message: 'compare my hotels' });
      assert.equal(refused.status, 403);
      assert.equal(refused.details, 'cross_hotel_chat_off');
    } finally {
      await setCrossHotelChat(pg, ORG_A, true);
      clearPortfolioAccessCache();
    }
  });

  test('the availability probe tells a surface what it may offer', async () => {
    const maria = await probe(UID_MARIA);
    assert.equal(maria.status, 200);
    assert.equal(maria.data.available, true);
    assert.equal(maria.data.organizationId, ORG_A);
    const hotels = maria.data.hotels as Array<{ hotelId: string; name: string }>;
    assert.deepEqual(hotels.map((h) => h.hotelId).sort(), [PID_A1, PID_A2].sort());
    assert.deepEqual(leaksIn(maria.data), []);

    const gil = await probe(UID_GIL);
    assert.equal(gil.data.available, false);
    assert.equal(gil.data.reason, 'no_company_job');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the tools answer for company A and never for company B', () => {
  test('every portfolio tool runs, returns company A\'s data, and leaks nothing', async () => {
    const ctx = await portfolioContextFor(ACCOUNT_MARIA, UID_MARIA);
    const names = portfolioToolNames();
    assert.ok(names.length >= 5, `expected a portfolio catalog, got ${names.length}`);

    for (const name of names) {
      shim.reset();
      const result = await executeTool(name, {}, ctx);
      assert.equal(result.ok, true, `${name} failed: ${result.error}`);

      // (1) the tool's own output carries no company-B value.
      assert.deepEqual(
        leaksIn(result.data), [],
        `${name} returned company B data: ${JSON.stringify(result.data).slice(0, 400)}`,
      );

      // (2) no STATEMENT returned a company-B row — a leak is caught at the
      //     database boundary even when the handler discards the row.
      for (const stmt of shim.statements as RecordedStatement[]) {
        assert.deepEqual(
          leaksIn(stmt.rows), [],
          `${name}: a ${stmt.verb} on ${stmt.target} returned a company-B row\n${stmt.sql}`,
        );
      }

      // (3) every statement against a hotel-scoped table carried the hotel
      //     filter — the loop-over-scopedDb shape, proved rather than intended.
      for (const stmt of shim.statements as RecordedStatement[]) {
        if (stmt.kind !== 'table') continue;
        if (GLOBAL_TABLES.has(stmt.target)) continue;
        const column = scopeColumnFor(stmt.target);
        const scoped = stmt.filters.some((f) => f.op === 'eq' && f.column === column);
        assert.ok(
          scoped,
          `${name}: ${stmt.verb} on ${stmt.target} carried no ${column} filter\n${stmt.sql}`,
        );
        const value = stmt.filters.find((f) => f.op === 'eq' && f.column === column)?.value;
        assert.ok(
          value === PID_A1 || value === PID_A2,
          `${name}: ${stmt.target} was scoped to ${String(value)}, not one of company A's hotels`,
        );
      }
    }

    assert.deepEqual(shim.unsupported, [], 'the shim compiled every query the tools issued');
  });

  test('the numbers are company A\'s own, not company A + company B', async () => {
    const ctx = await portfolioContextFor(ACCOUNT_MARIA, UID_MARIA);

    const work = await executeTool('portfolio_work_orders', { days: 365 }, ctx);
    const workHotels = (work.data as { hotels: Array<Record<string, unknown>> }).hotels;
    assert.equal(workHotels.length, 2, 'two hotels, not three');
    const byName = new Map(workHotels.map((h) => [h.hotel as string, h]));
    assert.equal(byName.get('Beaumont Suites')?.opened, PORTFOLIO_FACTS.beaumont.workOrders);
    assert.equal(byName.get('Lufkin Inn')?.opened, PORTFOLIO_FACTS.lufkin.workOrders);
    const totalOpened = workHotels.reduce((sum, h) => sum + (h.opened as number), 0);
    assert.equal(
      totalOpened,
      PORTFOLIO_FACTS.beaumont.workOrders + PORTFOLIO_FACTS.lufkin.workOrders,
      'a cross-company read would be dominated by Tyler\'s 99',
    );

    const spend = await executeTool('portfolio_supply_spend', { days: 365 }, ctx);
    const spendHotels = (spend.data as { hotels: Array<Record<string, unknown>> }).hotels;
    const totalSpend = spendHotels.reduce((sum, h) => sum + ((h.spendDollars as number) ?? 0), 0);
    assert.equal(
      Math.round(totalSpend),
      PORTFOLIO_FACTS.beaumont.supplySpendDollars + PORTFOLIO_FACTS.lufkin.supplySpendDollars,
    );

    const items = await executeTool('portfolio_open_items', {}, ctx);
    const itemHotels = (items.data as { hotels: Array<Record<string, unknown>> }).hotels;
    const totalOpen = itemHotels.reduce((sum, h) => sum + ((h.openItems as number) ?? 0), 0);
    assert.equal(
      totalOpen,
      PORTFOLIO_FACTS.beaumont.openFindings + PORTFOLIO_FACTS.lufkin.openFindings,
    );
  });

  test('every derived figure comes out of the tool, so nothing is left to divide', async () => {
    // The model got both of these wrong live by dividing in prose. Here the real
    // tools compute them from real rows: 60-room hotels, seeded work orders.
    const ctx = await portfolioContextFor(ACCOUNT_MARIA, UID_MARIA);
    const work = await executeTool('portfolio_work_orders', { days: 365 }, ctx);
    const byName = new Map(
      (work.data as { hotels: Array<Record<string, unknown>> }).hotels
        .map((h) => [h.hotel as string, h]),
    );

    const lufkin = byName.get('Lufkin Inn')!;
    assert.equal(lufkin.rooms, 60);
    assert.equal(lufkin.opened, PORTFOLIO_FACTS.lufkin.workOrders);
    assert.equal(lufkin.openedPer100Rooms, 8.33, '5 tickets at 60 rooms, worked out here');
    assert.equal(
      lufkin.stillOpenPer100Rooms,
      Math.round(((lufkin.stillOpen as number) / 60) * 100 * 100) / 100,
    );

    // SEVERITY: the fixture writes every ticket as 'MAJOR' — the housekeeper
    // app's vocabulary. The old read matched only the literal 'urgent', so this
    // whole board counted as zero.
    const buckets = lufkin.stillOpenBySeverity as Record<string, number>;
    assert.equal(buckets.high, lufkin.stillOpen, 'MAJOR is high, not invisible');
    assert.equal(buckets.urgent, 0);
    assert.equal(buckets.ungraded, 0);
    assert.equal(
      buckets.urgent + buckets.high + buckets.normal + buckets.low + buckets.ungraded,
      lufkin.stillOpen,
      'every open ticket lands in exactly one bucket',
    );

    const spend = await executeTool('portfolio_supply_spend', { days: 365 }, ctx);
    const spendByName = new Map(
      (spend.data as { hotels: Array<Record<string, unknown>> }).hotels
        .map((h) => [h.hotel as string, h]),
    );
    assert.equal(
      spendByName.get('Lufkin Inn')?.spendPer100RoomsDollars,
      Math.round((PORTFOLIO_FACTS.lufkin.supplySpendDollars / 60) * 100 * 100) / 100,
    );

    const items = await executeTool('portfolio_open_items', {}, ctx);
    const itemsByName = new Map(
      (items.data as { hotels: Array<Record<string, unknown>> }).hotels
        .map((h) => [h.hotel as string, h]),
    );
    assert.equal(
      itemsByName.get('Lufkin Inn')?.openItemsPer100Rooms,
      Math.round((PORTFOLIO_FACTS.lufkin.openFindings / 60) * 100 * 100) / 100,
    );
  });

  test('"how many times worse" is in the payload, not left to the sentence', async () => {
    const ctx = await portfolioContextFor(ACCOUNT_MARIA, UID_MARIA);
    const compare = await executeTool(
      'portfolio_compare', { metric: 'work_orders', days: 365 }, ctx,
    );
    const data = compare.data as {
      ranking: Array<Record<string, unknown>>;
      comparison: Record<string, unknown>;
    };

    const expected = PORTFOLIO_FACTS.lufkin.workOrders / PORTFOLIO_FACTS.beaumont.workOrders;
    assert.equal(data.comparison.highestIsTimesTheLowest, expected);
    assert.deepEqual(data.comparison.highest, { hotel: 'Lufkin Inn', value: PORTFOLIO_FACTS.lufkin.workOrders });
    assert.deepEqual(data.comparison.lowest, { hotel: 'Beaumont Suites', value: PORTFOLIO_FACTS.beaumont.workOrders });
    assert.equal(
      data.comparison.portfolioTotal,
      PORTFOLIO_FACTS.lufkin.workOrders + PORTFOLIO_FACTS.beaumont.workOrders,
    );
    assert.equal(data.ranking[0].timesTheLowest, expected);
    assert.equal(data.ranking[1].timesTheLowest, 1, 'the lowest is 1x itself');
    assert.equal(
      data.ranking.every((r) => !('_exactPerRoom' in r)), true,
      'the unrounded working value is internal; publishing it would invite the model to divide it',
    );
    // A rate is present whether or not the caller asked to rank per room, so a
    // follow-up "per room?" never becomes a division.
    assert.equal(data.ranking[0].per100RoomsValue, 8.33);
    assert.deepEqual(leaksIn(compare.data), [], 'the new fields must not widen the wall either');
  });

  test('the ranking names the right worst hotel — and it is not the loud one', async () => {
    const ctx = await portfolioContextFor(ACCOUNT_MARIA, UID_MARIA);
    const compare = await executeTool(
      'portfolio_compare', { metric: 'work_orders', days: 365 }, ctx,
    );
    const ranking = (compare.data as { ranking: Array<Record<string, unknown>> }).ranking;
    assert.equal(ranking.length, 2);
    assert.equal(ranking[0].hotel, 'Lufkin Inn', 'worst first, within the company');
    assert.equal(ranking[0].value, PORTFOLIO_FACTS.lufkin.workOrders);
    assert.deepEqual(leaksIn(compare.data), []);
  });

  test('the rulebook tool answers with company A\'s CONFIRMED rules only', async () => {
    const ctx = await portfolioContextFor(ACCOUNT_MARIA, UID_MARIA);
    const result = await executeTool('company_rulebook', {}, ctx);
    const rules = (result.data as { rules: Array<Record<string, unknown>> }).rules;
    const text = JSON.stringify(rules);
    assert.match(text, /Ecolab/);
    // Company B's confirmed rule must not appear…
    assert.deepEqual(leaksIn(result.data), []);
    // …and neither must company A's own UNREVIEWED one. The open box's whole
    // guarantee is that an extracted line is not policy until a human says so.
    assert.equal(/laundry vendor/i.test(text), false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('a hotel id in a tool argument is checked by the tool itself', () => {
  test('the other company\'s hotel is refused INSIDE the tool', async () => {
    const ctx = await portfolioContextFor(ACCOUNT_MARIA, UID_MARIA);
    for (const name of ['portfolio_work_orders', 'portfolio_supply_spend', 'portfolio_open_items', 'portfolio_inventory_health']) {
      shim.reset();
      const result = await executeTool(name, { hotelIds: [PID_B1] }, ctx);
      assert.equal(result.ok, false, `${name} accepted a hotel outside the company`);
      assert.match(result.error ?? '', /not one of this company's hotels/);
      // And it did not read anything on the way to saying no.
      for (const stmt of shim.statements as RecordedStatement[]) {
        assert.deepEqual(leaksIn(stmt.rows), [], `${name} read a company-B row before refusing`);
      }
    }
  });

  test('a hotel id smuggled in alongside a legitimate one is refused, not filtered', async () => {
    // The dangerous near-miss: silently dropping the bad id would answer the
    // question and hide that somebody asked for something they may not have.
    const ctx = await portfolioContextFor(ACCOUNT_MARIA, UID_MARIA);
    const result = await executeTool(
      'portfolio_work_orders', { hotelIds: [PID_A1, PID_B1] }, ctx,
    );
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /1 of the 2 hotels/);
  });

  test('narrowing to one of the caller\'s OWN hotels still works', async () => {
    const ctx = await portfolioContextFor(ACCOUNT_MARIA, UID_MARIA);
    const result = await executeTool('portfolio_work_orders', { hotelIds: [PID_A2], days: 365 }, ctx);
    assert.equal(result.ok, true);
    const hotels = (result.data as { hotels: Array<Record<string, unknown>> }).hotels;
    assert.equal(hotels.length, 1);
    assert.equal(hotels[0].hotel, 'Lufkin Inn');
  });

  test('the tool re-checks the company switch, not just the context it was handed', async () => {
    // The context is built ONCE per turn. This is the case where the company
    // switches cross-hotel chat off while a conversation is open: the tool must
    // refuse on its own, from its own read, with a context that still says yes.
    const ctx = await portfolioContextFor(ACCOUNT_MARIA, UID_MARIA);
    await setCrossHotelChat(pg, ORG_A, false);
    clearPortfolioAccessCache();
    try {
      const result = await executeTool('portfolio_work_orders', {}, ctx);
      assert.equal(result.ok, false, 'the tool trusted its context instead of re-reading');
      assert.match(result.error ?? '', /has not turned on/i);
    } finally {
      await setCrossHotelChat(pg, ORG_A, true);
      clearPortfolioAccessCache();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the two catalogs are disjoint', () => {
  test('no per-hotel tool appears on the portfolio surface', async () => {
    const portfolio = getToolsForRole('owner', 'portfolio').map((t) => t.name).sort();
    assert.deepEqual(portfolio, portfolioToolNames());
    const chat = getToolsForRole('owner', 'chat').map((t) => t.name);
    for (const name of portfolio) {
      assert.equal(chat.includes(name), false, `${name} leaked into the per-hotel chat catalog`);
    }
    assert.ok(chat.length > 20, 'the per-hotel catalog is still the big one');
  });

  test('a portfolio tool refuses a context that never went through the company gate', async () => {
    const ctx = await portfolioContextFor(ACCOUNT_MARIA, UID_MARIA);
    // Same person, same hotels — but no portfolio scope, which is the shape
    // EVERY other execution path in the app builds (per-hotel chat, the
    // approval-resolve route, the eval harness).
    const { portfolio: _dropped, ...withoutScope } = ctx;
    for (const name of portfolioToolNames()) {
      const result = await executeTool(name, {}, withoutScope as ToolContext);
      assert.equal(result.ok, false, `${name} ran without a company scope`);
      assert.match(result.error ?? '', /portfolio conversation/);
    }
  });

  test('not one portfolio tool mutates', () => {
    for (const tool of listAllTools()) {
      if (!(tool.surfaces ?? ['chat']).includes('portfolio')) continue;
      assert.equal(
        tool.mutates, undefined,
        `${tool.name} mutates. Company-wide actions are deliberately not built: the portfolio `
        + 'route runs with no approval gate, so a mutating tool here would execute with no card.',
      );
      assert.equal(tool.approval, undefined, `${tool.name} declares an approval tier`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the conversation carries the company', () => {
  test('an org-scoped row reads back for its owner, and stops when the gate closes', async () => {
    const conversationId = await createConversation({
      userAccountId: ACCOUNT_MARIA,
      propertyId: PID_A1,
      role: 'general_manager',
      promptVersion: PROMPT_VERSION,
      organizationId: ORG_A,
      title: 'worst week',
    });

    // The marker really is on the row, in the shape the reader expects.
    const stored = await pg.query<{ prompt_version: string }>(
      `select prompt_version from agent_conversations where id = $1`, [conversationId],
    );
    assert.match(stored.rows[0].prompt_version, new RegExp(`\\+org:${ORG_A}$`));

    signedInAs = UID_MARIA;
    const params = Promise.resolve({ id: conversationId });
    const okResponse = await conversationGet(
      authorizedRequest(`https://staxis.test/api/agent/conversations/${conversationId}`),
      { params },
    );
    assert.equal(okResponse.status, 200);

    // Switch the company off: the same person, the same row, now a 404.
    await setCrossHotelChat(pg, ORG_A, false);
    clearPortfolioAccessCache();
    try {
      const closed = await conversationGet(
        authorizedRequest(`https://staxis.test/api/agent/conversations/${conversationId}`),
        { params: Promise.resolve({ id: conversationId }) },
      );
      assert.equal(closed.status, 404, 'a company-wide transcript outlived the company\'s switch');
    } finally {
      await setCrossHotelChat(pg, ORG_A, true);
      clearPortfolioAccessCache();
    }
  });

  test('a per-hotel conversation is unaffected and cannot be continued as a company one', async () => {
    const conversationId = await createConversation({
      userAccountId: ACCOUNT_MARIA,
      propertyId: PID_A1,
      role: 'general_manager',
      promptVersion: PROMPT_VERSION,
      title: 'one hotel',
    });
    const stored = await pg.query<{ prompt_version: string }>(
      `select prompt_version from agent_conversations where id = $1`, [conversationId],
    );
    assert.equal(stored.rows[0].prompt_version, PROMPT_VERSION, 'no marker on an ordinary chat');

    signedInAs = UID_MARIA;
    const response = await conversationGet(
      authorizedRequest(`https://staxis.test/api/agent/conversations/${conversationId}`),
      { params: Promise.resolve({ id: conversationId }) },
    );
    assert.equal(response.status, 200, 'ordinary conversations still read back unchanged');

    const refused = await postTurn(UID_MARIA, { conversationId, message: 'and across the company?' });
    assert.equal(refused.status, 400);
    assert.match(refused.error ?? '', /single hotel/);
  });

  test('somebody else\'s company conversation is not readable', async () => {
    const conversationId = await createConversation({
      userAccountId: ACCOUNT_MARIA,
      propertyId: PID_A1,
      role: 'general_manager',
      promptVersion: PROMPT_VERSION,
      organizationId: ORG_A,
      title: 'private',
    });
    signedInAs = UID_VERA;
    const response = await conversationGet(
      authorizedRequest(`https://staxis.test/api/agent/conversations/${conversationId}`),
      { params: Promise.resolve({ id: conversationId }) },
    );
    assert.equal(response.status, 404);
  });
});

/**
 * Tables with no hotel column at all — a query against one legitimately carries
 * no scope filter. Mirrors UNSCOPABLE_TABLES in scoped-db.ts plus the two
 * company-level tables the portfolio surface reads through the SPINE (whose own
 * wall is `organization_id`, proved by company-spine.integration.test.ts).
 */
const GLOBAL_TABLES = new Set([
  'accounts',
  'agent_prompts',
  'agent_eval_baselines',
  'organizations',
  'organization_memberships',
  'organization_property_relationships',
  'company_access_settings',
  'company_knowledge',
  'agent_conversations',
  'agent_messages',
]);
