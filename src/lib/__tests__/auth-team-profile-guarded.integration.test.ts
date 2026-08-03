import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { PGlite } from '@electric-sql/pglite';

import { applyMigrationsToPgliteThrough } from '../../../tests/fixtures/pglite-migrate';
import {
  ACCOUNT_MARIA,
  PID_A1,
  PID_A2,
  UID_MARIA,
  seedTwoCompanies,
} from '../../../tests/fixtures/pglite-two-company-seed';

const TARGET = 'fa000000-0000-4000-8000-000000000001';
const TARGET_USER = 'fa000000-0000-4000-8000-000000000002';
const STAFF_A = 'fa000000-0000-4000-8000-000000000003';
const STAFF_B = 'fa000000-0000-4000-8000-000000000004';
const STAFF_FOREIGN = 'fa000000-0000-4000-8000-000000000005';
const STAFF_MISSING = 'fa000000-0000-4000-8000-000000000006';

interface Snapshot {
  active: boolean;
  role: string;
  data_user_id: string;
  property_access: string[];
  property_ids: string[];
  display_name: string;
  staff_id: string | null;
  updated_at: string;
  lifecycle_intent_version: number;
}

interface JsonRow { value: Record<string, unknown> }

async function snapshot(pg: PGlite): Promise<Snapshot> {
  const result = await pg.query<Snapshot>(
    `select account.active,account.role,account.data_user_id,
            account.property_access,
            public._staxis_structural_account_property_ids(account.id) as property_ids,
            account.display_name,account.staff_id,
            account.updated_at::text as updated_at,
            account.lifecycle_intent_version
     from public.accounts account where account.id=$1`,
    [TARGET],
  );
  assert.equal(result.rows.length, 1);
  return result.rows[0];
}

async function callProfile(
  pg: PGlite,
  current: Snapshot,
  options: {
    displayName?: string;
    staffId?: string | null;
    requestId: string;
  },
): Promise<Record<string, unknown>> {
  const changeDisplay = options.displayName !== undefined;
  const changeStaff = Object.prototype.hasOwnProperty.call(options, 'staffId');
  const result = await pg.query<JsonRow>(
    `select public.staxis_update_hotel_team_profile_guarded(
       $1,$2,'maria@example.test',$3,$4,$5,$6,$7,$8,$9,$10,$11,
       $12::uuid[],$13::uuid[],$14,$15,$16::timestamptz,$17,$18
     ) as value`,
    [
      ACCOUNT_MARIA,
      UID_MARIA,
      PID_A1,
      TARGET,
      changeDisplay,
      options.displayName ?? null,
      changeStaff,
      changeStaff ? options.staffId ?? null : null,
      current.active,
      current.role,
      current.data_user_id,
      current.property_access,
      current.property_ids,
      current.display_name,
      current.staff_id,
      current.updated_at,
      current.lifecycle_intent_version,
      options.requestId,
    ],
  );
  return result.rows[0].value;
}

