import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';

import {
  applyMigrationsToPgliteWithHook,
  authorizeAccessStageCRelease,
} from '../../../tests/fixtures/pglite-migrate';
import {
  ACCOUNT_ADMIN,
  ACCOUNT_FRANK,
  ACCOUNT_HANK,
  ACCOUNT_MARIA,
  ACCOUNT_WANDA,
  ORG_A,
  PID_A1,
  PID_A2,
  PID_B1,
  PID_L1,
  UID_ADMIN,
  UID_HANK,
  UID_MARIA,
  UID_WANDA,
  seedTwoCompanies,
} from '../../../tests/fixtures/pglite-two-company-seed';

const MIGRATION = '0426_authoritative_access_stage_c_final_contract.sql';
const LIVE_0425_DESCRIPTION =
  'Restore missing canonical room identities for is_test properties through the lineage-complete service roster path';
const ACCESS_B_LIVE_SHA = 'ec83bca6dab74a52dfb251d04be11d5c7427703f';
const CURRENT_LIVE_DESCENDANT_SHA = '442fb98d632521ea33346d5c8a97014248a31fa0';

const INVITE_USER = 'c4261000-0000-4000-8000-000000000001';
const INVITE_STAFF = 'c4262000-0000-4000-8000-000000000001';
const GRANT_ACCOUNT = 'c4260000-0000-4000-8000-000000000002';
const GRANT_USER = 'c4261000-0000-4000-8000-000000000002';
const GRANT_STAFF = 'c4262000-0000-4000-8000-000000000002';
const JOIN_ACCOUNT = 'c4260000-0000-4000-8000-000000000003';
const JOIN_USER = 'c4261000-0000-4000-8000-000000000003';
const JOIN_REQUEST = 'c4263000-0000-4000-8000-000000000001';
const FIRST_PROPERTY = 'c4264000-0000-4000-8000-000000000001';
const FIRST_USER = 'c4261000-0000-4000-8000-000000000004';
const FIRST_CODE = 'STGC-ABCDEFGHJK';
const LIFECYCLE_ACCOUNT = 'c4260000-0000-4000-8000-000000000004';
const LIFECYCLE_USER = 'c4261000-0000-4000-8000-000000000005';
const LIFECYCLE_OPERATION = 'c4265000-0000-4000-8000-000000000001';
const DETACH_ACCOUNT = 'c4260000-0000-4000-8000-000000000005';
const DETACH_USER = 'c4261000-0000-4000-8000-000000000006';
const DETACH_OPERATION = 'c4265000-0000-4000-8000-000000000002';
const TRANSFER_ACCOUNT = 'c4260000-0000-4000-8000-000000000009';
const TRANSFER_USER = 'c4261000-0000-4000-8000-000000000009';
const TRANSFER_OPERATION = 'c4265000-0000-4000-8000-000000000009';

const DIRTY_JOIN_REQUEST = 'c4266000-0000-4000-8000-000000000001';
const DIRTY_ACCESS_REQUEST = 'c4266000-0000-4000-8000-000000000002';
const DIRTY_INVITATION = 'c4266000-0000-4000-8000-000000000003';
const POST_CHECK_JOIN_REQUEST = 'c4266000-0000-4000-8000-000000000004';

interface JsonRow {
  value: Record<string, unknown>;
}

interface MigrationRow {
  version: string;
  description: string;
}

interface PreflightIssue {
  issue_code: string;
}

async function rows<T = Record<string, unknown>>(
  pg: PGlite,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const result = (await pg.query(sql, params)) as { rows: T[] };
  return result.rows;
}

async function jsonRpc(
  pg: PGlite,
  sql: string,
  params: unknown[] = [],
): Promise<Record<string, unknown>> {
  const result = await pg.query<JsonRow>(sql, params);
  assert.ok(result.rows[0], 'expected JSON RPC result');
  return result.rows[0].value;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function activeSourceText(...roots: string[]): string {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry);
      const stats = statSync(path);
      if (stats.isDirectory()) {
        if (entry !== '__tests__' && entry !== 'node_modules') visit(path);
        continue;
      }
      if (/(?:\.ts|\.tsx|\.js|\.mjs|\.cjs)$/.test(entry) && !/\.(?:test|spec)\.(?:ts|tsx|js|mjs|cjs)$/.test(entry)) {
        files.push(path);
      }
    }
  };
  for (const root of roots) {
    try {
      if (statSync(root).isDirectory()) visit(root);
    } catch {
      // Optional support roots (workers/cron/support) are absent in some
      // deployments; the inventory remains deterministic for those that exist.
    }
  }
  return files.sort()
    .map((path) => readFileSync(path, 'utf8'))
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
}

async function seedStageCFixture(pg: PGlite): Promise<void> {
  await seedTwoCompanies(pg);
  // The fixture deliberately plants the admin's historical row through the
  // pre-C seed. Its canonical platform-admin role is already established, so
  // mark that state as the operator would before a production cutover.
  await pg.query(
    `update public.account_authorization_state
        set authority_mode = 'normalized',
            cutover_at = coalesce(cutover_at, now()),
            cutover_reason = coalesce(cutover_reason, 'Stage C canonical-admin fixture')
      where account_id = $1`,
    [ACCOUNT_ADMIN],
  );
}

async function seedProductionResidueFixture(pg: PGlite): Promise<void> {
  // Keep the seeded platform admin in its original legacy mode. The clean
  // Stage C fixture intentionally normalizes that row, but this production
  // incident is specifically the preflight admin residue.
  await seedTwoCompanies(pg);
  // Reuse the real company topology but mark the A1 hotel as the explicit
  // is_test production fixture. The seed's unrelated legacy controls are
  // normalized/emptied so the only failed-run residues are the three
  // approved decision classes below.
  await pg.query(`update public.properties set is_test=true where id=$1`, [PID_A1]);
  await pg.query(
    `update public.accounts set property_access='{}'::uuid[]
      where id in ($1,$2)`,
    [ACCOUNT_WANDA, ACCOUNT_HANK],
  );
  await pg.query(
    `update public.account_authorization_state
        set authority_mode='normalized',
            cutover_at=coalesce(cutover_at, now()),
            cutover_reason=coalesce(cutover_reason, 'Stage C residue fixture cleanup')
      where account_id in ($1,$2)`,
    [ACCOUNT_WANDA, ACCOUNT_HANK],
  );

  // Admin: global role authority, raw A1 residue, no canonical grant.
  await pg.query(
    `update public.account_authorization_state
        set authority_mode='legacy', cutover_at=null,
            cutover_reason='Stage C production-shaped admin residue'
      where account_id=$1`,
    [ACCOUNT_ADMIN],
  );
  await pg.query(`update public.accounts set property_access=array[$2::uuid] where id=$1`, [ACCOUNT_ADMIN, PID_A1]);

  // Duplicate: Maria's canonical hats cover A1/A2; raw A1 is redundant.
  await pg.query(`update public.accounts set property_access=array[$2::uuid] where id=$1`, [ACCOUNT_MARIA, PID_A1]);

  // Revoked-empty: Frank's only A1 membership is explicitly ended/revoked.
  await pg.query(`update public.accounts set property_access=array[$2::uuid] where id=$1`, [ACCOUNT_FRANK, PID_A1]);
  await pg.query(
    `update public.organization_memberships
        set status='revoked', ended_at=coalesce(ended_at, now()), updated_at=now()
      where account_id=$1 and organization_id=$2
        and membership_scope='property' and $3::uuid = any(coalesce(covered_property_ids,'{}'::uuid[]))
        and status='active'`,
    [ACCOUNT_FRANK, ORG_A, PID_A1],
  );

  // The Stage A translator observed the fixture setup writes. Production
  // evidence for this incident is zero, so reset only this test setup audit
  // before the report-only prefix runs.
  await pg.query(`delete from public.account_access_cutover_legacy_write_events`);
}

async function seedWrapperMappingFixture(pg: PGlite): Promise<void> {
  await seedProductionResidueFixture(pg);
  // Add a second normalized duplicate on the same account so the wrapper
  // attribution is exercised once per matching account/property disposition.
  await pg.query(`update public.properties set is_test=true where id=$1`, [PID_A2]);
  await pg.query(
    `update public.accounts set property_access=array[$2::uuid,$3::uuid] where id=$1`,
    [ACCOUNT_MARIA, PID_A1, PID_A2],
  );
  await pg.query(`delete from public.account_access_cutover_legacy_write_events`);
}

async function seedUnsupportedResidueFixture(pg: PGlite): Promise<void> {
  await seedProductionResidueFixture(pg);
  await pg.query(`update public.properties set is_test=true where id=$1`, [PID_L1]);
  await pg.query(`update public.accounts set property_access=array[$2::uuid] where id=$1`, [ACCOUNT_HANK, PID_L1]);
  await pg.query(`delete from public.account_access_cutover_legacy_write_events`);
}

async function recordAllProductionResidueDispositions(
  pg: PGlite,
  options: { deployedDescendantSha?: string; accessBMergeSha?: string } = {},
): Promise<string> {
  const runId = (await rows<{ final_preflight_run_id: string }>(
    pg,
    `select final_preflight_run_id from public.account_access_cutover_status where id is true`,
  ))[0].final_preflight_run_id;
  const states = await rows<{
    account_id: string;
    authority_mode: string;
    authority_version: number;
  }>(
    pg,
    `select account_id,authority_mode,authority_version
       from public.account_authorization_state
      where account_id in ($1,$2,$3)
      order by account_id`,
    [ACCOUNT_ADMIN, ACCOUNT_MARIA, ACCOUNT_FRANK],
  );
  const byAccount = new Map(states.map((state) => [state.account_id, state]));
  const mariaCanonicalIds = (await rows<{ property_id: string }>(
    pg,
    `select distinct property_id from public._staxis_account_property_authorizations($1) order by property_id`,
    [ACCOUNT_MARIA],
  )).map((row) => row.property_id);
  const frankCanonicalIds = (await rows<{ property_id: string }>(
    pg,
    `select distinct property_id from public._staxis_account_property_authorizations($1) order by property_id`,
    [ACCOUNT_FRANK],
  )).map((row) => row.property_id);
  await recordRepairDisposition(pg, {
    preflightRunId: runId,
    accountId: ACCOUNT_ADMIN,
    propertyId: PID_A1,
    issueCodes: ['admin_legacy_access', 'admin_legacy_account', 'stage_a_invariant_failure'],
    decision: 'admin_global',
    deployedDescendantSha: options.deployedDescendantSha,
    accessBMergeSha: options.accessBMergeSha,
    rawPropertyIds: [PID_A1],
    canonicalPropertyIds: [],
    authorityMode: byAccount.get(ACCOUNT_ADMIN)?.authority_mode ?? '',
    authorityVersion: byAccount.get(ACCOUNT_ADMIN)?.authority_version ?? 0,
    reason: 'admin_global_role_residue',
  });
  await recordRepairDisposition(pg, {
    preflightRunId: runId,
    accountId: ACCOUNT_MARIA,
    propertyId: PID_A1,
    issueCodes: ['normalized_legacy_residue', 'stage_a_invariant_failure'],
    decision: 'canonical_duplicate',
    deployedDescendantSha: options.deployedDescendantSha,
    accessBMergeSha: options.accessBMergeSha,
    rawPropertyIds: [PID_A1],
    canonicalPropertyIds: mariaCanonicalIds,
    authorityMode: byAccount.get(ACCOUNT_MARIA)?.authority_mode ?? '',
    authorityVersion: byAccount.get(ACCOUNT_MARIA)?.authority_version ?? 0,
    reason: 'canonical_duplicate_residue',
  });
  await recordRepairDisposition(pg, {
    preflightRunId: runId,
    accountId: ACCOUNT_FRANK,
    propertyId: PID_A1,
    issueCodes: ['normalized_legacy_residue', 'stage_a_invariant_failure'],
    decision: 'revoked_canonical_empty',
    deployedDescendantSha: options.deployedDescendantSha,
    accessBMergeSha: options.accessBMergeSha,
    rawPropertyIds: [PID_A1],
    canonicalPropertyIds: frankCanonicalIds,
    authorityMode: byAccount.get(ACCOUNT_FRANK)?.authority_mode ?? '',
    authorityVersion: byAccount.get(ACCOUNT_FRANK)?.authority_version ?? 0,
    reason: 'revoked_canonical_empty_residue',
  });
  return runId;
}

async function insertCanonicalAccount(
  pg: PGlite,
  accountId: string,
  userId: string,
  username: string,
  displayName: string,
  role: string,
  email: string,
): Promise<void> {
  await pg.query(`insert into auth.users(id,email) values ($1,$2)`, [userId, email]);
  await pg.query(
    `insert into public.accounts(
       id, username, password_hash, display_name, role, data_user_id
     ) values ($1,$3,'x',$4,$5,$2)`,
    [accountId, userId, username, displayName, role],
  );
}

async function insertStaff(
  pg: PGlite,
  id: string,
  propertyId: string,
  name: string,
  department: string,
  phone: string,
): Promise<void> {
  await pg.query(
    `insert into public.staff(
       id, property_id, name, phone, phone_lookup, language, is_senior,
       department, scheduled_today, weekly_hours, max_weekly_hours,
       max_days_per_week, days_worked_this_week, is_active
     ) values ($1,$2,$3,$4,$5,'en',false,$6,false,0,40,5,0,true)`,
    [id, propertyId, name, phone, phone.replace(/\D/g, '').slice(-10), department],
  );
}

async function propertyIds(pg: PGlite, accountId: string): Promise<string[]> {
  const result = await jsonRpc(
    pg,
    `select public.staxis_list_account_authorized_properties($1) as value`,
    [accountId],
  );
  return (result.propertyIds as string[] | undefined) ?? [];
}

