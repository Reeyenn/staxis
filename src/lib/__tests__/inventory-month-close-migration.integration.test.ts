/** Executable PGlite coverage for migration 0322's physical-integrity rules. */

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { PGlite } from '@electric-sql/pglite';
import { applyMigrationsToPglite } from '../../../tests/fixtures/pglite-migrate';

const USER_ID = '71000000-0000-4000-8000-000000000001';
const PROPERTY_ID = '72000000-0000-4000-8000-000000000001';
const BASE_ITEM_ID = '73000000-0000-4000-8000-000000000001';
const ADJUSTED_ITEM_ID = '73000000-0000-4000-8000-000000000002';
const REJECTED_ITEM_ID = '73000000-0000-4000-8000-000000000003';
const COUNT_SESSION_ID = '74000000-0000-4000-8000-000000000001';
const START_REQUEST_ID = '75000000-0000-4000-8000-000000000001';
const ADJUSTMENT_REQUEST_ID = '75000000-0000-4000-8000-000000000002';
const DELIVERY_REQUEST_ID = '75000000-0000-4000-8000-000000000003';
const EXISTING_ADJUSTMENT_REQUEST_ID = '75000000-0000-4000-8000-000000000004';
const SECOND_EXISTING_ADJUSTMENT_REQUEST_ID = '75000000-0000-4000-8000-000000000005';

let pg: PGlite;

async function scalar<T>(sql: string, params: unknown[] = []): Promise<T> {
  const result = await pg.query(sql, params) as { rows: Array<Record<string, unknown>> };
  return Object.values(result.rows[0] ?? {})[0] as T;
}

