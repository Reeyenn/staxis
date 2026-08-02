import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { PGlite } from '@electric-sql/pglite';

import { applyMigrationsToPglite } from '../../../tests/fixtures/pglite-migrate';

const PROPERTY_MAIN = 'c4240000-0000-4000-8000-000000000001';
const PROPERTY_OTHER = 'c4240000-0000-4000-8000-000000000002';
const ORPHAN_PROPERTY = 'c4240000-0000-4000-8000-0000000000ff';

const ADMIN_ACCOUNT = 'c4241000-0000-4000-8000-000000000001';
const ADMIN_AUTH = 'c4242000-0000-4000-8000-000000000001';
const CANONICAL_ACCOUNT = 'c4241000-0000-4000-8000-000000000002';
const CANONICAL_AUTH = 'c4242000-0000-4000-8000-000000000002';
const DETACH_ACCOUNT = 'c4241000-0000-4000-8000-000000000003';
const DETACH_AUTH = 'c4242000-0000-4000-8000-000000000003';
const MISSING_IDENTITY_ACCOUNT = 'c4241000-0000-4000-8000-000000000004';
const ORPHAN_ACCOUNT = 'c4241000-0000-4000-8000-000000000005';
const ORPHAN_AUTH = 'c4242000-0000-4000-8000-000000000005';
const MISSING_IDENTITY_AUTH = 'c4242000-0000-4000-8000-0000000000ff';
const PROFILE_ACCOUNT = 'c4241000-0000-4000-8000-000000000006';
const PROFILE_AUTH = 'c4242000-0000-4000-8000-000000000006';
const INACTIVE_ACCOUNT = 'c4241000-0000-4000-8000-000000000007';
const INACTIVE_AUTH = 'c4242000-0000-4000-8000-000000000007';
const ATOMIC_ACCOUNT = 'c4241000-0000-4000-8000-000000000008';
const ATOMIC_ACCOUNT_AUTH = 'c4242000-0000-4000-8000-000000000008';
const ATOMIC_OWNER = 'c4241000-0000-4000-8000-000000000009';
const ATOMIC_OWNER_AUTH = 'c4242000-0000-4000-8000-000000000009';
const ATOMIC_TARGET = 'c4241000-0000-4000-8000-00000000000a';
const ATOMIC_TARGET_AUTH = 'c4242000-0000-4000-8000-00000000000a';
const NORMALIZED_OLD_OWNER = 'c4241000-0000-4000-8000-00000000000b';
const NORMALIZED_OLD_AUTH = 'c4242000-0000-4000-8000-00000000000b';
const NORMALIZED_NEW_OWNER = 'c4241000-0000-4000-8000-00000000000c';
const NORMALIZED_NEW_AUTH = 'c4242000-0000-4000-8000-00000000000c';
const COMPANY_OLD_OWNER = 'c4241000-0000-4000-8000-00000000000d';
const COMPANY_OLD_AUTH = 'c4242000-0000-4000-8000-00000000000d';
const COMPANY_NEW_MANAGER = 'c4241000-0000-4000-8000-00000000000e';
const COMPANY_NEW_AUTH = 'c4242000-0000-4000-8000-00000000000e';
const COMPANY_ORGANIZATION = 'c4245000-0000-4000-8000-000000000001';

let pg: PGlite;

async function asService<T>(sql: string, params: unknown[] = []): Promise<T> {
  await pg.exec('begin');
  try {
    await pg.exec('set local role service_role');
    const result = await pg.query(sql, params) as { rows: Array<Record<string, unknown>> };
    await pg.exec('commit');
    return Object.values(result.rows[0] ?? {})[0] as T;
  } catch (error) {
    await pg.exec('rollback').catch(() => undefined);
    throw error;
  }
}

function serviceJson(sql: string, params: unknown[] = []): Promise<Record<string, unknown>> {
  return asService<Record<string, unknown>>(sql, params);
}

async function accountState(accountId: string): Promise<{
  active: boolean;
  authority_mode: string;
  authority_version: number;
  role: string;
  updated_at: string;
  property_access: string[];
}> {
  const result = await pg.query<{
    active: boolean;
    authority_mode: string;
    authority_version: number;
    role: string;
    updated_at: string;
    property_access: string[];
  }>(
    `select account.active, state.authority_mode, state.authority_version,
            account.role, account.updated_at::text, account.property_access
       from public.account_authorization_state state
       join public.accounts account on account.id = state.account_id
      where state.account_id = $1`,
    [accountId],
  );
  assert.equal(result.rows.length, 1);
  return result.rows[0]!;
}

