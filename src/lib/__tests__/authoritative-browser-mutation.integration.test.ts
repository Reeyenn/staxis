import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { PGlite } from '@electric-sql/pglite';

import { applyMigrationsToPgliteThrough } from '../../../tests/fixtures/pglite-migrate';
import {
  ACCOUNT_ADMIN,
  ACCOUNT_MARIA,
  ORG_A,
  PID_A1,
  PID_A2,
  PID_B1,
  PID_L1,
  UID_ADMIN,
  UID_ANA,
  UID_FIONA,
  UID_GIL,
  UID_MARIA,
  UID_WANDA,
  seedTwoCompanies,
} from '../../../tests/fixtures/pglite-two-company-seed';

const REQUEST_ID = '94000000-0000-4000-8000-000000000001';
const ITEM_ID = '94000000-0000-4000-8000-000000000002';
const PRIVATE_CONVERSATION_ID = '94000000-0000-4000-8000-000000000003';
const PRIVATE_MESSAGE_ID = '94000000-0000-4000-8000-000000000004';

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

before(async () => {
  const migrated = await applyMigrationsToPgliteThrough('0425');
  assert.equal(
    migrated.report.failedAtRuntime.some((failure) => failure.file.startsWith('0394_')),
    false,
    `0396 must apply: ${JSON.stringify(migrated.report.failedAtRuntime)}`,
  );
  pg = migrated.pg;
  await seedTwoCompanies(pg);
  // Hosted Supabase has browser table grants outside this migration chain.
  // Mirror only the direct surface under test so RLS, not GRANT, decides.
  await pg.exec(`grant select, insert, update, delete on public.work_orders to authenticated`);
  await pg.exec(`grant select on
    public.comms_conversations, public.comms_members, public.comms_messages,
    public.comms_presence, public.schedule_templates,
    public.schedule_week_signoffs to authenticated`);
  await pg.query(
    `insert into public.work_orders(
       property_id,room_number,description,severity,status
     ) values ($1,'101','Existing scoped row','medium','submitted')`,
    [PID_A1],
  );
  await pg.query(
    `insert into public.comms_conversations(id,property_id,kind,dm_key,title)
     values ($1,$2,'dm','private-a:private-b','Private DM')`,
    [PRIVATE_CONVERSATION_ID, PID_A1],
  );
  await pg.query(
    `insert into public.comms_members(property_id,conversation_id,staff_id)
     values ($1,$2,'94000000-0000-4000-8000-000000000005')`,
    [PID_A1, PRIVATE_CONVERSATION_ID],
  );
  await pg.query(
    `insert into public.comms_messages(id,property_id,conversation_id,body)
     values ($1,$2,$3,'private message body')`,
    [PRIVATE_MESSAGE_ID, PID_A1, PRIVATE_CONVERSATION_ID],
  );
  await pg.query(
    `insert into public.comms_presence(property_id,staff_id)
     values ($1,'94000000-0000-4000-8000-000000000005')`,
    [PID_A1],
  );
  await pg.query(
    `insert into public.schedule_templates(property_id,scope,name,payload,created_by)
     values ($1,'day','Private staffing plan','[{"staffId":"secret"}]'::jsonb,$2)`,
    [PID_A1, ACCOUNT_MARIA],
  );
});

after(async () => {
  await pg?.close();
});

