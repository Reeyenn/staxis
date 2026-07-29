process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-min-20-chars';
process.env.CRON_SECRET ??= 'placeholder-cron-secret-min-16';

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { PGlite } from '@electric-sql/pglite';

import { applyMigrationsToPglite } from '../../../tests/fixtures/pglite-migrate';
import {
  ACCOUNT_ANA,
  ACCOUNT_FIONA,
  ACCOUNT_FRANK,
  ACCOUNT_GIL,
  ACCOUNT_MARIA,
  ORG_A,
  ORG_B,
  PID_A1,
  PID_A2,
  PID_B1,
  seedTwoCompanies,
} from '../../../tests/fixtures/pglite-two-company-seed';

const TARGET_ACCOUNT = 'c1000000-0000-4000-8000-000000000001';
const TARGET_UID = 'c1000000-0000-4000-8000-000000000002';
const TARGET_B_ACCOUNT = 'c2000000-0000-4000-8000-000000000001';
const TARGET_B_UID = 'c2000000-0000-4000-8000-000000000002';
const ADD_ACCOUNT = 'c3000000-0000-4000-8000-000000000001';
const ADD_UID = 'c3000000-0000-4000-8000-000000000002';
const PORTFOLIO_A = 'c4000000-0000-4000-8000-000000000001';
const PORTFOLIO_B = 'c4000000-0000-4000-8000-000000000002';
const IDEMPOTENCY = 'c5000000-0000-4000-8000-000000000001';
const ADD_IDEMPOTENCY = 'c5000000-0000-4000-8000-000000000002';
const NESTED_ROOT = 'c6000000-0000-4000-8000-000000000001';
const NESTED_CHILD = 'c6000000-0000-4000-8000-000000000002';
const SCOPED_MANAGER_ACCOUNT = 'c7000000-0000-4000-8000-000000000001';
const SCOPED_MANAGER_UID = 'c7000000-0000-4000-8000-000000000002';
const RECURSIVE_TARGET_ACCOUNT = 'c8000000-0000-4000-8000-000000000001';
const RECURSIVE_TARGET_UID = 'c8000000-0000-4000-8000-000000000002';
const RECURSIVE_IDEMPOTENCY = 'c9000000-0000-4000-8000-000000000001';

interface JsonRow { value: Record<string, unknown> }

async function epoch(pg: PGlite, organizationId: string): Promise<number> {
  const result = await pg.query<{ version: number }>(
    `select version from organization_access_epochs where organization_id = $1`,
    [organizationId],
  );
  return Number(result.rows[0].version);
}

async function revision(pg: PGlite, membershipId: string): Promise<string> {
  const result = await pg.query<{ value: string }>(
    `select public._staxis_company_access_membership_revision($1) as value`,
    [membershipId],
  );
  return result.rows[0].value;
}

async function createPlainMembership(
  pg: PGlite,
  accountId: string,
  userId: string,
  organizationId: string,
  username: string,
): Promise<string> {
  await pg.query(`insert into auth.users (id, email) values ($1, $2)`, [userId, `${username}@example.test`]);
  await pg.query(
    `insert into accounts (
       id, username, password_hash, display_name, role, property_access, data_user_id
     ) values ($1, $2, 'x', $3, 'front_desk', '{}', $4)`,
    [accountId, username, `${username} Person`, userId],
  );
  const result = await pg.query<{ id: string }>(
    `insert into organization_memberships (
       organization_id, account_id, job_category, job_title, status
     ) values ($1, $2, 'operations', 'Regional Support', 'active') returning id`,
    [organizationId, accountId],
  );
  return result.rows[0].id;
}