async function recordRepairDisposition(
  pg: PGlite,
  values: {
    preflightRunId: string;
    accountId: string;
    propertyId: string;
    issueCodes: string[];
    issueIds?: string[];
    decision: string;
    operatorLabel?: string;
    accessBMergeSha?: string;
    deployedDescendantSha?: string;
    dispositionId?: string;
    rawPropertyIds: string[];
    rawScopeHash?: string;
    canonicalPropertyIds: string[];
    canonicalScopeHash?: string;
    authorityMode: string;
    authorityVersion: number;
    reason: string;
  },
): Promise<Record<string, unknown>> {
  const manifestCount = (await rows<{ count: number }>(
    pg,
    `select count(*)::integer as count
       from public.account_access_cutover_repair_manifests
      where preflight_run_id=$1`,
    [values.preflightRunId],
  ))[0]?.count ?? 0;
  if (manifestCount === 0) {
    const issueRows = await rows<{
      id: string;
      issue_code: string;
      account_id: string | null;
      property_id: string | null;
      details: Record<string, unknown>;
    }>(
      pg,
      `select id,issue_code,account_id,property_id,details
         from public.account_access_cutover_preflight_issues
        where run_id=$1 order by id`,
      [values.preflightRunId],
    );
    for (const issue of issueRows) {
      const propertyIds = Array.isArray(issue.details.propertyIds)
        ? issue.details.propertyIds.filter((value): value is string => typeof value === 'string')
        : [];
      const manifestPropertyId = issue.property_id ?? (propertyIds.length === 1 ? propertyIds[0] : null);
      await pg.query(
        `insert into public.account_access_cutover_repair_manifests(
           issue_id,preflight_run_id,source,issue_code,account_id,property_id,
           raw_property_ids,raw_scope_hash,stage_a_mapping,details
         ) values (
           $1,$2,'test-fixture',$3,$4,$5,$6::uuid[],
           public._staxis_stage_c_scope_hash($6::uuid[]),
           case when $3='stage_a_invariant_failure'
             then coalesce($7::jsonb #> '{stageAInvariant,sample}','[]'::jsonb)
             else '{}'::jsonb end,
           $7::jsonb
         ) on conflict (issue_id) do nothing`,
        [
          issue.id,
          values.preflightRunId,
          issue.issue_code,
          issue.account_id,
          manifestPropertyId,
          propertyIds,
          issue.details,
        ],
      );
    }
  }
  const operatorLabel = values.operatorLabel ?? 'production-residue-operator';
  const accessBMergeSha = values.accessBMergeSha ?? ACCESS_B_LIVE_SHA;
  const deployedDescendantSha = values.deployedDescendantSha ?? CURRENT_LIVE_DESCENDANT_SHA;
  const issueIds = values.issueIds ?? (await rows<{ issue_id: string; issue_code: string }>(
    pg,
    `select issue_id,issue_code
       from public.account_access_cutover_repair_manifests
      where preflight_run_id=$1
        and (
          issue_code='stage_a_invariant_failure'
          or (account_id=$2 and (property_id=$3 or property_id is null)
              and issue_code = any($4::text[]))
        )
      order by issue_code,issue_id`,
    [values.preflightRunId, values.accountId, values.propertyId, values.issueCodes],
    )).filter((row) => values.decision === 'admin_global' || row.issue_code !== 'stage_a_invariant_failure')
      .map((row) => row.issue_id);
  return jsonRpc(
    pg,
    `select public.staxis_access_stage_c_record_repair_disposition(
       $1,$2,$3,$4::text[],$5::uuid[],$6,$7,$8,$9,$10::uuid[],$11,$12,
       $13,$14::uuid[],$15,$16,$17,clock_timestamp(),$18
     ) as value`,
    [
      values.preflightRunId,
      values.accountId,
      values.propertyId,
      values.issueCodes,
      issueIds,
      values.decision,
      operatorLabel,
      accessBMergeSha,
      deployedDescendantSha,
      values.rawPropertyIds,
      values.rawScopeHash ?? sha256(values.rawPropertyIds.slice().sort().join(',')),
      values.authorityMode,
      values.authorityVersion,
      values.canonicalPropertyIds,
      values.canonicalScopeHash ?? sha256(values.canonicalPropertyIds.slice().sort().join(',')),
      0,
      values.reason,
      values.dispositionId ?? null,
    ],
  );
}

