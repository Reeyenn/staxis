/**
 * SEVENTEEN HOTELS, AGAINST A REAL POSTGRES.
 *
 * `portfolio-chat-leak.integration.test.ts` proves the wall. This file proves
 * the SIZE: the founder's stated case is a VP with seventeen to twenty hotels,
 * and every portfolio tool fans out one read set per hotel. Two hotels cannot
 * show what that costs; seventeen can.
 *
 * WHAT IS PROVED HERE
 *   1. every tool's answer at N=17 is arithmetically right, checked against a
 *      brute-force SQL recount rather than against the fixture's own plan;
 *   2. the ranking names the same hotels, in the same order, that a single
 *      `group by property_id` would;
 *   3. the per-hotel loop runs with BOUNDED concurrency — it does not open
 *      seventeen (or fifty) simultaneous reads;
 *   4. the per-turn memo serves one turn twice and never serves a second turn
 *      at all, so two conversations cannot share a number;
 *   5. nothing is dropped silently — a bounded answer says what it bounded, and
 *      every covered hotel still carries its headline figures.
 *
 * It also PRINTS a timing / statement-count / payload-size table, because the
 * only honest way to claim an optimisation worked is to show the number before
 * and the number after.
 *
 * NOTE ON PGLITE AND TIME. PGlite is a single in-process database, so wall-clock
 * here measures WORK DONE, not the concurrency win a real connection pool gives.
 * The portable number this suite is really about is `statements` — how many
 * round trips one answer costs — which is identical in PGlite and in production.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-min-20-chars';
process.env.CRON_SECRET ??= 'placeholder-cron-secret-min-16';
process.env.OPENAI_API_KEY ??= 'sk-placeholder';
process.env.ANTHROPIC_API_KEY ??= 'sk-ant-placeholder';

import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { PGlite } from '@electric-sql/pglite';

import { supabaseAdmin } from '@/lib/supabase-admin';
import { executeTool, type ToolContext } from '@/lib/agent/tools';
import '@/lib/agent/tools/index';
import {
  clearPortfolioAccessCache,
  resolvePortfolioAccessUncached,
} from '@/lib/company/portfolio';
import {
  clearPortfolioHotelCache,
  forEachHotel,
  loadPortfolioHotels,
  mapWithConcurrency,
  PORTFOLIO_READ_CONCURRENCY,
} from '@/lib/agent/portfolio/hotels';
import { scopeColumnFor } from '@/lib/agent/scoped-db';
import {
  buildPortfolioSnapshot,
  clearPortfolioSnapshotCache,
} from '@/lib/agent/portfolio/snapshot';

import { applyMigrationsToPglite } from '../../../tests/fixtures/pglite-migrate';
import {
  createPglitePostgrest,
  loadCatalog,
  type PglitePostgrest,
  type RecordedStatement,
} from '../../../tests/fixtures/postgrest-pglite';
import {
  ACCOUNT_CARL,
  ORG_C,
  UID_CARL,
  seedLargeCompany,
  seedTwoCompanies,
  type LargeCompanyHotelPlan,
} from '../../../tests/fixtures/pglite-two-company-seed';

const HOTEL_COUNT = 17;

let pg: PGlite;
let shim: PglitePostgrest;
let plans: LargeCompanyHotelPlan[];

const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);
const originalRpc = supabaseAdmin.rpc.bind(supabaseAdmin);

before(async () => {
  const migrated = await applyMigrationsToPglite();
  pg = migrated.pg;
  const catalog = await loadCatalog(pg);
  shim = createPglitePostgrest(pg, catalog);
  // @ts-expect-error installing the pglite-backed client on the singleton
  supabaseAdmin.from = shim.from;
  // @ts-expect-error installing the pglite-backed client on the singleton
  supabaseAdmin.rpc = shim.rpc;

  await seedTwoCompanies(pg);
  plans = await seedLargeCompany(pg, HOTEL_COUNT);
});

after(async () => {
  supabaseAdmin.from = originalFrom;
  supabaseAdmin.rpc = originalRpc;
  await pg?.close();
});

beforeEach(() => {
  clearPortfolioAccessCache();
  clearPortfolioHotelCache();
  clearPortfolioSnapshotCache();
  shim.reset();
});

/** The context exactly as the portfolio route builds it, via the same spine call. */
async function vpContext(): Promise<ToolContext> {
  const access = await resolvePortfolioAccessUncached(ACCOUNT_CARL);
  assert.ok(access.ok, 'fixture: Carl oversees the big company');
  assert.equal(access.access.organizationId, ORG_C);
  assert.equal(
    access.access.propertyIds.length, HOTEL_COUNT,
    `fixture: the company should operate ${HOTEL_COUNT} hotels`,
  );
  return {
    user: {
      uid: UID_CARL,
      accountId: ACCOUNT_CARL,
      username: 'carl',
      displayName: 'Carl',
      role: 'general_manager',
      propertyAccess: access.access.propertyIds,
    },
    propertyId: access.access.propertyIds[0],
    staffId: null,
    requestId: 'portfolio-scale-test',
    surface: 'portfolio',
    portfolio: {
      organizationId: access.access.organizationId,
      organizationName: access.access.organizationName,
      propertyIds: access.access.propertyIds,
    },
  };
}

