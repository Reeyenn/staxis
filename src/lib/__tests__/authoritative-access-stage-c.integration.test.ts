import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { PGlite } from '@electric-sql/pglite';

import { applyMigrationsToPgliteWithHook } from '../../../tests/fixtures/pglite-migrate';
import {
  ACCOUNT_ADMIN,
  ACCOUNT_HANK,
  ACCOUNT_MARIA,
  ACCOUNT_WANDA,
  ORG_A,
  PID_A1,
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

function activeSourceText(root: string): string {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry);
      const stats = statSync(path);
      if (stats.isDirectory()) {
        if (entry !== '__tests__' && entry !== 'node_modules') visit(path);
        continue;
      }
      if (/\.(?:ts|tsx)$/.test(entry) && !/\.(?:test|spec)\.(?:ts|tsx)$/.test(entry)) {
        files.push(path);
      }
    }
  };
  visit(root);
  return files.sort().map((path) => readFileSync(path, 'utf8')).join('\n');
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

describe('Access Stage C final contract — real migration boundary', () => {
  describe('clean cutover and canonical runtime operations', () => {
    let pg: PGlite;
    let report: { applied: string[]; failedAtRuntime: Array<{ file: string; error: string }> };

    before(async () => {
      const migrated = await applyMigrationsToPgliteWithHook(async ({ pg: hookPg, file }) => {
        if (file === MIGRATION) await seedStageCFixture(hookPg);
      });
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

      const raw = await rows<{ non_empty: number; null_count: number }>(
        pg,
        `select count(*) filter (where cardinality(coalesce(property_access,'{}'::uuid[])) > 0)::integer as non_empty,
                count(*) filter (where property_access is null)::integer as null_count
           from public.accounts`,
      );
      assert.deepEqual(raw[0], { non_empty: 0, null_count: 0 });

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

      const source = `${activeSourceText(join(__dirname, '..', '..', 'app'))}\n${activeSourceText(join(__dirname, '..', '..', 'lib'))}`;
      const nonCommentSourceLines = source.split('\n').filter((line) => {
        const trimmed = line.trim();
        return !trimmed.startsWith('//')
          && !trimmed.startsWith('/*')
          && !trimmed.startsWith('*')
          && !trimmed.startsWith('*/');
      });
      assert.deepEqual(
        nonCommentSourceLines.filter((line) =>
          !/p_expected(?:_old|_new)?_property_access\s*:/.test(line)
          && (/(?:accounts\.)?property_access\b/.test(line) || /['"]property_access['"]/.test(line)),
        ),
        [],
        'active app runtime source must not read or write the raw property_access column',
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
        assert.doesNotMatch(source, new RegExp(`\\b${obsolete}\\b`), `active app source still names ${obsolete}`);
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
    });

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
