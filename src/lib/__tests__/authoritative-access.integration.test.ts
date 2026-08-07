process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-min-20-chars';
process.env.CRON_SECRET ??= 'placeholder-cron-secret-min-16';
process.env.OPENAI_API_KEY ??= 'sk-placeholder-test-key-min-20-chars';

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { PGlite } from '@electric-sql/pglite';

import { applyMigrationsToPgliteThrough } from '../../../tests/fixtures/pglite-migrate';
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
  PID_L1,
  UID_ADMIN,
  UID_MARIA,
  UID_GIL,
  seedTwoCompanies,
  type TwoCompanySeed,
} from '../../../tests/fixtures/pglite-two-company-seed';

const REGION = '90000000-0000-4000-8000-000000000001';
const CHILD = '90000000-0000-4000-8000-000000000002';
const OVERLAPPING_SIBLING = '90000000-0000-4000-8000-000000000007';
const BRIDGE_ACCOUNT = '90000000-0000-4000-8000-000000000003';
const BRIDGE_USER = '90000000-0000-4000-8000-000000000004';
const GRANT_ACCOUNT = '90000000-0000-4000-8000-000000000005';
const GRANT_USER = '90000000-0000-4000-8000-000000000006';
const SCHEDULED_ACCOUNT = '90000000-0000-4000-8000-000000000008';
const SCHEDULED_USER = '90000000-0000-4000-8000-000000000009';
const SHADOW_ACCOUNT = '90000000-0000-4000-8000-000000000010';
const SHADOW_USER = '90000000-0000-4000-8000-000000000011';
const TRANSFER_BRIDGE_PROPERTY = '90000000-0000-4000-8000-000000000012';
const TRANSFER_BRIDGE_ACCOUNT = '90000000-0000-4000-8000-000000000013';
const TRANSFER_BRIDGE_USER = '90000000-0000-4000-8000-000000000014';
const WINDOW_GUARD_PROPERTY = '90000000-0000-4000-8000-000000000015';

let pg: PGlite;
let seed: TwoCompanySeed;

function asObject(value: unknown): Record<string, unknown> {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  assert.ok(parsed && typeof parsed === 'object' && !Array.isArray(parsed));
  return parsed as Record<string, unknown>;
}

async function resolveScope(args: {
  accountId: string;
  organizationId?: string | null;
  selector?: 'all_authorized' | 'portfolio' | 'property_subset';
  portfolioId?: string | null;
  propertyIds?: string[] | null;
}): Promise<Record<string, unknown>> {
  const result = await pg.query<{ result: unknown }>(
    `select public.staxis_resolve_authorization_scope(
       $1, $2, $3, $4, $5::jsonb, 120
     ) as result`,
    [
      args.accountId,
      args.organizationId ?? null,
      args.selector ?? 'all_authorized',
      args.portfolioId ?? null,
      args.propertyIds == null ? null : JSON.stringify(args.propertyIds),
    ],
  );
  return asObject(result.rows[0]?.result);
}

async function listAccess(accountId: string): Promise<Record<string, unknown>> {
  const result = await pg.query<{ result: unknown }>(
    'select public.staxis_list_account_authorized_properties($1) as result',
    [accountId],
  );
  return asObject(result.rows[0]?.result);
}

before(async () => {
  const migrated = await applyMigrationsToPgliteThrough('0425');
  assert.equal(
    migrated.report.failedAtRuntime.some((failure) => failure.file.startsWith('0376_')),
    false,
    `0378 must apply: ${JSON.stringify(migrated.report.failedAtRuntime)}`,
  );
  pg = migrated.pg;
  seed = await seedTwoCompanies(pg);
});

after(async () => {
  await pg?.close();
});

