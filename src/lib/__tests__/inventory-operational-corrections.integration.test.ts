import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { PGlite } from '@electric-sql/pglite';
import { applyMigrationsToPglite } from '../../../tests/fixtures/pglite-migrate';

const USER_A = '71000000-0000-4000-8000-000000000001';
const USER_B = '71000000-0000-4000-8000-000000000002';
const PROP_A = '72000000-0000-4000-8000-000000000001';
const PROP_B = '72000000-0000-4000-8000-000000000002';
const PROP_CLOSE = '72000000-0000-4000-8000-000000000003';
const PROP_ARCHIVE_CLOSE = '72000000-0000-4000-8000-000000000004';
const PROP_BAD_TIMEZONE = '72000000-0000-4000-8000-000000000005';
const PROP_START_COST_ONLY = '72000000-0000-4000-8000-000000000006';
const PROP_START_BACKDATED = '72000000-0000-4000-8000-000000000007';
const LOSS_ITEM = '73000000-0000-4000-8000-000000000001';
const DELIVERY_ITEM = '73000000-0000-4000-8000-000000000002';
const TARGET_ITEM = '73000000-0000-4000-8000-000000000003';
const ARCHIVE_ITEM = '73000000-0000-4000-8000-000000000004';
const EMPTY_ITEM = '73000000-0000-4000-8000-000000000005';
const FOREIGN_ITEM = '73000000-0000-4000-8000-000000000006';
const CLOSED_ITEM = '73000000-0000-4000-8000-000000000007';
const CLOSE_CORRECTION_ITEM = '73000000-0000-4000-8000-000000000008';
const NEVER_ARCHIVED_ITEM = '73000000-0000-4000-8000-000000000009';
const BACKDATED_ITEM = '73000000-0000-4000-8000-000000000010';
const METADATA_ITEM_A = '73000000-0000-4000-8000-000000000011';
const METADATA_ITEM_B = '73000000-0000-4000-8000-000000000012';
const DISCARD_PROVENANCE_ITEM = '73000000-0000-4000-8000-000000000013';
const CROSS_CLOSE_ITEM_A = '73000000-0000-4000-8000-000000000014';
const CROSS_CLOSE_ITEM_B = '73000000-0000-4000-8000-000000000015';
const UNKNOWN_COST_ITEM = '73000000-0000-4000-8000-000000000016';
const ARCHIVED_LEDGER_ITEM = '73000000-0000-4000-8000-000000000017';
const MOVE_SOURCE_ITEM = '73000000-0000-4000-8000-000000000018';
const START_COST_ITEM = '73000000-0000-4000-8000-000000000019';
const START_BACKDATED_ITEM = '73000000-0000-4000-8000-000000000020';
const CUSTOM_CATEGORY = '76000000-0000-4000-8000-000000000001';

let pg: PGlite;

async function scalar<T>(sql: string, params: unknown[] = []): Promise<T> {
  const result = await pg.query(sql, params) as { rows: Array<Record<string, unknown>> };
  return Object.values(result.rows[0] ?? {})[0] as T;
}