describe('Access Stage C final contract — real migration boundary', () => {
  describe('clean cutover and canonical runtime operations', () => {
    let pg: PGlite;
    let sharedDataDir: string;
    let report: { applied: string[]; failedAtRuntime: Array<{ file: string; error: string }> };

    before(async () => {
      sharedDataDir = mkdtempSync(join(tmpdir(), 'staxis-access-stage-c-'));
      const migrated = await applyMigrationsToPgliteWithHook(
        async ({ pg: hookPg, file }) => {
          if (file === MIGRATION) await seedStageCFixture(hookPg);
        },
        {
          dataDir: sharedDataDir,
          afterAccessStageCPreparation: async ({ pg: hookPg, file }) => {
            if (file === MIGRATION) await authorizeAccessStageCRelease(hookPg);
          },
        },
      );
      pg = migrated.pg;
      report = migrated.report;
      assert.ok(
        report.applied.includes(MIGRATION),
        JSON.stringify(report.failedAtRuntime.filter((entry) => entry.file === MIGRATION)),
      );
      assert.deepEqual(
        report.failedAtRuntime.filter((entry) => entry.file === MIGRATION),
        [],
      );
    });

    after(async () => {
      await pg?.close();
      if (sharedDataDir) rmSync(sharedDataDir, { recursive: true, force: true });
    });

    test('rejects every self-target scope mutation before state, bridges, or audit can change', async () => {
      const before = (await rows<{
        role: string;
        property_access: string[];
        authority_mode: string;
        authority_version: number;
        updated_at: string;
      }>(
        pg,
        `select account.role,account.property_access,state.authority_mode,
                state.authority_version,account.updated_at::text as updated_at
           from public.accounts account
           join public.account_authorization_state state on state.account_id=account.id
          where account.id=$1`,
        [ACCOUNT_ADMIN],
      ))[0];
      const bridgeCountBefore = Number((await rows<{ count: number }>(
        pg,
        `select count(*)::integer as count
           from public.account_property_authorization_bridges where account_id=$1`,
        [ACCOUNT_ADMIN],
      ))[0].count);
      const auditCountBefore = Number((await rows<{ count: number }>(
        pg,
        `select count(*)::integer as count
           from public.admin_audit_log
          where target_type='account' and target_id=$1`,
        [ACCOUNT_ADMIN],
      ))[0].count);
      assert.ok(before);

      for (const newRole of ['staff', 'admin']) {
        const result = await jsonRpc(
          pg,
          `select public.staxis_set_account_authorization_scope(
             $1,$1,'{}'::uuid[],$2,$3,$4,'Stage C self-target guard'
           ) as value`,
          [ACCOUNT_ADMIN, before.authority_version, before.role, newRole],
        );
        assert.deepEqual(result, { ok: false, status: 'forbidden', reason: 'self' });
      }
      const selfNoop = await jsonRpc(
        pg,
        `select public.staxis_set_account_authorization_scope(
           $1,$1,'{}'::uuid[],$2,$3,$3,'Stage C self-target no-op guard'
         ) as value`,
        [ACCOUNT_ADMIN, before.authority_version, before.role],
      );
      assert.deepEqual(selfNoop, { ok: false, status: 'forbidden', reason: 'self' });

      assert.deepEqual(
        (await rows<{
          role: string;
          property_access: string[];
          authority_mode: string;
          authority_version: number;
          updated_at: string;
        }>(
          pg,
          `select account.role,account.property_access,state.authority_mode,
                  state.authority_version,account.updated_at::text as updated_at
             from public.accounts account
             join public.account_authorization_state state on state.account_id=account.id
            where account.id=$1`,
          [ACCOUNT_ADMIN],
        ))[0],
        before,
      );
      assert.equal(
        Number((await rows<{ count: number }>(
          pg,
          `select count(*)::integer as count
             from public.account_property_authorization_bridges where account_id=$1`,
          [ACCOUNT_ADMIN],
        ))[0].count),
        bridgeCountBefore,
      );
      assert.equal(
        Number((await rows<{ count: number }>(
          pg,
          `select count(*)::integer as count
             from public.admin_audit_log
            where target_type='account' and target_id=$1`,
          [ACCOUNT_ADMIN],
        ))[0].count),
        auditCountBefore,
      );

      const target = (await rows<{
        role: string;
        authority_version: number;
        property_ids: string[];
      }>(
        pg,
        `select account.role,state.authority_version,
                coalesce(array_agg(authz.property_id order by authz.property_id)
                  filter (where authz.property_id is not null), '{}'::uuid[]) as property_ids
           from public.accounts account
           join public.account_authorization_state state on state.account_id=account.id
           left join lateral public._staxis_account_property_authorizations(account.id) authz on true
          where account.id=$1
          group by account.role,state.authority_version`,
        [ACCOUNT_HANK],
      ))[0];
      assert.ok(target);
      const updated = await jsonRpc(
        pg,
        `select public.staxis_set_account_authorization_scope(
           $1,$2,$3::uuid[],$4,$5,$6,'Stage C authorized other-account update'
         ) as value`,
        [ACCOUNT_ADMIN, ACCOUNT_HANK, target.property_ids, target.authority_version, target.role, 'maintenance'],
      );
      assert.equal(updated.ok, true);
      assert.equal(updated.status, 'updated');
      const restoredVersion = updated.authorityVersion as number;
      const restored = await jsonRpc(
        pg,
        `select public.staxis_set_account_authorization_scope(
           $1,$2,$3::uuid[],$4,$5,$6,'Stage C authorized other-account restore'
         ) as value`,
        [ACCOUNT_ADMIN, ACCOUNT_HANK, target.property_ids, restoredVersion, 'maintenance', target.role],
      );
      assert.equal(restored.ok, true);
      assert.equal(restored.status, 'updated');
    });

    test('proves the external 0425 prerequisite, final inventory, receipts, ACLs, RLS, and raw-writer retirement', async () => {
      const applied = await rows<MigrationRow>(
        pg,
        `select version, description from public.applied_migrations where version in ('0425','0426') order by version`,
      );
      assert.deepEqual(applied, [
        { version: '0425', description: LIVE_0425_DESCRIPTION },
        {
          version: '0426',
          description: 'Access Stage C canonical-only contract, final receipts, array teardown, and fail-closed enforcement',
        },
      ]);
      assert.equal(
        await rows<{ stage: string; enforcement_enabled: boolean; details: Record<string, unknown> }>(
          pg,
          `select stage, enforcement_enabled, details
             from public.account_access_cutover_status where id is true`,
        ).then(([row]) => row.stage),
        'C',
      );
      const status = (await rows<{ enforcement_enabled: boolean; details: Record<string, unknown> }>(
        pg,
        `select enforcement_enabled, details from public.account_access_cutover_status where id is true`,
      ))[0];
      assert.equal(status.enforcement_enabled, true);
      assert.equal(status.details.legacyArraysCleared, true);
      assert.equal(status.details.legacyTranslatorRetired, true);
      assert.equal(status.details.legacyImportRetired, true);
      const stageAInvariant = await rows<{ issue_count: number }>(
          pg,
          `select issue_count from public.account_access_cutover_invariant_runs
            where status = 'passed' order by checked_at desc limit 1`,
        );
      assert.ok(stageAInvariant[0], 'Stage A invariant evidence must be retained through the final cutover');
      assert.equal(
        stageAInvariant[0].issue_count,
        0,
      );

      const releaseReceipts = await rows<{
        id: string;
        operator_label: string;
        access_b_merge_sha: string;
        deployed_descendant_sha: string;
        attested_at: string;
        preflight_run_id: string;
        old_deployment_job: string;
        old_deployment_fence_evidence: string;
        old_deployment_fence_hash: string;
        old_deployment_fence_nonce: string;
        authorization_hash: string;
        status: string;
        consumed_at: string | null;
        consumed_session_id: string | null;
        consumed_preflight_run_id: string | null;
      }>(
        pg,
        `select id,operator_label,access_b_merge_sha,deployed_descendant_sha,
                attested_at,preflight_run_id,old_deployment_job,
                old_deployment_fence_evidence,old_deployment_fence_hash,
                old_deployment_fence_nonce,authorization_hash,status,consumed_at,
                consumed_session_id,consumed_preflight_run_id
           from public.account_access_cutover_release_receipts
          order by created_at`,
      );
      assert.equal(releaseReceipts.length, 1);
      const releaseReceipt = releaseReceipts[0];
      assert.equal(releaseReceipt.operator_label, 'pglite-stage-c-operator');
      assert.equal(releaseReceipt.access_b_merge_sha, 'ec83bca6dab74a52dfb251d04be11d5c7427703f');
      assert.equal(releaseReceipt.deployed_descendant_sha, '442fb98d632521ea33346d5c8a97014248a31fa0');
      assert.ok(releaseReceipt.attested_at);
      assert.equal(releaseReceipt.preflight_run_id, status.details.preflightRunId);
      assert.equal(releaseReceipt.old_deployment_job, 'pglite-access-stage-c-test');
      assert.equal(releaseReceipt.old_deployment_fence_hash, sha256(releaseReceipt.old_deployment_fence_evidence));
      assert.equal(releaseReceipt.authorization_hash, sha256('pglite-access-stage-c-release-token'));
      assert.equal(releaseReceipt.status, 'consumed');
      assert.ok(releaseReceipt.consumed_at);
      assert.ok(releaseReceipt.consumed_session_id);
      assert.equal(releaseReceipt.consumed_preflight_run_id, releaseReceipt.preflight_run_id);

      const finalReceiptRows = await rows<{
        account_id: string;
        source_property_ids: string[];
        source_property_count: number;
        source_scope_hash: string;
        canonical_property_ids: string[];
        canonical_property_count: number;
        bridge_count: number;
      }>(
        pg,
        `select account_id,source_property_ids,source_property_count,source_scope_hash,
                canonical_property_ids,canonical_property_count,bridge_count
           from public.account_access_cutover_final_receipts
          order by account_id`,
      );
      assert.ok(finalReceiptRows.length > 0);
      for (const finalReceipt of finalReceiptRows) {
        assert.equal(finalReceipt.source_property_count, finalReceipt.source_property_ids.length);
        assert.equal(finalReceipt.canonical_property_count, finalReceipt.canonical_property_ids.length);
        assert.match(finalReceipt.source_scope_hash, /^[0-9a-f]{64}$/);
        assert.equal(finalReceipt.source_scope_hash, sha256(finalReceipt.source_property_ids.join(',')));
        assert.ok(finalReceipt.bridge_count >= 0);
      }
      const finalReceiptDigest = sha256(
        finalReceiptRows
          .map((receipt) => `${receipt.account_id}:${receipt.source_scope_hash}`)
          .join('|'),
      );
      assert.equal(
        sha256(
          (await rows<{ account_id: string; source_scope_hash: string }>(
            pg,
            `select account_id,source_scope_hash
               from public.account_access_cutover_final_receipts
              order by account_id`,
          )).map((receipt) => `${receipt.account_id}:${receipt.source_scope_hash}`).join('|'),
        ),
        finalReceiptDigest,
      );
      assert.equal(Number(status.details.finalReceipts), finalReceiptRows.length);
      assert.deepEqual(
        (await rows<{ dispositions: number; repairs: number }>(
          pg,
          `select
             (select count(*)::integer from public.account_access_cutover_repair_dispositions) as dispositions,
             (select count(*)::integer from public.account_access_cutover_repair_receipts) as repairs`,
        ))[0],
        { dispositions: 0, repairs: 0 },
        'clean preflight must not create repair dispositions or repair receipts',
      );

      const raw = await rows<{ non_empty: number; null_count: number }>(
        pg,
        `select count(*) filter (where cardinality(coalesce(property_access,'{}'::uuid[])) > 0)::integer as non_empty,
                count(*) filter (where property_access is null)::integer as null_count
           from public.accounts`,
      );
      assert.deepEqual(raw[0], { non_empty: 0, null_count: 0 });
      const finalEvidence = (await rows<{ details: Record<string, unknown> }>(
        pg,
        `select details from public.account_access_cutover_final_receipts
          order by account_id limit 1`,
      ))[0]?.details;
      assert.ok(finalEvidence?.evidenceBefore, 'final receipt must retain before identity/topology evidence');
      assert.ok(finalEvidence?.evidenceAfter, 'final receipt must retain after identity/topology evidence');
      assert.match(String(finalEvidence?.evidenceBeforeHash), /^[0-9a-f]{64}$/);
      assert.match(String(finalEvidence?.evidenceAfterHash), /^[0-9a-f]{64}$/);

      const producerFenceTables = await rows<{ table_name: string; trigger_name: string }>(
        pg,
        `select trigger_relation.relname as table_name, trigger_row.tgname as trigger_name
           from pg_trigger trigger_row
           join pg_class trigger_relation on trigger_relation.oid=trigger_row.tgrelid
           join pg_namespace trigger_schema on trigger_schema.oid=trigger_relation.relnamespace
          where trigger_schema.nspname='public'
            and not trigger_row.tgisinternal
            and trigger_row.tgname like '%000_stage_c_producer%'
          order by table_name`,
      );
      assert.deepEqual(
        producerFenceTables.map((row) => row.table_name),
        [
          'account_access_cutover_legacy_write_events',
          'account_invites',
          'account_lifecycle_intents',
          'accounts',
          'join_requests',
          'organization_access_requests',
          'organization_invitations',
        ],
        'every pending-operation and legacy-evidence producer must share the cutover fence',
      );
      const rawColumnPrivilege = (await rows<{ service_update: boolean; service_username_update: boolean }>(
        pg,
        `select has_column_privilege('service_role','public.accounts','property_access','UPDATE') as service_update,
                has_column_privilege('service_role','public.accounts','username','UPDATE') as service_username_update`,
      ))[0];
      assert.deepEqual(rawColumnPrivilege, { service_update: false, service_username_update: false });
      await assert.rejects(
        pg.exec(`begin; set local role service_role;
          select set_config('staxis.access_stage_c_repair_disposition_id','00000000-0000-0000-0000-000000000001',true);
          update public.accounts set property_access='{}'::uuid[] where id='${ACCOUNT_ADMIN}';`),
        /permission denied|final access contract rejects|property_access/i,
      );
      await pg.exec('rollback;').catch(() => undefined);

      for (const signature of [
        'public.staxis_grant_property_access(uuid,uuid)',
        'public.staxis_remove_property_access(uuid,uuid)',
        'public.staxis_remove_property_access_guarded(uuid,uuid,text,timestamptz)',
        'public.staxis_remove_property_access_guarded_v2(uuid,uuid,text,uuid,uuid,text,timestamptz,text)',
        'public._staxis_stage_b_import_legacy_scope(uuid,text)',
        'public.staxis_translate_legacy_property_access(uuid,uuid[],text)',
        'public._staxis_reconcile_property_trigger()',
        'public._staxis_reconcile_account_trigger()',
        'public._staxis_reconcile_legacy_organization_access(uuid,uuid)',
        'public.staxis_reconcile_legacy_organization_access(uuid,uuid)',
      ]) {
        assert.equal(
          (await rows<{ present: string | null }>(
            pg,
            `select to_regprocedure($1) as present`,
            [signature],
          ))[0].present,
          null,
          `${signature} must be retired after final enforcement`,
        );
      }
      await assert.rejects(
        pg.query(`select public.staxis_grant_property_access($1,$2)`, [ACCOUNT_ADMIN, PID_L1]),
        /function public\.staxis_grant_property_access\(.*does not exist/i,
        'a direct obsolete grant RPC must fail closed after the final cutover',
      );
      for (const signature of [
        'public.staxis_accept_account_invite(text,uuid,uuid,text,text)',
        'public.staxis_grant_existing_account_invite_guarded(uuid,uuid,uuid,uuid,text,text,uuid,text,uuid[],uuid,text)',
        'public.staxis_decide_staff_join_request(uuid,uuid,uuid,text)',
        'public.staxis_finalize_join_code_signup(uuid,text,uuid,integer,uuid,text,text,text,text,text,text)',
      ]) {
        assert.notEqual(
          (await rows<{ present: string | null }>(pg, `select to_regprocedure($1) as present`, [signature]))[0].present,
          null,
          `${signature} must remain available to runtime flows`,
        );
      }
      const triggerNames = await rows<{ tgname: string }>(
        pg,
        `select tgname from pg_trigger
          where tgrelid = 'public.accounts'::regclass and not tgisinternal`,
      );
      assert.ok(triggerNames.some(({ tgname }) => tgname.includes('final_legacy_property_access_fence')));
      assert.equal(
        await rows<{ count: number }>(
          pg,
          `select count(*)::integer as count from pg_trigger
            where tgrelid = 'public.accounts'::regclass
              and not tgisinternal
              and tgname ilike '%translate%legacy%'`,
        ).then(([row]) => Number(row.count)),
        0,
      );
      const propertyTriggerNames = await rows<{ tgname: string }>(
        pg,
        `select tgname from pg_trigger
          where tgrelid = 'public.properties'::regclass and not tgisinternal`,
      );
      assert.ok(propertyTriggerNames.some(({ tgname }) => tgname === 'trg_properties_ensure_canonical_property_topology'));
      assert.ok(!propertyTriggerNames.some(({ tgname }) => tgname === 'trg_properties_reconcile_legacy_organization_access'));

      const rawReaders = await rows<{ proname: string; identity: string }>(
        pg,
        `select routine.proname, pg_get_function_identity_arguments(routine.oid) as identity
          from pg_proc routine
           join pg_namespace namespace on namespace.oid = routine.pronamespace
          where namespace.nspname = 'public'
            and regexp_replace(routine.prosrc, '--[^\\n]*', '', 'g')
                  ~* '[[:alnum:]_]+[[:space:]]*[.][[:space:]]*property_access'`,
      );
      assert.deepEqual(
        rawReaders.map((row) => `${row.proname}(${row.identity})`).sort(),
        [
          '_staxis_reject_final_legacy_property_access_write()',
          'staxis_preflight_authorization_cutover_stage_c()',
        ],
        'only the final fence and report-only preflight may inspect the retired column',
      );
      assert.deepEqual(
        await rows<{ table_name: string; policy_name: string }>(
          pg,
          `select schemaname || '.' || tablename as table_name, policyname as policy_name
             from pg_policies
            where schemaname = 'public'
              and (coalesce(qual,'') || ' ' || coalesce(with_check,''))
                    ~* '[[:alnum:]_]+[.]property_access'`,
        ),
        [],
        'active RLS policies must not read the retired property_access authority',
      );
      assert.deepEqual(
        await rows<{ view_name: string }>(
          pg,
          `select schemaname || '.' || viewname as view_name
             from pg_views
            where schemaname = 'public'
              and definition ~* '[[:alnum:]_]+[.]property_access'`,
        ),
        [],
        'active views must not read the retired property_access authority',
      );

      const receiptShape = (await rows<{ has_fk: boolean; rls: boolean; policy_qual: string }>(
        pg,
        `select exists (
                  select 1 from pg_constraint constraint_row
                   where constraint_row.conrelid = 'public.account_access_cutover_final_receipts'::regclass
                     and constraint_row.contype = 'f'
                     and constraint_row.confrelid = 'public.accounts'::regclass
                ) as has_fk,
                relation.relrowsecurity as rls,
                coalesce(policy.qual::text,'') as policy_qual
           from pg_class relation
           left join pg_policies policy
             on policy.schemaname = 'public'
            and policy.tablename = 'account_access_cutover_final_receipts'
          where relation.oid = 'public.account_access_cutover_final_receipts'::regclass`,
      ))[0];
      assert.deepEqual(receiptShape, { has_fk: false, rls: true, policy_qual: 'false' });
      const receiptAcl = (await rows<{ anon_select: boolean; service_select: boolean; service_execute: boolean; anon_execute: boolean; search_path: string[] | null }>(
        pg,
        `select has_table_privilege('anon','public.account_access_cutover_final_receipts','select') as anon_select,
                has_table_privilege('service_role','public.account_access_cutover_final_receipts','select') as service_select,
                has_function_privilege('service_role','public.staxis_access_stage_c_final_receipt(uuid)','execute') as service_execute,
                has_function_privilege('anon','public.staxis_access_stage_c_final_receipt(uuid)','execute') as anon_execute,
                routine.proconfig as search_path
           from pg_proc routine
          where routine.oid = 'public.staxis_access_stage_c_final_receipt(uuid)'::regprocedure`,
      ))[0];
      assert.equal(receiptAcl.anon_select, false);
      assert.equal(receiptAcl.service_select, false);
      assert.equal(receiptAcl.service_execute, true);
      assert.equal(receiptAcl.anon_execute, false);
      assert.ok(receiptAcl.search_path?.some((setting) => setting.replace(/\s+/g, '') === 'search_path=pg_catalog,public'));

      const releaseShape = (await rows<{
        rls: boolean;
        policy_qual: string;
        anon_select: boolean;
        authenticated_select: boolean;
        service_select: boolean;
      }>(
        pg,
        `select relation.relrowsecurity as rls,
                coalesce(policy.qual::text,'') as policy_qual,
                has_table_privilege('anon','public.account_access_cutover_release_receipts','select') as anon_select,
                has_table_privilege('authenticated','public.account_access_cutover_release_receipts','select') as authenticated_select,
                has_table_privilege('service_role','public.account_access_cutover_release_receipts','select') as service_select
           from pg_class relation
           left join pg_policies policy
             on policy.schemaname='public'
            and policy.tablename='account_access_cutover_release_receipts'
          where relation.oid='public.account_access_cutover_release_receipts'::regclass`,
      ))[0];
      assert.deepEqual(releaseShape, {
        rls: true,
        policy_qual: 'false',
        anon_select: false,
        authenticated_select: false,
        service_select: true,
      });
      const releaseAcl = await rows<{
        identity: string;
        service_execute: boolean;
        anon_execute: boolean;
        search_path: string[] | null;
      }>(
        pg,
        `select pg_get_function_identity_arguments(routine.oid) as identity,
                has_function_privilege('service_role',routine.oid,'execute') as service_execute,
                has_function_privilege('anon',routine.oid,'execute') as anon_execute,
                routine.proconfig as search_path
           from pg_proc routine
          where routine.oid = any(array[
            'public.staxis_access_stage_c_record_release_receipt(text,text,text,timestamptz,uuid,text,text,text,text,text,uuid)'::regprocedure,
            'public.staxis_access_stage_c_release_receipt(uuid)'::regprocedure,
            'public.staxis_access_stage_c_consume_release()'::regprocedure
          ])
          order by routine.oid`,
      );
      assert.equal(releaseAcl.length, 3);
      for (const acl of releaseAcl) {
        assert.equal(acl.service_execute, true, acl.identity);
        assert.equal(acl.anon_execute, false, acl.identity);
        assert.ok(acl.search_path?.some((setting) => setting.replace(/\s+/g, '') === 'search_path=pg_catalog,public'));
      }
      const repairAcl = await rows<{
        table_name: string;
        rls: boolean;
        policy_qual: string;
        anon_select: boolean;
        service_select: boolean;
        service_insert: boolean;
      }>(
        pg,
        `select relation.relname as table_name,
                relation.relrowsecurity as rls,
                coalesce(policy.qual::text,'') as policy_qual,
                has_table_privilege('anon',relation.oid,'select') as anon_select,
                has_table_privilege('service_role',relation.oid,'select') as service_select,
                has_table_privilege('service_role',relation.oid,'insert') as service_insert
           from pg_class relation
           left join pg_policies policy
             on policy.schemaname='public'
            and policy.tablename=relation.relname
          where relation.oid in (
            'public.account_access_cutover_repair_dispositions'::regclass,
            'public.account_access_cutover_repair_receipts'::regclass
          )
          order by relation.relname`,
      );
      assert.deepEqual(repairAcl, [
        {
          table_name: 'account_access_cutover_repair_dispositions',
          rls: true,
          policy_qual: 'false',
          anon_select: false,
          service_select: true,
          service_insert: false,
        },
        {
          table_name: 'account_access_cutover_repair_receipts',
          rls: true,
          policy_qual: 'false',
          anon_select: false,
          service_select: true,
          service_insert: false,
        },
      ]);
      const repairEvidenceAcl = (await rows<{
        service_execute: boolean;
        anon_execute: boolean;
        search_path: string[] | null;
      }>(
        pg,
        `select has_function_privilege('service_role','public.staxis_access_stage_c_repair_evidence(uuid)','execute') as service_execute,
                has_function_privilege('anon','public.staxis_access_stage_c_repair_evidence(uuid)','execute') as anon_execute,
                routine.proconfig as search_path
           from pg_proc routine
          where routine.oid='public.staxis_access_stage_c_repair_evidence(uuid)'::regprocedure`,
      ))[0];
      assert.deepEqual({
        service_execute: repairEvidenceAcl.service_execute,
        anon_execute: repairEvidenceAcl.anon_execute,
      }, { service_execute: true, anon_execute: false });
      assert.ok(repairEvidenceAcl.search_path?.some((setting) => setting.replace(/\s+/g, '') === 'search_path=pg_catalog,public'));
      assert.equal(
        (await rows<{ present: string | null }>(
          pg,
          `select to_regprocedure($1) as present`,
          ['public.staxis_access_stage_c_record_repair_disposition(uuid,uuid,uuid,text[],uuid[],text,text,text,text,uuid[],text,text,bigint,uuid[],text,bigint,text,timestamptz,uuid)'],
        ))[0].present,
        null,
        'the operator disposition writer must retire after the final suffix',
      );
      const releaseRead = await jsonRpc(
        pg,
        `select public.staxis_access_stage_c_release_receipt($1) as value`,
        [releaseReceipt.id],
      );
      assert.equal(releaseRead.id, releaseReceipt.id);
      assert.equal(releaseRead.status, 'consumed');
      await assert.rejects(
        pg.query(
          `update public.account_access_cutover_release_receipts
              set operator_label='tampered' where id=$1`,
          [releaseReceipt.id],
        ),
        /immutable after consumption/i,
      );

      const recoveryAcl = (await rows<{ service_execute: boolean; anon_execute: boolean; service_select: boolean; anon_select: boolean }>(
        pg,
        `select has_function_privilege('service_role','public.staxis_access_stage_c_freeze_and_forward(text,text,uuid)','execute') as service_execute,
                has_function_privilege('anon','public.staxis_access_stage_c_freeze_and_forward(text,text,uuid)','execute') as anon_execute,
                has_table_privilege('service_role','public.account_access_cutover_recovery_actions','select') as service_select,
                has_table_privilege('anon','public.account_access_cutover_recovery_actions','select') as anon_select`,
      ))[0];
      assert.deepEqual(recoveryAcl, {
        service_execute: true,
        anon_execute: false,
        service_select: true,
        anon_select: false,
      });

      const canonicalAcl = await rows<{
        identity: string;
        service_execute: boolean;
        anon_execute: boolean;
        authenticated_execute: boolean;
        search_path: string[] | null;
      }>(
        pg,
        `select pg_get_function_identity_arguments(routine.oid) as identity,
                has_function_privilege('service_role', routine.oid, 'execute') as service_execute,
                has_function_privilege('anon', routine.oid, 'execute') as anon_execute,
                has_function_privilege('authenticated', routine.oid, 'execute') as authenticated_execute,
                routine.proconfig as search_path
           from pg_proc routine
          where routine.oid = any(array[
            'public.staxis_delete_property_and_legacy_accounts(uuid,uuid,text)'::regprocedure,
            'public.staxis_accept_account_invite(text,uuid,uuid,text,text)'::regprocedure,
            'public.staxis_grant_existing_account_invite_guarded(uuid,uuid,uuid,uuid,text,text,uuid,text,uuid[],uuid,text)'::regprocedure,
            'public.staxis_decide_staff_join_request(uuid,uuid,uuid,text)'::regprocedure,
            'public.staxis_finalize_join_code_signup(uuid,text,uuid,integer,uuid,text,text,text,text,text,text)'::regprocedure,
            'public.staxis_remove_property_access_authoritative(uuid,uuid,text,uuid,uuid,text,bigint,timestamptz,text)'::regprocedure
          ])
          order by routine.oid`,
      );
      assert.equal(canonicalAcl.length, 6);
      for (const acl of canonicalAcl) {
        assert.equal(acl.service_execute, true, acl.identity);
        assert.equal(acl.anon_execute, false, acl.identity);
        assert.equal(acl.authenticated_execute, false, acl.identity);
        assert.ok(
          acl.search_path?.some((setting) => [
            'search_path=public,pg_temp',
            'search_path=pg_catalog,public',
          ].includes(setting.replace(/\s+/g, ''))),
          `${acl.identity} must pin search_path`,
        );
      }

      const sourceRoot = join(__dirname, '..', '..', '..');
      const source = activeSourceText(
        join(sourceRoot, 'src', 'app'),
        join(sourceRoot, 'src', 'lib'),
        join(sourceRoot, 'scripts'),
        join(sourceRoot, 'workers'),
        join(sourceRoot, 'cron'),
        join(sourceRoot, 'support'),
        join(sourceRoot, 'src', 'workers'),
        join(sourceRoot, 'src', 'cron'),
        join(sourceRoot, 'src', 'support'),
      );
      assert.deepEqual(
        source.split('\n').filter((line) =>
          !/p_expected(?:_old|_new)?_property_access\s*:/.test(line)
          && (/(?:accounts\.)?property_access\b/.test(line) || /['"]property_access['"]/.test(line)),
        ),
        [],
        'active app, script, worker, cron, and support runtime source must not read or write the raw property_access column',
      );
      const customerGates = (await rows<{
        maria_a: boolean;
        maria_b: boolean;
        wanda_l: boolean;
        hank_a: boolean;
        admin_b: boolean;
      }>(
        pg,
        `select
           public.staxis_account_reaches_property($1,$2) as maria_a,
           public.staxis_account_reaches_property($1,$3) as maria_b,
           public.staxis_account_reaches_property($4,$5) as wanda_l,
           public.staxis_account_reaches_property($6,$2) as hank_a,
           public.staxis_account_reaches_property($7,$3) as admin_b`,
        [UID_MARIA, PID_A1, PID_B1, UID_WANDA, PID_L1, UID_HANK, UID_ADMIN],
      ))[0];
      assert.deepEqual(customerGates, {
        maria_a: true,
        maria_b: false,
        wanda_l: true,
        hank_a: false,
        admin_b: true,
      });
      for (const obsolete of [
        'staxis_grant_property_access',
        'staxis_remove_property_access',
        'staxis_remove_property_access_guarded',
        'staxis_remove_property_access_guarded_v2',
        'staxis_translate_legacy_property_access',
        '_staxis_translate_legacy_property_access_trigger',
        '_staxis_reconcile_property_trigger',
        '_staxis_reconcile_account_trigger',
        '_staxis_reconcile_legacy_organization_access',
        'staxis_reconcile_legacy_organization_access',
      ]) {
        assert.doesNotMatch(source, new RegExp(`\\b${obsolete}\\b`), `active runtime source still names ${obsolete}`);
      }
      for (const canonical of [
        'staxis_delete_property_and_legacy_accounts',
        'staxis_accept_account_invite',
        'staxis_grant_existing_account_invite_guarded',
        'staxis_decide_staff_join_request',
        'staxis_finalize_join_code_signup',
      ]) {
        assert.match(source, new RegExp(`\\b${canonical}\\b`));
      }
    });

    test('publishes the shared-producer and exclusive-cutover fence contract', async () => {
      const producerFunction = (await rows<{ definition: string }>(
        pg,
        `select pg_get_functiondef('public._staxis_stage_c_producer_lock()'::regprocedure) as definition`,
      ))[0].definition;
      assert.match(producerFunction, /pg_advisory_xact_lock_shared/i);
      assert.doesNotMatch(producerFunction, /pg_try_advisory_xact_lock/i);
      assert.match(producerFunction, /staxis\.access\.stage_c\.cutover/);
      const producerAcl = (await rows<{
        service_execute: boolean;
        anon_execute: boolean;
        authenticated_execute: boolean;
        search_path: string[] | null;
      }>(
        pg,
        `select has_function_privilege('service_role',routine.oid,'execute') as service_execute,
                has_function_privilege('anon',routine.oid,'execute') as anon_execute,
                has_function_privilege('authenticated',routine.oid,'execute') as authenticated_execute,
                routine.proconfig as search_path
           from pg_proc routine
          where routine.oid='public._staxis_stage_c_producer_lock()'::regprocedure`,
      ))[0];
      assert.equal(producerAcl.service_execute, false);
      assert.equal(producerAcl.anon_execute, false);
      assert.equal(producerAcl.authenticated_execute, false);
      assert.ok(producerAcl.search_path?.some((setting) => setting.replace(/\s+/g, '') === 'search_path=pg_catalog,public'));
      const migrationSource = readFileSync(
        join(process.cwd(), 'supabase', 'migrations', MIGRATION),
        'utf8',
      );
      assert.match(
        migrationSource,
        /begin;[\s\S]*?pg_catalog\.pg_advisory_xact_lock\([\s\S]*?staxis\.access\.stage_c\.cutover/,
        'the suffix must take the exclusive half of the producer protocol',
      );
      const cutoverLockKey = (await rows<{ locked: boolean }>(
        pg,
        `select pg_try_advisory_xact_lock(
           pg_catalog.hashtextextended('staxis.access.stage_c.cutover', 0)
         ) as locked`,
      ))[0].locked;
      assert.equal(cutoverLockKey, true, 'the finalizer must be able to take the producer lock in its own session');
      await pg.exec('commit;').catch(() => undefined);
    });

    test('requires a fresh consumed release receipt and rolls back missing, stale, reused, wrong-token, and wrong-SHA gates', async () => {
      const before = (await rows<{ stage: string; enforcement_enabled: boolean; final_receipts: number }>(
        pg,
        `select status.stage, status.enforcement_enabled,
                (select count(*)::integer from public.account_access_cutover_final_receipts) as final_receipts
           from public.account_access_cutover_status status
          where status.id is true`,
      ))[0];
      const release = (await rows<{ id: string; preflight_run_id: string }>(
        pg,
        `select id,preflight_run_id from public.account_access_cutover_release_receipts
          where status='consumed' order by created_at limit 1`,
      ))[0];
      assert.ok(release);

      await pg.query(`select set_config('staxis.access_stage_c_release_id','',false)`);
      await pg.query(`select set_config('staxis.access_stage_c_release_token','',false)`);
      await pg.query(`select set_config('staxis.access_stage_c_release_nonce','',false)`);
      await assert.rejects(
        pg.query(`select public.staxis_access_stage_c_consume_release()`),
        /requires a same-session receipt id, authorization token, nonce/i,
      );

      const preflightRunId = release.preflight_run_id;
      const wrongShaCount = Number((await rows<{ count: number }>(
        pg,
        `select count(*)::integer as count from public.account_access_cutover_release_receipts`,
      ))[0].count);
      await assert.rejects(
        jsonRpc(
          pg,
          `select public.staxis_access_stage_c_record_release_receipt(
             'wrong-sha-operator','0000000000000000000000000000000000000000',
             '442fb98d632521ea33346d5c8a97014248a31fa0',clock_timestamp(),$1,
             'wrong-sha-job','wrong-sha-evidence',$2,'wrong-sha-nonce-123456','wrong-sha-token-123456'
           ) as value`,
          [preflightRunId, sha256('wrong-sha-evidence')],
        ),
        /wrong Access B SHA/i,
      );
      assert.equal(
        Number((await rows<{ count: number }>(
          pg,
          `select count(*)::integer as count from public.account_access_cutover_release_receipts`,
        ))[0].count),
        wrongShaCount,
      );

      const staleToken = 'stale-release-token-123456';
      const staleNonce = 'stale-release-nonce-123456';
      const staleEvidence = 'stale external deployment fence evidence';
      const stale = await jsonRpc(
        pg,
        `select public.staxis_access_stage_c_record_release_receipt(
           'stale-operator','ec83bca6dab74a52dfb251d04be11d5c7427703f',
           '442fb98d632521ea33346d5c8a97014248a31fa0',$1,$2,
           'stale-job',$3,$4,$5,$6
         ) as value`,
        [new Date(Date.now() - 24 * 60 * 60_000).toISOString(), preflightRunId, staleEvidence, sha256(staleEvidence), staleNonce, staleToken],
      );
      await pg.query(
        `select set_config('staxis.access_stage_c_release_id',$1,false),
                set_config('staxis.access_stage_c_release_token',$2,false),
                set_config('staxis.access_stage_c_release_nonce',$3,false)`,
        [String(stale.receiptId), staleToken, staleNonce],
      );
      await assert.rejects(
        pg.query(`select public.staxis_access_stage_c_consume_release()`),
        /stale, fenced for another session, or has the wrong deployment evidence/i,
      );

      const freshToken = 'fresh-release-token-123456';
      const freshNonce = 'fresh-release-nonce-123456';
      const freshEvidence = 'fresh external deployment fence evidence';
      const fresh = await jsonRpc(
        pg,
        `select public.staxis_access_stage_c_record_release_receipt(
           'fresh-operator','ec83bca6dab74a52dfb251d04be11d5c7427703f',
           '442fb98d632521ea33346d5c8a97014248a31fa0',clock_timestamp(),$1,
           'fresh-job',$2,$3,$4,$5
         ) as value`,
        [preflightRunId, freshEvidence, sha256(freshEvidence), freshNonce, freshToken],
      );
      await pg.query(
        `select set_config('staxis.access_stage_c_release_id',$1,false),
                set_config('staxis.access_stage_c_release_token',$2,false),
                set_config('staxis.access_stage_c_release_nonce',$3,false)`,
        [String(fresh.receiptId), 'wrong-fresh-token-123456', freshNonce],
      );
      await assert.rejects(
        pg.query(`select public.staxis_access_stage_c_consume_release()`),
        /authorization token does not match/i,
      );
      await pg.query(`select set_config('staxis.access_stage_c_release_token',$1,false)`, [freshToken]);
      const consumedFresh = await jsonRpc(
        pg,
        `select public.staxis_access_stage_c_consume_release() as value`,
      );
      assert.equal(consumedFresh.status, 'consumed');
      await assert.rejects(
        pg.query(`select public.staxis_access_stage_c_consume_release()`),
        /already consumed/i,
      );

      assert.deepEqual(
        (await rows<{ stage: string; enforcement_enabled: boolean; final_receipts: number }>(
          pg,
          `select status.stage, status.enforcement_enabled,
                  (select count(*)::integer from public.account_access_cutover_final_receipts) as final_receipts
             from public.account_access_cutover_status status
            where status.id is true`,
        ))[0],
        before,
        'every rejected release gate must leave final authority unchanged',
      );
    });

    test('rejects empty and update writes while preserving immutable receipts and named recovery evidence', async () => {
      const emptyInsertUser = 'c4261000-0000-4000-8000-000000000007';
      await pg.query(`insert into auth.users(id,email) values ($1,'empty-write@example.test')`, [emptyInsertUser]);
      const inserted = await rows<{ property_access: string[] | null }>(
        pg,
        `insert into public.accounts(id,username,password_hash,display_name,role,data_user_id)
         values ('c4260000-0000-4000-8000-000000000007','empty-write','x','Empty Write','front_desk',$1)
         returning property_access`,
        [emptyInsertUser],
      );
      assert.equal(inserted[0].property_access, null);
      await assert.rejects(
        pg.query(
          `insert into public.accounts(id,username,password_hash,display_name,role,property_access,data_user_id)
           values ('c4260000-0000-4000-8000-000000000008','explicit-empty','x','Explicit Empty','front_desk','{}',$1)`,
          [emptyInsertUser],
        ),
        /final access contract rejects accounts\.property_access writes/i,
      );
      await assert.rejects(
        pg.query(`update public.accounts set property_access = '{}'::uuid[] where id = $1`, [ACCOUNT_WANDA]),
        /final access contract rejects all accounts\.property_access writes/i,
      );
      await assert.rejects(
        pg.query(`select public.staxis_remove_property_access($1,$2)`, [ACCOUNT_ADMIN, PID_L1]),
        /function public\.staxis_remove_property_access\(.*does not exist/i,
        'a direct obsolete revoke RPC must fail closed after the final cutover',
      );

      const receipt = await jsonRpc(
        pg,
        `select public.staxis_access_stage_c_final_receipt($1) as value`,
        [ACCOUNT_WANDA],
      );
      assert.equal(receipt.account_id, ACCOUNT_WANDA);
      assert.deepEqual(receipt.source_property_ids, [PID_L1]);
      await assert.rejects(
        pg.query(`update public.account_access_cutover_final_receipts set details = '{}' where account_id = $1`, [ACCOUNT_WANDA]),
        /final receipts are immutable/i,
      );
      await assert.rejects(
        pg.query(`delete from public.account_access_cutover_final_receipts where account_id = $1`, [ACCOUNT_WANDA]),
        /final receipts are immutable/i,
      );

      const recovery = await jsonRpc(
        pg,
        `select public.staxis_access_stage_c_freeze_and_forward($1,$2,null) as value`,
        ['stage-c-test-operator', 'stage-c test recovery evidence'],
      );
      assert.equal(recovery.ok, true);
      assert.equal(recovery.authorityChanged, false);
      const recoveryEvidence = await jsonRpc(
        pg,
        `select public.staxis_access_stage_c_recovery_evidence(null) as value`,
      );
      assert.ok(Array.isArray(recoveryEvidence));
      assert.equal((recoveryEvidence as unknown[]).length, 1);
    });

    test('preserves canonical invite acceptance, existing-account grant, join approval, onboarding, lifecycle CAS, detach, and idempotency', async () => {
      await insertStaff(pg, INVITE_STAFF, PID_L1, 'Invite Person', 'housekeeping', '512-555-1001');
      await pg.query(`insert into auth.users(id,email) values ($1,'invite-person@example.test')`, [INVITE_USER]);
      const inviteToken = 'a'.repeat(64);
      const inviteClaim = 'c4267000-0000-4000-8000-000000000001';
      await pg.query(
        `insert into public.account_invites(
           hotel_id,email,role,token_hash,expires_at,invited_by,
           target_staff_id,acceptance_claim_token,acceptance_claimed_at
         ) values ($1,'invite-person@example.test','housekeeping',$2,now()+interval '1 day',$3,$4,$5,now())`,
        [PID_L1, inviteToken, ACCOUNT_WANDA, INVITE_STAFF, inviteClaim],
      );
      const accepted = await jsonRpc(
        pg,
        `select public.staxis_accept_account_invite($1,$2,$3,'invite-person','Invite Person') as value`,
        [inviteToken, inviteClaim, INVITE_USER],
      );
      assert.equal(accepted.ok, true);
      assert.equal(accepted.normalized, true);
      const acceptedAccountId = String(accepted.accountId);
      assert.equal((await propertyIds(pg, acceptedAccountId)).includes(PID_L1), true);
      assert.equal((await rows<{ count: number }>(
        pg,
        `select count(*)::integer as count from public.account_property_staff_links
          where account_id=$1 and property_id=$2 and staff_id=$3 and is_active`,
        [acceptedAccountId, PID_L1, INVITE_STAFF],
      ))[0].count, 1);
      assert.equal((await rows<{ property_access: string[] | null }>(pg, `select property_access from accounts where id=$1`, [acceptedAccountId]))[0].property_access, null);

      await insertStaff(pg, GRANT_STAFF, PID_A1, 'Grant Person', 'front_desk', '512-555-1002');
      await insertCanonicalAccount(pg, GRANT_ACCOUNT, GRANT_USER, 'grant-person', 'Grant Person', 'front_desk', 'grant-person@example.test');
      const granted = await jsonRpc(
        pg,
        `select public.staxis_grant_existing_account_invite_guarded(
           $1,$2,$3,$4,'grant-person@example.test','front_desk',$5,'property',$6,$7,'stage-c-grant'
         ) as value`,
        [ACCOUNT_MARIA, UID_MARIA, PID_A1, GRANT_ACCOUNT, ORG_A, [PID_A1], GRANT_STAFF],
      );
      assert.equal(granted.ok, true, JSON.stringify(granted));
      assert.equal(granted.normalized, true);
      assert.equal((await propertyIds(pg, GRANT_ACCOUNT)).includes(PID_A1), true);
      assert.equal((await rows<{ count: number }>(
        pg,
        `select count(*)::integer as count from organization_memberships
          where account_id=$1 and organization_id=$2 and membership_scope='property'
            and staxis_role='front_desk' and ended_at is null and status='active'`,
        [GRANT_ACCOUNT, ORG_A],
      ))[0].count, 1);
      const grantReplay = await jsonRpc(
        pg,
        `select public.staxis_grant_existing_account_invite_guarded(
           $1,$2,$3,$4,'grant-person@example.test','front_desk',$5,'property',$6,$7,'stage-c-grant-replay'
         ) as value`,
        [ACCOUNT_MARIA, UID_MARIA, PID_A1, GRANT_ACCOUNT, ORG_A, [PID_A1], GRANT_STAFF],
      );
      assert.equal(grantReplay.ok, true);
      assert.equal((await rows<{ count: number }>(
        pg,
        `select count(*)::integer as count from organization_memberships
          where account_id=$1 and organization_id=$2 and membership_scope='property'
            and staxis_role='front_desk' and ended_at is null and status='active'`,
        [GRANT_ACCOUNT, ORG_A],
      ))[0].count, 1);

      await insertCanonicalAccount(pg, JOIN_ACCOUNT, JOIN_USER, 'join-person', 'Join Person', 'housekeeping', 'join-person@example.test');
      await pg.query(
        `insert into public.join_requests(id,property_id,account_id,name,phone,language,department,status)
         values ($1,$2,$3,'Join Person','512-555-1003','en','housekeeping','pending')`,
        [JOIN_REQUEST, PID_A1, JOIN_ACCOUNT],
      );
      const approved = await jsonRpc(
        pg,
        `select public.staxis_decide_staff_join_request($1,$2,$3,'approve') as value`,
        [ACCOUNT_MARIA, JOIN_REQUEST, PID_A1],
      );
      assert.equal(approved.ok, true);
      assert.equal(approved.authorityMode, 'normalized');
      assert.equal((await propertyIds(pg, JOIN_ACCOUNT)).includes(PID_A1), true);
      const approvalReplay = await jsonRpc(
        pg,
        `select public.staxis_decide_staff_join_request($1,$2,$3,'approve') as value`,
        [ACCOUNT_MARIA, JOIN_REQUEST, PID_A1],
      );
      assert.deepEqual(approvalReplay, { ok: false, reason: 'already_decided' });

      await pg.query(
        `insert into public.properties(id,owner_id,name,total_rooms,timezone)
         values ($1,$2,'Stage C First Person',12,'America/Chicago')`,
        [FIRST_PROPERTY, UID_ADMIN],
      );
      await pg.query(`insert into auth.users(id,email) values ($1,'first-stage-c@example.test')`, [FIRST_USER]);
      const minted = await jsonRpc(
        pg,
        `select public.staxis_mint_first_person_onboarding_invite(
           $1,$2,$3,$4,'owner','first-stage-c@example.test','stage-c-first-person'
         ) as value`,
        [ACCOUNT_ADMIN, UID_ADMIN, FIRST_PROPERTY, FIRST_CODE],
      );
      assert.equal(minted.ok, true);
      const finalized = await jsonRpc(
        pg,
        `select public.staxis_finalize_join_code_signup(
           $1,$2,$3,0,$4,'first-stage-c','First Stage C','owner',null,'en','stage-c-first-person'
         ) as value`,
        [minted.codeId, FIRST_CODE, FIRST_PROPERTY, FIRST_USER],
      );
      assert.equal(finalized.ok, true, JSON.stringify(finalized));
      assert.equal(finalized.status, 'finalized');
      assert.equal(finalized.pendingApproval, false);
      const firstAccount = (await rows<{ id: string; property_access: string[] | null }>(
        pg,
        `select id,property_access from accounts where data_user_id=$1`,
        [FIRST_USER],
      ))[0];
      assert.equal(firstAccount.property_access, null);
      assert.deepEqual(await propertyIds(pg, firstAccount.id), [FIRST_PROPERTY]);

      await insertCanonicalAccount(pg, LIFECYCLE_ACCOUNT, LIFECYCLE_USER, 'lifecycle-person', 'Lifecycle Person', 'front_desk', 'lifecycle@example.test');
      const lifecycleGrant = await jsonRpc(
        pg,
        `select public.staxis_grant_existing_account_invite_guarded(
           $1,$2,$3,$4,'lifecycle@example.test','front_desk',$5,'property',$6,null,'stage-c-lifecycle-grant'
         ) as value`,
        [ACCOUNT_MARIA, UID_MARIA, PID_A1, LIFECYCLE_ACCOUNT, ORG_A, [PID_A1]],
      );
      assert.equal(lifecycleGrant.ok, true);
      const lifecycleState = (await rows<{ authority_version: number; lifecycle_intent_version: number; updated_at: string }>(
        pg,
        `select state.authority_version,account.lifecycle_intent_version,account.updated_at
           from account_authorization_state state join accounts account on account.id=state.account_id
          where state.account_id=$1`,
        [LIFECYCLE_ACCOUNT],
      ))[0];
      const registered = await jsonRpc(
        pg,
        `select public.staxis_register_account_lifecycle_intent(
           $1,$2,$3,'maria@example.test',$4,$5,false,true,'front_desk',$6,$7,$8
         ) as value`,
        [LIFECYCLE_OPERATION, ACCOUNT_MARIA, UID_MARIA, PID_A1, LIFECYCLE_ACCOUNT, LIFECYCLE_USER, [PID_A1], lifecycleState.lifecycle_intent_version],
      );
      assert.equal(registered.status, 'pending');
      const claimed = await jsonRpc(
        pg,
        `select public.staxis_claim_account_lifecycle_intent($1,$2,120) as value`,
        [LIFECYCLE_OPERATION, ACCOUNT_ADMIN],
      );
      assert.equal(claimed.status, 'claimed');
      const snapshot = await jsonRpc(
        pg,
        `select public.staxis_record_account_lifecycle_auth_snapshot($1,null,$2) as value`,
        [LIFECYCLE_OPERATION, ACCOUNT_ADMIN],
      );
      assert.equal(snapshot.status, 'pending');
      const committed = await jsonRpc(
        pg,
        `select public.staxis_commit_account_lifecycle_intent($1,'request',$2) as value`,
        [LIFECYCLE_OPERATION, ACCOUNT_ADMIN],
      );
      assert.equal(committed.status, 'committed');
      const lifecycleReplay = await jsonRpc(
        pg,
        `select public.staxis_register_account_lifecycle_intent(
           $1,$2,$3,'maria@example.test',$4,$5,false,true,'front_desk',$6,$7,$8
         ) as value`,
        [LIFECYCLE_OPERATION, ACCOUNT_MARIA, UID_MARIA, PID_A1, LIFECYCLE_ACCOUNT, LIFECYCLE_USER, [PID_A1], lifecycleState.lifecycle_intent_version],
      );
      assert.equal(lifecycleReplay.status, 'committed');
      assert.equal((await rows<{ active: boolean }>(pg, `select active from accounts where id=$1`, [LIFECYCLE_ACCOUNT]))[0].active, false);

      await insertCanonicalAccount(pg, DETACH_ACCOUNT, DETACH_USER, 'detach-person', 'Detach Person', 'front_desk', 'detach@example.test');
      const detachGrant = await jsonRpc(
        pg,
        `select public.staxis_grant_existing_account_invite_guarded(
           $1,$2,$3,$4,'detach@example.test','front_desk',$5,'property',$6,null,'stage-c-detach-grant'
         ) as value`,
        [ACCOUNT_MARIA, UID_MARIA, PID_A1, DETACH_ACCOUNT, ORG_A, [PID_A1]],
      );
      assert.equal(detachGrant.ok, true);
      const detachState = (await rows<{ authority_version: number; updated_at: string; role: string }>(
        pg,
        `select state.authority_version,account.updated_at,account.role
           from account_authorization_state state join accounts account on account.id=state.account_id
          where state.account_id=$1`,
        [DETACH_ACCOUNT],
      ))[0];
      const detached = await jsonRpc(
        pg,
        `select public.staxis_remove_property_access_authoritative(
           $1,$2,'maria@example.test',$3,$4,$5,$6,$7,'stage-c-detach'
         ) as value`,
        [ACCOUNT_MARIA, UID_MARIA, DETACH_ACCOUNT, PID_A1, detachState.role, detachState.authority_version, detachState.updated_at],
      );
      assert.equal(detached.status, 'ok', JSON.stringify(detached));
      assert.equal((await propertyIds(pg, DETACH_ACCOUNT)).includes(PID_A1), false);
      assert.equal((await rows<{ count: number }>(
        pg,
        `select count(*)::integer as count from account_property_authorization_bridges
          where account_id=$1 and property_id=$2 and status='active'`,
        [DETACH_ACCOUNT, PID_A1],
      ))[0].count, 0);
      assert.equal((await rows<{ count: number }>(pg, `select count(*)::integer as count from account_lifecycle_intents where operation_id=$1`, [DETACH_OPERATION]))[0].count, 0);

      await insertCanonicalAccount(pg, TRANSFER_ACCOUNT, TRANSFER_USER, 'transfer-person', 'Transfer Person', 'front_desk', 'transfer@example.test');
      const transferGrant = await jsonRpc(
        pg,
        `select public.staxis_grant_existing_account_invite_guarded(
           $1,$2,$3,$4,'transfer@example.test','front_desk',$5,$6,$7,null,'stage-c-transfer-grant'
         ) as value`,
        [ACCOUNT_ADMIN, UID_ADMIN, PID_L1, TRANSFER_ACCOUNT, null, null, null],
      );
      assert.equal(transferGrant.ok, true, JSON.stringify(transferGrant));
      const transferVersions = (await rows<{
        old_active: boolean;
        old_role: string;
        old_auth_user_id: string;
        old_property_ids: string[];
        old_intent_version: number;
        new_active: boolean;
        new_role: string;
        new_auth_user_id: string;
        new_property_ids: string[];
        new_intent_version: number;
      }>(
        pg,
        `select
           old_account.active as old_active,
           old_account.role as old_role,
           old_account.data_user_id as old_auth_user_id,
           public._staxis_structural_account_property_ids(old_account.id) as old_property_ids,
           old_account.lifecycle_intent_version as old_intent_version,
           new_account.active as new_active,
           new_account.role as new_role,
           new_account.data_user_id as new_auth_user_id,
           public._staxis_structural_account_property_ids(new_account.id) as new_property_ids,
           new_account.lifecycle_intent_version as new_intent_version
          from public.accounts old_account
          join public.accounts new_account on new_account.id = $2
         where old_account.id = $1`,
        [ACCOUNT_WANDA, TRANSFER_ACCOUNT],
      ))[0];
      const transferred = await jsonRpc(
        pg,
        `select public.staxis_transfer_ownership_guarded(
           $1,$2,$3,'staxis-admin@example.test',$4,$5,$6,
           $7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'stage-c transfer','stage-c-transfer'
         ) as value`,
        [
          TRANSFER_OPERATION,
          ACCOUNT_ADMIN,
          UID_ADMIN,
          PID_L1,
          ACCOUNT_WANDA,
          TRANSFER_ACCOUNT,
          transferVersions.old_active,
          transferVersions.old_role,
          transferVersions.old_auth_user_id,
          transferVersions.old_property_ids,
          transferVersions.old_intent_version,
          transferVersions.new_active,
          transferVersions.new_role,
          transferVersions.new_auth_user_id,
          transferVersions.new_property_ids,
          transferVersions.new_intent_version,
        ],
      );
      assert.equal(transferred.status, 'ok', JSON.stringify(transferred));
      assert.deepEqual(
        await rows<{ old_role: string; new_role: string }>(
          pg,
          `select
             (select role from public.accounts where id=$1) as old_role,
             (select role from public.accounts where id=$2) as new_role`,
          [ACCOUNT_WANDA, TRANSFER_ACCOUNT],
        ),
        [{ old_role: 'general_manager', new_role: 'owner' }],
      );
      const transferReplay = await jsonRpc(
        pg,
        `select public.staxis_transfer_ownership_guarded(
           $1,$2,$3,'staxis-admin@example.test',$4,$5,$6,
           $7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'stage-c transfer','stage-c-transfer'
         ) as value`,
        [
          TRANSFER_OPERATION,
          ACCOUNT_ADMIN,
          UID_ADMIN,
          PID_L1,
          ACCOUNT_WANDA,
          TRANSFER_ACCOUNT,
          transferVersions.old_active,
          transferVersions.old_role,
          transferVersions.old_auth_user_id,
          transferVersions.old_property_ids,
          transferVersions.old_intent_version,
          transferVersions.new_active,
          transferVersions.new_role,
          transferVersions.new_auth_user_id,
          transferVersions.new_property_ids,
          transferVersions.new_intent_version,
        ],
      );
      assert.equal(transferReplay.status, 'already_applied', JSON.stringify(transferReplay));
    });

    test('rejects a wrong-name rollback, then deletes canonical scope without losing receipts', async () => {
      await assert.rejects(
        pg.query(
          `select public.staxis_delete_property_and_legacy_accounts($1,$2,$3)`,
          [ACCOUNT_ADMIN, PID_L1, 'Wrong Waco name'],
        ),
        /confirmed hotel name does not match/i,
      );
      assert.deepEqual(
        await rows<{ property_count: number; wanda_count: number; transfer_count: number }>(
          pg,
          `select
             (select count(*)::integer from public.properties where id=$1) as property_count,
             (select count(*)::integer from public.accounts where id=$2) as wanda_count,
             (select count(*)::integer from public.accounts where id=$3) as transfer_count`,
          [PID_L1, ACCOUNT_WANDA, TRANSFER_ACCOUNT],
        ),
        [{ property_count: 1, wanda_count: 1, transfer_count: 1 }],
      );
      const deleted = await jsonRpc(
        pg,
        `select public.staxis_delete_property_and_legacy_accounts($1,$2,'Waco Inn') as value`,
        [ACCOUNT_ADMIN, PID_L1],
      );
      assert.equal(deleted.canonical, true);
      assert.equal(deleted.propertyRosterLineagePreserved, true);
      assert.equal((await rows<{ count: number }>(pg, `select count(*)::integer as count from properties where id=$1`, [PID_L1]))[0].count, 0);
      assert.equal((await rows<{ count: number }>(pg, `select count(*)::integer as count from accounts where id in ($1,$2)`, [ACCOUNT_WANDA, TRANSFER_ACCOUNT]))[0].count, 0);
      const receipt = await jsonRpc(
        pg,
        `select public.staxis_access_stage_c_final_receipt($1) as value`,
        [ACCOUNT_WANDA],
      );
      assert.deepEqual(receipt.source_property_ids, [PID_L1]);
    });
  });

  test('repairs exact production-shaped admin, duplicate, and revoked-empty residues before consuming the release gate', async () => {
    let sourcePreflightRunId = '';
    let mariaCanonicalIds: string[] = [];
    let frankCanonicalIds: string[] = [];
    const migrated = await applyMigrationsToPgliteWithHook(
      async ({ pg: hookPg, file }) => {
        if (file === MIGRATION) await seedProductionResidueFixture(hookPg);
      },
      {
        afterAccessStageCPreparation: async ({ pg: hookPg, file }) => {
          if (file !== MIGRATION) return;
          sourcePreflightRunId = (await rows<{ final_preflight_run_id: string }>(
            hookPg,
            `select final_preflight_run_id from public.account_access_cutover_status where id is true`,
          ))[0].final_preflight_run_id;
          const states = await rows<{
            account_id: string;
            authority_mode: string;
            authority_version: number;
          }>(
            hookPg,
            `select account_id,authority_mode,authority_version
               from public.account_authorization_state
              where account_id in ($1,$2,$3)
              order by account_id`,
            [ACCOUNT_ADMIN, ACCOUNT_MARIA, ACCOUNT_FRANK],
          );
          const byAccount = new Map(states.map((state) => [state.account_id, state]));
          mariaCanonicalIds = (await rows<{ property_id: string }>(
            hookPg,
            `select distinct property_id from public._staxis_account_property_authorizations($1) order by property_id`,
            [ACCOUNT_MARIA],
          )).map((row) => row.property_id);
          frankCanonicalIds = (await rows<{ property_id: string }>(
            hookPg,
            `select distinct property_id from public._staxis_account_property_authorizations($1) order by property_id`,
            [ACCOUNT_FRANK],
          )).map((row) => row.property_id);
          await recordRepairDisposition(hookPg, {
            preflightRunId: sourcePreflightRunId,
            accountId: ACCOUNT_ADMIN,
            propertyId: PID_A1,
            issueCodes: ['admin_legacy_access', 'admin_legacy_account', 'stage_a_invariant_failure'],
            decision: 'admin_global',
            rawPropertyIds: [PID_A1],
            canonicalPropertyIds: [],
            authorityMode: byAccount.get(ACCOUNT_ADMIN)?.authority_mode ?? '',
            authorityVersion: byAccount.get(ACCOUNT_ADMIN)?.authority_version ?? 0,
            reason: 'admin_global_role_residue',
          });
          await recordRepairDisposition(hookPg, {
            preflightRunId: sourcePreflightRunId,
            accountId: ACCOUNT_MARIA,
            propertyId: PID_A1,
            issueCodes: ['normalized_legacy_residue', 'stage_a_invariant_failure'],
            decision: 'canonical_duplicate',
            rawPropertyIds: [PID_A1],
            canonicalPropertyIds: mariaCanonicalIds,
            authorityMode: byAccount.get(ACCOUNT_MARIA)?.authority_mode ?? '',
            authorityVersion: byAccount.get(ACCOUNT_MARIA)?.authority_version ?? 0,
            reason: 'canonical_duplicate_residue',
          });
          await recordRepairDisposition(hookPg, {
            preflightRunId: sourcePreflightRunId,
            accountId: ACCOUNT_FRANK,
            propertyId: PID_A1,
            issueCodes: ['normalized_legacy_residue', 'stage_a_invariant_failure'],
            decision: 'revoked_canonical_empty',
            rawPropertyIds: [PID_A1],
            canonicalPropertyIds: frankCanonicalIds,
            authorityMode: byAccount.get(ACCOUNT_FRANK)?.authority_mode ?? '',
            authorityVersion: byAccount.get(ACCOUNT_FRANK)?.authority_version ?? 0,
            reason: 'revoked_canonical_empty_residue',
          });
          await authorizeAccessStageCRelease(hookPg);
        },
      },
    );
    try {
      assert.ok(
        migrated.report.applied.includes(MIGRATION),
        JSON.stringify(migrated.report.failedAtRuntime.filter((entry) => entry.file === MIGRATION)),
      );
      assert.deepEqual(
        migrated.report.failedAtRuntime.filter((entry) => entry.file === MIGRATION),
        [],
      );
      const status = (await rows<{
        stage: string;
        enforcement_enabled: boolean;
        details: Record<string, unknown>;
      }>(
        migrated.pg,
        `select stage,enforcement_enabled,details
           from public.account_access_cutover_status where id is true`,
      ))[0];
      assert.deepEqual(
        {
          stage: status.stage,
          enforcement_enabled: status.enforcement_enabled,
          repairSourcePreflightRunId: status.details.repairSourcePreflightRunId,
          repairDispositionCount: status.details.repairDispositionCount,
        },
        {
          stage: 'C',
          enforcement_enabled: true,
          repairSourcePreflightRunId: sourcePreflightRunId,
          repairDispositionCount: 3,
        },
      );
      const productionManifest = await rows<{
        issue_id: string;
        source: string;
        issue_code: string;
        raw_scope_hash: string;
        status: string;
      }>(
        migrated.pg,
        `select issue_id,source,issue_code,raw_scope_hash,status
           from public.account_access_cutover_repair_manifests
          where preflight_run_id=$1 order by issue_id`,
        [sourcePreflightRunId],
      );
      assert.equal(productionManifest.length, 5, 'the fixture has four direct residue rows plus the Stage-A wrapper');
      assert.equal(new Set(productionManifest.map((row) => row.issue_id)).size, 5);
      assert.ok(productionManifest.every((row) => row.source === 'test-fixture' || row.source === 'production-2f31759a-2cd9-48ee-a458-c0ddea0e7d93'));
      assert.ok(productionManifest.every((row) => /^[0-9a-f]{64}$/.test(row.raw_scope_hash)));
      assert.ok(productionManifest.every((row) => row.status === 'consumed'));
      const alreadyFinalized = await jsonRpc(
        migrated.pg,
        `select public.staxis_preflight_authorization_cutover_stage_c() as value`,
      );
      assert.deepEqual(alreadyFinalized, { ok: true, alreadyFinalized: true, stage: 'C' });
      const repairReceipts = await rows<{
        account_id: string;
        property_id: string;
        decision: string;
          source_property_ids: string[];
          source_scope_hash: string;
          canonical_property_ids_before: string[];
          canonical_scope_hash_before: string;
          canonical_property_ids_after: string[];
          canonical_scope_hash_after: string;
          authority_mode_before: string;
          authority_mode_after: string;
          authority_version_before: number;
          authority_version_after: number;
          legacy_write_event_count_before: number;
          legacy_write_event_count_after: number;
          evidence_before: Record<string, unknown>;
          evidence_after: Record<string, unknown>;
          evidence_before_hash: string;
          evidence_after_hash: string;
          operator_label: string;
          access_b_merge_sha: string;
          deployed_descendant_sha: string;
          repaired_at: string | Date;
      }>(
        migrated.pg,
        `select account_id,property_id,decision,source_property_ids,source_scope_hash,
                canonical_property_ids_before,canonical_scope_hash_before,
                canonical_property_ids_after,canonical_scope_hash_after,
                authority_mode_before,authority_mode_after,
                authority_version_before,authority_version_after,
                legacy_write_event_count_before,legacy_write_event_count_after,
                evidence_before,evidence_after,evidence_before_hash,evidence_after_hash,
                operator_label,access_b_merge_sha,deployed_descendant_sha,repaired_at
           from public.account_access_cutover_repair_receipts
          where preflight_run_id=$1 order by account_id`,
        [sourcePreflightRunId],
      );
      for (const receipt of repairReceipts) {
        assert.equal(receipt.source_scope_hash, sha256(receipt.source_property_ids.join(',')));
        assert.equal(receipt.canonical_scope_hash_before, sha256(receipt.canonical_property_ids_before.join(',')));
        assert.equal(receipt.canonical_scope_hash_after, sha256(receipt.canonical_property_ids_after.join(',')));
        assert.equal(receipt.legacy_write_event_count_before, 0);
        assert.equal(receipt.legacy_write_event_count_after, 0);
        assert.equal(receipt.operator_label, 'production-residue-operator');
        assert.equal(receipt.access_b_merge_sha, ACCESS_B_LIVE_SHA);
        assert.equal(receipt.deployed_descendant_sha, CURRENT_LIVE_DESCENDANT_SHA);
        assert.ok(receipt.repaired_at instanceof Date || /^\d{4}-\d{2}-\d{2}T/.test(receipt.repaired_at));
        assert.ok(receipt.evidence_before.account);
        assert.ok(receipt.evidence_before.topology);
        assert.ok(receipt.evidence_before.staffLinks);
        assert.ok(receipt.evidence_before.bridges);
        assert.ok(receipt.evidence_before.grants);
        assert.ok(receipt.evidence_after.authIdentity);
        assert.match(receipt.evidence_before_hash, /^[0-9a-f]{64}$/);
        assert.match(receipt.evidence_after_hash, /^[0-9a-f]{64}$/);
      }
      assert.deepEqual(
        repairReceipts.map((receipt) => ({
          account_id: receipt.account_id,
          property_id: receipt.property_id,
          decision: receipt.decision,
          source_property_ids: receipt.source_property_ids,
          canonical_property_ids_before: receipt.canonical_property_ids_before,
          canonical_property_ids_after: receipt.canonical_property_ids_after,
          authority_mode_before: receipt.authority_mode_before,
          authority_mode_after: receipt.authority_mode_after,
        })),
        [
          {
            account_id: ACCOUNT_ADMIN,
            property_id: PID_A1,
            decision: 'admin_global',
            source_property_ids: [PID_A1],
            canonical_property_ids_before: [],
            canonical_property_ids_after: [],
            authority_mode_before: 'legacy',
            authority_mode_after: 'normalized',
          },
          {
            account_id: ACCOUNT_MARIA,
            property_id: PID_A1,
            decision: 'canonical_duplicate',
            source_property_ids: [PID_A1],
            canonical_property_ids_before: mariaCanonicalIds,
            canonical_property_ids_after: mariaCanonicalIds,
            authority_mode_before: 'normalized',
            authority_mode_after: 'normalized',
          },
          {
            account_id: ACCOUNT_FRANK,
            property_id: PID_A1,
            decision: 'revoked_canonical_empty',
            source_property_ids: [PID_A1],
            canonical_property_ids_before: [],
            canonical_property_ids_after: [],
            authority_mode_before: 'normalized',
            authority_mode_after: 'normalized',
          },
        ],
      );
      const repairRuns = await rows<{ id: string; status: string; issue_count: number }>(
        migrated.pg,
        `select id,status,issue_count
           from public.account_access_cutover_preflight_runs
          where id in ($1,$2)
          order by id`,
        [sourcePreflightRunId, status.details.repairPreflightRunId],
      );
      assert.deepEqual(
        repairRuns.map((run) => ({ id: run.id, status: run.status, issue_count: Number(run.issue_count) })),
        [
          { id: sourcePreflightRunId, status: 'failed', issue_count: repairRuns.find((run) => run.id === sourcePreflightRunId)?.issue_count ?? 0 },
          { id: String(status.details.repairPreflightRunId), status: 'passed', issue_count: 0 },
        ].sort((left, right) => left.id.localeCompare(right.id)),
      );
      assert.deepEqual(
        await rows<{ account_id: string; property_access: string[] | null }>(
          migrated.pg,
          `select id as account_id,property_access from accounts
            where id in ($1,$2,$3) order by account_id`,
          [ACCOUNT_ADMIN, ACCOUNT_FRANK, ACCOUNT_MARIA],
        ),
        [
          { account_id: ACCOUNT_ADMIN, property_access: [] },
          { account_id: ACCOUNT_MARIA, property_access: [] },
          { account_id: ACCOUNT_FRANK, property_access: [] },
        ],
      );
      assert.deepEqual(await propertyIds(migrated.pg, ACCOUNT_MARIA), mariaCanonicalIds);
      assert.deepEqual(await propertyIds(migrated.pg, ACCOUNT_FRANK), frankCanonicalIds);
      assert.equal(
        (await jsonRpc(
          migrated.pg,
          `select public.staxis_list_account_authorized_properties($1) as value`,
          [ACCOUNT_ADMIN],
        )).all,
        true,
      );
      assert.equal(
        Number((await rows<{ count: number }>(
          migrated.pg,
          `select count(*)::integer as count from public.account_access_cutover_legacy_write_events`,
        ))[0].count),
        0,
      );
      assert.equal(
        Number((await rows<{ count: number }>(
          migrated.pg,
          `select count(*)::integer as count from public.account_access_cutover_repair_dispositions
            where status='consumed' and consumed_preflight_run_id <> preflight_run_id`,
        ))[0].count),
        3,
      );
      const release = (await rows<{
        preflight_run_id: string;
        consumed_preflight_run_id: string;
        status: string;
        details: Record<string, unknown>;
      }>(
        migrated.pg,
        `select preflight_run_id,consumed_preflight_run_id,status,details
           from public.account_access_cutover_release_receipts`,
      ))[0];
      assert.equal(release.preflight_run_id, sourcePreflightRunId);
      assert.notEqual(release.consumed_preflight_run_id, sourcePreflightRunId);
      assert.equal(release.status, 'consumed');
      assert.equal(release.details.repairEligible, true);
      const evidence = await jsonRpc(
        migrated.pg,
        `select public.staxis_access_stage_c_repair_evidence($1) as value`,
        [sourcePreflightRunId],
      );
      assert.equal((evidence.dispositions as unknown[]).length, 3);
      assert.equal((evidence.receipts as unknown[]).length, 3);
      await assert.rejects(
        migrated.pg.query(
          `update public.account_access_cutover_repair_receipts
              set operator_label='tampered'`,
        ),
        /repair receipts are immutable/i,
      );
      await assert.rejects(
        migrated.pg.query(
          `delete from public.account_access_cutover_repair_dispositions`,
        ),
        /repair dispositions are durable|immutable/i,
      );
    } finally {
      await migrated.pg.close();
    }
  });

  test('attributes only matching Stage A wrapper samples to four exact dispositions and preserves receipt rollback', async () => {
    let sourcePreflightRunId = '';
    const migrated = await applyMigrationsToPgliteWithHook(
      async ({ pg: hookPg, file }) => {
        if (file === MIGRATION) await seedWrapperMappingFixture(hookPg);
      },
      {
        afterAccessStageCPreparation: async ({ pg: hookPg, file }) => {
          if (file !== MIGRATION) return;
          sourcePreflightRunId = (await rows<{ final_preflight_run_id: string }>(
            hookPg,
            `select final_preflight_run_id from public.account_access_cutover_status where id is true`,
          ))[0].final_preflight_run_id;
          const states = await rows<{
            account_id: string;
            authority_mode: string;
            authority_version: number;
          }>(
            hookPg,
            `select account_id,authority_mode,authority_version
               from public.account_authorization_state
              where account_id in ($1,$2,$3)
              order by account_id`,
            [ACCOUNT_ADMIN, ACCOUNT_MARIA, ACCOUNT_FRANK],
          );
          const byAccount = new Map(states.map((state) => [state.account_id, state]));
          const mariaCanonicalIds = (await rows<{ property_id: string }>(
            hookPg,
            `select distinct property_id from public._staxis_account_property_authorizations($1) order by property_id`,
            [ACCOUNT_MARIA],
          )).map((row) => row.property_id);
          const frankCanonicalIds = (await rows<{ property_id: string }>(
            hookPg,
            `select distinct property_id from public._staxis_account_property_authorizations($1) order by property_id`,
            [ACCOUNT_FRANK],
          )).map((row) => row.property_id);
          const wrapperIssue = (await rows<{ details: Record<string, unknown> }>(
            hookPg,
            `select details
               from public.account_access_cutover_preflight_issues
              where run_id=$1 and issue_code='stage_a_invariant_failure'`,
            [sourcePreflightRunId],
          ))[0];
          assert.ok(wrapperIssue, 'Stage A wrapper evidence must be present');

          const adminDisposition = {
            preflightRunId: sourcePreflightRunId,
            accountId: ACCOUNT_ADMIN,
            propertyId: PID_A1,
            issueCodes: ['admin_legacy_access', 'admin_legacy_account', 'stage_a_invariant_failure'],
            decision: 'admin_global',
            rawPropertyIds: [PID_A1],
            canonicalPropertyIds: [],
            authorityMode: byAccount.get(ACCOUNT_ADMIN)?.authority_mode ?? '',
            authorityVersion: byAccount.get(ACCOUNT_ADMIN)?.authority_version ?? 0,
            reason: 'admin_global_role_residue',
          };
          const mariaDisposition = {
            preflightRunId: sourcePreflightRunId,
            accountId: ACCOUNT_MARIA,
            propertyId: PID_A1,
            issueCodes: ['normalized_legacy_residue', 'stage_a_invariant_failure'],
            decision: 'canonical_duplicate',
            rawPropertyIds: [PID_A1, PID_A2],
            canonicalPropertyIds: mariaCanonicalIds,
            authorityMode: byAccount.get(ACCOUNT_MARIA)?.authority_mode ?? '',
            authorityVersion: byAccount.get(ACCOUNT_MARIA)?.authority_version ?? 0,
            reason: 'canonical_duplicate_residue',
          };
          const frankDisposition = {
            preflightRunId: sourcePreflightRunId,
            accountId: ACCOUNT_FRANK,
            propertyId: PID_A1,
            issueCodes: ['normalized_legacy_residue', 'stage_a_invariant_failure'],
            decision: 'revoked_canonical_empty',
            rawPropertyIds: [PID_A1],
            canonicalPropertyIds: frankCanonicalIds,
            authorityMode: byAccount.get(ACCOUNT_FRANK)?.authority_mode ?? '',
            authorityVersion: byAccount.get(ACCOUNT_FRANK)?.authority_version ?? 0,
            reason: 'revoked_canonical_empty_residue',
          };

          await assert.rejects(
            recordRepairDisposition(hookPg, {
              ...adminDisposition,
              issueCodes: ['admin_legacy_access', 'admin_legacy_account'],
            }),
            /exact issue rows/i,
            'omitting the matching wrapper must not bypass it',
          );
          assert.equal(
            Number((await rows<{ count: number }>(
              hookPg,
              `select count(*)::integer as count
                 from public.account_access_cutover_repair_dispositions`,
            ))[0].count),
            0,
          );

          await hookPg.query(
            `update public.account_access_cutover_preflight_issues
                set details=jsonb_set(details,'{stageAInvariant,sample}',$2::jsonb,true)
              where run_id=$1 and issue_code='stage_a_invariant_failure'`,
            [sourcePreflightRunId, JSON.stringify([{
              accountId: ACCOUNT_HANK,
              propertyId: PID_A1,
              code: 'legacy_row_without_shadow_translation',
              details: {},
            }])],
          );
          await assert.rejects(
            recordRepairDisposition(hookPg, mariaDisposition),
            /exact issue rows/i,
            'a wrapper sample for another account must not be attributed to this disposition',
          );
          await hookPg.query(
            `update public.account_access_cutover_preflight_issues
                set details=jsonb_set(details,'{stageAInvariant,sample}',$2::jsonb,true)
              where run_id=$1 and issue_code='stage_a_invariant_failure'`,
            [sourcePreflightRunId, JSON.stringify([{
              accountId: ACCOUNT_MARIA,
              propertyId: PID_A2,
              code: 'legacy_row_without_shadow_translation',
              details: {},
            }])],
          );
          await assert.rejects(
            recordRepairDisposition(hookPg, mariaDisposition),
            /exact issue rows/i,
            'a wrapper sample for another property must not be attributed to this disposition',
          );
          await hookPg.query(
            `update public.account_access_cutover_preflight_issues
                set details=$2::jsonb
              where run_id=$1 and issue_code='stage_a_invariant_failure'`,
            [sourcePreflightRunId, JSON.stringify(wrapperIssue.details)],
          );

          await recordRepairDisposition(hookPg, adminDisposition);
          await recordRepairDisposition(hookPg, mariaDisposition);
          await recordRepairDisposition(hookPg, { ...mariaDisposition, propertyId: PID_A2 });
          await recordRepairDisposition(hookPg, frankDisposition);
          const replay = await recordRepairDisposition(hookPg, mariaDisposition);
          assert.equal(replay.idempotentReplay, true);
          const repairable = (await rows<{ value: boolean }>(
            hookPg,
            `select public._staxis_stage_c_preflight_repairable($1) as value`,
            [sourcePreflightRunId],
          ))[0].value;
          assert.equal(
            repairable,
            true,
            'all direct issue rows and wrapper samples must be dispositioned',
          );

          const dispositions = await rows<{
            account_id: string;
            property_id: string;
            issue_codes: string[];
            raw_property_ids: string[];
            raw_scope_hash: string;
            canonical_property_ids: string[];
            canonical_scope_hash: string;
          }>(
            hookPg,
            `select account_id,property_id,issue_codes,raw_property_ids,raw_scope_hash,
                    canonical_property_ids,canonical_scope_hash
               from public.account_access_cutover_repair_dispositions
              where preflight_run_id=$1 order by account_id,property_id`,
            [sourcePreflightRunId],
          );
          assert.equal(dispositions.length, 4);
          for (const disposition of dispositions) {
            assert.ok(disposition.issue_codes.includes('stage_a_invariant_failure'));
            assert.equal(disposition.raw_scope_hash, sha256(disposition.raw_property_ids.join(',')));
            assert.equal(disposition.canonical_scope_hash, sha256(disposition.canonical_property_ids.join(',')));
          }
        },
      },
    );
    try {
      assert.equal(migrated.report.applied.includes(MIGRATION), false);
      assert.match(
        migrated.report.failedAtRuntime.find((entry) => entry.file === MIGRATION)?.error ?? '',
        /release gate requires a same-session receipt|repair phase requires a same-session release receipt/i,
      );
      assert.deepEqual(
        await rows<{ id: string; property_access: string[] }>(
          migrated.pg,
          `select id,property_access from public.accounts
            where id in ($1,$2,$3) order by id`,
          [ACCOUNT_ADMIN, ACCOUNT_MARIA, ACCOUNT_FRANK],
        ),
        [
          { id: ACCOUNT_ADMIN, property_access: [PID_A1] },
          { id: ACCOUNT_MARIA, property_access: [PID_A1, PID_A2] },
          { id: ACCOUNT_FRANK, property_access: [PID_A1] },
        ],
      );
      assert.equal(
        Number((await rows<{ count: number }>(
          migrated.pg,
          `select count(*)::integer as count
             from public.account_access_cutover_repair_dispositions
            where preflight_run_id=$1 and status='unconsumed'`,
          [sourcePreflightRunId],
        ))[0].count),
        4,
      );
      assert.equal(
        Number((await rows<{ count: number }>(
          migrated.pg,
          `select count(*)::integer as count from public.account_access_cutover_repair_receipts`,
        ))[0].count),
        0,
      );
    } finally {
      await migrated.pg.close();
    }
  });

  test('rejects unavailable and unrelated Stage A wrapper samples before recording a disposition', async () => {
    const migrated = await applyMigrationsToPgliteWithHook(
      async ({ pg: hookPg, file }) => {
        if (file === MIGRATION) await seedProductionResidueFixture(hookPg);
      },
      {
        afterAccessStageCPreparation: async ({ pg: hookPg, file }) => {
          if (file !== MIGRATION) return;
          const runId = (await rows<{ final_preflight_run_id: string }>(
            hookPg,
            `select final_preflight_run_id from public.account_access_cutover_status where id is true`,
          ))[0].final_preflight_run_id;
          const mariaState = (await rows<{ authority_mode: string; authority_version: number }>(
            hookPg,
            `select authority_mode,authority_version
               from public.account_authorization_state where account_id=$1`,
            [ACCOUNT_MARIA],
          ))[0];
          const mariaCanonicalIds = (await rows<{ property_id: string }>(
            hookPg,
            `select distinct property_id from public._staxis_account_property_authorizations($1) order by property_id`,
            [ACCOUNT_MARIA],
          )).map((row) => row.property_id);
          for (const code of ['stage_a_invariant_unavailable', 'unrelated_stage_a_sample']) {
            if (code === 'stage_a_invariant_unavailable') {
              await hookPg.query(
                `update public.account_access_cutover_preflight_issues
                    set issue_code='stage_a_invariant_unavailable', details=$2::jsonb
                  where run_id=$1 and issue_code='stage_a_invariant_failure'`,
                [runId, JSON.stringify({ reason: 'Stage A service report unavailable' })],
              );
            } else {
              await hookPg.query(
                `update public.account_access_cutover_preflight_issues
                    set details=jsonb_set(details,'{stageAInvariant,sample}',$2::jsonb,true)
                  where run_id=$1 and issue_code='stage_a_invariant_failure'`,
                [runId, JSON.stringify([{
                  accountId: ACCOUNT_MARIA,
                  propertyId: PID_A1,
                  code,
                  details: {},
                }])],
              );
            }
            await assert.rejects(
              recordRepairDisposition(hookPg, {
                preflightRunId: runId,
                accountId: ACCOUNT_MARIA,
                propertyId: PID_A1,
                issueCodes: code === 'stage_a_invariant_unavailable'
                  ? ['normalized_legacy_residue']
                  : ['normalized_legacy_residue', 'stage_a_invariant_failure'],
                decision: 'canonical_duplicate',
                rawPropertyIds: [PID_A1],
                canonicalPropertyIds: mariaCanonicalIds,
                authorityMode: mariaState.authority_mode,
                authorityVersion: mariaState.authority_version,
                reason: 'canonical_duplicate_residue',
              }),
              code === 'stage_a_invariant_unavailable'
                ? /available Stage A invariant evidence/i
                : /supported Stage A invariant wrapper evidence/i,
            );
            if (code === 'stage_a_invariant_unavailable') {
              await hookPg.query(
                `update public.account_access_cutover_preflight_issues
                    set issue_code='stage_a_invariant_failure', details=$2::jsonb
                  where run_id=$1 and issue_code='stage_a_invariant_unavailable'`,
                [runId, JSON.stringify({
                  stageAInvariant: {
                    sample: [{
                      accountId: ACCOUNT_MARIA,
                      propertyId: PID_A1,
                      code: 'unrelated_stage_a_sample',
                      details: {},
                    }],
                  },
                })],
              );
            }
          }
          assert.equal(
            Number((await rows<{ count: number }>(
              hookPg,
              `select count(*)::integer as count from public.account_access_cutover_repair_dispositions`,
            ))[0].count),
            0,
          );
        },
      },
    );
    try {
      assert.equal(migrated.report.applied.includes(MIGRATION), false);
      assert.equal(
        Number((await rows<{ count: number }>(
          migrated.pg,
          `select count(*)::integer as count from public.account_access_cutover_repair_dispositions`,
        ))[0].count),
        0,
      );
    } finally {
      await migrated.pg.close();
    }
  });

  test('rejects unsupported or stale repair dispositions without mutating the failed preflight state', async () => {
    const migrated = await applyMigrationsToPgliteWithHook(
      async ({ pg: hookPg, file }) => {
        if (file === MIGRATION) await seedUnsupportedResidueFixture(hookPg);
      },
      {
        afterAccessStageCPreparation: async ({ pg: hookPg, file }) => {
          if (file !== MIGRATION) return;
          const runId = (await rows<{ final_preflight_run_id: string }>(
            hookPg,
            `select final_preflight_run_id from public.account_access_cutover_status where id is true`,
          ))[0].final_preflight_run_id;
          const mariaState = (await rows<{ authority_mode: string; authority_version: number }>(
            hookPg,
            `select authority_mode,authority_version from public.account_authorization_state where account_id=$1`,
            [ACCOUNT_MARIA],
          ))[0];
          const mariaCanonicalIds = (await rows<{ property_id: string }>(
            hookPg,
            `select distinct property_id from public._staxis_account_property_authorizations($1) order by property_id`,
            [ACCOUNT_MARIA],
          )).map((row) => row.property_id);
          const validMaria = {
            preflightRunId: runId,
            accountId: ACCOUNT_MARIA,
            propertyId: PID_A1,
            issueCodes: ['normalized_legacy_residue', 'stage_a_invariant_failure'],
            decision: 'canonical_duplicate',
            rawPropertyIds: [PID_A1],
            canonicalPropertyIds: mariaCanonicalIds,
            authorityMode: mariaState.authority_mode,
            authorityVersion: mariaState.authority_version,
            reason: 'canonical_duplicate_residue',
          };
          await recordRepairDisposition(hookPg, validMaria);
          const replay = await recordRepairDisposition(hookPg, validMaria);
          assert.equal(replay.idempotentReplay, true);
          await assert.rejects(
            recordRepairDisposition(hookPg, {
              ...validMaria,
              reason: 'operator prose is not an approved repair reason',
            }),
            /incomplete or malformed/i,
          );

          const hankState = (await rows<{ authority_mode: string; authority_version: number }>(
            hookPg,
            `select authority_mode,authority_version from public.account_authorization_state where account_id=$1`,
            [ACCOUNT_HANK],
          ))[0];
          await assert.rejects(
            recordRepairDisposition(hookPg, {
              preflightRunId: runId,
              accountId: ACCOUNT_HANK,
              propertyId: PID_L1,
              issueCodes: ['normalized_legacy_residue', 'stage_a_invariant_failure'],
              decision: 'revoked_canonical_empty',
              rawPropertyIds: [PID_L1],
              canonicalPropertyIds: [],
              authorityMode: hankState.authority_mode,
              authorityVersion: hankState.authority_version,
              reason: 'revoked_canonical_empty_residue',
            }),
            /ended canonical membership/i,
          );
          await assert.rejects(
            recordRepairDisposition(hookPg, {
              ...validMaria,
              rawScopeHash: '0'.repeat(64),
              reason: 'canonical_duplicate_residue',
            }),
            /evidence no longer matches/i,
          );
          await assert.rejects(
            recordRepairDisposition(hookPg, {
              ...validMaria,
              authorityVersion: mariaState.authority_version - 1,
              reason: 'canonical_duplicate_residue',
            }),
            /evidence no longer matches/i,
          );
          await assert.rejects(
            recordRepairDisposition(hookPg, {
              ...validMaria,
              propertyId: PID_A2,
              reason: 'canonical_duplicate_residue',
            }),
            /active is_test property topology|evidence no longer matches|exact issue rows|immutable manifest issue UUIDs|incomplete or malformed/i,
          );
          await hookPg.query(`update public.properties set is_test=false where id=$1`, [PID_A1]);
          await assert.rejects(
            recordRepairDisposition(hookPg, {
              ...validMaria,
              reason: 'canonical_duplicate_residue',
            }),
            /active is_test property topology/i,
          );
          await hookPg.query(`update public.properties set is_test=true where id=$1`, [PID_A1]);
          await assert.rejects(
            recordRepairDisposition(hookPg, {
              ...validMaria,
              operatorLabel: '',
              reason: 'canonical_duplicate_residue',
            }),
            /incomplete or malformed/i,
          );
          await assert.rejects(
            recordRepairDisposition(hookPg, {
              ...validMaria,
              accessBMergeSha: '0'.repeat(40),
              reason: 'canonical_duplicate_residue',
            }),
            /incomplete or malformed/i,
          );
        },
      },
    );
    try {
      assert.equal(migrated.report.applied.includes(MIGRATION), false);
      assert.match(
        migrated.report.failedAtRuntime.find((entry) => entry.file === MIGRATION)?.error ?? '',
        /0426 Stage C preflight rejected finalization/i,
      );
      assert.deepEqual(
        await rows<{ id: string; property_access: string[] }>(
          migrated.pg,
          `select id,property_access from public.accounts
            where id in ($1,$2) order by id`,
          [ACCOUNT_HANK, ACCOUNT_MARIA],
        ),
        [
          { id: ACCOUNT_HANK, property_access: [PID_L1] },
          { id: ACCOUNT_MARIA, property_access: [PID_A1] },
        ],
      );
      assert.equal(
        (await rows<{ stage: string; enforcement_enabled: boolean }>(
          migrated.pg,
          `select stage,enforcement_enabled from public.account_access_cutover_status where id is true`,
        ))[0].stage,
        'A',
      );
      assert.equal(
        (await rows<{ relation: string | null }>(
          migrated.pg,
          `select to_regclass('public.account_access_cutover_repair_receipts') as relation`,
        ))[0].relation,
        'account_access_cutover_repair_receipts',
      );
      assert.equal(
        Number((await rows<{ count: number }>(
          migrated.pg,
          `select count(*)::integer as count from public.account_access_cutover_repair_receipts`,
        ))[0].count),
        0,
      );
    } finally {
      await migrated.pg.close();
    }
  });

  test('rolls back every repair mutation when the release descendant SHA is stale', async () => {
    const migrated = await applyMigrationsToPgliteWithHook(
      async ({ pg: hookPg, file }) => {
        if (file === MIGRATION) await seedProductionResidueFixture(hookPg);
      },
      {
        afterAccessStageCPreparation: async ({ pg: hookPg, file }) => {
          if (file !== MIGRATION) return;
          await recordAllProductionResidueDispositions(hookPg, {
            deployedDescendantSha: '0'.repeat(40),
          });
          await authorizeAccessStageCRelease(hookPg);
        },
      },
    );
    try {
      assert.equal(migrated.report.applied.includes(MIGRATION), false);
      assert.match(
        migrated.report.failedAtRuntime.find((entry) => entry.file === MIGRATION)?.error ?? '',
        /active account or release evidence|0426 Stage C preflight rejected finalization/i,
      );
      assert.deepEqual(
        await rows<{ id: string; property_access: string[] }>(
          migrated.pg,
          `select id,property_access from public.accounts
            where id in ($1,$2,$3) order by id`,
          [ACCOUNT_ADMIN, ACCOUNT_FRANK, ACCOUNT_MARIA],
        ),
        [
          { id: ACCOUNT_ADMIN, property_access: [PID_A1] },
          { id: ACCOUNT_MARIA, property_access: [PID_A1] },
          { id: ACCOUNT_FRANK, property_access: [PID_A1] },
        ],
      );
      assert.equal(
        (await rows<{ authority_mode: string }>(
          migrated.pg,
          `select authority_mode from public.account_authorization_state where account_id=$1`,
          [ACCOUNT_ADMIN],
        ))[0].authority_mode,
        'legacy',
      );
      assert.equal(
        Number((await rows<{ count: number }>(
          migrated.pg,
          `select count(*)::integer as count from public.account_access_cutover_repair_receipts`,
        ))[0].count),
        0,
      );
      assert.equal(
        (await rows<{ relation: string | null }>(
          migrated.pg,
          `select to_regclass('public.account_access_cutover_final_receipts') as relation`,
        ))[0].relation,
        null,
      );
      assert.deepEqual(
        (await rows<{ status: string; consumed_at: string | null }>(
          migrated.pg,
          `select status,consumed_at from public.account_access_cutover_release_receipts`,
        ))[0],
        { status: 'unconsumed', consumed_at: null },
      );
      assert.equal(
        Number((await rows<{ count: number }>(
          migrated.pg,
          `select count(*)::integer as count
             from public.account_access_cutover_repair_dispositions
            where status='unconsumed'`,
        ))[0].count),
        3,
      );
    } finally {
      await migrated.pg.close();
    }
  });

    test('rolls back the repair transaction when a pending queue or legacy write appears after release approval', async () => {
    const migrated = await applyMigrationsToPgliteWithHook(
      async ({ pg: hookPg, file }) => {
        if (file === MIGRATION) await seedProductionResidueFixture(hookPg);
      },
      {
        afterAccessStageCPreparation: async ({ pg: hookPg, file }) => {
          if (file !== MIGRATION) return;
          await recordAllProductionResidueDispositions(hookPg);
          await authorizeAccessStageCRelease(hookPg);
          await hookPg.query(
            `insert into public.join_requests(
               id,property_id,account_id,name,phone,language,department,status
             ) values ($1,$2,$3,'Stage C race','512-555-2201','en','housekeeping','pending')`,
            [DIRTY_JOIN_REQUEST, PID_A1, ACCOUNT_HANK],
          );
          await hookPg.query(
            `insert into public.account_access_cutover_legacy_write_events(
               account_id,operation,previous_property_ids,next_property_ids,
               previous_scope_hash,next_scope_hash,reason
             ) values ($1,'UPDATE',$2::uuid[],$3::uuid[],$4,$5,'Stage C race evidence')`,
            [
              ACCOUNT_MARIA,
              [PID_A1],
              [],
              sha256(PID_A1),
              sha256(''),
            ],
          );
        },
      },
    );
    try {
      assert.equal(migrated.report.applied.includes(MIGRATION), false);
      assert.match(
        migrated.report.failedAtRuntime.find((entry) => entry.file === MIGRATION)?.error ?? '',
        /in-flight lifecycle or access operation|ordinary legacy writer events|Stage C preflight rejected finalization/i,
      );
      assert.deepEqual(
        await rows<{ id: string; property_access: string[] }>(
          migrated.pg,
          `select id,property_access from public.accounts
            where id in ($1,$2,$3) order by id`,
          [ACCOUNT_ADMIN, ACCOUNT_FRANK, ACCOUNT_MARIA],
        ),
        [
          { id: ACCOUNT_ADMIN, property_access: [PID_A1] },
          { id: ACCOUNT_MARIA, property_access: [PID_A1] },
          { id: ACCOUNT_FRANK, property_access: [PID_A1] },
        ],
      );
      assert.equal(
        Number((await rows<{ count: number }>(
          migrated.pg,
          `select count(*)::integer as count from public.account_access_cutover_repair_receipts`,
        ))[0].count),
        0,
      );
      assert.deepEqual(
        (await rows<{ status: string; consumed_at: string | null }>(
          migrated.pg,
          `select status,consumed_at from public.account_access_cutover_release_receipts`,
        ))[0],
        { status: 'unconsumed', consumed_at: null },
      );
      assert.equal(
        Number((await rows<{ count: number }>(
          migrated.pg,
          `select count(*)::integer as count from public.account_access_cutover_legacy_write_events`,
        ))[0].count),
        1,
      );
      assert.equal(
        Number((await rows<{ count: number }>(
          migrated.pg,
          `select count(*)::integer as count from public.join_requests where status='pending'`,
        ))[0].count),
        1,
      );
    } finally {
      await migrated.pg.close();
    }
  });

  test('aborts when a producer is injected after the fresh preflight records zero', async () => {
    const migrated = await applyMigrationsToPgliteWithHook(
      async ({ pg: hookPg, file }) => {
        if (file === MIGRATION) await seedProductionResidueFixture(hookPg);
      },
      {
        afterAccessStageCPreparation: async ({ pg: hookPg, file }) => {
          if (file !== MIGRATION) return;
          await recordAllProductionResidueDispositions(hookPg);
          await authorizeAccessStageCRelease(hookPg);
          // This test-only trigger runs after the fresh preflight has already
          // written issue_count=0.  The finalizer's second queue check must
          // therefore reject the transaction instead of committing a zero-
          // issue cutover alongside a newly pending canonical operation.
          await hookPg.exec(`
            create or replace function public.stage_c_test_post_check_inject()
            returns trigger
            language plpgsql
            as $$
            begin
              insert into public.join_requests(
                id,property_id,account_id,name,phone,language,department,status
              ) values (
                '${POST_CHECK_JOIN_REQUEST}', '${PID_A1}', '${ACCOUNT_HANK}',
                'Stage C post-check race','512-555-2202','en','housekeeping','pending'
              );
              return new;
            end;
            $$;
            drop trigger if exists stage_c_test_post_check_inject
              on public.account_access_cutover_preflight_runs;
            create trigger stage_c_test_post_check_inject
              after update of status,issue_count
              on public.account_access_cutover_preflight_runs
              for each row
              when (new.status = 'passed' and new.issue_count = 0)
              execute function public.stage_c_test_post_check_inject();
          `);
        },
      },
    );
    try {
      assert.equal(migrated.report.applied.includes(MIGRATION), false);
      assert.match(
        migrated.report.failedAtRuntime.find((entry) => entry.file === MIGRATION)?.error ?? '',
        /new in-flight operation after clear/i,
      );
      assert.deepEqual(
        await rows<{ id: string; property_access: string[] }>(
          migrated.pg,
          `select id,property_access from public.accounts
            where id in ($1,$2,$3) order by id`,
          [ACCOUNT_ADMIN, ACCOUNT_FRANK, ACCOUNT_MARIA],
        ),
        [
          { id: ACCOUNT_ADMIN, property_access: [PID_A1] },
          { id: ACCOUNT_MARIA, property_access: [PID_A1] },
          { id: ACCOUNT_FRANK, property_access: [PID_A1] },
        ],
      );
      assert.equal(
        Number((await rows<{ count: number }>(
          migrated.pg,
          `select count(*)::integer as count
             from public.account_access_cutover_repair_receipts`,
        ))[0].count),
        0,
      );
      assert.equal(
        Number((await rows<{ count: number }>(
          migrated.pg,
          `select count(*)::integer as count
             from public.join_requests
            where id=$1`,
          [POST_CHECK_JOIN_REQUEST],
        ))[0].count),
        0,
        'the aborted suffix must not strand the injected pending operation',
      );
      assert.deepEqual(
        (await rows<{ status: string; consumed_at: string | null }>(
          migrated.pg,
          `select status,consumed_at
             from public.account_access_cutover_release_receipts`,
        ))[0],
        { status: 'unconsumed', consumed_at: null },
      );
    } finally {
      await migrated.pg.close();
    }
  });

  test('fails closed before destructive DDL when the external release receipt is missing', async () => {
    const migrated = await applyMigrationsToPgliteWithHook(async ({ pg: hookPg, file }) => {
      if (file === MIGRATION) await seedStageCFixture(hookPg);
    }, { authorizeAccessStageCRelease: false });
    try {
      assert.equal(migrated.report.applied.includes(MIGRATION), false);
      assert.match(
        migrated.report.failedAtRuntime.find((entry) => entry.file === MIGRATION)?.error ?? '',
        /release gate requires a same-session receipt/i,
      );
      assert.deepEqual(
        await rows<{ property_access: string[] }>(
          migrated.pg,
          `select property_access from public.accounts where id=$1`,
          [ACCOUNT_WANDA],
        ),
        [{ property_access: [PID_L1] }],
      );
      assert.equal(
        (await rows<{ relation: string | null }>(
          migrated.pg,
          `select to_regclass('public.account_access_cutover_final_receipts') as relation`,
        ))[0].relation,
        null,
      );
      assert.deepEqual(
        (await rows<{ stage: string; enforcement_enabled: boolean }>(
          migrated.pg,
          `select stage,enforcement_enabled from public.account_access_cutover_status where id is true`,
        ))[0],
        { stage: 'A', enforcement_enabled: false },
      );
    } finally {
      await migrated.pg.close();
    }
  });

  test('fails closed before finalization for pending queues and leaves raw authority untouched', async () => {
    const migrated = await applyMigrationsToPgliteWithHook(async ({ pg: hookPg, file }) => {
      if (file !== MIGRATION) return;
      await seedStageCFixture(hookPg);
      await hookPg.query(`update public.accounts set active=false where id=$1`, [ACCOUNT_HANK]);
      await hookPg.query(
        `insert into public.join_requests(id,property_id,account_id,name,phone,language,department,status)
         values ($1,$2,$3,'Pending Join','512-555-2001','en','housekeeping','pending')`,
        [DIRTY_JOIN_REQUEST, PID_L1, ACCOUNT_HANK],
      );
      const membership = (await rows<{ id: string }>(
        hookPg,
        `select id from organization_memberships
          where organization_id=$1 and account_id=$2 and membership_scope='property'
            and staxis_role='general_manager' and ended_at is null limit 1`,
        [ORG_A, ACCOUNT_MARIA],
      ))[0];
      const relationship = (await rows<{ id: string }>(
        hookPg,
        `select id from organization_property_relationships
          where organization_id=$1 and property_id=$2 and ends_at is null limit 1`,
        [ORG_A, PID_A1],
      ))[0];
      assert.ok(membership && relationship);
      await hookPg.query(
        `insert into public.organization_access_requests(
           id,organization_id,membership_id,requested_access_profile,scope_type,
           property_relationship_id,property_id,reason,status
         ) values ($1,$2,$3,'viewer','property',$4,$5,'pending Stage C request','pending')`,
        [DIRTY_ACCESS_REQUEST, ORG_A, membership.id, relationship.id, PID_A1],
      );
      await hookPg.query(
        `insert into public.organization_invitations(
           id,organization_id,email,token_hash,access_profile,scope_type,
           property_relationship_id,property_id,expires_at,invited_by_account_id,status
         ) values ($1,$2,'stage-c-pending@example.test',$3,'viewer','property',$4,$5,now()+interval '1 day',$6,'pending')`,
        [DIRTY_INVITATION, ORG_A, sha256('stage-c-pending'), relationship.id, PID_A1, ACCOUNT_MARIA],
      );
    }, { authorizeAccessStageCRelease: false });

    try {
      assert.equal(migrated.report.applied.includes(MIGRATION), false);
      const failed = migrated.report.failedAtRuntime.find((entry) => entry.file === MIGRATION);
      assert.match(failed?.error ?? '', /0426 Stage C preflight rejected finalization/i);
      assert.deepEqual(
        await rows<{ property_access: string[] }>(
          migrated.pg,
          `select property_access from accounts where id=$1`,
          [ACCOUNT_HANK],
        ),
        [{ property_access: [PID_L1] }],
      );
      assert.equal(
        (await rows<{ relation: string | null }>(
          migrated.pg,
          `select to_regclass('public.account_access_cutover_final_receipts') as relation`,
        ))[0].relation,
        null,
      );
      const issueCodes = await rows<PreflightIssue>(
        migrated.pg,
        `select issue_code from account_access_cutover_preflight_issues
          where run_id = (select final_preflight_run_id from account_access_cutover_status where id is true)
          order by issue_code`,
      );
      for (const issueCode of [
        'inactive_legacy_account',
        'join_request_in_flight',
        'organization_access_request_in_flight',
        'organization_invitation_in_flight',
      ]) {
        assert.ok(issueCodes.some((issue) => issue.issue_code === issueCode), `${issueCode}: ${issueCodes.map((issue) => issue.issue_code).join(',')}`);
      }
      const run = (await rows<{ status: string; issue_count: number }>(
        migrated.pg,
        `select status,issue_count from account_access_cutover_preflight_runs
          where id = (select final_preflight_run_id from account_access_cutover_status where id is true)`,
      ))[0];
      assert.equal(run.status, 'failed');
      assert.ok(Number(run.issue_count) >= 3);
      const status = (await rows<{ stage: string; enforcement_enabled: boolean }>(
        migrated.pg,
        `select stage,enforcement_enabled from account_access_cutover_status where id is true`,
      ))[0];
      assert.notEqual(status.stage, 'C');
      assert.equal(status.enforcement_enabled, false);
      assert.equal(
        (await rows<{ relation: string | null }>(
          migrated.pg,
          `select to_regclass('public.account_access_cutover_recovery_actions') as relation`,
        ))[0].relation,
        'account_access_cutover_recovery_actions',
      );
      const recovery = await jsonRpc(
        migrated.pg,
        `select public.staxis_access_stage_c_freeze_and_forward($1,$2,null) as value`,
        ['stage-c-dirty-operator', 'drain pending queues before retrying Stage C'],
      );
      assert.equal(recovery.ok, true);
      assert.equal(recovery.authorityChanged, false);
      const evidence = await jsonRpc(
        migrated.pg,
        `select public.staxis_access_stage_c_recovery_evidence(null) as value`,
      );
      assert.equal((evidence as unknown as unknown[]).length, 1);
    } finally {
      await migrated.pg.close();
    }
  });
});
