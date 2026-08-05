process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-min-20-chars';
process.env.CRON_SECRET ??= 'placeholder-cron-secret-min-16';

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { PGlite } from '@electric-sql/pglite';

import { applyMigrationsToPgliteThrough } from '../../../tests/fixtures/pglite-migrate';
import {
  ACCOUNT_ADMIN,
  ACCOUNT_ANA,
  ACCOUNT_FIONA,
  ACCOUNT_GIL,
  ACCOUNT_MARIA,
  ACCOUNT_BO,
  ORG_A,
  ORG_B,
  PID_A1,
  PID_A2,
  PID_L1,
  seedTwoCompanies,
} from '../../../tests/fixtures/pglite-two-company-seed';

const PORTFOLIO = 'c8200000-0000-4000-8000-000000000001';
const BRAND = 'c8200000-0000-4000-8000-000000000002';
const TRANSFER_KEY = 'c8200000-0000-4000-8000-000000000003';
const ACQUIRE_KEY = 'c8200000-0000-4000-8000-000000000004';
const TYPE_KEY = 'c8200000-0000-4000-8000-000000000005';
const DEACTIVATE_KEY = 'c8200000-0000-4000-8000-000000000006';
const ROLE_REMOVAL_KEY = 'c8200000-0000-4000-8000-000000000007';
const SCHEDULED_TRANSFER_KEY = 'c8200000-0000-4000-8000-000000000008';
const SCHEDULED_DEACTIVATE_KEY = 'c8200000-0000-4000-8000-000000000009';

interface JsonRow { value: Record<string, unknown> }

async function projection(
  pg: PGlite,
  actorId: string,
  propertyId: string,
  query = '',
): Promise<Record<string, unknown>> {
  const result = await pg.query<JsonRow>(
    `select public.staxis_admin_hotel_relationship_projection($1, $2, $3) as value`,
    [actorId, propertyId, query],
  );
  return result.rows[0].value;
}

async function preview(
  pg: PGlite,
  actorId: string,
  propertyId: string,
  targetOrganizationId: string | null,
  relationshipType: 'operator' | 'owner' | null,
  revision: string,
): Promise<Record<string, unknown>> {
  const result = await pg.query<JsonRow>(
    `select public._staxis_preview_admin_hotel_relationship($1, $2, $3, $4, $5) as value`,
    [actorId, propertyId, targetOrganizationId, relationshipType, revision],
  );
  return result.rows[0].value;
}

async function commit(
  pg: PGlite,
  propertyId: string,
  targetOrganizationId: string | null,
  relationshipType: 'operator' | 'owner' | null,
  revision: string,
  fingerprint: string,
  idempotencyKey: string,
): Promise<Record<string, unknown>> {
  const result = await pg.query<JsonRow>(
    `select public.staxis_commit_admin_hotel_relationship(
       $1, $2, $3, $4, $5, $6, true, $7
     ) as value`,
    [ACCOUNT_ADMIN, propertyId, targetOrganizationId, relationshipType, revision, fingerprint, idempotencyKey],
  );
  return result.rows[0].value;
}

async function expectSqlState(action: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(action, (caught: unknown) => (
    Boolean(caught && typeof caught === 'object' && (caught as { code?: string }).code === code)
  ));
}

async function epoch(pg: PGlite, organizationId: string): Promise<number> {
  const result = await pg.query<{ version: number }>(
    `select version from organization_access_epochs where organization_id = $1`,
    [organizationId],
  );
  return Number(result.rows[0].version);
}

