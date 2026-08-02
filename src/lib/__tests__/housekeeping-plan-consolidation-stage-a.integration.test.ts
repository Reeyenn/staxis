import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { PGlite } from '@electric-sql/pglite';
import { applyMigrationsToPgliteWithHook } from '../../../tests/fixtures/pglite-migrate';

const OWNER = 'a1000000-0000-4000-8000-000000000001';
const PROPERTY = 'a2000000-0000-4000-8000-000000000001';
const OTHER_PROPERTY = 'a2000000-0000-4000-8000-000000000002';
const HOUSEKEEPER = 'a3000000-0000-4000-8000-000000000001';
const SECOND_HOUSEKEEPER = 'a3000000-0000-4000-8000-000000000002';
const OTHER_HOUSEKEEPER = 'a3000000-0000-4000-8000-000000000003';
const LEGACY_TASK = 'a4000000-0000-4000-8000-000000000001';
const LEGACY_ASSIGNMENT = 'a5000000-0000-4000-8000-000000000001';
const NEW_TASK = 'a4000000-0000-4000-8000-000000000002';
const NEW_ASSIGNMENT = 'a5000000-0000-4000-8000-000000000002';
const PASS_INSPECTION = 'a6000000-0000-4000-8000-000000000001';
const FAIL_TASK = 'a4000000-0000-4000-8000-000000000003';
const FAIL_INSPECTION = 'a6000000-0000-4000-8000-000000000002';
const WRONG_PROPERTY_INSPECTION = 'a6000000-0000-4000-8000-000000000003';
const BUSINESS_DATE = '2026-08-02';

let pg: PGlite;

async function scalar<T>(sql: string, params: unknown[] = []): Promise<T> {
  const result = (await pg.query(sql, params)) as { rows: Array<Record<string, unknown>> };
  assert.ok(result.rows[0], 'expected one database row');
  return Object.values(result.rows[0])[0] as T;
}

async function rows<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const result = (await pg.query(sql, params)) as { rows: T[] };
  return result.rows;
}

