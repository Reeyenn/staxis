import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { PGlite } from '@electric-sql/pglite';
import { applyMigrationsToPglite } from '../../../tests/fixtures/pglite-migrate';

const OWNER = '81000000-0000-4000-8000-000000000001';
const GM = '81000000-0000-4000-8000-000000000002';
const STAFF = '81000000-0000-4000-8000-000000000003';
const ADMIN = '81000000-0000-4000-8000-000000000004';
const PROPERTY = '82000000-0000-4000-8000-000000000001';
const FOREIGN_PROPERTY = '82000000-0000-4000-8000-000000000002';
const SECTION = '83000000-0000-4000-8000-000000000001';
const ITEM = '84000000-0000-4000-8000-000000000001';
const FOREIGN_ITEM = '84000000-0000-4000-8000-000000000002';
const COUNT = '85000000-0000-4000-8000-000000000001';
const ORDER = '86000000-0000-4000-8000-000000000001';
const DISCARD = '87000000-0000-4000-8000-000000000001';
const RECONCILIATION = '88000000-0000-4000-8000-000000000001';
const OPENING_REQUEST = '89000000-0000-4000-8000-000000000001';
const STAFF_CATEGORY = '8a000000-0000-4000-8000-000000000001';
const GM_CATEGORY = '8a000000-0000-4000-8000-000000000002';

let pg: PGlite;

async function asUser(
  userId: string,
  sql: string,
  params: unknown[] = [],
): Promise<Array<Record<string, unknown>>> {
  await pg.exec('begin');
  try {
    await pg.exec('set local role authenticated');
    await pg.query(`select set_config('request.jwt.claim.sub', $1, true)`, [userId]);
    await pg.query(`select set_config('request.jwt.claim.role', 'authenticated', true)`);
    await pg.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({
      sub: userId,
      role: 'authenticated',
      mfa_verified: true,
    })]);
    const result = await pg.query(sql, params) as { rows: Array<Record<string, unknown>> };
    await pg.exec('commit');
    return result.rows;
  } catch (error) {
    await pg.exec('rollback').catch(() => undefined);
    throw error;
  }
}

async function asService<T>(sql: string, params: unknown[] = []): Promise<T> {
  await pg.exec('begin');
  try {
    await pg.exec('set local role service_role');
    await pg.query(`select set_config('request.jwt.claim.role', 'service_role', true)`);
    const result = await pg.query(sql, params) as { rows: Array<Record<string, unknown>> };
    await pg.exec('commit');
    return Object.values(result.rows[0] ?? {})[0] as T;
  } catch (error) {
    await pg.exec('rollback').catch(() => undefined);
    throw error;
  }
}

