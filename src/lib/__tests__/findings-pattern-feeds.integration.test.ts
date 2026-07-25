/**
 * PROOF, not assertion: the Phase-2A feeds read columns that actually exist,
 * carry the hotel filter on every statement, and drive the real detectors to
 * the right verdicts — with a REAL Postgres deciding.
 *
 * WHY THIS CANNOT BE A UNIT TEST
 * The detectors themselves are pure and are proven in
 * findings-pattern-detectors.test.ts. What CANNOT be proven with a fake is the
 * half that has bitten this codebase three times in a month: selecting a column
 * that does not exist. PostgREST answers that with a 200 and an empty array,
 * the loader reports "this hotel has no history", the detector honestly stays
 * silent, and the feature is dead without a single error anywhere. A hand-made
 * fake would answer `inventory_orders.recieved_at` just as happily as the real
 * spelling.
 *
 * So: production migrations applied to PGlite, the PostgREST shim compiling the
 * real query builder into real SQL, the real loaders and the real runner
 * against two seeded hotels — hotel B's rows deliberately reachable, planted at
 * three times hotel A's volume with `ZZLEAKB` on every free-text column, so a
 * forgotten filter would not merely leak, it would visibly change hotel A's
 * numbers and flip its verdicts.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-min-20-chars';
process.env.CRON_SECRET ??= 'placeholder-cron-secret-min-16';
process.env.ANTHROPIC_API_KEY ??= 'sk-ant-placeholder';

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { PGlite } from '@electric-sql/pglite';

import { supabaseAdmin } from '@/lib/supabase-admin';
import { addDaysInTz, propertyLocalToday } from '@/lib/schedule/local-date';
import { loadFeeds, resolveLoadEnv } from '@/lib/findings/feeds';
import { runFindingsForProperty } from '@/lib/findings/runner';
import { listFindings } from '@/lib/findings/store';
import { isFeedFailure } from '@/lib/findings/types';
import type { FeedOutcome, FeedResult } from '@/lib/findings/types';
import type {
  InventoryUsageHistory,
  OperatingRhythmHistory,
  SupplySpendHistory,
  WorkOrderHistory,
} from '@/lib/findings/history';

import { applyMigrationsToPglite } from '../../../tests/fixtures/pglite-migrate';
import {
  createPglitePostgrest,
  loadCatalog,
  type Catalog,
  type PglitePostgrest,
} from '../../../tests/fixtures/postgrest-pglite';
import { seedTwoHotels, LEAK_MARKER, PID_A, PID_B } from '../../../tests/fixtures/pglite-two-hotel-seed';

const TZ = 'America/Chicago';
const LEAK_NEEDLES = ['bbbbbbbb-', LEAK_MARKER, PID_B];

function leaksIn(value: unknown): string[] {
  const text = JSON.stringify(value ?? null) ?? '';
  return LEAK_NEEDLES.filter((needle) => text.includes(needle));
}

/** Noon Chicago, so the UTC instant and the hotel-local date never disagree. */
function atNoon(date: string): string {
  return `${date}T18:00:00.000Z`;
}

const ITEM_A = 'aaaaaaaa-1111-4000-8000-000000000001';
const ITEM_B = 'bbbbbbbb-1111-4000-8000-000000000001';

let pg: PGlite;
let catalog: Catalog;
let shim: PglitePostgrest;
let businessDate: string;

/** businessDate - n, as the hotel's own calendar reckons it. */
function ago(days: number): string {
  return addDaysInTz(businessDate, -days);
}

/**
 * One hotel's planted history.
 *
 *  supply spend  — twelve steady ~$900 weeks, then a $2,300 blowout.
 *  counts        — one item counted every 3 days, twelve times, the last of
 *                  them 9 days ago; the final stretch burns stock 4x faster.
 *  work orders   — weekly for ten weeks, then nothing for 30 days.
 *  daily logs    — every day right up to yesterday: the stream that is FINE.
 *
 * Hotel B gets the same shapes at three times the volume on different days, so
 * a missing hotel filter changes hotel A's arithmetic rather than merely
 * appending rows nobody looks at.
 */
