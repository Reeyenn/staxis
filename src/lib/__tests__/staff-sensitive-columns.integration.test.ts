import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { PGlite } from '@electric-sql/pglite';
import { applyMigrationsToPgliteWithHook } from '../../../tests/fixtures/pglite-migrate';

const GM = '91000000-0000-4000-8000-000000000001';
const LINE_STAFF = '91000000-0000-4000-8000-000000000002';
const OUTSIDER = '91000000-0000-4000-8000-000000000003';
const PROPERTY = '92000000-0000-4000-8000-000000000001';
const FOREIGN_PROPERTY = '92000000-0000-4000-8000-000000000002';
const ROSTER_ID = '93000000-0000-4000-8000-000000000001';

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

describe('staff sensitive-column privileges migration 0332', () => {
  before(async () => {
    const migrated = await applyMigrationsToPgliteWithHook(async ({ pg: hookPg, file }) => {
      if (file === '0332_staff_sensitive_column_privileges.sql') {
        // Supabase grants table DML to authenticated by default. Seed the
        // pre-migration privilege shape so this proves 0332 changes SELECT
        // only and leaves migration 0330's RLS-gated writes intact.
        await hookPg.exec(`
          grant select, insert, update, delete on public.staff to authenticated;
          grant select, insert, update, delete on public.staff to service_role;
        `);
      }
    });
    pg = migrated.pg;
    assert.ok(
      migrated.report.applied.includes('0332_staff_sensitive_column_privileges.sql'),
      `0332 must apply in PGlite: ${JSON.stringify(
        migrated.report.failedAtRuntime.filter(entry => entry.file.startsWith('0332')),
      )}`,
    );

    await pg.query(
      `insert into auth.users(id,email) values
         ($1,'gm-staff-privacy@example.test'),
         ($2,'line-staff-privacy@example.test'),
         ($3,'outsider-staff-privacy@example.test')
       on conflict (id) do nothing`,
      [GM, LINE_STAFF, OUTSIDER],
    );
    await pg.query(
      `insert into public.properties(id,owner_id,name,total_rooms,timezone)
       values
         ($1,$2,'Staff Privacy Hotel',60,'UTC'),
         ($3,$4,'Foreign Staff Privacy Hotel',60,'UTC')
       on conflict (id) do nothing`,
      [PROPERTY, GM, FOREIGN_PROPERTY, OUTSIDER],
    );
    await pg.query(
      `insert into public.accounts(username,display_name,role,property_access,data_user_id)
       values
         ('privacy-gm','Privacy GM','general_manager',array[$1]::uuid[],$2),
         ('privacy-line','Privacy Line Staff','housekeeping',array[$1]::uuid[],$3),
         ('privacy-outsider','Privacy Outsider','general_manager',array[$4]::uuid[],$5)
       on conflict (username) do nothing`,
      [PROPERTY, GM, LINE_STAFF, FOREIGN_PROPERTY, OUTSIDER],
    );
    await pg.query(
      `insert into public.staff(
         id,property_id,name,phone,phone_lookup,hourly_wage,language,
         department,is_active,max_weekly_hours
       ) values ($1,$2,'Pilot Housekeeper','+13125550123','3125550123',18.50,
         'en','housekeeping',true,40)`,
      [ROSTER_ID, PROPERTY],
    );
  });

  after(async () => {
    await pg.close();
  });

  test('authenticated property members can read the operational roster only', async () => {
    const rows = await asUser(
      LINE_STAFF,
      `select id,property_id,name,department,is_active,max_weekly_hours
       from public.staff where property_id=$1`,
      [PROPERTY],
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, ROSTER_ID);

    for (const column of ['phone', 'phone_lookup', 'hourly_wage']) {
      await assert.rejects(
        asUser(LINE_STAFF, `select ${column} from public.staff where property_id=$1`, [PROPERTY]),
        /permission denied|staff|column/i,
        `authenticated must not directly select staff.${column}`,
      );
    }
    await assert.rejects(
      asUser(LINE_STAFF, `select * from public.staff where property_id=$1`, [PROPERTY]),
      /permission denied|staff|column/i,
    );
  });

  test('the existing roster RLS still hides operational rows cross-property', async () => {
    const rows = await asUser(
      OUTSIDER,
      `select id,name from public.staff where property_id=$1`,
      [PROPERTY],
    );
    assert.deepEqual(rows, []);
  });

  test('service role retains full reads for manager-gated contact and wage APIs', async () => {
    const rows = await asService(
      `select phone,phone_lookup,hourly_wage from public.staff where id=$1`,
      [ROSTER_ID],
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].phone, '+13125550123');
    assert.equal(rows[0].phone_lookup, '3125550123');
    assert.equal(Number(rows[0].hourly_wage), 18.5);
  });

  test('0332 preserves writes while 0330 keeps them behind manage_team + MFA', async () => {
    const privileges = await pg.query<{
      can_update: boolean;
      can_read_phone: boolean;
      service_can_read_phone: boolean;
    }>(`
      select
        has_table_privilege('authenticated','public.staff','UPDATE') as can_update,
        has_column_privilege('authenticated','public.staff','phone','SELECT') as can_read_phone,
        has_column_privilege('service_role','public.staff','phone','SELECT') as service_can_read_phone
    `);
    assert.deepEqual(privileges.rows[0], {
      can_update: true,
      can_read_phone: false,
      service_can_read_phone: true,
    });

    const gmUpdate = await asUser(
      GM,
      `update public.staff set phone='+13125550999' where id=$1 returning id`,
      [ROSTER_ID],
    );
    assert.equal(gmUpdate.length, 1);

    const lineUpdate = await asUser(
      LINE_STAFF,
      `update public.staff set phone='+13125550000' where id=$1 returning id`,
      [ROSTER_ID],
    );
    assert.deepEqual(lineUpdate, []);

    const rows = await asService(`select phone from public.staff where id=$1`, [ROSTER_ID]);
    assert.equal(rows[0].phone, '+13125550999');
  });
});