describe('guarded My Hotel profile/staff commit boundary — real SQL', () => {
  let pg: PGlite;

  before(async () => {
    const migrated = await applyMigrationsToPgliteThrough('0425');
    pg = migrated.pg;
    await seedTwoCompanies(pg);
    await pg.query(
      `insert into auth.users(id,email) values ($1,'profile-target@example.test')`,
      [TARGET_USER],
    );
    await pg.query(
      `insert into public.accounts(
         id,username,display_name,role,property_access,data_user_id
       ) values ($1,'profile-target','Profile Target','front_desk',array[$2]::uuid[],$3)`,
      [TARGET, PID_A1, TARGET_USER],
    );
    await pg.query(
      `insert into public.staff(id,property_id,name,is_active)
       values ($1,$2,'Profile Staff A',true),
              ($3,$2,'Profile Staff B',true),
              ($4,$5,'Foreign Staff',true)`,
      [STAFF_A, PID_A1, STAFF_B, STAFF_FOREIGN, PID_A2],
    );
  });

  after(async () => {
    await pg?.close();
  });

  test('service-only RPC atomically writes account, normalized staff link, and audit', async () => {
    const acl = await pg.query<{
      service_execute: boolean;
      authenticated_execute: boolean;
      anon_execute: boolean;
    }>(
      `select
         has_function_privilege(
           'service_role',
           'public.staxis_update_hotel_team_profile_guarded(uuid,uuid,text,uuid,uuid,boolean,text,boolean,uuid,boolean,text,uuid,uuid[],uuid[],text,uuid,timestamptz,bigint,text)',
           'EXECUTE'
         ) as service_execute,
         has_function_privilege(
           'authenticated',
           'public.staxis_update_hotel_team_profile_guarded(uuid,uuid,text,uuid,uuid,boolean,text,boolean,uuid,boolean,text,uuid,uuid[],uuid[],text,uuid,timestamptz,bigint,text)',
           'EXECUTE'
         ) as authenticated_execute,
         has_function_privilege(
           'anon',
           'public.staxis_update_hotel_team_profile_guarded(uuid,uuid,text,uuid,uuid,boolean,text,boolean,uuid,boolean,text,uuid,uuid[],uuid[],text,uuid,timestamptz,bigint,text)',
           'EXECUTE'
         ) as anon_execute`,
    );
    assert.deepEqual(acl.rows[0], {
      service_execute: true,
      authenticated_execute: false,
      anon_execute: false,
    });

    const initial = await snapshot(pg);
    await pg.exec('begin');
    await pg.exec('set local role service_role');
    const result = await callProfile(pg, initial, {
      displayName: 'Profile Updated',
      staffId: STAFF_A,
      requestId: 'profile-happy',
    });
    await pg.exec('commit');
    assert.deepEqual(result, {
      status: 'ok',
      audit_written: true,
      display_name_changed: true,
      staff_link_changed: true,
    });

    const account = await pg.query<{ display_name: string; staff_id: string | null }>(
      `select display_name,staff_id from public.accounts where id=$1`, [TARGET],
    );
    assert.deepEqual(account.rows[0], {
      display_name: 'Profile Updated',
      staff_id: STAFF_A,
    });
    const link = await pg.query<{
      staff_id: string;
      is_active: boolean;
      source: string;
      linked_by_account_id: string;
    }>(
      `select staff_id,is_active,source,linked_by_account_id
       from public.account_property_staff_links
       where account_id=$1 and property_id=$2`,
      [TARGET, PID_A1],
    );
    assert.deepEqual(link.rows[0], {
      staff_id: STAFF_A,
      is_active: true,
      source: 'manual',
      linked_by_account_id: ACCOUNT_MARIA,
    });
    const audit = await pg.query<{ count: number }>(
      `select count(*)::integer as count from public.admin_audit_log
       where action='account.team_update' and target_id=$1
         and metadata->>'request_id'='profile-happy'
         and metadata->>'staff_link_changed'='true'`,
      [TARGET],
    );
    assert.equal(Number(audit.rows[0].count), 1);
  });

  test('audit failure rolls back the account and staff-link subgraph exactly', async () => {
    const initial = await snapshot(pg);
    const initialLink = await pg.query<Record<string, unknown>>(
      `select * from public.account_property_staff_links
       where account_id=$1 and property_id=$2`,
      [TARGET, PID_A1],
    );
    const initialAudit = await pg.query<{ count: number }>(
      `select count(*)::integer as count from public.admin_audit_log
       where target_id=$1`, [TARGET],
    );

    await pg.exec('begin');
    try {
      await pg.exec(`
        create function public._staxis_test_reject_profile_audit()
        returns trigger language plpgsql as $$
        begin
          if new.metadata->>'request_id' = 'profile-audit-fail' then
            raise exception 'simulated profile audit failure';
          end if;
          return new;
        end;
        $$;
        create trigger trg_staxis_test_reject_profile_audit
        before insert on public.admin_audit_log
        for each row execute function public._staxis_test_reject_profile_audit();
      `);
      await pg.exec('set local role service_role');
      await assert.rejects(
        callProfile(pg, initial, {
          displayName: 'Must Roll Back',
          staffId: STAFF_B,
          requestId: 'profile-audit-fail',
        }),
        /simulated profile audit failure/i,
      );
    } finally {
      await pg.exec('rollback').catch(() => undefined);
    }

    assert.deepEqual(await snapshot(pg), initial);
    const finalLink = await pg.query<Record<string, unknown>>(
      `select * from public.account_property_staff_links
       where account_id=$1 and property_id=$2`,
      [TARGET, PID_A1],
    );
    assert.deepEqual(finalLink.rows, initialLink.rows);
    const finalAudit = await pg.query<{ count: number }>(
      `select count(*)::integer as count from public.admin_audit_log
       where target_id=$1`, [TARGET],
    );
    assert.equal(Number(finalAudit.rows[0].count), Number(initialAudit.rows[0].count));
  });

  test('a caught staff-link constraint failure rolls back the preceding account update', async () => {
    const initial = await snapshot(pg);
    const initialLink = await pg.query<Record<string, unknown>>(
      `select * from public.account_property_staff_links
       where account_id=$1 and property_id=$2`,
      [TARGET, PID_A1],
    );
    const initialAudit = await pg.query<{ count: number }>(
      `select count(*)::integer as count from public.admin_audit_log
       where target_id=$1`, [TARGET],
    );

    await pg.exec('begin');
    try {
      await pg.exec(`
        create function public._staxis_test_reject_profile_link()
        returns trigger language plpgsql as $$
        begin
          if current_setting('staxis.request_id', true) = 'profile-link-conflict' then
            raise unique_violation using message = 'simulated staff-link uniqueness race';
          end if;
          return new;
        end;
        $$;
        create trigger trg_staxis_test_reject_profile_link
        before insert or update on public.account_property_staff_links
        for each row execute function public._staxis_test_reject_profile_link();
      `);
      await pg.exec('set local role service_role');
      const result = await callProfile(pg, initial, {
        displayName: 'Must Also Roll Back',
        staffId: STAFF_B,
        requestId: 'profile-link-conflict',
      });
      assert.deepEqual(result, { status: 'conflict', reason: 'staff_link' });
      await pg.exec('reset role');

      assert.deepEqual(await snapshot(pg), initial);
      const currentLink = await pg.query<Record<string, unknown>>(
        `select * from public.account_property_staff_links
         where account_id=$1 and property_id=$2`,
        [TARGET, PID_A1],
      );
      assert.deepEqual(currentLink.rows, initialLink.rows);
      const currentAudit = await pg.query<{ count: number }>(
        `select count(*)::integer as count from public.admin_audit_log
         where target_id=$1`, [TARGET],
      );
      assert.equal(Number(currentAudit.rows[0].count), Number(initialAudit.rows[0].count));
    } finally {
      await pg.exec('rollback').catch(() => undefined);
    }
  });

  test('fresh capability revocation and incomplete full-target control deny without writes', async () => {
    const baseline = await snapshot(pg);
    const baselineAudit = await pg.query<{ count: number }>(
      `select count(*)::integer as count from public.admin_audit_log where target_id=$1`,
      [TARGET],
    );

    await pg.exec('begin');
    await pg.query(
      `insert into public.capability_overrides(property_id,capability,role,allowed)
       values ($1,'manage_team','general_manager',false)
       on conflict (property_id,capability,role) do update set allowed=false`,
      [PID_A1],
    );
    const revoked = await callProfile(pg, baseline, {
      displayName: 'Revoked Write', requestId: 'profile-revoked',
    });
    assert.deepEqual(revoked, { status: 'forbidden', reason: 'manage_team' });
    assert.deepEqual(await snapshot(pg), baseline);
    await pg.exec('rollback');

    await pg.exec('begin');
    await pg.query(
      `update public.accounts set property_access=array[$1,$2]::uuid[] where id=$3`,
      [PID_A1, PID_A2, TARGET],
    );
    const multiHotel = await snapshot(pg);
    const incomplete = await callProfile(pg, multiHotel, {
      displayName: 'Cross Hotel Write', requestId: 'profile-incomplete',
    });
    assert.deepEqual(incomplete, { status: 'forbidden', reason: 'manage_team' });
    assert.equal((await snapshot(pg)).display_name, multiHotel.display_name);
    await pg.exec('rollback');

    const finalAudit = await pg.query<{ count: number }>(
      `select count(*)::integer as count from public.admin_audit_log where target_id=$1`,
      [TARGET],
    );
    assert.equal(Number(finalAudit.rows[0].count), Number(baselineAudit.rows[0].count));
  });

  test('hotel transfer invalidates the observed scope and foreign staff IDs are non-enumerable', async () => {
    const observed = await snapshot(pg);
    await pg.exec('begin');
    await pg.query(
      `update public.accounts set property_access=array[$1]::uuid[] where id=$2`,
      [PID_A2, TARGET],
    );
    const transferred = await callProfile(pg, observed, {
      displayName: 'Stale Transfer Write', requestId: 'profile-transfer',
    });
    assert.deepEqual(transferred, { status: 'not_found' });
    assert.equal((await snapshot(pg)).display_name, observed.display_name);
    await pg.exec('rollback');

    const current = await snapshot(pg);
    const foreign = await callProfile(pg, current, {
      staffId: STAFF_FOREIGN, requestId: 'profile-foreign-staff',
    });
    const missing = await callProfile(pg, current, {
      staffId: STAFF_MISSING, requestId: 'profile-missing-staff',
    });
    assert.deepEqual(foreign, { status: 'not_found' });
    assert.deepEqual(missing, foreign);
    assert.deepEqual(await snapshot(pg), current);
  });
});