async function plant(propertyId: string, itemId: string, scale: number, marker: string) {
  await pg.query(
    `insert into inventory (id, property_id, name, category, current_stock, par_level, unit, unit_cost)
     values ($1, $2, $3, 'housekeeping', 0, 200, 'each', 4.50)`,
    [itemId, propertyId, `${marker}Bath towels`],
  );

  // ── supply spend: one delivery at the start of each of 13 weeks ──────────
  for (let week = 0; week <= 12; week += 1) {
    const start = ago(1 + 7 * week + 6);
    const dollars = week === 0 ? 2300 * scale : (900 + (week % 3) * 50) * scale;
    await pg.query(
      `insert into inventory_orders (property_id, item_id, item_name, quantity, unit_cost,
                                     total_cost, received_at, entry_kind)
       values ($1, $2, $3, 1, null, $4, $5, 'receipt')`,
      [propertyId, itemId, `${marker}Supplies`, dollars, atNoon(start)],
    );
  }

  // ── counts: 12 of them, 3 days apart, the last 9 days ago ───────────────
  // Stock falls 12 a stretch for the first eleven, then 54 in the last one.
  let stock = 1_000;
  for (let i = 11; i >= 0; i -= 1) {
    const date = ago(9 + i * 3);
    await pg.query(
      `insert into inventory_counts (property_id, item_id, item_name, counted_stock,
                                     variance_value, unit_cost, counted_at)
       values ($1, $2, $3, $4, $5, 4.50, $6)`,
      [propertyId, itemId, `${marker}Bath towels`, stock, 44.1 + i, atNoon(date)],
    );
    stock -= i === 1 ? 54 * scale : 12;
  }

  // ── work orders: weekly for ten weeks, silent for the last 30 days ──────
  for (let week = 0; week < 10 * scale; week += 1) {
    await pg.query(
      `insert into work_orders (property_id, room_number, description, severity, status,
                                repair_cost, created_at)
       values ($1, '101', $2, 'medium', 'open', $3, $4)`,
      [propertyId, `${marker}leaky tap`, 32.5 + week * 5, atNoon(ago(30 + week * 7))],
    );
  }

  // ── daily logs: every day up to yesterday. This stream is healthy. ───────
  for (let day = 1; day <= 40; day += 1) {
    await pg.query(
      `insert into daily_logs (property_id, date, rooms_completed) values ($1, $2, $3)`,
      [propertyId, ago(day), 20],
    );
  }
}

async function feedFor<K extends 'supply_spend_history' | 'work_order_history' | 'inventory_usage_history' | 'operating_rhythm'>(
  propertyId: string,
  feed: K,
): Promise<FeedResult<K>> {
  const env = await resolveLoadEnv(propertyId, new Date());
  const loaded = await loadFeeds([feed], env);
  const outcome = loaded[feed] as FeedOutcome;
  assert.ok(outcome, `feed ${feed} did not load at all`);
  assert.ok(
    !isFeedFailure(outcome),
    `feed ${feed} failed: ${isFeedFailure(outcome) ? outcome.error : ''}`,
  );
  return outcome as FeedResult<K>;
}