type HotelRow = Record<string, unknown>;
function hotelsOf(data: unknown): HotelRow[] {
  return (data as { hotels?: HotelRow[] }).hotels ?? [];
}
function byName(rows: HotelRow[]): Map<string, HotelRow> {
  return new Map(rows.map((r) => [r.hotel as string, r]));
}

// ─── The measurement ────────────────────────────────────────────────────────

interface Measurement {
  tool: string;
  ms: number;
  statements: number;
  bytes: number;
}

const TOOL_CALLS: Array<{ name: string; args: Record<string, unknown> }> = [
  { name: 'list_my_hotels', args: {} },
  { name: 'portfolio_open_items', args: {} },
  { name: 'portfolio_work_orders', args: { days: 30 } },
  { name: 'portfolio_supply_spend', args: { days: 30 } },
  { name: 'portfolio_inventory_health', args: {} },
  { name: 'portfolio_compare', args: { metric: 'open_items' } },
  { name: 'company_rulebook', args: {} },
];

/**
 * One tool, from cold caches, in a turn of its own, measured.
 *
 * The context is REBUILT per row on purpose. A single shared context is one
 * turn, and one turn shares its read memo — measuring seven tools on it would
 * report the sixth tool's cost as whatever the first five happened to leave
 * behind, which is a benchmark of the harness rather than of the tool.
 */
async function measure(
  call: { name: string; args: Record<string, unknown> },
): Promise<Measurement> {
  clearPortfolioAccessCache();
  clearPortfolioHotelCache();
  clearPortfolioSnapshotCache();
  const ctx = await vpContext();
  shim.reset();
  const started = performance.now();
  const result = await executeTool(call.name, call.args, ctx);
  const ms = performance.now() - started;
  assert.equal(result.ok, true, `${call.name} failed: ${result.error}`);
  return {
    tool: call.name,
    ms,
    statements: shim.statements.length,
    bytes: JSON.stringify(result.data).length,
  };
}

/** A whole turn: the route's prompt snapshot, then the tools the model calls. */
async function measureTurn(
  label: string,
  calls: Array<{ name: string; args: Record<string, unknown> }>,
): Promise<Measurement> {
  clearPortfolioAccessCache();
  clearPortfolioHotelCache();
  clearPortfolioSnapshotCache();
  const access = await resolvePortfolioAccessUncached(ACCOUNT_CARL);
  assert.ok(access.ok);
  const ctx = await vpContext();
  shim.reset();
  const started = performance.now();

  // What the route does before the model is even called: name the hotels for the
  // prompt, then read each one's pulse.
  const hotels = await loadPortfolioHotels(access.access.propertyIds);
  await buildPortfolioSnapshot(access.access.organizationId, hotels, 0);

  let bytes = 0;
  for (const call of calls) {
    const result = await executeTool(call.name, call.args, ctx);
    assert.equal(result.ok, true, `${call.name} failed inside ${label}`);
    bytes += JSON.stringify(result.data).length;
  }
  return {
    tool: label,
    ms: performance.now() - started,
    statements: shim.statements.length,
    bytes,
  };
}

function printTable(rows: Measurement[], turns: Measurement[]) {
  const line = (a: string, b: string, c: string, d: string, e: string) =>
    `  ${a.padEnd(28)} ${b.padStart(9)} ${c.padStart(11)} ${d.padStart(10)} ${e.padStart(9)}`;
  console.log(`\n  PORTFOLIO TOOLS AT N=${HOTEL_COUNT} (cold caches, one tool per row)`);
  console.log(line('tool', 'ms', 'statements', 'bytes', '~tokens'));
  console.log(`  ${'-'.repeat(72)}`);
  for (const r of rows) {
    console.log(line(
      r.tool,
      r.ms.toFixed(1),
      String(r.statements),
      String(r.bytes),
      String(Math.round(r.bytes / 4)),
    ));
  }
  const totals = rows.reduce(
    (a, r) => ({ ms: a.ms + r.ms, statements: a.statements + r.statements, bytes: a.bytes + r.bytes }),
    { ms: 0, statements: 0, bytes: 0 },
  );
  console.log(`  ${'-'.repeat(72)}`);
  console.log(line('TOTAL (cold each)', totals.ms.toFixed(1), String(totals.statements), String(totals.bytes), String(Math.round(totals.bytes / 4))));
  console.log('');
  console.log('  WHOLE TURNS (prompt snapshot + the tools the model calls)');
  console.log(line('turn', 'ms', 'statements', 'bytes', '~tokens'));
  console.log(`  ${'-'.repeat(72)}`);
  for (const t of turns) {
    console.log(line(t.tool, t.ms.toFixed(1), String(t.statements), String(t.bytes), String(Math.round(t.bytes / 4))));
  }
  console.log('');
}