describe('inventory month close migration 0322', () => {
  before(async () => {
    const migrated = await applyMigrationsToPglite();
    pg = migrated.pg;
    assert.ok(
      migrated.report.applied.includes('0322_inventory_month_close.sql'),
      `0322 must apply in PGlite: ${JSON.stringify(migrated.report.failedAtRuntime.filter((row) => row.file.startsWith('0322')))}`,
    );

    await pg.query(
      `insert into auth.users(id, email) values ($1, 'month-close@example.test')
       on conflict (id) do nothing`,
      [USER_ID],
    );
    await pg.query(
      `insert into public.properties(id, owner_id, name, total_rooms, timezone)
       values ($1, $2, 'Month Close Hotel', 20, 'UTC')
       on conflict (id) do nothing`,
      [PROPERTY_ID, USER_ID],
    );
    await pg.query(
      `insert into public.inventory(
         id, property_id, name, category, current_stock, par_level, unit, unit_cost
       ) values ($1, $2, 'Baseline towels', 'housekeeping', 4, 8, 'each', 2)`,
      [BASE_ITEM_ID, PROPERTY_ID],
    );
    await pg.query(
      `insert into public.inventory_counts(
         property_id, item_id, item_name, counted_stock, unit_cost,
         counted_at, counted_by, count_session_id
       ) values ($1, $2, 'Baseline towels', 4, 2, now(), 'Manager', $3)`,
      [PROPERTY_ID, BASE_ITEM_ID, COUNT_SESSION_ID],
    );
    await pg.query(`select set_config('request.jwt.claim.role', 'service_role', false)`);
    await pg.query(
      `select public.staxis_start_inventory_month_close(
         $1, date_trunc('month', now())::date, $2, $3, 'Manager'
       )`,
      [PROPERTY_ID, START_REQUEST_ID, USER_ID],
    );
  });

  after(async () => {
    await pg.close();
  });

  test('captures pre-existing shelf stock as immutable opening evidence', async () => {
    await pg.query(
      `insert into public.inventory(
         id, property_id, name, category, current_stock, par_level, unit, unit_cost,
         opening_adjustment_quantity, opening_adjustment_unit_cost,
         opening_adjustment_at, opening_adjustment_request_id
       ) values ($1, $2, 'Discovered soap', 'housekeeping', 10, 12, 'each', 2.5,
         10, 2.5, now(), $3)`,
      [ADJUSTED_ITEM_ID, PROPERTY_ID, ADJUSTMENT_REQUEST_ID],
    );

    const value = Number(await scalar<number>(
      `select value_cents from public.inventory_opening_adjustments where item_id = $1`,
      [ADJUSTED_ITEM_ID],
    ));
    assert.equal(value, 2_500);
    await assert.rejects(
      pg.query(
        `update public.inventory set opening_adjustment_quantity = 11 where id = $1`,
        [ADJUSTED_ITEM_ID],
      ),
      /opening-adjustment provenance is immutable|23514/i,
    );
    await assert.rejects(
      pg.query(
        `update public.inventory_opening_adjustments set quantity = 11 where item_id = $1`,
        [ADJUSTED_ITEM_ID],
      ),
      /evidence is immutable|23514/i,
    );
  });

  test('audits missed opening stock on an existing baseline item', async () => {
    await pg.query(
      `select public.staxis_record_inventory_opening_adjustment(
         $1, $2, $3, now(), 4, 6, 2, 3, $4, 'Manager'
       )`,
      [PROPERTY_ID, BASE_ITEM_ID, EXISTING_ADJUSTMENT_REQUEST_ID, USER_ID],
    );
    await pg.query(
      `select public.staxis_record_inventory_opening_adjustment(
         $1, $2, $3, now(), 6, 7, 1, 4, $4, 'Manager'
       )`,
      [PROPERTY_ID, BASE_ITEM_ID, SECOND_EXISTING_ADJUSTMENT_REQUEST_ID, USER_ID],
    );

    assert.equal(Number(await scalar<number>(
      `select current_stock from public.inventory where id = $1`,
      [BASE_ITEM_ID],
    )), 7);
    assert.equal(Number(await scalar<number>(
      `select sum(quantity) from public.inventory_opening_adjustments
       where property_id = $1 and item_id = $2`,
      [PROPERTY_ID, BASE_ITEM_ID],
    )), 3);
    assert.equal(Number(await scalar<number>(
      `select sum(value_cents) from public.inventory_opening_adjustments
       where property_id = $1 and item_id = $2`,
      [PROPERTY_ID, BASE_ITEM_ID],
    )), 1_000);
    assert.equal(Number(await scalar<number>(
      `select count(*) from public.inventory_orders where property_id = $1 and item_id = $2`,
      [PROPERTY_ID, BASE_ITEM_ID],
    )), 0);
  });

  test('rejects unexplained positive stock and positive-stock archival', async () => {
    await assert.rejects(
      pg.query(
        `insert into public.inventory(
           id, property_id, name, category, current_stock, par_level, unit, unit_cost
         ) values ($1, $2, 'Unexplained stock', 'housekeeping', 3, 5, 'each', 1)`,
        [REJECTED_ITEM_ID, PROPERTY_ID],
      ),
      /opening-inventory adjustment or a received delivery line|23514/i,
    );
    await assert.rejects(
      pg.query(
        `update public.inventory set archived_at = now(), archived_by = $2 where id = $1`,
        [ADJUSTED_ITEM_ID, USER_ID],
      ),
      /count inventory stock to zero|23514/i,
    );
  });

  test('keeps delivery-created stock in the purchase ledger, not opening adjustments', async () => {
    const result = await pg.query(
      `select public.staxis_receive_inventory_delivery(
         $1, $2, now(), 'Vendor', 'Invoice', $3::jsonb
       ) as result`,
      [
        PROPERTY_ID,
        DELIVERY_REQUEST_ID,
        JSON.stringify([{
          line_key: 'delivery-line-1',
          item_id: null,
          item_name: 'Delivered coffee',
          category: 'breakfast',
          quantity: 6,
          unit: 'each',
          par_level: 12,
          unit_cost: 1.5,
        }]),
      ],
    ) as { rows: Array<{ result: { created: Array<{ item_id: string }> } }> };
    const itemId = result.rows[0]?.result.created[0]?.item_id;
    assert.ok(itemId);
    assert.equal(Number(await scalar<number>(
      `select count(*) from public.inventory_orders where property_id = $1 and item_id = $2`,
      [PROPERTY_ID, itemId],
    )), 1);
    assert.equal(Number(await scalar<number>(
      `select count(*) from public.inventory_opening_adjustments where property_id = $1 and item_id = $2`,
      [PROPERTY_ID, itemId],
    )), 0);
  });
});