describe('the pattern feeds, proven against a real database', () => {
  before(async () => {
    const migrated = await applyMigrationsToPglite();
    pg = migrated.pg;
    catalog = await loadCatalog(pg);
    await seedTwoHotels(pg, catalog);
    shim = createPglitePostgrest(pg, catalog);

    // @ts-expect-error installing the pglite-backed client on the singleton
    supabaseAdmin.from = shim.from;
    // @ts-expect-error installing the pglite-backed client on the singleton
    supabaseAdmin.rpc = shim.rpc;

    await pg.query(`update properties set timezone = $1 where id in ($2, $3)`, [TZ, PID_A, PID_B]);
    businessDate = propertyLocalToday(new Date(), TZ);

    // The generic seeder puts one row of everything on BOTH hotels, dated
    // now-ish. Those rows would land in today's window and blur the planted
    // shapes, so the tables under test start empty on both sides and are then
    // planted deliberately.
    await pg.exec(
      `truncate inventory_counts, inventory_orders, inventory_discards, work_orders, daily_logs cascade`,
    );

    await plant(PID_A, ITEM_A, 1, '');
    await plant(PID_B, ITEM_B, 3, LEAK_MARKER);
    shim.reset();
  });

  after(async () => {
    await pg.close().catch(() => undefined);
  });

  // ── the columns are real ─────────────────────────────────────────────────

  describe('every column these feeds select actually exists', () => {
    test('supply spend loads real dollars off inventory_orders', async () => {
      const feed = await feedFor(PID_A, 'supply_spend_history');
      const history = feed.value as SupplySpendHistory;
      assert.equal(
        history.days.length,
        13,
        'a mis-spelled column would come back 200 OK with an empty array and this would be 0',
      );
      assert.ok(history.days.every((d) => d.value > 0));
      assert.equal(
        history.days.find((d) => d.date === ago(7))?.value,
        230_000,
        'dollars must arrive as cents exactly once',
      );
    });

    test('work orders load with their repair costs', async () => {
      const feed = await feedFor(PID_A, 'work_order_history');
      const history = feed.value as WorkOrderHistory;
      assert.equal(history.createdPerDay.length, 10);
      assert.equal(history.repairCostCentsSamples.length, 10);
      assert.ok(history.repairCostCentsSamples.includes(3_250));
    });

    test('usage is computed between the hotel own consecutive counts', async () => {
      const feed = await feedFor(PID_A, 'inventory_usage_history');
      const history = feed.value as InventoryUsageHistory;
      assert.equal(history.items.length, 1);
      const item = history.items[0];
      assert.equal(item.itemId, ITEM_A);
      assert.equal(item.itemName, 'Bath towels', 'the unit and name come from the inventory row');
      assert.equal(item.unit, 'each');
      assert.equal(item.intervals.length, 11, '12 counts make 11 intervals');
      assert.ok(item.intervals.every((i) => i.days >= 1));
      assert.equal(
        Math.round(item.intervals[item.intervals.length - 1].unitsUsed),
        54,
        'the final stretch burned 54, and that is what the arithmetic must recover',
      );
    });

    test('the rhythm feed carries all three streams off three real tables', async () => {
      const feed = await feedFor(PID_A, 'operating_rhythm');
      const history = feed.value as OperatingRhythmHistory;
      assert.deepEqual(
        history.streams.map((s) => s.id),
        ['inventory_counts', 'daily_log_closings', 'work_order_flow'],
      );
      const byId = new Map(history.streams.map((s) => [s.id, s]));
      assert.equal(byId.get('inventory_counts')!.dates.length, 12);
      assert.equal(byId.get('daily_log_closings')!.dates.length, 40);
      assert.equal(byId.get('work_order_flow')!.dates.length, 10);
      assert.ok(
        byId.get('inventory_counts')!.worthCentsSamples.length >= 3,
        'the only stream that can be priced is priced from variance_value',
      );
    });
  });

  // ── the tenant wall ──────────────────────────────────────────────────────

  describe('one hotel never sees another hotel history', () => {
    test('hotel B has a bigger version of every shape, so a leak would be visible', async () => {
      const rows = await pg.query<{ n: number }>(
        `select (select count(*) from inventory_orders where property_id = $1)
              + (select count(*) from inventory_counts where property_id = $1)
              + (select count(*) from work_orders where property_id = $1) as n`,
        [PID_B],
      );
      assert.ok(
        (rows.rows[0]?.n ?? 0) > 40,
        'without hotel-B rows there is nothing to leak and the tests below prove nothing',
      );
    });

    test('no feed carries a trace of hotel B', async () => {
      for (const feed of [
        'supply_spend_history',
        'work_order_history',
        'inventory_usage_history',
        'operating_rhythm',
      ] as const) {
        const loaded = await feedFor(PID_A, feed);
        assert.deepEqual(leaksIn(loaded.value), [], `${feed} leaked hotel B`);
      }
    });

    test("hotel B's larger numbers do not appear in hotel A's arithmetic", async () => {
      const a = (await feedFor(PID_A, 'supply_spend_history')).value as SupplySpendHistory;
      const b = (await feedFor(PID_B, 'supply_spend_history')).value as SupplySpendHistory;
      const totalA = a.days.reduce((sum, d) => sum + d.value, 0);
      const totalB = b.days.reduce((sum, d) => sum + d.value, 0);
      assert.ok(totalB > totalA * 2, 'hotel B was planted at 3x on purpose');
      assert.ok(
        totalA < totalB,
        'if the filter were missing, both hotels would report the same combined total',
      );
    });

    test('every statement the feeds issued carried the hotel filter', async () => {
      shim.reset();
      await feedFor(PID_A, 'supply_spend_history');
      await feedFor(PID_A, 'work_order_history');
      await feedFor(PID_A, 'inventory_usage_history');
      await feedFor(PID_A, 'operating_rhythm');

      const unfiltered = shim.statements.filter(
        (s) => s.kind === 'table' && !s.filters.some((f) => f.column === 'property_id' || f.column === 'id'),
      );
      assert.deepEqual(unfiltered.map((s) => `${s.verb} ${s.target}`), []);
      assert.deepEqual(shim.unsupported, [], 'the shim silently skipped a builder feature');
    });
  });

  // ── end to end ───────────────────────────────────────────────────────────

  describe('the planted patterns become the findings a manager would expect', () => {
    const PHASE_2A = {
      detectorIds: [
        'supply_spend_baseline',
        'work_order_rate_baseline',
        'inventory_usage_baseline',
        'expected_activity_stopped',
      ] as const,
    };

    test('one run turns four feeds into the right cards, and nothing for hotel B', async () => {
      await pg.query(`delete from findings where property_id = $1`, [PID_A]);
      const before = await pg.query<{ digest: string }>(
        `select md5(coalesce(string_agg(f::text, '|' order by f::text), '')) digest
           from findings f where f.property_id = $1`,
        [PID_B],
      );

      const summary = await runFindingsForProperty(PID_A, PHASE_2A);
      assert.deepEqual(summary.errors, [], 'a detector threw against the real schema');

      const found = await listFindings(PID_A);
      const keys = found.map((f) => f.dedupeKey).sort();
      assert.deepEqual(keys, [
        'expected_activity_stopped:stopped:inventory_counts',
        'expected_activity_stopped:stopped:work_order_flow',
        `inventory_usage_baseline:item_usage:${ITEM_A}`,
        'supply_spend_baseline:weekly_supply_spend',
      ]);

      assert.deepEqual(leaksIn(found), [], "hotel B leaked into hotel A's queue");

      const after = await pg.query<{ digest: string }>(
        `select md5(coalesce(string_agg(f::text, '|' order by f::text), '')) digest
           from findings f where f.property_id = $1`,
        [PID_B],
      );
      assert.equal(after.rows[0].digest, before.rows[0].digest, "hotel A's run touched hotel B");
    });

    test('the daily log is closed every day here, so nobody is told it stopped', async () => {
      const found = await listFindings(PID_A);
      assert.equal(
        found.some((f) => f.dedupeKey.includes('daily_log_closings')),
        false,
        'a healthy stream must produce silence, not a card',
      );
    });

    test('the work-order RATE detector skips for want of history and says so', async () => {
      const summary = await runFindingsForProperty(PID_A, {
        detectorIds: ['work_order_rate_baseline'],
      });
      assert.equal(summary.detectorsChecked, 0);
      assert.equal(summary.detectorsSkipped, 1);
      assert.match(summary.skipped[0].because, /fewer than 24 work orders/);
    });

    test('the overspend card carries a real range and a basis pointing at their own weeks', async () => {
      const found = await listFindings(PID_A);
      const spend = found.find((f) => f.detectorId === 'supply_spend_baseline')!;
      assert.ok(spend.price, 'twelve weeks of their own deliveries is a basis');
      assert.ok(spend.price!.highCents > spend.price!.lowCents, 'the schema would refuse anything else');
      assert.match(spend.price!.basis, /your last 12 comparable weeks ran/);
      assert.equal(
        spend.magnitude,
        135_000,
        '$2,300 this week against a $950 median week is a $1,350 overspend, in cents',
      );
    });

    test('the absence cards are priced honestly — one can be, one cannot', async () => {
      const found = await listFindings(PID_A);
      const counts = found.find((f) => f.dedupeKey.endsWith('stopped:inventory_counts'))!;
      const workOrders = found.find((f) => f.dedupeKey.endsWith('stopped:work_order_flow'))!;

      assert.ok(counts.price, 'variance_value is a real basis for what counting turns up');
      assert.match(counts.price!.basis, /of stock the books could not account for/);

      assert.equal(
        workOrders.price,
        null,
        'nothing in the hotel records prices "nobody logged maintenance", so it gets no number',
      );
      assert.match(String(workOrders.evidence.values.price_basis), /no dollar figure/);
    });

    test('a second run updates the same four cards instead of stacking four more', async () => {
      const first = await pg.query<{ n: number }>(
        `select count(*)::int n from findings where property_id = $1`,
        [PID_A],
      );
      await runFindingsForProperty(PID_A, PHASE_2A);
      const second = await pg.query<{ n: number }>(
        `select count(*)::int n from findings where property_id = $1`,
        [PID_A],
      );
      assert.equal(second.rows[0].n, first.rows[0].n, 'a re-find must update, never duplicate');
    });
  });
});