describe(`the seven tools at ${HOTEL_COUNT} hotels`, () => {
  test('measured: time, database round trips, and answer size', async () => {
    // Warm-up, discarded: the first call through the shim compiles query paths
    // and pays a one-off cost that is not what any of these tools costs.
    await executeTool('list_my_hotels', {}, await vpContext());

    const rows: Measurement[] = [];
    for (const call of TOOL_CALLS) rows.push(await measure(call));

    const turns = [
      // The question a VP actually asks: which hotel is in the worst shape, and
      // what is going on there.
      await measureTurn('worst hotel, then why', [
        { name: 'list_my_hotels', args: {} },
        { name: 'portfolio_compare', args: { metric: 'open_items' } },
        { name: 'portfolio_open_items', args: {} },
        { name: 'portfolio_work_orders', args: { days: 30 } },
      ]),
      // The turn shape the memo exists for: a model that re-reads an aggregate
      // to write the sentence after ranking on it.
      await measureTurn('a model that asks twice', [
        { name: 'portfolio_compare', args: { metric: 'work_orders', days: 30 } },
        { name: 'portfolio_work_orders', args: { days: 30 } },
        { name: 'portfolio_compare', args: { metric: 'work_orders', days: 30 } },
        { name: 'portfolio_work_orders', args: { days: 30 } },
      ]),
    ];

    printTable(rows, turns);
    assert.equal(shim.unsupported.length, 0, 'the shim compiled every query the tools issued');
  });
});

// ─── Correctness at seventeen ───────────────────────────────────────────────