describe('0396 authoritative browser mutation boundary', () => {
  test('company oversight and finance retain reads but never acquire hotel mutation', async () => {
    for (const [userId, propertyId] of [
      [UID_ANA, PID_A1],
      [UID_MARIA, PID_A2],
      [UID_FIONA, PID_A1],
    ] as const) {
      const flags = await asUser(
        userId,
        `select public.user_owns_property($1) as reaches,
                public.staxis_user_can_mutate_property($1) as mutates`,
        [propertyId],
      );
      assert.deepEqual(flags[0], { reaches: true, mutates: false });
    }

    const financeRows = await asUser(
      UID_FIONA,
      `select description from public.work_orders where property_id=$1`,
      [PID_A1],
    );
    assert.equal(financeRows.length, 1, 'read-only company reach lost its hotel read');
    const finance = await asUser(
      UID_FIONA,
      `select public.staxis_user_can_view_inventory_financials($1) as allowed`,
      [PID_A1],
    );
    assert.equal(finance[0]?.allowed, true, 'finance hat lost server-side hotel financial read');

    await assert.rejects(
      asUser(
        UID_FIONA,
        `insert into public.work_orders(property_id,room_number,description,severity,status)
         values ($1,'102','forbidden finance write','low','submitted')`,
        [PID_A1],
      ),
      /row-level security|violates row-level security/i,
    );
  });

  test('private communications and schedules never reopen through property-wide PostgREST reads', async () => {
    for (const userId of [UID_FIONA, UID_MARIA]) {
      for (const [table, column] of [
        ['comms_conversations', 'id'],
        ['comms_members', 'id'],
        ['comms_messages', 'id'],
        ['comms_presence', 'staff_id'],
        ['schedule_templates', 'id'],
        ['schedule_week_signoffs', 'id'],
      ] as const) {
        const rows = await asUser(
          userId,
          `select ${column} from public.${table} where property_id=$1`,
          [PID_A1],
        );
        assert.equal(rows.length, 0, `${userId} bypassed route-only ${table}`);
      }
    }
    const managerAlias = await asUser(
      UID_FIONA,
      `select public.user_manages_property($1) as allowed`,
      [PID_A1],
    );
    assert.equal(managerAlias[0]?.allowed, false, 'legacy property_access survived normalized cutover');
  });

  test('explicit property operations, legacy assignment, and direct-ID walls remain exact', async () => {
    assert.deepEqual(
      (await asUser(
        UID_MARIA,
        `select public.staxis_user_can_mutate_property($1) as mutates`,
        [PID_A1],
      ))[0],
      { mutates: true },
    );
    assert.deepEqual(
      (await asUser(
        UID_GIL,
        `select public.staxis_user_can_mutate_property($1) as own,
                public.staxis_user_can_mutate_property($2) as foreign`,
        [PID_B1, PID_A1],
      ))[0],
      { own: true, foreign: false },
    );
    assert.deepEqual(
      (await asUser(
        UID_WANDA,
        `select public.staxis_user_can_mutate_property($1) as legacy`,
        [PID_L1],
      ))[0],
      { legacy: true },
    );

    await asUser(
      UID_MARIA,
      `insert into public.work_orders(property_id,room_number,description,severity,status)
       values ($1,'103','explicit GM write','low','submitted')`,
      [PID_A1],
    );
    await assert.rejects(
      asUser(
        UID_MARIA,
        `insert into public.work_orders(property_id,room_number,description,severity,status)
         values ($1,'104','VP-only write','low','submitted')`,
        [PID_A2],
      ),
      /row-level security|violates row-level security/i,
    );
  });

  test('property-hat revocation is immediate even while company read reach remains', async () => {
    const membership = await pg.query<{ id: string }>(
      `select id from public.organization_memberships
       where account_id=$1 and organization_id=$2
         and membership_scope='property' and staxis_role='general_manager'
         and ended_at is null`,
      [ACCOUNT_MARIA, ORG_A],
    );
    assert.equal(membership.rows.length, 1);
    await pg.query(`select public.staxis_end_membership_hat($1,$2)`, [
      ACCOUNT_ADMIN,
      membership.rows[0].id,
    ]);
    const after = await asUser(
      UID_MARIA,
      `select public.user_owns_property($1) as reaches,
              public.staxis_user_can_mutate_property($1) as mutates`,
      [PID_A1],
    );
    assert.deepEqual(after[0], { reaches: true, mutates: false });
  });

  test('active platform-admin mutation disappears on deactivation and demotion', async () => {
    assert.equal((await asUser(
      UID_ADMIN,
      `select public.staxis_user_can_mutate_property($1) as allowed`,
      [PID_A1],
    ))[0]?.allowed, true);

    await pg.query(`update public.accounts set active=false where id=$1`, [ACCOUNT_ADMIN]);
    assert.equal((await asUser(
      UID_ADMIN,
      `select public.staxis_user_can_mutate_property($1) as allowed,
              public.is_admin_user($2) as admin`,
      [PID_A1, UID_ADMIN],
    ))[0]?.allowed, false);
    await pg.query(`update public.accounts set active=true, role='owner' where id=$1`, [ACCOUNT_ADMIN]);
    const demoted = await asUser(
      UID_ADMIN,
      `select public.staxis_user_can_mutate_property($1) as allowed,
              public.is_admin_user($2) as admin`,
      [PID_A1, UID_ADMIN],
    );
    assert.deepEqual(demoted[0], { allowed: false, admin: false });
  });

  test('all authenticated inventory mutator entry points reject before replay or payload work', async () => {
    const attempts: Array<[string, unknown[]]> = [
      [
        `select public.staxis_save_inventory_count($1,$2,null,'Finance','[]'::jsonb)`,
        [PID_A1, REQUEST_ID],
      ],
      [
        `select public.staxis_receive_inventory_delivery($1,$2,null,'Vendor',null,'[]'::jsonb)`,
        [PID_A1, REQUEST_ID],
      ],
      [
        `select public.staxis_record_inventory_loss(
           $1,$2,null,'Finance',$3,0,1,'damage',null
         )`,
        [PID_A1, REQUEST_ID, ITEM_ID],
      ],
      [
        `select public.staxis_correct_inventory_delivery(
           $1,$2,null,'Finance','correction','[]'::jsonb
         )`,
        [PID_A1, REQUEST_ID],
      ],
      [
        `select public.staxis_verify_legacy_archived_inventory_zero(
           $1,$2,$3,now(),'Finance','verify'
         )`,
        [PID_A1, REQUEST_ID, ITEM_ID],
      ],
    ];
    for (const [sql, params] of attempts) {
      await assert.rejects(asUser(UID_FIONA, sql, params), /not authorized/i);
    }
  });
});
