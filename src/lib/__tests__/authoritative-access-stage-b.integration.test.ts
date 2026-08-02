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
  authority_mode: string;
  authority_version: number;
  role: string;
  updated_at: string;
  property_access: string[];
}> {
  const result = await pg.query<{
    authority_mode: string;
    authority_version: number;
    role: string;
    updated_at: string;
    property_access: string[];
  }>(
    `select state.authority_mode, state.authority_version,
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
              ($4, 'stage-b-orphan@example.test')`,
      [ADMIN_AUTH, CANONICAL_AUTH, DETACH_AUTH, ORPHAN_AUTH],
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
         ($6, 'stage-b-detach', 'x', 'Stage B Detach', 'housekeeping', array[$5]::uuid[], $7)`,
      [
        ADMIN_ACCOUNT, ADMIN_AUTH,
        CANONICAL_ACCOUNT, CANONICAL_AUTH,
        PROPERTY_MAIN,
        DETACH_ACCOUNT, DETACH_AUTH,
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
});
