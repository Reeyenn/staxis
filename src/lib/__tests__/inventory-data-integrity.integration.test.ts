/**
 * Executable database regression coverage for migration 0312.
 *
 * The test runs the real migration chain in PGlite, then exercises the exact
 * failure modes found before the hotel field test: cross-property item links,
 * partial count/delivery writes, retry duplication, destructive item deletes,
 * stale PO deltas, and owner-account cascades.
 */

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { PGlite } from '@electric-sql/pglite';
import { applyMigrationsToPglite } from '../../../tests/fixtures/pglite-migrate';

const USER_A = '51000000-0000-4000-8000-000000000001';
const USER_B = '51000000-0000-4000-8000-000000000002';
const PROP_A = '52000000-0000-4000-8000-000000000001';
const PROP_B = '52000000-0000-4000-8000-000000000002';
const ITEM_A = '53000000-0000-4000-8000-000000000001';
const ITEM_B = '53000000-0000-4000-8000-000000000002';
const ITEM_PROVENANCE = '53000000-0000-4000-8000-000000000003';
const VENDOR_A = '57000000-0000-4000-8000-000000000001';
const COUNT_REQ = '54000000-0000-4000-8000-000000000001';
const DELIVERY_REQ = '54000000-0000-4000-8000-000000000002';
const CREATE_REQ = '54000000-0000-4000-8000-000000000003';
const COUNT_FAIL_REQ = '54000000-0000-4000-8000-000000000004';
const DELIVERY_FAIL_REQ = '54000000-0000-4000-8000-000000000005';
const STALE_COUNT_REQ = '54000000-0000-4000-8000-000000000006';
const NONFINITE_COUNT_REQ = '54000000-0000-4000-8000-000000000007';
const NONFINITE_DELIVERY_REQ = '54000000-0000-4000-8000-000000000008';
const DUPLICATE_INVOICE_REQ = '54000000-0000-4000-8000-000000000009';
const FOREIGN_COUNT_REQ = '54000000-0000-4000-8000-000000000010';
const RESTRICTED_DELIVERY_REQ = '54000000-0000-4000-8000-000000000011';
const ARCHIVE_COUNT_REQ = '54000000-0000-4000-8000-000000000012';
const PO_ID = '55000000-0000-4000-8000-000000000001';
const PO_LINE = '56000000-0000-4000-8000-000000000001';
const PO_UNLINKED = '55000000-0000-4000-8000-000000000002';
const PO_UNLINKED_LINE = '56000000-0000-4000-8000-000000000002';
const PO_NONFINITE = '55000000-0000-4000-8000-000000000003';
const PO_NONFINITE_LINE = '56000000-0000-4000-8000-000000000003';

let pg: PGlite;

async function scalar<T>(sql: string, params: unknown[] = []): Promise<T> {
  const result = await pg.query(sql, params) as { rows: Array<Record<string, unknown>> };
  return Object.values(result.rows[0] ?? {})[0] as T;
}

