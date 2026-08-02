import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PGlite } from '@electric-sql/pglite';

import { applyMigrationsToPgliteWithHook } from '../../../tests/fixtures/pglite-migrate';

const PREFLIGHT_MIGRATION = '0418_authoritative_access_cutover_preflight.sql';
const BACKFILL_MIGRATION = '0419_authoritative_access_cutover_backfill.sql';
const INVARIANT_MIGRATION = '0423_authoritative_access_stage_a_invariants.sql';

const PROPERTY_GOVERNED = 'a4190000-0000-4000-8000-000000000101';
const PROPERTY_OTHER_COMPANY = 'a4190000-0000-4000-8000-000000000102';
const ORGANIZATION_GOVERNED = 'a4191000-0000-4000-8000-000000000101';
const ORGANIZATION_OTHER = 'a4191000-0000-4000-8000-000000000102';

const ACCOUNT_INVALID_ROLE = 'a4192000-0000-4000-8000-000000000101';
const ACCOUNT_MISSING_IDENTITY = 'a4192000-0000-4000-8000-000000000102';
const ACCOUNT_SHADOW = 'a4192000-0000-4000-8000-000000000103';
const ACCOUNT_ORPHAN_PROPERTY = 'a4192000-0000-4000-8000-000000000104';
const ACCOUNT_NORMALIZED_RESIDUE = 'a4192000-0000-4000-8000-000000000105';
const ACCOUNT_MISSING_STATE = 'a4192000-0000-4000-8000-000000000106';

const UID_INVALID_ROLE = 'a4193000-0000-4000-8000-000000000101';
const UID_SHADOW = 'a4193000-0000-4000-8000-000000000103';
const UID_MISSING_IDENTITY = 'a4193000-0000-4000-8000-000000000199';
const UID_ORPHAN_PROPERTY = 'a4193000-0000-4000-8000-000000000104';
const UID_NORMALIZED_RESIDUE = 'a4193000-0000-4000-8000-000000000105';
const UID_MISSING_STATE = 'a4193000-0000-4000-8000-000000000106';
const ORPHAN_PROPERTY = 'a4194000-0000-4000-8000-000000000404';

function asObject(value: unknown): Record<string, unknown> {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  assert.ok(parsed && typeof parsed === 'object' && !Array.isArray(parsed));
  return parsed as Record<string, unknown>;
}

async function insertAccount(
  pg: PGlite,
  accountId: string,
  username: string,
  role: string,
  propertyIds: string[],
  dataUserId: string,
): Promise<void> {
  await pg.query(
    `insert into public.accounts
       (id, username, password_hash, display_name, role, property_access, data_user_id)
     values ($1, $2, 'x', $3, $4, $5::uuid[], $6)`,
    [accountId, username, username, role, `{${propertyIds.join(',')}}`, dataUserId],
  );
}

async function seedBeforePreflight(pg: PGlite): Promise<void> {
  await pg.query(
    `insert into auth.users (id, email)
     values ($1, 'stage-a-orphan@example.test')`,
    [UID_ORPHAN_PROPERTY],
  );
  await insertAccount(
    pg,
    ACCOUNT_ORPHAN_PROPERTY,
    'stage-a-orphan-property',
    'front_desk',
    [],
    UID_ORPHAN_PROPERTY,
  );

  // The live account trigger correctly rejects an unknown property. Disable
  // only that legacy reconciliation trigger while planting the malformed row
  // that 0418 must report, then leave every constraint and authorization
  // refresh path active for the migration run itself.
  await pg.query(
    `alter table public.accounts
       disable trigger trg_accounts_reconcile_legacy_organization_access`,
  );
  try {
    await pg.query(
      `update public.accounts
          set property_access = $1::uuid[]
        where id = $2`,
      [`{${ORPHAN_PROPERTY}}`, ACCOUNT_ORPHAN_PROPERTY],
    );
  } finally {
    await pg.query(
      `alter table public.accounts
         enable trigger trg_accounts_reconcile_legacy_organization_access`,
    );
  }
}

