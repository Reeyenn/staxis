import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { PGlite } from '@electric-sql/pglite';
import { applyMigrationsToPglite } from '../../../tests/fixtures/pglite-migrate';

const USER = '81000000-0000-4000-8000-000000000001';
const OTHER_USER = '81000000-0000-4000-8000-000000000002';
const PROPERTY = '82000000-0000-4000-8000-000000000001';
const OTHER_PROPERTY = '82000000-0000-4000-8000-000000000002';
const CASCADE_PROPERTY = '82000000-0000-4000-8000-000000000003';
const ITEM = '83000000-0000-4000-8000-000000000001';
const CATALOG_ITEM = '83000000-0000-4000-8000-000000000002';
const OTHER_ITEM = '83000000-0000-4000-8000-000000000003';
const CASCADE_ITEM = '83000000-0000-4000-8000-000000000004';
const DELETE_CATEGORY = '83000000-0000-4000-8000-000000000005';
const COUNT_REQUEST = '84000000-0000-4000-8000-000000000001';
const DELIVERY_REQUEST = '84000000-0000-4000-8000-000000000002';
const SECOND_DELIVERY_REQUEST = '84000000-0000-4000-8000-000000000003';
const UNRESOLVED_A = '84000000-0000-4000-8000-000000000004';
const UNRESOLVED_B = '84000000-0000-4000-8000-000000000005';
const SERVICE_COUNT_REQUEST = '84000000-0000-4000-8000-000000000006';
const SERVICE_DELIVERY_REQUEST = '84000000-0000-4000-8000-000000000007';
const SERVICE_ORDER_INTENT_A = '84000000-0000-4000-8000-000000000008';
const SERVICE_ORDER_INTENT_B = '84000000-0000-4000-8000-000000000009';
const SERVICE_ORDER_INTENT_RACE = '84000000-0000-4000-8000-00000000000a';

let pg: PGlite;

async function rows(sql: string, params: unknown[] = []): Promise<Array<Record<string, unknown>>> {
  const result = await pg.query(sql, params) as { rows: Array<Record<string, unknown>> };
  return result.rows;
}

async function scalar<T>(sql: string, params: unknown[] = []): Promise<T> {
  return Object.values((await rows(sql, params))[0] ?? {})[0] as T;
}

