import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { PGlite } from '@electric-sql/pglite';

import { applyMigrationsToPglite } from '../../../tests/fixtures/pglite-migrate';
import {
  ACCOUNT_ADMIN,
  ACCOUNT_ANA,
  ACCOUNT_BO,
  ACCOUNT_FIONA,
  ACCOUNT_GIL,
  ACCOUNT_MARIA,
  ORG_A,
  ORG_B,
  PID_A1,
  PID_A2,
  PID_B1,
  UID_ANA,
  UID_FIONA,
  UID_GIL,
  UID_MARIA,
  seedTwoCompanies,
} from '../../../tests/fixtures/pglite-two-company-seed';

const LEGACY_TARGET = 'f1000000-0000-4000-8000-000000000001';
const LEGACY_TARGET_USER = 'f1000000-0000-4000-8000-000000000002';
const NORMALIZED_TARGET = 'f2000000-0000-4000-8000-000000000001';
const NORMALIZED_TARGET_USER = 'f2000000-0000-4000-8000-000000000002';
const NORMALIZED_MEMBERSHIP = 'f2000000-0000-4000-8000-000000000003';
const TRANSFER_TARGET = 'f3000000-0000-4000-8000-000000000001';
const TRANSFER_TARGET_USER = 'f3000000-0000-4000-8000-000000000002';
const TRANSFER_MEMBERSHIP = 'f3000000-0000-4000-8000-000000000003';
const VP_REVOCATION_TARGET = 'f3000000-0000-4000-8000-000000000004';
const VP_REVOCATION_TARGET_USER = 'f3000000-0000-4000-8000-000000000005';
const VP_REVOCATION_MEMBERSHIP = 'f3000000-0000-4000-8000-000000000006';
const LOCAL_TARGET = 'f3000000-0000-4000-8000-000000000007';
const LOCAL_TARGET_USER = 'f3000000-0000-4000-8000-000000000008';
const DEACTIVATE = 'f4000000-0000-4000-8000-000000000001';
const REACTIVATE = 'f4000000-0000-4000-8000-000000000002';
const REVOKED = 'f4000000-0000-4000-8000-000000000003';
const TRANSFERRED = 'f4000000-0000-4000-8000-000000000004';
const VP_REVOKED = 'f4000000-0000-4000-8000-000000000005';
const PROCESSOR = 'f5000000-0000-4000-8000-000000000001';
const PROCESSOR_2 = 'f5000000-0000-4000-8000-000000000002';

interface JsonRow { value: Record<string, unknown> }

