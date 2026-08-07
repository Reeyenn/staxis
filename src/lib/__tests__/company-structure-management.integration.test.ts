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
  ACCOUNT_ADMIN,
  ACCOUNT_BO,
  ACCOUNT_FIONA,
  ACCOUNT_FRANK,
  ACCOUNT_GIL,
  ACCOUNT_MARIA,
  ORG_A,
  ORG_B,
  PID_A1,
  PID_A2,
  PID_A3,
  PID_B1,
  seedTwoCompanies,
} from '../../../tests/fixtures/pglite-two-company-seed';

const PORTFOLIO_A_EAST = 'e1000000-0000-4000-8000-000000000001';
const PORTFOLIO_A_WEST = 'e1000000-0000-4000-8000-000000000002';
const PORTFOLIO_B = 'e2000000-0000-4000-8000-000000000001';
const BRAND_ORG = 'e3000000-0000-4000-8000-000000000001';
const IDEMPOTENCY = 'e4000000-0000-4000-8000-000000000001';
const UNPREVIEWED_IDEMPOTENCY = 'e4000000-0000-4000-8000-000000000002';
const MIXED_ACCOUNT = 'e5000000-0000-4000-8000-000000000001';
const MIXED_UID = 'e5000000-0000-4000-8000-000000000002';

interface JsonRow { value: Record<string, unknown> }

async function epoch(pg: PGlite, organizationId: string): Promise<number> {
  const result = await pg.query<{ version: number }>(
    `select version from organization_access_epochs where organization_id = $1`,
    [organizationId],
  );
  return Number(result.rows[0]?.version);
}

async function preview(
  pg: PGlite,
  actorId: string,
  organizationId: string,
  propertyId: string,
  desiredPortfolioIds: string[],
  expectedEpoch: number,
): Promise<Record<string, unknown>> {
  const result = await pg.query<JsonRow>(
    `select public._staxis_preview_company_portfolio_assignment(
       $1, $2, $3, $4::uuid[], $5
     ) as value`,
    [actorId, organizationId, propertyId, `{${desiredPortfolioIds.join(',')}}`, expectedEpoch],
  );
  return result.rows[0].value;
}

async function expectSqlState(action: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(action, (caught: unknown) => (
    Boolean(caught && typeof caught === 'object' && (caught as { code?: string }).code === code)
  ));
}

