/**
 * The nudge recipient list is itself tenant data. These tests run migration
 * 0395 against the real two-company authorization spine and prove that the
 * service projection starts from one hotel, honors the winning current hotel
 * standing, and rejects/bounds poisoned subscription configuration.
 */

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { PGlite } from '@electric-sql/pglite';

import { applyMigrationsToPglite } from '../../../tests/fixtures/pglite-migrate';
import {
  ACCOUNT_ADMIN,
  ACCOUNT_ANA,
  ACCOUNT_GIL,
  ACCOUNT_MARIA,
  ACCOUNT_WANDA,
  PID_A1,
  PID_A2,
  PID_B1,
  PID_L1,
  UID_MARIA,
  seedTwoCompanies,
  type TwoCompanySeed,
} from '../../../tests/fixtures/pglite-two-company-seed';

interface RecipientProjection {
  ok: boolean;
  reason?: string;
  propertyId?: string;
  subscriptionMode?: 'default' | 'explicit' | 'disabled';
  recipientAccountIds?: string[];
  candidateCount?: number;
  recipientLimit?: number;
}

let pg: PGlite;
let seed: TwoCompanySeed;

async function projection(propertyId: string): Promise<RecipientProjection> {
  const result = await pg.query<{ value: RecipientProjection }>(
    `select public.staxis_list_property_nudge_recipients($1) as value`,
    [propertyId],
  );
  return result.rows[0].value;
}

async function visibleNudgeCount(authUserId: string): Promise<number> {
  await pg.query(`select set_config('request.jwt.claim.sub',$1,false)`, [authUserId]);
  await pg.query(`select set_config('request.jwt.claim.role','authenticated',false)`);
  await pg.query(
    `select set_config(
       'request.jwt.claims',
       jsonb_build_object(
         'sub',$1::text,
         'role','authenticated',
         'aal','aal2',
         'mfa_verified',true
       )::text,
       false
     )`,
    [authUserId],
  );
  await pg.query(`set role authenticated`);
  try {
    const result = await pg.query<{ count: number }>(
      `select count(*)::integer as count from agent_nudges`,
    );
    return Number(result.rows[0].count);
  } finally {
    await pg.query(`reset role`);
    await pg.query(`select set_config('request.jwt.claim.sub','',false)`);
    await pg.query(`select set_config('request.jwt.claim.role','',false)`);
    await pg.query(`select set_config('request.jwt.claims','',false)`);
  }
}

before(async () => {
  const migrated = await applyMigrationsToPglite();
  assert.ok(
    migrated.report.applied.some((file) => file.startsWith('0395_')),
    'the property-scoped recipient migration must be active',
  );
  pg = migrated.pg;
  seed = await seedTwoCompanies(pg);
  // Supabase projects grant browser table privileges outside migrations;
  // PGlite has no project-level defaults, so add the production-equivalent
  // SELECT grant here to exercise (rather than bypass) the real RLS policy.
  await pg.query(`grant select on public.agent_nudges to authenticated`);
});

after(async () => {
  await pg?.close();
});

