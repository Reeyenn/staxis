import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { applyMigrationsToPgliteWithHook } from '../../../tests/fixtures/pglite-migrate';

const OWNER = 'c1000000-0000-4000-8000-000000000001';
const PROPERTY = 'c2000000-0000-4000-8000-000000000001';
const OTHER_PROPERTY = 'c2000000-0000-4000-8000-000000000002';
const HOUSEKEEPER = 'c3000000-0000-4000-8000-000000000001';
const SECOND_HOUSEKEEPER = 'c3000000-0000-4000-8000-000000000002';
const LEGACY_TASK = 'c4000000-0000-4000-8000-000000000001';
const LEGACY_ASSIGNMENT = 'c5000000-0000-4000-8000-000000000001';
const WINDOW_TASK = 'c4000000-0000-4000-8000-000000000002';
const WINDOW_ASSIGNMENT = 'c5000000-0000-4000-8000-000000000002';
const PMS_ONLY_ASSIGNMENT = 'c6000000-0000-4000-8000-000000000001';
const PMS_INGEST_RUN = 'c7000000-0000-4000-8000-000000000001';
const INSPECTION = 'c8000000-0000-4000-8000-000000000001';
const RECHECK_INSPECTION = 'c8000000-0000-4000-8000-000000000002';
const CANONICAL_TASK = 'c9000000-0000-4000-8000-000000000001';
const BUSINESS_DATE = '2026-08-02';

let pg: PGlite;

async function rows<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const result = (await pg.query(sql, params)) as { rows: T[] };
  return result.rows;
}

async function scalar<T>(sql: string, params: unknown[] = []): Promise<T> {
  const result = await rows<Record<string, unknown>>(sql, params);
  assert.ok(result[0], 'expected one database row');
  return Object.values(result[0])[0] as T;
}

async function failsWith(sql: string, params: unknown[] = []): Promise<string> {
  try {
    await pg.query(sql, params);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  assert.fail('expected database statement to fail');
}

function executableSourceFiles(root: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      if (name === 'node_modules' || name === '__tests__') continue;
      files.push(...executableSourceFiles(path));
    } else if (!/\.(?:ts|tsx|js|mjs|cjs)$/.test(name)) {
      continue;
    } else if (name === 'database.types.ts') {
      continue;
    } else {
      files.push(path);
    }
  }
  return files;
}