describe('inventory migration 0312 executable integrity', () => {
  before(async () => {
    const migrated = await applyMigrationsToPglite();
    pg = migrated.pg;
    assert.ok(
      migrated.report.applied.includes('0312_inventory_data_integrity.sql'),
      `0312 must apply in PGlite: ${JSON.stringify(migrated.report.failedAtRuntime.filter((x) => x.file.startsWith('0312')))}`,
    );

    await pg.query(
      `insert into auth.users(id, email) values ($1, 'integrity-a@example.test'), ($2, 'integrity-b@example.test')
       on conflict (id) do nothing`,
      [USER_A, USER_B],
    );
    await pg.query(
      `insert into public.properties(id, owner_id, name, total_rooms)
       values ($1, $2, 'Integrity A', 40), ($3, $4, 'Integrity B', 40)
       on conflict (id) do nothing`,
      [PROP_A, USER_A, PROP_B, USER_B],
    );
    await pg.query(
      `insert into public.accounts(username, display_name, role, property_access, data_user_id)
       values ('integrity-owner', 'Integrity Owner', 'owner', array[$1]::uuid[], $2)
       on conflict (username) do nothing`,
      [PROP_A, USER_A],
    );
    await pg.query(
      `insert into public.inventory(id, property_id, name, category, current_stock, par_level, unit, unit_cost)
       values ($1, $2, 'Bath Towels', 'housekeeping', 5, 20, 'each', 2.50),
              ($3, $4, 'Coffee Pods', 'breakfast', 8, 30, 'each', 0.50)
       on conflict (id) do nothing`,
      [ITEM_A, PROP_A, ITEM_B, PROP_B],
    );
    await pg.query(`select set_config('request.jwt.claim.sub', $1, false)`, [USER_A]);
    await pg.query(`select set_config('request.jwt.claim.role', 'authenticated', false)`);
    // PGlite's auth.jwt() bootstrap is a fixed empty object; emulate the
    // verified production access-token claim for RLS/RPC authorization.
    await pg.query(`
      create or replace function auth.jwt() returns jsonb
      language sql stable as 'select ''{"mfa_verified": true}''::jsonb'
    `);
    await pg.query('grant select, insert, update on public.inventory to authenticated');
  });

  after(async () => {
    await pg.close();
  });

  test('composite item/property FK rejects a cross-hotel count row', async () => {
    await assert.rejects(
      pg.query(
        `insert into public.inventory_counts(property_id, item_id, item_name, counted_stock)
         values ($1, $2, 'wrong hotel', 1)`,
        [PROP_A, ITEM_B],
      ),
      /foreign key|inventory_counts_item_property_fkey/i,
    );
  });

  test('security-definer inventory RPCs still reject another hotel', async () => {
    await assert.rejects(
      pg.query(
        `select public.staxis_save_inventory_count($1, $2, now(), 'Wrong hotel', $3::jsonb)`,
        [
          PROP_B,
          FOREIGN_COUNT_REQ,
          JSON.stringify([{ item_id: ITEM_B, expected_stock: 8, counted_stock: 7 }]),
        ],
      ),
      /not authorized|42501/i,
    );
    assert.equal(Number(await scalar<number>('select current_stock from public.inventory where id = $1', [ITEM_B])), 8);
  });

  test('delivery RPC honors the per-hotel inventory-ordering capability restriction', async () => {
    await pg.query(
      `insert into public.capability_overrides(property_id, capability, role, allowed)
       values ($1, 'manage_inventory_orders', 'owner', false)`,
      [PROP_A],
    );
    try {
      await assert.rejects(
        pg.query(
          `select public.staxis_receive_inventory_delivery($1, $2, now(), 'Restricted vendor', null, $3::jsonb)`,
          [
            PROP_A,
            RESTRICTED_DELIVERY_REQ,
            JSON.stringify([{ line_key: 'restricted', item_id: ITEM_A, quantity: 1 }]),
          ],
        ),
        /not authorized|42501/i,
      );
    } finally {
      await pg.query(
        `delete from public.capability_overrides
         where property_id = $1 and capability = 'manage_inventory_orders' and role = 'owner'`,
        [PROP_A],
      );
    }

    assert.equal(Number(await scalar<number>('select current_stock from public.inventory where id = $1', [ITEM_A])), 5);
    assert.equal(
      Number(await scalar<number>('select count(*) from public.inventory_write_receipts where request_id = $1', [RESTRICTED_DELIVERY_REQ])),
      0,
    );
  });

  test('count RPC atomically updates stock/history and replays without an inferred order', async () => {
    const countedAt = new Date(Date.now() - 60_000).toISOString();
    const rows = JSON.stringify([{ item_id: ITEM_A, expected_stock: 5, counted_stock: 12, estimated_stock: 10 }]);
    await pg.query(
      `select public.staxis_save_inventory_count($1, $2, $3, 'Field tester', $4::jsonb)`,
      [PROP_A, COUNT_REQ, countedAt, rows],
    );
    await assert.rejects(
      pg.query(
        `select public.staxis_save_inventory_count($1, $2, $3, 'Field tester', $4::jsonb)`,
        [
          PROP_A,
          COUNT_REQ,
          countedAt,
          JSON.stringify([{ item_id: ITEM_A, expected_stock: 12, counted_stock: 13 }]),
        ],
      ),
      /different operation or payload|22023/i,
    );
    await pg.query(
      `select public.staxis_save_inventory_count($1, $2, $3, 'Field tester', $4::jsonb)`,
      [PROP_A, COUNT_REQ, countedAt, rows],
    );

    assert.equal(Number(await scalar<number>('select current_stock from public.inventory where id = $1', [ITEM_A])), 12);
    assert.equal(
      Number(await scalar<number>('select count(*) from public.inventory_counts where count_session_id = $1', [COUNT_REQ])),
      1,
    );
    assert.equal(
      Number(await scalar<number>('select count(*) from public.inventory_orders where property_id = $1', [PROP_A])),
      0,
      'an upward recount is not proof of a delivery',
    );
  });

  test('count RPC rolls back earlier rows and its receipt when a later row is invalid', async () => {
    const rows = JSON.stringify([
      { item_id: ITEM_A, expected_stock: 12, counted_stock: 99 },
      { item_id: ITEM_B, expected_stock: 8, counted_stock: 1 },
    ]);
    await assert.rejects(
      pg.query(
        `select public.staxis_save_inventory_count($1, $2, now(), 'Field tester', $3::jsonb)`,
        [PROP_A, COUNT_FAIL_REQ, rows],
      ),
      /not found for property|P0002/i,
    );

    assert.equal(Number(await scalar<number>('select current_stock from public.inventory where id = $1', [ITEM_A])), 12);
    assert.equal(
      Number(await scalar<number>('select count(*) from public.inventory_counts where count_session_id = $1', [COUNT_FAIL_REQ])),
      0,
    );
    assert.equal(
      Number(await scalar<number>('select count(*) from public.inventory_write_receipts where request_id = $1', [COUNT_FAIL_REQ])),
      0,
    );
  });

  test('delivery RPC increments locked stock and ledger exactly once per request id', async () => {
    const lines = JSON.stringify([{ line_key: 'towels', item_id: ITEM_A, quantity: 3, unit_cost: 2.5 }]);
    for (let i = 0; i < 2; i++) {
      await pg.query(
        `select public.staxis_receive_inventory_delivery($1, $2, '2026-07-15T19:00:00Z', 'Vendor A', 'Manual delivery', $3::jsonb)`,
        [PROP_A, DELIVERY_REQ, lines],
      );
    }

    assert.equal(Number(await scalar<number>('select current_stock from public.inventory where id = $1', [ITEM_A])), 15);
    assert.equal(
      Number(await scalar<number>(
        `select count(*) from public.inventory_orders where property_id = $1 and notes = 'Manual delivery'`,
        [PROP_A],
      )),
      1,
    );
  });

  test('a count opened before a delivery cannot erase the received stock', async () => {
    const staleRows = JSON.stringify([{
      item_id: ITEM_A,
      expected_stock: 12,
      counted_stock: 20,
    }]);
    await assert.rejects(
      pg.query(
        `select public.staxis_save_inventory_count($1, $2, now(), 'Stale counter', $3::jsonb)`,
        [PROP_A, STALE_COUNT_REQ, staleRows],
      ),
      /changed after this count was opened|40001/i,
    );

    assert.equal(Number(await scalar<number>('select current_stock from public.inventory where id = $1', [ITEM_A])), 15);
    assert.equal(
      Number(await scalar<number>('select count(*) from public.inventory_counts where count_session_id = $1', [STALE_COUNT_REQ])),
      0,
    );
    assert.equal(
      Number(await scalar<number>('select count(*) from public.inventory_write_receipts where request_id = $1', [STALE_COUNT_REQ])),
      0,
    );
  });

  test('count and delivery RPCs reject non-finite numeric strings without mutations', async () => {
    const stockBefore = Number(await scalar<number>('select current_stock from public.inventory where id = $1', [ITEM_A]));
    await assert.rejects(
      pg.query(
        `select public.staxis_save_inventory_count($1, $2, now(), 'Field tester', $3::jsonb)`,
        [
          PROP_A,
          NONFINITE_COUNT_REQ,
          JSON.stringify([{ item_id: ITEM_A, expected_stock: stockBefore, counted_stock: 'NaN' }]),
        ],
      ),
      /must be a finite number|22023/i,
    );
    await assert.rejects(
      pg.query(
        `select public.staxis_receive_inventory_delivery($1, $2, now(), 'Vendor A', 'Bad number', $3::jsonb)`,
        [
          PROP_A,
          NONFINITE_DELIVERY_REQ,
          JSON.stringify([{ line_key: 'bad', item_id: ITEM_A, quantity: 'Infinity' }]),
        ],
      ),
      /must be a finite number|22023/i,
    );

    assert.equal(Number(await scalar<number>('select current_stock from public.inventory where id = $1', [ITEM_A])), stockBefore);
    assert.equal(
      Number(await scalar<number>(
        'select count(*) from public.inventory_write_receipts where request_id in ($1, $2)',
        [NONFINITE_COUNT_REQ, NONFINITE_DELIVERY_REQ],
      )),
      0,
    );
  });

  test('delivery RPC rolls back earlier lines and its receipt when a later line is invalid', async () => {
    const lines = JSON.stringify([
      { line_key: 'valid-towels', item_id: ITEM_A, quantity: 4 },
      { line_key: 'foreign-coffee', item_id: ITEM_B, quantity: 1 },
    ]);
    await assert.rejects(
      pg.query(
        `select public.staxis_receive_inventory_delivery($1, $2, '2026-07-15T19:30:00Z', 'Vendor A', 'Failed delivery', $3::jsonb)`,
        [PROP_A, DELIVERY_FAIL_REQ, lines],
      ),
      /not found for property|P0002/i,
    );

    assert.equal(Number(await scalar<number>('select current_stock from public.inventory where id = $1', [ITEM_A])), 15);
    assert.equal(
      Number(await scalar<number>(
        `select count(*) from public.inventory_orders where property_id = $1 and notes = 'Failed delivery'`,
        [PROP_A],
      )),
      0,
    );
    assert.equal(
      Number(await scalar<number>('select count(*) from public.inventory_write_receipts where request_id = $1', [DELIVERY_FAIL_REQ])),
      0,
    );
  });

  test('scanned-delivery create line creates item and ledger in the same transaction', async () => {
    const lines = JSON.stringify([{
      line_key: 'new-mop', item_id: null, item_name: 'Lobby Mop', category: 'maintenance',
      unit: 'each', par_level: 4, quantity: 2, unit_cost: 14,
    }]);
    await pg.query(
      `select public.staxis_receive_inventory_delivery($1, $2, '2026-07-15T20:00:00Z', 'Vendor B', 'Invoice scan · inv#123@vendor b', $3::jsonb)`,
      [PROP_A, CREATE_REQ, lines],
    );

    const createdId = await scalar<string>(
      `select id from public.inventory where property_id = $1 and name = 'Lobby Mop' and archived_at is null`,
      [PROP_A],
    );
    assert.ok(createdId);
    assert.equal(Number(await scalar<number>('select current_stock from public.inventory where id = $1', [createdId])), 2);
    assert.equal(
      Number(await scalar<number>('select count(*) from public.inventory_orders where item_id = $1', [createdId])),
      1,
    );

    const stockBefore = Number(await scalar<number>('select current_stock from public.inventory where id = $1', [ITEM_A]));
    await assert.rejects(
      pg.query(
        `select public.staxis_receive_inventory_delivery($1, $2, now(), 'Vendor B', 'Invoice scan · inv#123@vendor b', $3::jsonb)`,
        [
          PROP_A,
          DUPLICATE_INVOICE_REQ,
          JSON.stringify([{ line_key: 'duplicate', item_id: ITEM_A, quantity: 2 }]),
        ],
      ),
      /numbered invoice was already received|23505/i,
    );
    assert.equal(Number(await scalar<number>('select current_stock from public.inventory where id = $1', [ITEM_A])), stockBefore);
    assert.equal(
      Number(await scalar<number>('select count(*) from public.inventory_write_receipts where request_id = $1', [DUPLICATE_INVOICE_REQ])),
      0,
    );
  });

  test('PO rollout keeps a safe v1 body but only service-role grants the atomic v2 contract', async () => {
    assert.equal(
      await scalar<string | null>(`select to_regprocedure('public.staxis_receive_po_lines(uuid,uuid,jsonb)')::text`),
      'staxis_receive_po_lines(uuid,uuid,jsonb)',
    );
    assert.equal(
      await scalar<string | null>(`select to_regprocedure('public.staxis_receive_po_lines_v2(uuid,uuid,jsonb)')::text`),
      'staxis_receive_po_lines_v2(uuid,uuid,jsonb)',
    );
    assert.equal(
      await scalar<boolean>(
        `select has_function_privilege('service_role', 'public.staxis_receive_po_lines(uuid,uuid,jsonb)', 'EXECUTE')`,
      ),
      false,
    );
    assert.equal(
      await scalar<boolean>(
        `select has_function_privilege('service_role', 'public.staxis_receive_po_lines_v2(uuid,uuid,jsonb)', 'EXECUTE')`,
      ),
      true,
    );
  });

  test('PO receive derives delta from locked line state and v1/v2 retries are no-ops', async () => {
    await pg.query(
      `insert into public.purchase_orders(id, property_id, po_number, status)
       values ($1, $2, 'PO-INTEGRITY-1', 'sent')`,
      [PO_ID, PROP_A],
    );
    await pg.query(
      `insert into public.purchase_order_lines(id, purchase_order_id, item_id, description, qty_ordered, unit_cost_cents)
       values ($1, $2, $3, 'Bath Towels', 10, 250)`,
      [PO_LINE, PO_ID, ITEM_A],
    );
    const payload = JSON.stringify([{ line_id: PO_LINE, target_qty: 5, item_id: ITEM_B, delta: 999 }]);
    await pg.query('select public.staxis_receive_po_lines_v2($1, $2, $3::jsonb)', [PROP_A, PO_ID, payload]);
    await pg.query('select public.staxis_receive_po_lines_v2($1, $2, $3::jsonb)', [PROP_A, PO_ID, payload]);
    await pg.query('select public.staxis_receive_po_lines($1, $2, $3::jsonb)', [PROP_A, PO_ID, payload]);

    assert.equal(Number(await scalar<number>('select current_stock from public.inventory where id = $1', [ITEM_A])), 20);
    assert.equal(Number(await scalar<number>('select qty_received from public.purchase_order_lines where id = $1', [PO_LINE])), 5);
    assert.equal(await scalar<string>('select status from public.purchase_orders where id = $1', [PO_ID]), 'partially_received');
    assert.equal(
      Number(await scalar<number>(
        `select count(*) from public.inventory_orders where item_id = $1 and notes = 'Received PO-INTEGRITY-1'`,
        [ITEM_A],
      )),
      1,
    );
  });

  test('PO receive advances an unlinked free-text line without mutating inventory', async () => {
    await pg.query(
      `insert into public.purchase_orders(id, property_id, po_number, status)
       values ($1, $2, 'PO-INTEGRITY-UNLINKED', 'sent')`,
      [PO_UNLINKED, PROP_A],
    );
    await pg.query(
      `insert into public.purchase_order_lines(id, purchase_order_id, description, qty_ordered, unit_cost_cents)
       values ($1, $2, 'Unlinked Towels', 4, 250)`,
      [PO_UNLINKED_LINE, PO_UNLINKED],
    );

    const payload = JSON.stringify([{ line_id: PO_UNLINKED_LINE, target_qty: 1 }]);
    await pg.query('select public.staxis_receive_po_lines_v2($1, $2, $3::jsonb)', [PROP_A, PO_UNLINKED, payload]);
    await pg.query('select public.staxis_receive_po_lines($1, $2, $3::jsonb)', [PROP_A, PO_UNLINKED, payload]);

    assert.equal(
      Number(await scalar<number>('select qty_received from public.purchase_order_lines where id = $1', [PO_UNLINKED_LINE])),
      1,
    );
    assert.equal(await scalar<string>('select status from public.purchase_orders where id = $1', [PO_UNLINKED]), 'partially_received');
    assert.equal(
      Number(await scalar<number>(
        `select count(*) from public.inventory_orders where property_id = $1 and notes = 'Received PO-INTEGRITY-UNLINKED'`,
        [PROP_A],
      )),
      0,
    );
  });

  test('PO receive v2 rejects non-finite receipt targets without mutating data', async () => {
    await pg.query(
      `insert into public.purchase_orders(id, property_id, po_number, status)
       values ($1, $2, 'PO-INTEGRITY-NONFINITE', 'sent')`,
      [PO_NONFINITE, PROP_A],
    );
    await pg.query(
      `insert into public.purchase_order_lines(id, purchase_order_id, item_id, description, qty_ordered, unit_cost_cents)
       values ($1, $2, $3, 'Bath Towels', 4, 250)`,
      [PO_NONFINITE_LINE, PO_NONFINITE, ITEM_A],
    );
    const stockBefore = Number(await scalar<number>('select current_stock from public.inventory where id = $1', [ITEM_A]));

    for (const target of ['NaN', 'Infinity', '-Infinity']) {
      const payload = JSON.stringify([{ line_id: PO_NONFINITE_LINE, target_qty: target }]);
      await assert.rejects(
        pg.query('select public.staxis_receive_po_lines_v2($1, $2, $3::jsonb)', [PROP_A, PO_NONFINITE, payload]),
        /target_qty must be finite and nonnegative/i,
      );
    }

    assert.equal(Number(await scalar<number>('select current_stock from public.inventory where id = $1', [ITEM_A])), stockBefore);
    assert.equal(
      Number(await scalar<number>('select qty_received from public.purchase_order_lines where id = $1', [PO_NONFINITE_LINE])),
      0,
    );
    assert.equal(
      Number(await scalar<number>(
        `select count(*) from public.inventory_orders where property_id = $1 and notes = 'Received PO-INTEGRITY-NONFINITE'`,
        [PROP_A],
      )),
      0,
    );
  });

  test('PO line trigger rejects an item from another hotel', async () => {
    await assert.rejects(
      pg.query(
        `insert into public.purchase_order_lines(purchase_order_id, item_id, description, qty_ordered)
         values ($1, $2, 'foreign item', 1)`,
        [PO_ID, ITEM_B],
      ),
      /does not belong to property|23503/i,
    );
  });

  test('purchase order cannot be reassigned to another hotel after lines are linked', async () => {
    await assert.rejects(
      pg.query(
        `update public.purchase_orders set property_id = $1 where id = $2`,
        [PROP_B, PO_ID],
      ),
      /purchase-order property is immutable|23514/i,
    );
    assert.equal(
      await scalar<string>('select property_id::text from public.purchase_orders where id = $1', [PO_ID]),
      PROP_A,
    );
  });

  test('browser vendor links work while provenance and stock remain database-owned', async () => {
    await pg.query(
      `insert into public.vendors(id, property_id, name) values ($1, $2, 'Integrity Vendor')`,
      [VENDOR_A, PROP_A],
    );
    await pg.query('set role authenticated');
    try {
      await pg.query(
        `insert into public.inventory(
           id, property_id, name, category, current_stock, par_level, unit,
           vendor_id, created_at, created_by
         ) values ($1, $2, 'Provenance Item', 'maintenance', 2, 4, 'each', $3, '2000-01-01', $4)`,
        [ITEM_PROVENANCE, PROP_A, VENDOR_A, USER_B],
      );
      await assert.rejects(
        pg.query(`update public.inventory set current_stock = 99 where id = $1`, [ITEM_PROVENANCE]),
        /atomic inventory RPC|42501/i,
      );
      await assert.rejects(
        pg.query(
          `update public.inventory
           set archived_at = '2000-01-01', archived_by = $2
           where id = $1`,
          [ITEM_PROVENANCE, USER_B],
        ),
        /count inventory stock to zero|23514/i,
      );
      await pg.query(
        `select public.staxis_save_inventory_count($1, $2, now(), 'Archive count', $3::jsonb)`,
        [
          PROP_A,
          ARCHIVE_COUNT_REQ,
          JSON.stringify([{ item_id: ITEM_PROVENANCE, expected_stock: 2, counted_stock: 0 }]),
        ],
      );
      await pg.query(
        `update public.inventory
         set archived_at = '2000-01-01', archived_by = $2
         where id = $1`,
        [ITEM_PROVENANCE, USER_B],
      );
    } finally {
      await pg.query('reset role');
    }

    const provenance = await pg.query(
      `select created_at, created_by, archived_at, archived_by, current_stock
       from public.inventory where id = $1`,
      [ITEM_PROVENANCE],
    ) as { rows: Array<Record<string, unknown>> };
    const row = provenance.rows[0];
    assert.equal(row.created_by, USER_A);
    assert.equal(row.archived_by, USER_A);
    assert.notEqual(new Date(String(row.created_at)).getUTCFullYear(), 2000);
    assert.notEqual(new Date(String(row.archived_at)).getUTCFullYear(), 2000);
    assert.equal(Number(row.current_stock), 0);
  });

  test('history blocks hard item deletion and hotel ownership blocks auth-user deletion', async () => {
    await assert.rejects(
      pg.query('delete from public.inventory where id = $1', [ITEM_A]),
      /foreign key|item_property_fkey/i,
    );
    await assert.rejects(
      pg.query('delete from auth.users where id = $1', [USER_A]),
      /foreign key|properties_owner_id_fkey/i,
    );
    assert.equal(Number(await scalar<number>('select count(*) from public.properties where id = $1', [PROP_A])), 1);
  });
});