describe('inventory financial permissions migration 0331', () => {
  before(async () => {
    const migrated = await applyMigrationsToPglite();
    pg = migrated.pg;
    assert.ok(
      migrated.report.applied.includes('0331_inventory_budget_financial_permissions.sql'),
      `0331 must apply in PGlite: ${JSON.stringify(
        migrated.report.failedAtRuntime.filter((entry) => entry.file.startsWith('0331')),
      )}`,
    );

    await pg.query(
      `insert into auth.users(id,email) values
         ($1,'owner-budget@example.test'),
         ($2,'gm-budget@example.test'),
         ($3,'staff-budget@example.test'),
         ($4,'admin-budget@example.test')
       on conflict (id) do nothing`,
      [OWNER, GM, STAFF, ADMIN],
    );
    await pg.query(
      `insert into public.properties(id,owner_id,name,total_rooms,timezone)
       values ($1,$3,'Budget Hotel',60,'UTC'),($2,$3,'Foreign Budget Hotel',60,'UTC')
       on conflict (id) do nothing`,
      [PROPERTY, FOREIGN_PROPERTY, OWNER],
    );
    await pg.query(
      `insert into public.accounts(username,display_name,role,property_access,data_user_id)
       values
         ('budget-owner','Budget Owner','owner',array[$1]::uuid[],$2),
         ('budget-gm','Budget GM','general_manager',array[$1]::uuid[],$3),
         ('budget-staff','Budget Staff','housekeeping',array[$1]::uuid[],$4),
         ('budget-admin','Budget Admin','admin','{}'::uuid[],$5)
       on conflict (username) do nothing`,
      [PROPERTY, OWNER, GM, STAFF, ADMIN],
    );
    await pg.query(
      `insert into public.inventory_budgets(
         property_id,category,month_start,budget_cents,basis
       ) values ($1,'housekeeping','2026-07-01',12000,'usage')`,
      [PROPERTY],
    );
    await pg.query(
      `insert into public.inventory_budget_sections(id,property_id,name,item_ids)
       values ($1,$2,'Pool supplies','{}'::uuid[])`,
      [SECTION, PROPERTY],
    );
    await pg.query(
      `insert into public.inventory(
         id,property_id,name,category,current_stock,set_aside,par_level,unit,unit_cost,
         opening_adjustment_quantity,opening_adjustment_unit_cost,
         opening_adjustment_at,opening_adjustment_request_id
       ) values
         ($1,$3,'Bath Towels','housekeeping',5,1,12,'each',3,2,3,now(),$4),
         ($2,$5,'Foreign Towels','housekeeping',1,0,5,'each',99,null,null,null,null)`,
      [ITEM, FOREIGN_ITEM, PROPERTY, OPENING_REQUEST, FOREIGN_PROPERTY],
    );
    await pg.query(
      `insert into public.inventory_counts(
         id,property_id,count_session_id,item_id,item_name,counted_stock,
         estimated_stock,variance,variance_value,unit_cost,counted_at,counted_by
       ) values ($1,$2,gen_random_uuid(),$3,'Bath Towels',5,6,-1,-3,3,now(),'Counter')`,
      [COUNT, PROPERTY, ITEM],
    );
    await pg.query(
      `insert into public.inventory_orders(
         id,property_id,item_id,item_name,quantity,unit_cost,total_cost,
         vendor_name,received_at,notes
       ) values ($1,$2,$3,'Bath Towels',2,5,10,'Supplier',now(),'Current month receipt')`,
      [ORDER, PROPERTY, ITEM],
    );
    await pg.query(
      `insert into public.inventory_discards(
         id,property_id,item_id,item_name,quantity,reason,cost_value,unit_cost,
         discarded_at,discarded_by
       ) values ($1,$2,$3,'Bath Towels',1,'damaged',3,3,now(),'Counter')`,
      [DISCARD, PROPERTY, ITEM],
    );
    await pg.query(
      `insert into public.inventory_reconciliations(
         id,property_id,item_id,item_name,physical_count,system_estimate,
         discards_since_last,unaccounted_variance,unaccounted_variance_value,
         unit_cost,reconciled_by
       ) values ($1,$2,$3,'Bath Towels',5,7,1,-1,-3,3,'Counter')`,
      [RECONCILIATION, PROPERTY, ITEM],
    );

    // Supabase grants table DML to authenticated; production RLS, not a
    // missing table privilege, must be what makes each decision below.
    await pg.exec(`
      grant select, insert, update, delete on public.inventory_budgets to authenticated;
      grant select, insert, update, delete on public.inventory_budget_sections to authenticated;
      grant select, insert, update, delete on public.inventory_custom_categories to authenticated;
      grant insert, update on public.inventory to authenticated;
    `);
  });

  after(async () => {
    await pg.close();
  });

  test('custom-tab writes follow the inventory-management override while reads remain hotel-wide', async () => {
    // manage_inventory_orders has an everyone-default in the shared resolver;
    // a line role without an override must therefore match the visible editor.
    assert.deepEqual(
      await asUser(
        STAFF,
        `insert into public.inventory_custom_categories(id,property_id,name,sort)
         values ($1,$2,'Laundry',1) returning id`,
        [STAFF_CATEGORY, PROPERTY],
      ),
      [{ id: STAFF_CATEGORY }],
    );
    assert.deepEqual(
      await asUser(
        STAFF,
        `update public.inventory_custom_categories set name='Laundry supplies'
         where id=$1 and property_id=$2 returning name`,
        [STAFF_CATEGORY, PROPERTY],
      ),
      [{ name: 'Laundry supplies' }],
    );

    await pg.query(
      `insert into public.capability_overrides(property_id,capability,role,allowed)
       values ($1,'manage_inventory_orders','housekeeping',false)`,
      [PROPERTY],
    );
    try {
      const allowed = await asUser(
        STAFF,
        `select public.staxis_user_can_manage_inventory_operations($1) as allowed`,
        [PROPERTY],
      );
      assert.deepEqual(allowed, [{ allowed: false }]);

      // The tab must remain readable so inventory items can still render in
      // the correct bucket even after its editor capability is restricted.
      assert.deepEqual(
        await asUser(
          STAFF,
          `select id,name from public.inventory_custom_categories
           where id=$1 and property_id=$2`,
          [STAFF_CATEGORY, PROPERTY],
        ),
        [{ id: STAFF_CATEGORY, name: 'Laundry supplies' }],
      );
      await assert.rejects(
        asUser(
          STAFF,
          `insert into public.inventory_custom_categories(property_id,name,sort)
           values ($1,'Bypass tab',2) returning id`,
          [PROPERTY],
        ),
        /row-level security|violates.*policy|permission denied/i,
      );
      assert.deepEqual(
        await asUser(
          STAFF,
          `update public.inventory_custom_categories set name='Bypass rename'
           where id=$1 and property_id=$2 returning id`,
          [STAFF_CATEGORY, PROPERTY],
        ),
        [],
      );
      assert.deepEqual(
        await asUser(
          STAFF,
          `delete from public.inventory_custom_categories
           where id=$1 and property_id=$2 returning id`,
          [STAFF_CATEGORY, PROPERTY],
        ),
        [],
      );

      // A restriction for housekeeping must not remove the GM's independent
      // default grant at the same property.
      assert.deepEqual(
        await asUser(
          GM,
          `insert into public.inventory_custom_categories(id,property_id,name,sort)
           values ($1,$2,'Manager tab',3) returning id`,
          [GM_CATEGORY, PROPERTY],
        ),
        [{ id: GM_CATEGORY }],
      );
    } finally {
      await pg.query(
        `delete from public.capability_overrides
         where property_id=$1 and capability='manage_inventory_orders' and role='housekeeping'`,
        [PROPERTY],
      );
    }
  });

  test('disabling Inventory blocks custom-tab reads and mutations at the database boundary', async () => {
    await pg.query(
      `update public.properties
       set enabled_sections='{"inventory":false,"financials":true}'::jsonb
       where id=$1`,
      [PROPERTY],
    );
    try {
      assert.deepEqual(
        await asUser(
          OWNER,
          `select public.staxis_user_can_manage_inventory_operations($1) as allowed`,
          [PROPERTY],
        ),
        [{ allowed: false }],
      );
      await assert.rejects(
        asUser(
          OWNER,
          `insert into public.inventory_custom_categories(property_id,name,sort)
           values ($1,'Disabled section tab',4) returning id`,
          [PROPERTY],
        ),
        /row-level security|violates.*policy|permission denied/i,
      );
      assert.deepEqual(
        await asUser(
          OWNER,
          `select id from public.inventory_custom_categories where property_id=$1`,
          [PROPERTY],
        ),
        [],
      );
      assert.deepEqual(
        await asUser(
          OWNER,
          `select category from public.inventory_budgets where property_id=$1`,
          [PROPERTY],
        ),
        [],
      );
      assert.deepEqual(
        await asUser(
          OWNER,
          `select id from public.inventory_budget_sections where property_id=$1`,
          [PROPERTY],
        ),
        [],
      );
      assert.deepEqual(
        await asUser(
          OWNER,
          `select public.staxis_user_can_view_inventory_financials($1) as allowed`,
          [PROPERTY],
        ),
        [{ allowed: false }],
      );
    } finally {
      await pg.query(
        `update public.properties set enabled_sections='{}'::jsonb where id=$1`,
        [PROPERTY],
      );
    }
  });

  test('owner, GM, and admin can read budget dollars and allocation sections', async () => {
    for (const userId of [OWNER, GM, ADMIN]) {
      const budgets = await asUser(
        userId,
        `select budget_cents from public.inventory_budgets where property_id=$1`,
        [PROPERTY],
      );
      const sections = await asUser(
        userId,
        `select name from public.inventory_budget_sections where property_id=$1`,
        [PROPERTY],
      );
      assert.equal(budgets.length, 1, `${userId} should see the budget`);
      assert.equal(sections.length, 1, `${userId} should see budget allocation`);
    }
  });

  test('line staff retain operational reads but direct cost columns and select-star fail', async () => {
    const operational = await asUser(
      STAFF,
      `select i.id,i.name,i.current_stock from public.inventory i where i.property_id=$1`,
      [PROPERTY],
    );
    assert.equal(operational.length, 1);
    assert.equal(operational[0].id, ITEM);
    assert.equal(operational[0].name, 'Bath Towels');
    assert.equal(Number(operational[0].current_stock), 5);

    for (const sql of [
      `select unit_cost from public.inventory where property_id=$1`,
      `select unit_cost,variance_value from public.inventory_counts where property_id=$1`,
      `select unit_cost,total_cost from public.inventory_orders where property_id=$1`,
      `select unit_cost,cost_value from public.inventory_discards where property_id=$1`,
      `select unit_cost,unaccounted_variance_value from public.inventory_reconciliations where property_id=$1`,
      `select * from public.inventory where property_id=$1`,
    ]) {
      await assert.rejects(asUser(STAFF, sql, [PROPERTY]), /permission denied|unit_cost|variance_value|cost_value/i);
    }
  });

  test('financial managers also use service hydration instead of bypassing column grants', async () => {
    await assert.rejects(
      asUser(GM, `select unit_cost from public.inventory where property_id=$1`, [PROPERTY]),
      /permission denied|unit_cost/i,
    );

    const evidence = await asService<Record<string, unknown>>(
      `select public.staxis_list_inventory_financial_evidence($1)`,
      [PROPERTY],
    );
    assert.deepEqual((evidence.inventory as Record<string, unknown>)[ITEM], {
      unitCost: 3,
      openingAdjustmentUnitCost: 3,
    });
    assert.deepEqual((evidence.counts as Record<string, unknown>)[COUNT], {
      unitCost: 3,
      varianceValue: -3,
    });
    assert.deepEqual((evidence.orders as Record<string, unknown>)[ORDER], {
      unitCost: 5,
      totalCost: 10,
    });
    assert.deepEqual((evidence.discards as Record<string, unknown>)[DISCARD], {
      unitCost: 3,
      costValue: 3,
    });
    assert.equal((evidence.inventory as Record<string, unknown>)[FOREIGN_ITEM], undefined);
    assert.deepEqual(evidence.currentMonthSpend, { total: 10, complete: true });

    await assert.rejects(
      asUser(STAFF, `select public.staxis_list_inventory_financial_evidence($1)`, [PROPERTY]),
      /permission denied|service-role only/i,
    );
  });

  test('item cost writes keep manager Add/Edit working and reject line-staff tampering', async () => {
    const managerUpdate = await asUser(
      GM,
      `update public.inventory set unit_cost=4 where id=$1 and property_id=$2 returning id`,
      [ITEM, PROPERTY],
    );
    assert.deepEqual(managerUpdate, [{ id: ITEM }]);
    await assert.rejects(
      asUser(
        STAFF,
        `update public.inventory set unit_cost=1 where id=$1 and property_id=$2 returning id`,
        [ITEM, PROPERTY],
      ),
      /not authorized|42501/i,
    );
    assert.equal(Number(
      await asService<number>(`select unit_cost from public.inventory where id=$1`, [ITEM]),
    ), 4);
  });

  test('a stale authenticated JWT claim does not block privileged seed or repair writes', async () => {
    await pg.exec('begin');
    try {
      await pg.query(`select set_config('request.jwt.claim.role', 'authenticated', true)`);
      const identity = await pg.query(`select current_user as role`) as {
        rows: Array<{ role: string }>;
      };
      assert.notEqual(identity.rows[0]?.role, 'authenticated');
      await pg.query(
        `update public.inventory set unit_cost=7 where id=$1 and property_id=$2`,
        [ITEM, PROPERTY],
      );
    } finally {
      // This is only a trigger-role regression; keep the shared fixture's
      // manager-visible cost unchanged for the tests below.
      await pg.exec('rollback');
    }
  });

  test('line staff cannot read or mutate budget evidence through PostgREST roles', async () => {
    // A stale/hand-written allow row must not lift the SQL helper's permanent
    // owner/GM manager floor.
    await pg.query(
      `insert into public.capability_overrides(property_id,capability,role,allowed)
       values ($1,'view_financials','housekeeping',true)`,
      [PROPERTY],
    );
    assert.deepEqual(
      await asUser(
        STAFF,
        `select budget_cents from public.inventory_budgets where property_id=$1`,
        [PROPERTY],
      ),
      [],
    );
    assert.deepEqual(
      await asUser(
        STAFF,
        `update public.inventory_budgets set budget_cents=1
         where property_id=$1 returning budget_cents`,
        [PROPERTY],
      ),
      [],
    );
    assert.deepEqual(
      await asUser(
        STAFF,
        `delete from public.inventory_budget_sections where property_id=$1 returning id`,
        [PROPERTY],
      ),
      [],
    );
  });

  test('a per-property view_financials denial removes GM read and write access', async () => {
    await pg.query(
      `insert into public.capability_overrides(property_id,capability,role,allowed)
       values ($1,'view_financials','general_manager',false)`,
      [PROPERTY],
    );
    assert.deepEqual(
      await asUser(
        GM,
        `select budget_cents from public.inventory_budgets where property_id=$1`,
        [PROPERTY],
      ),
      [],
    );
    assert.deepEqual(
      await asUser(
        GM,
        `update public.inventory_budget_sections set name='Changed'
         where property_id=$1 returning id`,
        [PROPERTY],
      ),
      [],
    );
    await assert.rejects(
      asUser(
        GM,
        `update public.inventory set unit_cost=2 where id=$1 and property_id=$2 returning id`,
        [ITEM, PROPERTY],
      ),
      /not authorized|42501/i,
    );
  });

  test('an explicitly disabled Financials section denies authenticated cost RPCs', async () => {
    await pg.query(
      `delete from public.capability_overrides
       where property_id=$1 and capability='view_financials' and role='general_manager'`,
      [PROPERTY],
    );
    await pg.query(
      `update public.properties set enabled_sections='{"financials":false}'::jsonb where id=$1`,
      [PROPERTY],
    );
    const allowed = await asUser(
      OWNER,
      `select public.staxis_user_can_view_inventory_financials($1) as allowed`,
      [PROPERTY],
    );
    assert.deepEqual(allowed, [{ allowed: false }]);
    await assert.rejects(
      asUser(
        OWNER,
        `select public.staxis_list_inventory_delivery_corrections($1,'{}'::uuid[],true)`,
        [PROPERTY],
      ),
      /not authorized|42501/i,
    );
  });
});