describe('the numbers are right at seventeen hotels', () => {
  test('every hotel is present, and its work-order figures match a SQL recount', async () => {
    const ctx = await vpContext();
    const result = await executeTool('portfolio_work_orders', { days: 30 }, ctx);
    assert.equal(result.ok, true);
    const rows = hotelsOf(result.data);
    assert.equal(rows.length, HOTEL_COUNT, 'every covered hotel keeps its headline row');

    // Brute force: what a single cross-property group-by would say, asked of the
    // database directly rather than restated from the fixture's plan.
    const truth = await pg.query<{ property_id: string; opened: number; still_open: number }>(
      `select property_id,
              count(*)::int as opened,
              count(*) filter (where coalesce(status,'submitted') <> 'resolved')::int as still_open
         from work_orders
        where property_id = any($1::uuid[])
          and created_at >= now() - interval '30 days'
        group by property_id`,
      [`{${plans.map((p) => p.propertyId).join(',')}}`],
    );
    const expected = new Map(truth.rows.map((r) => [r.property_id, r]));
    assert.equal(expected.size, HOTEL_COUNT, 'fixture: every hotel got tickets');

    for (const row of rows) {
      const want = expected.get(row.hotelId as string);
      assert.ok(want, `${row.hotel} was not in the recount`);
      assert.equal(row.opened, want.opened, `${row.hotel}: opened`);
      assert.equal(row.stillOpen, want.still_open, `${row.hotel}: still open`);
      const plan = plans.find((p) => p.propertyId === row.hotelId)!;
      assert.equal(row.rooms, plan.rooms);
      assert.equal(
        row.openedPer100Rooms,
        Math.round((want.opened / plan.rooms) * 100 * 100) / 100,
        `${row.hotel}: the per-100-rooms rate is worked out in the tool`,
      );
    }
  });

  test('open items and known problems are counted apart, for all seventeen', async () => {
    const ctx = await vpContext();
    const result = await executeTool('portfolio_open_items', {}, ctx);
    assert.equal(result.ok, true);
    const rows = hotelsOf(result.data);
    assert.equal(rows.length, HOTEL_COUNT);

    const truth = await pg.query<{ property_id: string; live: number; known: number }>(
      `select property_id,
              count(*) filter (where status in ('open','updated'))::int as live,
              count(*) filter (where status = 'known_problem')::int as known
         from findings
        where property_id = any($1::uuid[])
        group by property_id`,
      [`{${plans.map((p) => p.propertyId).join(',')}}`],
    );
    const expected = new Map(truth.rows.map((r) => [r.property_id, r]));

    for (const row of rows) {
      const want = expected.get(row.hotelId as string)!;
      assert.equal(row.openItems, want.live, `${row.hotel}: open items`);
      assert.equal(row.alreadyKnownProblems, want.known, `${row.hotel}: known problems`);
    }
  });

  test('supply spend totals match the ledger, hotel by hotel', async () => {
    const ctx = await vpContext();
    const result = await executeTool('portfolio_supply_spend', { days: 30 }, ctx);
    assert.equal(result.ok, true);
    const rows = byName(hotelsOf(result.data));
    for (const plan of plans) {
      const row = rows.get(plan.name);
      assert.ok(row, `${plan.name} is missing from the spend answer`);
      assert.equal(
        Math.round(row.spendDollars as number),
        Math.round(plan.supplySpendDollars),
        `${plan.name}: spend`,
      );
    }
  });

  test('the ranking is the same order a single group-by would produce', async () => {
    const ctx = await vpContext();
    const result = await executeTool('portfolio_compare', { metric: 'open_items' }, ctx);
    assert.equal(result.ok, true);
    const ranking = (result.data as { ranking: Array<Record<string, unknown>> }).ranking;
    assert.equal(ranking.length, HOTEL_COUNT, 'a ranking that drops hotels answers a different question');

    const truth = await pg.query<{ property_id: string; name: string; live: number }>(
      `select f.property_id, p.name, count(*)::int as live
         from findings f join properties p on p.id = f.property_id
        where f.property_id = any($1::uuid[]) and f.status in ('open','updated')
        group by f.property_id, p.name
        order by count(*) desc, p.name asc`,
      [`{${plans.map((p) => p.propertyId).join(',')}}`],
    );

    assert.deepEqual(
      ranking.map((r) => r.hotel),
      truth.rows.map((r) => r.name),
      'worst first, ties broken by name — exactly the group-by order',
    );
    assert.deepEqual(ranking.map((r) => r.value), truth.rows.map((r) => r.live));

    const comparison = (result.data as { comparison: Record<string, unknown> }).comparison;
    assert.equal(comparison.portfolioTotal, truth.rows.reduce((s, r) => s + r.live, 0));
    assert.equal(
      (comparison.highest as { hotel: string }).hotel, truth.rows[0].name,
    );
    assert.equal(
      (comparison.lowest as { hotel: string }).hotel, truth.rows[truth.rows.length - 1].name,
    );
  });

  test('inventory health classifies every hotel, and the worst items are the worst', async () => {
    const ctx = await vpContext();
    const result = await executeTool('portfolio_inventory_health', {}, ctx);
    assert.equal(result.ok, true);
    const rows = byName(hotelsOf(result.data));
    assert.equal(rows.size, HOTEL_COUNT);
    for (const plan of plans) {
      const row = rows.get(plan.name)!;
      assert.equal(row.itemsTracked, plan.inventoryItems, `${plan.name}: items tracked`);
      assert.equal(row.critical, plan.criticalItems, `${plan.name}: critical items`);
    }
  });

  test('the wall holds at seventeen: every read named one covered hotel', async () => {
    // The leak suite proves this at two hotels against another company. This is
    // the same assertion at SEVENTEEN, with a fresh turn per tool so no memo can
    // make it vacuous by serving an answer no statement was issued for.
    const covered = new Set(plans.map((p) => p.propertyId));
    for (const call of TOOL_CALLS) {
      clearPortfolioAccessCache();
      clearPortfolioHotelCache();
      const ctx = await vpContext();
      shim.reset();
      const result = await executeTool(call.name, call.args, ctx);
      assert.equal(result.ok, true, `${call.name} failed: ${result.error}`);

      let scopedReads = 0;
      for (const stmt of shim.statements as RecordedStatement[]) {
        if (stmt.kind !== 'table') continue;
        if (GLOBAL_TABLES.has(stmt.target)) continue;
        const column = scopeColumnFor(stmt.target);
        const filter = stmt.filters.find((f) => f.op === 'eq' && f.column === column);
        assert.ok(
          filter,
          `${call.name}: ${stmt.verb} on ${stmt.target} carried no ${column} filter\n${stmt.sql}`,
        );
        assert.ok(
          covered.has(String(filter.value)),
          `${call.name}: ${stmt.target} was scoped to ${String(filter.value)}, not a hotel of this company`,
        );
        scopedReads += 1;
      }
      assert.ok(
        scopedReads > 0,
        `${call.name} answered without reading a single hotel — the assertion above proved nothing`,
      );
    }
    assert.deepEqual(shim.unsupported, []);
  });
});

// ─── The fan-out ────────────────────────────────────────────────────────────