async function insertPropertyGrant(
  pg: PGlite,
  membershipId: string,
  organizationId: string,
  propertyId: string,
  profile = 'viewer',
): Promise<void> {
  await pg.query(
    `insert into organization_access_grants (
       organization_id, membership_id, access_profile, scope_type,
       property_relationship_id, property_id, source
     )
     select $1, $2, $4, 'property', relationship.id, $3, 'manual'
     from organization_property_relationships relationship
     where relationship.organization_id = $1
       and relationship.property_id = $3
       and relationship.is_primary_grouping is true
       and relationship.relationship_type in ('operator', 'owner')
       and relationship.ends_at is null`,
    [organizationId, membershipId, propertyId, profile],
  );
}

async function preview(
  pg: PGlite,
  args: {
    actorId: string;
    organizationId: string;
    membershipId: string;
    operation: 'replace' | 'add';
    profile: string;
    scope: 'organization' | 'portfolio' | 'selected_properties';
    portfolioId?: string | null;
    propertyIds?: string[];
    expectedEpoch: number;
    expectedRevision: string;
  },
): Promise<Record<string, unknown>> {
  const result = await pg.query<JsonRow>(
    `select public._staxis_preview_company_access_edit(
       $1, $2, $3, $4, $5, $6, $7, $8::uuid[], null, $9, $10
     ) as value`,
    [
      args.actorId,
      args.organizationId,
      args.membershipId,
      args.operation,
      args.profile,
      args.scope,
      args.portfolioId ?? null,
      `{${(args.propertyIds ?? []).join(',')}}`,
      args.expectedEpoch,
      args.expectedRevision,
    ],
  );
  return result.rows[0].value;
}

async function expectSqlState(action: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(action, (caught: unknown) => (
    Boolean(caught && typeof caught === 'object' && (caught as { code?: string }).code === code)
  ));
}