async function seedBeforeBackfill(pg: PGlite): Promise<void> {
  await pg.query(
    `insert into auth.users (id, email)
     values ($1, 'stage-a-shadow@example.test'),
            ($2, 'stage-a-invalid-role@example.test')`,
    [UID_SHADOW, UID_INVALID_ROLE],
  );

  await pg.query(
    `insert into public.organizations
       (id, name, organization_type, status)
     values ($1, 'Stage A Governing Company', 'management_company', 'active'),
            ($2, 'Stage A Other Company', 'management_company', 'active')`,
    [ORGANIZATION_GOVERNED, ORGANIZATION_OTHER],
  );

  await pg.query(
    `insert into public.properties (id, name, owner_id, total_rooms, timezone)
     values ($1, 'Stage A Governed Hotel', $3, 40, 'America/Chicago'),
            ($2, 'Stage A Other Company Hotel', $3, 40, 'America/Chicago')`,
    [PROPERTY_GOVERNED, PROPERTY_OTHER_COMPANY, UID_SHADOW],
  );

  // The property trigger creates an independent single_hotel anchor. Hand the
  // primary topology to the explicit company rows used by this migration test.
  await pg.query(
    `update public.organization_property_relationships
        set is_primary_grouping = false
      where property_id in ($1::uuid, $2::uuid)
        and ends_at is null
        and is_primary_grouping`,
    [PROPERTY_GOVERNED, PROPERTY_OTHER_COMPANY],
  );
  await pg.query(
    `insert into public.organization_property_relationships
       (organization_id, property_id, relationship_type, is_primary_grouping)
     values ($1, $3, 'operator', true),
            ($2, $4, 'operator', true)`,
    [
      ORGANIZATION_GOVERNED,
      ORGANIZATION_OTHER,
      PROPERTY_GOVERNED,
      PROPERTY_OTHER_COMPANY,
    ],
  );

  // The production schema normally prevents these malformed rows. The
  // preflight contract must still be tested against legacy data that predates
  // or bypassed those constraints, so this isolated fixture temporarily
  // permits one invalid role and one dangling Auth identity.
  await pg.query(`alter table public.accounts drop constraint accounts_role_check`);
  await insertAccount(
    pg,
    ACCOUNT_INVALID_ROLE,
    'stage-a-invalid-role',
    'invalid_legacy_role',
    [PROPERTY_GOVERNED],
    UID_INVALID_ROLE,
  );
  await pg.query(
    `alter table public.accounts add constraint accounts_role_check
       check (role in (
         'admin', 'owner', 'general_manager', 'front_desk',
         'housekeeping', 'maintenance', 'staff'
       )) not valid`,
  );

  await pg.query(`alter table public.accounts drop constraint accounts_data_user_id_fkey`);
  // The notification projection intentionally has a live Auth FK. Suppress
  // only that projection trigger while planting the deliberately dangling
  // legacy identity; the account state and the preflight evidence remain real.
  await pg.query(
    `alter table public.account_authorization_state
       disable trigger trg_account_authorization_state_notification`,
  );
  try {
    await insertAccount(
      pg,
      ACCOUNT_MISSING_IDENTITY,
      'stage-a-missing-identity',
      'front_desk',
      [PROPERTY_GOVERNED],
      UID_MISSING_IDENTITY,
    );
  } finally {
    await pg.query(
      `alter table public.account_authorization_state
         enable trigger trg_account_authorization_state_notification`,
    );
  }
  await pg.query(
    `alter table public.accounts add constraint accounts_data_user_id_fkey
       foreign key (data_user_id) references auth.users(id) on delete cascade not valid`,
  );

  await insertAccount(
    pg,
    ACCOUNT_SHADOW,
    'stage-a-shadow',
    'staff',
    [PROPERTY_GOVERNED, PROPERTY_OTHER_COMPANY],
    UID_SHADOW,
  );
  await pg.query(
    `update public.account_authorization_state
        set authority_mode = 'shadow', cutover_at = null
      where account_id = $1`,
    [ACCOUNT_SHADOW],
  );

  // A real membership in the governing organization is valid company context
  // even when the legacy array still carries hotel rows. Suppress only the
  // refresh trigger during fixture construction so the account remains in the
  // deliberate Stage A shadow mode; the migration itself still sees the real
  // membership through the shared helper.
  await pg.query(
    `alter table public.organization_memberships
       disable trigger trg_organization_memberships_00_authorization_refresh`,
  );
  try {
    await pg.query(
      `insert into public.organization_memberships
         (organization_id, account_id, job_category, job_title, status,
          membership_scope, staxis_role, covered_property_ids)
       values ($1, $2, 'executive', 'Stage A Test Hat', 'active',
               'company', 'vp', null)`,
      [ORGANIZATION_GOVERNED, ACCOUNT_SHADOW],
    );
  } finally {
    await pg.query(
      `alter table public.organization_memberships
         enable trigger trg_organization_memberships_00_authorization_refresh`,
    );
  }
}