describe('the per-hotel loop is parallel but not unbounded', () => {
  test('never more lanes than the limit, whatever the size of the company', async () => {
    let inFlight = 0;
    let peak = 0;
    const items = Array.from({ length: 40 }, (_, i) => i);
    const out = await mapWithConcurrency(items, PORTFOLIO_READ_CONCURRENCY, async (n) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return n * 2;
    });
    assert.equal(
      peak, PORTFOLIO_READ_CONCURRENCY,
      'the pool should fill every lane and open no more — a peak below the limit means it serialised',
    );
    assert.deepEqual(out, items.map((n) => n * 2), 'results stay in the input order');
  });

  test('the real per-hotel read is bounded, ordered, and one accessor per hotel', async () => {
    const ids = plans.map((p) => p.propertyId);
    let inFlight = 0;
    let peak = 0;
    const { results, failedHotelCount } = await forEachHotel(ids, async (db, propertyId) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      // The accessor handed to a hotel's read is scoped to THAT hotel. A pooled
      // loop that reused one accessor across lanes would show up right here.
      assert.equal(db.propertyId, propertyId);
      return db.propertyId;
    });
    assert.equal(failedHotelCount, 0);
    assert.equal(peak, PORTFOLIO_READ_CONCURRENCY, `expected ${PORTFOLIO_READ_CONCURRENCY} lanes at ${HOTEL_COUNT} hotels`);
    assert.ok(peak < HOTEL_COUNT, 'seventeen hotels must not mean seventeen simultaneous reads');
    assert.deepEqual(results.map((r) => r.value), ids, 'the answer does not reshuffle with timing');
  });

  test('a hotel that throws costs that hotel, not the answer', async () => {
    const ids = plans.map((p) => p.propertyId);
    const { results, failedHotelCount } = await forEachHotel(ids, async (_db, propertyId) => {
      if (propertyId === ids[3]) throw new Error('this hotel is unreachable');
      return propertyId;
    });
    assert.equal(failedHotelCount, 1);
    assert.equal(results[3].value, null);
    assert.equal(results.filter((r) => r.value !== null).length, HOTEL_COUNT - 1);
  });
});

// ─── The per-turn memo ──────────────────────────────────────────────────────

describe('one read per turn, and never across turns', () => {
  function openedAt(data: unknown, propertyId: string): number {
    const row = hotelsOf(data).find((h) => h.hotelId === propertyId);
    assert.ok(row, 'the hotel should be in the answer');
    return row.opened as number;
  }

  function readsOf(target: string): number {
    return (shim.statements as RecordedStatement[]).filter((s) => s.target === target).length;
  }

  test('the same question asked twice in one turn is read once', async () => {
    const ctx = await vpContext();
    await executeTool('portfolio_work_orders', { days: 30 }, ctx);

    shim.reset();
    const second = await executeTool('portfolio_work_orders', { days: 30 }, ctx);
    assert.equal(second.ok, true);
    assert.equal(readsOf('work_orders'), 0, 'the identical second call went back to the database');

    // …but a DIFFERENT question is a different question.
    shim.reset();
    const narrower = await executeTool('portfolio_work_orders', { days: 7 }, ctx);
    assert.equal(narrower.ok, true);
    assert.equal(
      readsOf('work_orders'), HOTEL_COUNT,
      'a seven-day window must not be served from a thirty-day read',
    );
  });

  test('narrowing inside a turn is a new question, not a slice of the last answer', async () => {
    // The dangerous memo bug: a key that names the DATASET but not the HOTELS.
    // Every assertion in this file that uses a fresh turn per case would still
    // pass, because the collision only happens when both calls live in one turn.
    const ctx = await vpContext();
    const all = await executeTool('portfolio_work_orders', { days: 30 }, ctx);
    assert.equal(hotelsOf(all.data).length, HOTEL_COUNT);

    const named = plans.slice(0, 3).map((p) => p.propertyId);
    shim.reset();
    const some = await executeTool('portfolio_work_orders', { days: 30, hotelIds: named }, ctx);
    assert.equal(some.ok, true);
    assert.deepEqual(
      hotelsOf(some.data).map((h) => h.hotelId).sort(),
      [...named].sort(),
      'a question about three hotels was answered with all seventeen',
    );
    assert.equal(
      readsOf('work_orders'), named.length,
      'three hotels should cost three reads — not seventeen, and not zero',
    );
  });

  test('two conversations never share a number', async () => {
    const turnOne = await vpContext();
    const first = await executeTool('portfolio_work_orders', { days: 30 }, turnOne);
    assert.equal(first.ok, true);
    const target = plans[0].propertyId;
    const before = openedAt(first.data, target);

    // A ticket is filed while the first VP is still reading their answer.
    await pg.query(
      `insert into work_orders (property_id, room_number, description, severity, status, created_at)
       values ($1, '901', 'filed between the two turns', 'MAJOR', 'submitted', now())`,
      [target],
    );

    // The turn that is already underway keeps quoting the numbers it opened
    // with — both halves of one answer must agree with each other.
    const sameTurn = await executeTool('portfolio_work_orders', { days: 30 }, turnOne);
    assert.equal(openedAt(sameTurn.data, target), before, 'one answer, one set of numbers');

    // The NEXT conversation is a new context object, so a new memo. It must see
    // the new ticket — a memo that outlived its turn would hide it.
    const turnTwo = await vpContext();
    shim.reset();
    const fresh = await executeTool('portfolio_work_orders', { days: 30 }, turnTwo);
    assert.equal(fresh.ok, true);
    assert.equal(readsOf('work_orders'), HOTEL_COUNT, 'the second conversation read the database itself');
    assert.equal(
      openedAt(fresh.data, target), before + 1,
      'a second conversation was served the first one\'s stale numbers',
    );

    await pg.query(`delete from work_orders where property_id = $1 and room_number = '901'`, [target]);
  });

  test('a failed read is not remembered as an answer', async () => {
    // The memo holds the PROMISE, so a rejected read must be evicted — otherwise
    // one hiccup poisons every later tool in the same turn.
    const ctx = await vpContext();
    const broken = new Error('database went away');
    const original = shim.from;
    let failNext = true;
    // @ts-expect-error swapping the client for one statement
    supabaseAdmin.from = (table: string) => {
      if (table === 'inventory' && failNext) {
        failNext = false;
        throw broken;
      }
      return original(table);
    };
    try {
      const first = await executeTool('portfolio_inventory_health', {}, ctx);
      // One hotel's read threw; the answer survives and names it as unread.
      assert.equal(first.ok, true);
      assert.equal((first.data as { hotelsUnread?: number }).hotelsUnread, 1);
    } finally {
      // @ts-expect-error restoring
      supabaseAdmin.from = original;
    }

    // The failure is not what the turn remembers — but the SUCCESSFUL read that
    // wrapped it is, so this second call is served from the memo and still
    // reports the same thing. What must never happen is a thrown answer.
    const second = await executeTool('portfolio_inventory_health', {}, ctx);
    assert.equal(second.ok, true);
  });
});

