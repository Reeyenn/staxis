import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { PGlite } from '@electric-sql/pglite';
import { applyMigrationsToPgliteWithHook } from '../../../tests/fixtures/pglite-migrate';

const USER = '91000000-0000-4000-8000-000000000001';
const PROPERTY = '92000000-0000-4000-8000-000000000001';
const ITEM = '93000000-0000-4000-8000-000000000001';
const ARCHIVED_ITEM = '93000000-0000-4000-8000-000000000002';
const COUNT = '94000000-0000-4000-8000-000000000001';
const COUNT_REQUEST = '95000000-0000-4000-8000-000000000001';
const ORDER = '96000000-0000-4000-8000-000000000001';
const LOSS = '97000000-0000-4000-8000-000000000001';
const LOSS_REQUEST = '95000000-0000-4000-8000-000000000002';
const RECONCILIATION = '98000000-0000-4000-8000-000000000001';
const CORRECTION = '99000000-0000-4000-8000-000000000001';
const CORRECTION_REQUEST = '95000000-0000-4000-8000-000000000003';
const OPENING_SNAPSHOT = '9a000000-0000-4000-8000-000000000001';
const ENDING_SNAPSHOT = '9a000000-0000-4000-8000-000000000002';
const CLOSE = '9b000000-0000-4000-8000-000000000001';
const START_REQUEST = '95000000-0000-4000-8000-000000000004';
const CLOSE_REQUEST = '95000000-0000-4000-8000-000000000005';
const OPENING_ADJUSTMENT = '9c000000-0000-4000-8000-000000000001';
const OPENING_REQUEST = '95000000-0000-4000-8000-000000000006';
const VENDOR = '9d000000-0000-4000-8000-000000000001';
const CATEGORY = '9e000000-0000-4000-8000-000000000001';
const SECTION = '9f000000-0000-4000-8000-000000000001';

let pg: PGlite;

async function scalar<T>(sql: string, params: unknown[] = []): Promise<T> {
  const result = await pg.query(sql, params) as { rows: Array<Record<string, unknown>> };
  return Object.values(result.rows[0] ?? {})[0] as T;
}