async function seedBeforeInvariant(pg: PGlite): Promise<void> {
  await pg.query(
    `insert into auth.users (id, email)
     values ($1, 'stage-a-normalized-residue@example.test'),
            ($2, 'stage-a-missing-state@example.test')`,
    [UID_NORMALIZED_RESIDUE, UID_MISSING_STATE],
  );
  await insertAccount(
    pg,
    ACCOUNT_NORMALIZED_RESIDUE,
    'stage-a-normalized-residue',
    'front_desk',
    [],
    UID_NORMALIZED_RESIDUE,
  );
  await insertAccount(
    pg,
    ACCOUNT_MISSING_STATE,
    'stage-a-missing-state',
    'front_desk',
    [],
    UID_MISSING_STATE,
  );

  // These are deliberate post-backfill residues. Disable only the Stage A
  // compatibility translator while planting the array, then leave the array
  // intact and make the authorization-state facts explicit for 0423.
  await pg.query(
    `alter table public.accounts
       disable trigger trg_accounts_zz_authorization_translate_legacy_property_access`,
  );
  try {
    await pg.query(
      `update public.accounts
          set property_access = $1::uuid[]
        where id in ($2::uuid, $3::uuid)`,
      [`{${PROPERTY_GOVERNED}}`, ACCOUNT_NORMALIZED_RESIDUE, ACCOUNT_MISSING_STATE],
    );
  } finally {
    await pg.query(
      `alter table public.accounts
         enable trigger trg_accounts_zz_authorization_translate_legacy_property_access`,
    );
  }
  await pg.query(
    `update public.account_authorization_state
        set authority_mode = 'normalized', cutover_at = clock_timestamp()
      where account_id = $1`,
    [ACCOUNT_NORMALIZED_RESIDUE],
  );
  await pg.query(
    `delete from public.account_authorization_state where account_id = $1`,
    [ACCOUNT_MISSING_STATE],
  );
}

async function countBridges(pg: PGlite, accountId: string, propertyId: string): Promise<number> {
  const result = await pg.query<{ count: number }>(
    `select count(*)::integer as count
       from public.account_property_authorization_bridges
      where account_id = $1 and property_id = $2 and status = 'active'`,
    [accountId, propertyId],
  );
  return Number(result.rows[0]?.count ?? 0);
}

