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
const OTHER_HOUSEKEEPER = 'c3000000-0000-4000-8000-000000000003';
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

async function failsWithRole(
  role: 'anon' | 'authenticated' | 'service_role',
  sql: string,
  params: unknown[] = [],
): Promise<string> {
  await pg.exec(`begin; set local role ${role};`);
  try {
    await pg.query(sql, params);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await pg.exec('rollback;').catch(() => undefined);
    return message;
  }
  await pg.exec('rollback;').catch(() => undefined);
  assert.fail(`expected ${role} database statement to fail`);
}

async function seedStageCPreflightWindow(db: PGlite, operator = 'stage-c-preflight-operator'): Promise<void> {
  await db.query("select set_config('staxis.housekeeping_stage_c_freeze', 'approved', false)");
  await db.query("select set_config('staxis.housekeeping_stage_c_operator', $1, false)", [operator]);
  await db.query(
    "insert into auth.users(id, email) values ($1, 'stage-c-preflight@example.test') on conflict (id) do nothing",
    [OWNER],
  );
  await db.query(
    "insert into public.properties(id, owner_id, name, total_rooms, timezone) values ($1, $3, 'Stage C Preflight Inn', 80, 'America/Chicago'), ($2, $3, 'Other Stage C Preflight Inn', 20, 'America/Chicago') on conflict (id) do nothing",
    [PROPERTY, OTHER_PROPERTY, OWNER],
  );
  await db.query(
    "insert into public.staff(id, property_id, name, department, is_active) values ($1, $3, 'Stage C Preflight Housekeeper', 'housekeeping', true), ($2, $3, 'Stage C Preflight Other', 'housekeeping', true), ($4, $5, 'Stage C Preflight Foreign Housekeeper', 'housekeeping', true) on conflict (id) do nothing",
    [HOUSEKEEPER, SECOND_HOUSEKEEPER, PROPERTY, OTHER_HOUSEKEEPER, OTHER_PROPERTY],
  );
  await db.query(
    "insert into public.cleaning_tasks(id, property_id, room_number, business_date, dedupe_key, cleaning_type, priority, estimated_minutes, requires_inspection, extras, notes, rules_fired, rule_inputs, status, source_property_timezone, scheduled_at, last_evaluated_at) values ($1, $2, '101', $3, '101::2026-08-02', 'departure', 'normal', 30, false, '[]'::jsonb, 'preflight task', '[]'::jsonb, '{}'::jsonb, 'scheduled', 'America/Chicago', $4::timestamptz, $4::timestamptz)",
    [LEGACY_TASK, PROPERTY, BUSINESS_DATE, '2026-08-02T12:00:00Z'],
  );
  await db.query(
    "insert into public.hk_assignments(id, property_id, cleaning_task_id, housekeeper_id, queue_order, is_active, assigned_at, assigned_by, reason, score) values ($1, $2, $3, $4, 1, true, $5::timestamptz, 'auto', 'preflight assignment', 1.0)",
    [LEGACY_ASSIGNMENT, PROPERTY, LEGACY_TASK, HOUSEKEEPER, '2026-08-02T12:01:00Z'],
  );
}

async function seedCanonicalAssignmentThenLegacyReset(
  db: PGlite,
  resetDeltaMs: number,
): Promise<{ canonicalChangedAt: string; resetAt: string }> {
  await db.query(
    "select * from public.assign_room_work_atomic($1, public.housekeeping_plan_id($1, $2, '101'), $3, $4, 'canonical assignment timestamp test', 4, 6.5, false, 'manual')",
    [PROPERTY, BUSINESS_DATE, SECOND_HOUSEKEEPER, OWNER],
  );
  const canonicalReceipt = await db.query<{ changed_at: string }>(
    `select h.snapshot->>'updated_at' as changed_at
       from public.room_work w
       cross join lateral jsonb_array_elements(coalesce(w.assignment_history, '[]'::jsonb)) with ordinality h(snapshot, position)
      where w.legacy_task_id = $1
        and h.snapshot->>'housekeeper_id' = $2
        and (h.snapshot->>'is_active')::boolean
      order by h.position desc
      limit 1`,
    [LEGACY_TASK, SECOND_HOUSEKEEPER],
  );
  const canonicalChangedAt = canonicalReceipt.rows[0]?.changed_at;
  assert.ok(canonicalChangedAt, 'canonical assignment must have an updated_at receipt');
  const resetAt = new Date(new Date(canonicalChangedAt).getTime() + resetDeltaMs).toISOString();

  // The old-window row is deliberately written without either compatibility
  // trigger so the migration must compare its actual changed_at to canonical
  // receipt time, not an incidental trigger timestamp.
  await db.query('drop trigger if exists trg_legacy_hk_assignment_to_room_work on public.hk_assignments');
  await db.query('drop trigger if exists set_updated_at on public.hk_assignments');
  await db.query(
    "update public.hk_assignments set is_active = false, updated_at = $2::timestamptz, reason = 'timestamped old-window reset' where id = $1",
    [LEGACY_ASSIGNMENT, resetAt],
  );
  return { canonicalChangedAt, resetAt };
}

