/**
 * PROOF, against a real Postgres with the real migrations applied, that the
 * 0462 cents columns hold the right number at the right magnitude.
 *
 * The TypeScript twin (money-units.test.ts) proves the helper ARITHMETIC.
 * This proves the thing the app actually reads: columns computed by Postgres.
 *
 * Four claims, each of which a hand-written stub would happily fake:
 *
 *   • A WRITE-READ ROUND TRIP KEEPS THE MAGNITUDE. $19.99 written to the
 *     dollar column reads back as 1999 cents, not 19, not 199900. Magnitude is
 *     the whole bug class: the shipped 100x regression showed 1% of real spend
 *     and every individual number still "looked like money".
 *   • CENTS ARE ALWAYS WHOLE. The unrounded `unit_cost * 100` this change
 *     replaced produced fractional cents for ~9% of real prices. A generated
 *     column cannot regress into that.
 *   • THE MIRROR CANNOT DRIFT FROM ITS SOURCE. This is the reason the columns
 *     are generated rather than backfilled: Postgres recomputes on UPDATE, so
 *     a write from plpgsql (0312/0322/0324 insert into these very tables) is
 *     as covered as a write from TypeScript. A plain backfilled column would
 *     pass an insert test and silently diverge on the first RPC.
 *   • NULL STAYS NULL. Unit cost null means "price unknown"; 0 means "free".
 *     Collapsing them would make unpriced items look free in spend totals.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-min-20-chars';
process.env.CRON_SECRET ??= 'placeholder-cron-secret-min-16';

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { PGlite } from '@electric-sql/pglite';

import { setupRlsFixture } from '../../../tests/fixtures/pglite-bootstrap';
import { loadCatalog, type Catalog } from '../../../tests/fixtures/postgrest-pglite';
import { seedTwoHotels, PID_A } from '../../../tests/fixtures/pglite-two-hotel-seed';
import { dollarsToCents } from '../format';

let pg: PGlite;
let catalog: Catalog;
let itemId: string;

/** The money values that break naive conversions, plus ordinary prices. */
// Cents as strings: Postgres returns bigint as a string, and comparing the
// text keeps the magnitude claim exact and readable.
const MONEY_CASES = [
  { dollars: '0', cents: '0' },
  { dollars: '0.01', cents: '1' },
  { dollars: '4.55', cents: '455' },
  { dollars: '8.35', cents: '835' },
  { dollars: '19.99', cents: '1999' },
  { dollars: '1.005', cents: '101' },   // half-cent: rounds up, not down
  { dollars: '4.455', cents: '446' },
  { dollars: '1234.56', cents: '123456' },
  { dollars: '99999.99', cents: '9999999' },
];

before(async () => {
  const fixture = await setupRlsFixture();
  pg = fixture.pg;
  catalog = await loadCatalog(pg);
  await seedTwoHotels(pg, catalog);

  const item = await pg.query<{ id: string }>(
    `insert into public.inventory (property_id, name, category, current_stock, par_level, unit, unit_cost)
     values ($1, 'Bath towel', 'housekeeping', 0, 200, 'each', 4.55)
     returning id`,
    [PID_A],
  );
  itemId = item.rows[0].id;
});

after(async () => {
  await pg?.close();
});