describe('property-scoped nudge recipient projection', { concurrency: false }, () => {
  test('returns only current mutable hotel managers for the exact tenant', async () => {
    const a1 = await projection(PID_A1);
    assert.equal(a1.ok, true);
    assert.equal(a1.propertyId, PID_A1);
    assert.equal(a1.subscriptionMode, 'default');
    assert.deepEqual(a1.recipientAccountIds, [ACCOUNT_MARIA]);
    assert.equal(a1.recipientLimit, 64);
    assert.deepEqual(Object.keys(a1).sort(), [
      'candidateCount',
      'ok',
      'propertyId',
      'recipientAccountIds',
      'recipientLimit',
      'subscriptionMode',
    ], 'the service DTO exposes IDs and bounded metadata, never global account rows');
    assert.ok(!a1.recipientAccountIds?.includes(ACCOUNT_GIL), 'company B identity never crosses into A');
    assert.ok(!a1.recipientAccountIds?.includes(ACCOUNT_ANA), 'company-only owner is hotel read-only');
    assert.ok(!a1.recipientAccountIds?.includes(ACCOUNT_ADMIN), 'platform admins do not receive fleet nudges');

    const a2 = await projection(PID_A2);
    assert.deepEqual(a2.recipientAccountIds, [], 'company-only oversight does not become a hotel operator');

    const b1 = await projection(PID_B1);
    assert.deepEqual(b1.recipientAccountIds, [ACCOUNT_GIL]);
    assert.ok(!b1.recipientAccountIds?.includes(ACCOUNT_MARIA));

    const legacy = await projection(PID_L1);
    assert.deepEqual(legacy.recipientAccountIds, [ACCOUNT_WANDA]);
  });

  test('validates explicit subscriptions at write time and again after revocation', async () => {
    await pg.query(
      `update properties
          set nudge_subscription=jsonb_build_object(
            'enabled', true,
            'recipient_account_ids', jsonb_build_array($2::text)
          )
        where id=$1`,
      [PID_A1, ACCOUNT_MARIA],
    );
    const explicit = await projection(PID_A1);
    assert.equal(explicit.subscriptionMode, 'explicit');
    assert.deepEqual(explicit.recipientAccountIds, [ACCOUNT_MARIA]);
    await pg.query(
      `insert into agent_nudges(
         user_id,property_id,category,severity,payload,dedupe_key
       ) values (
         $1,$2,'operational','warning',
         jsonb_build_object('summary','authorization fence probe'),
         '0395-authorization-fence-probe'
       )`,
      [ACCOUNT_MARIA, PID_A1],
    );
    assert.equal(await visibleNudgeCount(UID_MARIA), 1);

    await assert.rejects(
      pg.query(
        `update properties
            set nudge_subscription=jsonb_build_object(
              'enabled', true,
              'recipient_account_ids', jsonb_build_array($2::text)
            )
          where id=$1`,
        [PID_A1, ACCOUNT_GIL],
      ),
      /lacks current hotel-manager standing/i,
      'a company B identity cannot be subscribed to company A data',
    );

    const gmHat = seed.hats.get(`${ACCOUNT_MARIA}:property:general_manager`);
    assert.ok(gmHat);
    const ended = await pg.query<{ value: boolean }>(
      `select public.staxis_end_membership_hat($1,$2) as value`,
      [ACCOUNT_ADMIN, gmHat],
    );
    assert.equal(ended.rows[0].value, true);

    const revoked = await projection(PID_A1);
    assert.equal(revoked.ok, true);
    assert.equal(revoked.subscriptionMode, 'explicit');
    assert.deepEqual(
      revoked.recipientAccountIds,
      [],
      'stored configuration cannot outlive current hotel-manager authority',
    );
    assert.equal(
      await visibleNudgeCount(UID_MARIA),
      0,
      'RLS hides an already-written property nudge immediately after revocation',
    );
  });

  test('fails closed on poisoned legacy configuration and enforces fixed bounds', async () => {
    // Model a pre-0395/raw-superuser value which bypassed the trigger. The
    // read-time projection must still keep company B out of company A.
    await pg.query(`alter table properties disable trigger staxis_validate_nudge_recipients`);
    try {
      await pg.query(
        `update properties
            set nudge_subscription=jsonb_build_object(
              'enabled', true,
              'recipient_account_ids', jsonb_build_array($2::text)
            )
          where id=$1`,
        [PID_A1, ACCOUNT_GIL],
      );
    } finally {
      await pg.query(`alter table properties enable trigger staxis_validate_nudge_recipients`);
    }
    const poisoned = await projection(PID_A1);
    assert.equal(poisoned.ok, true);
    assert.deepEqual(poisoned.recipientAccountIds, []);

    const tooMany = Array.from(
      { length: 65 },
      (_, index) => `90000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    );
    await assert.rejects(
      pg.query(
        `update properties
            set nudge_subscription=jsonb_build_object(
              'enabled', true,
              'recipient_account_ids', $2::jsonb
            )
          where id=$1`,
        [PID_B1, JSON.stringify(tooMany)],
      ),
      /64-recipient limit/i,
    );
  });

  test('exposes only the property-keyed projection to service_role', async () => {
    const grants = await pg.query<{
      service_projection: boolean;
      browser_projection: boolean;
      anonymous_projection: boolean;
      service_helper: boolean;
      browser_self_check: boolean;
      anonymous_self_check: boolean;
    }>(
      `select
         has_function_privilege(
           'service_role',
           'public.staxis_list_property_nudge_recipients(uuid)',
           'EXECUTE'
         ) as service_projection,
         has_function_privilege(
           'authenticated',
           'public.staxis_list_property_nudge_recipients(uuid)',
           'EXECUTE'
         ) as browser_projection,
         has_function_privilege(
           'anon',
           'public.staxis_list_property_nudge_recipients(uuid)',
           'EXECUTE'
         ) as anonymous_projection,
         has_function_privilege(
           'service_role',
           'public._staxis_account_is_current_nudge_recipient(uuid,uuid)',
           'EXECUTE'
         ) as service_helper,
         has_function_privilege(
           'authenticated',
           'public.staxis_current_user_can_receive_property_nudge(uuid,uuid)',
           'EXECUTE'
         ) as browser_self_check,
         has_function_privilege(
           'anon',
           'public.staxis_current_user_can_receive_property_nudge(uuid,uuid)',
           'EXECUTE'
         ) as anonymous_self_check`,
    );
    assert.deepEqual(grants.rows[0], {
      service_projection: true,
      browser_projection: false,
      anonymous_projection: false,
      service_helper: false,
      browser_self_check: true,
      anonymous_self_check: false,
    });

    const functionShape = await pg.query<{
      prosecdef: boolean;
      provolatile: string;
      proconfig: string[] | null;
    }>(
      `select procedure.prosecdef,procedure.provolatile,procedure.proconfig
         from pg_proc procedure
         join pg_namespace namespace on namespace.oid=procedure.pronamespace
        where namespace.nspname='public'
          and procedure.proname='staxis_list_property_nudge_recipients'`,
    );
    assert.equal(functionShape.rows.length, 1);
    assert.equal(functionShape.rows[0].prosecdef, true);
    assert.equal(functionShape.rows[0].provolatile, 's');
    assert.ok(
      functionShape.rows[0].proconfig?.some(
        (setting) => setting.replace(/\s+/g, '') === 'search_path=pg_catalog,public',
      ),
      'security-definer RPC must pin pg_catalog/public search_path',
    );

    const policies = await pg.query<{
      policyname: string;
      qual: string | null;
      with_check: string | null;
    }>(
      `select policyname,qual,with_check
         from pg_policies
        where schemaname='public'
          and tablename='agent_nudges'
          and policyname in (
            'agent_nudges_select_own',
            'agent_nudges_update_own_status'
          )
        order by policyname`,
    );
    assert.equal(policies.rows.length, 2);
    for (const policy of policies.rows) {
      assert.match(
        policy.qual ?? '',
        /staxis_current_user_can_receive_property_nudge/,
        `${policy.policyname} must recheck current hotel standing`,
      );
      assert.match(policy.qual ?? '', /mfa_verified_or_grace/);
      if (policy.policyname === 'agent_nudges_update_own_status') {
        assert.match(policy.with_check ?? '', /staxis_current_user_can_receive_property_nudge/);
      }
    }
  });
});