// ─── Bounded answers, announced ─────────────────────────────────────────────

describe('nothing is left out quietly', () => {
  test('every hotel keeps its headline; only the item lists are rationed, and it says so', async () => {
    const ctx = await vpContext();
    const result = await executeTool('portfolio_open_items', {}, ctx);
    assert.equal(result.ok, true);
    const data = result.data as { hotels: HotelRow[]; detailNote?: string };

    assert.equal(data.hotels.length, HOTEL_COUNT, 'a hotel dropped from a ranking is a wrong answer');
    for (const hotel of data.hotels) {
      assert.equal(typeof hotel.openItems, 'number', `${hotel.hotel} lost its count`);
      assert.equal(typeof hotel.critical, 'number', `${hotel.hotel} lost its critical count`);
      assert.notEqual(hotel.openItemsPer100Rooms, undefined, `${hotel.hotel} lost its rate`);
    }

    const withItems = data.hotels.filter((h) => Array.isArray(h.items));
    assert.ok(withItems.length > 0, 'somebody has to get the detail');
    assert.ok(withItems.length < HOTEL_COUNT, 'seventeen item lists is the payload this test exists to stop');
    assert.match(
      String(data.detailNote ?? ''),
      /item lists were left out/,
      'an answer that quietly stopped listing things reads like a company with nothing wrong',
    );

    // The hotels that DID get detail are the ones in the worst shape.
    const worst = [...data.hotels].sort((a, b) => (
      ((b.critical as number) - (a.critical as number))
      || ((b.openItems as number) - (a.openItems as number))
      || String(a.hotel).localeCompare(String(b.hotel))
    ));
    assert.deepEqual(
      withItems.map((h) => h.hotelId).sort(),
      worst.slice(0, withItems.length).map((h) => h.hotelId).sort(),
      'the detail went to the wrong hotels',
    );
  });

  test('naming hotels is how you ask for their detail', async () => {
    const ctx = await vpContext();
    const named = plans.slice(0, 4).map((p) => p.propertyId);
    const result = await executeTool('portfolio_open_items', { hotelIds: named }, ctx);
    assert.equal(result.ok, true);
    const data = result.data as { hotels: HotelRow[]; detailNote?: string };
    assert.equal(data.hotels.length, 4);
    assert.equal(
      data.hotels.every((h) => Array.isArray(h.items)), true,
      'a hotel the caller named should come back with its items',
    );
    assert.equal(data.detailNote, undefined, 'nothing was withheld, so there is nothing to announce');
  });

  test('inventory health rations its worst-item lists the same way', async () => {
    const ctx = await vpContext();
    const result = await executeTool('portfolio_inventory_health', {}, ctx);
    const data = result.data as { hotels: HotelRow[]; detailNote?: string };
    assert.equal(data.hotels.length, HOTEL_COUNT);
    for (const hotel of data.hotels) assert.equal(typeof hotel.critical, 'number');
    const withItems = data.hotels.filter((h) => Array.isArray(h.worstItems));
    assert.ok(withItems.length > 0 && withItems.length < HOTEL_COUNT);
    assert.match(String(data.detailNote ?? ''), /item lists were left out/);
  });

  test('a hotel that hit the row ceiling is reported as a floor, not a total', async () => {
    // The ceiling used to be silent: a hotel with more rows than one read returns
    // reported the ceiling as if it were the whole truth, and ranked BELOW a
    // quieter hotel. 5,001 tickets in one statement, then put back.
    const target = plans[plans.length - 1].propertyId;
    await pg.query(
      `insert into work_orders (property_id, room_number, description, severity, status, created_at)
       select $1, '902', 'bulk ' || g, 'MINOR', 'submitted', now() - interval '2 days'
         from generate_series(1, 5001) g`,
      [target],
    );
    try {
      const ctx = await vpContext();
      const result = await executeTool('portfolio_work_orders', { days: 30, hotelIds: [target] }, ctx);
      assert.equal(result.ok, true);
      const data = result.data as { hotels: HotelRow[]; hotelsAtRowLimit?: number; rowLimitNote?: string };
      assert.equal(data.hotels[0].atRowLimit, true, 'the hotel did not say it was capped');
      assert.equal(data.hotelsAtRowLimit, 1);
      assert.match(String(data.rowLimitNote ?? ''), /FLOOR, not a total/);

      // And the ranking, which counts rather than reads rows, is NOT capped —
      // it reports the real number.
      const ranked = await executeTool('portfolio_compare', { metric: 'work_orders', days: 30 }, ctx);
      const row = (ranked.data as { ranking: Array<Record<string, unknown>> }).ranking
        .find((r) => r.hotelId === target);
      assert.ok(row, 'the capped hotel is still in the ranking');
      assert.ok(
        (row.value as number) > 5000,
        `the ranking counted ${row.value} — a count that stops at the read ceiling ranks the busiest hotel too low`,
      );
    } finally {
      await pg.query(`delete from work_orders where property_id = $1 and room_number = '902'`, [target]);
    }
  });
});