describe('inventory audit day-one backfill', () => {
  before(async () => {
    const migrated = await applyMigrationsToPgliteWithHook(async ({ pg: hookPg, file }) => {
      if (file !== '0326_inventory_audit_history.sql') return;
      await hookPg.query(`insert into auth.users(id,email) values ($1,'backfill@example.test')`, [USER]);
      await hookPg.query(
        `insert into public.properties(id,owner_id,name,total_rooms,timezone)
         values ($1,$2,'Backfill Hotel',20,'UTC')`,
        [PROPERTY, USER],
      );
      await hookPg.query(
        `insert into public.accounts(username,display_name,role,property_access,data_user_id)
         values ('backfill-owner','Backfill Owner','owner',array[$1]::uuid[],$2)`,
        [PROPERTY, USER],
      );
      // Legacy inventory rows predate the provenance trigger and legitimately
      // retain a null created_at. Temporarily disable it to reproduce that
      // production-only shape without weakening the migrated schema.
      await hookPg.query('alter table public.inventory disable trigger inventory_enforce_row_integrity');
      await hookPg.query(
        `insert into public.inventory(
           id,property_id,name,category,current_stock,par_level,unit,unit_cost,created_by,created_at,last_ordered_at
         ) values ($1,$3,'Backfill Towels','housekeeping',0,20,'each',2,$4,null,'2026-06-02T09:00:00Z'),
                  ($2,$3,'Archived Soap','housekeeping',0,20,'bottle',4,$4,'2026-06-01T11:00:00Z',null)`,
        [ITEM, ARCHIVED_ITEM, PROPERTY, USER],
      );
      await hookPg.query('alter table public.inventory enable trigger inventory_enforce_row_integrity');
      await hookPg.query(
        `update public.inventory
         set archived_at='2026-06-02T10:00:00Z',archived_by=$3
         where id=$1 and property_id=$2`,
        [ARCHIVED_ITEM, PROPERTY, USER],
      );
      await hookPg.query(
        `insert into public.inventory_opening_adjustments(
           id,property_id,item_id,quantity,unit_cost_cents,value_cents,effective_at,
           request_id,stock_before,stock_after,actor_id,actor_name
         ) values ($1,$2,$3,1,200,200,'2026-06-02T12:00:00Z',$4,0,1,$5,'Backfill Owner')`,
        [OPENING_ADJUSTMENT, PROPERTY, ITEM, OPENING_REQUEST, USER],
      );
      await hookPg.query(
        `insert into public.vendors(id,property_id,name,email,account_number,is_active,created_at,updated_at)
         values ($1,$2,'Legacy Linen','linen@example.test','A-19',true,'2026-06-02T13:00:00Z','2026-06-02T13:00:00Z')`,
        [VENDOR, PROPERTY],
      );
      await hookPg.query(
        `insert into public.inventory_custom_categories(id,property_id,name,sort,created_at,updated_at)
         values ($1,$2,'Pool',0,'2026-06-02T14:00:00Z','2026-06-02T14:00:00Z')`,
        [CATEGORY, PROPERTY],
      );
      await hookPg.query(
        `insert into public.inventory_budget_sections(id,property_id,name,item_ids,sort,created_at,updated_at)
         values ($1,$2,'Guest supplies',array[$3]::uuid[],0,'2026-06-02T15:00:00Z','2026-06-02T15:00:00Z')`,
        [SECTION, PROPERTY, ITEM],
      );
      await hookPg.query(
        `insert into public.inventory_budgets(
           property_id,category,month_start,budget_cents,basis,created_at,updated_at
         ) values ($1,'housekeeping','2026-06-01',50000,'purchases','2026-06-02T16:00:00Z','2026-06-02T16:00:00Z')`,
        [PROPERTY],
      );
      await hookPg.query(
        `update public.properties
         set inventory_budget_mode='total',
             inventory_tab_layout='{"order":["general","breakfast"],"hidden":[]}'::jsonb
         where id=$1`,
        [PROPERTY],
      );
      await hookPg.query(
        `insert into public.inventory_counts(
           id,property_id,count_session_id,item_id,item_name,counted_stock,estimated_stock,
           variance,unit_cost,counted_at,counted_by
         ) values ($1,$2,$3,$4,'Backfill Towels',0,1,-1,2,'2026-06-03T10:00:00Z','Backfill Owner')`,
        [COUNT, PROPERTY, COUNT_REQUEST, ITEM],
      );
      await hookPg.query(
        `insert into public.inventory_orders(
           id,property_id,item_id,item_name,quantity,unit_cost,total_cost,vendor_name,received_at,notes
         ) values ($1,$2,$3,'Backfill Towels',2,2,4,'Vendor A','2026-06-04T10:00:00Z','Legacy receipt')`,
        [ORDER, PROPERTY, ITEM],
      );
      await hookPg.query(
        `insert into public.inventory_discards(
           id,property_id,item_id,item_name,quantity,reason,unit_cost,cost_value,
           discarded_at,discarded_by,request_id,stock_before,stock_after,recorded_by_user_id
         ) values ($1,$2,$3,'Backfill Towels',1,'damaged',2,2,
           '2026-06-05T10:00:00Z','Backfill Owner',$4,2,1,$5)`,
        [LOSS, PROPERTY, ITEM, LOSS_REQUEST, USER],
      );
      await hookPg.query(
        `insert into public.inventory_reconciliations(
           id,property_id,item_id,item_name,reconciled_at,physical_count,system_estimate,
           discards_since_last,unaccounted_variance,unaccounted_variance_value,unit_cost,reconciled_by
         ) values ($1,$2,$3,'Backfill Towels','2026-06-06T10:00:00Z',1,2,0,-1,-2,2,'Backfill Owner')`,
        [RECONCILIATION, PROPERTY, ITEM],
      );
      await hookPg.query(
        `insert into public.inventory_delivery_corrections(
           id,property_id,request_id,line_key,original_order_id,correction_kind,reason,
           corrected_at,corrected_by,corrected_by_user_id,
           previous_item_id,previous_item_name,previous_quantity,previous_unit_cost,previous_total_cost,
           corrected_item_id,corrected_item_name,corrected_quantity,corrected_unit_cost,corrected_total_cost,stock_effect
         ) values ($1,$2,$3,'legacy-line',$4,'correction','Wrong quantity',
           '2026-06-07T10:00:00Z','Backfill Owner',$5,
           $6,'Backfill Towels',2,2,4,$6,'Backfill Towels',1,2,2,'[]'::jsonb)`,
        [CORRECTION, PROPERTY, CORRECTION_REQUEST, ORDER, USER, ITEM],
      );
      await hookPg.query(
        `insert into public.inventory_write_receipts(property_id,request_id,operation,payload,result)
         values ($1,$2,'loss','{}'::jsonb,'{}'::jsonb),
                ($1,$3,'delivery_correction','{}'::jsonb,'{}'::jsonb)`,
        [PROPERTY, LOSS_REQUEST, CORRECTION_REQUEST],
      );
      await hookPg.query(
        `insert into public.inventory_month_close_snapshots(id,property_id,kind,captured_at)
         values ($1,$3,'baseline','2026-06-01T00:00:00Z'),($2,$3,'ending','2026-07-01T00:00:00Z')`,
        [OPENING_SNAPSHOT, ENDING_SNAPSHOT, PROPERTY],
      );
      await hookPg.query(
        `insert into public.inventory_month_closes(
           id,property_id,month_start,timezone,status,month_start_at,end_at,grace_end_at,
           count_window_start_at,activity_start_at,is_partial,budget_comparison_available,
           opening_snapshot_id,ending_snapshot_id,purchase_source,allocation_mode,
           confirmed_purchase_cents,beginning_value_cents,ending_value_cents,actual_usage_cents,
           baseline_at,opened_by,opened_by_name,closed_at,closed_by,closed_by_name,
           start_request_id,close_request_id
         ) values ($1,$2,'2026-06-01','UTC','closed','2026-06-01T00:00:00Z','2026-07-01T00:00:00Z',
           '2026-07-04T00:00:00Z','2026-06-30T00:00:00Z','2026-06-01T00:00:00Z',false,true,
           $3,$4,'logged_deliveries','itemized',400,1000,600,800,
           '2026-06-01T00:00:00Z',$5,'Backfill Owner','2026-07-02T10:00:00Z',$5,'Backfill Owner',$6,$7)`,
        [CLOSE, PROPERTY, OPENING_SNAPSHOT, ENDING_SNAPSHOT, USER, START_REQUEST, CLOSE_REQUEST],
      );
    });
    pg = migrated.pg;
    assert.ok(migrated.report.applied.includes('0326_inventory_audit_history.sql'));
  });

  after(async () => pg.close());

  test('backfills all retained core evidence once with stable request/label fields', async () => {
    const result = await pg.query(
      `select action,request_id,occurred_at,summary,details,dedupe_key
       from public.inventory_audit_events where property_id=$1 order by occurred_at,action`,
      [PROPERTY],
    ) as { rows: Array<Record<string, unknown>> };
    const actions = result.rows.map((row) => row.action);
    for (const expected of [
      'item.created', 'item.archived', 'count.saved', 'delivery.received',
      'order_intent.recorded',
      'loss.recorded', 'reconciliation.recorded', 'delivery.corrected',
      'opening_adjustment.recorded', 'month.started', 'month.closed',
      'vendor.created', 'budget.created', 'category.created',
      'budget_section.created', 'config.updated',
    ]) {
      assert.ok(actions.includes(expected), `missing ${expected}: ${actions.join(', ')}`);
    }
    assert.equal(actions.filter((action) => action === 'item.created').length, 2);
    assert.equal(
      Number(await scalar<number>(
        `select count(*) - count(distinct dedupe_key)
         from public.inventory_audit_events where property_id=$1 and dedupe_key is not null`,
        [PROPERTY],
      )),
      0,
    );
    const count = result.rows.find((row) => row.action === 'count.saved');
    assert.equal(count?.request_id, COUNT_REQUEST);
    assert.equal((count?.summary as { label: string }).label, 'Backfill Towels');
    const itemBaseline = result.rows.find((row) => (
      row.action === 'item.created'
      && (row.summary as { label: string }).label === 'Backfill Towels'
    ));
    assert.equal((itemBaseline?.details as { baseline?: boolean }).baseline, true);
    assert.equal((itemBaseline?.details as { inferredOccurredAt?: boolean }).inferredOccurredAt, true);
    assert.equal(new Date(String(itemBaseline?.occurred_at)).toISOString(), '2026-06-02T09:00:00.000Z');
    const correction = result.rows.find((row) => row.action === 'delivery.corrected');
    assert.equal(correction?.request_id, CORRECTION_REQUEST);
  });
});