describe('platform-admin hotel relationship lifecycle — real SQL boundaries', () => {
  let pg: PGlite;
  let anaMembership: string;

  before(async () => {
    const migrated = await applyMigrationsToPgliteThrough('0425');
    pg = migrated.pg;
    const seed = await seedTwoCompanies(pg);
    anaMembership = seed.hats.get(`${ACCOUNT_ANA}:company:owner`)!;
    await pg.query(
      `insert into organizations (id, name, organization_type, status)
       values ($1, 'Example Brand', 'brand', 'active')`,
      [BRAND],
    );
  });

  after(async () => { await pg?.close(); });

  test('only a fresh platform admin can project or preview; company owner, VP, finance, and GM fail closed', async () => {
    const adminProjection = await projection(pg, ACCOUNT_ADMIN, PID_A1, 'Gulf');
    assert.equal(adminProjection.lifecycleStatus, 'company_managed');
    assert.equal((adminProjection.currentRelationship as Record<string, unknown>).organizationId, ORG_A);
    assert.deepEqual(
      (adminProjection.organizations as Array<Record<string, unknown>>).map((organization) => organization.id),
      [ORG_A],
    );

    for (const actor of [ACCOUNT_ANA, ACCOUNT_MARIA, ACCOUNT_FIONA, ACCOUNT_GIL]) {
      await expectSqlState(
        pg.query(`select public.staxis_admin_hotel_relationship_projection($1, $2, '')`, [actor, PID_A1]),
        '42501',
      );
      await expectSqlState(
        preview(pg, actor, PID_A1, ORG_B, 'operator', String(adminProjection.relationshipRevision)),
        '42501',
      );
    }
  });

  test('direct hotel and target ids are revalidated and stale relationship revisions fail', async () => {
    const current = await projection(pg, ACCOUNT_ADMIN, PID_A2);
    await expectSqlState(
      preview(pg, ACCOUNT_ADMIN, 'ffffffff-ffff-4fff-8fff-ffffffffffff', ORG_B, 'operator', String(current.relationshipRevision)),
      'P0002',
    );
    await expectSqlState(
      preview(pg, ACCOUNT_ADMIN, PID_A2, BRAND, 'operator', String(current.relationshipRevision)),
      '23503',
    );
    await pg.query(`update properties set name = 'Lufkin Inn Updated' where id = $1`, [PID_A2]);
    await expectSqlState(
      preview(pg, ACCOUNT_ADMIN, PID_A2, ORG_B, 'operator', String(current.relationshipRevision)),
      '40001',
    );
  });

  test('transfer preview reports exact destructive impact; commit revokes, invalidates, audits, and replays idempotently', async () => {
    const relationship = await pg.query<{ id: string }>(
      `select id from organization_property_relationships
       where organization_id = $1 and property_id = $2
         and is_primary_grouping is true and ends_at is null`,
      [ORG_A, PID_A1],
    );
    const relationshipId = relationship.rows[0].id;
    await pg.query(
      `insert into portfolios (id, organization_id, name, portfolio_type, status)
       values ($1, $2, 'Lifecycle Region', 'region', 'active')`,
      [PORTFOLIO, ORG_A],
    );
    await pg.query(
      `insert into portfolio_properties (
         organization_id, portfolio_id, property_relationship_id, property_id,
         assigned_by_account_id
       ) values ($1, $2, $3, $4, $5)`,
      [ORG_A, PORTFOLIO, relationshipId, PID_A1, ACCOUNT_ADMIN],
    );
    await pg.query(
      `insert into organization_access_grants (
         organization_id, membership_id, access_profile, scope_type,
         property_relationship_id, property_id, source, granted_by_account_id
       ) values ($1, $2, 'viewer', 'property', $3, $4, 'manual', $5)`,
      [ORG_A, anaMembership, relationshipId, PID_A1, ACCOUNT_ADMIN],
    );
    await pg.query(
      `insert into organization_invitations (
         organization_id, email, token_hash, access_profile, scope_type,
         property_relationship_id, property_id, invited_by_account_id, expires_at
       ) values ($1, 'lifecycle@example.test', $2, 'viewer', 'property', $3, $4, $5, now() + interval '1 day')`,
      [ORG_A, '1'.repeat(64), relationshipId, PID_A1, ACCOUNT_ADMIN],
    );
    await pg.query(
      `insert into organization_access_requests (
         organization_id, membership_id, requested_access_profile, scope_type,
         property_relationship_id, property_id, reason
       ) values ($1, $2, 'viewer', 'property', $3, $4, 'Lifecycle test request')`,
      [ORG_A, anaMembership, relationshipId, PID_A1],
    );

    const oldAEpoch = await epoch(pg, ORG_A);
    const oldBEpoch = await epoch(pg, ORG_B);
    const current = await projection(pg, ACCOUNT_ADMIN, PID_A1);
    const impact = await preview(
      pg, ACCOUNT_ADMIN, PID_A1, ORG_B, 'operator', String(current.relationshipRevision),
    );
    assert.deepEqual(impact.impact, {
      revokedPropertyGrantCount: 1,
      revokedInvitationCount: 1,
      cancelledRequestCount: 1,
      removedPortfolioAssignmentCount: 1,
    });
    assert.equal(impact.changed, true);
    assert.equal(impact.accessChangesImmediately, true);

    const result = await commit(
      pg, PID_A1, ORG_B, 'operator', String(current.relationshipRevision),
      String(impact.previewFingerprint), TRANSFER_KEY,
    );
    assert.equal(result.organizationId, ORG_B);
    assert.equal(result.changed, true);
    assert.equal(result.idempotentReplay, false);
    assert.ok(await epoch(pg, ORG_A) > oldAEpoch);
    assert.ok(await epoch(pg, ORG_B) > oldBEpoch);

    const states = await pg.query<{
      grant_status: string;
      invitation_status: string;
      request_status: string;
      assignment_removed: boolean;
    }>(
      `select
         (select status from organization_access_grants where property_relationship_id = $1) as grant_status,
         (select status from organization_invitations where property_relationship_id = $1) as invitation_status,
         (select status from organization_access_requests where property_relationship_id = $1) as request_status,
         (select removed_at is not null from portfolio_properties where property_relationship_id = $1) as assignment_removed`,
      [relationshipId],
    );
    assert.deepEqual(states.rows[0], {
      grant_status: 'revoked',
      invitation_status: 'revoked',
      request_status: 'cancelled',
      assignment_removed: true,
    });

    const oldOwnerReach = await pg.query<{ found: boolean }>(
      `select exists(
         select 1 from public._staxis_nonlegacy_property_authorizations($1)
         where property_id = $2
       ) as found`,
      [ACCOUNT_ANA, PID_A1],
    );
    const newOwnerReach = await pg.query<{ found: boolean }>(
      `select exists(
         select 1 from public._staxis_nonlegacy_property_authorizations($1)
         where property_id = $2
       ) as found`,
      [ACCOUNT_BO, PID_A1],
    );
    assert.equal(oldOwnerReach.rows[0].found, false);
    assert.equal(newOwnerReach.rows[0].found, true);

    const summaryAudit = await pg.query<{ organization_id: string }>(
      `select organization_id from organization_access_events
       where request_id = $1 and event_type = 'admin_hotel_relationship.commit'
       order by organization_id`,
      [TRANSFER_KEY],
    );
    assert.deepEqual(summaryAudit.rows.map((row) => row.organization_id).sort(), [ORG_A, ORG_B].sort());

    const replay = await commit(
      pg, PID_A1, ORG_B, 'operator', String(current.relationshipRevision),
      String(impact.previewFingerprint), TRANSFER_KEY,
    );
    assert.equal(replay.idempotentReplay, true);
    assert.equal(replay.relationshipId, result.relationshipId);
  });

  test('one control supports acquire/link, owner/operator edit, and deactivate to Independent', async () => {
    const independent = await projection(pg, ACCOUNT_ADMIN, PID_L1);
    assert.equal(independent.lifecycleStatus, 'independent');
    const acquirePreview = await preview(
      pg, ACCOUNT_ADMIN, PID_L1, ORG_A, 'operator', String(independent.relationshipRevision),
    );
    const acquired = await commit(
      pg, PID_L1, ORG_A, 'operator', String(independent.relationshipRevision),
      String(acquirePreview.previewFingerprint), ACQUIRE_KEY,
    );
    assert.equal(acquired.lifecycleStatus, 'company_managed');
    assert.equal(acquired.organizationId, ORG_A);
    assert.equal(acquired.relationshipType, 'operator');

    const operator = await projection(pg, ACCOUNT_ADMIN, PID_L1);
    const typePreview = await preview(
      pg, ACCOUNT_ADMIN, PID_L1, ORG_A, 'owner', String(operator.relationshipRevision),
    );
    const owner = await commit(
      pg, PID_L1, ORG_A, 'owner', String(operator.relationshipRevision),
      String(typePreview.previewFingerprint), TYPE_KEY,
    );
    assert.equal(owner.relationshipType, 'owner');

    const managed = await projection(pg, ACCOUNT_ADMIN, PID_L1);
    const deactivatePreview = await preview(
      pg, ACCOUNT_ADMIN, PID_L1, null, null, String(managed.relationshipRevision),
    );
    const independentAgain = await commit(
      pg, PID_L1, null, null, String(managed.relationshipRevision),
      String(deactivatePreview.previewFingerprint), DEACTIVATE_KEY,
    );
    assert.equal(independentAgain.lifecycleStatus, 'independent');
    assert.equal(independentAgain.organizationId, null);
    assert.equal(independentAgain.relationshipId, null);
  });

  test('scheduled-ending primaries are transferred and deactivated without dual-company reach', async () => {
    const scheduledRelationship = await pg.query<{ id: string }>(
      `update organization_property_relationships
          set ends_at = now() + interval '1 day'
        where organization_id = $1 and property_id = $2
          and is_primary_grouping is true and ends_at is null
      returning id`,
      [ORG_A, PID_A2],
    );
    const scheduledRelationshipId = scheduledRelationship.rows[0].id;
    await pg.query(
      `insert into organization_access_grants (
         organization_id, membership_id, access_profile, scope_type,
         property_relationship_id, property_id, source, granted_by_account_id
       ) values ($1, $2, 'viewer', 'property', $3, $4, 'manual', $5)`,
      [ORG_A, anaMembership, scheduledRelationshipId, PID_A2, ACCOUNT_ADMIN],
    );

    const before = await projection(pg, ACCOUNT_ADMIN, PID_A2);
    assert.equal((before.currentRelationship as Record<string, unknown>).organizationId, ORG_A);
    const transferPreview = await preview(
      pg, ACCOUNT_ADMIN, PID_A2, ORG_B, 'operator', String(before.relationshipRevision),
    );
    assert.equal(
      (transferPreview.impact as Record<string, unknown>).revokedPropertyGrantCount,
      1,
      'scheduled-ending current relationship must be included in exact destructive impact',
    );
    await commit(
      pg, PID_A2, ORG_B, 'operator', String(before.relationshipRevision),
      String(transferPreview.previewFingerprint), SCHEDULED_TRANSFER_KEY,
    );

    const afterTransfer = await pg.query<{ organization_id: string }>(
      `select relationship.organization_id
       from organization_property_relationships relationship
       join organizations organization on organization.id = relationship.organization_id
       where relationship.property_id = $1
         and relationship.is_primary_grouping is true
         and relationship.relationship_type in ('operator', 'owner')
         and relationship.starts_at <= now()
         and (relationship.ends_at is null or relationship.ends_at > now())
         and organization.organization_type <> 'single_hotel'
       order by relationship.organization_id`,
      [PID_A2],
    );
    assert.deepEqual(afterTransfer.rows.map((row) => row.organization_id), [ORG_B]);
    const transferredReach = await pg.query<{ old_reach: boolean; new_reach: boolean }>(
      `select
         exists(select 1 from public._staxis_nonlegacy_property_authorizations($1) where property_id = $3) as old_reach,
         exists(select 1 from public._staxis_nonlegacy_property_authorizations($2) where property_id = $3) as new_reach`,
      [ACCOUNT_ANA, ACCOUNT_BO, PID_A2],
    );
    assert.deepEqual(transferredReach.rows[0], { old_reach: false, new_reach: true });

    await pg.query(
      `update organization_property_relationships
          set ends_at = now() + interval '1 day'
        where organization_id = $1 and property_id = $2
          and is_primary_grouping is true and ends_at is null`,
      [ORG_B, PID_A2],
    );
    const scheduledAtB = await projection(pg, ACCOUNT_ADMIN, PID_A2);
    const deactivatePreview = await preview(
      pg, ACCOUNT_ADMIN, PID_A2, null, null, String(scheduledAtB.relationshipRevision),
    );
    await commit(
      pg, PID_A2, null, null, String(scheduledAtB.relationshipRevision),
      String(deactivatePreview.previewFingerprint), SCHEDULED_DEACTIVATE_KEY,
    );
    const afterDeactivate = await pg.query<{ count: number; new_reach: boolean }>(
      `select
         (select count(*)::integer
          from organization_property_relationships relationship
          join organizations organization on organization.id = relationship.organization_id
          where relationship.property_id = $2
            and relationship.is_primary_grouping is true
            and relationship.relationship_type in ('operator', 'owner')
            and relationship.starts_at <= now()
            and (relationship.ends_at is null or relationship.ends_at > now())
            and organization.organization_type <> 'single_hotel') as count,
         exists(select 1 from public._staxis_nonlegacy_property_authorizations($1) where property_id = $2) as new_reach`,
      [ACCOUNT_BO, PID_A2],
    );
    assert.deepEqual(afterDeactivate.rows[0], { count: 0, new_reach: false });
  });

  test('admin removal between preview and commit takes effect immediately, including a stale open session', async () => {
    const current = await projection(pg, ACCOUNT_ADMIN, PID_A2);
    const impact = await preview(
      pg, ACCOUNT_ADMIN, PID_A2, ORG_B, 'owner', String(current.relationshipRevision),
    );
    await pg.query(`update accounts set role = 'owner' where id = $1`, [ACCOUNT_ADMIN]);
    await expectSqlState(
      commit(
        pg, PID_A2, ORG_B, 'owner', String(current.relationshipRevision),
        String(impact.previewFingerprint), ROLE_REMOVAL_KEY,
      ),
      '42501',
    );
    await expectSqlState(
      commit(
        pg, PID_A1, ORG_B, 'operator', String(current.relationshipRevision),
        String(impact.previewFingerprint), TRANSFER_KEY,
      ),
      '42501',
    );
    await pg.query(`update accounts set role = 'admin' where id = $1`, [ACCOUNT_ADMIN]);
  });
});
