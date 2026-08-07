import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { PGlite } from '@electric-sql/pglite';

import { applyMigrationsToPgliteThrough } from '../../../tests/fixtures/pglite-migrate';
import {
  ACCOUNT_ANA,
  ACCOUNT_FRANK,
  ACCOUNT_WANDA,
  ORG_A,
  ORG_B,
  PID_A1,
  PID_A2,
  PID_L1,
  UID_ANA,
  UID_FRANK,
  UID_WANDA,
  seedTwoCompanies,
} from '../../../tests/fixtures/pglite-two-company-seed';

const ACCOUNT_LEGACY_PARTIAL = 'a4222000-0000-4000-8000-000000000001';
const ACCOUNT_SHADOW_PARTIAL = 'a4222000-0000-4000-8000-000000000002';
const ACCOUNT_MISSING_ACCESS = 'a4222000-0000-4000-8000-000000000003';
const ACCOUNT_MISSING_AUTH = 'a4222000-0000-4000-8000-000000000004';
const UID_LEGACY_PARTIAL = 'a4223000-0000-4000-8000-000000000001';
const UID_SHADOW_PARTIAL = 'a4223000-0000-4000-8000-000000000002';
const UID_MISSING_ACCESS = 'a4223000-0000-4000-8000-000000000003';
const UID_MISSING_AUTH = 'a4223000-0000-4000-8000-000000000004';
const STAFF_TARGET = 'a4224000-0000-4000-8000-000000000001';

let inviteSequence = 0;

function asObject(value: unknown): Record<string, unknown> {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  assert.ok(parsed && typeof parsed === 'object' && !Array.isArray(parsed));
  return parsed as Record<string, unknown>;
}

async function insertAccount(
  pg: PGlite,
  accountId: string,
  username: string,
  propertyIds: string[],
  dataUserId: string,
): Promise<void> {
  await pg.query(
    `insert into public.accounts
       (id, username, password_hash, display_name, role, property_access, data_user_id)
     values ($1, $2, 'x', $3, 'front_desk', $4::uuid[], $5)`,
    [accountId, username, username, `{${propertyIds.join(',')}}`, dataUserId],
  );
}

function assertNamesAHotel(propertyIds: string[]): string[] {
  if (propertyIds.length === 0) {
    throw new Error('createInvite: pass null for all hotels, never an empty list');
  }
  return propertyIds;
}

async function createInvite(
  pg: PGlite,
  actorAccountId: string,
  actorAuthUserId: string,
  hotelId: string,
  role: string,
  organizationId: string | null,
  membershipScope: string | null,
  coveredPropertyIds: string[] | null,
): Promise<string> {
  inviteSequence += 1;
  const tokenHash = inviteSequence.toString(16).padStart(64, '0');
  const result = await pg.query<{ value: unknown }>(
    `select public.staxis_create_account_invite_guarded(
       $1::uuid,$2::uuid,$3::uuid,$4,$5,$6,
       clock_timestamp()+interval '7 days',$7::uuid,$8,$9::uuid[],$10
     ) as value`,
    [
      actorAccountId,
      actorAuthUserId,
      hotelId,
      `stage-a-invite-${inviteSequence}@example.test`,
      role,
      tokenHash,
      organizationId,
      membershipScope,
      // NULL and an empty list are different promises and only one of them is
      // legal: NULL means every hotel the company operates, an empty list names
      // nothing and is refused by the guarded RPC and by 0468's check. Render
      // the caller's intent, and refuse to render the illegal one at all.
      coveredPropertyIds === null
        ? null
        : `{${assertNamesAHotel(coveredPropertyIds).join(',')}}`,
      `stage-a-invite-${inviteSequence}`,
    ],
  );
  const value = asObject(result.rows[0]?.value);
  assert.equal(value.ok, true, JSON.stringify(value));
  return String(value.inviteId);
}

async function acceptInvite(
  pg: PGlite,
  inviteId: string,
  accountId: string,
): Promise<void> {
  await pg.query(
    `update public.account_invites
        set accepted_at = clock_timestamp(), accepted_by = $2
      where id = $1`,
    [inviteId, accountId],
  );
}