async function failsWith(sql: string, params: unknown[] = []): Promise<string> {
  try {
    await pg.query(sql, params);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  assert.fail('expected database statement to fail');
}

describe('housekeeping canonical plan expand stage', () => {
  before(async () => {
    const migrated = await applyMigrationsToPgliteWithHook(async ({ pg: db, file }) => {
      if (file !== '0434_housekeeping_plan_reconciliation.sql') return;

      await db.query(
        "insert into auth.users(id, email) values ($1, 'phase5@example.test') on conflict (id) do nothing",
        [OWNER],
      );
      await db.query(
        "insert into public.properties(id, owner_id, name, total_rooms, timezone) values ($1, $3, 'Phase Five Inn', 60, 'America/Chicago'), ($2, $3, 'Other Phase Five Inn', 30, 'America/Chicago') on conflict (id) do nothing",
        [PROPERTY, OTHER_PROPERTY, OWNER],
      );
      await db.query(
        "insert into public.staff(id, property_id, name, department, is_active) values ($1, $4, 'Alex', 'housekeeping', true), ($2, $4, 'Blair', 'housekeeping', true), ($3, $5, 'Other Hotel', 'housekeeping', true) on conflict (id) do nothing",
        [HOUSEKEEPER, SECOND_HOUSEKEEPER, OTHER_HOUSEKEEPER, PROPERTY, OTHER_PROPERTY],
      );
      await db.query(
        "insert into public.component_rooms(property_id, parent_room_number, child_room_numbers) values ($1, '101', '[\"102\", \"103\"]'::jsonb), ($2, '101', '[\"999\"]'::jsonb) on conflict (property_id, parent_room_number) do update set child_room_numbers = excluded.child_room_numbers",
        [PROPERTY, OTHER_PROPERTY],
      );
      await db.query(
        "insert into public.cleaning_tasks(id, property_id, room_number, business_date, dedupe_key, cleaning_type, priority, estimated_minutes, requires_inspection, extras, notes, rules_fired, rule_inputs, status, assignee_id, source_engine_run_id, source_property_timezone, scheduled_at, last_evaluated_at) values ($1, $2, '101', $3, '101::2026-08-02', 'departure', 'normal', 30, true, '[{\"kind\":\"fruit_basket\"}]'::jsonb, 'legacy task', '[{\"id\":\"rule\"}]'::jsonb, '{\"source\":\"fixture\"}'::jsonb, 'scheduled', $4, $5, 'America/Chicago', $6::timestamptz, $6::timestamptz)",
        [LEGACY_TASK, PROPERTY, BUSINESS_DATE, HOUSEKEEPER, 'b4000000-0000-4000-8000-000000000001', '2026-08-02T12:00:00Z'],
      );
      await db.query(
        "insert into public.hk_assignments(id, property_id, cleaning_task_id, housekeeper_id, queue_order, is_active, assigned_at, assigned_by, assigned_by_user_id, reason, score) values ($1, $2, $3, $4, 1, true, $5::timestamptz, 'auto', null, 'legacy seed', 4.5)",
        [LEGACY_ASSIGNMENT, PROPERTY, LEGACY_TASK, HOUSEKEEPER, '2026-08-02T12:01:00Z'],
      );
    });
    pg = migrated.pg;
    assert.ok(
      migrated.report.applied.includes('0434_housekeeping_plan_reconciliation.sql'),
      JSON.stringify(migrated.report.failedAtRuntime.filter((entry) => entry.file.startsWith('043'))),
    );
    assert.ok(
      migrated.report.applied.includes('0435_housekeeping_canonical_operations.sql'),
      JSON.stringify(migrated.report.failedAtRuntime.filter((entry) => entry.file.startsWith('043'))),
    );
    assert.deepEqual(
      migrated.report.failedAtRuntime.filter((entry) => entry.file.startsWith('043')),
      [],
    );
  });

  after(async () => {
    await pg.close();
  });

  test('keeps physical legacy relations writable and reconciles the seeded pair', async () => {
    const relations = await rows<{ relname: string; relkind: string }>(
      "select relname, relkind from pg_class where relnamespace = 'public'::regnamespace and relname in ('cleaning_tasks', 'hk_assignments', 'room_work_plan_v1') order by relname",
    );
    assert.deepEqual(relations, [
      { relname: 'cleaning_tasks', relkind: 'r' },
      { relname: 'hk_assignments', relkind: 'r' },
      { relname: 'room_work_plan_v1', relkind: 'v' },
    ]);

    const canonical = await rows<{
      legacy_task_id: string;
      plan_cleaning_type: string;
      plan_priority: string;
      plan_status: string;
      assigned_staff_id: string;
      history_count: number;
    }>(
      "select legacy_task_id, plan_cleaning_type, plan_priority, plan_status, assigned_staff_id, jsonb_array_length(assignment_history) as history_count from public.room_work where property_id = $1 and date = $2 and room_number = '101'",
      [PROPERTY, BUSINESS_DATE],
    );
    assert.deepEqual(canonical, [{
      legacy_task_id: LEGACY_TASK,
      plan_cleaning_type: 'departure',
      plan_priority: 'normal',
      plan_status: 'scheduled',
      assigned_staff_id: HOUSEKEEPER,
      history_count: 1,
    }]);

    const triggerNames = await rows<{ tgname: string }>(
      "select tgname from pg_trigger where tgrelid in ('public.cleaning_tasks'::regclass, 'public.hk_assignments'::regclass) and not tgisinternal order by tgname",
    );
    assert.deepEqual(triggerNames.map((row) => row.tgname), [
      'set_updated_at',
      'set_updated_at',
      'trg_activity_log_cleaning_task_ins',
      'trg_activity_log_cleaning_task_upd',
      'trg_activity_log_hk_assignment_ins',
      'trg_activity_log_hk_assignment_upd',
      'trg_legacy_cleaning_task_to_room_work',
      'trg_legacy_hk_assignment_to_room_work',
    ]);
  });

  test('bridges old task and assignment writes atomically, idempotently, and property-safely', async () => {
    await pg.query(
      "insert into public.cleaning_tasks(id, property_id, room_number, business_date, dedupe_key, cleaning_type, priority, estimated_minutes, requires_inspection, extras, rules_fired, status, source_property_timezone, scheduled_at, last_evaluated_at) values ($1, $2, '201', $3, '201::2026-08-02', 'stayover', 'low', 20, false, '[]'::jsonb, '[]'::jsonb, 'scheduled', 'America/Chicago', $4::timestamptz, $4::timestamptz)",
      [NEW_TASK, PROPERTY, BUSINESS_DATE, '2026-08-02T12:00:00Z'],
    );
    assert.equal(
      await scalar<string>("select plan_cleaning_type from public.room_work where legacy_task_id = $1", [NEW_TASK]),
      'stayover',
    );

    const duplicateDedupeError = await failsWith(
      "insert into public.room_work(property_id, date, room_number, plan_dedupe_key, status) values ($1, $2, '999', $3, 'not_started')",
      [PROPERTY, BUSINESS_DATE, '201::2026-08-02'],
    );
    assert.match(duplicateDedupeError, /duplicate|unique/i);

    const repeatedPlan = JSON.stringify([{
      property_id: PROPERTY,
      room_number: '301',
      business_date: BUSINESS_DATE,
      dedupe_key: '301::2026-08-02',
      cleaning_type: 'stayover',
      priority: 'normal',
      status: 'scheduled',
    }]);
    await pg.query("select * from public.upsert_room_work_plan($1, $2::jsonb)", [PROPERTY, repeatedPlan]);
    await pg.query("select * from public.upsert_room_work_plan($1, $2::jsonb)", [PROPERTY, repeatedPlan]);
    assert.equal(
      await scalar<number>(
        "select count(*)::int from public.room_work where property_id = $1 and date = $2 and room_number = '301'",
        [PROPERTY, BUSINESS_DATE],
      ),
      1,
    );

    await pg.query(
      "update public.cleaning_tasks set priority = 'high', status = 'ready_now' where id = $1 and property_id = $2",
      [NEW_TASK, PROPERTY],
    );
    assert.equal(
      await scalar<string>("select plan_status from public.room_work where legacy_task_id = $1", [NEW_TASK]),
      'ready_now',
    );

    await pg.query(
      "insert into public.hk_assignments(id, property_id, cleaning_task_id, housekeeper_id, queue_order, is_active, assigned_at, assigned_by, assigned_by_user_id, reason, score) values ($1, $2, $3, $4, 2, true, $5::timestamptz, 'manual', 'b4000000-0000-4000-8000-000000000002', 'manager', 2.5)",
      [NEW_ASSIGNMENT, PROPERTY, NEW_TASK, SECOND_HOUSEKEEPER, '2026-08-02T12:02:00Z'],
    );
    await pg.query(
      "update public.cleaning_tasks set assignee_id = $1 where id = $2 and property_id = $3",
      [SECOND_HOUSEKEEPER, NEW_TASK, PROPERTY],
    );
    assert.equal(
      await scalar<string>("select assigned_staff_id from public.room_work where legacy_task_id = $1", [NEW_TASK]),
      SECOND_HOUSEKEEPER,
    );

    await pg.query(
      "update public.hk_assignments set is_active = false where id = $1 and property_id = $2",
      [NEW_ASSIGNMENT, PROPERTY],
    );
    assert.equal(
      await scalar<string | null>("select assigned_staff_id from public.room_work where legacy_task_id = $1", [NEW_TASK]),
      null,
    );

    const crossPropertyError = await failsWith(
      "insert into public.hk_assignments(id, property_id, cleaning_task_id, housekeeper_id, is_active, assigned_by) values ('a5000000-0000-4000-8000-000000000003', $1, $2, $3, true, 'auto')",
      [OTHER_PROPERTY, NEW_TASK, OTHER_HOUSEKEEPER],
    );
    assert.match(crossPropertyError, /CROSS_PROPERTY|foreign key/i);
    assert.equal(
      await scalar<string | null>("select assigned_staff_id from public.room_work where legacy_task_id = $1", [NEW_TASK]),
      null,
    );
  });

  test('keeps the old reassignment RPC contract while its writes land canonically', async () => {
    const first = await rows<{ noop: boolean }>(
      "select noop from public.reassign_cleaning_task($1, $2, $3, $4, 'manager move')",
      [PROPERTY, LEGACY_TASK, SECOND_HOUSEKEEPER, OWNER],
    );
    assert.deepEqual(first, [{ noop: false }]);
    assert.equal(
      await scalar<string>("select assigned_staff_id from public.room_work where legacy_task_id = $1", [LEGACY_TASK]),
      SECOND_HOUSEKEEPER,
    );

    const repeat = await rows<{ noop: boolean }>(
      "select noop from public.reassign_cleaning_task($1, $2, $3, $4, 'same move')",
      [PROPERTY, LEGACY_TASK, SECOND_HOUSEKEEPER, OWNER],
    );
    assert.deepEqual(repeat, [{ noop: true }]);
    const crossPropertyError = await failsWith(
      "select * from public.reassign_cleaning_task($1, $2, $3, $4, 'bad move')",
      [PROPERTY, LEGACY_TASK, OTHER_HOUSEKEEPER, OWNER],
    );
    assert.match(crossPropertyError, /not at property|property/i);
    assert.equal(
      await scalar<string>("select assigned_staff_id from public.room_work where legacy_task_id = $1", [LEGACY_TASK]),
      SECOND_HOUSEKEEPER,
    );
  });

  test('completes the exact component set atomically, retries safely, and rolls back on a child failure', async () => {
    await pg.query(
      "insert into public.room_work(property_id, date, room_number, status) values ($1, $2, '101', 'not_started'), ($1, $2, '102', 'not_started'), ($1, $2, '103', 'not_started'), ($1, $2, '104', 'not_started') on conflict (property_id, date, room_number) do update set status = 'not_started', completed_at = null, is_paused = false",
      [PROPERTY, BUSINESS_DATE],
    );
    await pg.query(
      "update public.room_work set status = 'completed', completed_at = now() where property_id = $1 and date = $2 and room_number = '101'",
      [PROPERTY, BUSINESS_DATE],
    );
    const completed = await rows<{ room_number: string; status: string }>(
      "select room_number, status from public.room_work where property_id = $1 and date = $2 and room_number in ('101','102','103','104') order by room_number",
      [PROPERTY, BUSINESS_DATE],
    );
    assert.deepEqual(completed, [
      { room_number: '101', status: 'completed' },
      { room_number: '102', status: 'completed' },
      { room_number: '103', status: 'completed' },
      { room_number: '104', status: 'not_started' },
    ]);

    await pg.query(
      "update public.room_work set status = 'not_started', completed_at = null, is_paused = false where property_id = $1 and date = $2 and room_number in ('101','102','103')",
      [PROPERTY, BUSINESS_DATE],
    );
    await pg.exec("create or replace function public.phase5_fail_component() returns trigger language plpgsql as $$ begin raise exception 'phase5 child failure'; end; $$");
    await pg.exec("create trigger phase5_fail_component before update of status on public.room_work for each row when (new.room_number = '103') execute function public.phase5_fail_component()");
    const failure = await failsWith(
      "update public.room_work set status = 'completed' where property_id = $1 and date = $2 and room_number = '101'",
      [PROPERTY, BUSINESS_DATE],
    );
    assert.match(failure, /phase5 child failure/i);
    assert.deepEqual(
      await rows<{ room_number: string; status: string }>(
        "select room_number, status from public.room_work where property_id = $1 and date = $2 and room_number in ('101','102','103') order by room_number",
        [PROPERTY, BUSINESS_DATE],
      ),
      [
        { room_number: '101', status: 'not_started' },
        { room_number: '102', status: 'not_started' },
        { room_number: '103', status: 'not_started' },
      ],
    );
    await pg.exec("drop trigger phase5_fail_component on public.room_work; drop function public.phase5_fail_component()");

    await pg.query(
      "update public.room_work set status = 'completed' where property_id = $1 and date = $2 and room_number = '101'",
      [PROPERTY, BUSINESS_DATE],
    );
    assert.deepEqual(
      await rows<{ room_number: string; status: string }>(
        "select room_number, status from public.room_work where property_id = $1 and date = $2 and room_number in ('101','102','103') order by room_number",
        [PROPERTY, BUSINESS_DATE],
      ),
      [
        { room_number: '101', status: 'completed' },
        { room_number: '102', status: 'completed' },
        { room_number: '103', status: 'completed' },
      ],
    );
  });

  test('keeps old inspection finalization behavior while reconciling its canonical plan status', async () => {
    await pg.query(
      "insert into public.inspections(id, property_id, room_number, cleaning_task_id, result, started_at) values ($1, $2, '201', $3, 'in_progress', $4::timestamptz)",
      [PASS_INSPECTION, PROPERTY, NEW_TASK, '2026-08-02T13:00:00Z'],
    );
    await pg.query(
      "select * from public.complete_inspection_atomic($1, $2, 'pass', '[]'::jsonb, '[]'::jsonb, null, false, null, null, null)",
      [PASS_INSPECTION, PROPERTY],
    );
    assert.equal(
      await scalar<string>("select status from public.cleaning_tasks where id = $1", [NEW_TASK]),
      'inspected_pass',
    );
    assert.equal(
      await scalar<string>("select plan_status from public.room_work where legacy_task_id = $1", [NEW_TASK]),
      'inspected_pass',
    );
    const retry = await failsWith(
      "select * from public.complete_inspection_atomic($1, $2, 'pass', '[]'::jsonb, '[]'::jsonb, null, false, null, null, null)",
      [PASS_INSPECTION, PROPERTY],
    );
    assert.match(retry, /already/i);

    await pg.query(
      "insert into public.cleaning_tasks(id, property_id, room_number, business_date, dedupe_key, cleaning_type, priority, estimated_minutes, requires_inspection, extras, rules_fired, status, source_property_timezone, scheduled_at, last_evaluated_at) values ($1, $2, '202', $3, '202::2026-08-02', 'stayover', 'normal', 20, false, '[]'::jsonb, '[]'::jsonb, 'scheduled', 'America/Chicago', $4::timestamptz, $4::timestamptz)",
      [FAIL_TASK, PROPERTY, BUSINESS_DATE, '2026-08-02T13:00:00Z'],
    );
    await pg.query(
      "insert into public.inspections(id, property_id, room_number, cleaning_task_id, result, started_at) values ($1, $2, '202', $3, 'in_progress', $4::timestamptz)",
      [FAIL_INSPECTION, PROPERTY, FAIL_TASK, '2026-08-02T13:30:00Z'],
    );
    await pg.query(
      "select * from public.complete_inspection_atomic_canonical($1, $2, 'fail', '[{\"item_id\":\"mirror\"}]'::jsonb, '[]'::jsonb, null, false, null, null, 'mirror streaks')",
      [FAIL_INSPECTION, PROPERTY],
    );
    assert.deepEqual(
      await rows<{ plan_status: string; plan_priority: string; plan_notes: string }>(
        "select plan_status, plan_priority, plan_notes from public.room_work where legacy_task_id = $1",
        [FAIL_TASK],
      ),
      [{ plan_status: 'correction_pending', plan_priority: 'high', plan_notes: 'mirror streaks' }],
    );

    await pg.query(
      "insert into public.inspections(id, property_id, room_number, cleaning_task_id, result, started_at) values ($1, $2, '201', $3, 'in_progress', $4::timestamptz)",
      [WRONG_PROPERTY_INSPECTION, PROPERTY, NEW_TASK, '2026-08-02T14:00:00Z'],
    );
    const wrongProperty = await failsWith(
      "select * from public.complete_inspection_atomic($1, $2, 'pass', '[]'::jsonb, '[]'::jsonb, null, false, null, null, null)",
      [WRONG_PROPERTY_INSPECTION, OTHER_PROPERTY],
    );
    assert.match(wrongProperty, /does not belong|not found/i);
    assert.equal(
      await scalar<string>("select result from public.inspections where id = $1", [WRONG_PROPERTY_INSPECTION]),
      'in_progress',
    );
  });

  test('0434 blocks inactive cross-property assignment history instead of dropping it', async () => {
    const invalid = await applyMigrationsToPgliteWithHook(async ({ pg: db, file }) => {
      if (file !== '0434_housekeeping_plan_reconciliation.sql') return;

      await db.query(
        "insert into auth.users(id, email) values ($1, 'phase5-inactive@example.test') on conflict (id) do nothing",
        [OWNER],
      );
      await db.query(
        "insert into public.properties(id, owner_id, name, total_rooms, timezone) values ($1, $3, 'Phase Five Inn', 60, 'America/Chicago'), ($2, $3, 'Other Phase Five Inn', 30, 'America/Chicago') on conflict (id) do nothing",
        [PROPERTY, OTHER_PROPERTY, OWNER],
      );
      await db.query(
        "insert into public.staff(id, property_id, name, department, is_active) values ($1, $3, 'Historical Housekeeper', 'housekeeping', true), ($2, $4, 'Other Historical Housekeeper', 'housekeeping', true) on conflict (id) do nothing",
        [HOUSEKEEPER, OTHER_HOUSEKEEPER, PROPERTY, OTHER_PROPERTY],
      );
      await db.query(
        "insert into public.cleaning_tasks(id, property_id, room_number, business_date, dedupe_key, cleaning_type, priority, estimated_minutes, requires_inspection, extras, notes, rules_fired, rule_inputs, status, assignee_id, source_engine_run_id, source_property_timezone, scheduled_at, last_evaluated_at) values ($1, $2, '401', $3, '401::2026-08-02', 'stayover', 'normal', 20, false, '[]'::jsonb, 'inactive history', '[]'::jsonb, '{}'::jsonb, 'scheduled', null, $4, 'America/Chicago', $5::timestamptz, $5::timestamptz)",
        [FAIL_TASK, PROPERTY, BUSINESS_DATE, 'b4000000-0000-4000-8000-000000000004', '2026-08-02T12:00:00Z'],
      );
      await db.query(
        "insert into public.hk_assignments(id, property_id, cleaning_task_id, housekeeper_id, queue_order, is_active, assigned_at, assigned_by, reason, score) values ($1, $2, $3, $4, 1, false, $5::timestamptz, 'manual', 'historical cross-property row', 1.0)",
        [NEW_ASSIGNMENT, OTHER_PROPERTY, FAIL_TASK, OTHER_HOUSEKEEPER, '2026-07-01T12:01:00Z'],
      );
    });

    try {
      const failure = invalid.report.failedAtRuntime.find(
        (entry) => entry.file === '0434_housekeeping_plan_reconciliation.sql',
      );
      assert.ok(failure, JSON.stringify(invalid.report.failedAtRuntime.filter((entry) => entry.file.startsWith('043'))));
      assert.match(failure.error, /assignment history row/i);
      assert.equal(
        invalid.report.applied.includes('0434_housekeeping_plan_reconciliation.sql'),
        false,
      );
      await invalid.pg.exec('rollback;').catch(() => undefined);
      const historyRows = await invalid.pg.query<{ count: number }>(
        "select count(*)::int as count from public.hk_assignments where id = $1",
        [NEW_ASSIGNMENT],
      );
      assert.deepEqual(historyRows.rows, [{ count: 1 }]);
    } finally {
      await invalid.pg.close();
    }
  });
});
