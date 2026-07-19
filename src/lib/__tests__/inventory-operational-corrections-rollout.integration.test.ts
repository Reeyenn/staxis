import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  applyMigrationsToPgliteWithHook,
} from '../../../tests/fixtures/pglite-migrate';

const LEGACY_USER = '77000000-0000-4000-8000-000000000001';
const LEGACY_PROPERTY = '77000000-0000-4000-8000-000000000002';
const LEGACY_ITEM = '77000000-0000-4000-8000-000000000003';
const OPENING_SNAPSHOT = '77000000-0000-4000-8000-000000000004';
const ENDING_SNAPSHOT = '77000000-0000-4000-8000-000000000005';

test('0324 rolls out over archived delivery history and closed-month activity without rewinding its sequence', async () => {
  let seeded = false;
  const migrated = await applyMigrationsToPgliteWithHook(async ({ pg, file, report }) => {
    if (file !== '0324_inventory_operational_corrections.sql') return;
    assert.ok(report.applied.includes('0322_inventory_month_close.sql'));
    seeded = true;
    await pg.query(
      `insert into auth.users(id,email) values ($1,'legacy-rollout@example.test')`,
      [LEGACY_USER],
    );
    await pg.query(
      `insert into public.properties(id,owner_id,name,total_rooms,timezone)
       values ($1,$2,'Legacy rollout',20,'UTC')`,
      [LEGACY_PROPERTY, LEGACY_USER],
    );
    await pg.query(
      `insert into public.inventory(
         id,property_id,name,category,current_stock,par_level,unit,unit_cost
       ) values ($1,$2,'Legacy archived towels','housekeeping',0,10,'each',2)`,
      [LEGACY_ITEM, LEGACY_PROPERTY],
    );
    await pg.query(
      `insert into public.inventory_orders(
         property_id,item_id,item_name,quantity,unit_cost,total_cost,received_at,notes
       ) values ($1,$2,'Legacy archived towels',1,2,2,'2026-01-10T12:00:00Z','Legacy delivery')`,
      [LEGACY_PROPERTY, LEGACY_ITEM],
    );
    await pg.query(
      `insert into public.inventory_counts(
         property_id,item_id,item_name,counted_stock,estimated_stock,variance,
         variance_value,unit_cost,counted_at,counted_by
       ) values ($1,$2,'Legacy archived towels',0,0,0,0,2,'2026-01-20T12:00:00Z','Legacy counter')`,
      [LEGACY_PROPERTY, LEGACY_ITEM],
    );
    await pg.query(
      `insert into public.inventory_discards(
         property_id,item_id,item_name,quantity,reason,cost_value,unit_cost,discarded_at
       ) values ($1,$2,'Legacy archived towels',1,'lost',2,2,'2026-01-15T12:00:00Z')`,
      [LEGACY_PROPERTY, LEGACY_ITEM],
    );
    await pg.query(
      `update public.inventory
       set archived_at='2026-01-25T12:00:00Z',archived_by=$2
       where id=$1`,
      [LEGACY_ITEM, LEGACY_USER],
    );
    await pg.query(
      `insert into public.inventory_month_close_snapshots(id,property_id,kind,captured_at)
       values
         ($1,$3,'baseline','2026-01-01T00:00:00Z'),
         ($2,$3,'ending','2026-02-01T00:00:00Z')`,
      [OPENING_SNAPSHOT, ENDING_SNAPSHOT, LEGACY_PROPERTY],
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
         false,true,$2,$3,'logged_deliveries','itemized',200,200,0,400,
         '2026-01-01T00:00:00Z','2026-02-02T00:00:00Z'
       )`,
      [LEGACY_PROPERTY, OPENING_SNAPSHOT, ENDING_SNAPSHOT],
    );
  });

  try {
    assert.equal(seeded, true);
    const migrationFailure = migrated.report.failedAtRuntime.find(
      (entry) => entry.file === '0324_inventory_operational_corrections.sql',
    );
    assert.equal(migrationFailure, undefined, migrationFailure?.error);
    assert.ok(migrated.report.applied.includes('0324_inventory_operational_corrections.sql'));
    const archived = await migrated.pg.query<{
      archived_at: string | null;
      delivery_cache_active: boolean;
    }>(
      `select archived_at::text,delivery_cache_active
       from public.inventory where id=$1`,
      [LEGACY_ITEM],
    );
    assert.ok(archived.rows[0]?.archived_at);
    assert.equal(archived.rows[0]?.delivery_cache_active, false);

    const activity = await migrated.pg.query<{ kind: string; activity_sequence: string }>(
      `select 'count' as kind,activity_sequence::text from public.inventory_counts where item_id=$1
       union all
       select 'order',activity_sequence::text from public.inventory_orders where item_id=$1
       union all
       select 'discard',activity_sequence::text from public.inventory_discards where item_id=$1
       order by kind`,
      [LEGACY_ITEM],
    );
    assert.equal(activity.rows.length, 3);
    assert.ok(activity.rows.every((row) => Number(row.activity_sequence) > 0));
    const triggers = await migrated.pg.query<{ tgenabled: string }>(
      `select tgenabled from pg_trigger
       where tgname in (
         'inventory_counts_month_close_guard',
         'inventory_orders_month_close_guard',
         'inventory_discards_month_close_guard'
       )`,
    );
    assert.equal(triggers.rows.length, 3);
    assert.ok(triggers.rows.every((row) => row.tgenabled === 'O'));

    await migrated.pg.query(
      `select setval('public.inventory_activity_sequence',900000,true)`,
    );
    const migrationSql = readFileSync(
      join(process.cwd(), 'supabase/migrations/0324_inventory_operational_corrections.sql'),
      'utf8',
    );
    await assert.rejects(
      migrated.pg.exec(migrationSql),
      /0324 could not|already exists|multiple primary keys/i,
    );
    await migrated.pg.exec('rollback');
    const next = await migrated.pg.query<{ value: string }>(
      `select nextval('public.inventory_activity_sequence')::text as value`,
    );
    assert.equal(Number(next.rows[0]?.value), 900001);
  } finally {
    await migrated.pg.close();
  }
});