async function assertStageCFailurePreservesLegacy(
  migrated: Awaited<ReturnType<typeof applyMigrationsToPgliteWithHook>>,
  message: RegExp,
  expectedTaskCount = 1,
  expectedAssignmentCount = 1,
): Promise<void> {
  const failure = migrated.report.failedAtRuntime.find((entry) => entry.file === '0437_housekeeping_stage_c_contract.sql');
  assert.ok(failure, '0437 must fail in the focused preflight case');
  assert.match(failure.error, message);
  await migrated.pg.exec('rollback;').catch(() => undefined);
  assert.equal(await migrated.pg.query<{ relkind: string }>(
    "select relkind from pg_class where oid = 'public.cleaning_tasks'::regclass",
  ).then((result) => result.rows[0]?.relkind), 'r');
  assert.equal(await migrated.pg.query<{ relkind: string }>(
    "select relkind from pg_class where oid = 'public.hk_assignments'::regclass",
  ).then((result) => result.rows[0]?.relkind), 'r');
  const counts = await migrated.pg.query<{ task_count: number; assignment_count: number }>(
    "select (select count(*)::int from public.cleaning_tasks) as task_count, (select count(*)::int from public.hk_assignments) as assignment_count",
  );
  assert.equal(counts.rows[0]?.task_count, expectedTaskCount);
  assert.equal(counts.rows[0]?.assignment_count, expectedAssignmentCount);
  if (expectedTaskCount > 0) {
    assert.equal(await migrated.pg.query<{ count: number }>(
      "select count(*)::int as count from public.cleaning_tasks where id = $1 and property_id = $2",
      [LEGACY_TASK, PROPERTY],
    ).then((result) => result.rows[0]?.count), 1, 'the original legacy task data survives rollback');
  }
  if (expectedAssignmentCount > 0) {
    assert.equal(await migrated.pg.query<{ count: number }>(
      "select count(*)::int as count from public.hk_assignments where id = $1 and property_id = $2 and cleaning_task_id = $3",
      [LEGACY_ASSIGNMENT, PROPERTY, LEGACY_TASK],
    ).then((result) => result.rows[0]?.count), 1, 'the original legacy assignment data survives rollback');
  }
  assert.equal(await migrated.pg.query<{ evidence: string | null }>(
    "select to_regclass('public.housekeeping_stage_c_cutover_evidence') as evidence",
  ).then((result) => result.rows[0]?.evidence), null);
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
        // old assignment remains in the frozen legacy table. The first legacy
        // assignment is then reset in the old window; Stage C must not revive
        // its earlier active state.
        await db.query(
          "select * from public.assign_room_work_atomic($1, $2, $3, $4, 'canonical started-work assignment', 3, 8.5, false, 'manual')",
          [PROPERTY, WINDOW_TASK, SECOND_HOUSEKEEPER, OWNER],
        );
        await db.query(
          "select public.write_room_work_atomic($1, $2, '102', '{\"status\":\"in_progress\",\"started_at\":\"2026-08-02T14:05:00Z\"}'::jsonb)",
          [PROPERTY, BUSINESS_DATE],
        );
        await db.query(
          "update public.hk_assignments set is_active = false, updated_at = $2::timestamptz, reason = 'old-window reset' where id = $1",
          [LEGACY_ASSIGNMENT, '2026-08-02T14:10:00Z'],
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

    const resetWork = await rows<{ assigned_staff_id: string | null; assignment_history: unknown }>(
      "select assigned_staff_id, assignment_history from public.room_work where legacy_task_id = $1",
      [LEGACY_TASK],
    );
    assert.equal(resetWork[0].assigned_staff_id, null, 'a newer inactive legacy row cannot resurrect an assignment');
    const resetHistory = resetWork[0].assignment_history as Array<Record<string, unknown>>;
    assert.ok(resetHistory.some((entry) => entry.id === LEGACY_ASSIGNMENT && entry.is_active === true));
    assert.ok(resetHistory.some((entry) => entry.id === LEGACY_ASSIGNMENT && entry.is_active === false));

    const oldWindowAudit = await rows<{ event_type: string; source: string }>(
      "select event_type, source from public.activity_log where source_event_id = $1 and event_type in ('assignment_created', 'assignment_deactivated') order by event_type",
      [LEGACY_ASSIGNMENT],
    );
    assert.deepEqual(oldWindowAudit.map((entry) => entry.event_type), ['assignment_created', 'assignment_deactivated']);
    assert.equal(await scalar<number>(
      "select count(*) from public.activity_log where source_event_id = $1 and event_type = 'cleaning_task_in_progress'",
      [WINDOW_TASK],
    ), 1, 'old-window canonical status has one backfilled audit event');
    assert.deepEqual(await rows<{ source_event_id: string; event_type: string; event_count: number }>(
      `select source_event_id::text, event_type, count(*)::int as event_count
         from public.activity_log
        where source_event_id in ($1, $2, $3, $4, $5)
        group by source_event_id, event_type
        order by source_event_id, event_type`,
      [LEGACY_TASK, WINDOW_TASK, LEGACY_ASSIGNMENT, WINDOW_ASSIGNMENT, INSPECTION],
    ), [
      { source_event_id: LEGACY_TASK, event_type: 'cleaning_task_created', event_count: 1 },
      { source_event_id: LEGACY_TASK, event_type: 'cleaning_task_scheduled', event_count: 1 },
      { source_event_id: WINDOW_TASK, event_type: 'cleaning_task_created', event_count: 1 },
      { source_event_id: WINDOW_TASK, event_type: 'cleaning_task_in_progress', event_count: 1 },
      { source_event_id: LEGACY_ASSIGNMENT, event_type: 'assignment_created', event_count: 1 },
      { source_event_id: LEGACY_ASSIGNMENT, event_type: 'assignment_deactivated', event_count: 1 },
      { source_event_id: WINDOW_ASSIGNMENT, event_type: 'assignment_created', event_count: 1 },
      { source_event_id: WINDOW_ASSIGNMENT, event_type: 'assignment_deactivated', event_count: 1 },
      { source_event_id: INSPECTION, event_type: 'inspection_started', event_count: 1 },
    ], 'old-window backfill is complete and nonduplicated');

    const evidence = await rows<Record<string, unknown>>(
      "select operator_name, legacy_cleaning_tasks_count, legacy_cleaning_tasks_hash, legacy_hk_assignments_count, legacy_hk_assignments_hash, room_work_count_before, room_work_count_after, room_work_hash_before, room_work_hash_after, pms_assignments_count_before, pms_assignments_count_after, pms_assignments_hash_before, pms_assignments_hash_after, inspections_count_before, inspections_count_after, inspections_hash_before, inspections_hash_after, assignment_history_receipts_after, active_assignment_receipts_after, activity_log_count_before, activity_log_count_after, activity_log_hash_before, activity_log_hash_after, physical_legacy_tables_dropped, rollback_policy, remediation_procedure from public.housekeeping_stage_c_cutover_evidence",
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
    const actualReceiptCounts = await rows<{ assignment_history_receipts_after: number; active_assignment_receipts_after: number }>(
      `select
         coalesce(sum(jsonb_array_length(coalesce(assignment_history, '[]'::jsonb))), 0)::int as assignment_history_receipts_after,
         count(*) filter (where assigned_staff_id is not null)::int as active_assignment_receipts_after
       from public.room_work`,
    );
    assert.equal(Number(evidence[0].assignment_history_receipts_after), actualReceiptCounts[0]?.assignment_history_receipts_after);
    assert.equal(Number(evidence[0].active_assignment_receipts_after), actualReceiptCounts[0]?.active_assignment_receipts_after);
    assert.equal(evidence[0].physical_legacy_tables_dropped, true);
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

    assert.equal(await scalar<string | null>(
      "select to_regclass('public.cleaning_tasks')::text",
    ), null);
    assert.equal(await scalar<string | null>(
      "select to_regclass('public.hk_assignments')::text",
    ), null);

    const repo = resolve(new URL('.', import.meta.url).pathname, '..', '..', '..');
    const receiptBefore = await rows<{ run_id: string; cutover_at: string }>(
      'select run_id, cutover_at from public.housekeeping_stage_c_cutover_evidence',
    );
    let rerunError = '';
    try {
      await pg.exec(readFileSync(join(repo, 'supabase', 'migrations', '0437_housekeeping_stage_c_contract.sql'), 'utf8'));
    } catch (error) {
      rerunError = error instanceof Error ? error.message : String(error);
    }
    assert.match(rerunError, /expected physical cleaning_tasks\/hk_assignments tables/i);
    await pg.exec('rollback;').catch(() => undefined);
    assert.deepEqual(await rows<{ run_id: string; cutover_at: string }>(
      'select run_id, cutover_at from public.housekeeping_stage_c_cutover_evidence',
    ), receiptBefore, 'a deterministic post-success rerun cannot replace the immutable receipt');
  });

  test('keeps canonical assign/reset/reassign and started-work protections active', async () => {
    const evidenceBefore = await rows<{ run_id: string; legacy_cleaning_tasks_hash: string }>(
      'select run_id, legacy_cleaning_tasks_hash from public.housekeeping_stage_c_cutover_evidence',
    );
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

    const canonical300 = await scalar<string>(
      "select public.housekeeping_plan_id($1, $2, '300')::text",
      [PROPERTY, BUSINESS_DATE],
    );
    const futureAudit = await rows<{ event_type: string; source: string }>(
      "select event_type, source from public.activity_log where target_id = $1 order by occurred_at, id",
      [canonical300],
    );
    for (const eventType of ['cleaning_task_created', 'assignment_created', 'assignment_deactivated', 'cleaning_task_in_progress']) {
      assert.equal(futureAudit.filter((entry) => entry.event_type === eventType).length >= 1, true, `future canonical ${eventType} audit is present`);
    }
    const futureAuditCounts = new Map<string, number>();
    for (const entry of futureAudit) {
      futureAuditCounts.set(entry.event_type, (futureAuditCounts.get(entry.event_type) ?? 0) + 1);
    }
    assert.deepEqual(
      [...futureAuditCounts.entries()]
        .map(([event_type, event_count]) => ({ event_type, event_count }))
        .sort((a, b) => a.event_type.localeCompare(b.event_type)),
      [
        { event_type: 'assignment_created', event_count: 2 },
        { event_type: 'assignment_deactivated', event_count: 1 },
        { event_type: 'cleaning_task_created', event_count: 1 },
        { event_type: 'cleaning_task_in_progress', event_count: 1 },
      ],
      'future canonical task status and assignment transitions have exact nonduplicate audit receipts',
    );
    assert.equal(futureAudit.some((entry) => entry.source === 'manager_dashboard'), true);
    assert.deepEqual(await rows<{ run_id: string; legacy_cleaning_tasks_hash: string }>(
      'select run_id, legacy_cleaning_tasks_hash from public.housekeeping_stage_c_cutover_evidence',
    ), evidenceBefore, 'future canonical cleanup cannot mutate durable Stage C evidence');
  });

  test('keeps inspection failure/recheck evidence atomic and idempotent', async () => {
    const failed = await rows<{ result: string; failed_items: unknown }>(
      "select * from public.complete_inspection_atomic_canonical($1, $2, 'fail', $3::jsonb, '[]'::jsonb, 'Mirror streaks', false, null, null, 're-clean mirror')",
      [INSPECTION, PROPERTY, JSON.stringify([{ item_id: 'mirror', photo_url: 'inspection-photos/stage-c.jpg', note: 'streaks' }])],
    );
    assert.equal(failed[0].result, 'fail');
    assert.match(JSON.stringify(failed[0].failed_items), /inspection-photos\/stage-c\.jpg/);
    assert.equal(await scalar<number>(
      "select count(*) from public.activity_log where event_type = 'inspection_fail' and source_event_id = $1",
      [INSPECTION],
    ), 1, 'inspection correction transition remains auditable');
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
    assert.deepEqual(await rows<{ source_event_id: string; event_type: string; event_count: number }>(
      `select source_event_id::text, event_type, count(*)::int as event_count
         from public.activity_log
        where source_event_id in ($1, $2)
        group by source_event_id, event_type
        order by source_event_id, event_type`,
      [INSPECTION, RECHECK_INSPECTION],
    ), [
      { source_event_id: INSPECTION, event_type: 'inspection_fail', event_count: 1 },
      { source_event_id: INSPECTION, event_type: 'inspection_started', event_count: 1 },
      { source_event_id: RECHECK_INSPECTION, event_type: 'inspection_pass', event_count: 1 },
      { source_event_id: RECHECK_INSPECTION, event_type: 'inspection_started', event_count: 1 },
    ], 'inspection start/fail/recheck/pass audit transitions are exact and nonduplicated');
  });

  test('enforces service-only ACL/search_path and removes executable legacy seams', async () => {
    const acl = await rows<{
      cleaning_tasks: string | null;
      hk_assignments: string | null;
      evidence_rls: boolean;
      anon_select: boolean;
      service_select: boolean;
      service_insert: boolean;
      service_update: boolean;
      service_delete: boolean;
      pms_anon_insert: boolean;
      plan_anon_select: boolean;
      plan_authenticated_select: boolean;
      plan_service_select: boolean;
      plan_service_insert: boolean;
      plan_service_update: boolean;
      plan_service_delete: boolean;
    }>(
      "select to_regclass('public.cleaning_tasks')::text as cleaning_tasks, to_regclass('public.hk_assignments')::text as hk_assignments, has_table_privilege('anon', 'public.housekeeping_stage_c_cutover_evidence', 'select') as anon_select, has_table_privilege('service_role', 'public.housekeeping_stage_c_cutover_evidence', 'select') as service_select, has_table_privilege('service_role', 'public.housekeeping_stage_c_cutover_evidence', 'insert') as service_insert, has_table_privilege('service_role', 'public.housekeeping_stage_c_cutover_evidence', 'update') as service_update, has_table_privilege('service_role', 'public.housekeeping_stage_c_cutover_evidence', 'delete') as service_delete, has_table_privilege('anon', 'public.pms_housekeeping_assignments', 'insert') as pms_anon_insert, has_table_privilege('anon', 'public.room_work_plan_v1', 'select') as plan_anon_select, has_table_privilege('authenticated', 'public.room_work_plan_v1', 'select') as plan_authenticated_select, has_table_privilege('service_role', 'public.room_work_plan_v1', 'select') as plan_service_select, has_table_privilege('service_role', 'public.room_work_plan_v1', 'insert') as plan_service_insert, has_table_privilege('service_role', 'public.room_work_plan_v1', 'update') as plan_service_update, has_table_privilege('service_role', 'public.room_work_plan_v1', 'delete') as plan_service_delete, (select relrowsecurity from pg_class where oid = 'public.housekeeping_stage_c_cutover_evidence'::regclass) as evidence_rls",
    );
    assert.deepEqual(acl, [{
      cleaning_tasks: null,
      hk_assignments: null,
      anon_select: false,
      service_select: true,
      service_insert: false,
      service_update: false,
      service_delete: false,
      pms_anon_insert: false,
      plan_anon_select: false,
      plan_authenticated_select: false,
      plan_service_select: true,
      plan_service_insert: false,
      plan_service_update: false,
      plan_service_delete: false,
      evidence_rls: true,
    }], 'room_work_plan_v1 is intentionally service-readable only and has no direct DML grant');

    await pg.exec("begin; set local role service_role; select count(*) from public.room_work_plan_v1; rollback;");
    const planBefore = await rows<{ id: string; assigned_staff_id: string | null; assignment_history: unknown }>(
      "select id, assigned_staff_id, assignment_history from public.room_work where property_id = $1 and date = $2 and room_number = '300'",
      [PROPERTY, BUSINESS_DATE],
    );
    for (const statement of [
      "insert into public.room_work_plan_v1(id) values (gen_random_uuid())",
      "update public.room_work_plan_v1 set room_number = '301' where property_id = '" + PROPERTY + "'::uuid and business_date = '" + BUSINESS_DATE + "'::date and room_number = '300'",
      "delete from public.room_work_plan_v1 where property_id = '" + PROPERTY + "'::uuid and business_date = '" + BUSINESS_DATE + "'::date and room_number = '300'",
    ]) {
      assert.match(await failsWithRole('service_role', statement), /permission|cannot|not.*insert|not.*update|not.*delete/i);
    }
    assert.deepEqual(await rows<{ id: string; assigned_staff_id: string | null; assignment_history: unknown }>(
      "select id, assigned_staff_id, assignment_history from public.room_work where property_id = $1 and date = $2 and room_number = '300'",
      [PROPERTY, BUSINESS_DATE],
    ), planBefore, 'direct room_work_plan_v1 DML cannot bypass canonical RPC state');

    assert.match(await failsWith(
      "update public.housekeeping_stage_c_cutover_evidence set operator_name = 'tampered'",
    ), /immutable|permission|not.*update/i);
    assert.match(await failsWith(
      "delete from public.housekeeping_stage_c_cutover_evidence",
    ), /immutable|permission|not.*delete/i);
    assert.equal(await scalar<number>(
      "select count(*) from pg_trigger where tgrelid = 'public.housekeeping_stage_c_cutover_evidence'::regclass and tgname = 'housekeeping_stage_c_cutover_evidence_immutable'",
    ), 1, 'cutover evidence has a cataloged immutable trigger');
    assert.deepEqual(await rows<{ function_name: string }>(
      "select p.oid::regprocedure::text as function_name from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = '_record_housekeeping_stage_c_cutover_evidence' and has_function_privilege('anon', p.oid, 'execute')",
    ), [], 'browser roles cannot invoke the narrow receipt writer');
    assert.equal(await scalar<boolean>(
      "select has_function_privilege('service_role', 'public._record_housekeeping_stage_c_cutover_evidence()', 'execute')",
    ), true, 'service remediation role can invoke the one-time receipt writer');
    await pg.exec("begin; set local role service_role; select count(*) from public.housekeeping_stage_c_cutover_evidence; rollback;");
    let browserReadError = '';
    try {
      await pg.exec("begin; set local role anon; select * from public.housekeeping_stage_c_cutover_evidence;");
    } catch (error) {
      browserReadError = error instanceof Error ? error.message : String(error);
    }
    await pg.exec('rollback;').catch(() => undefined);
    assert.match(browserReadError, /permission|policy|denied/i, 'browser roles cannot read cutover evidence');

    const functions = await rows<{ proconfig: string[] | null; anon_exec: boolean; service_exec: boolean }>(
      "select proconfig, has_function_privilege('anon', 'public.assign_room_work_atomic(uuid,uuid,uuid,uuid,text,integer,numeric,boolean,text)', 'execute') as anon_exec, has_function_privilege('service_role', 'public.assign_room_work_atomic(uuid,uuid,uuid,uuid,text,integer,numeric,boolean,text)', 'execute') as service_exec from pg_proc where oid = 'public.assign_room_work_atomic(uuid,uuid,uuid,uuid,text,integer,numeric,boolean,text)'::regprocedure",
    );
    assert.equal(functions.length, 1);
    assert.match(String(functions[0].proconfig), /search_path=public, pg_temp/);
    assert.equal(functions[0].anon_exec, false);
    assert.equal(functions[0].service_exec, true);

    assert.equal(await scalar<number>(
      "select count(*) from pg_trigger where tgrelid = 'public.room_work'::regclass and not tgisinternal and tgname in ('trg_legacy_cleaning_task_to_room_work', 'trg_legacy_hk_assignment_to_room_work')",
    ), 0, 'canonical room_work has no reverse bridge');
    assert.equal(await scalar<number>(
      "select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname in ('cleaning_tasks', 'hk_assignments') and not t.tgisinternal",
    ), 0, 'no trigger remains attached to a retired legacy relation');
    assert.equal(await scalar<boolean>(
      "select to_regprocedure('public.reassign_cleaning_task(uuid,uuid,uuid,uuid,text)') is null and to_regprocedure('public.complete_inspection_atomic(uuid,uuid,text,jsonb,jsonb,text,boolean,text,timestamptz,text)') is null",
    ), true);

    const canonical300Id = await scalar<string>(
      "select public.housekeeping_plan_id($1, $2, '300')::text",
      [PROPERTY, BUSINESS_DATE],
    );
    const runtimeBefore = await rows<{ assigned_staff_id: string | null; assignment_history: unknown; status: string }>(
      'select assigned_staff_id, assignment_history, status from public.room_work where id = $1',
      [canonical300Id],
    );
    const activityCountBefore = await scalar<number>('select count(*) from public.activity_log');
    for (const statement of [
      'select * from public.cleaning_tasks limit 1',
      'select * from public.hk_assignments limit 1',
      "insert into public.cleaning_tasks(id) values (gen_random_uuid())",
      "update public.hk_assignments set is_active = false where true",
      "delete from public.hk_assignments where true",
      "select * from public.reassign_cleaning_task('" + PROPERTY + "'::uuid, '" + canonical300Id + "'::uuid, '" + HOUSEKEEPER + "'::uuid, '" + SECOND_HOUSEKEEPER + "'::uuid, 'retired RPC')",
      "select * from public.complete_inspection_atomic('" + INSPECTION + "'::uuid, '" + PROPERTY + "'::uuid, 'fail', '[]'::jsonb, '[]'::jsonb, null, false, null, null, null)",
    ]) {
      assert.match(await failsWith(statement), /does not exist|permission|relation|function|not.*found/i, `retired runtime seam must reject: ${statement}`);
    }
    assert.deepEqual(await rows<{ assigned_staff_id: string | null; assignment_history: unknown; status: string }>(
      'select assigned_staff_id, assignment_history, status from public.room_work where id = $1',
      [canonical300Id],
    ), runtimeBefore, 'retired runtime attempts cannot mutate canonical room_work');
    assert.equal(await scalar<number>('select count(*) from public.activity_log'), activityCountBefore, 'retired runtime attempts cannot emit canonical audit rows');
    assert.deepEqual(await rows<{ function_name: string }>(
      "select p.oid::regprocedure::text as function_name from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prokind in ('f', 'p') and pg_get_functiondef(p.oid) ~* '\\m(cleaning_tasks|hk_assignments)\\M' order by 1",
    ), [], 'no executable public function may retain a legacy relation reader or writer reference');

    const repo = resolve(new URL('.', import.meta.url).pathname, '..', '..', '..');
    const legacyCall = /\.from\(\s*['\"](?:cleaning_tasks|hk_assignments)['\"]\s*\)|\.rpc\(\s*['\"](?:complete_inspection_atomic|reassign_cleaning_task)['\"]\s*\)/;
    const legacyRelationName = /\b(?:cleaning_tasks|hk_assignments)\b/;
    for (const root of [join(repo, 'src'), join(repo, 'cua-service'), join(repo, 'scripts')]) {
      for (const file of executableSourceFiles(root)) {
        const executableSource = readFileSync(file, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/^\s*\/\/.*$/gm, '');
        assert.doesNotMatch(executableSource, legacyCall, `legacy executable seam remains in ${file}`);
        assert.doesNotMatch(executableSource, legacyRelationName, `retired housekeeping relation name remains in ${file}`);
      }
    }
  });
});

test('0437 newer legacy reset clears an older canonical assignment while retaining inactive history', async () => {
  const migrated = await applyMigrationsToPgliteWithHook(async ({ pg: db, file }) => {
    if (file === '0434_housekeeping_plan_reconciliation.sql') {
      await seedStageCPreflightWindow(db);
    } else if (file === '0436_housekeeping_stage_b_inspection_lock.sql') {
      const { canonicalChangedAt, resetAt } = await seedCanonicalAssignmentThenLegacyReset(db, 1_000);
      assert.ok(new Date(resetAt).getTime() > new Date(canonicalChangedAt).getTime());
    }
  });
  assert.deepEqual(
    migrated.report.failedAtRuntime.filter((entry) => entry.file.startsWith('043')),
    [],
    'newer reset scenario must complete the real 0434-0437 migration chain',
  );
  const current = await migrated.pg.query<{ assigned_staff_id: string | null }>(
    'select assigned_staff_id from public.room_work where legacy_task_id = $1',
    [LEGACY_TASK],
  );
  assert.equal(current.rows[0]?.assigned_staff_id, null, 'a strictly newer legacy reset clears canonical current assignment');
  const history = await migrated.pg.query<{ active_count: number; inactive_count: number }>(
    `select
       count(*) filter (where (h.snapshot->>'is_active')::boolean)::int as active_count,
       count(*) filter (where not (h.snapshot->>'is_active')::boolean)::int as inactive_count
       from public.room_work w
       cross join lateral jsonb_array_elements(w.assignment_history) h(snapshot)
      where w.legacy_task_id = $1
        and h.snapshot->>'id' = $2`,
    [LEGACY_TASK, LEGACY_ASSIGNMENT],
  );
  assert.equal(history.rows[0]?.active_count, 1, 'original active legacy receipt remains append-only history');
  assert.equal(history.rows[0]?.inactive_count, 2, 'newer legacy reset and canonical supersession remain append-only inactive history');
  await migrated.pg.close();
});

test('0437 older and tied legacy resets cannot erase newer or tied canonical assignment receipts', async () => {
  for (const resetDeltaMs of [-1_000, 0]) {
    const migrated = await applyMigrationsToPgliteWithHook(async ({ pg: db, file }) => {
      if (file === '0434_housekeeping_plan_reconciliation.sql') {
        await seedStageCPreflightWindow(db);
      } else if (file === '0436_housekeeping_stage_b_inspection_lock.sql') {
        const { canonicalChangedAt, resetAt } = await seedCanonicalAssignmentThenLegacyReset(db, resetDeltaMs);
        assert.equal(new Date(resetAt).getTime(), new Date(canonicalChangedAt).getTime() + resetDeltaMs);
      }
    });
    assert.deepEqual(
      migrated.report.failedAtRuntime.filter((entry) => entry.file.startsWith('043')),
      [],
      `reset delta ${resetDeltaMs}ms must complete the real 0434-0437 migration chain`,
    );
    const current = await migrated.pg.query<{ assigned_staff_id: string | null }>(
      'select assigned_staff_id from public.room_work where legacy_task_id = $1',
      [LEGACY_TASK],
    );
    assert.equal(current.rows[0]?.assigned_staff_id, SECOND_HOUSEKEEPER, `reset delta ${resetDeltaMs}ms cannot erase canonical assignment`);
    const activeReceipt = await migrated.pg.query<{ receipt_count: number }>(
      `select count(*)::int as receipt_count
         from public.room_work w
         cross join lateral jsonb_array_elements(w.assignment_history) h(snapshot)
        where w.legacy_task_id = $1
          and h.snapshot->>'housekeeper_id' = $2
          and (h.snapshot->>'is_active')::boolean`,
      [LEGACY_TASK, SECOND_HOUSEKEEPER],
    );
    assert.equal(activeReceipt.rows[0]?.receipt_count, 1, `reset delta ${resetDeltaMs}ms leaves one canonical active receipt`);
    const inactiveLegacy = await migrated.pg.query<{ receipt_count: number }>(
      `select count(*)::int as receipt_count
         from public.room_work w
         cross join lateral jsonb_array_elements(w.assignment_history) h(snapshot)
        where w.legacy_task_id = $1
          and h.snapshot->>'id' = $2
          and not (h.snapshot->>'is_active')::boolean`,
      [LEGACY_TASK, LEGACY_ASSIGNMENT],
    );
    assert.equal(inactiveLegacy.rows[0]?.receipt_count, 2, `reset delta ${resetDeltaMs}ms preserves inactive legacy and canonical supersession history`);
    await migrated.pg.close();
  }
});

test('0437 durable cutover receipt survives property cleanup by design', async () => {
  const migrated = await applyMigrationsToPgliteWithHook(async ({ pg: db, file }) => {
    if (file === '0434_housekeeping_plan_reconciliation.sql') {
      await seedStageCPreflightWindow(db, 'receipt-retention-test-operator');
    }
  });
  assert.deepEqual(migrated.report.failedAtRuntime.filter((entry) => entry.file.startsWith('043')), []);
  const before = await migrated.pg.query<{ run_id: string; migration_version: string; operator_name: string; assignment_history_receipts_after: number; active_assignment_receipts_after: number }>(
    'select run_id, migration_version, operator_name, assignment_history_receipts_after, active_assignment_receipts_after from public.housekeeping_stage_c_cutover_evidence',
  );
  assert.equal(await migrated.pg.query<{ foreign_key_count: number }>(
    "select count(*)::int as foreign_key_count from pg_constraint where conrelid = 'public.housekeeping_stage_c_cutover_evidence'::regclass and contype = 'f'",
  ).then((result) => result.rows[0]?.foreign_key_count), 0, 'receipt intentionally has no tenant/property FK');
  await migrated.pg.query('delete from public.properties where id = $1', [PROPERTY]);
  assert.equal(await migrated.pg.query<{ property_count: number }>(
    'select count(*)::int as property_count from public.properties where id = $1',
    [PROPERTY],
  ).then((result) => result.rows[0]?.property_count), 0);
  assert.deepEqual(await migrated.pg.query<{ run_id: string; migration_version: string; operator_name: string; assignment_history_receipts_after: number; active_assignment_receipts_after: number }>(
    'select run_id, migration_version, operator_name, assignment_history_receipts_after, active_assignment_receipts_after from public.housekeeping_stage_c_cutover_evidence',
  ), before, 'immutable receipt survives the intended property cleanup retention boundary');
  await migrated.pg.close();
});

test('0437 fails at the pre-DROP audit gate before any legacy retirement statement', async () => {
  const migrated = await applyMigrationsToPgliteWithHook(async ({ pg: db, file }) => {
    if (file === '0434_housekeeping_plan_reconciliation.sql') {
      await seedStageCPreflightWindow(db);
    } else if (file === '0437_housekeeping_stage_c_contract.sql') {
      await db.query('create sequence public.stage_c_test_audit_probe_seq');
      await db.query('create sequence public.stage_c_test_retirement_probe_seq');
      await db.query(`
        create or replace function public.stage_c_test_probe_legacy_retirement()
        returns event_trigger
        language plpgsql
        as $function$
        declare
          legacy_task_name text := 'cleaning_' || 'tasks';
          legacy_assignment_name text := 'hk_' || 'assignments';
        begin
          if exists (
            select 1
              from pg_event_trigger_dropped_objects()
             where object_identity ilike ('%' || legacy_task_name || '%')
                or object_identity ilike ('%' || legacy_assignment_name || '%')
                or object_identity ilike '%reassign_cleaning_task%'
                or object_identity ilike '%complete_inspection_atomic%'
          ) then
            perform nextval('public.stage_c_test_retirement_probe_seq');
          end if;
        end;
        $function$;
      `);
      await db.query(`
        create event trigger stage_c_test_probe_legacy_retirement
          on sql_drop
          execute function public.stage_c_test_probe_legacy_retirement()
      `);
      await db.query(`
        create or replace function public.stage_c_test_suppress_activity()
        returns trigger
        language plpgsql
        as $function$
        begin
          perform nextval('public.stage_c_test_audit_probe_seq');
          return null;
        end;
        $function$;
      `);
      await db.query(`
        create trigger stage_c_test_suppress_activity
          before insert on public.activity_log
          for each row execute function public.stage_c_test_suppress_activity()
      `);
    }
  });
  await assertStageCFailurePreservesLegacy(migrated, /audit continuity failure/i, 1, 1);
  assert.equal(
    await migrated.pg.query<{ probe: string }>(
      "select last_value::text as probe from public.stage_c_test_audit_probe_seq",
    ).then((result) => Number(result.rows[0]?.probe ?? '0') > 0),
    true,
    'the audit gate probe must fire before legacy retirement statements are reached',
  );
  assert.equal(
    await migrated.pg.query<{ dropped: boolean }>(
      "select is_called as dropped from public.stage_c_test_retirement_probe_seq",
    ).then((result) => result.rows[0]?.dropped),
    false,
    'no legacy drop statement may be reached after the audit gate failure',
  );
  assert.equal(
    await migrated.pg.query<{ old_rpcs_present: boolean }>(
      `select to_regprocedure('public.reassign_cleaning_task(uuid,uuid,uuid,uuid,text)') is not null
          and to_regprocedure('public.complete_inspection_atomic(uuid,uuid,text,jsonb,jsonb,text,boolean,text,timestamptz,text)') is not null
          as old_rpcs_present`,
    ).then((result) => result.rows[0]?.old_rpcs_present),
    true,
    'audit gate failure must precede retirement of the old RPCs',
  );
  await migrated.pg.close();
});

test('0437 rejects canonical room_work identity corruption before destructive DDL', async () => {
  const migrated = await applyMigrationsToPgliteWithHook(async ({ pg: db, file }) => {
    if (file === '0434_housekeeping_plan_reconciliation.sql') {
      await seedStageCPreflightWindow(db);
    } else if (file === '0437_housekeeping_stage_c_contract.sql') {
      await db.query('drop trigger if exists room_work_fill_identity on public.room_work');
      await db.query(
        'update public.room_work set id = gen_random_uuid() where legacy_task_id = $1',
        [LEGACY_TASK],
      );
    }
  });
  await assertStageCFailurePreservesLegacy(migrated, /room_work identity row\(s\) do not match/i, 1, 1);
  await migrated.pg.close();
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

test('0437 preflight requires a named operator independently of the freeze gate', async () => {
  const migrated = await applyMigrationsToPgliteWithHook(async ({ pg: db, file }) => {
    if (file !== '0434_housekeeping_plan_reconciliation.sql') return;
    await db.query("select set_config('staxis.housekeeping_stage_c_freeze', 'approved', false)");
  });
  await assertStageCFailurePreservesLegacy(migrated, /operator evidence is missing/i, 0, 0);
  await migrated.pg.close();
});

test('0437 rejects duplicate natural keys before dropping either legacy table', async () => {
  const duplicateTask = 'd4000000-0000-4000-8000-000000000001';
  const migrated = await applyMigrationsToPgliteWithHook(async ({ pg: db, file }) => {
    if (file === '0434_housekeeping_plan_reconciliation.sql') {
      await seedStageCPreflightWindow(db);
    } else if (file === '0437_housekeeping_stage_c_contract.sql') {
      await db.query('alter table public.cleaning_tasks drop constraint cleaning_tasks_dedupe_unique');
      await db.query('drop index if exists public.room_work_plan_dedupe_unique');
      await db.query('drop trigger if exists trg_legacy_cleaning_task_to_room_work on public.cleaning_tasks');
      await db.query(
        "insert into public.cleaning_tasks(id, property_id, room_number, business_date, dedupe_key, cleaning_type, priority, estimated_minutes, requires_inspection, extras, notes, rules_fired, rule_inputs, status, source_property_timezone, scheduled_at, last_evaluated_at) values ($1, $2, '103', $3, '101::2026-08-02', 'stayover', 'normal', 20, false, '[]'::jsonb, 'ambiguous task', '[]'::jsonb, '{}'::jsonb, 'scheduled', 'America/Chicago', $4::timestamptz, $4::timestamptz)",
        [duplicateTask, PROPERTY, BUSINESS_DATE, '2026-08-02T12:05:00Z'],
      );
      await db.query(
        "insert into public.room_work(id, legacy_task_id, property_id, date, room_number, plan_dedupe_key, plan_cleaning_type, status) values (public.housekeeping_plan_id($1, $2, '103'), $3, $1, $2, '103', '103::2026-08-02', 'stayover', 'not_started')",
        [PROPERTY, BUSINESS_DATE, duplicateTask],
      );
    }
  });
  await assertStageCFailurePreservesLegacy(migrated, /dedupe group\(s\) are ambiguous/i, 2, 1);
  await migrated.pg.close();
});

test('0437 rejects a cross-property legacy assignment before destructive DDL', async () => {
  const foreignAssignment = 'd5000000-0000-4000-8000-000000000001';
  const migrated = await applyMigrationsToPgliteWithHook(async ({ pg: db, file }) => {
    if (file === '0434_housekeeping_plan_reconciliation.sql') {
      await seedStageCPreflightWindow(db);
    } else if (file === '0435_housekeeping_canonical_operations.sql') {
      await db.query('drop trigger if exists trg_legacy_hk_assignment_to_room_work on public.hk_assignments');
      await db.query(
        "insert into public.hk_assignments(id, property_id, cleaning_task_id, housekeeper_id, queue_order, is_active, assigned_at, assigned_by, reason, score) values ($1, $2, $3, $4, 2, false, $5::timestamptz, 'manual', 'cross-property test', 2.0)",
        [foreignAssignment, OTHER_PROPERTY, LEGACY_TASK, OTHER_HOUSEKEEPER, '2026-08-02T12:06:00Z'],
      );
    }
  });
  await assertStageCFailurePreservesLegacy(migrated, /hk_assignments row\(s\).*same-property/i, 1, 2);
  await migrated.pg.close();
});

test('0437 rejects a cross-property legacy task mapping before destructive DDL', async () => {
  const foreignTask = 'd5000000-0000-4000-8000-000000000002';
  const migrated = await applyMigrationsToPgliteWithHook(async ({ pg: db, file }) => {
    if (file === '0434_housekeeping_plan_reconciliation.sql') {
      await seedStageCPreflightWindow(db);
    } else if (file === '0435_housekeeping_canonical_operations.sql') {
      await db.query('drop trigger if exists trg_legacy_cleaning_task_to_room_work on public.cleaning_tasks');
      await db.query(
        "insert into public.cleaning_tasks(id, property_id, room_number, business_date, dedupe_key, cleaning_type, priority, estimated_minutes, requires_inspection, extras, notes, rules_fired, rule_inputs, status, source_property_timezone, scheduled_at, last_evaluated_at) values ($1, $2, '201', $3, '201::2026-08-02', 'stayover', 'normal', 20, false, '[]'::jsonb, 'cross-property task', '[]'::jsonb, '{}'::jsonb, 'scheduled', 'America/Chicago', $4::timestamptz, $4::timestamptz)",
        [foreignTask, OTHER_PROPERTY, BUSINESS_DATE, '2026-08-02T12:07:00Z'],
      );
    }
  });
  await assertStageCFailurePreservesLegacy(migrated, /cleaning_tasks row\(s\).*same-property canonical room_work owner/i, 2, 1);
  await migrated.pg.close();
});

test('0437 rejects an inactive or wrong-department current staff target before destructive DDL', async () => {
  for (const [, statement] of [
    ['inactive', "update public.staff set is_active = false where id = $1"],
    ['wrong department', "update public.staff set department = 'front_desk' where id = $1"],
  ] as const) {
    const migrated = await applyMigrationsToPgliteWithHook(async ({ pg: db, file }) => {
      if (file === '0434_housekeeping_plan_reconciliation.sql') {
        await seedStageCPreflightWindow(db);
      } else if (file === '0435_housekeeping_canonical_operations.sql') {
        await db.query(statement, [HOUSEKEEPER]);
      }
    });
    await assertStageCFailurePreservesLegacy(migrated, /current assignment row\(s\).*property or department boundary/i);
    await migrated.pg.close();
  }
});

test('0437 rejects missing and wrong-type history is_active values before destructive DDL', async () => {
  for (const [, history] of [
    ['missing', `'[{"id":"c5000000-0000-4000-8000-000000000001"}]'::jsonb`],
    ['wrong type', "'[{\"id\":\"c5000000-0000-4000-8000-000000000001\",\"is_active\":\"true\"}]'::jsonb"],
  ] as const) {
    const migrated = await applyMigrationsToPgliteWithHook(async ({ pg: db, file }) => {
      if (file === '0434_housekeeping_plan_reconciliation.sql') {
        await seedStageCPreflightWindow(db);
      } else if (file === '0435_housekeeping_canonical_operations.sql') {
        await db.query(
          `update public.room_work set assignment_history = ${history} where legacy_task_id = $1`,
          [LEGACY_TASK],
        );
      }
    });
    await assertStageCFailurePreservesLegacy(migrated, /missing a boolean is_active key/i);
    await migrated.pg.close();
  }
});

test('0437 aborts on a PMS count/hash anomaly caused during reconciliation', async () => {
  const pmsAssignment = 'd6000000-0000-4000-8000-000000000001';
  const ingestRun = 'd7000000-0000-4000-8000-000000000001';
  const migrated = await applyMigrationsToPgliteWithHook(async ({ pg: db, file }) => {
    if (file === '0434_housekeeping_plan_reconciliation.sql') {
      await seedStageCPreflightWindow(db);
      await db.query(
        "insert into public.pms_ingest_runs(id, property_id, source_kind, mode, parser_name, parser_version, source_captured_at, started_at, finished_at, status) values ($1, $2, 'cua', 'live', 'stage-c-test', '1', $3::timestamptz, $3::timestamptz, $3::timestamptz, 'succeeded')",
        [ingestRun, PROPERTY, '2026-08-02T11:00:00Z'],
      );
      await db.query(
        "insert into public.pms_housekeeping_assignments(id, property_id, date, room_number, housekeeper_name, cleaning_type, scheduled_time, dnd_active, notes, raw, ingest_run_id) values ($1, $2, $3, '101', 'PMS Housekeeper', 'departure', $4::timestamptz, false, 'PMS parity', '{}'::jsonb, $5)",
        [pmsAssignment, PROPERTY, BUSINESS_DATE, '2026-08-02T12:00:00Z', ingestRun],
      );
    } else if (file === '0437_housekeeping_stage_c_contract.sql') {
      await db.query(`
        create or replace function public.stage_c_test_mutate_pms()
        returns trigger language plpgsql as $function$
        begin
          if current_setting('staxis.stage_c_test_pms_mutation', true) = 'armed' then
            update public.pms_housekeeping_assignments set notes = coalesce(notes, '') || ' mutated' where id = '${pmsAssignment}'::uuid;
            perform set_config('staxis.stage_c_test_pms_mutation', 'spent', true);
          end if;
          return new;
        end;
        $function$;
      `);
      await db.query(
        'create trigger stage_c_test_mutate_pms after update on public.room_work for each row execute function public.stage_c_test_mutate_pms()',
      );
      await db.query("select set_config('staxis.stage_c_test_pms_mutation', 'armed', false)");
    }
  });
  const failure = migrated.report.failedAtRuntime.find((entry) => entry.file === '0437_housekeeping_stage_c_contract.sql');
  assert.ok(failure);
  assert.match(failure.error, /before destructive DDL/i, 'the parity anomaly must abort before the drop statements');
  await assertStageCFailurePreservesLegacy(migrated, /pms_housekeeping_assignments count\/hash changed/i);
  await migrated.pg.close();
});