describe('authoritative access and exact portfolio receipts — real SQL', () => {
  test('service credentials reach authorization only through bounded RPCs', async () => {
    const privileges = await pg.query<{
      states: boolean;
      bridges: boolean;
      receipts: boolean;
      resolve_rpc: boolean;
      assert_rpc: boolean;
      receipt_helper: boolean;
      entitlement_helper: boolean;
      topology_helper: boolean;
      topology_rpc: boolean;
      topology_rpc_browser: boolean;
    }>(
      `select
         has_table_privilege('service_role', 'public.account_authorization_state', 'SELECT') as states,
         has_table_privilege('service_role', 'public.account_property_authorization_bridges', 'SELECT') as bridges,
         has_table_privilege('service_role', 'public.authorization_scope_receipts', 'SELECT') as receipts,
         has_function_privilege(
           'service_role',
           'public.staxis_resolve_authorization_scope(uuid,uuid,text,uuid,jsonb,integer)',
           'EXECUTE'
         ) as resolve_rpc,
         has_function_privilege(
           'service_role',
           'public.staxis_assert_authorization_scope_receipt(uuid,uuid)',
           'EXECUTE'
         ) as assert_rpc,
         has_function_privilege(
           'service_role',
           'public._staxis_authorization_scope_receipt_json(uuid)',
           'EXECUTE'
         ) as receipt_helper,
         has_function_privilege(
           'service_role',
           'public._staxis_nonlegacy_property_authorizations(uuid)',
           'EXECUTE'
         ) as entitlement_helper,
         has_function_privilege(
           'service_role',
           'public._staxis_current_primary_property_relationships()',
           'EXECUTE'
         ) as topology_helper,
         has_function_privilege(
           'service_role',
           'public.staxis_resolve_organization_property_topology(uuid,timestamp with time zone)',
           'EXECUTE'
         ) as topology_rpc,
         has_function_privilege(
           'authenticated',
           'public.staxis_resolve_organization_property_topology(uuid,timestamp with time zone)',
           'EXECUTE'
         ) as topology_rpc_browser`,
    );
    assert.deepEqual(privileges.rows[0], {
      states: false,
      bridges: false,
      receipts: false,
      resolve_rpc: true,
      assert_rpc: true,
      receipt_helper: false,
      entitlement_helper: false,
      topology_helper: false,
      topology_rpc: true,
      topology_rpc_browser: false,
    });
  });

  test('legacy and normalized accounts use one mode, and RLS matches the service DTO', async () => {
    const legacy = await listAccess('1e6ac41e-0000-4000-8000-000000000002');
    assert.equal(legacy.authorityMode, 'legacy');
    assert.deepEqual(legacy.propertyIds, [PID_L1]);
    assert.match(String(legacy.effectiveAccessHash), /^[0-9a-f]{64}$/);
    assert.deepEqual(
      (legacy.propertyStandings as Array<Record<string, unknown>>).map((standing) => ({
        propertyId: standing.propertyId,
        operationalRole: standing.operationalRole,
        seesFinancials: standing.seesFinancials,
        hotelMutationAllowed: standing.hotelMutationAllowed,
        portfolioIntelligenceRead: standing.portfolioIntelligenceRead,
      })),
      [{
        propertyId: PID_L1,
        operationalRole: 'owner',
        seesFinancials: true,
        hotelMutationAllowed: true,
        portfolioIntelligenceRead: false,
      }],
    );

    const normalized = await listAccess(ACCOUNT_MARIA);
    assert.equal(normalized.authorityMode, 'normalized');
    assert.deepEqual(normalized.legacyPropertyIds, []);
    assert.deepEqual(normalized.propertyIds, [PID_A1, PID_A2].sort());
    assert.deepEqual(
      (normalized.propertyStandings as Array<Record<string, unknown>>).map((standing) => ({
        propertyId: standing.propertyId,
        operationalRole: standing.operationalRole,
        seesFinancials: standing.seesFinancials,
        hotelMutationAllowed: standing.hotelMutationAllowed,
      })),
      [
        {
          propertyId: PID_A1,
          operationalRole: 'general_manager',
          seesFinancials: true,
          hotelMutationAllowed: true,
        },
        {
          propertyId: PID_A2,
          operationalRole: 'front_desk',
          seesFinancials: true,
          hotelMutationAllowed: false,
        },
      ].sort((left, right) => left.propertyId.localeCompare(right.propertyId)),
    );

    const companyOwner = await listAccess(ACCOUNT_ANA);
    assert.ok((companyOwner.propertyStandings as Array<Record<string, unknown>>).every((standing) => (
      standing.operationalRole === 'front_desk'
        && standing.seesFinancials === true
        && standing.hotelMutationAllowed === false
        && standing.portfolioIntelligenceRead === true
    )), 'a bare company owner gained hotel mutation authority');

    const finance = await listAccess(ACCOUNT_FIONA);
    assert.ok((finance.propertyStandings as Array<Record<string, unknown>>).every((standing) => (
      standing.operationalRole === 'front_desk'
        && standing.seesFinancials === true
        && standing.hotelMutationAllowed === false
        && standing.portfolioIntelligenceRead === true
    )), 'finance hat gained hotel-manager authority or lost its explicit read bit');
  });

  test('receipt separates full authorization from a subset and refuses cross-company IDs', async () => {
    const full = await resolveScope({ accountId: ACCOUNT_FIONA, organizationId: ORG_A });
    assert.equal(full.ok, true, JSON.stringify(full));
    const fullReceipt = asObject(full.receipt);
    assert.deepEqual(fullReceipt.authorizedPropertyIds, [PID_A1, PID_A2].sort());
    assert.deepEqual(fullReceipt.propertyIds, [PID_A1, PID_A2].sort());
    assert.equal(fullReceipt.authorizedPropertyCount, 2);
    assert.equal(fullReceipt.selectedPropertyCount, 2);
    assert.match(String(fullReceipt.authorizationHash), /^[0-9a-f]{64}$/);
    assert.match(String(fullReceipt.scopeHash), /^[0-9a-f]{64}$/);

    const subset = await resolveScope({
      accountId: ACCOUNT_FIONA,
      organizationId: ORG_A,
      selector: 'property_subset',
      propertyIds: [PID_A1],
    });
    assert.equal(subset.ok, true, JSON.stringify(subset));
    const subsetReceipt = asObject(subset.receipt);
    assert.deepEqual(subsetReceipt.authorizedPropertyIds, [PID_A1, PID_A2].sort());
    assert.deepEqual(subsetReceipt.propertyIds, [PID_A1]);
    assert.equal(subsetReceipt.authorizationHash, fullReceipt.authorizationHash);
    assert.notEqual(subsetReceipt.scopeHash, fullReceipt.scopeHash);

    const smuggled = await resolveScope({
      accountId: ACCOUNT_FIONA,
      organizationId: ORG_A,
      selector: 'property_subset',
      propertyIds: [PID_A1, PID_B1],
    });
    assert.deepEqual(smuggled, { ok: false, reason: 'unauthorized_scope' });
  });

  test('region selectors and catalog include cycle-safe descendants exactly', async () => {
    await pg.query(
      `insert into public.portfolios
         (id, organization_id, parent_id, name, portfolio_type, status)
       values ($1, $3, null, 'East', 'region', 'active'),
              ($2, $3, $1, 'East Urban', 'portfolio', 'active'),
              ($4, $3, null, 'Confidential Sibling', 'portfolio', 'active')`,
      [REGION, CHILD, ORG_A, OVERLAPPING_SIBLING],
    );
    const relationships = await pg.query<{ id: string; property_id: string }>(
      `select id, property_id from public.organization_property_relationships
       where organization_id = $1 and property_id = any($2::uuid[])
         and is_primary_grouping and ends_at is null`,
      [ORG_A, `{${PID_A1},${PID_A2}}`],
    );
    const byProperty = new Map(relationships.rows.map((row) => [row.property_id, row.id]));
    await pg.query(
      `insert into public.portfolio_properties
         (organization_id, portfolio_id, property_relationship_id, property_id)
       values ($1, $2, $3, $4), ($1, $5, $6, $7)`,
      [ORG_A, REGION, byProperty.get(PID_A1), PID_A1, CHILD, byProperty.get(PID_A2), PID_A2],
    );
    await pg.query(
      `insert into public.portfolio_properties
         (organization_id, portfolio_id, property_relationship_id, property_id)
       values ($1, $2, $3, $4)`,
      [ORG_A, OVERLAPPING_SIBLING, byProperty.get(PID_A1), PID_A1],
    );

    const result = await resolveScope({
      accountId: ACCOUNT_MARIA,
      organizationId: ORG_A,
      selector: 'portfolio',
      portfolioId: REGION,
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    const receipt = asObject(result.receipt);
    assert.deepEqual(receipt.propertyIds, [PID_A1, PID_A2].sort());
    const catalog = receipt.portfolioCatalog as Array<Record<string, unknown>>;
    const region = catalog.find((entry) => entry.portfolioId === REGION);
    const child = catalog.find((entry) => entry.portfolioId === CHILD);
    assert.deepEqual(region?.directPropertyIds, [PID_A1]);
    assert.deepEqual(region?.propertyIds, [PID_A1, PID_A2].sort());
    assert.deepEqual(child?.propertyIds, [PID_A2]);
  });

  test('a normalized region grant reaches its exact descendant hotel set until revoked', async () => {
    await pg.query(
      "insert into auth.users (id, email) values ($1, 'region-manager@example.test')",
      [GRANT_USER],
    );
    await pg.query(
      `insert into public.accounts
         (id, username, password_hash, display_name, role, property_access, data_user_id)
       values ($1, 'region-manager', 'x', 'Region Manager', 'general_manager', '{}', $2)`,
      [GRANT_ACCOUNT, GRANT_USER],
    );
    const membership = await pg.query<{ id: string }>(
      `insert into public.organization_memberships
         (organization_id, account_id, job_category, status)
       values ($1, $2, 'vp', 'active') returning id`,
      [ORG_A, GRANT_ACCOUNT],
    );
    const grant = await pg.query<{ id: string }>(
      `insert into public.organization_access_grants
         (organization_id, membership_id, access_profile, scope_type,
          portfolio_id, status, source)
       values ($1, $2, 'portfolio_manager', 'portfolio', $3, 'active', 'manual')
       returning id`,
      [ORG_A, membership.rows[0].id, REGION],
    );

    const grantStanding = await listAccess(GRANT_ACCOUNT);
    assert.ok(
      (grantStanding.propertyStandings as Array<Record<string, unknown>>).every((standing) => (
        standing.operationalRole === 'front_desk'
          && standing.seesFinancials === false
          && standing.hotelMutationAllowed === false
          && standing.portfolioIntelligenceRead === true
      )),
      'portfolio_manager grant silently inherited the account global GM mutation role',
    );

    const result = await resolveScope({ accountId: GRANT_ACCOUNT, organizationId: ORG_A });
    assert.equal(result.ok, true, JSON.stringify(result));
    const receipt = asObject(result.receipt);
    assert.deepEqual(receipt.authorizedPropertyIds, [PID_A1, PID_A2].sort());
    assert.deepEqual(
      (receipt.portfolioCatalog as Array<Record<string, unknown>>)
        .map((entry) => entry.portfolioId).sort(),
      [REGION, CHILD].sort(),
      'a portfolio grant disclosed a sibling grouping that shares a hotel',
    );
    const provenance = asObject(receipt.provenance);
    assert.ok((provenance.entitlements as Array<Record<string, unknown>>)
      .every((entry) => entry.accessProfile === 'portfolio_manager'));

    assert.deepEqual(
      await resolveScope({
        accountId: GRANT_ACCOUNT,
        organizationId: ORG_A,
        selector: 'portfolio',
        portfolioId: OVERLAPPING_SIBLING,
      }),
      { ok: false, reason: 'unauthorized_scope' },
    );

    await pg.query(
      `update public.organization_access_grants
          set status = 'revoked', revoked_at = now(),
              revocation_reason = 'security lifecycle test', version = version + 1
        where id = $1`,
      [grant.rows[0].id],
    );
    const revoked = await listAccess(GRANT_ACCOUNT);
    assert.deepEqual(revoked.propertyIds, []);
    assert.deepEqual(revoked.propertyStandings, []);
  });

  test('cutover bridges preserve only unmatched legacy access; later array edits cannot widen it', async () => {
    await pg.query(
      "insert into auth.users (id, email) values ($1, 'bridge@example.test')",
      [BRIDGE_USER],
    );
    await pg.query(
      `insert into public.accounts
         (id, username, password_hash, display_name, role, property_access, data_user_id)
       values ($1, 'bridge-user', 'x', 'Bridge User', 'front_desk', $2::uuid[], $3)`,
      [BRIDGE_ACCOUNT, `{${PID_L1}}`, BRIDGE_USER],
    );
    const hat = await pg.query<{ membership_id: string }>(
      `select public.staxis_set_membership_hat(
         $1, $2, $3, 'property', 'front_desk', $4::jsonb, null
       ) as membership_id`,
      [ACCOUNT_ADMIN, ORG_A, BRIDGE_ACCOUNT, JSON.stringify([PID_A1])],
    );
    assert.deepEqual((await listAccess(BRIDGE_ACCOUNT)).propertyIds, [PID_L1, PID_A1].sort());

    await pg.query(
      'update public.accounts set property_access = $2::uuid[] where id = $1',
      [BRIDGE_ACCOUNT, `{${PID_L1},${PID_B1}}`],
    );
    assert.deepEqual(
      (await listAccess(BRIDGE_ACCOUNT)).propertyIds,
      [PID_L1, PID_A1].sort(),
      'normalized mode silently unioned a later legacy array edit',
    );

    await pg.query(
      'select public.staxis_end_membership_hat($1, $2)',
      [ACCOUNT_ADMIN, hat.rows[0].membership_id],
    );
    assert.deepEqual((await listAccess(BRIDGE_ACCOUNT)).propertyIds, [PID_L1]);
    const reaches = await pg.query<{ a: boolean; b: boolean; legacy: boolean }>(
      `select public.staxis_account_reaches_property($1, $2) as a,
              public.staxis_account_reaches_property($1, $3) as b,
              public.staxis_account_reaches_property($1, $4) as legacy`,
      [BRIDGE_USER, PID_A1, PID_B1, PID_L1],
    );
    assert.deepEqual(reaches.rows[0], { a: false, b: false, legacy: true });
  });

  test('a scheduled grant cuts over safely and activates without a later write', async () => {
    await pg.query(
      "insert into auth.users (id, email) values ($1, 'scheduled@example.test')",
      [SCHEDULED_USER],
    );
    await pg.query(
      `insert into public.accounts
         (id, username, password_hash, display_name, role, property_access, data_user_id)
       values ($1, 'scheduled-user', 'x', 'Scheduled User', 'front_desk', $2::uuid[], $3)`,
      [SCHEDULED_ACCOUNT, `{${PID_L1}}`, SCHEDULED_USER],
    );
    const membership = await pg.query<{ id: string }>(
      `insert into public.organization_memberships
       (organization_id, account_id, job_category, status)
       values ($1, $2, 'vp', 'active') returning id`,
      [ORG_A, SCHEDULED_ACCOUNT],
    );
    const relationship = await pg.query<{ id: string }>(
      `select id from public.organization_property_relationships
       where organization_id = $1 and property_id = $2
         and is_primary_grouping and relationship_type in ('operator', 'owner')
         and ends_at is null`,
      [ORG_A, PID_A1],
    );
    await pg.query(
      `insert into public.organization_access_grants
         (organization_id, membership_id, access_profile, scope_type,
          property_relationship_id, property_id, status, source, starts_at)
       values ($1, $2, 'property_manager', 'property', $3, $4,
               'active', 'manual', clock_timestamp() + interval '400 milliseconds')`,
      [ORG_A, membership.rows[0].id, relationship.rows[0].id, PID_A1],
    );

    const beforeStart = await listAccess(SCHEDULED_ACCOUNT);
    assert.equal(beforeStart.authorityMode, 'normalized');
    assert.deepEqual(beforeStart.propertyIds, [PID_L1]);

    await delay(600);
    assert.deepEqual(
      (await listAccess(SCHEDULED_ACCOUNT)).propertyIds,
      [PID_L1, PID_A1].sort(),
      'scheduled entitlement required a second database write to become active',
    );
  });

  test('shadow rollout promotion is idempotent and preserves unmatched legacy access', async () => {
    await pg.query(
      "insert into auth.users (id, email) values ($1, 'shadow@example.test')",
      [SHADOW_USER],
    );
    await pg.query(
      `insert into public.accounts
         (id, username, password_hash, display_name, role, property_access, data_user_id)
       values ($1, 'shadow-user', 'x', 'Shadow User', 'front_desk', $2::uuid[], $3)`,
      [SHADOW_ACCOUNT, `{${PID_L1}}`, SHADOW_USER],
    );
    await pg.query(
      `update public.account_authorization_state
       set authority_mode = 'shadow'
       where account_id = $1`,
      [SHADOW_ACCOUNT],
    );
    await pg.query(
      `select public.staxis_set_membership_hat(
         $1, $2, $3, 'property', 'front_desk', $4::jsonb, null
       )`,
      [ACCOUNT_ADMIN, ORG_A, SHADOW_ACCOUNT, JSON.stringify([PID_A1])],
    );
    const shadow = await listAccess(SHADOW_ACCOUNT);
    assert.equal(shadow.authorityMode, 'shadow');
    assert.deepEqual(shadow.propertyIds, [PID_L1]);

    const promoted = await pg.query<{ result: unknown }>(
      `select public.staxis_promote_shadow_authorization($1, $2) as result`,
      [SHADOW_ACCOUNT, 'portfolio intelligence rollout'],
    );
    assert.equal(asObject(promoted.rows[0].result).status, 'promoted');
    const normalized = await listAccess(SHADOW_ACCOUNT);
    assert.equal(normalized.authorityMode, 'normalized');
    assert.deepEqual(normalized.propertyIds, [PID_L1, PID_A1].sort());

    const retried = await pg.query<{ result: unknown }>(
      `select public.staxis_promote_shadow_authorization($1, $2) as result`,
      [SHADOW_ACCOUNT, 'retry'],
    );
    assert.equal(asObject(retried.rows[0].result).status, 'already_normalized');

    await pg.query(
      'update public.accounts set property_access = $2::uuid[] where id = $1',
      [SHADOW_ACCOUNT, `{${PID_L1},${PID_B1}}`],
    );
    assert.deepEqual(
      (await listAccess(SHADOW_ACCOUNT)).propertyIds,
      [PID_L1, PID_A1].sort(),
    );
  });

  test('brand and vendor organizations cannot enter management-company portfolio mode', async () => {
    await pg.query(
      `update public.organizations set organization_type = 'vendor' where id = $1`,
      [ORG_B],
    );
    assert.deepEqual(
      await resolveScope({ accountId: ACCOUNT_BO, organizationId: ORG_B }),
      { ok: false, reason: 'no_company_job' },
    );
    await pg.query(
      `update public.organizations set organization_type = 'management_company' where id = $1`,
      [ORG_B],
    );
  });

  test('a one-hotel GM job does not make an unrelated company portfolio ambiguous', async () => {
    const gm = await pg.query<{ membership_id: string }>(
      `select public.staxis_set_membership_hat(
         $1, $2, $3, 'property', 'general_manager', $4::jsonb, null
       ) as membership_id`,
      [ACCOUNT_ADMIN, ORG_B, ACCOUNT_MARIA, JSON.stringify([PID_B1])],
    );
    const resolved = await resolveScope({ accountId: ACCOUNT_MARIA });
    assert.equal(resolved.ok, true, JSON.stringify(resolved));
    assert.equal(asObject(resolved.receipt).organizationId, ORG_A);
    assert.deepEqual(
      await resolveScope({ accountId: ACCOUNT_MARIA, organizationId: ORG_B }),
      { ok: false, reason: 'no_company_job' },
    );
    await pg.query(
      'select public.staxis_end_membership_hat($1, $2)',
      [ACCOUNT_ADMIN, gm.rows[0].membership_id],
    );
  });

  test('brand/vendor relationships cannot mint coverage and role changes invalidate receipts', async () => {
    await pg.query(
      `insert into public.organization_property_relationships
         (organization_id, property_id, relationship_type, is_primary_grouping)
       values ($1, $2, 'vendor', false)`,
      [ORG_B, PID_A1],
    );
    await assert.rejects(
      pg.query(
        `select public.staxis_set_membership_hat(
           $1, $2, $3, 'property', 'general_manager', $4::jsonb, null
         )`,
        [ACCOUNT_ADMIN, ORG_B, ACCOUNT_GIL, JSON.stringify([PID_A1])],
      ),
      /not governed by this company/i,
    );

    const issued = await resolveScope({ accountId: ACCOUNT_MARIA, organizationId: ORG_A });
    assert.equal(issued.ok, true, JSON.stringify(issued));
    const receipt = asObject(issued.receipt);
    const vpMembershipId = seed.hats.get(`${ACCOUNT_MARIA}:company:vp`);
    assert.ok(vpMembershipId);
    await pg.query('select public.staxis_end_membership_hat($1, $2)', [ACCOUNT_ADMIN, vpMembershipId]);
    const asserted = await pg.query<{ result: unknown }>(
      'select public.staxis_assert_authorization_scope_receipt($1, $2) as result',
      [receipt.id, ACCOUNT_MARIA],
    );
    assert.deepEqual(asObject(asserted.rows[0].result), {
      ok: false,
      reason: 'revoked_or_changed',
    });

    await pg.query(
      `select public.staxis_set_membership_hat($1, $2, $3, 'company', 'vp', null, null),
              public.staxis_set_membership_hat($1, $4, $3, 'company', 'vp', null, null)`,
      [ACCOUNT_ADMIN, ORG_A, ACCOUNT_MARIA, ORG_B],
    );
    assert.deepEqual(
      await resolveScope({ accountId: ACCOUNT_MARIA }),
      { ok: false, reason: 'ambiguous_company' },
    );
  });

  test('direct writes reject overlapping primary windows while adjacent windows remain legal', async () => {
    await seed.attachPropertyToOrganization(
      pg,
      ORG_A,
      WINDOW_GUARD_PROPERTY,
      'Primary Window Guard Hotel',
    );
    const current = await pg.query<{ id: string }>(
      `select id
       from public.organization_property_relationships
       where organization_id = $1
         and property_id = $2
         and is_primary_grouping is true
         and starts_at <= clock_timestamp()
         and (ends_at is null or ends_at > clock_timestamp())`,
      [ORG_A, WINDOW_GUARD_PROPERTY],
    );
    assert.equal(current.rows.length, 1);

    const ending = await pg.query<{ ends_at: string }>(
      `update public.organization_property_relationships
          set ends_at = clock_timestamp() + interval '1 day'
        where id = $1
        returning ends_at::text`,
      [current.rows[0].id],
    );
    const boundary = ending.rows[0].ends_at;

    await assert.rejects(
      pg.query(
        `insert into public.organization_property_relationships
           (organization_id, property_id, relationship_type,
            is_primary_grouping, starts_at, ends_at)
         values ($1, $2, 'operator', true, clock_timestamp(), null)`,
        [ORG_B, WINDOW_GUARD_PROPERTY],
      ),
      /window overlaps another relationship/i,
    );

    const adjacent = await pg.query<{ id: string }>(
      `insert into public.organization_property_relationships
         (organization_id, property_id, relationship_type,
          is_primary_grouping, starts_at, ends_at)
       values ($1, $2, 'operator', true, $3::timestamptz, null)
       returning id`,
      [ORG_B, WINDOW_GUARD_PROPERTY, boundary],
    );
    assert.equal(adjacent.rows.length, 1, 'an exactly adjacent future window was rejected');

    await assert.rejects(
      pg.query(
        `update public.organization_property_relationships
            set starts_at = clock_timestamp()
          where id = $1`,
        [adjacent.rows[0].id],
      ),
      /window overlaps another relationship/i,
    );

    await pg.query(
      'delete from public.organization_property_relationships where id = $1',
      [adjacent.rows[0].id],
    );
    await pg.query(
      `select public.staxis_set_primary_property_organization(
         $1, $2, $3, 'operator'
       )`,
      [ACCOUNT_ADMIN, WINDOW_GUARD_PROPERTY, null],
    );
    const repaired = await pg.query<{ active_count: number }>(
      `select count(*)::integer as active_count
       from public._staxis_current_primary_property_relationships()
       where property_id = $1`,
      [WINDOW_GUARD_PROPERTY],
    );
    assert.equal(repaired.rows[0].active_count, 1);
  });

  test('dual-current topology denies both tenants, receipts, and RLS until repaired', async () => {
    const issued = await resolveScope({ accountId: ACCOUNT_ANA, organizationId: ORG_A });
    assert.equal(issued.ok, true, JSON.stringify(issued));
    const staleReceipt = asObject(issued.receipt);

    const oldPrimary = await pg.query<{ id: string }>(
      `select id
       from public.organization_property_relationships
       where organization_id = $1
         and property_id = $2
         and is_primary_grouping is true
         and starts_at <= clock_timestamp()
         and (ends_at is null or ends_at > clock_timestamp())`,
      [ORG_A, PID_A1],
    );
    assert.equal(oldPrimary.rows.length, 1);
    await pg.query(
      `update public.organization_property_relationships
          set ends_at = clock_timestamp() + interval '1 day'
        where id = $1`,
      [oldPrimary.rows[0].id],
    );

    let corruptRelationshipId: string | undefined;
    await pg.query(
      `alter table public.organization_property_relationships
         disable trigger trg_organization_property_relationships_primary_window_guard`,
    );
    try {
      const corrupt = await pg.query<{ id: string }>(
        `insert into public.organization_property_relationships
           (organization_id, property_id, relationship_type,
            is_primary_grouping, starts_at, ends_at)
         values ($1, $2, 'operator', true, clock_timestamp(), null)
         returning id`,
        [ORG_B, PID_A1],
      );
      corruptRelationshipId = corrupt.rows[0].id;
    } finally {
      await pg.query(
        `alter table public.organization_property_relationships
           enable trigger trg_organization_property_relationships_primary_window_guard`,
      );
    }
    assert.ok(corruptRelationshipId);

    assert.deepEqual((await listAccess(ACCOUNT_ANA)).propertyIds, [PID_A2]);
    assert.deepEqual((await listAccess(ACCOUNT_BO)).propertyIds, [PID_B1]);
    assert.deepEqual(
      await resolveScope({ accountId: ACCOUNT_ANA, organizationId: ORG_A }),
      { ok: false, reason: 'store_unavailable' },
    );
    assert.deepEqual(
      await resolveScope({ accountId: ACCOUNT_BO, organizationId: ORG_B }),
      { ok: false, reason: 'store_unavailable' },
    );
    for (const organizationId of [ORG_A, ORG_B]) {
      await assert.rejects(
        pg.query(
          `select *
           from public.staxis_portfolio_property_knowledge(
             $1, $2::uuid[], clock_timestamp(), 1001
           )`,
          [organizationId, `{${PID_A1}}`],
        ),
        /scope is not current for this organization/i,
      );
    }

    const gates = await pg.query<{
      maria_reaches: boolean;
      gil_reaches: boolean;
      admin_reaches: boolean;
    }>(
      `select
         public.staxis_account_reaches_property($1, $4) as maria_reaches,
         public.staxis_account_reaches_property($2, $4) as gil_reaches,
         public.staxis_account_reaches_property($3, $4) as admin_reaches`,
      [UID_MARIA, UID_GIL, UID_ADMIN, PID_A1],
    );
    assert.deepEqual(gates.rows[0], {
      maria_reaches: false,
      gil_reaches: false,
      admin_reaches: true,
    });
    await pg.query(
      `select set_config('request.jwt.claim.sub', $1, false)`,
      [UID_MARIA],
    );
    const deniedMutation = await pg.query<{ allowed: boolean }>(
      `select public.staxis_user_can_mutate_property($1) as allowed`,
      [PID_A1],
    );
    assert.equal(deniedMutation.rows[0].allowed, false);
    await pg.query(`select set_config('request.jwt.claim.sub', '', false)`);

    const stale = await pg.query<{ result: unknown }>(
      'select public.staxis_assert_authorization_scope_receipt($1, $2) as result',
      [staleReceipt.id, ACCOUNT_ANA],
    );
    assert.deepEqual(asObject(stale.rows[0].result), {
      ok: false,
      reason: 'scope_changed',
    });

    // Ending either side is an allowed repair. The surviving company regains
    // authority immediately; the admin transfer RPC can then move it back.
    await pg.query(
      `update public.organization_property_relationships
          set ends_at = clock_timestamp()
        where id = $1`,
      [oldPrimary.rows[0].id],
    );
    assert.deepEqual(
      (await listAccess(ACCOUNT_BO)).propertyIds,
      [PID_A1, PID_B1].sort(),
    );
    const recoveredB = await resolveScope({ accountId: ACCOUNT_BO, organizationId: ORG_B });
    assert.equal(recoveredB.ok, true, JSON.stringify(recoveredB));

    await pg.query(
      `select public.staxis_set_primary_property_organization(
         $1, $2, $3, 'operator'
       )`,
      [ACCOUNT_ADMIN, PID_A1, ORG_A],
    );
    assert.deepEqual(
      (await listAccess(ACCOUNT_ANA)).propertyIds,
      [PID_A1, PID_A2].sort(),
    );
    assert.deepEqual((await listAccess(ACCOUNT_BO)).propertyIds, [PID_B1]);
    const restoredGate = await pg.query<{ reaches: boolean }>(
      `select public.staxis_account_reaches_property($1, $2) as reaches`,
      [UID_MARIA, PID_A1],
    );
    assert.deepEqual(restoredGate.rows[0], { reaches: true });
    await pg.query(
      `select set_config('request.jwt.claim.sub', $1, false)`,
      [UID_MARIA],
    );
    const restoredMutation = await pg.query<{ allowed: boolean }>(
      `select public.staxis_user_can_mutate_property($1) as allowed`,
      [PID_A1],
    );
    assert.equal(restoredMutation.rows[0].allowed, true);
    await pg.query(`select set_config('request.jwt.claim.sub', '', false)`);
  });

  test('a hotel transfer invalidates the old-company receipt immediately', async () => {
    const issued = await resolveScope({ accountId: ACCOUNT_FIONA, organizationId: ORG_A });
    assert.equal(issued.ok, true, JSON.stringify(issued));
    const receipt = asObject(issued.receipt);
    assert.deepEqual(receipt.authorizedPropertyIds, [PID_A1, PID_A2].sort());

    await seed.attachPropertyToOrganization(pg, ORG_B, PID_A2, 'Lufkin Inn');

    const asserted = await pg.query<{ result: unknown }>(
      'select public.staxis_assert_authorization_scope_receipt($1, $2) as result',
      [receipt.id, ACCOUNT_FIONA],
    );
    assert.deepEqual(
      asObject(asserted.rows[0].result),
      { ok: false, reason: 'scope_changed' },
    );
    assert.deepEqual((await listAccess(ACCOUNT_FIONA)).propertyIds, [PID_A1]);

    const refreshed = await resolveScope({ accountId: ACCOUNT_FIONA, organizationId: ORG_A });
    assert.equal(refreshed.ok, true, JSON.stringify(refreshed));
    assert.deepEqual(asObject(refreshed.receipt).authorizedPropertyIds, [PID_A1]);
  });

  test('a cutover bridge never follows a transferred hotel into its acquiring company', async () => {
    await seed.attachPropertyToOrganization(
      pg,
      ORG_A,
      TRANSFER_BRIDGE_PROPERTY,
      'Bridge Transfer Hotel',
    );
    await pg.query(
      "insert into auth.users (id, email) values ($1, 'bridge-transfer@example.test')",
      [TRANSFER_BRIDGE_USER],
    );
    await pg.query(
      `insert into public.accounts
         (id, username, password_hash, display_name, role, property_access, data_user_id)
       values ($1, 'bridge-transfer', 'x', 'Bridge Transfer', 'front_desk', $2::uuid[], $3)`,
      [TRANSFER_BRIDGE_ACCOUNT, `{${TRANSFER_BRIDGE_PROPERTY}}`, TRANSFER_BRIDGE_USER],
    );
    await pg.query(
      `select public.staxis_set_membership_hat(
         $1, $2, $3, 'property', 'front_desk', $4::jsonb, null
       )`,
      [ACCOUNT_ADMIN, ORG_A, TRANSFER_BRIDGE_ACCOUNT, JSON.stringify([PID_A1])],
    );

    const before = await listAccess(TRANSFER_BRIDGE_ACCOUNT);
    assert.deepEqual(before.propertyIds, [PID_A1, TRANSFER_BRIDGE_PROPERTY].sort());
    const beforeStanding = (before.propertyStandings as Array<Record<string, unknown>>)
      .find((standing) => standing.propertyId === TRANSFER_BRIDGE_PROPERTY);
    assert.equal(
      ((beforeStanding?.entitlements as Array<Record<string, unknown>>)?.[0])?.organizationId,
      ORG_A,
    );

    await seed.attachPropertyToOrganization(
      pg,
      ORG_B,
      TRANSFER_BRIDGE_PROPERTY,
      'Bridge Transfer Hotel',
    );

    assert.deepEqual(
      (await listAccess(TRANSFER_BRIDGE_ACCOUNT)).propertyIds,
      [PID_A1],
      'the cutover bridge followed the hotel into the acquiring company',
    );
    const bridge = await pg.query<{
      status: string;
      cutover_organization_id: string | null;
    }>(
      `select status, cutover_organization_id
       from public.account_property_authorization_bridges
       where account_id = $1 and property_id = $2`,
      [TRANSFER_BRIDGE_ACCOUNT, TRANSFER_BRIDGE_PROPERTY],
    );
    assert.deepEqual(bridge.rows[0], {
      status: 'retired',
      cutover_organization_id: ORG_A,
    });
    assert.deepEqual(
      await resolveScope({
        accountId: TRANSFER_BRIDGE_ACCOUNT,
        organizationId: ORG_B,
      }),
      { ok: false, reason: 'no_company_job' },
      'a stale bridge exposed the acquiring company portfolio/knowledge scope',
    );
  });
});