describe('inventory audit history migration 0326', () => {
  before(async () => {
    const migrated = await applyMigrationsToPglite();
    pg = migrated.pg;
    assert.ok(
      migrated.report.applied.includes('0326_inventory_audit_history.sql'),
      `0326 must apply: ${JSON.stringify(migrated.report.failedAtRuntime.filter((entry) => entry.file.startsWith('0326')))}`,
    );
    await pg.query(
      `insert into auth.users(id,email) values ($1,'audit-owner@example.test'),($2,'audit-other@example.test')
       on conflict (id) do nothing`,
      [USER, OTHER_USER],
    );
    await pg.query(
      `insert into public.properties(id,owner_id,name,total_rooms,timezone)
       values ($1,$4,'Audit Hotel',20,'UTC'),($2,$5,'Other Hotel',20,'UTC'),($3,$4,'Cascade Hotel',10,'UTC')
       on conflict (id) do nothing`,
      [PROPERTY, OTHER_PROPERTY, CASCADE_PROPERTY, USER, OTHER_USER],
    );
    await pg.query(
      `insert into public.accounts(username,display_name,role,property_access,data_user_id)
       values ('audit-owner','Actual Audit Owner','owner',array[$1,$2]::uuid[],$3)
       on conflict (username) do nothing`,
      [PROPERTY, CASCADE_PROPERTY, USER],
    );
    await pg.query(`select set_config('request.jwt.claim.sub',$1,false)`, [USER]);
    await pg.query(`select set_config('request.jwt.claim.role','authenticated',false)`);
    await pg.query(`
      create or replace function auth.jwt() returns jsonb
      language sql stable as 'select ''{"mfa_verified": true}''::jsonb'
    `);
    await pg.query(
      `insert into public.inventory(id,property_id,name,category,current_stock,par_level,unit,unit_cost)
       values ($1,$4,'Audit Towels','housekeeping',0,20,'each',2.5),
              ($2,$4,'Editable Soap','housekeeping',0,20,'bottle',4),
              ($3,$5,'Other Coffee','breakfast',0,20,'case',10),
              ($6,$7,'Cascade Bulbs','maintenance',0,10,'each',3)`,
      [ITEM, CATALOG_ITEM, OTHER_ITEM, PROPERTY, OTHER_PROPERTY, CASCADE_ITEM, CASCADE_PROPERTY],
    );
  });

  after(async () => {
    await pg.close();
  });

  test('count actor UUID/name are auth-derived and caller label cannot spoof them', async () => {
    await pg.query(
      `select public.staxis_save_inventory_count($1,$2,now(),'Spoofed Manager',$3::jsonb)`,
      [PROPERTY, COUNT_REQUEST, JSON.stringify([{ item_id: ITEM, expected_stock: 0, counted_stock: 0 }])],
    );
    const source = (await rows(
      `select counted_by,recorded_by_user_id,recorded_by_name
       from public.inventory_counts where count_session_id=$1`,
      [COUNT_REQUEST],
    ))[0];
    assert.equal(source.recorded_by_user_id, USER);
    assert.equal(source.recorded_by_name, 'Actual Audit Owner');
    assert.equal(source.counted_by, 'Actual Audit Owner');

    const event = (await rows(
      `select actor_user_id,actor_name,request_id from public.inventory_audit_events
       where action='count.saved' and request_id=$1`,
      [COUNT_REQUEST],
    ))[0];
    assert.equal(event.actor_user_id, USER);
    assert.equal(event.actor_name, 'Actual Audit Owner');
  });

  test('delivery request/actor binding is transaction-local, never inferred from unresolved receipts', async () => {
    await pg.query(
      `insert into public.inventory_write_receipts(property_id,request_id,operation,payload)
       values ($1,$2,'delivery','{}'::jsonb),($1,$3,'delivery','{}'::jsonb)`,
      [PROPERTY, UNRESOLVED_A, UNRESOLVED_B],
    );
    for (const requestId of [DELIVERY_REQUEST, SECOND_DELIVERY_REQUEST]) {
      await pg.query(
        `select public.staxis_receive_inventory_delivery($1,$2,now(),'Audit Vendor','Dock receipt',$3::jsonb)`,
        [PROPERTY, requestId, JSON.stringify([{ line_key: requestId, item_id: ITEM, quantity: 1, unit_cost: 2.5 }])],
      );
    }
    const deliveryRows = await rows(
      `select request_id,recorded_by_user_id,recorded_by_name
       from public.inventory_orders where request_id in ($1,$2) order by request_id`,
      [DELIVERY_REQUEST, SECOND_DELIVERY_REQUEST],
    );
    assert.deepEqual(deliveryRows.map((row) => row.request_id), [DELIVERY_REQUEST, SECOND_DELIVERY_REQUEST]);
    assert.ok(deliveryRows.every((row) => row.recorded_by_user_id === USER));
    assert.ok(deliveryRows.every((row) => row.recorded_by_name === 'Actual Audit Owner'));
    assert.equal(
      Number(await scalar<number>(
        `select count(*) from public.inventory_orders where request_id in ($1,$2)`,
        [UNRESOLVED_A, UNRESOLVED_B],
      )),
      0,
    );
  });

  test('service-side tools preserve their authenticated end-user actor atomically', async () => {
    await pg.query(`select set_config('request.jwt.claim.role','service_role',false)`);
    try {
      await pg.query(
        `select public.staxis_save_inventory_count_for_actor(
          $1,$2,now(),'Untrusted service label',$3::jsonb,$4,'Fallback actor label'
        )`,
        [PROPERTY, SERVICE_COUNT_REQUEST, JSON.stringify([{
          item_id: ITEM, expected_stock: 2, counted_stock: 2,
        }]), USER],
      );
      await pg.query(
        `select public.staxis_receive_inventory_delivery_for_actor(
          $1,$2,now(),'Service Vendor','Service delivery',$3::jsonb,$4,'Fallback actor label'
        )`,
        [PROPERTY, SERVICE_DELIVERY_REQUEST, JSON.stringify([{
          line_key: SERVICE_DELIVERY_REQUEST, item_id: ITEM, quantity: 1, unit_cost: 2.5,
        }]), USER],
      );
      await pg.query(
        `select public.staxis_record_inventory_order_intent(
          $1,$2,$3,'2026-07-20T10:00:00Z',$4,'Fallback actor label'
        )`,
        [PROPERTY, ITEM, SERVICE_ORDER_INTENT_A, USER],
      );
      await pg.query(
        `select public.staxis_record_inventory_order_intent(
          $1,$2,$3,'2026-07-20T11:00:00Z',$4,'Fallback actor label'
        )`,
        [PROPERTY, ITEM, SERVICE_ORDER_INTENT_B, USER],
      );
      const raced = await Promise.allSettled([
        pg.query(
          `select public.staxis_record_inventory_order_intent(
            $1,$2,$3,'2026-07-20T12:00:00Z',$4,'Fallback actor label'
          )`,
          [PROPERTY, ITEM, SERVICE_ORDER_INTENT_RACE, USER],
        ),
        pg.query(
          `select public.staxis_record_inventory_order_intent(
            $1,$2,$3,'2026-07-20T13:00:00Z',$4,'Fallback actor label'
          )`,
          [PROPERTY, CATALOG_ITEM, SERVICE_ORDER_INTENT_RACE, USER],
        ),
      ]);
      assert.equal(raced.filter((result) => result.status === 'fulfilled').length, 1);
      assert.equal(raced.filter((result) => result.status === 'rejected').length, 1);
    } finally {
      await pg.query(`select set_config('request.jwt.claim.role','authenticated',false)`);
    }

    const sourceActors = await rows(
      `select recorded_by_user_id,recorded_by_name from public.inventory_counts where count_session_id=$1
       union all
       select recorded_by_user_id,recorded_by_name from public.inventory_orders where request_id=$2`,
      [SERVICE_COUNT_REQUEST, SERVICE_DELIVERY_REQUEST],
    );
    assert.equal(sourceActors.length, 2);
    assert.ok(sourceActors.every((row) => row.recorded_by_user_id === USER));
    assert.ok(sourceActors.every((row) => row.recorded_by_name === 'Actual Audit Owner'));

    const auditActors = await rows(
      `select actor_user_id,actor_name from public.inventory_audit_events where request_id in ($1,$2)`,
      [SERVICE_COUNT_REQUEST, SERVICE_DELIVERY_REQUEST],
    );
    assert.equal(auditActors.length, 2);
    assert.ok(auditActors.every((row) => row.actor_user_id === USER));
    assert.ok(auditActors.every((row) => row.actor_name === 'Actual Audit Owner'));

    const intents = await rows(
      `select actor_user_id,actor_name,request_id,details
       from public.inventory_audit_events
       where action='order_intent.recorded' and request_id in ($1,$2) order by occurred_at`,
      [SERVICE_ORDER_INTENT_A, SERVICE_ORDER_INTENT_B],
    );
    assert.deepEqual(intents.map((row) => row.request_id), [SERVICE_ORDER_INTENT_A, SERVICE_ORDER_INTENT_B]);
    assert.ok(intents.every((row) => row.actor_user_id === USER));
    assert.ok(intents.every((row) => row.actor_name === 'Actual Audit Owner'));
    assert.ok(intents.every((row) => {
      const details = row.details as { deliveryLogged?: boolean; purchaseLogged?: boolean };
      return details.deliveryLogged === false && details.purchaseLogged === false;
    }));
    assert.equal(
      Number(await scalar<number>(
        `select count(*) from public.inventory
         where property_id=$1 and last_ordered_at in ('2026-07-20T12:00:00Z','2026-07-20T13:00:00Z')`,
        [PROPERTY],
      )),
      1,
    );
    assert.equal(Number(await scalar<number>(
      `select count(*) from public.inventory_audit_events
       where action='order_intent.recorded' and request_id=$1`,
      [SERVICE_ORDER_INTENT_RACE],
    )), 1);
  });

  test('item create/edit/archive events retain immutable before/after evidence', async () => {
    await pg.query(
      `update public.inventory set name='Guest Soap',unit_cost=5,updated_at=clock_timestamp()
       where id=$1 and property_id=$2`,
      [CATALOG_ITEM, PROPERTY],
    );
    await pg.query(
      `update public.inventory set archived_at=clock_timestamp(),archived_by=$3
       where id=$1 and property_id=$2`,
      [CATALOG_ITEM, PROPERTY, OTHER_USER],
    );
    const itemEvents = await rows(
      `select action,actor_user_id,summary,before_state,after_state
       from public.inventory_audit_events where entity_key=$1 order by sequence`,
      [CATALOG_ITEM],
    );
    assert.deepEqual(itemEvents.map((row) => row.action), ['item.created', 'item.updated', 'item.archived']);
    assert.ok(itemEvents.every((row) => row.actor_user_id === USER));
    const editSummary = itemEvents[1].summary as { changedFields?: string[] };
    assert.deepEqual(editSummary.changedFields, ['name', 'unit_cost']);
    assert.equal((itemEvents[1].before_state as { name: string }).name, 'Editable Soap');
    assert.equal((itemEvents[1].after_state as { name: string }).name, 'Guest Soap');

    const eventId = await scalar<string>(
      `select id from public.inventory_audit_events where entity_key=$1 and action='item.updated'`,
      [CATALOG_ITEM],
    );
    await assert.rejects(
      pg.query(`update public.inventory_audit_events set actor_name='Tampered' where id=$1`, [eventId]),
      /immutable|23514/i,
    );
    await assert.rejects(
      pg.query(`delete from public.inventory_audit_events where id=$1`, [eventId]),
      /immutable|23514/i,
    );
  });

  test('configuration deletes are timestamped when deleted, not when the old row was created', async () => {
    await pg.query(
      `insert into public.inventory_custom_categories(id,property_id,name,sort,created_at,updated_at)
       values ($1,$2,'Temporary category',0,'2020-01-01T00:00:00Z','2020-01-01T00:00:00Z')`,
      [DELETE_CATEGORY, PROPERTY],
    );
    const beforeDelete = await scalar<string>(`select clock_timestamp()::text`);
    await pg.query(
      `delete from public.inventory_custom_categories where id=$1 and property_id=$2`,
      [DELETE_CATEGORY, PROPERTY],
    );
    const deletedAt = await scalar<string>(
      `select occurred_at::text from public.inventory_audit_events
       where action='category.deleted' and entity_id=$1`,
      [DELETE_CATEGORY],
    );
    assert.ok(Date.parse(deletedAt) >= Date.parse(beforeDelete));
  });

  test('property cascade remains possible while standalone audit deletion is forbidden', async () => {
    await pg.query(
      `insert into public.inventory_custom_categories(property_id,name,sort)
       values ($1,'Cascade custom',0)`,
      [CASCADE_PROPERTY],
    );
    await pg.query(
      `insert into public.inventory_budget_sections(property_id,name,item_ids,sort)
       values ($1,'Cascade section',array[$2]::uuid[],0)`,
      [CASCADE_PROPERTY, CASCADE_ITEM],
    );
    await pg.query(
      `insert into public.inventory_budgets(property_id,category,month_start,budget_cents,basis)
       values ($1,'maintenance','2026-07-01',10000,'purchases')`,
      [CASCADE_PROPERTY],
    );
    assert.ok(Number(await scalar<number>(
      `select count(*) from public.inventory_audit_events where property_id=$1`,
      [CASCADE_PROPERTY],
    )) > 0);
    await pg.query(`delete from public.properties where id=$1`, [CASCADE_PROPERTY]);
    assert.equal(Number(await scalar<number>(
      `select count(*) from public.inventory_audit_events where property_id=$1`,
      [CASCADE_PROPERTY],
    )), 0);
  });

  test('service cursor is tenant-scoped, paged without overlap, and financial details are filtered', async () => {
    await pg.query(`select set_config('request.jwt.claim.role','service_role',false)`);
    try {
      const first = await scalar<Record<string, unknown>>(
        `select public.staxis_list_inventory_audit_events($1,null,2,false)`,
        [PROPERTY],
      );
      const firstEvents = first.events as Array<Record<string, unknown>>;
      assert.equal(firstEvents.length, 2);
      assert.equal(typeof first.nextSequence, 'string');
      assert.ok(firstEvents.every((event) => !('unitCost' in (event.details as Record<string, unknown>))));

      const second = await scalar<Record<string, unknown>>(
        `select public.staxis_list_inventory_audit_events($1,$2::bigint,2,false)`,
        [PROPERTY, first.nextSequence],
      );
      const secondEvents = second.events as Array<Record<string, unknown>>;
      const firstIds = new Set(firstEvents.map((event) => event.id));
      assert.ok(secondEvents.every((event) => !firstIds.has(event.id)));

      const other = await scalar<Record<string, unknown>>(
        `select public.staxis_list_inventory_audit_events($1,null,100,false)`,
        [OTHER_PROPERTY],
      );
      const otherEvents = other.events as Array<Record<string, unknown>>;
      assert.ok(otherEvents.length > 0);
      assert.ok(otherEvents.every((event) => (event.summary as { label: string }).label === 'Other Coffee'));

      const financial = await scalar<Record<string, unknown>>(
        `select public.staxis_list_inventory_audit_events($1,null,100,true)`,
        [PROPERTY],
      );
      const edited = (financial.events as Array<Record<string, unknown>>)
        .find((event) => event.action === 'item.updated');
      assert.equal((edited?.details as Record<string, unknown>).unitCostAfter, 5);
    } finally {
      await pg.query(`select set_config('request.jwt.claim.role','authenticated',false)`);
    }
  });

  test('authenticated callers cannot bypass the API and execute the private cursor RPC', async () => {
    await assert.rejects(
      pg.query(`select public.staxis_list_inventory_audit_events($1,null,10,false)`, [PROPERTY]),
      /service-role only|42501/i,
    );
    await assert.rejects(
      pg.query(
        `select public.staxis_record_inventory_order_intent($1,$2,$3,now(),$4,'Spoof')`,
        [PROPERTY, ITEM, crypto.randomUUID(), OTHER_USER],
      ),
      /service-role only|42501/i,
    );
  });
});
