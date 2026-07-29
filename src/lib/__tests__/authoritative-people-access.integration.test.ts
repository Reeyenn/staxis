import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { PGlite } from '@electric-sql/pglite';

import { applyMigrationsToPglite } from '../../../tests/fixtures/pglite-migrate';
import {
  ACCOUNT_ADMIN,
  ACCOUNT_ANA,
  ACCOUNT_BO,
  ACCOUNT_FIONA,
  ACCOUNT_MARIA,
  ORG_A,
  ORG_B,
  PID_A1,
  PID_A2,
  PID_B1,
  UID_ADMIN,
  seedTwoCompanies,
  type TwoCompanySeed,
} from '../../../tests/fixtures/pglite-two-company-seed';

const FUTURE_ACCOUNT = 'e1000000-0000-4000-8000-000000000001';
const FUTURE_USER = 'e1000000-0000-4000-8000-000000000002';
const FUTURE_MEMBERSHIP = 'e1000000-0000-4000-8000-000000000003';
const CONVERSION_KEY = 'e2000000-0000-4000-8000-000000000001';

interface JsonRow { value: Record<string, unknown> }

function sqlState(action: Promise<unknown>, code: string): Promise<void> {
  return assert.rejects(action, (caught: unknown) => (
    Boolean(caught && typeof caught === 'object'
      && (caught as { code?: string }).code === code)
  ));
}

async function accountReach(pg: PGlite, accountId: string): Promise<string[]> {
  const result = await pg.query<JsonRow>(
    `select public.staxis_list_account_authorized_properties($1) as value`,
    [accountId],
  );
  return result.rows[0].value.propertyIds as string[];
}