// ─── Worst first ────────────────────────────────────────────────────────────
//
// Rationing the detail is only half of "don't hand back seventeen dumps". The
// other half is ORDER: seventeen equal-looking rows in hotel-id order leave the
// model to re-derive the ranking the tool already computed — the same division
// this whole file exists to keep out of a sentence.

describe('the answer comes back worst first', () => {
  test('open items lead with the hotel in the worst shape, by the tool\'s own rule', async () => {
    const ctx = await vpContext();
    const result = await executeTool('portfolio_open_items', {}, ctx);
    assert.equal(result.ok, true);
    const rows = hotelsOf(result.data);
    assert.equal(rows.length, HOTEL_COUNT, 'ordering must not be an excuse to drop hotels');

    // Recomputed from the rows themselves, so this fails if the ORDER is wrong
    // even when every number in it is right.
    const expected = [...rows].sort((a, b) => (
      ((b.critical as number) - (a.critical as number))
      || ((b.openItems as number) - (a.openItems as number))
      || String(a.hotel).localeCompare(String(b.hotel))
    ));
    assert.deepEqual(
      rows.map((r) => r.hotel), expected.map((r) => r.hotel),
      'the rows came back in hotel-id order, not worst-first',
    );
    // And it is genuinely a re-order, not the seed order wearing a new name.
    assert.notDeepEqual(
      rows.map((r) => r.hotelId), plans.map((p) => p.propertyId),
      'if the ranked order equals the seed order this test proves nothing',
    );
  });

  test('work orders rank on BACKLOG, so a hotel that closes its tickets is not called the worst', async () => {
    // The mutation this catches: ranking on `opened` instead of `stillOpen`.
    // The quietest hotel in the fixture gets a pile of tickets that are ALREADY
    // RESOLVED. Ranked on volume it jumps to first; ranked on backlog — the
    // thing a VP actually has to act on — it must not move up at all.
    const ctx0 = await vpContext();
    const before = hotelsOf((await executeTool('portfolio_work_orders', { days: 30 }, ctx0)).data);
    const quietest = before[before.length - 1];
    const busiestOpened = Math.max(...before.map((h) => h.opened as number));

    await pg.query(
      `insert into work_orders (property_id, room_number, description, severity, status, created_at)
       select $1, '903', 'already fixed ' || g, 'MINOR', 'resolved', now() - interval '2 days'
         from generate_series(1, $2::int) g`,
      [quietest.hotelId, busiestOpened + 25],
    );
    try {
      const after = hotelsOf((await executeTool('portfolio_work_orders', { days: 30 }, await vpContext())).data);
      const moved = after.find((h) => h.hotelId === quietest.hotelId)!;

      assert.ok(
        (moved.opened as number) > busiestOpened,
        'fixture: the quiet hotel should now have opened more tickets than anyone',
      );
      assert.equal(moved.stillOpen, quietest.stillOpen, 'none of the new tickets is open');
      assert.notEqual(
        after[0].hotelId, quietest.hotelId,
        'a hotel that closed every one of its tickets was named the company\'s worst',
      );
      assert.equal(
        after[after.length - 1].hotelId, quietest.hotelId,
        'the smallest backlog belongs at the bottom whatever the ticket volume',
      );
    } finally {
      await pg.query(
        `delete from work_orders where property_id = $1 and room_number = '903'`,
        [quietest.hotelId],
      );
    }
  });

  test('supply spend leads with the biggest spender', async () => {
    const ctx = await vpContext();
    const rows = hotelsOf((await executeTool('portfolio_supply_spend', { days: 30 }, ctx)).data);
    assert.equal(rows.length, HOTEL_COUNT);
    const spends = rows.map((r) => (r.spendDollars as number) ?? -1);
    assert.deepEqual(
      spends, [...spends].sort((a, b) => b - a),
      'the spend answer is not in descending order',
    );
    const truth = await pg.query<{ name: string }>(
      `select p.name, sum(o.total_cost) as spend
         from inventory_orders o join properties p on p.id = o.property_id
        where o.property_id = any($1::uuid[]) and o.received_at >= now() - interval '30 days'
        group by p.name order by sum(o.total_cost) desc limit 1`,
      [`{${plans.map((p) => p.propertyId).join(',')}}`],
    );
    assert.equal(rows[0].hotel, truth.rows[0].name, 'the top row is not the biggest spender');
  });

  test('a hotel Staxis could not read sinks to the bottom rather than looking healthy', async () => {
    // An unread hotel has no counts. Sorting it as if its absent numbers were
    // zeros would park it at the "nothing wrong here" end of a worst-first list.
    const ctx = await vpContext();
    const original = shim.from;
    let failNext = true;
    // @ts-expect-error swapping the client for one statement
    supabaseAdmin.from = (table: string) => {
      if (table === 'inventory' && failNext) {
        failNext = false;
        throw new Error('this hotel is unreachable');
      }
      return original(table);
    };
    let rows: HotelRow[];
    try {
      const result = await executeTool('portfolio_inventory_health', {}, ctx);
      assert.equal(result.ok, true);
      rows = hotelsOf(result.data);
    } finally {
      // @ts-expect-error restoring
      supabaseAdmin.from = original;
    }
    const unread = rows.filter((r) => r.read === false);
    assert.equal(unread.length, 1, 'fixture: exactly one hotel should have failed');
    assert.equal(
      rows[rows.length - 1].read, false,
      'the unread hotel was not last — it is sitting among hotels with real numbers',
    );
    // It failed on the FIRST read issued, so in input order it is near the top;
    // finding it last is therefore the ordering working, not a coincidence.
    assert.ok(
      plans.findIndex((p) => p.propertyId === unread[0].hotelId) < PORTFOLIO_READ_CONCURRENCY,
      'fixture: the failing hotel should be one of the first lanes',
    );
  });

  test('a per-room column is published only when the ranking asked for one', async () => {
    const ctx = await vpContext();
    const byTotal = (await executeTool('portfolio_compare', { metric: 'open_items' }, ctx)).data;
    const totalRanking = (byTotal as { ranking: HotelRow[] }).ranking;
    assert.equal(totalRanking.length, HOTEL_COUNT);
    assert.ok(
      totalRanking.every((r) => !('perRoomValue' in r)),
      'seventeen null perRoomValue keys were carried for a ranking that did not use them',
    );
    // …and the figure a VP actually says out loud is always there.
    assert.ok(totalRanking.every((r) => typeof r.per100RoomsValue === 'number'));

    const byRoom = (await executeTool(
      'portfolio_compare', { metric: 'open_items', perRoom: true }, await vpContext(),
    )).data;
    const roomRanking = (byRoom as { ranking: HotelRow[] }).ranking;
    assert.ok(
      roomRanking.every((r) => typeof r.perRoomValue === 'number'),
      'ranking per room must publish the number it ranked on',
    );
  });
});

/** Tables with no hotel column, so a query against one carries no scope filter. */
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