test('0419 backfill skips account-level issues and applies the consistent company boundary', async () => {
  let observedIndependent0418Baseline = false;
  const migrated = await applyMigrationsToPgliteWithHook(async ({ pg, file }) => {
    if (file === PREFLIGHT_MIGRATION) await seedBeforePreflight(pg);
    if (file === BACKFILL_MIGRATION) {
      const baseline = await pg.query<{ id: string; created_by: string }>(
        `select id, created_by
           from public.account_access_cutover_preflight_runs
          where created_by = '0418'
          order by started_at desc
          limit 1`,
      );
      assert.equal(baseline.rows.length, 1);
      assert.equal(baseline.rows[0]?.created_by, '0418');
      observedIndependent0418Baseline = true;
      await seedBeforeBackfill(pg);
    }
    if (file === INVARIANT_MIGRATION) await seedBeforeInvariant(pg);
  });

  try {
    assert.ok(migrated.report.applied.includes(PREFLIGHT_MIGRATION));
    assert.equal(
      observedIndependent0418Baseline,
      true,
      '0418 must commit an inspectable baseline before 0419 starts',
    );
    assert.ok(
      migrated.report.applied.includes(BACKFILL_MIGRATION),
      JSON.stringify(migrated.report.failedAtRuntime),
    );

    const status = await migrated.pg.query<{
      last_preflight_run_id: string;
      baseline_preflight_run_id: string;
    }>(
      `select last_preflight_run_id, baseline_preflight_run_id
         from public.account_access_cutover_status
        where id is true`,
    );
    const preflightRunId = status.rows[0]?.last_preflight_run_id;
    const baselinePreflightRunId = status.rows[0]?.baseline_preflight_run_id;
    assert.ok(preflightRunId);
    assert.ok(baselinePreflightRunId);
    assert.notEqual(
      preflightRunId,
      baselinePreflightRunId,
      '0419 must retain a distinct immediate run rather than relabeling the 0418 baseline',
    );

    const preflightRuns = await migrated.pg.query<{
      id: string;
      created_by: string;
      status: string;
    }>(
      `select id, created_by, status
         from public.account_access_cutover_preflight_runs
        where id in ($1::uuid, $2::uuid)
        order by created_by`,
      [baselinePreflightRunId, preflightRunId],
    );
    assert.deepEqual(
      preflightRuns.rows.map((row) => [row.id, row.created_by]),
      [
        [baselinePreflightRunId, '0418'],
        [preflightRunId, '0419'],
      ],
    );

    const backfillRun = await migrated.pg.query<{
      id: string;
      preflight_run_id: string;
      baseline_preflight_run_id: string;
      skipped_count: number;
    }>(
      `select preflight_run_id, baseline_preflight_run_id, skipped_count
         from public.account_access_cutover_backfill_runs
        order by started_at desc
        limit 1`,
    );
    assert.equal(backfillRun.rows[0]?.preflight_run_id, preflightRunId);
    assert.equal(backfillRun.rows[0]?.baseline_preflight_run_id, baselinePreflightRunId);
    assert.ok(Number(backfillRun.rows[0]?.skipped_count) >= 4);

    const orphanArray = await migrated.pg.query<{ property_access: string[] }>(
      `select property_access from public.accounts where id = $1`,
      [ACCOUNT_ORPHAN_PROPERTY],
    );
    assert.deepEqual(orphanArray.rows[0]?.property_access, [ORPHAN_PROPERTY]);
    assert.equal(
      await countBridges(migrated.pg, ACCOUNT_ORPHAN_PROPERTY, ORPHAN_PROPERTY),
      0,
      'an orphan property UUID must never become a guessed bridge',
    );

    const orphanPreflightRuns = await migrated.pg.query<{ run_id: string }>(
      `select distinct run_id
         from public.account_access_cutover_preflight_issues
        where account_id = $1
          and property_id = $2
          and issue_code = 'property_missing'`,
      [ACCOUNT_ORPHAN_PROPERTY, ORPHAN_PROPERTY],
    );
    assert.ok(
      orphanPreflightRuns.rows.length >= 2,
      '0418 and the exact 0419 preflight run must durably report property_missing',
    );
    assert.ok(
      orphanPreflightRuns.rows.some((row) => row.run_id === preflightRunId),
      '0419 must link its backfill to the exact preflight run it just created',
    );

    const orphanBackfillEvidence = await migrated.pg.query<{
      issue_code: string;
      details: Record<string, unknown>;
    }>(
      `select issue_code, details
         from public.account_access_cutover_preflight_issues
        where run_id = $1
          and account_id = $2
          and property_id = $3
        order by id`,
      [preflightRunId, ACCOUNT_ORPHAN_PROPERTY, ORPHAN_PROPERTY],
    );
    assert.ok(
      orphanBackfillEvidence.rows.some((row) => row.issue_code === 'property_missing'),
    );
    assert.ok(
      orphanBackfillEvidence.rows.some((row) => (
        row.issue_code === 'backfill_skipped_preflight_property_missing'
        && row.details.preflightRunId === preflightRunId
        && row.details.preflightIssueCode === 'property_missing'
        && row.details.preflightIssueDetails !== null
      )),
      JSON.stringify(orphanBackfillEvidence.rows),
    );

    assert.equal(
      await countBridges(migrated.pg, ACCOUNT_INVALID_ROLE, PROPERTY_GOVERNED),
      0,
      'an account-level invalid-role preflight issue must poison every legacy row',
    );
    assert.equal(
      await countBridges(migrated.pg, ACCOUNT_MISSING_IDENTITY, PROPERTY_GOVERNED),
      0,
      'an account-level missing-identity preflight issue must poison every legacy row',
    );

    const accountLevelEvidence = await migrated.pg.query<{
      account_id: string;
      issue_code: string;
      details: Record<string, unknown>;
    }>(
      `select account_id, issue_code, details
         from public.account_access_cutover_preflight_issues
        where run_id = $1
          and issue_code like 'backfill_skipped_preflight_%'
          and account_id in ($2::uuid, $3::uuid)
        order by account_id`,
      [preflightRunId, ACCOUNT_INVALID_ROLE, ACCOUNT_MISSING_IDENTITY],
    );
    assert.equal(accountLevelEvidence.rows.length, 2);
    assert.deepEqual(
      accountLevelEvidence.rows.map((row) => row.details.preflightRunId),
      [preflightRunId, preflightRunId],
    );
    assert.deepEqual(
      new Set(accountLevelEvidence.rows.map((row) => row.details.preflightIssueCode)),
      new Set(['invalid_account_role', 'auth_identity_missing']),
    );
    assert.deepEqual(
      new Set(accountLevelEvidence.rows.map((row) => row.issue_code)),
      new Set([
        'backfill_skipped_preflight_invalid_account_role',
        'backfill_skipped_preflight_auth_identity_missing',
      ]),
    );

    assert.equal(
      await countBridges(migrated.pg, ACCOUNT_SHADOW, PROPERTY_GOVERNED),
      1,
      'governing-company membership must not be treated as cross-company access',
    );
    assert.equal(
      await countBridges(migrated.pg, ACCOUNT_SHADOW, PROPERTY_OTHER_COMPANY),
      0,
      'membership only in another company must fail closed',
    );

    const crossCompanyEvidence = await migrated.pg.query<{
      issue_code: string;
      details: Record<string, unknown>;
    }>(
      `select issue_code, details
         from public.account_access_cutover_preflight_issues
        where run_id = $1
          and account_id = $2
          and property_id = $3
        order by id`,
      [preflightRunId, ACCOUNT_SHADOW, PROPERTY_OTHER_COMPANY],
    );
    assert.ok(
      crossCompanyEvidence.rows.some((row) => row.issue_code === 'cross_company_legacy_access'),
    );
    assert.ok(
      crossCompanyEvidence.rows.some((row) => (
        row.issue_code === 'backfill_skipped_preflight_cross_company_legacy_access'
        && row.details.preflightRunId === preflightRunId
        && row.details.preflightIssueCode === 'cross_company_legacy_access'
      )),
    );

    // A preflight issue explains why the row was skipped, but it does not
    // resolve the missing bridge. The final invariant must retain both layers
    // of evidence for the exact orphan UUID.
    const invariantResult = await migrated.pg.query<{ value: unknown }>(
      `select public.staxis_assert_stage_a_access_invariants() as value`,
    );
    const invariant = asObject(invariantResult.rows[0]?.value);
    assert.ok(Number(invariant.issueCount) > 0);
    const invariantIssues = await migrated.pg.query<{
      issue_code: string;
      details: Record<string, unknown>;
    }>(
      `select issue_code, details
         from public.account_access_cutover_invariant_issues
        where run_id = $1
          and account_id = $2
          and property_id = $3`,
      [invariant.runId, ACCOUNT_ORPHAN_PROPERTY, ORPHAN_PROPERTY],
    );
    const orphanInvariant = invariantIssues.rows.find(
      (row) => row.issue_code === 'legacy_row_without_shadow_translation',
    );
    assert.ok(
      orphanInvariant,
      `the final invariant reporter must retain the orphan UUID as durable evidence: ${JSON.stringify(invariantIssues.rows)}`,
    );
    const invariantPreflightIssues = orphanInvariant?.details.preflightIssues;
    assert.ok(Array.isArray(invariantPreflightIssues));
    assert.ok(
      invariantPreflightIssues.some((issue) => asObject(issue).code === 'property_missing'),
      `the invariant must retain the matching preflight context: ${JSON.stringify(orphanInvariant?.details)}`,
    );

    const residueIssues = await migrated.pg.query<{
      account_id: string;
      property_id: string;
      issue_code: string;
      details: Record<string, unknown>;
    }>(
      `select account_id, property_id, issue_code, details
         from public.account_access_cutover_invariant_issues
        where run_id = $1
          and account_id in ($2::uuid, $3::uuid)
          and property_id = $4
          and issue_code = 'legacy_row_without_shadow_translation'
        order by account_id`,
      [invariant.runId, ACCOUNT_NORMALIZED_RESIDUE, ACCOUNT_MISSING_STATE, PROPERTY_GOVERNED],
    );
    assert.equal(residueIssues.rows.length, 2);
    const normalizedResidue = residueIssues.rows.find(
      (row) => row.account_id === ACCOUNT_NORMALIZED_RESIDUE,
    );
    const missingStateResidue = residueIssues.rows.find(
      (row) => row.account_id === ACCOUNT_MISSING_STATE,
    );
    assert.equal(normalizedResidue?.details.authorizationStatePresent, true);
    assert.equal(normalizedResidue?.details.authorityMode, 'normalized');
    assert.equal(missingStateResidue?.details.authorizationStatePresent, false);
    assert.equal(missingStateResidue?.details.authorityMode, null);

    const invalidRoleInvariant = await migrated.pg.query<{
      details: Record<string, unknown>;
    }>(
      `select details
         from public.account_access_cutover_invariant_issues
        where run_id = $1
          and account_id = $2
          and property_id = $3
          and issue_code = 'legacy_row_without_shadow_translation'`,
      [invariant.runId, ACCOUNT_INVALID_ROLE, PROPERTY_GOVERNED],
    );
    const invalidRoleDetails = invalidRoleInvariant.rows[0]?.details;
    const invalidRolePreflight = invalidRoleDetails?.preflightIssues;
    assert.ok(Array.isArray(invalidRolePreflight));
    assert.ok(
      invalidRolePreflight.some((issue) => asObject(issue).code === 'invalid_account_role'),
      JSON.stringify(invalidRoleDetails),
    );
  } finally {
    await migrated.pg.close();
  }
});