describe('company access management — real SQL lifecycle and tenant boundaries', () => {
  let pg: PGlite;
  let targetMembership: string;
  let targetBMembership: string;
  let addMembership: string;
  let recursiveTargetMembership: string;

  before(async () => {
    const migrated = await applyMigrationsToPglite();
    pg = migrated.pg;
    await seedTwoCompanies(pg);
    await pg.query(
      `insert into portfolios (id, organization_id, name, portfolio_type, status)
       values ($1, $2, 'Gulf Region', 'region', 'active'),
              ($3, $4, 'Piney Region', 'region', 'active')`,
      [PORTFOLIO_A, ORG_A, PORTFOLIO_B, ORG_B],
    );
    for (const propertyId of [PID_A1, PID_A2]) {
      await pg.query(
        `insert into portfolio_properties (
           organization_id, portfolio_id, property_relationship_id, property_id
         )
         select $1, $2, relationship.id, $3
         from organization_property_relationships relationship
         where relationship.organization_id = $1
           and relationship.property_id = $3
           and relationship.is_primary_grouping is true
           and relationship.ends_at is null`,
        [ORG_A, PORTFOLIO_A, propertyId],
      );
    }
    await pg.query(
      `insert into portfolios (
         id, organization_id, parent_id, name, portfolio_type, status
       ) values ($1, $3, null, 'Nested Operations', 'region', 'active'),
                ($2, $3, $1, 'Nested Child', 'portfolio', 'active')`,
      [NESTED_ROOT, NESTED_CHILD, ORG_A],
    );
    await pg.query(
      `insert into portfolio_properties (
         organization_id, portfolio_id, property_relationship_id, property_id
       )
       select $1, $2, relationship.id, $3
       from organization_property_relationships relationship
       where relationship.organization_id = $1
         and relationship.property_id = $3
         and relationship.is_primary_grouping is true
         and relationship.relationship_type in ('operator', 'owner')
         and relationship.ends_at is null`,
      [ORG_A, NESTED_CHILD, PID_A2],
    );
    const scopedManagerMembership = await createPlainMembership(
      pg, SCOPED_MANAGER_ACCOUNT, SCOPED_MANAGER_UID, ORG_A, 'scoped-manager',
    );
    await pg.query(
      `insert into organization_access_grants (
         organization_id, membership_id, access_profile, scope_type,
         portfolio_id, source
       ) values ($1, $2, 'portfolio_manager', 'portfolio', $3, 'manual')`,
      [ORG_A, scopedManagerMembership, NESTED_ROOT],
    );
    recursiveTargetMembership = await createPlainMembership(
      pg, RECURSIVE_TARGET_ACCOUNT, RECURSIVE_TARGET_UID, ORG_A, 'recursive-target',
    );
    targetMembership = await createPlainMembership(
      pg, TARGET_ACCOUNT, TARGET_UID, ORG_A, 'target-a',
    );
    await insertPropertyGrant(pg, targetMembership, ORG_A, PID_A1);
    targetBMembership = await createPlainMembership(
      pg, TARGET_B_ACCOUNT, TARGET_B_UID, ORG_B, 'target-b',
    );
    await insertPropertyGrant(pg, targetBMembership, ORG_B, PID_B1);
    addMembership = await createPlainMembership(
      pg, ADD_ACCOUNT, ADD_UID, ORG_A, 'target-add',
    );
    await insertPropertyGrant(pg, addMembership, ORG_A, PID_A1, 'contributor');
  });

  after(async () => {
    await pg?.close();
  });

  test('owner/VP get bounded edit policies; finance and hotel GMs get none', async () => {
    const owner = await pg.query<JsonRow>(
      `select public.staxis_company_access_editor_projection($1) as value`, [ACCOUNT_ANA],
    );
    assert.equal((owner.rows[0].value.organizations as unknown[]).length, 1);
    assert.equal(JSON.stringify(owner.rows[0].value).includes(PID_B1), false);
    assert.equal(JSON.stringify(owner.rows[0].value).includes(targetBMembership), false);

    const vp = await pg.query<JsonRow>(
      `select public.staxis_company_access_editor_projection($1) as value`, [ACCOUNT_MARIA],
    );
    const vpJson = JSON.stringify(vp.rows[0].value);
    assert.equal(vpJson.includes('property_manager'), true);
    assert.equal(vpJson.includes('organization_owner'), false);

    for (const actorId of [ACCOUNT_FIONA, ACCOUNT_FRANK, ACCOUNT_GIL]) {
      const denied = await pg.query<JsonRow>(
        `select public.staxis_company_access_editor_projection($1) as value`, [actorId],
      );
      assert.deepEqual(denied.rows[0].value.organizations, []);
    }
  });

  test('selected-hotel replacement is exact, immediate, audited, and idempotent', async () => {
    const expectedEpoch = await epoch(pg, ORG_A);
    const expectedRevision = await revision(pg, targetMembership);
    const impact = await preview(pg, {
      actorId: ACCOUNT_ANA,
      organizationId: ORG_A,
      membershipId: targetMembership,
      operation: 'replace',
      profile: 'property_manager',
      scope: 'selected_properties',
      propertyIds: [PID_A1, PID_A2],
      expectedEpoch,
      expectedRevision,
    });
    assert.deepEqual(impact.beforePropertyIds, [PID_A1]);
    assert.deepEqual(impact.afterPropertyIds, [PID_A1, PID_A2]);
    assert.equal(impact.revokedGrantCount, 1);
    assert.equal(impact.upsertedGrantCount, 2);

    const first = await pg.query<JsonRow>(
      `select public.staxis_commit_company_access_edit(
         $1, $2, $3, 'replace', 'property_manager', 'selected_properties',
         null, $4::uuid[], null, $5, $6, $7, true, $8
       ) as value`,
      [
        ACCOUNT_ANA,
        ORG_A,
        targetMembership,
        `{${PID_A1},${PID_A2}}`,
        expectedEpoch,
        expectedRevision,
        impact.previewFingerprint,
        IDEMPOTENCY,
      ],
    );
    assert.equal(first.rows[0].value.changed, true);
    assert.equal(first.rows[0].value.idempotentReplay, false);

    const reach = await pg.query<JsonRow>(
      `select public.staxis_list_account_authorized_properties($1) as value`, [TARGET_ACCOUNT],
    );
    assert.deepEqual(reach.rows[0].value.propertyIds, [PID_A1, PID_A2]);
    const active = await pg.query<{ access_profile: string; property_id: string }>(
      `select access_profile, property_id
       from organization_access_grants
       where membership_id = $1 and status = 'active'
       order by property_id`,
      [targetMembership],
    );
    assert.deepEqual(active.rows, [
      { access_profile: 'property_manager', property_id: PID_A1 },
      { access_profile: 'property_manager', property_id: PID_A2 },
    ]);

    const replay = await pg.query<JsonRow>(
      `select public.staxis_commit_company_access_edit(
         $1, $2, $3, 'replace', 'property_manager', 'selected_properties',
         null, $4::uuid[], null, $5, $6, $7, true, $8
       ) as value`,
      [
        ACCOUNT_ANA,
        ORG_A,
        targetMembership,
        `{${PID_A1},${PID_A2}}`,
        expectedEpoch,
        expectedRevision,
        impact.previewFingerprint,
        IDEMPOTENCY,
      ],
    );
    assert.equal(replay.rows[0].value.idempotentReplay, true);

    const audit = await pg.query<{ count: number }>(
      `select count(*)::integer as count from organization_access_events
       where request_id = $1
         and event_type = 'company_access.membership_grant_set_commit'`,
      [IDEMPOTENCY],
    );
    assert.equal(Number(audit.rows[0].count), 1);
  });

  test('add preserves current scope while adding a region atomically', async () => {
    const expectedEpoch = await epoch(pg, ORG_A);
    const expectedRevision = await revision(pg, addMembership);
    const impact = await preview(pg, {
      actorId: ACCOUNT_ANA,
      organizationId: ORG_A,
      membershipId: addMembership,
      operation: 'add',
      profile: 'viewer',
      scope: 'portfolio',
      portfolioId: PORTFOLIO_A,
      expectedEpoch,
      expectedRevision,
    });
    assert.equal(impact.retainedGrantCount, 1);
    assert.equal(impact.revokedGrantCount, 0);
    await pg.query(
      `select public.staxis_commit_company_access_edit(
         $1, $2, $3, 'add', 'viewer', 'portfolio', $4,
         '{}'::uuid[], null, $5, $6, $7, true, $8
       )`,
      [
        ACCOUNT_ANA, ORG_A, addMembership, PORTFOLIO_A, expectedEpoch,
        expectedRevision, impact.previewFingerprint, ADD_IDEMPOTENCY,
      ],
    );
    const active = await pg.query<{ access_profile: string; scope_type: string }>(
      `select access_profile, scope_type from organization_access_grants
       where membership_id = $1 and status = 'active' order by scope_type`,
      [addMembership],
    );
    assert.deepEqual(active.rows, [
      { access_profile: 'viewer', scope_type: 'portfolio' },
      { access_profile: 'contributor', scope_type: 'property' },
    ]);
  });

  test('portfolio-manager preview and commit include active descendant hotels exactly', async () => {
    const directExpansion = await pg.query<{ value: string[] }>(
      `select public._staxis_company_access_scope_properties(
         $1, 'portfolio', $2, null
       ) as value`,
      [ORG_A, NESTED_ROOT],
    );
    assert.deepEqual(directExpansion.rows[0].value, [PID_A2]);

    assert.equal((await pg.query<{ value: boolean }>(
      `select public._staxis_company_access_can_delegate(
         $1, $2, 'viewer', 'portfolio', $3, null
       ) as value`,
      [SCOPED_MANAGER_ACCOUNT, ORG_A, NESTED_CHILD],
    )).rows[0].value, true);
    assert.equal((await pg.query<{ value: boolean }>(
      `select public._staxis_company_access_can_delegate(
         $1, $2, 'viewer', 'property', null, $3
       ) as value`,
      [SCOPED_MANAGER_ACCOUNT, ORG_A, PID_A2],
    )).rows[0].value, true);
    assert.equal((await pg.query<{ value: boolean }>(
      `select public._staxis_company_access_can_delegate(
         $1, $2, 'viewer', 'property', null, $3
       ) as value`,
      [SCOPED_MANAGER_ACCOUNT, ORG_A, PID_A1],
    )).rows[0].value, false);

    const expectedEpoch = await epoch(pg, ORG_A);
    const expectedRevision = await revision(pg, recursiveTargetMembership);
    const impact = await preview(pg, {
      actorId: SCOPED_MANAGER_ACCOUNT,
      organizationId: ORG_A,
      membershipId: recursiveTargetMembership,
      operation: 'add',
      profile: 'viewer',
      scope: 'portfolio',
      portfolioId: NESTED_ROOT,
      expectedEpoch,
      expectedRevision,
    });
    assert.deepEqual(impact.beforePropertyIds, []);
    assert.deepEqual(impact.afterPropertyIds, [PID_A2]);

    await pg.query(
      `select public.staxis_commit_company_access_edit(
         $1, $2, $3, 'add', 'viewer', 'portfolio', $4,
         '{}'::uuid[], null, $5, $6, $7, true, $8
       )`,
      [
        SCOPED_MANAGER_ACCOUNT,
        ORG_A,
        recursiveTargetMembership,
        NESTED_ROOT,
        expectedEpoch,
        expectedRevision,
        impact.previewFingerprint,
        RECURSIVE_IDEMPOTENCY,
      ],
    );
    const reach = await pg.query<JsonRow>(
      `select public.staxis_list_account_authorized_properties($1) as value`,
      [RECURSIVE_TARGET_ACCOUNT],
    );
    assert.deepEqual(reach.rows[0].value.propertyIds, [PID_A2]);
  });

  test('cross-company and direct membership/hotel tampering fail closed', async () => {
    await expectSqlState(preview(pg, {
      actorId: ACCOUNT_ANA,
      organizationId: ORG_A,
      membershipId: targetBMembership,
      operation: 'replace',
      profile: 'viewer',
      scope: 'selected_properties',
      propertyIds: [PID_A1],
      expectedEpoch: await epoch(pg, ORG_A),
      expectedRevision: await revision(pg, targetBMembership),
    }), 'P0002');

    await expectSqlState(preview(pg, {
      actorId: ACCOUNT_ANA,
      organizationId: ORG_A,
      membershipId: addMembership,
      operation: 'replace',
      profile: 'viewer',
      scope: 'selected_properties',
      propertyIds: [PID_B1],
      expectedEpoch: await epoch(pg, ORG_A),
      expectedRevision: await revision(pg, addMembership),
    }), '42501');
  });

  test('stale membership/epoch preview and finance/GM mutations are denied', async () => {
    const staleEpoch = await epoch(pg, ORG_A);
    const staleRevision = await revision(pg, addMembership);
    await insertPropertyGrant(pg, addMembership, ORG_A, PID_A2, 'viewer');
    await expectSqlState(preview(pg, {
      actorId: ACCOUNT_ANA,
      organizationId: ORG_A,
      membershipId: addMembership,
      operation: 'replace',
      profile: 'viewer',
      scope: 'selected_properties',
      propertyIds: [PID_A1],
      expectedEpoch: staleEpoch,
      expectedRevision: staleRevision,
    }), '40001');

    const currentEpoch = await epoch(pg, ORG_A);
    const currentRevision = await revision(pg, addMembership);
    for (const actorId of [ACCOUNT_FIONA, ACCOUNT_FRANK]) {
      await expectSqlState(preview(pg, {
        actorId,
        organizationId: ORG_A,
        membershipId: addMembership,
        operation: 'replace',
        profile: 'viewer',
        scope: 'selected_properties',
        propertyIds: [PID_A1],
        expectedEpoch: currentEpoch,
        expectedRevision: currentRevision,
      }), '42501');
    }
  });
});