describe('Stage A invitation promise and invariant assertions — real SQL', () => {
  let pg: PGlite;
  let companies: Awaited<ReturnType<typeof seedTwoCompanies>>;

  before(async () => {
    const migrated = await applyMigrationsToPgliteThrough('0425');
    pg = migrated.pg;
    companies = await seedTwoCompanies(pg);

    await pg.query(
      `insert into auth.users (id, email)
       values ($1, 'stage-a-legacy-partial@example.test'),
              ($2, 'stage-a-shadow-partial@example.test'),
              ($3, 'stage-a-missing-access@example.test')`,
      [UID_LEGACY_PARTIAL, UID_SHADOW_PARTIAL, UID_MISSING_ACCESS],
    );
    await insertAccount(pg, ACCOUNT_LEGACY_PARTIAL, 'stage-a-legacy-partial', [PID_A1], UID_LEGACY_PARTIAL);
    await insertAccount(pg, ACCOUNT_SHADOW_PARTIAL, 'stage-a-shadow-partial', [PID_A1], UID_SHADOW_PARTIAL);
    await insertAccount(pg, ACCOUNT_MISSING_ACCESS, 'stage-a-missing-access', [], UID_MISSING_ACCESS);
    await pg.query(
      `update public.account_authorization_state
          set authority_mode = 'shadow', cutover_at = null
        where account_id = $1`,
      [ACCOUNT_SHADOW_PARTIAL],
    );

    // Plant one accepted account with a dangling Auth identity, matching the
    // preflight fixture's legacy-data shape while retaining the real account
    // state and invite path.
    await pg.query(`alter table public.accounts drop constraint accounts_data_user_id_fkey`);
    await pg.query(`alter table public.account_authorization_state
      disable trigger trg_account_authorization_state_notification`);
    try {
      await insertAccount(pg, ACCOUNT_MISSING_AUTH, 'stage-a-missing-auth', [], UID_MISSING_AUTH);
    } finally {
      await pg.query(`alter table public.account_authorization_state
        enable trigger trg_account_authorization_state_notification`);
    }
    await pg.query(`alter table public.accounts add constraint accounts_data_user_id_fkey
      foreign key (data_user_id) references auth.users(id) on delete cascade not valid`);

    await pg.query(
      `insert into public.staff (id, property_id, name, department, language)
       values ($1, $2, 'Stage A Target Staff', 'front_desk', 'en')`,
      [STAFF_TARGET, PID_A1],
    );
  });

  after(async () => {
    await pg?.close();
  });

  test('company, property, legacy, and shadow promises expose complete coverage facts without granting access', async () => {
    const companyInvite = await createInvite(
      pg, ACCOUNT_ANA, UID_ANA, PID_A1, 'owner', ORG_A, 'company', null,
    );
    await acceptInvite(pg, companyInvite, ACCOUNT_ANA);
    const company = asObject((await pg.query<{ value: unknown }>(
      `select public.staxis_invite_access_shadow($1::uuid) as value`,
      [companyInvite],
    )).rows[0]?.value);
    assert.equal(company.accepted, true);
    assert.equal(company.topologyValid, true);
    assert.equal(company.accessEstablished, true);
    assert.deepEqual(company.promisedPropertyIds, [PID_A1, PID_A2]);
    assert.deepEqual(company.currentPropertyIds, [PID_A1, PID_A2]);
    assert.deepEqual(company.missingPropertyIds, []);
    assert.deepEqual(company.extraPropertyIds, []);

    const normalizedPartialInvite = await createInvite(
      pg, ACCOUNT_ANA, UID_ANA, PID_A1, 'front_desk', ORG_A, 'property', [PID_A1, PID_A2],
    );
    await acceptInvite(pg, normalizedPartialInvite, ACCOUNT_FRANK);
    const normalizedPartial = asObject((await pg.query<{ value: unknown }>(
      `select public.staxis_invite_access_shadow($1::uuid) as value`,
      [normalizedPartialInvite],
    )).rows[0]?.value);
    assert.equal(normalizedPartial.authorityMode, 'normalized');
    assert.equal(normalizedPartial.topologyValid, true);
    assert.equal(normalizedPartial.accessEstablished, false);
    assert.deepEqual(normalizedPartial.promisedPropertyIds, [PID_A1, PID_A2]);
    assert.deepEqual(normalizedPartial.currentPropertyIds, [PID_A1]);
    assert.deepEqual(normalizedPartial.missingPropertyIds, [PID_A2]);

    const legacyPartialInvite = await createInvite(
      pg, ACCOUNT_ANA, UID_ANA, PID_A1, 'front_desk', ORG_A, 'property', [PID_A1, PID_A2],
    );
    await acceptInvite(pg, legacyPartialInvite, ACCOUNT_LEGACY_PARTIAL);
    const legacyPartial = asObject((await pg.query<{ value: unknown }>(
      `select public.staxis_invite_access_shadow($1::uuid) as value`,
      [legacyPartialInvite],
    )).rows[0]?.value);
    assert.equal(legacyPartial.authorityMode, 'legacy');
    assert.deepEqual(legacyPartial.currentPropertyIds, [PID_A1]);
    assert.deepEqual(legacyPartial.missingPropertyIds, [PID_A2]);

    const shadowPartialInvite = await createInvite(
      pg, ACCOUNT_ANA, UID_ANA, PID_A1, 'front_desk', ORG_A, 'property', [PID_A1, PID_A2],
    );
    await acceptInvite(pg, shadowPartialInvite, ACCOUNT_SHADOW_PARTIAL);
    const shadowPartial = asObject((await pg.query<{ value: unknown }>(
      `select public.staxis_invite_access_shadow($1::uuid) as value`,
      [shadowPartialInvite],
    )).rows[0]?.value);
    assert.equal(shadowPartial.authorityMode, 'shadow');
    assert.deepEqual(shadowPartial.currentPropertyIds, [PID_A1]);
    assert.deepEqual(shadowPartial.missingPropertyIds, [PID_A2]);

    // A pending invite exposes the same persisted promise, but never treats a
    // claim/reservation as current access.
    const pendingInvite = await createInvite(
      pg, ACCOUNT_ANA, UID_ANA, PID_A1, 'front_desk', ORG_A, 'property', [PID_A1, PID_A2],
    );
    const pending = asObject((await pg.query<{ value: unknown }>(
      `select public.staxis_invite_access_shadow($1::uuid) as value`,
      [pendingInvite],
    )).rows[0]?.value);
    assert.equal(pending.accepted, false);
    assert.equal(pending.claimIsAccess, false);
    assert.equal(pending.accessEstablished, false);
    assert.deepEqual(pending.promisedPropertyIds, [PID_A1, PID_A2]);
  });

  test('stale, cross-company, suspended, missing-access, and roster promises fail closed', async () => {
    const rosterInvite = await createInvite(
      pg, ACCOUNT_ANA, UID_ANA, PID_A1, 'front_desk', ORG_A, 'property', [PID_A1],
    );
    await pg.query(
      `update public.account_invites
          set target_staff_id = $2
        where id = $1`,
      [rosterInvite, STAFF_TARGET],
    );
    await acceptInvite(pg, rosterInvite, ACCOUNT_FRANK);

    // The account has a real company context, but only in another company.
    // A legacy/shadow array that names ORG_A's hotel must not be treated as
    // current authority for an ORG_A invitation.
    await pg.query(
      `alter table public.organization_memberships
         disable trigger trg_organization_memberships_00_authorization_refresh`,
    );
    try {
      await pg.query(
        `insert into public.organization_memberships
           (organization_id, account_id, job_category, job_title, status,
            membership_scope, staxis_role, covered_property_ids)
         values ($1, $2, 'executive', 'Other Company Hat', 'active',
                 'company', 'vp', null)`,
        [ORG_B, ACCOUNT_SHADOW_PARTIAL],
      );
    } finally {
      await pg.query(
        `alter table public.organization_memberships
           enable trigger trg_organization_memberships_00_authorization_refresh`,
      );
    }
    const crossCompanyInvite = await createInvite(
      pg, ACCOUNT_ANA, UID_ANA, PID_A1, 'front_desk', ORG_A, 'property', [PID_A1],
    );
    await acceptInvite(pg, crossCompanyInvite, ACCOUNT_SHADOW_PARTIAL);
    const crossCompany = asObject((await pg.query<{ value: unknown }>(
      `select public.staxis_invite_access_shadow($1::uuid) as value`,
      [crossCompanyInvite],
    )).rows[0]?.value);
    assert.equal(crossCompany.topologyValid, true);
    assert.equal(crossCompany.accessEstablished, false);
    assert.deepEqual(crossCompany.currentPropertyIds, []);
    assert.deepEqual(crossCompany.missingPropertyIds, [PID_A1]);

    const staleInvite = await createInvite(
      pg, ACCOUNT_ANA, UID_ANA, PID_A1, 'front_desk', ORG_A, 'property', [PID_A1, PID_A2],
    );
    await acceptInvite(pg, staleInvite, ACCOUNT_ANA);

    // Move the promised second property to another company. The assertion
    // must retain the promised property while reporting the missing exact
    // relationship, rather than unioning ORG_B's new topology.
    await pg.query(
      `update public.organization_property_relationships
          set ends_at = clock_timestamp()
        where organization_id = $1
          and property_id = $2
          and is_primary_grouping is true
          and ends_at is null`,
      [ORG_A, PID_A2],
    );
    await pg.query(
      `insert into public.organization_property_relationships
         (organization_id, property_id, relationship_type, is_primary_grouping)
       values ($1, $2, 'operator', true)`,
      ['bbbb0000-0000-4000-8000-00000000000b', PID_A2],
    );
    const stale = asObject((await pg.query<{ value: unknown }>(
      `select public.staxis_invite_access_shadow($1::uuid) as value`,
      [staleInvite],
    )).rows[0]?.value);
    assert.equal(stale.topologyValid, false);
    assert.equal(stale.topologyReason, 'property_invite_topology_stale_or_cross_company');
    assert.deepEqual(stale.promisedPropertyIds, [PID_A1, PID_A2]);
    assert.deepEqual(stale.missingTopologyPropertyIds, [PID_A2]);

    const suspendedInvite = await createInvite(
      pg, ACCOUNT_ANA, UID_ANA, PID_A1, 'front_desk', ORG_A, 'property', [PID_A1],
    );
    await acceptInvite(pg, suspendedInvite, ACCOUNT_ANA);
    await pg.query(`update public.organizations set status = 'suspended' where id = $1`, [ORG_A]);
    const suspended = asObject((await pg.query<{ value: unknown }>(
      `select public.staxis_invite_access_shadow($1::uuid) as value`,
      [suspendedInvite],
    )).rows[0]?.value);
    assert.equal(suspended.topologyValid, false);
    assert.equal(suspended.invitedOrganizationStatus, 'suspended');
    assert.equal(suspended.topologyReason, 'property_invite_organization_inactive_or_missing');
    assert.deepEqual(suspended.missingTopologyPropertyIds, [PID_A1]);

    const missingAccessInvite = await createInvite(
      pg, ACCOUNT_WANDA, UID_WANDA, PID_L1, 'front_desk', null, null, null,
    );
    await acceptInvite(pg, missingAccessInvite, ACCOUNT_MISSING_ACCESS);
    const missingAccess = asObject((await pg.query<{ value: unknown }>(
      `select public.staxis_invite_access_shadow($1::uuid) as value`,
      [missingAccessInvite],
    )).rows[0]?.value);
    assert.equal(missingAccess.topologyValid, true);
    assert.equal(missingAccess.currentAccessValid, false);
    assert.deepEqual(missingAccess.promisedPropertyIds, [PID_L1]);
    assert.deepEqual(missingAccess.missingPropertyIds, [PID_L1]);

    const missingAuthInvite = await createInvite(
      pg, ACCOUNT_WANDA, UID_WANDA, PID_L1, 'front_desk', null, null, null,
    );
    await acceptInvite(pg, missingAuthInvite, ACCOUNT_MISSING_AUTH);
    const missingAuth = asObject((await pg.query<{ value: unknown }>(
      `select public.staxis_invite_access_shadow($1::uuid) as value`,
      [missingAuthInvite],
    )).rows[0]?.value);
    assert.equal(missingAuth.authIdentityLinked, false);
    assert.equal(missingAuth.accessEstablished, false);

    const roster = asObject((await pg.query<{ value: unknown }>(
      `select public.staxis_invite_access_shadow($1::uuid) as value`,
      [rosterInvite],
    )).rows[0]?.value);
    assert.equal(roster.topologyValid, false, 'the invite organization was intentionally suspended');
    assert.equal(roster.rosterPromised, true);
    assert.equal(roster.rosterBound, false);
    assert.equal(asObject(roster.rosterBinding).targetStaffMatchesAnchor, true);

    const invariantResult = asObject((await pg.query<{ value: unknown }>(
      `select public.staxis_assert_stage_a_access_invariants() as value`,
    )).rows[0]?.value);
    assert.ok(Number(invariantResult.issueCount) > 0);
    const issues = await pg.query<{
      issue_code: string;
      details: Record<string, unknown>;
    }>(
      `select issue_code, details
         from public.account_access_cutover_invariant_issues
        where run_id = $1`,
      [invariantResult.runId],
    );
    const inviteIssueCodes = new Set(issues.rows.map((row) => row.issue_code));
    assert.ok(inviteIssueCodes.has('accepted_invite_auth_identity_missing'));
    assert.ok(inviteIssueCodes.has('accepted_invite_current_access_missing'));
    assert.ok(inviteIssueCodes.has('accepted_invite_promised_coverage_missing'));
    assert.ok(inviteIssueCodes.has('accepted_invite_roster_binding_missing'));
    assert.ok(inviteIssueCodes.has('accepted_invite_topology_invalid'));
    assert.ok(
      issues.rows.some((row) => (
        row.issue_code === 'active_bridge_topology_stale'
        && row.details.cutoverOrganizationId === ORG_A
        && row.details.cutoverRelationshipId !== null
      )),
      'a suspended governing organization must invalidate the exact topology-bound bridge',
    );

    const rosterInvariant = issues.rows.find(
      (row) => row.issue_code === 'accepted_invite_roster_binding_missing'
        && asObject(row.details.assertion).inviteId === rosterInvite,
    );
    assert.ok(rosterInvariant, JSON.stringify(issues.rows));
    const missingAccessInvariant = issues.rows.find(
      (row) => row.issue_code === 'accepted_invite_current_access_missing'
        && asObject(row.details.assertion).inviteId === missingAccessInvite,
    );
    assert.ok(missingAccessInvariant, JSON.stringify(issues.rows));
  });

  test('legacy anchor transfers and roster drift invalidate the persisted invite promise', async () => {
    // Restore the governing organization after the prior lifecycle fixture so
    // this test can prove a clean accepted state before each drift.
    await pg.query(
      `update public.organizations set status = 'active' where id = $1`,
      [ORG_A],
    );

    const rosterDriftInvite = await createInvite(
      pg, ACCOUNT_ANA, UID_ANA, PID_A1, 'front_desk', ORG_A, 'property', [PID_A1],
    );
    await pg.query(
      `update public.account_invites
          set target_staff_id = $2
        where id = $1`,
      [rosterDriftInvite, STAFF_TARGET],
    );
    await acceptInvite(pg, rosterDriftInvite, ACCOUNT_FRANK);

    // Represent the durable post-acceptance binding produced by the existing
    // People acceptance path. The assertion must still verify every live fact
    // rather than trusting the accepted invite or the link row.
    await pg.query(
      `update public.accounts
          set staff_id = $2
        where id = $1`,
      [ACCOUNT_FRANK, STAFF_TARGET],
    );
    await pg.query(
      `insert into public.account_property_staff_links (
         account_id, property_id, staff_id, is_active, source,
         linked_by_account_id, linked_at, deactivated_at,
         deactivated_by_account_id, updated_at
       ) values ($1, $2, $3, true, 'invitation', $4,
                 clock_timestamp(), null, null, clock_timestamp())`,
      [ACCOUNT_FRANK, PID_A1, STAFF_TARGET, ACCOUNT_ANA],
    );

    const bound = asObject((await pg.query<{ value: unknown }>(
      `select public.staxis_invite_access_shadow($1::uuid) as value`,
      [rosterDriftInvite],
    )).rows[0]?.value);
    assert.equal(bound.rosterBound, true);
    assert.equal(bound.accountStaffLinkActive, true);
    assert.equal(bound.targetStaffExists, true);
    assert.equal(bound.targetStaffActive, true);
    assert.equal(bound.targetStaffDepartment, 'front_desk');
    assert.equal(bound.rosterRoleMatches, true);
    assert.equal(asObject(bound.rosterBinding).roleMatchesDepartment, true);

    await pg.query(
      `update public.staff set department = 'maintenance' where id = $1`,
      [STAFF_TARGET],
    );
    const departmentDrift = asObject((await pg.query<{ value: unknown }>(
      `select public.staxis_invite_access_shadow($1::uuid) as value`,
      [rosterDriftInvite],
    )).rows[0]?.value);
    assert.equal(departmentDrift.rosterBound, false);
    assert.equal(departmentDrift.targetStaffExists, true);
    assert.equal(departmentDrift.targetStaffActive, true);
    assert.equal(departmentDrift.targetStaffDepartment, 'maintenance');
    assert.equal(departmentDrift.rosterRoleMatches, false);
    assert.equal(departmentDrift.accountStaffLinkActive, true);
    assert.equal(departmentDrift.rosterLinkExists, true);

    await pg.query(
      `update public.staff
          set department = 'front_desk', is_active = false
        where id = $1`,
      [STAFF_TARGET],
    );
    const inactiveStaff = asObject((await pg.query<{ value: unknown }>(
      `select public.staxis_invite_access_shadow($1::uuid) as value`,
      [rosterDriftInvite],
    )).rows[0]?.value);
    assert.equal(inactiveStaff.rosterBound, false);
    assert.equal(inactiveStaff.targetStaffExists, true);
    assert.equal(inactiveStaff.targetStaffActive, false);
    assert.equal(inactiveStaff.targetStaffDepartment, 'front_desk');
    assert.equal(inactiveStaff.rosterRoleMatches, true);
    assert.equal(inactiveStaff.accountStaffLinkActive, true);

    // Leave the shared fixture at its original roster state before testing the
    // independent legacy-anchor topology transition.
    await pg.query(
      `update public.staff set is_active = true where id = $1`,
      [STAFF_TARGET],
    );
    await pg.query(
      `delete from public.account_property_staff_links
        where account_id = $1 and property_id = $2`,
      [ACCOUNT_FRANK, PID_A1],
    );
    await pg.query(
      `update public.accounts set staff_id = null where id = $1`,
      [ACCOUNT_FRANK],
    );

    const legacyAnchorInvite = await createInvite(
      pg, ACCOUNT_WANDA, UID_WANDA, PID_L1, 'owner', null, null, null,
    );
    await acceptInvite(pg, legacyAnchorInvite, ACCOUNT_WANDA);
    const independent = asObject((await pg.query<{ value: unknown }>(
      `select public.staxis_invite_access_shadow($1::uuid) as value`,
      [legacyAnchorInvite],
    )).rows[0]?.value);
    assert.equal(independent.topologyValid, true);
    assert.equal(independent.currentAccessValid, true);
    assert.equal(independent.promisedCoverageComplete, true);
    assert.equal(independent.ok, true);
    assert.equal(independent.currentOrganizationType, 'single_hotel');

    await companies.attachPropertyToOrganization(pg, ORG_A, PID_L1, 'Waco Inn Managed');
    const transferred = asObject((await pg.query<{ value: unknown }>(
      `select public.staxis_invite_access_shadow($1::uuid) as value`,
      [legacyAnchorInvite],
    )).rows[0]?.value);
    assert.equal(transferred.topologyValid, false);
    assert.equal(transferred.currentAccessValid, false);
    assert.equal(transferred.promisedCoverageComplete, false);
    assert.equal(transferred.ok, false);
    assert.equal(transferred.currentOrganizationId, ORG_A);
    assert.equal(transferred.currentOrganizationType, 'management_company');

    const invariantResult = asObject((await pg.query<{ value: unknown }>(
      `select public.staxis_assert_stage_a_access_invariants() as value`,
    )).rows[0]?.value);
    const issues = await pg.query<{
      issue_code: string;
      details: Record<string, unknown>;
    }>(
      `select issue_code, details
         from public.account_access_cutover_invariant_issues
        where run_id = $1`,
      [invariantResult.runId],
    );
    const legacyIssueCodes = new Set(
      issues.rows
        .filter((row) => row.details.assertion !== undefined
          && asObject(row.details.assertion).inviteId === legacyAnchorInvite)
        .map((row) => row.issue_code),
    );
    assert.ok(legacyIssueCodes.has('accepted_invite_topology_invalid'));
    assert.ok(legacyIssueCodes.has('accepted_invite_current_access_missing'));
    assert.ok(legacyIssueCodes.has('accepted_invite_promised_coverage_missing'));
  });
});
