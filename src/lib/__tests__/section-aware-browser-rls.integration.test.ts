import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { PGlite } from '@electric-sql/pglite';
import { applyMigrationsToPgliteWithHook } from '../../../tests/fixtures/pglite-migrate';

const GM = 'a1000000-0000-4000-8000-000000000001';
const MAINTENANCE = 'a1000000-0000-4000-8000-000000000002';
const OUTSIDER = 'a1000000-0000-4000-8000-000000000003';
const PROPERTY = 'a2000000-0000-4000-8000-000000000001';
const FOREIGN_PROPERTY = 'a2000000-0000-4000-8000-000000000002';
const WORK_ORDER = 'a3000000-0000-4000-8000-000000000001';
const PM_TASK = 'a4000000-0000-4000-8000-000000000001';
const STAFF_ROW = 'a5000000-0000-4000-8000-000000000001';
const SHIFT_PRESET = 'a6000000-0000-4000-8000-000000000001';
const SCHEDULED_SHIFT = 'a7000000-0000-4000-8000-000000000001';
const TIME_OFF = 'a8000000-0000-4000-8000-000000000001';
const WEEK_PUBLICATION = 'a9000000-0000-4000-8000-000000000001';
const INVENTORY_ITEM = 'aa000000-0000-4000-8000-000000000001';
const INVENTORY_CATEGORY = 'ab000000-0000-4000-8000-000000000001';
const INVENTORY_COUNT = 'ac000000-0000-4000-8000-000000000001';
const INVENTORY_ORDER = 'ad000000-0000-4000-8000-000000000001';
const INVENTORY_DISCARD = 'ae000000-0000-4000-8000-000000000001';
const INVENTORY_RECONCILIATION = 'af000000-0000-4000-8000-000000000001';

let pg: PGlite;

async function asUser(
  userId: string,
  sql: string,
  params: unknown[] = [],
  mfaVerified = true,
): Promise<Array<Record<string, unknown>>> {
  await pg.exec('begin');
  try {
    await pg.exec('set local role authenticated');
    await pg.query(`select set_config('request.jwt.claim.sub', $1, true)`, [userId]);
    await pg.query(`select set_config('request.jwt.claim.role', 'authenticated', true)`);
    await pg.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({
      sub: userId,
      role: 'authenticated',
      mfa_verified: mfaVerified,
    })]);
    const result = await pg.query(sql, params) as { rows: Array<Record<string, unknown>> };
    await pg.exec('commit');
    return result.rows;
  } catch (error) {
    await pg.exec('rollback').catch(() => undefined);
    throw error;
  }
}

async function asService(
  sql: string,
  params: unknown[] = [],
): Promise<Array<Record<string, unknown>>> {
  await pg.exec('begin');
  try {
    await pg.exec('set local role service_role');
    await pg.query(`select set_config('request.jwt.claim.role', 'service_role', true)`);
    const result = await pg.query(sql, params) as { rows: Array<Record<string, unknown>> };
    await pg.exec('commit');
    return result.rows;
  } catch (error) {
    await pg.exec('rollback').catch(() => undefined);
    throw error;
  }
}

async function setSections(valueSql: string): Promise<void> {
  await pg.exec(`update public.properties set enabled_sections=${valueSql} where id='${PROPERTY}'`);
}