test('0419 rerun preserves Stage C enforcement and fails with explicit remediation', async () => {
  const migrated = await applyMigrationsToPgliteWithHook(async ({ pg, file }) => {
    if (file !== BACKFILL_MIGRATION) return;

    // Seed the already-live control record immediately before the migration.
    // 0419 must lock and reject it, not overwrite it or create a new backfill.
    await pg.exec(`
      create table public.account_access_cutover_status (
        id boolean primary key default true check (id is true),
        stage text not null default 'A' check (stage in ('A', 'B', 'C')),
        enforcement_enabled boolean not null default false,
        last_preflight_run_id uuid references public.account_access_cutover_preflight_runs(id),
        last_backfill_at timestamptz,
        details jsonb not null default '{}'::jsonb
      );
      insert into public.account_access_cutover_status (id, stage, enforcement_enabled)
      values (true, 'C', true);
    `);
  });

  try {
    assert.equal(
      migrated.report.applied.includes(BACKFILL_MIGRATION),
      false,
      'a Stage C control record must make the additive 0419 migration fail loudly',
    );
    const failure = migrated.report.failedAtRuntime.find(
      (entry) => entry.file === BACKFILL_MIGRATION,
    );
    assert.ok(failure);
    assert.match(failure.error, /0419 cannot rerun additive backfill/);
    assert.match(failure.error, /stage C/);

    // The generic migration hook intentionally keeps applying later files
    // after a runtime failure; clear the failed transaction before inspecting
    // the durable pre-seeded control row.
    await migrated.pg.exec('rollback');

    const status = await migrated.pg.query<{ stage: string; enforcement_enabled: boolean }>(
      `select stage, enforcement_enabled
         from public.account_access_cutover_status
        where id is true`,
    );
    assert.deepEqual(status.rows[0], { stage: 'C', enforcement_enabled: true });
    const backfillTable = await migrated.pg.query<{ table_name: string | null }>(
      `select to_regclass('public.account_access_cutover_backfill_runs') as table_name`,
    );
    assert.equal(
      backfillTable.rows[0]?.table_name,
      null,
      'the failed rerun must not leave a partially-created backfill evidence table',
    );
  } finally {
    await migrated.pg.close();
  }
});