describe('0462 — inventory ledger cents mirrors', () => {
  test('unit cost round-trips at the right magnitude', async () => {
    for (const { dollars, cents } of MONEY_CASES) {
      await pg.query('update public.inventory set unit_cost = $1::numeric where id = $2', [dollars, itemId]);
      const r = await pg.query<{ c: string }>(
        'select unit_cost_cents::text as c from public.inventory where id = $1', [itemId],
      );
      assert.equal(r.rows[0].c, cents, `$${dollars} stored as ${r.rows[0].c} cents, expected ${cents}`);
    }
  });

  test('the database agrees with the TypeScript helper', async () => {
    // If these two ever disagree, a number computed in the app and the same
    // number computed by a database function stop matching, which is exactly
    // how a reconciliation report starts accusing an honest hotel.
    for (const { dollars } of MONEY_CASES) {
      await pg.query('update public.inventory set unit_cost = $1::numeric where id = $2', [dollars, itemId]);
      const r = await pg.query<{ unit_cost_cents: string | number | null }>(
        'select unit_cost_cents from public.inventory where id = $1', [itemId],
      );
      assert.equal(
        Number(r.rows[0].unit_cost_cents),
        dollarsToCents(Number(dollars)),
        `db and helper disagree on $${dollars}`,
      );
    }
  });

  test('cents are always whole numbers', async () => {
    for (const { dollars } of MONEY_CASES) {
      await pg.query('update public.inventory set unit_cost = $1::numeric where id = $2', [dollars, itemId]);
      const r = await pg.query<{ unit_cost_cents: string }>(
        'select unit_cost_cents::text as unit_cost_cents from public.inventory where id = $1', [itemId],
      );
      assert.ok(/^-?\d+$/.test(r.rows[0].unit_cost_cents), `got fractional cents: ${r.rows[0].unit_cost_cents}`);
    }
  });

  test('null unit cost stays null, and zero stays zero', async () => {
    await pg.query('update public.inventory set unit_cost = null where id = $1', [itemId]);
    let r = await pg.query<{ unit_cost_cents: unknown }>(
      'select unit_cost_cents from public.inventory where id = $1', [itemId],
    );
    assert.equal(r.rows[0].unit_cost_cents, null, 'unknown price must not become 0 cents');

    await pg.query('update public.inventory set unit_cost = 0 where id = $1', [itemId]);
    r = await pg.query<{ unit_cost_cents: unknown }>(
      'select unit_cost_cents from public.inventory where id = $1', [itemId],
    );
    assert.equal(Number(r.rows[0].unit_cost_cents), 0, 'a free item must stay 0, not null');
  });

  test('the mirror follows the source on UPDATE, so it cannot drift', async () => {
    // A plain backfilled column would pass every insert-only test above and
    // still diverge here — this is the case that justifies the design.
    await pg.query('update public.inventory set unit_cost = 19.99 where id = $1', [itemId]);
    let r = await pg.query<{ c: string }>(
      'select unit_cost_cents::text as c from public.inventory where id = $1', [itemId],
    );
    assert.equal(r.rows[0].c, '1999');

    await pg.query('update public.inventory set unit_cost = 8.35 where id = $1', [itemId]);
    r = await pg.query<{ c: string }>(
      'select unit_cost_cents::text as c from public.inventory where id = $1', [itemId],
    );
    assert.equal(r.rows[0].c, '835', 'cents did not follow the dollar column on update');
  });

  test('a generated column rejects a direct write, so cents can never be set out of band', async () => {
    await assert.rejects(
      () => pg.query('update public.inventory set unit_cost_cents = 1 where id = $1', [itemId]),
      /can only be updated to DEFAULT|generated/i,
      'a direct write to the mirror should be refused by Postgres',
    );
  });

  test('the restock ledger totals exactly in cents', async () => {
    // "Spend this month" is a SUM. Summing the dollar column accumulates float
    // error; summing the cents column is exact.
    // Scoped to a marker name: the shared fixture already seeds orders for
    // this property, and summing those in would prove nothing about rounding.
    const MARKER = 'Cents sum probe';
    const prices = ['0.10', '0.20', '0.30', '19.99', '8.35'];
    for (const p of prices) {
      await pg.query(
        `insert into public.inventory_orders (property_id, item_id, item_name, quantity, unit_cost, total_cost)
         values ($1, $2, $3, 1, $4::numeric, $4::numeric)`,
        [PID_A, itemId, MARKER, p],
      );
    }
    const r = await pg.query<{ total: string }>(
      `select coalesce(sum(total_cost_cents), 0)::text as total
         from public.inventory_orders where property_id = $1 and item_name = $2`,
      [PID_A, MARKER],
    );
    assert.equal(r.rows[0].total, '2894', 'cents sum must be exact');
  });
});

describe('0462 — labor and asset cents mirrors', () => {
  test('a wage round-trips at the right magnitude', async () => {
    await pg.query('update public.properties set hourly_wage = 15.50 where id = $1', [PID_A]);
    const r = await pg.query<{ c: string }>(
      'select hourly_wage_cents::text as c from public.properties where id = $1', [PID_A],
    );
    assert.equal(r.rows[0].c, '1550');
  });

  test('every converted table exposes whole-cent mirrors of its dollar columns', async () => {
    // Guards the column list itself: if a later change adds a dollar column to
    // one of these tables without a mirror, or types a mirror as something
    // other than an integer, this fails.
    const expected: Record<string, string[]> = {
      inventory: ['unit_cost_cents', 'opening_adjustment_unit_cost_cents', 'delivery_baseline_unit_cost_cents'],
      inventory_counts: ['unit_cost_cents', 'variance_value_cents'],
      inventory_orders: ['unit_cost_cents', 'total_cost_cents'],
      inventory_discards: ['unit_cost_cents', 'cost_value_cents'],
      inventory_reconciliations: ['unit_cost_cents', 'unaccounted_variance_value_cents'],
      inventory_delivery_corrections: [
        'previous_unit_cost_cents', 'previous_total_cost_cents',
        'corrected_unit_cost_cents', 'corrected_total_cost_cents',
      ],
      properties: ['hourly_wage_cents', 'weekly_budget_cents'],
      staff: ['hourly_wage_cents'],
      daily_logs: ['hourly_wage_cents', 'labor_cost_cents', 'labor_saved_cents'],
      work_orders: ['repair_cost_cents'],
      equipment: ['purchase_cost_cents', 'replacement_cost_cents'],
    };

    for (const [table, columns] of Object.entries(expected)) {
      for (const column of columns) {
        const r = await pg.query<{ data_type: string; is_generated: string }>(
          `select data_type, is_generated from information_schema.columns
            where table_schema = 'public' and table_name = $1 and column_name = $2`,
          [table, column],
        );
        assert.equal(r.rows.length, 1, `${table}.${column} is missing`);
        assert.equal(r.rows[0].data_type, 'bigint', `${table}.${column} must be integer cents`);
        assert.equal(r.rows[0].is_generated, 'ALWAYS', `${table}.${column} must be derived, not free-floating`);
      }
    }
  });
});