describe('section-aware browser RLS migration 0334', () => {
  before(async () => {
    const migrated = await applyMigrationsToPgliteWithHook(async ({ pg: hookPg, file }) => {
      if (file === '0334_section_aware_browser_rls.sql') {
        // Supabase's public-schema default privileges exist in production but
        // are not part of the SQL migration chain PGlite replays. Mirror only
        // the pre-0334 browser privileges whose RLS behavior this test proves.
        await hookPg.exec(`
          grant select on public.property_shift_presets to authenticated;
          grant select on public.scheduled_shifts to authenticated;
          grant select on public.time_off_requests to authenticated;
          grant select on public.week_publications to authenticated;
          grant insert, update on public.inventory to authenticated;
          grant select, insert, update, delete on public.inventory_custom_categories to authenticated;
        `);
      }
    });
    pg = migrated.pg;
    assert.ok(
      migrated.report.applied.includes('0334_section_aware_browser_rls.sql'),
      `0334 must apply in PGlite: ${JSON.stringify(
        migrated.report.failedAtRuntime.filter((entry) => entry.file.startsWith('0334')),
      )}`,
    );

    await pg.query(
      `insert into auth.users(id,email) values
         ($1,'section-gm@example.test'),
         ($2,'section-maintenance@example.test'),
         ($3,'section-outsider@example.test')
       on conflict (id) do nothing`,
      [GM, MAINTENANCE, OUTSIDER],
    );
    await pg.query(
      `insert into public.properties(
         id,owner_id,name,total_rooms,timezone,enabled_sections
       ) values
         ($1,$2,'Section RLS Hotel',40,'UTC','{}'::jsonb),
         ($3,$4,'Foreign Section RLS Hotel',40,'UTC','{}'::jsonb)
       on conflict (id) do nothing`,
      [PROPERTY, GM, FOREIGN_PROPERTY, OUTSIDER],
    );
    await pg.query(
      `insert into public.accounts(
         username,display_name,role,property_access,data_user_id,active
       ) values
         ('section-rls-gm','Section GM','general_manager',array[$1]::uuid[],$2,true),
         ('section-rls-maint','Section Engineer','maintenance',array[$1]::uuid[],$3,true),
         ('section-rls-outsider','Section Outsider','general_manager',array[$4]::uuid[],$5,true)
       on conflict (username) do nothing`,
      [PROPERTY, GM, MAINTENANCE, FOREIGN_PROPERTY, OUTSIDER],
    );

    await asService(
      `insert into public.work_orders(
         id,property_id,room_number,description,severity,status
       ) values ($1,$2,'101','Replace filter','medium','submitted')`,
      [WORK_ORDER, PROPERTY],
    );
    await asService(
      `insert into public.preventive_tasks(
         id,property_id,name,frequency_days
       ) values ($1,$2,'Inspect fire extinguishers',30)`,
      [PM_TASK, PROPERTY],
    );
    await asService(
      `insert into public.staff(id,property_id,name,language,department,is_active)
       values ($1,$2,'Shared Roster Member','en','maintenance',true)`,
      [STAFF_ROW, PROPERTY],
    );
    await pg.query(
      `insert into public.property_shift_presets(
         id,property_id,name,department,start_time,end_time
       ) values ($1,$2,'Morning Engineering','maintenance','08:00','16:00')`,
      [SHIFT_PRESET, PROPERTY],
    );
    await pg.query(
      `insert into public.scheduled_shifts(
         id,property_id,staff_id,department,shift_date,start_time,end_time,status
       ) values ($1,$2,$3,'maintenance','2026-07-22','08:00','16:00','published')`,
      [SCHEDULED_SHIFT, PROPERTY, STAFF_ROW],
    );
    await pg.query(
      `insert into public.time_off_requests(
         id,property_id,staff_id,request_date,reason,status
       ) values ($1,$2,$3,'2026-07-23','Appointment','pending')`,
      [TIME_OFF, PROPERTY, STAFF_ROW],
    );
    await pg.query(
      `insert into public.week_publications(id,property_id,week_start)
       values ($1,$2,'2026-07-20')`,
      [WEEK_PUBLICATION, PROPERTY],
    );
    await pg.query(
      `insert into public.inventory(
         id,property_id,name,category,current_stock,par_level,unit
       ) values ($1,$2,'Pilot Bath Towels','housekeeping',5,12,'each')`,
      [INVENTORY_ITEM, PROPERTY],
    );
    await pg.query(
      `insert into public.inventory_custom_categories(id,property_id,name,sort)
       values ($1,$2,'Pilot supplies',1)`,
      [INVENTORY_CATEGORY, PROPERTY],
    );
    await pg.query(
      `insert into public.inventory_counts(
         id,property_id,count_session_id,item_id,item_name,counted_stock,counted_at
       ) values ($1,$2,gen_random_uuid(),$3,'Pilot Bath Towels',5,now())`,
      [INVENTORY_COUNT, PROPERTY, INVENTORY_ITEM],
    );
    await pg.query(
      `insert into public.inventory_orders(
         id,property_id,item_id,item_name,quantity,received_at
       ) values ($1,$2,$3,'Pilot Bath Towels',2,now())`,
      [INVENTORY_ORDER, PROPERTY, INVENTORY_ITEM],
    );
    await pg.query(
      `insert into public.inventory_discards(
         id,property_id,item_id,item_name,quantity,reason,discarded_at
       ) values ($1,$2,$3,'Pilot Bath Towels',1,'damaged',now())`,
      [INVENTORY_DISCARD, PROPERTY, INVENTORY_ITEM],
    );
    await pg.query(
      `insert into public.inventory_reconciliations(
         id,property_id,item_id,item_name,physical_count,system_estimate,
         discards_since_last,unaccounted_variance,reconciled_at
       ) values ($1,$2,$3,'Pilot Bath Towels',5,5,0,0,now())`,
      [INVENTORY_RECONCILIATION, PROPERTY, INVENTORY_ITEM],
    );
  });

  after(async () => {
    await pg.close();
  });

  test('strict section predicate defaults on only for SQL-null maps and missing keys', async () => {
    const cases: Array<{ stored: string; expected: boolean }> = [
      { stored: 'null', expected: true },
      { stored: `'{}'::jsonb`, expected: true },
      { stored: `'[{"maintenance":true}]'::jsonb`, expected: false },
      { stored: `'{"maintenance":true}'::jsonb`, expected: true },
      { stored: `'{"maintenance":false}'::jsonb`, expected: false },
      { stored: `'{"maintenance":null}'::jsonb`, expected: false },
      { stored: `'{"maintenance":"true"}'::jsonb`, expected: false },
    ];

    for (const { stored, expected } of cases) {
      await setSections(stored);
      const rows = await asUser(
        GM,
        `select public.staxis_property_section_enabled($1,'maintenance') as enabled`,
        [PROPERTY],
      );
      assert.equal(rows[0].enabled, expected, stored);
    }

    await setSections(`'{}'::jsonb`);
    const unknown = await asUser(
      GM,
      `select public.staxis_property_section_enabled($1,'unknown') as enabled`,
      [PROPERTY],
    );
    assert.equal(unknown[0].enabled, false);

    const service = await asService(
      `select public.staxis_property_section_enabled($1,'maintenance') as enabled`,
      ['a2000000-0000-4000-8000-999999999999'],
    );
    assert.equal(service[0].enabled, true);
  });

  test('work-order browser access requires property scope, MFA, and Maintenance enabled', async () => {
    await setSections(`'{"maintenance":true}'::jsonb`);

    const allowed = await asUser(
      MAINTENANCE,
      `insert into public.work_orders(property_id,room_number,description,severity,status)
       values ($1,'102','Clear drain','low','submitted') returning id`,
      [PROPERTY],
    );
    assert.equal(allowed.length, 1, 'maintenance role has no invented role floor');

    await assert.rejects(
      asUser(
        OUTSIDER,
        `insert into public.work_orders(property_id,room_number,description,severity,status)
         values ($1,'103','Cross-tenant attempt','low','submitted')`,
        [PROPERTY],
      ),
      /row-level security|violates.*policy/i,
    );
    await assert.rejects(
      asUser(
        MAINTENANCE,
        `insert into public.work_orders(property_id,room_number,description,severity,status)
         values ($1,'104','No MFA attempt','low','submitted')`,
        [PROPERTY],
        false,
      ),
      /row-level security|violates.*policy/i,
    );

    await setSections(`'{"maintenance":false}'::jsonb`);
    assert.deepEqual(
      await asUser(MAINTENANCE, `select id from public.work_orders where property_id=$1`, [PROPERTY]),
      [],
    );
    await assert.rejects(
      asUser(
        MAINTENANCE,
        `insert into public.work_orders(property_id,room_number,description,severity,status)
         values ($1,'105','Disabled-section attempt','low','submitted')`,
        [PROPERTY],
      ),
      /row-level security|violates.*policy/i,
    );

    const service = await asService(
      `insert into public.work_orders(property_id,room_number,description,severity,status)
       values ($1,'106','Internal workflow','low','submitted') returning id`,
      [PROPERTY],
    );
    assert.equal(service.length, 1);
  });

  test('preventive-task mutations honor manage_equipment overrides and section state', async () => {
    await setSections(`'{"maintenance":true}'::jsonb`);
    const allowed = await asUser(
      MAINTENANCE,
      `insert into public.preventive_tasks(property_id,name,frequency_days)
       values ($1,'Flush water heater',90) returning id`,
      [PROPERTY],
    );
    assert.equal(allowed.length, 1);

    await pg.query(
      `insert into public.capability_overrides(property_id,capability,role,allowed)
       values ($1,'manage_equipment','maintenance',false)
       on conflict (property_id,capability,role) do update set allowed=false`,
      [PROPERTY],
    );
    await assert.rejects(
      asUser(
        MAINTENANCE,
        `insert into public.preventive_tasks(property_id,name,frequency_days)
         values ($1,'Override bypass attempt',7)`,
        [PROPERTY],
      ),
      /row-level security|violates.*policy/i,
    );
    const blockedUpdate = await asUser(
      MAINTENANCE,
      `update public.preventive_tasks set notes='must not write' where id=$1 returning id`,
      [PM_TASK],
    );
    assert.deepEqual(blockedUpdate, []);

    await pg.query(
      `delete from public.capability_overrides
       where property_id=$1 and capability='manage_equipment' and role='maintenance'`,
      [PROPERTY],
    );
    const restored = await asUser(
      MAINTENANCE,
      `update public.preventive_tasks set notes='allowed' where id=$1 returning id`,
      [PM_TASK],
    );
    assert.equal(restored.length, 1);

    await setSections(`'{"maintenance":false}'::jsonb`);
    await assert.rejects(
      asUser(
        MAINTENANCE,
        `insert into public.preventive_tasks(property_id,name,frequency_days)
         values ($1,'Disabled PM attempt',7)`,
        [PROPERTY],
      ),
      /row-level security|violates.*policy/i,
    );
    const service = await asService(
      `insert into public.preventive_tasks(property_id,name,frequency_days)
       values ($1,'Internal PM workflow',365) returning id`,
      [PROPERTY],
    );
    assert.equal(service.length, 1);
  });

  test('Staff disabled blocks roster mutations but preserves shared roster reads', async () => {
    await setSections(`'{"staff":false,"maintenance":true}'::jsonb`);

    const roster = await asUser(
      GM,
      `select id,name from public.staff where property_id=$1`,
      [PROPERTY],
    );
    assert.equal(roster.length, 1, 'shared roster SELECT remains available');

    const blocked = await asUser(
      GM,
      `update public.staff set name='Browser bypass' where id=$1 returning id`,
      [STAFF_ROW],
    );
    assert.deepEqual(blocked, []);

    const service = await asService(
      `update public.staff set name='Internal roster workflow' where id=$1 returning id`,
      [STAFF_ROW],
    );
    assert.equal(service.length, 1);

    await setSections(`'{"staff":true,"maintenance":true}'::jsonb`);
    const allowed = await asUser(
      GM,
      `update public.staff set name='Manager roster update' where id=$1 returning id`,
      [STAFF_ROW],
    );
    assert.equal(allowed.length, 1);
  });

  test('Staff scheduling reads require Staff enabled while service workflows remain', async () => {
    const tables = [
      'property_shift_presets',
      'scheduled_shifts',
      'time_off_requests',
      'week_publications',
    ];

    await setSections(`'{"staff":true,"inventory":true,"financials":true}'::jsonb`);
    for (const table of tables) {
      const rows = await asUser(
        GM,
        `select id from public.${table} where property_id=$1`,
        [PROPERTY],
      );
      assert.equal(rows.length, 1, `${table} should load while Staff is enabled`);
    }

    await setSections(`'{"staff":false,"inventory":true,"financials":true}'::jsonb`);
    for (const table of tables) {
      const rows = await asUser(
        GM,
        `select id from public.${table} where property_id=$1`,
        [PROPERTY],
      );
      assert.deepEqual(rows, [], `${table} must hide when Staff is disabled`);

      const serviceRows = await asService(
        `select id from public.${table} where property_id=$1`,
        [PROPERTY],
      );
      assert.equal(serviceRows.length, 1, `${table} service read must remain available`);
    }
  });

  test('Inventory disabled hides direct operational data and blocks browser writes', async () => {
    const operationalTables = [
      'inventory',
      'inventory_counts',
      'inventory_orders',
      'inventory_discards',
      'inventory_reconciliations',
      'inventory_custom_categories',
    ];

    await setSections(`'{"inventory":true,"financials":true,"staff":true}'::jsonb`);
    for (const table of operationalTables) {
      const rows = await asUser(
        GM,
        `select id from public.${table} where property_id=$1`,
        [PROPERTY],
      );
      assert.equal(rows.length, 1, `${table} should load while Inventory is enabled`);
    }
    assert.deepEqual(
      await asUser(
        GM,
        `select public.staxis_user_can_manage_inventory_operations($1) as operations,
                public.staxis_user_can_view_inventory_financials($1) as financials`,
        [PROPERTY],
      ),
      [{ operations: true, financials: true }],
    );

    await setSections(`'{"inventory":false,"financials":true,"staff":true}'::jsonb`);
    for (const table of operationalTables) {
      const rows = await asUser(
        GM,
        `select id from public.${table} where property_id=$1`,
        [PROPERTY],
      );
      assert.deepEqual(rows, [], `${table} must hide when Inventory is disabled`);
    }
    assert.deepEqual(
      await asUser(
        GM,
        `select public.staxis_user_can_manage_inventory_operations($1) as operations,
                public.staxis_user_can_view_inventory_financials($1) as financials`,
        [PROPERTY],
      ),
      [{ operations: false, financials: false }],
    );
    await assert.rejects(
      asUser(
        GM,
        `insert into public.inventory(
           property_id,name,category,current_stock,par_level,unit
         ) values ($1,'Disabled item','housekeeping',0,5,'each')`,
        [PROPERTY],
      ),
      /row-level security|violates.*policy/i,
    );

    const service = await asService(
      `select id from public.inventory where property_id=$1`,
      [PROPERTY],
    );
    assert.equal(service.length, 1);
    assert.deepEqual(
      await asService(
        `select public.staxis_user_can_manage_inventory_operations($1) as operations,
                public.staxis_user_can_view_inventory_financials($1) as financials`,
        [PROPERTY],
      ),
      [{ operations: true, financials: true }],
    );

    await setSections(`'{"inventory":null,"financials":true,"staff":true}'::jsonb`);
    assert.deepEqual(
      await asUser(
        GM,
        `select public.staxis_user_can_manage_inventory_operations($1) as operations,
                public.staxis_user_can_view_inventory_financials($1) as financials`,
        [PROPERTY],
      ),
      [{ operations: false, financials: false }],
      'an explicit malformed Inventory value must fail closed',
    );
  });

  test('all authenticated Inventory atomic RPCs fail before replay or mutation when disabled', async () => {
    await setSections(`'{"inventory":false,"financials":true,"staff":true}'::jsonb`);
    const receiptCountBefore = await pg.query<{ count: string }>(
      `select count(*)::text as count from public.inventory_write_receipts where property_id=$1`,
      [PROPERTY],
    );
    const calls = [
      {
        label: 'count',
        sql: `select public.staxis_save_inventory_count(
          $1,gen_random_uuid(),now(),'Pilot Counter',
          jsonb_build_array(jsonb_build_object(
            'item_id',$2::text,'expected_stock',5,'counted_stock',5
          ))
        )`,
        params: [PROPERTY, INVENTORY_ITEM],
      },
      {
        label: 'delivery',
        sql: `select public.staxis_receive_inventory_delivery(
          $1,gen_random_uuid(),now(),'Pilot Vendor',null,
          jsonb_build_array(jsonb_build_object(
            'line_key','pilot-line','item_id',$2::text,'quantity',1,'unit_cost',null
          ))
        )`,
        params: [PROPERTY, INVENTORY_ITEM],
      },
      {
        label: 'loss',
        sql: `select public.staxis_record_inventory_loss(
          $1,gen_random_uuid(),now(),'Pilot Counter',$2,5,1,'damaged',null
        )`,
        params: [PROPERTY, INVENTORY_ITEM],
      },
      {
        label: 'correction list',
        sql: `select public.staxis_list_inventory_delivery_corrections(
          $1,'{}'::uuid[],false
        )`,
        params: [PROPERTY],
      },
      {
        label: 'delivery correction',
        sql: `select public.staxis_correct_inventory_delivery(
          $1,gen_random_uuid(),now(),'Pilot Counter','Disabled section','[]'::jsonb
        )`,
        params: [PROPERTY],
      },
    ];
    for (const call of calls) {
      await assert.rejects(
        asUser(GM, call.sql, call.params),
        /inventory section is disabled or unavailable/i,
        call.label,
      );
    }
    const receiptCountAfter = await pg.query<{ count: string }>(
      `select count(*)::text as count from public.inventory_write_receipts where property_id=$1`,
      [PROPERTY],
    );
    assert.equal(receiptCountAfter.rows[0].count, receiptCountBefore.rows[0].count);

    const implementations = [
      'public.staxis_save_inventory_count_0334_impl(uuid,uuid,timestamp with time zone,text,jsonb)',
      'public.staxis_receive_inventory_delivery_0334_impl(uuid,uuid,timestamp with time zone,text,text,jsonb)',
      'public.staxis_record_inventory_loss_0334_impl(uuid,uuid,timestamp with time zone,text,uuid,numeric,numeric,text,text)',
      'public.staxis_list_inventory_delivery_corrections_0334_impl(uuid,uuid[],boolean)',
      'public.staxis_correct_inventory_delivery_0334_impl(uuid,uuid,timestamp with time zone,text,text,jsonb)',
    ];
    for (const signature of implementations) {
      for (const role of ['authenticated', 'service_role']) {
        const hiddenImpl = await pg.query<{ allowed: boolean }>(
          `select has_function_privilege($1,$2,'EXECUTE') as allowed`,
          [role, signature],
        );
        assert.equal(hiddenImpl.rows[0].allowed, false, `${role} cannot bypass ${signature}`);
      }
    }

    const service = await asService(
      `select public.staxis_list_inventory_delivery_corrections($1,'{}'::uuid[],false) as result`,
      [PROPERTY],
    );
    assert.deepEqual(service[0].result, []);

    await setSections(`'{"inventory":true,"financials":true,"staff":true}'::jsonb`);
    const authenticated = await asUser(
      GM,
      `select public.staxis_list_inventory_delivery_corrections($1,'{}'::uuid[],false) as result`,
      [PROPERTY],
    );
    assert.deepEqual(authenticated[0].result, []);
  });

  test('RLS and grants leave no anonymous maintenance or roster mutation path', async () => {
    const tables = await pg.query<{ table_name: string; rls_enabled: boolean }>(`
      select c.relname::text as table_name, c.relrowsecurity as rls_enabled
      from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public'
        and c.relname in ('work_orders','preventive_tasks','staff')
      order by c.relname
    `);
    assert.deepEqual(tables.rows, [
      { table_name: 'preventive_tasks', rls_enabled: true },
      { table_name: 'staff', rls_enabled: true },
      { table_name: 'work_orders', rls_enabled: true },
    ]);

    for (const table of ['work_orders', 'preventive_tasks']) {
      for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
        const result = await pg.query<{ allowed: boolean }>(
          `select has_table_privilege('anon',$1,$2) as allowed`,
          [`public.${table}`, privilege],
        );
        assert.equal(result.rows[0].allowed, false, `anon ${privilege} on ${table}`);
      }
    }
    for (const privilege of ['INSERT', 'UPDATE', 'DELETE']) {
      const result = await pg.query<{ allowed: boolean }>(
        `select has_table_privilege('anon','public.staff',$1) as allowed`,
        [privilege],
      );
      assert.equal(result.rows[0].allowed, false, `anon ${privilege} on staff`);
    }
  });
});
