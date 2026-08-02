import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { PGlite } from '@electric-sql/pglite';

import { applyMigrationsToPglite } from '../../../tests/fixtures/pglite-migrate';
import {
  ACCOUNT_ADMIN,
  ACCOUNT_HANK,
  ACCOUNT_MARIA,
  ACCOUNT_WANDA,
  PID_B1,
  PID_L1,
  UID_WANDA,
  seedTwoCompanies,
} from '../../../tests/fixtures/pglite-two-company-seed';

const INVITE_AUTH_USER = 'a4200000-0000-4000-8000-000000000003';
const INVITE_CLAIM = 'a4200000-0000-4000-8000-000000000004';
const INVITE_TOKEN_HASH = 'a'.repeat(64);
const MISSING_PROPERTY = 'a4200000-0000-4000-8000-000000000005';

function asObject(value: unknown): Record<string, unknown> {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  assert.ok(parsed && typeof parsed === 'object' && !Array.isArray(parsed));
  return parsed as Record<string, unknown>;
}

function sqlState(action: Promise<unknown>, code: string): Promise<void> {
  return assert.rejects(action, (caught: unknown) => (
    Boolean(caught && typeof caught === 'object'
      && (caught as { code?: string }).code === code)
  ));
}

describe('Stage A authoritative access compatibility — real SQL', () => {
  let pg: PGlite;

  before(async () => {
    const migrated = await applyMigrationsToPglite();
    const expected = [
      '0418_authoritative_access_cutover_preflight.sql',
      '0419_authoritative_access_cutover_backfill.sql',
      '0420_authoritative_access_legacy_write_translation.sql',
      '0421_authoritative_people_access_shadow_rpc.sql',
      '0422_authoritative_invite_acceptance_shadow_rpc.sql',
      '0423_authoritative_access_stage_a_invariants.sql',
    ];
    for (const migration of expected) {
      assert.ok(
        migrated.report.applied.includes(migration),
        `${migration} must apply: ${JSON.stringify(migrated.report.failedAtRuntime)}`,
      );
    }
    pg = migrated.pg;
    await seedTwoCompanies(pg);
  });

  after(async () => {
    await pg?.close();
  });

  test('platform-admin customer-context arrays remain operational without customer bridges', async () => {
    await pg.query(
      `update public.accounts
          set property_access = array[$1]::uuid[]
        where id = $2`,
      [PID_L1, ACCOUNT_ADMIN],
    );

    const raw = await pg.query<{ property_access: string[] }>(
      `select property_access from public.accounts where id = $1`,
      [ACCOUNT_ADMIN],
    );
    assert.deepEqual(raw.rows[0].property_access, [PID_L1]);

    const bridge = await pg.query<{ count: number }>(
      `select count(*)::integer as count
         from public.account_property_authorization_bridges
        where account_id = $1 and property_id = $2`,
      [ACCOUNT_ADMIN, PID_L1],
    );
    assert.equal(Number(bridge.rows[0].count), 0);

    const event = await pg.query<{ reason: string }>(
      `select reason
         from public.account_access_cutover_legacy_write_events
        where account_id = $1
        order by created_at desc
        limit 1`,
      [ACCOUNT_ADMIN],
    );
    assert.equal(
      event.rows[0].reason,
      'platform admin compatibility array write: global authority unchanged',
    );

    await pg.query(
      `update public.accounts set property_access = '{}'::uuid[] where id = $1`,
      [ACCOUNT_ADMIN],
    );
  });

  test('Stage A preserves arrays and projections while translating the unambiguous legacy account', async () => {
    const status = await pg.query<{
      stage: string;
      enforcement_enabled: boolean;
    }>(
      `select stage, enforcement_enabled
         from public.account_access_cutover_status
        where id is true`,
    );
    assert.deepEqual(status.rows[0], { stage: 'A', enforcement_enabled: false });

    const raw = await pg.query<{ property_access: string[] }>(
      `select property_access from public.accounts where id = $1`,
      [ACCOUNT_WANDA],
    );
    assert.deepEqual(raw.rows[0].property_access, [PID_L1]);

    const bridge = await pg.query<{ count: number; relationship_id: string | null }>(
      `select count(*)::integer as count,
              (array_agg(cutover_relationship_id order by cutover_relationship_id))[1]
                as relationship_id
         from public.account_property_authorization_bridges
        where account_id = $1 and property_id = $2 and status = 'active'`,
      [ACCOUNT_WANDA, PID_L1],
    );
    assert.equal(Number(bridge.rows[0].count), 1);
    assert.ok(bridge.rows[0].relationship_id, 'the bridge must bind to current topology');

    const projection = await pg.query<{ value: unknown }>(
      `select public.staxis_list_account_authorized_properties($1) as value`,
      [ACCOUNT_WANDA],
    );
    const projected = asObject(projection.rows[0].value);
    assert.equal(projected.authorityMode, 'legacy');
    assert.deepEqual(projected.propertyIds, [PID_L1]);

    const peopleShadow = await pg.query<{ value: unknown }>(
      `select public.staxis_people_access_shadow($1,$2) as value`,
      [ACCOUNT_WANDA, PID_L1],
    );
    const shadow = asObject(peopleShadow.rows[0].value);
    assert.equal(shadow.legacyAuthorityPreserved, true);
    assert.deepEqual(shadow.legacyPropertyIds, [PID_L1]);
    assert.deepEqual(shadow.activeShadowBridgePropertyIds, [PID_L1]);
  });

  test('ambiguous or inactive legacy writes abort without changing the array or bridge evidence', async () => {
    const before = await pg.query<{ property_access: string[]; events: number }>(
      `select account.property_access,
              (select count(*)::integer
                 from public.account_access_cutover_legacy_write_events event
                where event.account_id = account.id) as events
         from public.accounts account
        where account.id = $1`,
      [ACCOUNT_WANDA],
    );

    await sqlState(
      pg.query(
        `update public.accounts
            set property_access = array[$1,$2]::uuid[]
          where id = $3`,
        [PID_L1, MISSING_PROPERTY, ACCOUNT_WANDA],
      ),
      '42501',
    );
    const afterMissing = await pg.query<{ property_access: string[]; events: number }>(
      `select account.property_access,
              (select count(*)::integer
                 from public.account_access_cutover_legacy_write_events event
                where event.account_id = account.id) as events
         from public.accounts account
        where account.id = $1`,
      [ACCOUNT_WANDA],
    );
    assert.deepEqual(afterMissing.rows[0].property_access, before.rows[0].property_access);
    assert.equal(Number(afterMissing.rows[0].events), Number(before.rows[0].events));

    await sqlState(
      pg.query(
        `update public.accounts
            set property_access = array[$1,$1]::uuid[]
          where id = $2`,
        [PID_L1, ACCOUNT_HANK],
      ),
      '23514',
    );

    await pg.query(
      `update public.accounts set active = false where id = $1`,
      [ACCOUNT_HANK],
    );
    await sqlState(
      pg.query(
        `update public.accounts
            set property_access = array[$1]::uuid[]
          where id = $2`,
        [PID_L1, ACCOUNT_HANK],
      ),
      '42501',
    );
    const inactive = await pg.query<{ property_access: string[] }>(
      `select property_access from public.accounts where id = $1`,
      [ACCOUNT_HANK],
    );
    assert.deepEqual(inactive.rows[0].property_access, [PID_L1]);
    await pg.query(
      `update public.accounts set active = true where id = $1`,
      [ACCOUNT_HANK],
    );
  });

  test('normalized accounts keep legacy compatibility writes non-authoritative', async () => {
    const before = await pg.query<{ value: unknown }>(
      `select public.staxis_list_account_authorized_properties($1) as value`,
      [ACCOUNT_MARIA],
    );
    const beforeProjection = asObject(before.rows[0].value);

    await pg.query(
      `update public.accounts set property_access = array[$1]::uuid[] where id = $2`,
      [PID_B1, ACCOUNT_MARIA],
    );

    const raw = await pg.query<{ property_access: string[] }>(
      `select property_access from public.accounts where id = $1`,
      [ACCOUNT_MARIA],
    );
    assert.deepEqual(raw.rows[0].property_access, [PID_B1]);
    const after = await pg.query<{ value: unknown }>(
      `select public.staxis_list_account_authorized_properties($1) as value`,
      [ACCOUNT_MARIA],
    );
    const afterProjection = asObject(after.rows[0].value);
    assert.equal(afterProjection.authorityMode, 'normalized');
    assert.deepEqual(afterProjection.propertyIds, beforeProjection.propertyIds);
    assert.equal(
      (afterProjection.propertyIds as string[]).includes(PID_B1),
      false,
      'a normalized account array write must not widen canonical access',
    );
    await pg.query(
      `update public.accounts set property_access = '{}'::uuid[] where id = $1`,
      [ACCOUNT_MARIA],
    );
  });

  test('pending invite claims are not access, while authorized acceptance establishes one legacy bridge', async () => {
    await pg.query(
      `insert into auth.users(id, email) values ($1, 'stage-a-invitee@example.test')`,
      [INVITE_AUTH_USER],
    );
    const created = await pg.query<{ value: unknown }>(
      `select public.staxis_create_account_invite_guarded(
         $1::uuid,$2::uuid,$3::uuid,'stage-a-invitee@example.test','front_desk',$4,
         clock_timestamp()+interval '7 days',null::uuid,null::text,null::uuid[],$5
       ) as value`,
      [
        ACCOUNT_WANDA,
        UID_WANDA,
        PID_L1,
        INVITE_TOKEN_HASH,
        'stage-a-invite-create',
      ],
    );
    const createdValue = asObject(created.rows[0].value);
    assert.equal(createdValue.ok, true, JSON.stringify(createdValue));
    const inviteId = String(createdValue.inviteId);

    const pending = await pg.query<{ value: unknown }>(
      `select public.staxis_invite_access_shadow($1::uuid) as value`,
      [inviteId],
    );
    const pendingValue = asObject(pending.rows[0].value);
    assert.equal(pendingValue.accepted, false);
    assert.equal(pendingValue.accessEstablished, false);
    assert.equal(pendingValue.claimIsAccess, false);

    const claimed = await pg.query<{ value: unknown }>(
      `select public.staxis_claim_account_invite_acceptance($1,$2) as value`,
      [INVITE_TOKEN_HASH, INVITE_CLAIM],
    );
    assert.equal(asObject(claimed.rows[0].value).ok, true);

    const accepted = await pg.query<{ value: unknown }>(
      `select public.staxis_accept_account_invite(
         $1,$2,$3,'stage-a-invitee','Stage A Invitee'
       ) as value`,
      [INVITE_TOKEN_HASH, INVITE_CLAIM, INVITE_AUTH_USER],
    );
    const acceptedValue = asObject(accepted.rows[0].value);
    assert.equal(acceptedValue.ok, true, JSON.stringify(acceptedValue));
    const acceptedAccountId = String(acceptedValue.accountId);

    const acceptedShadow = await pg.query<{ value: unknown }>(
      `select public.staxis_invite_access_shadow($1::uuid) as value`,
      [inviteId],
    );
    const acceptedShadowValue = asObject(acceptedShadow.rows[0].value);
    assert.equal(acceptedShadowValue.accepted, true);
    assert.equal(acceptedShadowValue.accessEstablished, true);
    assert.equal(acceptedShadowValue.accountId, acceptedAccountId);
    assert.equal(acceptedShadowValue.authorityMode, 'legacy');

    const acceptedBridge = await pg.query<{ count: number }>(
      `select count(*)::integer as count
         from public.account_property_authorization_bridges
        where account_id = $1 and property_id = $2 and status = 'active'`,
      [acceptedAccountId, PID_L1],
    );
    assert.equal(Number(acceptedBridge.rows[0].count), 1);
  });

  test('preflight and Stage A invariants report cleanly without tearing down compatibility', async () => {
    const preflight = await pg.query<{ value: unknown }>(
      `select public.staxis_preflight_authorization_cutover() as value`,
    );
    const preflightValue = asObject(preflight.rows[0].value);
    assert.equal(preflightValue.ok, true, JSON.stringify(preflightValue));
    assert.equal(preflightValue.stage, 'A');

    const invariant = await pg.query<{ value: unknown }>(
      `select public.staxis_assert_stage_a_access_invariants() as value`,
    );
    const invariantValue = asObject(invariant.rows[0].value);
    assert.equal(invariantValue.ok, true, JSON.stringify(invariantValue));
    assert.equal(invariantValue.stage, 'A');
    assert.equal(invariantValue.legacyArraysPreserved, true);
    assert.equal(invariantValue.issueCount, 0);

    const compatibility = await pg.query<{ property_access: string[]; enforcement_enabled: boolean }>(
      `select account.property_access, status.enforcement_enabled
         from public.accounts account
         cross join public.account_access_cutover_status status
        where account.id = $1 and status.id is true`,
      [ACCOUNT_WANDA],
    );
    assert.deepEqual(compatibility.rows[0], {
      property_access: [PID_L1],
      enforcement_enabled: false,
    });
  });

  test('a retired bridge cannot be resurrected by retrying the same legacy write', async () => {
    const beforeRetry = await pg.query<{ events: number }>(
      `select count(*)::integer as events
         from public.account_access_cutover_legacy_write_events
        where account_id = $1`,
      [ACCOUNT_WANDA],
    );

    // The real relationship-retirement trigger records the topology change
    // and retires the bridge before the legacy writer can run again.
    await pg.query(
      `update public.organization_property_relationships
          set ends_at = clock_timestamp()
        where property_id = $1
          and is_primary_grouping is true
          and ends_at is null`,
      [PID_L1],
    );

    const retired = await pg.query<{
      status: string;
      retired_at: string | null;
      retirement_reason: string | null;
    }>(
      `select status, retired_at, retirement_reason
         from public.account_property_authorization_bridges
        where account_id = $1 and property_id = $2
        order by created_at desc
        limit 1`,
      [ACCOUNT_WANDA, PID_L1],
    );
    assert.equal(retired.rows[0]?.status, 'retired');
    assert.ok(retired.rows[0]?.retired_at);
    assert.ok(retired.rows[0]?.retirement_reason);

    await assert.rejects(
      pg.query(
        `update public.accounts
            set property_access = array[$1]::uuid[]
          where id = $2`,
        [PID_L1, ACCOUNT_WANDA],
      ),
      (caught: unknown) => (
        Boolean(caught && typeof caught === 'object'
          && (caught as { code?: string }).code === '42501'
          && String((caught as { detail?: string }).detail ?? '').includes('retirementReason'))
      ),
    );

    const afterRetry = await pg.query<{
      property_access: string[];
      active_bridges: number;
      events: number;
    }>(
      `select account.property_access,
              (select count(*)::integer
                 from public.account_property_authorization_bridges bridge
                where bridge.account_id = account.id
                  and bridge.property_id = $2
                  and bridge.status = 'active') as active_bridges,
              (select count(*)::integer
                 from public.account_access_cutover_legacy_write_events event
                where event.account_id = account.id) as events
         from public.accounts account
        where account.id = $1`,
      [ACCOUNT_WANDA, PID_L1],
    );
    assert.deepEqual(afterRetry.rows[0]?.property_access, [PID_L1]);
    assert.equal(Number(afterRetry.rows[0]?.active_bridges), 0);
    assert.equal(Number(afterRetry.rows[0]?.events), Number(beforeRetry.rows[0]?.events));
  });
});