async function activeBridgeCount(accountId: string, propertyId: string): Promise<number> {
  const result = await pg.query<{ count: number }>(
    `select count(*)::integer as count
       from public.account_property_authorization_bridges
      where account_id = $1 and property_id = $2 and status = 'active'`,
    [accountId, propertyId],
  );
  return Number(result.rows[0]?.count ?? 0);
}

describe('Access Stage B canonical mutation boundary', () => {
  before(async () => {
    const migrated = await applyMigrationsToPglite();
    pg = migrated.pg;
    assert.ok(
      migrated.report.applied.includes('0424_authoritative_access_stage_b_mutations.sql'),
      JSON.stringify(migrated.report.failedAtRuntime),
    );

    await pg.query(
      `insert into auth.users (id, email)
       values ($1, 'stage-b-admin@example.test'),
              ($2, 'stage-b-canonical@example.test'),
              ($3, 'stage-b-detach@example.test'),
              ($4, 'stage-b-orphan@example.test'),
              ($5, 'stage-b-profile@example.test'),
              ($6, 'stage-b-inactive@example.test'),
              ($7, 'stage-b-atomic@example.test'),
              ($8, 'stage-b-atomic-owner@example.test'),
              ($9, 'stage-b-atomic-target@example.test'),
              ($10, 'stage-b-normalized-old@example.test'),
              ($11, 'stage-b-normalized-new@example.test')`,
      [
        ADMIN_AUTH, CANONICAL_AUTH, DETACH_AUTH, ORPHAN_AUTH,
        PROFILE_AUTH, INACTIVE_AUTH, ATOMIC_ACCOUNT_AUTH,
        ATOMIC_OWNER_AUTH, ATOMIC_TARGET_AUTH,
        NORMALIZED_OLD_AUTH, NORMALIZED_NEW_AUTH,
      ],
    );
    await pg.query(
      `insert into public.properties (id, owner_id, name, total_rooms, timezone)
       values ($1, $3, 'Stage B Main Hotel', 40, 'UTC'),
              ($2, $3, 'Stage B Other Hotel', 40, 'UTC')`,
      [PROPERTY_MAIN, PROPERTY_OTHER, ADMIN_AUTH],
    );
    await pg.query(
      `insert into public.accounts
         (id, username, password_hash, display_name, role, property_access, data_user_id)
       values
         ($1, 'stage-b-admin', 'x', 'Stage B Admin', 'admin', '{}'::uuid[], $2),
         ($3, 'stage-b-canonical', 'x', 'Stage B Canonical', 'front_desk', array[$5]::uuid[], $4),
         ($6, 'stage-b-detach', 'x', 'Stage B Detach', 'housekeeping', array[$5]::uuid[], $7),
         ($8, 'stage-b-profile', 'x', 'Stage B Profile', 'owner', '{}'::uuid[], $9),
         ($10, 'stage-b-inactive', 'x', 'Stage B Inactive', 'front_desk', '{}'::uuid[], $11),
         ($12, 'stage-b-atomic', 'x', 'Stage B Atomic', 'front_desk', array[$5]::uuid[], $13),
         ($14, 'stage-b-atomic-owner', 'x', 'Stage B Atomic Owner', 'owner', array[$5]::uuid[], $15),
         ($16, 'stage-b-atomic-target', 'x', 'Stage B Atomic Target', 'front_desk', array[$5]::uuid[], $17),
         ($18, 'stage-b-normalized-old', 'x', 'Stage B Normalized Old', 'owner', array[$5]::uuid[], $19),
         ($20, 'stage-b-normalized-new', 'x', 'Stage B Normalized New', 'general_manager', array[$5]::uuid[], $21)`,
      [
        ADMIN_ACCOUNT, ADMIN_AUTH,
        CANONICAL_ACCOUNT, CANONICAL_AUTH,
        PROPERTY_MAIN,
        DETACH_ACCOUNT, DETACH_AUTH,
        PROFILE_ACCOUNT, PROFILE_AUTH,
        INACTIVE_ACCOUNT, INACTIVE_AUTH,
        ATOMIC_ACCOUNT, ATOMIC_ACCOUNT_AUTH,
        ATOMIC_OWNER, ATOMIC_OWNER_AUTH,
        ATOMIC_TARGET, ATOMIC_TARGET_AUTH,
        NORMALIZED_OLD_OWNER, NORMALIZED_OLD_AUTH,
        NORMALIZED_NEW_OWNER, NORMALIZED_NEW_AUTH,
      ],
    );

    // These rows deliberately remain valid legacy/shadow rows with no bridge:
    // the Stage A non-enforcing compatibility writer records the failure, and
    // Stage B must refuse to guess them into canonical authority.
    await pg.query(`alter table public.accounts drop constraint accounts_data_user_id_fkey`);
    await pg.query(`alter table public.account_authorization_state
      disable trigger trg_account_authorization_state_notification`);
    try {
      await pg.query(
        `insert into public.accounts
           (id, username, password_hash, display_name, role, property_access, data_user_id)
         values
           ($1, 'stage-b-missing-identity', 'x', 'Missing Identity', 'front_desk', array[$3]::uuid[], $4),
           ($2, 'stage-b-orphan', 'x', 'Orphan Property', 'front_desk', array[$3]::uuid[], $5)`,
        [MISSING_IDENTITY_ACCOUNT, ORPHAN_ACCOUNT, PROPERTY_MAIN, MISSING_IDENTITY_AUTH, ORPHAN_AUTH],
      );
    } finally {
      await pg.query(`alter table public.account_authorization_state
        enable trigger trg_account_authorization_state_notification`);
    }
    await pg.query(`alter table public.accounts add constraint accounts_data_user_id_fkey
      foreign key (data_user_id) references auth.users(id) on delete cascade not valid`);
    await pg.query(
      `update public.accounts
          set property_access = array[$1]::uuid[]
        where id = $2`,
      [ORPHAN_PROPERTY, ORPHAN_ACCOUNT],
    );
    await pg.query(
      `update public.accounts set active = false where id = $1`,
      [INACTIVE_ACCOUNT],
    );
    await pg.query(
      `update public.accounts set property_access = array[$1]::uuid[] where id = $2`,
      [PROPERTY_MAIN, INACTIVE_ACCOUNT],
    );
    await pg.query(
      `insert into auth.users (id, email)
       values ($1, 'stage-b-company-old@example.test'),
              ($2, 'stage-b-company-new@example.test')`,
      [COMPANY_OLD_AUTH, COMPANY_NEW_AUTH],
    );
    await pg.query(
      `insert into public.accounts
         (id, username, password_hash, display_name, role, property_access, data_user_id)
       values
         ($1, 'stage-b-company-old', 'x', 'Stage B Company Old', 'owner', '{}'::uuid[], $2),
         ($3, 'stage-b-company-new', 'x', 'Stage B Company New', 'general_manager', '{}'::uuid[], $4)`,
      [COMPANY_OLD_OWNER, COMPANY_OLD_AUTH, COMPANY_NEW_MANAGER, COMPANY_NEW_AUTH],
    );
  });

  after(async () => {
    await pg.close();
  });

  test('canonical account scope mutation preserves the legacy receipt but authority follows bridges', async () => {
    const before = await accountState(CANONICAL_ACCOUNT);
    assert.equal(before.authority_mode, 'legacy');
    assert.deepEqual(before.property_access, [PROPERTY_MAIN]);

    const result = await serviceJson(
      `select public.staxis_set_account_authorization_scope(
         $1,$2,$3::uuid[],$4,$5,$6,'Stage B canonical scope test'
       )`,
      [
        ADMIN_ACCOUNT,
        CANONICAL_ACCOUNT,
        [PROPERTY_MAIN],
        before.authority_version,
        before.role,
        before.role,
      ],
    );
    assert.equal(result.ok, true);
    assert.equal(result.status, 'updated');

    const after = await accountState(CANONICAL_ACCOUNT);
    assert.equal(after.authority_mode, 'normalized');
    assert.deepEqual(after.property_access, [PROPERTY_MAIN]);
    assert.equal(await activeBridgeCount(CANONICAL_ACCOUNT, PROPERTY_MAIN), 1);

    const authority = await serviceJson(
      `select public.staxis_list_account_authorized_properties($1)`,
      [CANONICAL_ACCOUNT],
    );
    assert.deepEqual(authority.propertyIds, [PROPERTY_MAIN]);

    // A rollback-era array write is retained as evidence but cannot broaden a
    // normalized account after the application has moved to canonical reads.
    await pg.query(
      `update public.accounts set property_access = array[$1]::uuid[] where id = $2`,
      [PROPERTY_OTHER, CANONICAL_ACCOUNT],
    );
    const unchanged = await serviceJson(
      `select public.staxis_list_account_authorized_properties($1)`,
      [CANONICAL_ACCOUNT],
    );
    assert.deepEqual(unchanged.propertyIds, [PROPERTY_MAIN]);
    assert.equal((await accountState(CANONICAL_ACCOUNT)).property_access[0], PROPERTY_OTHER);
  });

  test('canonical detach retires authority and a retry cannot resurrect the bridge', async () => {
    const before = await accountState(DETACH_ACCOUNT);
    assert.equal(before.authority_mode, 'legacy');

    const detached = await serviceJson(
      `select public.staxis_remove_property_access_authoritative(
         $1,$2,'stage-b-admin@example.test',$3,$4,$5,$6,$7,$8
       )`,
      [
        ADMIN_ACCOUNT,
        ADMIN_AUTH,
        DETACH_ACCOUNT,
        PROPERTY_MAIN,
        before.role,
        before.authority_version,
        before.updated_at,
        'stage-b-detach-request',
      ],
    );
    assert.equal(detached.status, 'ok');
    assert.equal(await activeBridgeCount(DETACH_ACCOUNT, PROPERTY_MAIN), 0);
    assert.deepEqual((await accountState(DETACH_ACCOUNT)).property_access, [PROPERTY_MAIN]);
    const retired = await pg.query<{ count: number }>(
      `select count(*)::integer as count
         from public.account_property_authorization_bridges
        where account_id = $1 and property_id = $2 and status = 'retired'`,
      [DETACH_ACCOUNT, PROPERTY_MAIN],
    );
    assert.equal(retired.rows[0]?.count, 1);

    const retry = await serviceJson(
      `select public.staxis_set_account_authorization_scope(
         $1,$2,$3::uuid[],$4,$5,$6,'Stage B retired bridge retry'
       )`,
      [
        ADMIN_ACCOUNT,
        DETACH_ACCOUNT,
        [PROPERTY_MAIN],
        (await accountState(DETACH_ACCOUNT)).authority_version,
        before.role,
        before.role,
      ],
    );
    assert.equal(retry.ok, false);
    assert.equal(retry.reason, 'retired_bridge');
    assert.equal(await activeBridgeCount(DETACH_ACCOUNT, PROPERTY_MAIN), 0);
    assert.deepEqual((await accountState(DETACH_ACCOUNT)).property_access, [PROPERTY_MAIN]);
  });

  test('normalized self profile CAS uses canonical scope while raw array remains rollback data', async () => {
    const before = await accountState(PROFILE_ACCOUNT);
    const initialized = await serviceJson(
      `select public.staxis_set_account_authorization_scope(
         $1,$2,$3::uuid[],$4,$5,$6,'Stage B profile CAS setup'
       )`,
      [
        ADMIN_ACCOUNT,
        PROFILE_ACCOUNT,
        [PROPERTY_MAIN],
        before.authority_version,
        before.role,
        before.role,
      ],
    );
    assert.equal(initialized.ok, true);

    const current = await pg.query<{
      active: boolean;
      role: string;
      data_user_id: string;
      property_access: string[];
      display_name: string;
      staff_id: string | null;
      updated_at: string;
      lifecycle_intent_version: number;
    }>(
      `select active, role, data_user_id, property_access, display_name,
              staff_id, updated_at::text, lifecycle_intent_version
         from public.accounts where id = $1`,
      [PROFILE_ACCOUNT],
    );
    const row = current.rows[0]!;
    const stale = await serviceJson(
      `select public.staxis_update_hotel_team_profile_guarded(
         $1,$2,'stage-b-profile@example.test',$3,$4,true,'Stale Canonical Name',
         false,null,$5,$6,$7,$8::uuid[],$9::uuid[],$10,$11,$12,$13,'profile-stale'
       )`,
      [
        PROFILE_ACCOUNT,
        PROFILE_AUTH,
        PROPERTY_MAIN,
        PROFILE_ACCOUNT,
        row.active,
        row.role,
        row.data_user_id,
        [PROPERTY_MAIN],
        [PROPERTY_MAIN, PROPERTY_OTHER],
        row.display_name,
        row.staff_id,
        row.updated_at,
        row.lifecycle_intent_version,
      ],
    );
    assert.equal(stale.status, 'conflict');

    const successful = await serviceJson(
      `select public.staxis_update_hotel_team_profile_guarded(
         $1,$2,'stage-b-profile@example.test',$3,$4,true,'Canonical Name',
         false,null,$5,$6,$7,$8::uuid[],$9::uuid[],$10,$11,$12,$13,'profile-ok'
       )`,
      [
        PROFILE_ACCOUNT,
        PROFILE_AUTH,
        PROPERTY_MAIN,
        PROFILE_ACCOUNT,
        row.active,
        row.role,
        row.data_user_id,
        [PROPERTY_MAIN],
        [PROPERTY_MAIN],
        row.display_name,
        row.staff_id,
        row.updated_at,
        row.lifecycle_intent_version,
      ],
    );
    assert.equal(successful.status, 'ok');
    const after = await pg.query<{ display_name: string; property_access: string[] }>(
      `select display_name, property_access from public.accounts where id = $1`,
      [PROFILE_ACCOUNT],
    );
    assert.equal(after.rows[0]?.display_name, 'Canonical Name');
    assert.deepEqual(after.rows[0]?.property_access, []);
  });

  test('rejected set, detach, and ownership mutations leave canonical state and evidence unchanged', async () => {
    const beforeSet = await accountState(ATOMIC_ACCOUNT);
    const beforeSetBridges = await pg.query<{ count: number }>(
      `select count(*)::integer as count from public.account_property_authorization_bridges
        where account_id = $1 and status = 'active'`,
      [ATOMIC_ACCOUNT],
    );
    const setResult = await serviceJson(
      `select public.staxis_set_account_authorization_scope(
         $1,$2,$3::uuid[],$4,$5,$6,'Stage B rejected set atomicity'
       )`,
      [
        ADMIN_ACCOUNT,
        ATOMIC_ACCOUNT,
        [ORPHAN_PROPERTY],
        beforeSet.authority_version,
        beforeSet.role,
        beforeSet.role,
      ],
    );
    assert.equal(setResult.ok, false);
    assert.equal(setResult.reason, 'property_missing');
    assert.deepEqual(await accountState(ATOMIC_ACCOUNT), beforeSet);
    const afterSetBridges = await pg.query<{ count: number }>(
      `select count(*)::integer as count from public.account_property_authorization_bridges
        where account_id = $1 and status = 'active'`,
      [ATOMIC_ACCOUNT],
    );
    assert.equal(afterSetBridges.rows[0]?.count, beforeSetBridges.rows[0]?.count);

    const beforeDetach = await accountState(ATOMIC_TARGET);
    const beforeDetachBridges = await pg.query<{ count: number }>(
      `select count(*)::integer as count from public.account_property_authorization_bridges
        where account_id = $1 and property_id = $2 and status = 'active'`,
      [ATOMIC_TARGET, PROPERTY_MAIN],
    );
    const beforeDetachAudit = await pg.query<{ count: number }>(
      `select count(*)::integer as count from public.admin_audit_log
        where target_id = $1 and action = 'account.team_detach'`,
      [ATOMIC_TARGET],
    );
    await pg.query(
      `insert into public.capability_overrides
         (property_id, role, capability, allowed)
       values ($1, 'owner', 'manage_users', false)`,
      [PROPERTY_MAIN],
    );
    try {
      const detachResult = await serviceJson(
        `select public.staxis_remove_property_access_authoritative(
           $1,$2,'stage-b-atomic-owner@example.test',$3,$4,$5,$6,$7,$8
         )`,
        [
          ATOMIC_OWNER,
          ATOMIC_OWNER_AUTH,
          ATOMIC_TARGET,
          PROPERTY_MAIN,
          beforeDetach.role,
          beforeDetach.authority_version,
          beforeDetach.updated_at,
          'atomic-detach-reject',
        ],
      );
      assert.equal(detachResult.status, 'forbidden');
      assert.equal(detachResult.reason, 'manage_users');
    } finally {
      await pg.query(
        `delete from public.capability_overrides
          where property_id = $1 and role = 'owner' and capability = 'manage_users'`,
        [PROPERTY_MAIN],
      );
    }
    assert.deepEqual(await accountState(ATOMIC_TARGET), beforeDetach);
    assert.equal(
      await activeBridgeCount(ATOMIC_TARGET, PROPERTY_MAIN),
      beforeDetachBridges.rows[0]?.count,
    );
    const afterDetachAudit = await pg.query<{ count: number }>(
      `select count(*)::integer as count from public.admin_audit_log
        where target_id = $1 and action = 'account.team_detach'`,
      [ATOMIC_TARGET],
    );
    assert.equal(afterDetachAudit.rows[0]?.count, beforeDetachAudit.rows[0]?.count);

    const beforeOwnerOld = await accountState(ATOMIC_OWNER);
    const beforeOwnerNew = await accountState(ATOMIC_TARGET);
    const beforeOwnerOldBridges = await pg.query<{ count: number }>(
      `select count(*)::integer as count from public.account_property_authorization_bridges
        where account_id = $1 and status = 'active'`,
      [ATOMIC_OWNER],
    );
    const beforeOwnerNewBridges = await pg.query<{ count: number }>(
      `select count(*)::integer as count from public.account_property_authorization_bridges
        where account_id = $1 and status = 'active'`,
      [ATOMIC_TARGET],
    );
    const beforeOwnerAudit = await pg.query<{ count: number }>(
      `select count(*)::integer as count from public.admin_audit_log
        where action = 'account.transfer_ownership'`,
    );
    const ownerResult = await serviceJson(
      `select public.staxis_transfer_ownership_guarded(
         $1,$2,$3,'stage-b-atomic-owner@example.test',$4,$5,$6,
         $7::boolean,$8::text,$9::uuid,$10::uuid[],$11::bigint,
         $12::boolean,$13::text,$14::uuid,$15::uuid[],$16::bigint,
         $17,$18
       )`,
      [
        'c4243000-0000-4000-8000-000000000008',
        ATOMIC_OWNER,
        ATOMIC_OWNER_AUTH,
        PROPERTY_MAIN,
        ATOMIC_OWNER,
        ATOMIC_TARGET,
        beforeOwnerOld.active,
        beforeOwnerOld.role,
        ATOMIC_OWNER_AUTH,
        [PROPERTY_OTHER],
        0,
        beforeOwnerNew.active,
        beforeOwnerNew.role,
        ATOMIC_TARGET_AUTH,
        [PROPERTY_MAIN],
        0,
        'Stage B ownership CAS atomicity',
        'atomic-owner-reject',
      ],
    );
    assert.equal(ownerResult.status, 'conflict', JSON.stringify(ownerResult));
    assert.deepEqual(await accountState(ATOMIC_OWNER), beforeOwnerOld);
    assert.deepEqual(await accountState(ATOMIC_TARGET), beforeOwnerNew);
    assert.equal(
      (await pg.query<{ count: number }>(
        `select count(*)::integer as count from public.account_property_authorization_bridges
          where account_id = $1 and status = 'active'`,
        [ATOMIC_OWNER],
      )).rows[0]?.count,
      beforeOwnerOldBridges.rows[0]?.count,
    );
    assert.equal(
      (await pg.query<{ count: number }>(
        `select count(*)::integer as count from public.account_property_authorization_bridges
          where account_id = $1 and status = 'active'`,
        [ATOMIC_TARGET],
      )).rows[0]?.count,
      beforeOwnerNewBridges.rows[0]?.count,
    );
    const afterOwnerAudit = await pg.query<{ count: number }>(
      `select count(*)::integer as count from public.admin_audit_log
        where action = 'account.transfer_ownership'`,
    );
    assert.equal(afterOwnerAudit.rows[0]?.count, beforeOwnerAudit.rows[0]?.count);
  });

  test('inactive legacy import fails before any canonical write and does not auto-bridge after reactivation', async () => {
    const before = await accountState(INACTIVE_ACCOUNT);
    assert.equal(before.authority_mode, 'legacy');
    const result = await serviceJson(
      `select public.staxis_set_account_authorization_scope(
         $1,$2,$3::uuid[],$4,$5,$6,'Stage B inactive import'
       )`,
      [
        ADMIN_ACCOUNT,
        INACTIVE_ACCOUNT,
        [PROPERTY_MAIN],
        before.authority_version,
        before.role,
        before.role,
      ],
    );
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'account_inactive');
    assert.deepEqual(await accountState(INACTIVE_ACCOUNT), before);
    assert.equal(await activeBridgeCount(INACTIVE_ACCOUNT, PROPERTY_MAIN), 0);

    await pg.query(`update public.accounts set active = true where id = $1`, [INACTIVE_ACCOUNT]);
    const afterReactivation = await accountState(INACTIVE_ACCOUNT);
    assert.equal(afterReactivation.authority_mode, 'legacy');
    assert.equal(await activeBridgeCount(INACTIVE_ACCOUNT, PROPERTY_MAIN), 0);
    const authority = await serviceJson(
      `select public.staxis_list_account_authorized_properties($1)`,
      [INACTIVE_ACCOUNT],
    );
    assert.deepEqual(authority.propertyIds, [PROPERTY_MAIN]);
  });

  test('normalized independent ownership keeps the hotel transfer path and demotes the old owner', async () => {
    for (const [accountId, role] of [
      [NORMALIZED_OLD_OWNER, 'owner'],
      [NORMALIZED_NEW_OWNER, 'general_manager'],
    ] as const) {
      const before = await accountState(accountId);
      const initialized = await serviceJson(
        `select public.staxis_set_account_authorization_scope(
           $1,$2,$3::uuid[],$4,$5,$6,'Stage B normalized independent setup'
         )`,
        [ADMIN_ACCOUNT, accountId, [PROPERTY_MAIN], before.authority_version, role, role],
      );
      assert.equal(initialized.ok, true);
      assert.equal((await accountState(accountId)).authority_mode, 'normalized');
      assert.equal(await activeBridgeCount(accountId, PROPERTY_MAIN), 1);
    }

    const roster = await serviceJson(
      `select public.staxis_list_authoritative_hotel_accounts($1,false)`,
      [PROPERTY_MAIN],
    );
    const rosterAccounts = roster.accounts as Array<Record<string, unknown>>;
    assert.equal(
      rosterAccounts.find((entry) => entry.accountId === NORMALIZED_OLD_OWNER)?.managementSurface,
      'legacy_hotel',
    );
    assert.equal(
      rosterAccounts.find((entry) => entry.accountId === NORMALIZED_NEW_OWNER)?.managementSurface,
      'legacy_hotel',
    );

    const oldRow = await pg.query<{
      active: boolean;
      role: string;
      data_user_id: string;
      lifecycle_intent_version: number;
    }>(
      `select active, role, data_user_id, lifecycle_intent_version
         from public.accounts where id = $1`,
      [NORMALIZED_OLD_OWNER],
    );
    const newRow = await pg.query<{
      active: boolean;
      role: string;
      data_user_id: string;
      lifecycle_intent_version: number;
    }>(
      `select active, role, data_user_id, lifecycle_intent_version
         from public.accounts where id = $1`,
      [NORMALIZED_NEW_OWNER],
    );
    const old = oldRow.rows[0]!;
    const next = newRow.rows[0]!;
    assert.equal(old.lifecycle_intent_version, 0);
    assert.equal(next.lifecycle_intent_version, 0);
    assert.equal(old.data_user_id, NORMALIZED_OLD_AUTH);
    assert.equal(next.data_user_id, NORMALIZED_NEW_AUTH);
    const transferred = await serviceJson(
      `select public.staxis_transfer_ownership_guarded(
         $1,$2,$3,'stage-b-normalized-old@example.test',$4,$5,$6,
         $7,$8,$9,$10::uuid[],$11,$12,$13,$14,$15::uuid[],$16,
         'Stage B normalized independent transfer','normalized-independent-transfer'
       )`,
      [
        'c4243000-0000-4000-8000-00000000000b',
        NORMALIZED_OLD_OWNER,
        NORMALIZED_OLD_AUTH,
        PROPERTY_MAIN,
        NORMALIZED_OLD_OWNER,
        NORMALIZED_NEW_OWNER,
        old.active,
        old.role,
        old.data_user_id,
        [PROPERTY_MAIN],
        old.lifecycle_intent_version,
        next.active,
        next.role,
        next.data_user_id,
        [PROPERTY_MAIN],
        next.lifecycle_intent_version,
      ],
    );
    assert.equal(transferred.status, 'ok');
    assert.equal((await accountState(NORMALIZED_OLD_OWNER)).role, 'general_manager');
    assert.equal((await accountState(NORMALIZED_NEW_OWNER)).role, 'owner');
    assert.equal(await activeBridgeCount(NORMALIZED_OLD_OWNER, PROPERTY_MAIN), 1);
    assert.equal(await activeBridgeCount(NORMALIZED_NEW_OWNER, PROPERTY_MAIN), 1);
  });

  test('unresolved legacy rows fail closed at the canonical mutation boundary', async () => {
    const missingIdentity = await accountState(MISSING_IDENTITY_ACCOUNT);
    const missingIdentityResult = await serviceJson(
      `select public.staxis_set_account_authorization_scope(
         $1,$2,$3::uuid[],$4,$5,$6,'Stage B missing identity test'
       )`,
      [
        ADMIN_ACCOUNT,
        MISSING_IDENTITY_ACCOUNT,
        [PROPERTY_MAIN],
        missingIdentity.authority_version,
        missingIdentity.role,
        missingIdentity.role,
      ],
    );
    assert.equal(missingIdentityResult.ok, false);
    assert.equal(missingIdentityResult.reason, 'auth_identity_missing');
    assert.equal(await activeBridgeCount(MISSING_IDENTITY_ACCOUNT, PROPERTY_MAIN), 0);
    assert.deepEqual((await accountState(MISSING_IDENTITY_ACCOUNT)).property_access, [PROPERTY_MAIN]);

    const orphan = await accountState(ORPHAN_ACCOUNT);
    const orphanResult = await serviceJson(
      `select public.staxis_set_account_authorization_scope(
         $1,$2,$3::uuid[],$4,$5,$6,'Stage B orphan test'
       )`,
      [
        ADMIN_ACCOUNT,
        ORPHAN_ACCOUNT,
        [ORPHAN_PROPERTY],
        orphan.authority_version,
        orphan.role,
        orphan.role,
      ],
    );
    assert.equal(orphanResult.ok, false);
    assert.equal(orphanResult.reason, 'property_missing');
    assert.equal(await activeBridgeCount(ORPHAN_ACCOUNT, ORPHAN_PROPERTY), 0);
    assert.deepEqual((await accountState(ORPHAN_ACCOUNT)).property_access, [ORPHAN_PROPERTY]);
  });

  test('normalized company ownership stays off the hotel transfer path', async () => {
    const anchor = await pg.query<{ id: string; organization_id: string }>(
      `select relationship.id, relationship.organization_id
         from public.organization_property_relationships relationship
         join public.organizations organization on organization.id = relationship.organization_id
        where relationship.property_id = $1
          and relationship.is_primary_grouping
          and relationship.ends_at is null
          and organization.organization_type = 'single_hotel'`,
      [PROPERTY_OTHER],
    );
    assert.equal(anchor.rows.length, 1, 'the fixture must have one independent anchor');
    const anchorId = anchor.rows[0]!.id;

    await pg.query(
      `update public.organization_property_relationships
          set is_primary_grouping = false where id = $1`,
      [anchorId],
    );
    await pg.query(
      `insert into public.organizations (id, name, organization_type, status)
       values ($1, 'Stage B Company', 'management_company', 'active')`,
      [COMPANY_ORGANIZATION],
    );
    await pg.query(
      `insert into public.organization_property_relationships
         (organization_id, property_id, relationship_type, is_primary_grouping)
       values ($1, $2, 'operator', true)`,
      [COMPANY_ORGANIZATION, PROPERTY_OTHER],
    );
    await pg.query(
      `update public.accounts set property_access = array[$1]::uuid[]
        where id = any($2::uuid[])`,
      [PROPERTY_OTHER, [COMPANY_OLD_OWNER, COMPANY_NEW_MANAGER]],
    );

    try {
      for (const accountId of [COMPANY_OLD_OWNER, COMPANY_NEW_MANAGER]) {
        const before = await accountState(accountId);
        const result = await serviceJson(
          `select public.staxis_set_account_authorization_scope(
             $1,$2,$3::uuid[],$4,$5,$6,'Stage B company ownership setup'
           )`,
          [ADMIN_ACCOUNT, accountId, [PROPERTY_OTHER], before.authority_version, before.role, before.role],
        );
        assert.equal(result.ok, true, JSON.stringify(result));
        assert.equal((await accountState(accountId)).authority_mode, 'normalized');
        assert.equal(await activeBridgeCount(accountId, PROPERTY_OTHER), 1);
      }

      const roster = await serviceJson(
        `select public.staxis_list_authoritative_hotel_accounts($1,false)`,
        [PROPERTY_OTHER],
      );
      const companyRoster = (roster.accounts as Array<Record<string, unknown>>).filter((entry) => (
        entry.accountId === COMPANY_OLD_OWNER || entry.accountId === COMPANY_NEW_MANAGER
      ));
      assert.equal(companyRoster.length, 2);
      assert.deepEqual(
        companyRoster.map((entry) => entry.managementSurface),
        ['company_access', 'company_access'],
        'a company topology was routed through the independent hotel surface',
      );

      const beforeOld = await accountState(COMPANY_OLD_OWNER);
      const beforeNew = await accountState(COMPANY_NEW_MANAGER);
      const transfer = await serviceJson(
        `select public.staxis_transfer_ownership_guarded(
           $1,$2,$3,'stage-b-company-old@example.test',$4,$5,$6,
           $7::boolean,$8::text,$9::uuid,$10::uuid[],$11::bigint,
           $12::boolean,$13::text,$14::uuid,$15::uuid[],$16::bigint,
           'Stage B company ownership denial','company-ownership-denial'
         )`,
        [
          'c4243000-0000-4000-8000-00000000000d',
          COMPANY_OLD_OWNER,
          COMPANY_OLD_AUTH,
          PROPERTY_OTHER,
          COMPANY_OLD_OWNER,
          COMPANY_NEW_MANAGER,
          beforeOld.active,
          beforeOld.role,
          COMPANY_OLD_AUTH,
          [PROPERTY_OTHER],
          0,
          beforeNew.active,
          beforeNew.role,
          COMPANY_NEW_AUTH,
          [PROPERTY_OTHER],
          0,
        ],
      );
      assert.equal(transfer.status, 'forbidden', JSON.stringify(transfer));
      assert.equal(transfer.reason, 'normalized_authority');
      assert.deepEqual(await accountState(COMPANY_OLD_OWNER), beforeOld);
      assert.deepEqual(await accountState(COMPANY_NEW_MANAGER), beforeNew);
      assert.equal(await activeBridgeCount(COMPANY_OLD_OWNER, PROPERTY_OTHER), 1);
      assert.equal(await activeBridgeCount(COMPANY_NEW_MANAGER, PROPERTY_OTHER), 1);
    } finally {
      await pg.query(
        `delete from public.organization_property_relationships
          where organization_id = $1 and property_id = $2`,
        [COMPANY_ORGANIZATION, PROPERTY_OTHER],
      );
      await pg.query(`delete from public.organizations where id = $1`, [COMPANY_ORGANIZATION]);
      await pg.query(
        `update public.organization_property_relationships
            set is_primary_grouping = true where id = $1`,
        [anchorId],
      );
    }
  });
});