describe('housekeeping canonical plan Stage C contract', () => {
  before(async () => {
    const migrated = await applyMigrationsToPgliteWithHook(async ({ pg: db, file }) => {
      if (file === '0434_housekeeping_plan_reconciliation.sql') {
        await db.query("select set_config('staxis.housekeeping_stage_c_freeze', 'approved', false)");
        await db.query("select set_config('staxis.housekeeping_stage_c_operator', 'stage-c-test-operator', false)");
        await db.query(
          "insert into auth.users(id, email) values ($1, 'stage-c@example.test') on conflict (id) do nothing",
          [OWNER],
        );
        await db.query(
          "insert into public.properties(id, owner_id, name, total_rooms, timezone) values ($1, $3, 'Stage C Inn', 80, 'America/Chicago'), ($2, $3, 'Other Stage C Inn', 20, 'America/Chicago') on conflict (id) do nothing",
          [PROPERTY, OTHER_PROPERTY, OWNER],
        );
        await db.query(
          "insert into public.staff(id, property_id, name, department, is_active) values ($1, $3, 'Stage C Housekeeper', 'housekeeping', true), ($2, $3, 'Second Stage C Housekeeper', 'housekeeping', true), ($4, $5, 'Other Property Housekeeper', 'housekeeping', true) on conflict (id) do nothing",
          [HOUSEKEEPER, SECOND_HOUSEKEEPER, PROPERTY, 'c3000000-0000-4000-8000-000000000003', OTHER_PROPERTY],
        );
        await db.query(
          "insert into public.component_rooms(property_id, parent_room_number, child_room_numbers) values ($1, '900', '[\"901\",\"902\"]'::jsonb) on conflict (property_id, parent_room_number) do update set child_room_numbers = excluded.child_room_numbers",
          [PROPERTY],
        );
        await db.query(
          "insert into public.pms_ingest_runs(id, property_id, source_kind, mode, parser_name, parser_version, source_captured_at, started_at, finished_at, status) values ($1, $2, 'cua', 'live', 'stage-c-test', 'stage-c-test-1', $3::timestamptz, $3::timestamptz, $3::timestamptz, 'succeeded') on conflict (id) do nothing",
          [PMS_INGEST_RUN, PROPERTY, '2026-08-02T11:00:00Z'],
        );
        await db.query(
          "insert into public.pms_housekeeping_assignments(id, property_id, date, room_number, housekeeper_name, cleaning_type, scheduled_time, dnd_active, notes, raw, ingest_run_id) values ($1, $2, $3, '101', 'Stage C Housekeeper', 'departure', $4::timestamptz, false, 'PMS parity row', '{\"source\":\"stage-c\"}'::jsonb, $5)",
          [PMS_ONLY_ASSIGNMENT, PROPERTY, BUSINESS_DATE, '2026-08-02T12:00:00Z', PMS_INGEST_RUN],
        );
        await db.query(
          "insert into public.cleaning_tasks(id, property_id, room_number, business_date, dedupe_key, cleaning_type, priority, estimated_minutes, requires_inspection, extras, notes, rules_fired, rule_inputs, status, source_property_timezone, scheduled_at, last_evaluated_at) values ($1, $2, '101', $3, '101::2026-08-02', 'departure', 'normal', 30, true, '[{\"kind\":\"inspection\"}]'::jsonb, 'legacy inspection task', '[{\"id\":\"stage-c-rule\"}]'::jsonb, '{\"source\":\"stage-c\"}'::jsonb, 'scheduled', 'America/Chicago', $4::timestamptz, $4::timestamptz)",
          [LEGACY_TASK, PROPERTY, BUSINESS_DATE, '2026-08-02T12:01:00Z'],
        );
        await db.query(
          "insert into public.hk_assignments(id, property_id, cleaning_task_id, housekeeper_id, queue_order, is_active, assigned_at, assigned_by, reason, score) values ($1, $2, $3, $4, 1, true, $5::timestamptz, 'auto', 'legacy initial assignment', 4.25)",
          [LEGACY_ASSIGNMENT, PROPERTY, LEGACY_TASK, HOUSEKEEPER, '2026-08-02T12:02:00Z'],
        );
        await db.query(
          "insert into public.inspections(id, property_id, room_number, cleaning_task_id, result, failed_items, passed_items, started_at) values ($1, $2, '101', $3, 'in_progress', '[]'::jsonb, '[]'::jsonb, $4::timestamptz)",
          [INSPECTION, PROPERTY, LEGACY_TASK, '2026-08-02T13:00:00Z'],
        );
      } else if (file === '0435_housekeeping_canonical_operations.sql') {
        // This task and assignment are written in the approved old-window
        // interval, after the bridge is installed but before final retirement.
        await db.query(
          "insert into public.cleaning_tasks(id, property_id, room_number, business_date, dedupe_key, cleaning_type, priority, estimated_minutes, requires_inspection, extras, notes, rules_fired, status, source_property_timezone, scheduled_at, last_evaluated_at) values ($1, $2, '102', $3, '102::2026-08-02', 'stayover', 'normal', 20, false, '[]'::jsonb, 'old-window task', '[]'::jsonb, 'scheduled', 'America/Chicago', $4::timestamptz, $4::timestamptz)",
          [WINDOW_TASK, PROPERTY, BUSINESS_DATE, '2026-08-02T14:00:00Z'],
        );
        await db.query(
          "insert into public.hk_assignments(id, property_id, cleaning_task_id, housekeeper_id, queue_order, is_active, assigned_at, assigned_by, reason, score) values ($1, $2, $3, $4, 2, true, $5::timestamptz, 'auto', 'old-window assignment', 3.75)",
          [WINDOW_ASSIGNMENT, PROPERTY, WINDOW_TASK, HOUSEKEEPER, '2026-08-02T14:01:00Z'],
        );
        // A PMS-only row arrives after 0355. Stage C must preserve it through
        // room_work_plan_v1's full-outer truth without inventing room_work.
        await db.query(
          "insert into public.pms_housekeeping_assignments(id, property_id, date, room_number, housekeeper_name, cleaning_type, scheduled_time, dnd_active, notes, raw, ingest_run_id) values ($1, $2, $3, '777', 'PMS Only Name', 'stayover', $4::timestamptz, true, 'PMS-only truth', '{\"pms_only\":true}'::jsonb, $5)",
          ['ca000000-0000-4000-8000-000000000001', PROPERTY, BUSINESS_DATE, '2026-08-02T12:30:00Z', PMS_INGEST_RUN],
        );
      } else if (file === '0436_housekeeping_stage_b_inspection_lock.sql') {
        // Canonical assignment wins for started work even though the frozen
        // old assignment remains active in the compatibility table.
        await db.query(
          "select * from public.assign_room_work_atomic($1, $2, $3, $4, 'canonical started-work assignment', 3, 8.5, false, 'manual')",
          [PROPERTY, WINDOW_TASK, SECOND_HOUSEKEEPER, OWNER],
        );
        await db.query(
          "select public.write_room_work_atomic($1, $2, '102', '{\"status\":\"in_progress\",\"started_at\":\"2026-08-02T14:05:00Z\"}'::jsonb)",
          [PROPERTY, BUSINESS_DATE],
        );
      }
    });

    pg = migrated.pg;
    assert.ok(migrated.report.applied.includes('0434_housekeeping_plan_reconciliation.sql'));
    assert.ok(migrated.report.applied.includes('0435_housekeeping_canonical_operations.sql'));
    assert.ok(migrated.report.applied.includes('0436_housekeeping_stage_b_inspection_lock.sql'));
    assert.ok(migrated.report.applied.includes('0437_housekeeping_stage_c_contract.sql'));
    assert.deepEqual(
      migrated.report.failedAtRuntime.filter((entry) => entry.file.startsWith('043')),
      [],
      'the real 0434-0437 migrations must apply without a runtime failure',
    );
  });

  after(async () => {
    await pg.close();
  });

  test('retires the physical pair only after deterministic reconciliation and preserves identity/history/PMS truth', async () => {
    const relations = await rows<{ relname: string; relkind: string }>(
      "select relname, relkind from pg_class where relnamespace = 'public'::regnamespace and relname in ('cleaning_tasks', 'hk_assignments', 'room_work_plan_v1', 'housekeeping_stage_c_cutover_evidence') order by relname",
    );
    assert.deepEqual(relations, [
      { relname: 'cleaning_tasks', relkind: 'v' },
      { relname: 'housekeeping_stage_c_cutover_evidence', relkind: 'r' },
      { relname: 'room_work_plan_v1', relkind: 'v' },
    ]);

    const windowWork = await rows<{ id: string; status: string; assigned_staff_id: string; assignment_history: unknown }>(
      "select id, status, assigned_staff_id, assignment_history from public.room_work where legacy_task_id = $1",
      [WINDOW_TASK],
    );
    assert.equal(windowWork.length, 1);
    assert.equal(windowWork[0].id, await scalar<string>(
      "select public.housekeeping_plan_id($1, $2, '102')::text",
      [PROPERTY, BUSINESS_DATE],
    ));
    assert.equal(windowWork[0].status, 'in_progress', 'started-work status is canonical and protected');
    assert.equal(windowWork[0].assigned_staff_id, SECOND_HOUSEKEEPER, 'canonical started-work assignment wins');
    const history = windowWork[0].assignment_history as Array<Record<string, unknown>>;
    assert.ok(history.some((entry) => entry.id === WINDOW_ASSIGNMENT && entry.is_active === false));
    assert.ok(history.some((entry) => entry.housekeeper_id === SECOND_HOUSEKEEPER && entry.is_active === true));

    const evidence = await rows<Record<string, unknown>>(
      "select operator_name, legacy_cleaning_tasks_count, legacy_cleaning_tasks_hash, legacy_hk_assignments_count, legacy_hk_assignments_hash, room_work_count_before, room_work_count_after, room_work_hash_before, room_work_hash_after, pms_assignments_count_before, pms_assignments_count_after, pms_assignments_hash_before, pms_assignments_hash_after, inspections_count_before, inspections_count_after, inspections_hash_before, inspections_hash_after, activity_log_count_before, activity_log_count_after, activity_log_hash_before, activity_log_hash_after, physical_legacy_tables_dropped, compatibility_projection, rollback_policy, remediation_procedure from public.housekeeping_stage_c_cutover_evidence",
    );
    assert.equal(evidence.length, 1);
    assert.equal(evidence[0].operator_name, 'stage-c-test-operator');
    assert.equal(evidence[0].legacy_cleaning_tasks_count, 2);
    assert.equal(evidence[0].legacy_hk_assignments_count, 2);
    for (const field of [
      'legacy_cleaning_tasks_hash',
      'legacy_hk_assignments_hash',
      'room_work_hash_before',
      'room_work_hash_after',
      'pms_assignments_hash_before',
      'pms_assignments_hash_after',
      'inspections_hash_before',
      'inspections_hash_after',
      'activity_log_hash_before',
      'activity_log_hash_after',
    ]) {
      assert.match(String(evidence[0][field]), /^[0-9a-f]{32}$/);
    }
    assert.equal(evidence[0].room_work_count_before, evidence[0].room_work_count_after);
    assert.equal(evidence[0].pms_assignments_count_before, evidence[0].pms_assignments_count_after);
    assert.equal(evidence[0].inspections_count_before, evidence[0].inspections_count_after);
    assert.equal(Number(evidence[0].activity_log_count_before) <= Number(evidence[0].activity_log_count_after), true);
    assert.equal(evidence[0].physical_legacy_tables_dropped, true);
    assert.match(String(evidence[0].compatibility_projection), /SELECT-only/);
    assert.match(String(evidence[0].rollback_policy), /OLD-APP-ROLLBACK-INVALID/);
    assert.match(String(evidence[0].remediation_procedure), /CLEANING_STAGE_C_FREEZE_AND_FORWARD_REMEDIATE_V1/);

    const pmsOnly = await rows<{ room_number: string; pms_housekeeper_name: string; room_work_id: string }>(
      "select room_number, pms_housekeeper_name, room_work_id from public.room_work_plan_v1 where property_id = $1 and business_date = $2 and room_number = '777'",
      [PROPERTY, BUSINESS_DATE],
    );
    assert.deepEqual(pmsOnly, [{
      room_number: '777',
      pms_housekeeper_name: 'PMS Only Name',
      room_work_id: await scalar<string>(
        "select public.housekeeping_plan_id($1, $2, '777')::text",
        [PROPERTY, BUSINESS_DATE],
      ),
    }]);

    const projected = await rows<{ id: string; property_id: string; status: string; priority: string }>(
      "select id, property_id, status, priority from public.cleaning_tasks where id = $1",
      [LEGACY_TASK],
    );
    assert.deepEqual(projected, [{ id: LEGACY_TASK, property_id: PROPERTY, status: 'scheduled', priority: 'normal' }]);
    assert.match(await failsWith(
      "insert into public.cleaning_tasks(id, property_id, room_number, business_date, dedupe_key, cleaning_type) values (gen_random_uuid(), $1, '999', $2, '999::2026-08-02', 'stayover')",
      [PROPERTY, BUSINESS_DATE],
    ), /not.*updatable|cannot insert/i);
    assert.match(await failsWith(
      "update public.cleaning_tasks set priority = 'high' where id = $1",
      [LEGACY_TASK],
    ), /not.*updatable|cannot update/i);
    assert.match(await failsWith(
      "delete from public.cleaning_tasks where id = $1",
      [LEGACY_TASK],
    ), /not.*updatable|cannot delete/i);
  });

  test('keeps canonical assign/reset/reassign and started-work protections active', async () => {
    await pg.query(
      "select * from public.upsert_room_work_plan($1, $2::jsonb)",
      [PROPERTY, JSON.stringify([{
        property_id: PROPERTY,
        room_number: '300',
        business_date: BUSINESS_DATE,
        dedupe_key: '300::2026-08-02',
        cleaning_type: 'stayover',
        priority: 'normal',
        status: 'scheduled',
      }])],
    );
    const assigned = await rows<{ task_id: string; assignee_id: string; noop: boolean }>(
      "select * from public.assign_room_work_atomic($1, public.housekeeping_plan_id($1, $2, '300'), $3, $4, 'stage-c assignment', 1, 2.5, false, 'manual')",
      [PROPERTY, BUSINESS_DATE, HOUSEKEEPER, OWNER],
    );
    assert.equal(assigned[0].assignee_id, HOUSEKEEPER);
    assert.equal(await scalar<number>(
      "select public.reset_room_work_assignments($1, $2, public.housekeeping_plan_id($1, $2, '300'))",
      [PROPERTY, BUSINESS_DATE],
    ), 1);
    const reassigned = await rows<{ assignee_id: string; noop: boolean }>(
      "select assignee_id, noop from public.assign_room_work_atomic($1, public.housekeeping_plan_id($1, $2, '300'), $3, $4, 'stage-c reassign', 2, 3.5, false, 'manual')",
      [PROPERTY, BUSINESS_DATE, SECOND_HOUSEKEEPER, OWNER],
    );
    assert.deepEqual(reassigned, [{ assignee_id: SECOND_HOUSEKEEPER, noop: false }]);

    await pg.query(
      "select public.write_room_work_atomic($1, $2, '300', '{\"status\":\"in_progress\",\"started_at\":\"2026-08-02T15:00:00Z\"}'::jsonb)",
      [PROPERTY, BUSINESS_DATE],
    );
    assert.equal(await scalar<number>(
      "select public.reset_room_work_assignments($1, $2, public.housekeeping_plan_id($1, $2, '300'))",
      [PROPERTY, BUSINESS_DATE],
    ), 0, 'reset cannot clear started work');
    assert.match(await failsWith(
      "select * from public.assign_room_work_atomic($1, public.housekeeping_plan_id($1, $2, '300'), $3, $4, 'must be protected', 3, 4, false, 'manual')",
      [PROPERTY, BUSINESS_DATE, HOUSEKEEPER, OWNER],
    ), /not reassignable/i);

    await pg.query(
      "select public.write_room_work_atomic($1, $2, '900', '{\"status\":\"completed\",\"completed_at\":\"2026-08-02T15:30:00Z\"}'::jsonb)",
      [PROPERTY, BUSINESS_DATE],
    );
    const componentStatuses = await rows<{ room_number: string; status: string }>(
      "select room_number, status from public.room_work where property_id = $1 and date = $2 and room_number in ('900', '901', '902') order by room_number",
      [PROPERTY, BUSINESS_DATE],
    );
    assert.deepEqual(componentStatuses, [
      { room_number: '900', status: 'completed' },
      { room_number: '901', status: 'completed' },
      { room_number: '902', status: 'completed' },
    ]);
  });

  test('keeps inspection failure/recheck evidence atomic and idempotent', async () => {
    const failed = await rows<{ result: string; failed_items: unknown }>(
      "select * from public.complete_inspection_atomic_canonical($1, $2, 'fail', $3::jsonb, '[]'::jsonb, 'Mirror streaks', false, null, null, 're-clean mirror')",
      [INSPECTION, PROPERTY, JSON.stringify([{ item_id: 'mirror', photo_url: 'inspection-photos/stage-c.jpg', note: 'streaks' }])],
    );
    assert.equal(failed[0].result, 'fail');
    assert.match(JSON.stringify(failed[0].failed_items), /inspection-photos\/stage-c\.jpg/);
    const correction = await rows<{ plan_status: string; issue_note: string }>(
      "select plan_status, issue_note from public.room_work where legacy_task_id = $1",
      [LEGACY_TASK],
    );
    assert.deepEqual(correction, [{ plan_status: 'correction_pending', issue_note: 're-clean mirror' }]);
    assert.match(await failsWith(
      "select * from public.complete_inspection_atomic_canonical($1, $2, 'fail', '[]'::jsonb, '[]'::jsonb, null, false, null, null, null)",
      [INSPECTION, PROPERTY],
    ), /already/i);

    await pg.query(
      "insert into public.inspections(id, property_id, room_number, cleaning_task_id, parent_inspection_id, result, started_at) values ($1, $2, '101', $3, $4, 'in_progress', '2026-08-02T16:00:00Z')",
      [RECHECK_INSPECTION, PROPERTY, LEGACY_TASK, INSPECTION],
    );
    await pg.query(
      "select * from public.complete_inspection_atomic_canonical($1, $2, 'pass', '[]'::jsonb, '[\"mirror\"]'::jsonb, null, false, null, null, null)",
      [RECHECK_INSPECTION, PROPERTY],
    );
    const chain = await rows<{ result: string; recheck_inspection_id: string }>(
      "select result, recheck_inspection_id from public.inspections where id in ($1, $2) order by id",
      [INSPECTION, RECHECK_INSPECTION],
    );
    assert.equal(chain.find((row) => row.result === 'fail')?.recheck_inspection_id, RECHECK_INSPECTION);
    assert.equal(chain.find((row) => row.result === 'pass')?.result, 'pass');
  });

  test('enforces service-only ACL/search_path and removes executable legacy seams', async () => {
    const acl = await rows<{ anon_select: boolean; service_select: boolean; pms_anon_insert: boolean; evidence_rls: boolean }>(
      "select has_table_privilege('anon', 'public.cleaning_tasks', 'select') as anon_select, has_table_privilege('service_role', 'public.cleaning_tasks', 'select') as service_select, has_table_privilege('anon', 'public.pms_housekeeping_assignments', 'insert') as pms_anon_insert, (select relrowsecurity from pg_class where oid = 'public.housekeeping_stage_c_cutover_evidence'::regclass) as evidence_rls",
    );
    assert.deepEqual(acl, [{ anon_select: false, service_select: true, pms_anon_insert: false, evidence_rls: true }]);

    const functions = await rows<{ proconfig: string[] | null; anon_exec: boolean; service_exec: boolean }>(
      "select proconfig, has_function_privilege('anon', 'public.assign_room_work_atomic(uuid,uuid,uuid,uuid,text,integer,numeric,boolean,text)', 'execute') as anon_exec, has_function_privilege('service_role', 'public.assign_room_work_atomic(uuid,uuid,uuid,uuid,text,integer,numeric,boolean,text)', 'execute') as service_exec from pg_proc where oid = 'public.assign_room_work_atomic(uuid,uuid,uuid,uuid,text,integer,numeric,boolean,text)'::regprocedure",
    );
    assert.equal(functions.length, 1);
    assert.match(String(functions[0].proconfig), /search_path=public, pg_temp/);
    assert.equal(functions[0].anon_exec, false);
    assert.equal(functions[0].service_exec, true);

    assert.equal(await scalar<number>(
      "select count(*) from pg_trigger where tgrelid = 'public.cleaning_tasks'::regclass and not tgisinternal",
    ), 0, 'read-only projection has no redirect trigger');
    assert.equal(await scalar<number>(
      "select count(*) from pg_trigger where tgrelid = 'public.room_work'::regclass and not tgisinternal and tgname in ('trg_legacy_cleaning_task_to_room_work', 'trg_legacy_hk_assignment_to_room_work')",
    ), 0, 'canonical room_work has no reverse bridge');
    assert.equal(await scalar<boolean>(
      "select to_regprocedure('public.reassign_cleaning_task(uuid,uuid,uuid,uuid,text)') is null and to_regprocedure('public.complete_inspection_atomic(uuid,uuid,text,jsonb,jsonb,text,boolean,text,timestamptz,text)') is null",
    ), true);
    assert.deepEqual(await rows<{ function_name: string }>(
      "select p.oid::regprocedure::text as function_name from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prokind in ('f', 'p') and pg_get_functiondef(p.oid) ~* '\\m(cleaning_tasks|hk_assignments)\\M' order by 1",
    ), [], 'no executable public function may retain a legacy relation reader or writer reference');

    const repo = resolve(new URL('.', import.meta.url).pathname, '..', '..', '..');
    const legacyCall = /\.from\(\s*['\"](?:cleaning_tasks|hk_assignments)['\"]\s*\)|\.rpc\(\s*['\"](?:complete_inspection_atomic|reassign_cleaning_task)['\"]\s*\)/;
    for (const root of [join(repo, 'src'), join(repo, 'cua-service'), join(repo, 'scripts')]) {
      for (const file of executableSourceFiles(root)) {
        const executableSource = readFileSync(file, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/^\s*\/\/.*$/gm, '');
        assert.doesNotMatch(executableSource, legacyCall, `legacy executable seam remains in ${file}`);
      }
    }
  });
});

test('0437 preflight aborts without destructive mutation for a missing inspection mapping', async () => {
  const invalidInspection = 'da000000-0000-4000-8000-000000000001';
  const invalidOwner = 'da100000-0000-4000-8000-000000000001';
  const invalidProperty = 'da200000-0000-4000-8000-000000000001';
  const migrated = await applyMigrationsToPgliteWithHook(async ({ pg: db, file }) => {
    if (file !== '0434_housekeeping_plan_reconciliation.sql') return;
    await db.query("select set_config('staxis.housekeeping_stage_c_freeze', 'approved', false)");
    await db.query("select set_config('staxis.housekeeping_stage_c_operator', 'preflight-test-operator', false)");
    await db.query(
      "insert into auth.users(id, email) values ($1, 'preflight@example.test') on conflict (id) do nothing",
      [invalidOwner],
    );
    await db.query(
      "insert into public.properties(id, owner_id, name, total_rooms, timezone) values ($1, $2, 'Invalid Mapping Inn', 10, 'America/Chicago') on conflict (id) do nothing",
      [invalidProperty, invalidOwner],
    );
    await db.query(
      "insert into public.inspections(id, property_id, room_number, cleaning_task_id, result, started_at) values ($1, $2, '404', 'da400000-0000-4000-8000-000000000001', 'in_progress', '2026-08-02T10:00:00Z')",
      [invalidInspection, invalidProperty],
    );
  });
  const failure = migrated.report.failedAtRuntime.find((entry) => entry.file === '0437_housekeeping_stage_c_contract.sql');
  assert.ok(failure);
  assert.match(failure.error, /inspection row\(s\).*mapping/i);
  await migrated.pg.exec('rollback;').catch(() => undefined);
  assert.equal(await migrated.pg.query<{ relkind: string }>(
    "select relkind from pg_class where oid = 'public.cleaning_tasks'::regclass",
  ).then((result) => result.rows[0]?.relkind), 'r');
  assert.equal(await migrated.pg.query<{ relkind: string }>(
    "select relkind from pg_class where oid = 'public.hk_assignments'::regclass",
  ).then((result) => result.rows[0]?.relkind), 'r');
  assert.equal(await migrated.pg.query<{ evidence: string | null }>(
    "select to_regclass('public.housekeeping_stage_c_cutover_evidence') as evidence",
  ).then((result) => result.rows[0]?.evidence), null);
  await migrated.pg.close();
});

test('0437 preflight fences an in-flight old deployment when the freeze gate is absent', async () => {
  const migrated = await applyMigrationsToPgliteWithHook(async ({ pg: db, file }) => {
    if (file !== '0434_housekeeping_plan_reconciliation.sql') return;
    await db.query("select set_config('staxis.housekeeping_stage_c_operator', 'freeze-gate-test-operator', false)");
  });
  const failure = migrated.report.failedAtRuntime.find((entry) => entry.file === '0437_housekeeping_stage_c_contract.sql');
  assert.ok(failure);
  assert.match(failure.error, /freeze gate is not approved/i);
  await migrated.pg.exec('rollback;').catch(() => undefined);
  assert.equal(await migrated.pg.query<{ evidence: string | null }>(
    "select to_regclass('public.housekeeping_stage_c_cutover_evidence') as evidence",
  ).then((result) => result.rows[0]?.evidence), null);
  assert.equal(await migrated.pg.query<{ relkind: string }>(
    "select relkind from pg_class where oid = 'public.cleaning_tasks'::regclass",
  ).then((result) => result.rows[0]?.relkind), 'r');
  await migrated.pg.close();
});