async function asService<T>(
  pg: PGlite,
  sql: string,
  params: unknown[] = [],
): Promise<T> {
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

async function addNormalizedTarget(
  pg: PGlite,
  accountId: string,
  userId: string,
  membershipId: string,
  propertyId = PID_A1,
): Promise<string> {
  await pg.query(`insert into auth.users(id,email) values ($1,$2)`, [userId, `${accountId}@example.test`]);
  await pg.query(
    `insert into accounts(
       id,username,display_name,role,property_access,data_user_id
     ) values ($1,$2,$2,'front_desk','{}'::uuid[],$3)`,
    [accountId, `person-${accountId}`, userId],
  );
  await pg.query(
    `insert into organization_memberships(
       id,organization_id,account_id,job_category,status
     ) values ($1,$2,$3,'operations','active')`,
    [membershipId, ORG_A, accountId],
  );
  const grant = await pg.query<{ id: string }>(
    `insert into organization_access_grants(
       organization_id,membership_id,access_profile,scope_type,
       property_relationship_id,property_id,source
     )
     select $1,$2,'viewer','property',relationship.id,$3,'manual'
     from organization_property_relationships relationship
     where relationship.organization_id=$1 and relationship.property_id=$3
       and relationship.is_primary_grouping is true
       and relationship.ends_at is null
     returning id`,
    [ORG_A, membershipId, propertyId],
  );
  return grant.rows[0].id;
}

async function register(
  pg: PGlite,
  operationId: string,
  targetId: string,
  targetUserId: string,
  desiredActive: boolean,
  expectedActive: boolean,
  expectedVersion: number,
  actorId = ACCOUNT_ANA,
  actorUserId = UID_ANA,
  hotelId = PID_A1,
): Promise<Record<string, unknown>> {
  const result = await pg.query<JsonRow>(
    `select public.staxis_register_account_lifecycle_intent(
       $1,$2,$3,'manager@example.test',$4,$5,$6,$7,'front_desk',$8,
       '{}'::uuid[],$9
     ) as value`,
    [
      operationId, actorId, actorUserId, hotelId, targetId, desiredActive,
      expectedActive, targetUserId, expectedVersion,
    ],
  );
  return result.rows[0].value;
}

async function claimSnapshotCommit(
  pg: PGlite,
  operationId: string,
  processorId: string,
  bannedUntil: string | null,
): Promise<Record<string, unknown>> {
  const claim = await pg.query<JsonRow>(
    `select public.staxis_claim_account_lifecycle_intent($1,$2,120) as value`,
    [operationId, processorId],
  );
  assert.equal(claim.rows[0].value.status, 'claimed');
  const snapshot = await pg.query<JsonRow>(
    `select public.staxis_record_account_lifecycle_auth_snapshot($1,$2,$3) as value`,
    [operationId, bannedUntil, processorId],
  );
  assert.equal(snapshot.rows[0].value.status, 'pending');
  const committed = await pg.query<JsonRow>(
    `select public.staxis_commit_account_lifecycle_intent($1,'test-request',$2) as value`,
    [operationId, processorId],
  );
  return committed.rows[0].value;
}

describe('authoritative People lifecycle and acquired-hotel mutations — real SQL', () => {
  let pg: PGlite;
  let normalizedGrant: string;
  let mariaVpMembership: string;

  before(async () => {
    const migrated = await applyMigrationsToPglite();
    pg = migrated.pg;
    const seeded = await seedTwoCompanies(pg);
    mariaVpMembership = seeded.hats.get(`${ACCOUNT_MARIA}:company:vp`)!;
    await pg.query(`insert into auth.users(id,email) values ($1,'legacy-target@example.test')`, [LEGACY_TARGET_USER]);
    await pg.query(
      `insert into accounts(
         id,username,display_name,role,property_access,data_user_id
       ) values ($1,'legacy-target','Legacy Target','front_desk',
         array[$2,$3]::uuid[],$4)`,
      [LEGACY_TARGET, PID_A1, PID_A2, LEGACY_TARGET_USER],
    );
    await pg.query(
      `insert into auth.users(id,email) values ($1,'local-target@example.test')`,
      [LOCAL_TARGET_USER],
    );
    await pg.query(
      `insert into accounts(
         id,username,display_name,role,property_access,data_user_id
       ) values ($1,'local-target','Local Target','front_desk',
         array[$2]::uuid[],$3)`,
      [LOCAL_TARGET, PID_B1, LOCAL_TARGET_USER],
    );
    normalizedGrant = await addNormalizedTarget(
      pg, NORMALIZED_TARGET, NORMALIZED_TARGET_USER, NORMALIZED_MEMBERSHIP,
    );
    await addNormalizedTarget(
      pg,
      VP_REVOCATION_TARGET,
      VP_REVOCATION_TARGET_USER,
      VP_REVOCATION_MEMBERSHIP,
      PID_A2,
    );
  });

  after(async () => {
    await pg?.close();
  });

  test('company owner/VP manage People and Access while finance and another company fail closed', async () => {
    const target = await pg.query<{
      updated_at: string;
      lifecycle_intent_version: number;
    }>(
      `select updated_at::text as updated_at,lifecycle_intent_version
       from accounts where id=$1`,
      [LEGACY_TARGET],
    );
    const financeDenied = await pg.query<JsonRow>(
      `select public.staxis_change_hotel_team_role_guarded(
         $1,$2,'fiona@example.test',$3,$4,'maintenance',null,true,
         'front_desk',$5,array[$3,$6]::uuid[],'Legacy Target',
         $7::timestamptz,$8,'finance-denied'
       ) as value`,
      [
        ACCOUNT_FIONA, UID_FIONA, PID_A1, LEGACY_TARGET,
        LEGACY_TARGET_USER, PID_A2, target.rows[0].updated_at,
        target.rows[0].lifecycle_intent_version,
      ],
    );
    assert.deepEqual(financeDenied.rows[0].value, {
      status: 'forbidden', reason: 'manage_users',
    });

    const denied = await pg.query<JsonRow>(
      `select public.staxis_change_hotel_team_role_guarded(
         $1,(select data_user_id from accounts where id=$1),null,$2,$3,
         'maintenance',null,true,'front_desk',$4,array[$2,$5]::uuid[],
         'Legacy Target',$6::timestamptz,$7,'cross-company'
       ) as value`,
      [
        ACCOUNT_BO, PID_A1, LEGACY_TARGET, LEGACY_TARGET_USER, PID_A2,
        target.rows[0].updated_at, target.rows[0].lifecycle_intent_version,
      ],
    );
    assert.deepEqual(denied.rows[0].value, {
      status: 'forbidden', reason: 'manage_users',
    });

    const changedByVp = await pg.query<JsonRow>(
      `select public.staxis_change_hotel_team_role_guarded(
         $1,$2,'maria@example.test',$3,$4,'general_manager',null,true,
         'front_desk',$5,array[$3,$6]::uuid[],'Legacy Target',
         $7::timestamptz,$8,'vp-company-role-change'
       ) as value`,
      [
        ACCOUNT_MARIA, UID_MARIA, PID_A1, LEGACY_TARGET, LEGACY_TARGET_USER,
        PID_A2, target.rows[0].updated_at, target.rows[0].lifecycle_intent_version,
      ],
    );
    assert.equal(changedByVp.rows[0].value.status, 'ok');

    const refreshed = await pg.query<{ updated_at: string }>(
      `select updated_at::text as updated_at from accounts where id=$1`,
      [LEGACY_TARGET],
    );
    const detached = await pg.query<JsonRow>(
      `select public.staxis_remove_property_access_guarded_v2(
         $1,$2,'ana@example.test',$3,$4,'general_manager',$5::timestamptz,
         'company-detach'
       ) as value`,
      [
        ACCOUNT_ANA, UID_ANA, LEGACY_TARGET, PID_A1,
        refreshed.rows[0].updated_at,
      ],
    );
    assert.equal(detached.rows[0].value.status, 'ok');
    assert.equal(detached.rows[0].value.audit_written, true);
    assert.equal(detached.rows[0].value.remaining_hotels, 1);
    const state = await pg.query<{ role: string; property_access: string[] }>(
      `select role,property_access from accounts where id=$1`, [LEGACY_TARGET],
    );
    assert.deepEqual(state.rows[0], {
      role: 'general_manager', property_access: [PID_A2],
    });
    const audit = await pg.query<{ count: number }>(
      `select count(*)::integer as count from admin_audit_log
       where target_id=$1 and action='account.team_detach'
         and metadata->>'request_id'='company-detach'`,
      [LEGACY_TARGET],
    );
    assert.equal(Number(audit.rows[0].count), 1);
    await assert.rejects(
      asService(
        pg,
        `select public.staxis_remove_property_access_guarded(
           $1,$2,'general_manager',clock_timestamp()
         )`,
        [LEGACY_TARGET, PID_A2],
      ),
      /permission denied/i,
    );
  });

  test('an explicit property GM manages only their own hotel', async () => {
    const outside = await pg.query<{ updated_at: string }>(
      `select updated_at::text as updated_at from accounts where id=$1`,
      [LEGACY_TARGET],
    );
    const denied = await pg.query<JsonRow>(
      `select public.staxis_remove_property_access_guarded_v2(
         $1,$2,'gil@example.test',$3,$4,'general_manager',$5::timestamptz,
         'gm-direct-id-tamper'
       ) as value`,
      [ACCOUNT_GIL, UID_GIL, LEGACY_TARGET, PID_A2, outside.rows[0].updated_at],
    );
    assert.deepEqual(denied.rows[0].value, {
      status: 'forbidden', reason: 'manage_users',
    });

    const local = await pg.query<{ updated_at: string }>(
      `select updated_at::text as updated_at from accounts where id=$1`,
      [LOCAL_TARGET],
    );
    const detached = await pg.query<JsonRow>(
      `select public.staxis_remove_property_access_guarded_v2(
         $1,$2,'gil@example.test',$3,$4,'front_desk',$5::timestamptz,
         'gm-own-hotel'
       ) as value`,
      [ACCOUNT_GIL, UID_GIL, LOCAL_TARGET, PID_B1, local.rows[0].updated_at],
    );
    assert.equal(detached.rows[0].value.status, 'ok');
    assert.equal(detached.rows[0].value.remaining_hotels, 0);
  });

  test('VP revocation after registration takes effect at commit', async () => {
    const registered = await register(
      pg,
      VP_REVOKED,
      VP_REVOCATION_TARGET,
      VP_REVOCATION_TARGET_USER,
      false,
      true,
      0,
      ACCOUNT_MARIA,
      UID_MARIA,
      PID_A2,
    );
    assert.equal(registered.status, 'pending');
    await pg.query(
      `select public.staxis_end_membership_hat($1,$2)`,
      [ACCOUNT_ADMIN, mariaVpMembership],
    );
    const result = await claimSnapshotCommit(
      pg, VP_REVOKED, PROCESSOR, 'infinity',
    );
    assert.equal(result.status, 'invariant_conflict');
    assert.match(String(result.reason), /authorization|scope/);
    const target = await pg.query<{ active: boolean }>(
      `select active from accounts where id=$1`, [VP_REVOCATION_TARGET],
    );
    assert.equal(target.rows[0].active, true);
  });

  test('normalized manager can deactivate and reactivate a normalized target with exact inactive roster scope', async () => {
    const registered = await register(
      pg, DEACTIVATE, NORMALIZED_TARGET, NORMALIZED_TARGET_USER, false, true, 0,
    );
    assert.equal(registered.status, 'pending');
    const committed = await claimSnapshotCommit(pg, DEACTIVATE, PROCESSOR, 'infinity');
    assert.equal(committed.status, 'committed');
    assert.equal(committed.active, false);

    const roster = await pg.query<JsonRow>(
      `select public.staxis_list_authoritative_hotel_accounts($1,false) as value`,
      [PID_A1],
    );
    const inactive = (roster.rows[0].value.accounts as Array<Record<string, unknown>>)
      .find((account) => account.accountId === NORMALIZED_TARGET);
    assert.equal(inactive?.active, false);
    assert.equal(inactive?.managementSurface, 'company_access');
    assert.deepEqual(inactive?.propertyIds, [PID_A1]);

    const reactivated = await register(
      pg, REACTIVATE, NORMALIZED_TARGET, NORMALIZED_TARGET_USER, true, false, 1,
    );
    assert.equal(reactivated.status, 'pending');
    const recommitted = await claimSnapshotCommit(pg, REACTIVATE, PROCESSOR_2, null);
    assert.equal(recommitted.status, 'committed');
    assert.equal(recommitted.active, true);
    const audits = await pg.query<{ action: string; hotels: string[] }>(
      `select action, array(
         select jsonb_array_elements_text(metadata->'affected_hotel_ids')
       ) as hotels
       from admin_audit_log
       where target_id=$1 and action in ('account.deactivate','account.reactivate')
       order by action`,
      [NORMALIZED_TARGET],
    );
    assert.deepEqual(audits.rows, [
      { action: 'account.deactivate', hotels: [PID_A1] },
      { action: 'account.reactivate', hotels: [PID_A1] },
    ]);
  });

  test('grant revocation after registration is rejected at commit instead of deactivating a stale target', async () => {
    const registered = await register(
      pg, REVOKED, NORMALIZED_TARGET, NORMALIZED_TARGET_USER, false, true, 2,
    );
    assert.equal(registered.status, 'pending');
    await pg.query(
      `update organization_access_grants
          set status='revoked', revoked_at=clock_timestamp(),
              revocation_reason='revoked during lifecycle'
        where id=$1`,
      [normalizedGrant],
    );
    const result = await claimSnapshotCommit(pg, REVOKED, PROCESSOR, 'infinity');
    assert.equal(result.status, 'invariant_conflict');
    assert.match(String(result.reason), /authorization|scope/);
    const target = await pg.query<{ active: boolean }>(
      `select active from accounts where id=$1`, [NORMALIZED_TARGET],
    );
    assert.equal(target.rows[0].active, true);
  });

  test('hotel transfer after registration invalidates both target scope and former-company authority', async () => {
    await addNormalizedTarget(
      pg, TRANSFER_TARGET, TRANSFER_TARGET_USER, TRANSFER_MEMBERSHIP,
    );
    const registered = await register(
      pg, TRANSFERRED, TRANSFER_TARGET, TRANSFER_TARGET_USER, false, true, 0,
    );
    assert.equal(registered.status, 'pending');
    await pg.query(
      `select public.staxis_set_primary_property_organization($1,$2,$3,'operator')`,
      [ACCOUNT_ADMIN, PID_A1, ORG_B],
    );
    const result = await claimSnapshotCommit(pg, TRANSFERRED, PROCESSOR, 'infinity');
    assert.equal(result.status, 'invariant_conflict');
    const deniedRetry = await register(
      pg, TRANSFERRED, TRANSFER_TARGET, TRANSFER_TARGET_USER, false, true, 1,
    );
    assert.notEqual(deniedRetry.status, 'pending');
  });
});