describe('company structure management — real SQL tenant and lifecycle boundaries', () => {
  let pg: PGlite;
  let seed: Awaited<ReturnType<typeof seedTwoCompanies>>;

  before(async () => {
    const migrated = await applyMigrationsToPglite();
    pg = migrated.pg;
    seed = await seedTwoCompanies(pg);

    await pg.query(
      `insert into portfolios (id, organization_id, name, portfolio_type, status)
       values ($1, $2, 'East Region', 'region', 'active'),
              ($3, $2, 'West Region', 'region', 'active'),
              ($4, $5, 'Piney Region', 'region', 'active')`,
      [PORTFOLIO_A_EAST, ORG_A, PORTFOLIO_A_WEST, PORTFOLIO_B, ORG_B],
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
      [ORG_A, PORTFOLIO_A_EAST, PID_A1],
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
      [ORG_A, PORTFOLIO_A_WEST, PID_A2],
    );
    await pg.query(
      `insert into auth.users (id, email) values ($1, 'mixed-structure@example.test')`,
      [MIXED_UID],
    );
    await pg.query(
      `insert into accounts (
         id, username, password_hash, display_name, role, data_user_id
       ) values ($1, 'mixed-structure', 'x', 'Mixed Structure Actor', 'front_desk', $2)`,
      [MIXED_ACCOUNT, MIXED_UID],
    );
    const mixedMembership = await pg.query<{ id: string }>(
      `insert into organization_memberships (
         organization_id, account_id, job_category, job_title, status
       ) values ($1, $2, 'operations', 'Regional Support', 'active') returning id`,
      [ORG_A, MIXED_ACCOUNT],
    );
    await pg.query(
      `insert into organization_access_grants (
         organization_id, membership_id, access_profile, scope_type,
         property_relationship_id, property_id, source
       )
       select $1, $2, 'viewer', 'property', relationship.id, $3, 'manual'
       from organization_property_relationships relationship
       where relationship.organization_id = $1
         and relationship.property_id = $3
         and relationship.is_primary_grouping is true
         and relationship.relationship_type in ('operator', 'owner')
         and relationship.ends_at is null`,
      [ORG_A, mixedMembership.rows[0].id, PID_A1],
    );
    await pg.query(
      `insert into organization_access_grants (
         organization_id, membership_id, access_profile, scope_type,
         portfolio_id, source
       ) values ($1, $2, 'portfolio_manager', 'portfolio', $3, 'manual')`,
      [ORG_A, mixedMembership.rows[0].id, PORTFOLIO_A_WEST],
    );
    await pg.query(
      `insert into organizations (id, name, organization_type, status)
       values ($1, 'Example Brand', 'brand', 'active')`,
      [BRAND_ORG],
    );
    await pg.query(
      `insert into organization_property_relationships (
         organization_id, property_id, relationship_type, is_primary_grouping
       ) values ($1, $2, 'brand', false)`,
      [BRAND_ORG, PID_A1],
    );
  });

  after(async () => {
    await pg?.close();
  });

  // Fiona used to be the third case here, as a `finance` hat that could not
  // manage assignments. 0464 retired that role and converted her into a
  // regional manager, so she now sits with Maria on the CAN side. The refusals
  // that remain are the hotel jobs, which is where the boundary actually is.
  test('every company job can manage same-company assignments; hotel jobs cannot', async () => {
    const currentEpoch = await epoch(pg, ORG_A);
    const ownerPreview = await preview(
      pg, ACCOUNT_ANA, ORG_A, PID_A1, [PORTFOLIO_A_WEST], currentEpoch,
    );
    assert.deepEqual(ownerPreview.currentPortfolioIds, [PORTFOLIO_A_EAST]);
    assert.deepEqual(ownerPreview.desiredPortfolioIds, [PORTFOLIO_A_WEST]);
    assert.equal(ownerPreview.accessChangesImmediately, true);

    const vpPreview = await preview(
      pg, ACCOUNT_MARIA, ORG_A, PID_A2, [PORTFOLIO_A_EAST], currentEpoch,
    );
    assert.equal(vpPreview.propertyId, PID_A2);

    const fionaPreview = await preview(
      pg, ACCOUNT_FIONA, ORG_A, PID_A1, [PORTFOLIO_A_WEST], currentEpoch,
    );
    assert.equal(fionaPreview.propertyId, PID_A1);

    await expectSqlState(
      preview(pg, ACCOUNT_FRANK, ORG_A, PID_A1, [PORTFOLIO_A_WEST], currentEpoch),
      '42501',
    );
    await expectSqlState(
      preview(pg, ACCOUNT_GIL, ORG_B, PID_B1, [PORTFOLIO_B], await epoch(pg, ORG_B)),
      '42501',
    );
  });

  test('foreign company, hotel, portfolio, and brand ids all fail closed', async () => {
    const currentEpoch = await epoch(pg, ORG_A);
    await expectSqlState(
      preview(pg, ACCOUNT_ANA, ORG_B, PID_B1, [PORTFOLIO_B], await epoch(pg, ORG_B)),
      '42501',
    );
    await expectSqlState(
      preview(pg, ACCOUNT_ANA, ORG_A, PID_B1, [PORTFOLIO_A_EAST], currentEpoch),
      '42501',
    );
    await expectSqlState(
      preview(pg, ACCOUNT_ANA, ORG_A, PID_A1, [PORTFOLIO_B], currentEpoch),
      '42501',
    );
    await expectSqlState(
      preview(pg, ACCOUNT_ANA, BRAND_ORG, PID_A1, [], 1),
      '42501',
    );
  });

  test('mixed narrow read and portfolio-manager grants cannot be combined into broader mutation reach', async () => {
    const currentEpoch = await epoch(pg, ORG_A);

    // The viewer grant makes A1 readable, but it is not in the actor's managed
    // West portfolio. Combining those independent grants must not authorize a
    // move of A1 into West.
    await expectSqlState(
      preview(pg, MIXED_ACCOUNT, ORG_A, PID_A1, [PORTFOLIO_A_WEST], currentEpoch),
      '42501',
    );

    // A2 is already covered by the portfolio-manager grant and remains a
    // legitimate exact target for a no-op/current assignment preview.
    const allowed = await preview(
      pg, MIXED_ACCOUNT, ORG_A, PID_A2, [PORTFOLIO_A_WEST], currentEpoch,
    );
    assert.equal(allowed.propertyId, PID_A2);
    assert.deepEqual(allowed.currentPortfolioIds, [PORTFOLIO_A_WEST]);
  });

  test('company owner, regional manager, and GM cannot use the platform-admin hotel transfer path', async () => {
    for (const actorId of [ACCOUNT_ANA, ACCOUNT_MARIA, ACCOUNT_FIONA, ACCOUNT_GIL]) {
      await expectSqlState(
        pg.query(
          `select public.staxis_set_primary_property_organization($1, $2, $3, 'operator')`,
          [actorId, PID_A1, ORG_B],
        ),
        '42501',
      );
    }
    const relationship = await pg.query<{ organization_id: string }>(
      `select organization_id
       from organization_property_relationships
       where property_id = $1 and is_primary_grouping is true and ends_at is null`,
      [PID_A1],
    );
    assert.deepEqual(relationship.rows.map((row) => row.organization_id), [ORG_A]);
  });

  test('a scoped hotel user projection cannot enumerate a sister hotel', async () => {
    const result = await pg.query<JsonRow>(
      `select public.staxis_company_structure_projection($1) as value`,
      [ACCOUNT_FRANK],
    );
    const projection = result.rows[0].value;
    const organizations = projection.organizations as Array<Record<string, unknown>>;
    assert.equal(organizations.length, 1);
    const hotels = organizations[0].hotels as Array<Record<string, unknown>>;
    assert.deepEqual(hotels.map((hotel) => hotel.propertyId), [PID_A1]);
    assert.equal(JSON.stringify(projection).includes(PID_A2), false);
    assert.equal(JSON.stringify(projection).includes('Lufkin Inn'), false);
  });

  test('an epoch race invalidates the preview before confirmation', async () => {
    const staleEpoch = await epoch(pg, ORG_A);
    await pg.query(
      `update portfolios set name = 'East Region Updated' where id = $1`,
      [PORTFOLIO_A_EAST],
    );
    await expectSqlState(
      preview(pg, ACCOUNT_ANA, ORG_A, PID_A1, [PORTFOLIO_A_WEST], staleEpoch),
      '40001',
    );
  });

  test('the database refuses a missing preview fingerprint or confirmation', async () => {
    const currentEpoch = await epoch(pg, ORG_A);
    await expectSqlState(
      pg.query(
        `select public.staxis_commit_company_portfolio_assignment(
           $1, $2, $3, $4::uuid[], $5, null, true, $6
         )`,
        [ACCOUNT_ANA, ORG_A, PID_A1, `{${PORTFOLIO_A_WEST}}`, currentEpoch, UNPREVIEWED_IDEMPOTENCY],
      ),
      '22023',
    );
    await expectSqlState(
      pg.query(
        `select public.staxis_commit_company_portfolio_assignment(
           $1, $2, $3, $4::uuid[], $5, $6, false, $7
         )`,
        [ACCOUNT_ANA, ORG_A, PID_A1, `{${PORTFOLIO_A_WEST}}`, currentEpoch, 'a'.repeat(64), UNPREVIEWED_IDEMPOTENCY],
      ),
      '22023',
    );
  });

  test('commit is audited, changes access epoch immediately, and retries idempotently', async () => {
    const expectedEpoch = await epoch(pg, ORG_A);
    const impact = await preview(
      pg, ACCOUNT_ANA, ORG_A, PID_A1, [PORTFOLIO_A_WEST], expectedEpoch,
    );
    const fingerprint = String(impact.previewFingerprint);
    const first = await pg.query<JsonRow>(
      `select public.staxis_commit_company_portfolio_assignment(
         $1, $2, $3, $4::uuid[], $5, $6, true, $7
       ) as value`,
      [ACCOUNT_ANA, ORG_A, PID_A1, `{${PORTFOLIO_A_WEST}}`, expectedEpoch, fingerprint, IDEMPOTENCY],
    );
    assert.equal(first.rows[0].value.changed, true);
    assert.equal(first.rows[0].value.idempotentReplay, false);
    assert.ok(Number(first.rows[0].value.accessEpoch) > expectedEpoch);

    const replay = await pg.query<JsonRow>(
      `select public.staxis_commit_company_portfolio_assignment(
         $1, $2, $3, $4::uuid[], $5, $6, true, $7
       ) as value`,
      [ACCOUNT_ANA, ORG_A, PID_A1, `{${PORTFOLIO_A_WEST}}`, expectedEpoch, fingerprint, IDEMPOTENCY],
    );
    assert.equal(replay.rows[0].value.idempotentReplay, true);
    assert.equal(replay.rows[0].value.accessEpoch, first.rows[0].value.accessEpoch);

    const audit = await pg.query<{ count: number }>(
      `select count(*)::integer as count
       from organization_access_events
       where request_id = $1
         and event_type = 'company_structure.portfolio_assignment_commit'
         and organization_id = $2
         and target_id = $3`,
      [IDEMPOTENCY, ORG_A, PID_A1],
    );
    assert.equal(Number(audit.rows[0].count), 1);

    const openAssignments = await pg.query<{ portfolio_id: string }>(
      `select portfolio_id
       from portfolio_properties
       where organization_id = $1 and property_id = $2
         and removed_at is null
       order by portfolio_id`,
      [ORG_A, PID_A1],
    );
    assert.deepEqual(openAssignments.rows.map((row) => row.portfolio_id), [PORTFOLIO_A_WEST]);
  });

  test('an idempotency key cannot be reused for a different request', async () => {
    const currentEpoch = await epoch(pg, ORG_A);
    await expectSqlState(
      pg.query(
        `select public.staxis_commit_company_portfolio_assignment(
           $1, $2, $3, $4::uuid[], $5, $6, true, $7
         )`,
        [ACCOUNT_ANA, ORG_A, PID_A1, '{}', currentEpoch, 'f'.repeat(64), IDEMPOTENCY],
      ),
      '23505',
    );
  });

  test('a newly acquired governed hotel appears without a customer claiming relationship', async () => {
    await seed.attachPropertyToOrganization(pg, ORG_A, PID_A3, 'Port Arthur Hotel');
    const result = await pg.query<JsonRow>(
      `select public.staxis_company_structure_projection($1) as value`,
      [ACCOUNT_ANA],
    );
    const organizations = result.rows[0].value.organizations as Array<Record<string, unknown>>;
    const company = organizations.find((organization) => organization.id === ORG_A);
    assert.ok(company);
    const hotels = company.hotels as Array<Record<string, unknown>>;
    assert.ok(hotels.some((hotel) => hotel.propertyId === PID_A3));
    const problems = company.problems as Array<Record<string, unknown>>;
    assert.ok(problems.some((problem) => (
      problem.code === 'hotel_without_portfolio' && problem.propertyId === PID_A3
    )));

    const oldEpoch = await epoch(pg, ORG_A);
    await pg.query(
      `select public.staxis_set_primary_property_organization($1, $2, $3, 'operator')`,
      [ACCOUNT_ADMIN, PID_A3, ORG_B],
    );
    assert.ok(await epoch(pg, ORG_A) > oldEpoch);
    const afterTransfer = await pg.query<JsonRow>(
      `select public.staxis_company_structure_projection($1) as value`,
      [ACCOUNT_ANA],
    );
    assert.equal(JSON.stringify(afterTransfer.rows[0].value).includes(PID_A3), false);
    const receivingCompany = await pg.query<JsonRow>(
      `select public.staxis_company_structure_projection($1) as value`,
      [ACCOUNT_BO],
    );
    assert.equal(JSON.stringify(receivingCompany.rows[0].value).includes(PID_A3), true);
  });
});