describe('inventory operational corrections migration 0324', () => {
  before(async () => {
    const migrated = await applyMigrationsToPglite();
    pg = migrated.pg;
    assert.ok(
      migrated.report.applied.includes('0324_inventory_operational_corrections.sql'),
      `0324 must apply in PGlite: ${JSON.stringify(
        migrated.report.failedAtRuntime.filter((entry) => entry.file.startsWith('0324')),
      )}`,
    );

    await pg.query(
      `insert into auth.users(id, email) values ($1, 'ops-a@example.test'), ($2, 'ops-b@example.test')
       on conflict (id) do nothing`,
      [USER_A, USER_B],
    );
    await pg.query(
      `insert into public.properties(id, owner_id, name, total_rooms, timezone)
       values ($1, $2, 'Ops A', 40, 'UTC'), ($3, $4, 'Ops B', 40, 'UTC'),
              ($5, $2, 'Close Corrections', 40, 'UTC'),
              ($6, $2, 'Archive Close', 40, 'UTC'),
              ($7, $2, 'Missing Timezone', 40, '   '),
              ($8, $2, 'Start Cost Only', 40, 'UTC'),
              ($9, $2, 'Start Backdated', 40, 'UTC')
       on conflict (id) do nothing`,
      [
        PROP_A, USER_A, PROP_B, USER_B, PROP_CLOSE, PROP_ARCHIVE_CLOSE,
        PROP_BAD_TIMEZONE, PROP_START_COST_ONLY, PROP_START_BACKDATED,
      ],
    );
    await pg.query(
      `insert into public.accounts(username, display_name, role, property_access, data_user_id)
       values ('ops-owner', 'Ops Owner', 'owner', array[$1,$2,$3,$4,$5,$6]::uuid[], $7)
       on conflict (username) do nothing`,
      [
        PROP_A, PROP_CLOSE, PROP_ARCHIVE_CLOSE, PROP_BAD_TIMEZONE,
        PROP_START_COST_ONLY, PROP_START_BACKDATED, USER_A,
      ],
    );
    await pg.query(
      `insert into public.inventory(id, property_id, name, category, current_stock, par_level, unit, unit_cost)
       values
         ($1, $8, 'Loss Towels', 'housekeeping', 10, 20, 'each', 2),
         ($2, $8, 'Delivery Towels', 'housekeeping', 10, 20, 'each', 2),
         ($3, $8, 'Replacement Towels', 'housekeeping', 4, 20, 'each', 5),
         ($4, $8, 'Archive Towels', 'housekeeping', 3, 20, 'each', 1),
         ($5, $8, 'Never Stocked', 'maintenance', 0, 1, 'each', null),
         ($6, $11, 'Foreign Coffee', 'breakfast', 8, 20, 'each', 1),
         ($7, $8, 'Closed Month Towels', 'housekeeping', 10, 20, 'each', 2),
         ($10, $9, 'Close Correction Towels', 'housekeeping', 5, 20, 'each', null)
       on conflict (id) do nothing`,
      [
        LOSS_ITEM, DELIVERY_ITEM, TARGET_ITEM, ARCHIVE_ITEM, EMPTY_ITEM, FOREIGN_ITEM, CLOSED_ITEM,
        PROP_A, PROP_CLOSE, CLOSE_CORRECTION_ITEM, PROP_B,
      ],
    );
    await pg.query(
      `insert into public.inventory(
         id,property_id,name,category,current_stock,par_level,unit,unit_cost,archived_at
       ) values ($1,$2,'Unused Archived Item','maintenance',0,1,'each',null,'2026-06-15T12:00:00Z')`,
      [NEVER_ARCHIVED_ITEM, PROP_ARCHIVE_CLOSE],
    );
    await pg.query(
      `insert into public.inventory(
         id,property_id,name,category,current_stock,par_level,unit,unit_cost
       ) values
         ($1,$3,'Backdated Delivery Item','maintenance',10,20,'each',1),
         ($2,$3,'Metadata A','maintenance',0,20,'each',7),
         ($4,$3,'Metadata B','maintenance',0,20,'each',9),
         ($5,$3,'Discard Provenance','maintenance',1,20,'each',3)`,
      [BACKDATED_ITEM, METADATA_ITEM_A, PROP_A, METADATA_ITEM_B, DISCARD_PROVENANCE_ITEM],
    );
    await pg.query(
      `insert into public.inventory(
         id,property_id,name,category,current_stock,par_level,unit,unit_cost
       ) values
         ($1,$3,'Cross Close A','maintenance',0,20,'each',1),
         ($2,$3,'Cross Close B','maintenance',0,20,'each',1)`,
      [CROSS_CLOSE_ITEM_A, CROSS_CLOSE_ITEM_B, PROP_CLOSE],
    );
    await pg.query(
      `insert into public.inventory(
         id,property_id,name,category,current_stock,par_level,unit,unit_cost
       ) values ($1,$2,'Unknown Cost Item','maintenance',0,20,'each',7)`,
      [UNKNOWN_COST_ITEM, PROP_A],
    );
    await pg.query(
      `insert into public.inventory(
         id,property_id,name,category,current_stock,par_level,unit,unit_cost
       ) values
         ($1,$5,'Archived Ledger Item','maintenance',0,20,'each',4),
         ($2,$5,'Move Source Item','maintenance',0,20,'each',3),
         ($3,$6,'Start Cost Item','maintenance',0,20,'each',4),
         ($4,$7,'Start Backdated Item','maintenance',0,20,'each',3)`,
      [
        ARCHIVED_LEDGER_ITEM, MOVE_SOURCE_ITEM, START_COST_ITEM, START_BACKDATED_ITEM,
        PROP_A, PROP_START_COST_ONLY, PROP_START_BACKDATED,
      ],
    );
    await pg.query(
      `insert into public.inventory_custom_categories(id,property_id,name,sort)
       values ($1,$2,'Pool',10)`,
      [CUSTOM_CATEGORY, PROP_A],
    );

    // Seed one historical delivery and then freeze its month. A correction
    // must roll back even though its RPC mutates stock before the activity
    // trigger sees the compensating order row.
    await pg.query(
      `insert into public.inventory_orders(
         property_id,item_id,item_name,quantity,unit_cost,total_cost,received_at,notes
       ) values ($1,$2,'Closed Month Towels',2,2,4,'2026-01-15T12:00:00Z','Closed delivery')`,
      [PROP_A, CLOSED_ITEM],
    );
    const openingSnapshot = '74000000-0000-4000-8000-000000000001';
    const endingSnapshot = '74000000-0000-4000-8000-000000000002';
    await pg.query(
      `insert into public.inventory_month_close_snapshots(id,property_id,kind,captured_at)
       values ($1,$3,'baseline','2026-01-01T00:00:00Z'),($2,$3,'ending','2026-02-01T00:00:00Z')`,
      [openingSnapshot, endingSnapshot, PROP_A],
    );
    await pg.query(
      `insert into public.inventory_month_closes(
         property_id,month_start,timezone,status,month_start_at,end_at,grace_end_at,
         count_window_start_at,activity_start_at,is_partial,budget_comparison_available,
         opening_snapshot_id,ending_snapshot_id,purchase_source,allocation_mode,
         confirmed_purchase_cents,beginning_value_cents,ending_value_cents,actual_usage_cents,
         baseline_at,closed_at
       ) values (
         $1,'2026-01-01','UTC','closed','2026-01-01T00:00:00Z','2026-02-01T00:00:00Z',
         '2026-02-04T00:00:00Z','2026-01-31T00:00:00Z','2026-01-01T00:00:00Z',
         false,true,$2,$3,'logged_deliveries','itemized',400,2000,1600,800,
         '2026-01-01T00:00:00Z','2026-02-02T00:00:00Z'
       )`,
      [PROP_A, openingSnapshot, endingSnapshot],
    );

    await pg.query(`select set_config('request.jwt.claim.sub', $1, false)`, [USER_A]);
    await pg.query(`select set_config('request.jwt.claim.role', 'authenticated', false)`);
    await pg.query(`
      create or replace function auth.jwt() returns jsonb
      language sql stable as 'select ''{"mfa_verified": true}''::jsonb'
    `);
    await pg.query('grant select, insert, update on public.inventory to authenticated');
  });

  after(async () => {
    await pg.close();
  });

  test('month start and close reject a blank hotel timezone before financial mutation', async () => {
    await pg.query(`select set_config('request.jwt.claim.role', 'service_role', false)`);
    try {
      await assert.rejects(
        pg.query(
          `select public.staxis_start_inventory_month_close($1,'2026-07-01',$2,$3,'Maria')`,
          [PROP_BAD_TIMEZONE, '75000000-0000-4000-8000-000000000080', USER_A],
        ),
        /timezone is missing or invalid|22023/i,
      );
      await assert.rejects(
        pg.query(
          `select public.staxis_close_inventory_month_close(
             $1,'2026-06-01',$2,'zero',null,$3,'Maria','Bad timezone'
           )`,
          [PROP_BAD_TIMEZONE, '75000000-0000-4000-8000-000000000081', USER_A],
        ),
        /timezone is missing or invalid|22023/i,
      );
    } finally {
      await pg.query(`select set_config('request.jwt.claim.role', 'authenticated', false)`);
    }
    assert.equal(Number(await scalar(
      `select count(*) from public.inventory_month_closes where property_id=$1`,
      [PROP_BAD_TIMEZONE],
    )), 0);
  });

  test('month start uses durable stock order but ignores a cost-only correction', async () => {
    await pg.query(
      `select public.staxis_receive_inventory_delivery(
         $1,$2,now() - interval '1 hour','Vendor','Opening cost root',$3::jsonb
       )`,
      [
        PROP_START_COST_ONLY,
        '75000000-0000-4000-8000-000000000114',
        JSON.stringify([{
          line_key: 'opening-cost', item_id: START_COST_ITEM, quantity: 1, unit_cost: 4,
        }]),
      ],
    );
    const costRoot = await scalar<string>(
      `select id from public.inventory_orders where property_id=$1 and notes='Opening cost root'`,
      [PROP_START_COST_ONLY],
    );
    await pg.query(
      `select public.staxis_save_inventory_count($1,$2,now(),'Counter',$3::jsonb)`,
      [
        PROP_START_COST_ONLY,
        '75000000-0000-4000-8000-000000000115',
        JSON.stringify([{
          item_id: START_COST_ITEM, expected_stock: 1, counted_stock: 1,
        }]),
      ],
    );
    await pg.query(
      `select public.staxis_correct_inventory_delivery(
         $1,$2,now(),'Maria','Correct invoice price only',$3::jsonb
       )`,
      [
        PROP_START_COST_ONLY,
        '75000000-0000-4000-8000-000000000116',
        JSON.stringify([{
          line_key: 'opening-cost', order_id: costRoot,
          expected_item_id: START_COST_ITEM, expected_quantity: 1, expected_unit_cost: 4,
          corrected_item_id: START_COST_ITEM, corrected_quantity: 1, corrected_unit_cost: 5,
        }]),
      ],
    );
    await pg.query(`select set_config('request.jwt.claim.role', 'service_role', false)`);
    try {
      await pg.query(
        `select public.staxis_start_inventory_month_close(
           $1,date_trunc('month', now())::date,$2,$3,'Maria'
         )`,
        [PROP_START_COST_ONLY, '75000000-0000-4000-8000-000000000117', USER_A],
      );
    } finally {
      await pg.query(`select set_config('request.jwt.claim.role', 'authenticated', false)`);
    }
    assert.equal(Number(await scalar(
      `select count(*) from public.inventory_month_closes where property_id=$1 and status='open'`,
      [PROP_START_COST_ONLY],
    )), 1);

    await pg.query(
      `select public.staxis_save_inventory_count($1,$2,now(),'Counter',$3::jsonb)`,
      [
        PROP_START_BACKDATED,
        '75000000-0000-4000-8000-000000000118',
        JSON.stringify([{
          item_id: START_BACKDATED_ITEM, expected_stock: 0, counted_stock: 0,
        }]),
      ],
    );
    await pg.query(
      `select public.staxis_receive_inventory_delivery(
         $1,$2,now() - interval '1 day','Vendor','Backdated after opening count',$3::jsonb
       )`,
      [
        PROP_START_BACKDATED,
        '75000000-0000-4000-8000-000000000119',
        JSON.stringify([{
          line_key: 'backdated-opening', item_id: START_BACKDATED_ITEM, quantity: 1, unit_cost: 3,
        }]),
      ],
    );
    const backdatedRoot = await scalar<string>(
      `select id from public.inventory_orders where property_id=$1 and notes='Backdated after opening count'`,
      [PROP_START_BACKDATED],
    );
    await pg.query(
      `select public.staxis_correct_inventory_delivery(
         $1,$2,now(),'Maria','Void backdated receipt',$3::jsonb
       )`,
      [
        PROP_START_BACKDATED,
        '75000000-0000-4000-8000-000000000120',
        JSON.stringify([{
          line_key: 'backdated-opening', order_id: backdatedRoot,
          expected_item_id: START_BACKDATED_ITEM, expected_quantity: 1, expected_unit_cost: 3,
          corrected_item_id: null, corrected_quantity: 0, corrected_unit_cost: null,
        }]),
      ],
    );
    assert.equal(Number(await scalar(
      `select current_stock from public.inventory where id=$1`, [START_BACKDATED_ITEM],
    )), 0, 'the net-zero chain keeps the old count numerically current');
    await pg.query(`select set_config('request.jwt.claim.role', 'service_role', false)`);
    try {
      await assert.rejects(
        pg.query(
          `select public.staxis_start_inventory_month_close(
             $1,date_trunc('month', now())::date,$2,$3,'Maria'
           )`,
          [PROP_START_BACKDATED, '75000000-0000-4000-8000-000000000121', USER_A],
        ),
        /activity occurred after the complete opening count|22023/i,
      );
    } finally {
      await pg.query(`select set_config('request.jwt.claim.role', 'authenticated', false)`);
    }
    assert.equal(Number(await scalar(
      `select count(*) from public.inventory_month_closes where property_id=$1`,
      [PROP_START_BACKDATED],
    )), 0);
  });

  test('records a whole-number stock loss atomically and replays only the same payload', async () => {
    const requestId = '75000000-0000-4000-8000-000000000001';
    const args = [PROP_A, requestId, '2026-07-19T12:00:00Z', 'Maria', LOSS_ITEM, 10, 2, 'missing', 'Could not locate'] as const;
    await pg.query(
      `select public.staxis_record_inventory_loss($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [...args],
    );
    await pg.query(
      `select public.staxis_record_inventory_loss($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [...args],
    );
    assert.equal(Number(await scalar('select current_stock from public.inventory where id=$1', [LOSS_ITEM])), 8);
    assert.equal(Number(await scalar('select count(*) from public.inventory_discards where request_id=$1', [requestId])), 1);
    assert.equal(Number(await scalar('select stock_before from public.inventory_discards where request_id=$1', [requestId])), 10);
    assert.equal(Number(await scalar('select stock_after from public.inventory_discards where request_id=$1', [requestId])), 8);

    await assert.rejects(
      pg.query(
        `select public.staxis_record_inventory_loss($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [PROP_A, requestId, '2026-07-19T12:00:00Z', 'Maria', LOSS_ITEM, 8, 1, 'missing', 'Changed'],
      ),
      /different operation or payload|22023/i,
    );
    await assert.rejects(
      pg.query(
        `select public.staxis_record_inventory_loss($1,$2,now(),$3,$4,$5,$6,$7,$8)`,
        [PROP_A, '75000000-0000-4000-8000-000000000002', 'Maria', LOSS_ITEM, 8, 1.5, 'damaged', null],
      ),
      /positive whole number|22023/i,
    );
    await pg.query(`update public.inventory set set_aside=8 where id=$1`, [LOSS_ITEM]);
    await assert.rejects(
      pg.query(
        `select public.staxis_record_inventory_loss($1,$2,now(),$3,$4,8,1,'missing',null)`,
        [PROP_A, '75000000-0000-4000-8000-000000000098', 'Maria', LOSS_ITEM],
      ),
      /below set-aside stock|22023/i,
    );
    await pg.query(`update public.inventory set set_aside=0 where id=$1`, [LOSS_ITEM]);
    assert.equal(Number(await scalar('select current_stock from public.inventory where id=$1', [LOSS_ITEM])), 8);
  });

  test('loss RPC enforces hotel scope, capability denial, and blocks direct browser inserts', async () => {
    await assert.rejects(
      pg.query(
        `select public.staxis_record_inventory_loss($1,$2,now(),'Wrong hotel',$3,8,1,'lost',null)`,
        [PROP_B, '75000000-0000-4000-8000-000000000003', FOREIGN_ITEM],
      ),
      /not authorized|42501/i,
    );
    await pg.query(
      `insert into public.capability_overrides(property_id,capability,role,allowed)
       values ($1,'manage_inventory_orders','owner',false)`,
      [PROP_A],
    );
    try {
      await assert.rejects(
        pg.query(
          `select public.staxis_record_inventory_loss($1,$2,now(),'Restricted',$3,8,1,'lost',null)`,
          [PROP_A, '75000000-0000-4000-8000-000000000004', LOSS_ITEM],
        ),
        /not authorized|42501/i,
      );
    } finally {
      await pg.query(
        `delete from public.capability_overrides
         where property_id=$1 and capability='manage_inventory_orders' and role='owner'`,
        [PROP_A],
      );
    }

    await pg.query('set role authenticated');
    try {
      await assert.rejects(
        pg.query(`select payload from public.inventory_write_receipts limit 1`),
        /permission denied/i,
      );
      await assert.rejects(
        pg.query(
          `insert into public.inventory_discards(property_id,item_id,item_name,quantity,reason)
           values ($1,$2,'Loss Towels',1,'lost')`,
          [PROP_A, LOSS_ITEM],
        ),
        /permission denied|row-level security/i,
      );
    } finally {
      await pg.query('reset role');
    }
  });

  test('unknown receipt cost stays unresolved and delivery-created item fields persist safely', async () => {
    const stockBeforeFutureAttempt = Number(await scalar(
      `select current_stock from public.inventory where id=$1`, [UNKNOWN_COST_ITEM],
    ));
    await assert.rejects(
      pg.query(
        `select public.staxis_receive_inventory_delivery(
           $1,$2,now() + interval '1 day','Vendor','Future hotel date',$3::jsonb
         )`,
        [
          PROP_A,
          '75000000-0000-4000-8000-000000000110',
          JSON.stringify([{
            line_key: 'future', item_id: UNKNOWN_COST_ITEM, quantity: 1, unit_cost: null,
          }]),
        ],
      ),
      /future hotel date|22023/i,
    );
    assert.equal(Number(await scalar(
      `select current_stock from public.inventory where id=$1`, [UNKNOWN_COST_ITEM],
    )), stockBeforeFutureAttempt);
    assert.equal(Number(await scalar(
      `select count(*) from public.inventory_orders where property_id=$1 and notes='Future hotel date'`,
      [PROP_A],
    )), 0);

    await pg.query(
      `select public.staxis_receive_inventory_delivery(
         $1,$2,date_trunc('day', now()) + interval '12 hours','Vendor','Unknown actual cost',$3::jsonb
       )`,
      [
        PROP_A,
        '75000000-0000-4000-8000-000000000100',
        JSON.stringify([{
          line_key: 'unknown', item_id: UNKNOWN_COST_ITEM, quantity: 2, unit_cost: null,
        }]),
      ],
    );
    const unknownOrder = await pg.query(
      `select unit_cost,total_cost from public.inventory_orders
       where property_id=$1 and notes='Unknown actual cost'`,
      [PROP_A],
    ) as { rows: Array<Record<string, unknown>> };
    assert.deepEqual(unknownOrder.rows[0], { unit_cost: null, total_cost: null });
    assert.equal(Number(await scalar(
      `select unit_cost from public.inventory where id=$1`, [UNKNOWN_COST_ITEM],
    )), 7, 'unknown invoice cost must not erase the item master estimate');

    const unknownRoot = await scalar<string>(
      `select id from public.inventory_orders where property_id=$1 and notes='Unknown actual cost'`,
      [PROP_A],
    );
    await pg.query(
      `select public.staxis_correct_inventory_delivery(
         $1,$2,now(),'Maria','Correct unknown quantity',$3::jsonb
       )`,
      [
        PROP_A,
        '75000000-0000-4000-8000-000000000111',
        JSON.stringify([{
          line_key: 'unknown', order_id: unknownRoot,
          expected_item_id: UNKNOWN_COST_ITEM, expected_quantity: 2, expected_unit_cost: null,
          corrected_item_id: UNKNOWN_COST_ITEM, corrected_quantity: 3, corrected_unit_cost: null,
        }]),
      ],
    );
    assert.equal(Number(await scalar(
      `select unit_cost from public.inventory where id=$1`, [UNKNOWN_COST_ITEM],
    )), 7, 'correcting an unknown-cost receipt must preserve the saved master estimate');

    await pg.query(
      `select public.staxis_receive_inventory_delivery(
         $1,$2,now(),'Known Vendor','Known cost after unknown',$3::jsonb
       )`,
      [
        PROP_A,
        '75000000-0000-4000-8000-000000000112',
        JSON.stringify([{
          line_key: 'known', item_id: UNKNOWN_COST_ITEM, quantity: 1, unit_cost: 9,
        }]),
      ],
    );
    const knownRoot = await scalar<string>(
      `select id from public.inventory_orders where property_id=$1 and notes='Known cost after unknown'`,
      [PROP_A],
    );
    assert.equal(Number(await scalar(
      `select unit_cost from public.inventory where id=$1`, [UNKNOWN_COST_ITEM],
    )), 9);
    await pg.query(
      `select public.staxis_correct_inventory_delivery(
         $1,$2,now(),'Maria','Void known receipt',$3::jsonb
       )`,
      [
        PROP_A,
        '75000000-0000-4000-8000-000000000113',
        JSON.stringify([{
          line_key: 'known', order_id: knownRoot,
          expected_item_id: UNKNOWN_COST_ITEM, expected_quantity: 1, expected_unit_cost: 9,
          corrected_item_id: null, corrected_quantity: 0, corrected_unit_cost: null,
        }]),
      ],
    );
    assert.equal(Number(await scalar(
      `select unit_cost from public.inventory where id=$1`, [UNKNOWN_COST_ITEM],
    )), 7, 'voiding a newer known receipt must reveal the saved estimate behind an older unknown receipt');

    await pg.query(
      `select public.staxis_receive_inventory_delivery(
         $1,$2,now(),'Vendor','Create pool item',$3::jsonb
       )`,
      [
        PROP_A,
        '75000000-0000-4000-8000-000000000101',
        JSON.stringify([{
          line_key: 'created', item_id: null, item_name: 'Pool Towels',
          category: 'housekeeping', unit: 'each', par_level: 10,
          quantity: 4, unit_cost: null, custom_category_id: CUSTOM_CATEGORY, set_aside: 2,
        }]),
      ],
    );
    assert.equal(Number(await scalar(
      `select current_stock from public.inventory where property_id=$1 and name='Pool Towels'`,
      [PROP_A],
    )), 4);
    assert.equal(Number(await scalar(
      `select set_aside from public.inventory where property_id=$1 and name='Pool Towels'`,
      [PROP_A],
    )), 2);
    assert.equal(await scalar(
      `select custom_category_id::text from public.inventory where property_id=$1 and name='Pool Towels'`,
      [PROP_A],
    ), CUSTOM_CATEGORY);
    assert.equal(await scalar(
      `select delivery_cache_active from public.inventory where property_id=$1 and name='Pool Towels'`,
      [PROP_A],
    ), true);
    assert.equal(await scalar(
      `select unit_cost from public.inventory where property_id=$1 and name='Pool Towels'`,
      [PROP_A],
    ), null);

    const createdRoot = await scalar<string>(
      `select id from public.inventory_orders where property_id=$1 and notes='Create pool item'`,
      [PROP_A],
    );
    await assert.rejects(
      pg.query(
        `select public.staxis_correct_inventory_delivery(
           $1,$2,now(),'Maria','Void reserved stock',$3::jsonb
         )`,
        [
          PROP_A,
          '75000000-0000-4000-8000-000000000108',
          JSON.stringify([{
            line_key: 'created', order_id: createdRoot,
            expected_item_id: await scalar<string>(
              `select id::text from public.inventory where property_id=$1 and name='Pool Towels'`,
              [PROP_A],
            ),
            expected_quantity: 4, expected_unit_cost: null,
            corrected_item_id: null, corrected_quantity: 0, corrected_unit_cost: null,
          }]),
        ],
      ),
      /below set-aside stock|22023/i,
    );

    const createdItemId = await scalar<string>(
      `select id::text from public.inventory where property_id=$1 and name='Pool Towels'`,
      [PROP_A],
    );
    await pg.query(
      `select public.staxis_save_inventory_count($1,$2,now(),'Counter',$3::jsonb)`,
      [
        PROP_A,
        '75000000-0000-4000-8000-000000000109',
        JSON.stringify([{ item_id: createdItemId, expected_stock: 4, counted_stock: 0 }]),
      ],
    );
    await pg.query('set role authenticated');
    try {
      await assert.rejects(
        pg.query(
          `update public.inventory set archived_at=now(),archived_by=$2
           where id=$1 and property_id=$3`,
          [createdItemId, USER_A, PROP_A],
        ),
        /reduce set-aside stock to zero|23514/i,
      );
    } finally {
      await pg.query('reset role');
    }
    await pg.query(`update public.inventory set set_aside=0 where id=$1`, [createdItemId]);

    await pg.query(
      `insert into public.capability_overrides(property_id,capability,role,allowed)
       values ($1,'view_financials','owner',false)`,
      [PROP_A],
    );
    try {
      await assert.rejects(
        pg.query(
          `select public.staxis_receive_inventory_delivery(
             $1,$2,now(),'Vendor','Forbidden cost',$3::jsonb
           )`,
          [
            PROP_A,
            '75000000-0000-4000-8000-000000000102',
            JSON.stringify([{
              line_key: 'cost', item_id: UNKNOWN_COST_ITEM, quantity: 1, unit_cost: 9,
            }]),
          ],
        ),
        /not authorized to set inventory delivery cost|42501/i,
      );
      await pg.query(
        `select public.staxis_receive_inventory_delivery(
           $1,$2,now(),'Vendor','Quantity only',$3::jsonb
         )`,
        [
          PROP_A,
          '75000000-0000-4000-8000-000000000103',
          JSON.stringify([{
            line_key: 'quantity-only', item_id: UNKNOWN_COST_ITEM, quantity: 1, unit_cost: null,
          }]),
        ],
      );
      assert.equal(await scalar(
        `select total_cost from public.inventory_orders
         where property_id=$1 and notes='Quantity only'`,
        [PROP_A],
      ), null);
    } finally {
      await pg.query(
        `delete from public.capability_overrides
         where property_id=$1 and capability='view_financials' and role='owner'`,
        [PROP_A],
      );
    }
  });

  test('a fully voided numbered invoice can be re-entered once with an audit link', async () => {
    const notes = 'Invoice scan · inv#RETRY-100';
    await pg.query(
      `select public.staxis_receive_inventory_delivery($1,$2,now(),'Vendor',$3,$4::jsonb)`,
      [
        PROP_A, '75000000-0000-4000-8000-000000000104', notes,
        JSON.stringify([{
          line_key: 'invoice', item_id: UNKNOWN_COST_ITEM, quantity: 1, unit_cost: 7,
        }]),
      ],
    );
    const root = await scalar<string>(
      `select id from public.inventory_orders where property_id=$1 and notes=$2`,
      [PROP_A, notes],
    );
    await pg.query(
      `select public.staxis_correct_inventory_delivery(
         $1,$2,now(),'Maria','Invoice was not ours',$3::jsonb
       )`,
      [
        PROP_A,
        '75000000-0000-4000-8000-000000000105',
        JSON.stringify([{
          line_key: 'invoice', order_id: root,
          expected_item_id: UNKNOWN_COST_ITEM, expected_quantity: 1, expected_unit_cost: 7,
          corrected_item_id: null, corrected_quantity: 0, corrected_unit_cost: null,
        }]),
      ],
    );
    await pg.query(
      `select public.staxis_receive_inventory_delivery($1,$2,now(),'Vendor',$3,$4::jsonb)`,
      [
        PROP_A, '75000000-0000-4000-8000-000000000106', notes,
        JSON.stringify([{
          line_key: 'replacement', item_id: UNKNOWN_COST_ITEM, quantity: 1, unit_cost: 7,
        }]),
      ],
    );
    assert.equal(Number(await scalar(
      `select count(*) from public.inventory_delivery_reentries
       where property_id=$1 and replacement_request_id=$2`,
      [PROP_A, '75000000-0000-4000-8000-000000000106'],
    )), 1);
    await assert.rejects(
      pg.query(
        `select public.staxis_receive_inventory_delivery($1,$2,now(),'Vendor',$3,$4::jsonb)`,
        [
          PROP_A, '75000000-0000-4000-8000-000000000107', notes,
          JSON.stringify([{
            line_key: 'duplicate', item_id: UNKNOWN_COST_ITEM, quantity: 1, unit_cost: 7,
          }]),
        ],
      ),
      /already received|23505/i,
    );
  });

  test('a backdated delivery logged after a count still receives its stock correction', async () => {
    await pg.query(
      `select public.staxis_save_inventory_count($1,$2,now(),'Counter',$3::jsonb)`,
      [
        PROP_A,
        '75000000-0000-4000-8000-000000000085',
        JSON.stringify([{ item_id: BACKDATED_ITEM, expected_stock: 10, counted_stock: 10 }]),
      ],
    );
    await pg.query(
      `select public.staxis_receive_inventory_delivery(
         $1,$2,'2026-07-18T12:00:00Z','Vendor','Backdated after count',$3::jsonb
       )`,
      [
        PROP_A,
        '75000000-0000-4000-8000-000000000086',
        JSON.stringify([{
          line_key: 'backdated', item_id: BACKDATED_ITEM, quantity: 5, unit_cost: 1,
        }]),
      ],
    );
    const orderId = await scalar<string>(
      `select id from public.inventory_orders where property_id=$1 and notes='Backdated after count'`,
      [PROP_A],
    );
    await pg.query(
      `select public.staxis_correct_inventory_delivery($1,$2,now(),'Maria','Backdated quantity fix',$3::jsonb)`,
      [
        PROP_A,
        '75000000-0000-4000-8000-000000000087',
        JSON.stringify([{
          line_key: 'backdated', order_id: orderId,
          expected_item_id: BACKDATED_ITEM, expected_quantity: 5, expected_unit_cost: 1,
          corrected_item_id: BACKDATED_ITEM, corrected_quantity: 3, corrected_unit_cost: 1,
        }]),
      ],
    );
    assert.equal(Number(await scalar(
      `select current_stock from public.inventory where id=$1`, [BACKDATED_ITEM],
    )), 13);
  });

  test('moving and voiding deliveries recomputes live cost/vendor metadata without clobbering newer receipts', async () => {
    await pg.query(
      `select public.staxis_receive_inventory_delivery(
         $1,$2,'2026-07-19T10:00:00Z','Wrong Vendor','Metadata move root',$3::jsonb
       )`,
      [
        PROP_A,
        '75000000-0000-4000-8000-000000000088',
        JSON.stringify([{
          line_key: 'move', item_id: METADATA_ITEM_A, quantity: 4, unit_cost: 4,
        }]),
      ],
    );
    const movedRoot = await scalar<string>(
      `select id from public.inventory_orders where property_id=$1 and notes='Metadata move root'`,
      [PROP_A],
    );
    await pg.query('set role authenticated');
    try {
      await pg.query(
        `update public.inventory set unit_cost=7,vendor_name='Configured Vendor'
         where id=$1 and property_id=$2`,
        [METADATA_ITEM_A, PROP_A],
      );
    } finally {
      await pg.query('reset role');
    }
    await pg.query(
      `select public.staxis_correct_inventory_delivery($1,$2,now(),'Maria','Wrong item',$3::jsonb)`,
      [
        PROP_A,
        '75000000-0000-4000-8000-000000000089',
        JSON.stringify([{
          line_key: 'move', order_id: movedRoot,
          expected_item_id: METADATA_ITEM_A, expected_quantity: 4, expected_unit_cost: 4,
          corrected_item_id: METADATA_ITEM_B, corrected_quantity: 4, corrected_unit_cost: 6,
        }]),
      ],
    );
    assert.equal(Number(await scalar(`select unit_cost from public.inventory where id=$1`, [METADATA_ITEM_A])), 7);
    assert.equal(await scalar(`select vendor_name from public.inventory where id=$1`, [METADATA_ITEM_A]), 'Configured Vendor');
    assert.equal(Number(await scalar(`select unit_cost from public.inventory where id=$1`, [METADATA_ITEM_B])), 6);

    await pg.query(
      `select public.staxis_receive_inventory_delivery(
         $1,$2,'2026-07-19T11:00:00Z','New Vendor','Metadata newer root',$3::jsonb
       )`,
      [
        PROP_A,
        '75000000-0000-4000-8000-000000000090',
        JSON.stringify([{
          line_key: 'newer', item_id: METADATA_ITEM_B, quantity: 1, unit_cost: 8,
        }]),
      ],
    );
    const newerRoot = await scalar<string>(
      `select id from public.inventory_orders where property_id=$1 and notes='Metadata newer root'`,
      [PROP_A],
    );
    await pg.query(
      `select public.staxis_correct_inventory_delivery($1,$2,now(),'Maria','Void older moved root',$3::jsonb)`,
      [
        PROP_A,
        '75000000-0000-4000-8000-000000000091',
        JSON.stringify([{
          line_key: 'void-older', order_id: movedRoot,
          expected_item_id: METADATA_ITEM_B, expected_quantity: 4, expected_unit_cost: 6,
          corrected_item_id: null, corrected_quantity: 0, corrected_unit_cost: null,
        }]),
      ],
    );
    assert.equal(Number(await scalar(`select current_stock from public.inventory where id=$1`, [METADATA_ITEM_B])), 1);
    assert.equal(Number(await scalar(`select unit_cost from public.inventory where id=$1`, [METADATA_ITEM_B])), 8);
    assert.equal(await scalar(`select vendor_name from public.inventory where id=$1`, [METADATA_ITEM_B]), 'New Vendor');

    await pg.query(
      `select public.staxis_correct_inventory_delivery($1,$2,now(),'Maria','Void latest root',$3::jsonb)`,
      [
        PROP_A,
        '75000000-0000-4000-8000-000000000092',
        JSON.stringify([{
          line_key: 'void-newer', order_id: newerRoot,
          expected_item_id: METADATA_ITEM_B, expected_quantity: 1, expected_unit_cost: 8,
          corrected_item_id: null, corrected_quantity: 0, corrected_unit_cost: null,
        }]),
      ],
    );
    assert.equal(Number(await scalar(`select current_stock from public.inventory where id=$1`, [METADATA_ITEM_B])), 0);
    assert.equal(Number(await scalar(`select unit_cost from public.inventory where id=$1`, [METADATA_ITEM_B])), 9);
    assert.equal(await scalar(`select vendor_name from public.inventory where id=$1`, [METADATA_ITEM_B]), null);
    await pg.query('set role authenticated');
    try {
      await pg.query(
        `update public.inventory set archived_at=now(),archived_by=$2 where id=$1 and property_id=$3`,
        [METADATA_ITEM_B, USER_A, PROP_A],
      );
    } finally {
      await pg.query('reset role');
    }
    assert.ok(await scalar(
      `select archived_at is not null from public.inventory where id=$1`, [METADATA_ITEM_B],
    ));
  });

  test('an archived root can repair its invoice cost but no delivery can move into another archived item', async () => {
    await pg.query(
      `select public.staxis_receive_inventory_delivery(
         $1,$2,now(),'Vendor','Archived ledger root',$3::jsonb
       )`,
      [
        PROP_A,
        '75000000-0000-4000-8000-000000000122',
        JSON.stringify([{
          line_key: 'archived-ledger', item_id: ARCHIVED_LEDGER_ITEM, quantity: 2, unit_cost: 4,
        }]),
      ],
    );
    const archivedRoot = await scalar<string>(
      `select id from public.inventory_orders where property_id=$1 and notes='Archived ledger root'`,
      [PROP_A],
    );
    await pg.query(
      `select public.staxis_save_inventory_count($1,$2,now(),'Counter',$3::jsonb)`,
      [
        PROP_A,
        '75000000-0000-4000-8000-000000000123',
        JSON.stringify([{
          item_id: ARCHIVED_LEDGER_ITEM, expected_stock: 2, counted_stock: 0,
        }]),
      ],
    );
    await pg.query('set role authenticated');
    try {
      await pg.query(
        `update public.inventory set archived_at=now(),archived_by=$2
         where id=$1 and property_id=$3`,
        [ARCHIVED_LEDGER_ITEM, USER_A, PROP_A],
      );
    } finally {
      await pg.query('reset role');
    }

    await pg.query(
      `select public.staxis_correct_inventory_delivery(
         $1,$2,now(),'Maria','Repair archived invoice cost',$3::jsonb
       )`,
      [
        PROP_A,
        '75000000-0000-4000-8000-000000000124',
        JSON.stringify([{
          line_key: 'archived-ledger', order_id: archivedRoot,
          expected_item_id: ARCHIVED_LEDGER_ITEM, expected_quantity: 2, expected_unit_cost: 4,
          corrected_item_id: ARCHIVED_LEDGER_ITEM, corrected_quantity: 2, corrected_unit_cost: 5,
        }]),
      ],
    );
    assert.equal(Number(await scalar(
      `select current_stock from public.inventory where id=$1`, [ARCHIVED_LEDGER_ITEM],
    )), 0);
    assert.equal(Number(await scalar(
      `select jsonb_array_length(stock_effect) from public.inventory_delivery_corrections
       where original_order_id=$1 order by created_at desc,id desc limit 1`,
      [archivedRoot],
    )), 0);
    assert.equal(Number(await scalar(
      `select sum(total_cost) from public.inventory_orders where id=$1 or corrects_order_id=$1`,
      [archivedRoot],
    )), 10);

    await pg.query(
      `select public.staxis_receive_inventory_delivery(
         $1,$2,now(),'Vendor','Move source root',$3::jsonb
       )`,
      [
        PROP_A,
        '75000000-0000-4000-8000-000000000125',
        JSON.stringify([{
          line_key: 'move-source', item_id: MOVE_SOURCE_ITEM, quantity: 1, unit_cost: 3,
        }]),
      ],
    );
    const moveRoot = await scalar<string>(
      `select id from public.inventory_orders where property_id=$1 and notes='Move source root'`,
      [PROP_A],
    );
    await assert.rejects(
      pg.query(
        `select public.staxis_correct_inventory_delivery(
           $1,$2,now(),'Maria','Do not revive archived target',$3::jsonb
         )`,
        [
          PROP_A,
          '75000000-0000-4000-8000-000000000126',
          JSON.stringify([{
            line_key: 'move-source', order_id: moveRoot,
            expected_item_id: MOVE_SOURCE_ITEM, expected_quantity: 1, expected_unit_cost: 3,
            corrected_item_id: ARCHIVED_LEDGER_ITEM, corrected_quantity: 1, corrected_unit_cost: 3,
          }]),
        ],
      ),
      /not available for this property|P0002/i,
    );
    assert.equal(Number(await scalar(
      `select current_stock from public.inventory where id=$1`, [MOVE_SOURCE_ITEM],
    )), 1);
    assert.equal(Number(await scalar(
      `select count(*) from public.inventory_delivery_corrections where original_order_id=$1`,
      [moveRoot],
    )), 0);
  });

  test('correction chains preserve roots, net totals, audit evidence, and idempotency', async () => {
    const deliveryRequest = '75000000-0000-4000-8000-000000000010';
    await pg.query(
      `select public.staxis_receive_inventory_delivery(
         $1,$2,'2026-07-19T10:00:00Z','Vendor','Manual delivery',$3::jsonb
       )`,
      [PROP_A, deliveryRequest, JSON.stringify([{ line_key: 'towels', item_id: DELIVERY_ITEM, quantity: 5, unit_cost: 2 }])],
    );
    const orderId = await scalar<string>(
      `select id from public.inventory_orders where property_id=$1 and notes='Manual delivery'`,
      [PROP_A],
    );

    const firstRequest = '75000000-0000-4000-8000-000000000011';
    const firstCorrectedAt = new Date().toISOString();
    const firstLines = JSON.stringify([{
      line_key: 'towels', order_id: orderId,
      expected_item_id: DELIVERY_ITEM, expected_quantity: 5, expected_unit_cost: 2,
      corrected_item_id: DELIVERY_ITEM, corrected_quantity: 3, corrected_unit_cost: 2,
    }]);
    for (let i = 0; i < 2; i += 1) {
      await pg.query(
        `select public.staxis_correct_inventory_delivery($1,$2,$3,'Maria','Wrong quantity',$4::jsonb)`,
        [PROP_A, firstRequest, firstCorrectedAt, firstLines],
      );
    }
    assert.equal(Number(await scalar('select current_stock from public.inventory where id=$1', [DELIVERY_ITEM])), 13);
    assert.equal(Number(await scalar('select count(*) from public.inventory_delivery_corrections where original_order_id=$1', [orderId])), 1);
    assert.equal(Number(await scalar(
      `select sum(quantity) from public.inventory_orders where id=$1 or corrects_order_id=$1`,
      [orderId],
    )), 3);
    assert.equal(Number(await scalar(
      `select sum(total_cost) from public.inventory_orders where id=$1 or corrects_order_id=$1`,
      [orderId],
    )), 6);

    const secondLines = JSON.stringify([{
      line_key: 'towels', order_id: orderId,
      expected_item_id: DELIVERY_ITEM, expected_quantity: 3, expected_unit_cost: 2,
      corrected_item_id: DELIVERY_ITEM, corrected_quantity: 4, corrected_unit_cost: 2,
    }]);
    await pg.query(
      `select public.staxis_correct_inventory_delivery($1,$2,now(),'Maria','Second correction',$3::jsonb)`,
      [PROP_A, '75000000-0000-4000-8000-000000000012', secondLines],
    );
    assert.equal(Number(await scalar('select current_stock from public.inventory where id=$1', [DELIVERY_ITEM])), 14);
    assert.equal(Number(await scalar(
      `select sum(quantity) from public.inventory_orders where id=$1 or corrects_order_id=$1`,
      [orderId],
    )), 4);
    assert.equal(
      await scalar<string>(
        `select prior_correction_id::text from public.inventory_delivery_corrections
         where original_order_id=$1 order by created_at desc,id desc limit 1`,
        [orderId],
      ),
      await scalar<string>(
        `select id::text from public.inventory_delivery_corrections
         where original_order_id=$1 order by created_at asc,id asc limit 1`,
        [orderId],
      ),
    );

    await assert.rejects(
      pg.query(
        `select public.staxis_correct_inventory_delivery($1,$2,$3,'Maria','Changed payload',$4::jsonb)`,
        [PROP_A, firstRequest, firstCorrectedAt, secondLines],
      ),
      /different operation or payload|22023/i,
    );
  });

  test('nonfinancial staff get cost-free correction history and cannot alter delivery money', async () => {
    const orderId = await scalar<string>(
      `select id from public.inventory_orders where property_id=$1 and notes='Manual delivery'`,
      [PROP_A],
    );
    await pg.query(
      `insert into public.capability_overrides(property_id,capability,role,allowed)
       values ($1,'view_financials','owner',false)`,
      [PROP_A],
    );
    try {
      const safe = await scalar<unknown>(
        `select public.staxis_list_inventory_delivery_corrections($1,array[$2]::uuid[],false)`,
        [PROP_A, orderId],
      );
      assert.ok(Array.isArray(safe) && safe.length === 2);
      const row = safe[0] as Record<string, unknown>;
      assert.equal('previous_unit_cost' in row, false);
      assert.equal('corrected_total_cost' in row, false);

      await assert.rejects(
        pg.query(
          `select public.staxis_list_inventory_delivery_corrections($1,array[$2]::uuid[],true)`,
          [PROP_A, orderId],
        ),
        /not authorized to view inventory delivery costs|42501/i,
      );
      await assert.rejects(
        pg.query(
          `select public.staxis_correct_inventory_delivery($1,$2,now(),'Maria','No finance access',$3::jsonb)`,
          [
            PROP_A,
            '75000000-0000-4000-8000-000000000019',
            JSON.stringify([{
              line_key: 'denied', order_id: orderId,
              expected_item_id: DELIVERY_ITEM, expected_quantity: 4, expected_unit_cost: 2,
              corrected_item_id: DELIVERY_ITEM, corrected_quantity: 3, corrected_unit_cost: 2,
            }]),
          ],
        ),
        /not authorized to correct inventory deliveries|42501/i,
      );

      await pg.query('set role authenticated');
      try {
        await assert.rejects(
          pg.query(`select previous_unit_cost from public.inventory_delivery_corrections limit 1`),
          /permission denied|row-level security/i,
        );
      } finally {
        await pg.query('reset role');
      }
    } finally {
      await pg.query(
        `delete from public.capability_overrides
         where property_id=$1 and capability='view_financials' and role='owner'`,
        [PROP_A],
      );
    }
  });

  test('multi-line corrections reset row state and insufficient stock rolls the request back', async () => {
    await pg.query(
      `select public.staxis_receive_inventory_delivery(
         $1,$2,'2026-07-19T09:00:00Z','Vendor','Multi delivery',$3::jsonb
       )`,
      [
        PROP_A,
        '75000000-0000-4000-8000-000000000040',
        JSON.stringify([
          { line_key: 'target', item_id: TARGET_ITEM, quantity: 2, unit_cost: 5 },
          { line_key: 'loss', item_id: LOSS_ITEM, quantity: 1, unit_cost: 2 },
        ]),
      ],
    );
    const targetOrder = await scalar<string>(
      `select id from public.inventory_orders where notes='Multi delivery' and item_id=$1`,
      [TARGET_ITEM],
    );
    const lossOrder = await scalar<string>(
      `select id from public.inventory_orders where notes='Multi delivery' and item_id=$1`,
      [LOSS_ITEM],
    );
    const lines = JSON.stringify([
      {
        line_key: 'target', order_id: targetOrder,
        expected_item_id: TARGET_ITEM, expected_quantity: 2, expected_unit_cost: 5,
        corrected_item_id: TARGET_ITEM, corrected_quantity: 1, corrected_unit_cost: 5,
      },
      {
        line_key: 'loss', order_id: lossOrder,
        expected_item_id: LOSS_ITEM, expected_quantity: 1, expected_unit_cost: 2,
        corrected_item_id: null, corrected_quantity: 0, corrected_unit_cost: null,
      },
    ]);
    await pg.query(
      `select public.staxis_correct_inventory_delivery($1,$2,$3,'Maria','Multi-line correction',$4::jsonb)`,
      [PROP_A, '75000000-0000-4000-8000-000000000041', new Date().toISOString(), lines],
    );
    const evidence = await pg.query(
      `select original_order_id::text,previous_item_id::text,correction_kind
       from public.inventory_delivery_corrections
       where request_id=$1 order by line_key`,
      ['75000000-0000-4000-8000-000000000041'],
    ) as { rows: Array<Record<string, unknown>> };
    assert.deepEqual(evidence.rows, [
      { original_order_id: lossOrder, previous_item_id: LOSS_ITEM, correction_kind: 'void' },
      { original_order_id: targetOrder, previous_item_id: TARGET_ITEM, correction_kind: 'correction' },
    ]);
    assert.equal(Number(await scalar('select current_stock from public.inventory where id=$1', [TARGET_ITEM])), 5);
    assert.equal(Number(await scalar('select current_stock from public.inventory where id=$1', [LOSS_ITEM])), 8);

    // A later non-count movement can leave less stock than the still-effective
    // delivery. Never clamp or go negative: reject the entire void request.
    await pg.query(
      `select public.staxis_record_inventory_loss($1,$2,now(),'Maria',$3,5,5,'damaged','Removed')`,
      [PROP_A, '75000000-0000-4000-8000-000000000042', TARGET_ITEM],
    );
    const voidTarget = JSON.stringify([{
      line_key: 'target', order_id: targetOrder,
      expected_item_id: TARGET_ITEM, expected_quantity: 1, expected_unit_cost: 5,
      corrected_item_id: null, corrected_quantity: 0, corrected_unit_cost: null,
    }]);
    await assert.rejects(
      pg.query(
        `select public.staxis_correct_inventory_delivery($1,$2,now(),'Maria','Void after loss',$3::jsonb)`,
        [PROP_A, '75000000-0000-4000-8000-000000000043', voidTarget],
      ),
      /below set-aside stock|make current stock negative|count the item first|22023/i,
    );
    assert.equal(Number(await scalar('select current_stock from public.inventory where id=$1', [TARGET_ITEM])), 0);
    assert.equal(Number(await scalar(
      'select count(*) from public.inventory_delivery_corrections where original_order_id=$1',
      [targetOrder],
    )), 1);
  });

  test('a newer physical count supersedes stock arithmetic while voiding the ledger', async () => {
    const orderId = await scalar<string>(
      `select id from public.inventory_orders where property_id=$1 and notes='Manual delivery'`,
      [PROP_A],
    );
    await pg.query(
      `select public.staxis_save_inventory_count($1,$2,now(),'Counter',$3::jsonb)`,
      [
        PROP_A,
        '75000000-0000-4000-8000-000000000013',
        JSON.stringify([{ item_id: DELIVERY_ITEM, expected_stock: 14, counted_stock: 7 }]),
      ],
    );
    const voidLines = JSON.stringify([{
      line_key: 'towels', order_id: orderId,
      expected_item_id: DELIVERY_ITEM, expected_quantity: 4, expected_unit_cost: 2,
      corrected_item_id: null, corrected_quantity: 0, corrected_unit_cost: null,
    }]);
    await pg.query(
      `select public.staxis_correct_inventory_delivery($1,$2,now(),'Maria','Delivery never arrived',$3::jsonb)`,
      [PROP_A, '75000000-0000-4000-8000-000000000014', voidLines],
    );
    assert.equal(Number(await scalar('select current_stock from public.inventory where id=$1', [DELIVERY_ITEM])), 7);
    assert.equal(Number(await scalar(
      `select sum(quantity) from public.inventory_orders where id=$1 or corrects_order_id=$1`,
      [orderId],
    )), 0);
    assert.equal(
      await scalar<string>(
        `select stock_effect->0->>'reason' from public.inventory_delivery_corrections
         where original_order_id=$1 order by created_at desc,id desc limit 1`,
        [orderId],
      ),
      'newer_count_supersedes_receipt',
    );

    // Void is deliberately terminal. A reinstatement is a new delivery, not a
    // mutation of a root explicitly declared never received.
    await assert.rejects(
      pg.query(
        `select public.staxis_correct_inventory_delivery($1,$2,now(),'Maria','Restore void',$3::jsonb)`,
        [
          PROP_A,
          '75000000-0000-4000-8000-000000000015',
          JSON.stringify([{
            line_key: 'towels', order_id: orderId,
            expected_item_id: DELIVERY_ITEM, expected_quantity: 0, expected_unit_cost: null,
            corrected_item_id: DELIVERY_ITEM, corrected_quantity: 4, corrected_unit_cost: 2,
          }]),
        ],
      ),
      /already voided; add a new delivery instead|23514/i,
    );
  });

  test('delivery correction rejects a root from another hotel scope', async () => {
    const orderId = await scalar<string>(
      `select id from public.inventory_orders where property_id=$1 and notes='Manual delivery'`,
      [PROP_A],
    );
    await assert.rejects(
      pg.query(
        `select public.staxis_correct_inventory_delivery($1,$2,now(),'Wrong hotel','No access',$3::jsonb)`,
        [
          PROP_B,
          '75000000-0000-4000-8000-000000000016',
          JSON.stringify([{
            line_key: 'foreign', order_id: orderId,
            expected_item_id: DELIVERY_ITEM, expected_quantity: 0, expected_unit_cost: null,
            corrected_item_id: null, corrected_quantity: 0, corrected_unit_cost: null,
          }]),
        ],
      ),
      /not authorized|42501/i,
    );
  });

  test('closed-month correction fails atomically after all provisional effects roll back', async () => {
    const orderId = await scalar<string>(
      `select id from public.inventory_orders where property_id=$1 and notes='Closed delivery'`,
      [PROP_A],
    );
    const before = Number(await scalar('select current_stock from public.inventory where id=$1', [CLOSED_ITEM]));
    const lines = JSON.stringify([{
      line_key: 'closed', order_id: orderId,
      expected_item_id: CLOSED_ITEM, expected_quantity: 2, expected_unit_cost: 2,
      corrected_item_id: null, corrected_quantity: 0, corrected_unit_cost: null,
    }]);
    await assert.rejects(
      pg.query(
        `select public.staxis_correct_inventory_delivery($1,$2,now(),'Maria','Wrong closed delivery',$3::jsonb)`,
        [PROP_A, '75000000-0000-4000-8000-000000000020', lines],
      ),
      /closed month|23514/i,
    );
    assert.equal(Number(await scalar('select current_stock from public.inventory where id=$1', [CLOSED_ITEM])), before);
    assert.equal(Number(await scalar(
      'select count(*) from public.inventory_delivery_corrections where original_order_id=$1',
      [orderId],
    )), 0);
    assert.equal(Number(await scalar(
      'select count(*) from public.inventory_write_receipts where request_id=$1',
      ['75000000-0000-4000-8000-000000000020'],
    )), 0);
  });

  test('month close freezes corrected net purchase quantity and dollars', async () => {
    const openingSnapshot = '74000000-0000-4000-8000-000000000020';
    await pg.query(
      `insert into public.inventory_month_close_snapshots(id,property_id,kind,captured_at)
       values ($1,$2,'baseline','2026-06-01T00:00:00Z')`,
      [openingSnapshot, PROP_CLOSE],
    );
    await pg.query(
      `insert into public.inventory_month_close_snapshot_items(
         snapshot_id,property_id,item_id,item_name,category,budget_key,quantity,set_aside,
         unit_cost_cents,physical_unit_cost_cents,value_cents,counted_at,valuation_method
       ) values ($1,$2,$3,'Close Correction Towels','housekeeping','housekeeping',5,0,100,100,500,
         '2026-06-01T00:00:00Z','baseline_saved_cost')`,
      [openingSnapshot, PROP_CLOSE, CLOSE_CORRECTION_ITEM],
    );
    await pg.query(
      `insert into public.inventory_month_closes(
         property_id,month_start,timezone,status,month_start_at,end_at,grace_end_at,
         count_window_start_at,activity_start_at,is_partial,budget_comparison_available,
         opening_snapshot_id,beginning_value_cents,baseline_at,start_request_id
       ) values (
         $1,'2026-06-01','UTC','open','2026-06-01T00:00:00Z','2026-07-01T00:00:00Z',
         '2026-07-04T00:00:00Z','2026-06-30T00:00:00Z','2026-06-01T00:00:00Z',
         false,true,$2,500,'2026-06-01T00:00:00Z',$3
       )`,
      [PROP_CLOSE, openingSnapshot, '75000000-0000-4000-8000-000000000050'],
    );
    await pg.query(
      `select public.staxis_receive_inventory_delivery(
         $1,$2,'2026-06-15T12:00:00Z','Vendor','June correction close',$3::jsonb
       )`,
      [
        PROP_CLOSE,
        '75000000-0000-4000-8000-000000000051',
        JSON.stringify([{
          line_key: 'close', item_id: CLOSE_CORRECTION_ITEM, quantity: 5, unit_cost: null,
        }]),
      ],
    );
    const orderId = await scalar<string>(
      `select id from public.inventory_orders where property_id=$1 and notes='June correction close'`,
      [PROP_CLOSE],
    );
    await pg.query(
      `select public.staxis_correct_inventory_delivery($1,$2,now(),'Maria','June quantity fix',$3::jsonb)`,
      [
        PROP_CLOSE,
        '75000000-0000-4000-8000-000000000052',
        JSON.stringify([{
          line_key: 'close', order_id: orderId,
          expected_item_id: CLOSE_CORRECTION_ITEM, expected_quantity: 5, expected_unit_cost: null,
          corrected_item_id: CLOSE_CORRECTION_ITEM, corrected_quantity: 3, corrected_unit_cost: 1,
        }]),
      ],
    );
    assert.equal(Number(await scalar(
      `select unit_cost from public.inventory where id=$1`, [CLOSE_CORRECTION_ITEM],
    )), 1, 'latest corrected delivery cost must repair the live item cache');

    await pg.query(
      `select public.staxis_correct_inventory_delivery($1,$2,now(),'Maria','Invoice price is unknown',$3::jsonb)`,
      [
        PROP_CLOSE,
        '75000000-0000-4000-8000-000000000053',
        JSON.stringify([{
          line_key: 'close-unknown', order_id: orderId,
          expected_item_id: CLOSE_CORRECTION_ITEM, expected_quantity: 3, expected_unit_cost: 1,
          corrected_item_id: CLOSE_CORRECTION_ITEM, corrected_quantity: 3, corrected_unit_cost: null,
        }]),
      ],
    );
    await pg.query(`select set_config('request.jwt.claim.role', 'service_role', false)`);
    try {
      await assert.rejects(
        pg.query(
          `select public.staxis_close_inventory_month_close(
             $1,'2026-06-01',$2,'logged_deliveries',null,$3,'Maria','Must not fake zero'
           )`,
          [PROP_CLOSE, '75000000-0000-4000-8000-000000000054', USER_A],
        ),
        /no usable cost|22023/i,
      );
    } finally {
      await pg.query(`select set_config('request.jwt.claim.role', 'authenticated', false)`);
    }
    await pg.query(
      `select public.staxis_correct_inventory_delivery($1,$2,now(),'Maria','Confirmed invoice price',$3::jsonb)`,
      [
        PROP_CLOSE,
        '75000000-0000-4000-8000-000000000055',
        JSON.stringify([{
          line_key: 'close-known', order_id: orderId,
          expected_item_id: CLOSE_CORRECTION_ITEM, expected_quantity: 3, expected_unit_cost: null,
          corrected_item_id: CLOSE_CORRECTION_ITEM, corrected_quantity: 3, corrected_unit_cost: 1,
        }]),
      ],
    );

    // A genuinely uncosted delivery that is voided is complete $0 evidence,
    // not a missing price and not a fake zero. The prior effective receipt
    // also becomes the live metadata source again.
    await pg.query(`update public.inventory set unit_cost=null where id=$1`, [CLOSE_CORRECTION_ITEM]);
    await pg.query(
      `select public.staxis_receive_inventory_delivery(
         $1,$2,'2026-06-20T12:00:00Z','Wrong Vendor','June uncosted void',$3::jsonb
       )`,
      [
        PROP_CLOSE,
        '75000000-0000-4000-8000-000000000056',
        JSON.stringify([{
          line_key: 'void-close', item_id: CLOSE_CORRECTION_ITEM, quantity: 2, unit_cost: null,
        }]),
      ],
    );
    const voidOrderId = await scalar<string>(
      `select id from public.inventory_orders where property_id=$1 and notes='June uncosted void'`,
      [PROP_CLOSE],
    );
    await pg.query(
      `select public.staxis_correct_inventory_delivery($1,$2,now(),'Maria','Delivery never arrived',$3::jsonb)`,
      [
        PROP_CLOSE,
        '75000000-0000-4000-8000-000000000057',
        JSON.stringify([{
          line_key: 'void-close', order_id: voidOrderId,
          expected_item_id: CLOSE_CORRECTION_ITEM, expected_quantity: 2, expected_unit_cost: null,
          corrected_item_id: null, corrected_quantity: 0, corrected_unit_cost: null,
        }]),
      ],
    );
    assert.equal(Number(await scalar(
      `select unit_cost from public.inventory where id=$1`, [CLOSE_CORRECTION_ITEM],
    )), 1, 'voiding the latest delivery must restore prior effective metadata');

    await pg.query(
      `select public.staxis_save_inventory_count(
         $1,$2,'2026-06-30T12:00:00Z','Counter',$3::jsonb
       )`,
      [
        PROP_CLOSE,
        '75000000-0000-4000-8000-000000000058',
        JSON.stringify([
          { item_id: CLOSE_CORRECTION_ITEM, expected_stock: 8, counted_stock: 8 },
          { item_id: CROSS_CLOSE_ITEM_A, expected_stock: 0, counted_stock: 0 },
          { item_id: CROSS_CLOSE_ITEM_B, expected_stock: 0, counted_stock: 2 },
        ]),
      ],
    );

    // A root logged after the ending count is backdated to A, then corrected
    // to B. The B compensation row must invalidate B's earlier count even
    // though its received_at retains the old business date.
    await pg.query(
      `select public.staxis_receive_inventory_delivery(
         $1,$2,'2026-06-25T12:00:00Z','Vendor','Cross close backdated',$3::jsonb
       )`,
      [
        PROP_CLOSE,
        '75000000-0000-4000-8000-000000000063',
        JSON.stringify([{
          line_key: 'cross-close', item_id: CROSS_CLOSE_ITEM_A, quantity: 2, unit_cost: 1,
        }]),
      ],
    );
    const crossRoot = await scalar<string>(
      `select id from public.inventory_orders where property_id=$1 and notes='Cross close backdated'`,
      [PROP_CLOSE],
    );
    await pg.query(
      `select public.staxis_correct_inventory_delivery($1,$2,now(),'Maria','Wrong cross-close item',$3::jsonb)`,
      [
        PROP_CLOSE,
        '75000000-0000-4000-8000-000000000064',
        JSON.stringify([{
          line_key: 'cross-close', order_id: crossRoot,
          expected_item_id: CROSS_CLOSE_ITEM_A, expected_quantity: 2, expected_unit_cost: 1,
          corrected_item_id: CROSS_CLOSE_ITEM_B, corrected_quantity: 2, corrected_unit_cost: 1,
        }]),
      ],
    );
    await pg.query(`select set_config('request.jwt.claim.role', 'service_role', false)`);
    try {
      await assert.rejects(
        pg.query(
          `select public.staxis_close_inventory_month_close(
             $1,'2026-06-01',$2,'logged_deliveries',null,$3,'Maria','Cross-item stale count'
           )`,
          [PROP_CLOSE, '75000000-0000-4000-8000-000000000065', USER_A],
        ),
        /delivery or discard occurred after the selected ending count|22023/i,
      );
    } finally {
      await pg.query(`select set_config('request.jwt.claim.role', 'authenticated', false)`);
    }
    await pg.query(
      `select public.staxis_save_inventory_count(
         $1,$2,'2026-06-30T12:30:00Z','Counter',$3::jsonb
       )`,
      [
        PROP_CLOSE,
        '75000000-0000-4000-8000-000000000066',
        JSON.stringify([
          { item_id: CLOSE_CORRECTION_ITEM, expected_stock: 8, counted_stock: 8 },
          { item_id: CROSS_CLOSE_ITEM_A, expected_stock: 0, counted_stock: 0 },
          { item_id: CROSS_CLOSE_ITEM_B, expected_stock: 2, counted_stock: 2 },
        ]),
      ],
    );

    // The loss occurred on June 29 but was committed after the June 30 count.
    // Close must use durable commit order and demand a fresh count instead of
    // accepting the caller's backdated occurrence timestamp.
    await pg.query(
      `select public.staxis_record_inventory_loss(
         $1,$2,'2026-06-29T12:00:00Z','Maria',$3,8,1,'missing','Found after count'
       )`,
      [PROP_CLOSE, '75000000-0000-4000-8000-000000000060', CLOSE_CORRECTION_ITEM],
    );
    await pg.query(`select set_config('request.jwt.claim.role', 'service_role', false)`);
    try {
      await assert.rejects(
        pg.query(
          `select public.staxis_close_inventory_month_close(
             $1,'2026-06-01',$2,'logged_deliveries',null,$3,'Maria','Stale count'
           )`,
          [PROP_CLOSE, '75000000-0000-4000-8000-000000000061', USER_A],
        ),
        /delivery or discard occurred after the selected ending count|22023/i,
      );
    } finally {
      await pg.query(`select set_config('request.jwt.claim.role', 'authenticated', false)`);
    }
    await pg.query(
      `select public.staxis_save_inventory_count(
         $1,$2,'2026-06-30T13:00:00Z','Counter',$3::jsonb
       )`,
      [
        PROP_CLOSE,
        '75000000-0000-4000-8000-000000000062',
        JSON.stringify([
          { item_id: CLOSE_CORRECTION_ITEM, expected_stock: 7, counted_stock: 7 },
          { item_id: CROSS_CLOSE_ITEM_A, expected_stock: 0, counted_stock: 0 },
          { item_id: CROSS_CLOSE_ITEM_B, expected_stock: 2, counted_stock: 2 },
        ]),
      ],
    );

    await pg.query(`select set_config('request.jwt.claim.role', 'service_role', false)`);
    try {
      await pg.query(
        `select public.staxis_close_inventory_month_close(
           $1,'2026-06-01',$2,'logged_deliveries',null,$3,'Maria','Corrected close'
         )`,
        [PROP_CLOSE, '75000000-0000-4000-8000-000000000059', USER_A],
      );
    } finally {
      await pg.query(`select set_config('request.jwt.claim.role', 'authenticated', false)`);
    }

    const close = await pg.query(
      `select logged_delivery_count,uncosted_delivery_count,logged_purchase_cents,
              confirmed_purchase_cents,actual_usage_cents
       from public.inventory_month_closes where property_id=$1 and month_start='2026-06-01'`,
      [PROP_CLOSE],
    ) as { rows: Array<Record<string, unknown>> };
    assert.deepEqual(close.rows[0], {
      logged_delivery_count: 3,
      uncosted_delivery_count: 0,
      logged_purchase_cents: 500,
      confirmed_purchase_cents: 500,
      actual_usage_cents: 100,
    });
    assert.equal(Number(await scalar(
      `select sum(quantity) from public.inventory_month_close_purchases p
       join public.inventory_month_closes c on c.id=p.close_id
       where c.property_id=$1 and c.month_start='2026-06-01'`,
      [PROP_CLOSE],
    )), 5);
    assert.equal(Number(await scalar(
      `select sum(value_cents) from public.inventory_month_close_purchases p
       join public.inventory_month_closes c on c.id=p.close_id
       where c.property_id=$1 and c.month_start='2026-06-01'`,
      [PROP_CLOSE],
    )), 500);
  });

  test('a never-stocked archived item closes at zero without invented count evidence', async () => {
    const openingSnapshot = '74000000-0000-4000-8000-000000000040';
    await pg.query(
      `insert into public.inventory_month_close_snapshots(id,property_id,kind,captured_at)
       values ($1,$2,'baseline','2026-06-01T00:00:00Z')`,
      [openingSnapshot, PROP_ARCHIVE_CLOSE],
    );
    await pg.query(
      `insert into public.inventory_month_close_snapshot_items(
         snapshot_id,property_id,item_id,item_name,category,budget_key,quantity,set_aside,
         unit_cost_cents,physical_unit_cost_cents,value_cents,counted_at,valuation_method
       ) values ($1,$2,$3,'Unused Archived Item','maintenance','maintenance',0,0,null,null,0,
         '2026-06-01T00:00:00Z','baseline_saved_cost')`,
      [openingSnapshot, PROP_ARCHIVE_CLOSE, NEVER_ARCHIVED_ITEM],
    );
    await pg.query(
      `insert into public.inventory_month_closes(
         property_id,month_start,timezone,status,month_start_at,end_at,grace_end_at,
         count_window_start_at,activity_start_at,is_partial,budget_comparison_available,
         opening_snapshot_id,beginning_value_cents,baseline_at,start_request_id
       ) values (
         $1,'2026-06-01','UTC','open','2026-06-01T00:00:00Z','2026-07-01T00:00:00Z',
         '2026-07-04T00:00:00Z','2026-06-30T00:00:00Z','2026-06-01T00:00:00Z',
         false,true,$2,0,'2026-06-01T00:00:00Z',$3
       )`,
      [PROP_ARCHIVE_CLOSE, openingSnapshot, '75000000-0000-4000-8000-000000000070'],
    );

    await pg.query(`select set_config('request.jwt.claim.role', 'service_role', false)`);
    try {
      await pg.query(
        `select public.staxis_close_inventory_month_close(
           $1,'2026-06-01',$2,'zero',null,$3,'Maria','Never stocked archive'
         )`,
        [PROP_ARCHIVE_CLOSE, '75000000-0000-4000-8000-000000000071', USER_A],
      );
    } finally {
      await pg.query(`select set_config('request.jwt.claim.role', 'authenticated', false)`);
    }

    assert.equal(Number(await scalar(
      `select actual_usage_cents from public.inventory_month_closes
       where property_id=$1 and month_start='2026-06-01'`,
      [PROP_ARCHIVE_CLOSE],
    )), 0);
    assert.equal(await scalar(
      `select si.valuation_method
       from public.inventory_month_close_snapshot_items si
       join public.inventory_month_closes c on c.ending_snapshot_id=si.snapshot_id
       where c.property_id=$1 and c.month_start='2026-06-01' and si.item_id=$2`,
      [PROP_ARCHIVE_CLOSE, NEVER_ARCHIVED_ITEM],
    ), 'archived_never_stocked');
  });

  test('archiving retains a real zero count, and archived stock leaves active totals', async () => {
    await pg.query(
      `select public.staxis_record_inventory_loss(
         $1,$2,now(),'Maria',$3,1,1,'damaged','Discard provenance'
       )`,
      [PROP_A, '75000000-0000-4000-8000-000000000093', DISCARD_PROVENANCE_ITEM],
    );
    const countRequest = '75000000-0000-4000-8000-000000000030';
    await pg.query(
      `select public.staxis_save_inventory_count($1,$2,now(),'Archive count',$3::jsonb)`,
      [PROP_A, countRequest, JSON.stringify([{ item_id: ARCHIVE_ITEM, expected_stock: 3, counted_stock: 0 }])],
    );
    await pg.query('set role authenticated');
    try {
      await pg.query(
        `update public.inventory set archived_at=now(),archived_by=$2 where id=$1 and property_id=$3`,
        [ARCHIVE_ITEM, USER_A, PROP_A],
      );
      // A never-stocked empty catalog row has no usage to explain and can be archived directly.
      await pg.query(
        `update public.inventory set archived_at=now(),archived_by=$2 where id=$1 and property_id=$3`,
        [EMPTY_ITEM, USER_A, PROP_A],
      );
      await pg.query(
        `update public.inventory set archived_at=now(),archived_by=$2 where id=$1 and property_id=$3`,
        [DISCARD_PROVENANCE_ITEM, USER_A, PROP_A],
      );
    } finally {
      await pg.query('reset role');
    }

    assert.equal(Number(await scalar(
      `select count(*) from public.inventory
       where property_id=$1 and archived_at is null and id in ($2,$3)`,
      [PROP_A, ARCHIVE_ITEM, EMPTY_ITEM],
    )), 0);

    const snapshotId = '74000000-0000-4000-8000-000000000010';
    await pg.query(
      `insert into public.inventory_month_close_snapshots(id,property_id,kind,captured_at)
       values ($1,$2,'ending',now())`,
      [snapshotId, PROP_A],
    );
    await pg.query(
      `insert into public.inventory_month_close_snapshot_items(
         snapshot_id,property_id,item_id,item_name,category,budget_key,archived_at,
         quantity,set_aside,unit_cost_cents,value_cents,valuation_method
       ) select $1,property_id,id,name,category,category,archived_at,0,0,100,0,'archived_zero'
         from public.inventory where id in ($2,$3,$4,$5)`,
      [snapshotId, ARCHIVE_ITEM, EMPTY_ITEM, DISCARD_PROVENANCE_ITEM, METADATA_ITEM_B],
    );
    assert.equal(
      await scalar<string>(
        `select valuation_method from public.inventory_month_close_snapshot_items
         where snapshot_id=$1 and item_id=$2`,
        [snapshotId, ARCHIVE_ITEM],
      ),
      'archived_count',
    );
    assert.equal(
      await scalar<string>(
        `select inventory_discard_id::text from public.inventory_month_close_snapshot_items
         where snapshot_id=$1 and item_id=$2`,
        [snapshotId, DISCARD_PROVENANCE_ITEM],
      ),
      await scalar<string>(
        `select id::text from public.inventory_discards where request_id=$1`,
        ['75000000-0000-4000-8000-000000000093'],
      ),
    );
    assert.equal(
      await scalar<string>(
        `select inventory_count_id::text from public.inventory_month_close_snapshot_items
         where snapshot_id=$1 and item_id=$2`,
        [snapshotId, ARCHIVE_ITEM],
      ),
      await scalar<string>('select id::text from public.inventory_counts where count_session_id=$1', [countRequest]),
    );
    assert.equal(
      await scalar<string>(
        `select valuation_method from public.inventory_month_close_snapshot_items
         where snapshot_id=$1 and item_id=$2`,
        [snapshotId, EMPTY_ITEM],
      ),
      'archived_never_stocked',
    );
    assert.equal(await scalar(
      `select inventory_count_id from public.inventory_month_close_snapshot_items
       where snapshot_id=$1 and item_id=$2`,
      [snapshotId, EMPTY_ITEM],
    ), null);
    assert.equal(
      await scalar(
        `select valuation_method from public.inventory_month_close_snapshot_items
         where snapshot_id=$1 and item_id=$2`,
        [snapshotId, DISCARD_PROVENANCE_ITEM],
      ),
      'archived_loss_zero',
    );
    assert.equal(
      await scalar(
        `select valuation_method from public.inventory_month_close_snapshot_items
         where snapshot_id=$1 and item_id=$2`,
        [snapshotId, METADATA_ITEM_B],
      ),
      'archived_correction_zero',
    );
    assert.ok(await scalar(
      `select inventory_delivery_correction_id is not null
       from public.inventory_month_close_snapshot_items
       where snapshot_id=$1 and item_id=$2`,
      [snapshotId, METADATA_ITEM_B],
    ));
  });
});