describe('authoritative People and Access bridge — real SQL', () => {
  let pg: PGlite;
  let seed: TwoCompanySeed;

  before(async () => {
    const migrated = await applyMigrationsToPglite();
    pg = migrated.pg;
    seed = await seedTwoCompanies(pg);
  });

  after(async () => {
    await pg?.close();
  });

  test('Access projects finance/VP/GM hats and atomically converts one hat to grants', async () => {
    const financeHat = seed.hats.get(`${ACCOUNT_FIONA}:company:finance`);
    assert.ok(financeHat);
    const projection = await pg.query<JsonRow>(
      `select public.staxis_company_access_editor_projection_v2($1) as value`,
      [ACCOUNT_ANA],
    );
    const organization = (projection.rows[0].value.organizations as Array<{
      id: string;
      accessEpoch: number;
      memberships: Array<Record<string, unknown>>;
    }>).find((entry) => entry.id === ORG_A);
    assert.ok(organization);
    const finance = organization.memberships.find((entry) => entry.id === financeHat);
    assert.equal(finance?.sourceKind, 'membership_hat');
    assert.equal(finance?.sourceRole, 'finance');
    assert.equal(finance?.sourceScope, 'company');
    assert.equal(finance?.canReplace, true);
    assert.equal(finance?.canAdd, false);

    const preview = await pg.query<JsonRow>(
      `select public.staxis_preview_company_access_edit_v2(
         $1,$2,$3,'replace','viewer','organization',null,'{}'::uuid[],null,$4,$5
       ) as value`,
      [
        ACCOUNT_ANA,
        ORG_A,
        financeHat,
        organization.accessEpoch,
        finance?.accessRevision,
      ],
    );
    assert.deepEqual(preview.rows[0].value.beforePropertyIds, [PID_A1, PID_A2]);
    assert.deepEqual(preview.rows[0].value.afterPropertyIds, [PID_A1, PID_A2]);
    assert.equal(preview.rows[0].value.conversionFromHat, true);

    const committed = await pg.query<JsonRow>(
      `select public.staxis_commit_company_access_edit_v2(
         $1,$2,$3,'replace','viewer','organization',null,'{}'::uuid[],null,
         $4,$5,$6,true,$7
       ) as value`,
      [
        ACCOUNT_ANA,
        ORG_A,
        financeHat,
        organization.accessEpoch,
        finance?.accessRevision,
        preview.rows[0].value.previewFingerprint,
        CONVERSION_KEY,
      ],
    );
    assert.equal(committed.rows[0].value.conversionFromHat, true);
    assert.equal(committed.rows[0].value.idempotentReplay, false);
    assert.deepEqual(await accountReach(pg, ACCOUNT_FIONA), [PID_A1, PID_A2]);
    const authorizationState = await pg.query<{ normalized_scope_hash: string }>(
      `select normalized_scope_hash from account_authorization_state where account_id=$1`,
      [ACCOUNT_FIONA],
    );
    assert.notEqual(
      authorizationState.rows[0].normalized_scope_hash,
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      'the same transaction must hash the immediately-effective replacement grant',
    );

    const source = await pg.query<{
      membership_scope: string | null;
      staxis_role: string | null;
      status: string;
    }>(
      `select membership_scope,staxis_role,status
       from organization_memberships where id=$1`,
      [financeHat],
    );
    assert.deepEqual(source.rows[0], {
      membership_scope: null,
      staxis_role: null,
      status: 'active',
    });
    const grant = await pg.query<{ id: string }>(
      `select id from organization_access_grants
       where membership_id=$1 and status='active' and source='manual'`,
      [financeHat],
    );
    assert.equal(grant.rows.length, 1);

    const replay = await pg.query<JsonRow>(
      `select public.staxis_commit_company_access_edit_v2(
         $1,$2,$3,'replace','viewer','organization',null,'{}'::uuid[],null,
         $4,$5,$6,true,$7
       ) as value`,
      [
        ACCOUNT_ANA,
        ORG_A,
        financeHat,
        organization.accessEpoch,
        finance?.accessRevision,
        preview.rows[0].value.previewFingerprint,
        CONVERSION_KEY,
      ],
    );
    assert.equal(replay.rows[0].value.idempotentReplay, true);

    await pg.query(
      `update organization_access_grants
          set status='revoked', revoked_at=clock_timestamp(),
              revoked_by_account_id=$1, revocation_reason='test revocation'
        where id=$2`,
      [ACCOUNT_ANA, grant.rows[0].id],
    );
    assert.deepEqual(await accountReach(pg, ACCOUNT_FIONA), []);
    const audit = await pg.query<{ count: number }>(
      `select count(*)::integer as count from organization_access_events
       where request_id=$1
         and event_type='company_access.membership_hat_conversion_commit'`,
      [CONVERSION_KEY],
    );
    assert.equal(Number(audit.rows[0].count), 1);
  });

  test('the final company-owner hat cannot be removed by an older RPC or direct write', async () => {
    const ownerHat = seed.hats.get(`${ACCOUNT_ANA}:company:owner`);
    assert.ok(ownerHat);
    await sqlState(
      pg.query(`select public.staxis_end_membership_hat($1,$2)`, [ACCOUNT_ADMIN, ownerHat]),
      '23514',
    );
    await sqlState(
      pg.query(
        `update organization_memberships
            set status='revoked', ended_at=clock_timestamp()
          where id=$1`,
        [ownerHat],
      ),
      '23514',
    );
    assert.deepEqual(await accountReach(pg, ACCOUNT_ANA), [PID_A1, PID_A2]);
  });

  test('future grants retire legacy bridges at cutover and cannot resurrect after revoke', async () => {
    await pg.query(`insert into auth.users(id,email) values ($1,'future@example.test')`, [FUTURE_USER]);
    await pg.query(
      `insert into accounts(
         id,username,display_name,role,property_access,data_user_id
       ) values ($1,'future','Future Person','front_desk',array[$2]::uuid[],$3)`,
      [FUTURE_ACCOUNT, PID_A1, FUTURE_USER],
    );
    await pg.query(
      `insert into organization_memberships(
         id,organization_id,account_id,job_category,status
       ) values ($1,$2,$3,'operations','active')`,
      [FUTURE_MEMBERSHIP, ORG_A, FUTURE_ACCOUNT],
    );
    const grant = await pg.query<{ id: string }>(
      `insert into organization_access_grants(
         organization_id,membership_id,access_profile,scope_type,
         property_relationship_id,property_id,starts_at,source
       )
       select $1,$2,'viewer','property',relationship.id,$3,
              clock_timestamp()+interval '1 day','manual'
       from organization_property_relationships relationship
       where relationship.organization_id=$1 and relationship.property_id=$3
         and relationship.is_primary_grouping is true
         and relationship.ends_at is null
       returning id`,
      [ORG_A, FUTURE_MEMBERSHIP, PID_A1],
    );
    const cutover = await pg.query<{ authority_mode: string; bridges: number }>(
      `select state.authority_mode,
          (select count(*)::integer
           from account_property_authorization_bridges bridge
           where bridge.account_id=state.account_id and bridge.status='active') as bridges
       from account_authorization_state state where state.account_id=$1`,
      [FUTURE_ACCOUNT],
    );
    assert.deepEqual(cutover.rows[0], { authority_mode: 'normalized', bridges: 0 });
    assert.deepEqual(await accountReach(pg, FUTURE_ACCOUNT), []);

    await pg.query(
      `update organization_access_grants
          set starts_at=clock_timestamp()-interval '1 minute'
        where id=$1`,
      [grant.rows[0].id],
    );
    assert.deepEqual(await accountReach(pg, FUTURE_ACCOUNT), [PID_A1]);
    await pg.query(
      `update organization_access_grants
          set status='revoked', revoked_at=clock_timestamp(),
              revocation_reason='future lifecycle test'
        where id=$1`,
      [grant.rows[0].id],
    );
    assert.deepEqual(await accountReach(pg, FUTURE_ACCOUNT), []);
    const stale = await pg.query<{ property_access: string[] }>(
      `select property_access from accounts where id=$1`, [FUTURE_ACCOUNT],
    );
    assert.deepEqual(stale.rows[0].property_access, [PID_A1]);
  });

  test('hotel transfer removes former-company people from the exact roster without cross-company union', async () => {
    const before = await pg.query<JsonRow>(
      `select public.staxis_list_authoritative_hotel_accounts($1,false) as value`,
      [PID_A1],
    );
    const beforeIds = (before.rows[0].value.accounts as Array<{ accountId: string }>)
      .map((account) => account.accountId);
    assert.equal(beforeIds.includes(ACCOUNT_MARIA), true);
    assert.equal(beforeIds.includes(ACCOUNT_BO), false);

    await pg.query(
      `select public.staxis_set_primary_property_organization($1,$2,$3,'operator')`,
      [ACCOUNT_ADMIN, PID_A1, ORG_B],
    );
    const after = await pg.query<JsonRow>(
      `select public.staxis_list_authoritative_hotel_accounts($1,false) as value`,
      [PID_A1],
    );
    const afterIds = (after.rows[0].value.accounts as Array<{ accountId: string }>)
      .map((account) => account.accountId);
    assert.equal(afterIds.includes(ACCOUNT_MARIA), false);
    assert.equal(afterIds.includes(ACCOUNT_BO), true);
    assert.equal(JSON.stringify(after.rows[0].value).includes(PID_B1), true);
  });
});
