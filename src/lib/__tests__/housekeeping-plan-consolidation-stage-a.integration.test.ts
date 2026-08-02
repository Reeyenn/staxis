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
const WINDOW_TASK = 'a4000000-0000-4000-8000-000000000006';
const WINDOW_ASSIGNMENT = 'a5000000-0000-4000-8000-000000000006';
const CACHE_ONLY_TASK = 'a4000000-0000-4000-8000-000000000007';
const HISTORY_ONLY_TASK = 'a4000000-0000-4000-8000-000000000009';
const HISTORY_ONLY_ASSIGNMENT = 'a5000000-0000-4000-8000-000000000007';
const INELIGIBLE_TASK = 'a4000000-0000-4000-8000-000000000010';
const HISTORY_WRONG_ROOM_TASK = 'a4000000-0000-4000-8000-000000000011';
const HISTORY_LINKED_TASK = 'a4000000-0000-4000-8000-000000000012';
const HISTORY_LIFECYCLE_TASK_ONE = 'a4000000-0000-4000-8000-000000000013';
const HISTORY_LIFECYCLE_TASK_TWO = 'a4000000-0000-4000-8000-000000000014';
const HISTORY_LIFECYCLE_TASK_THREE = 'a4000000-0000-4000-8000-000000000015';
const HISTORY_LIFECYCLE_ASSIGNMENT_ONE = 'a5000000-0000-4000-8000-000000000008';
const HISTORY_LIFECYCLE_ASSIGNMENT_TWO = 'a5000000-0000-4000-8000-000000000009';
const HISTORY_LIFECYCLE_ASSIGNMENT_THREE = 'a5000000-0000-4000-8000-000000000010';
const HISTORY_LIFECYCLE_ASSIGNMENT_FOUR = 'a5000000-0000-4000-8000-000000000011';
const HISTORY_MISSING_ID_TASK = 'a4000000-0000-4000-8000-000000000016';
const HISTORY_STALE_TASK = 'a4000000-0000-4000-8000-000000000017';
const HISTORY_STALE_ASSIGNMENT = 'a5000000-0000-4000-8000-000000000012';
const HISTORY_STALE_ROOM_ASSIGNMENT = 'a5000000-0000-4000-8000-000000000013';
const LOCK_BRIDGE_TASK = 'a4000000-0000-4000-8000-000000000018';
const LOCK_BRIDGE_ASSIGNMENT = 'a5000000-0000-4000-8000-000000000014';
const INACTIVE_STAFF = 'a3000000-0000-4000-8000-000000000004';
const NON_HOUSEKEEPING_STAFF = 'a3000000-0000-4000-8000-000000000005';
const DUPLICATE_TASK_ONE = 'a4000000-0000-4000-8000-000000000004';
const DUPLICATE_TASK_TWO = 'a4000000-0000-4000-8000-000000000005';
const PASS_INSPECTION = 'a6000000-0000-4000-8000-000000000001';
const FAIL_TASK = 'a4000000-0000-4000-8000-000000000003';
const FAIL_INSPECTION = 'a6000000-0000-4000-8000-000000000002';
const WRONG_PROPERTY_INSPECTION = 'a6000000-0000-4000-8000-000000000003';
const LEGACY_FAIL_TASK = 'a4000000-0000-4000-8000-000000000008';
const LEGACY_FAIL_INSPECTION = 'a6000000-0000-4000-8000-000000000004';
const DIFFERENT_ROOM_INSPECTION = 'a6000000-0000-4000-8000-000000000005';
const ROOM_ONLY_INSPECTION = 'a6000000-0000-4000-8000-000000000006';
const BUSINESS_DATE = '2026-08-02';
const LOCK_DATE = '2026-08-03';

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

async function seedHistoryProperty(db: PGlite, email: string): Promise<void> {
  await db.query(
    "insert into auth.users(id, email) values ($1, $2) on conflict (id) do nothing",
    [OWNER, email],
  );
  await db.query(
    "insert into public.properties(id, owner_id, name, total_rooms, timezone) values ($1, $2, 'Phase Five Inn', 80, 'America/Chicago') on conflict (id) do nothing",
    [PROPERTY, OWNER],
  );
  await db.query(
    "insert into public.staff(id, property_id, name, department, is_active) values ($1, $2, 'History Housekeeper', 'housekeeping', true) on conflict (id) do nothing",
    [HOUSEKEEPER, PROPERTY],
  );
}

describe('housekeeping canonical plan expand stage', () => {
  before(async () => {
    const migrated = await applyMigrationsToPgliteWithHook(async ({ pg: db, file }) => {
      if (
        file !== '0434_housekeeping_plan_reconciliation.sql'
        && file !== '0435_housekeeping_canonical_operations.sql'
      ) return;

      if (file === '0435_housekeeping_canonical_operations.sql') {
        // This write occurs after 0434 commits and before 0435 begins. The
        // bridge installed by 0434 must preserve it without waiting for 0435.
        await db.query(
          "insert into public.cleaning_tasks(id, property_id, room_number, business_date, dedupe_key, cleaning_type, priority, estimated_minutes, requires_inspection, extras, rules_fired, status, source_property_timezone, scheduled_at, last_evaluated_at) values ($1, $2, '601', $3, '601::2026-08-02', 'stayover', 'normal', 20, false, '[]'::jsonb, '[]'::jsonb, 'scheduled', 'America/Chicago', $4::timestamptz, $4::timestamptz)",
          [WINDOW_TASK, PROPERTY, BUSINESS_DATE, '2026-08-02T12:04:00Z'],
        );
        await db.query(
          "insert into public.hk_assignments(id, property_id, cleaning_task_id, housekeeper_id, queue_order, is_active, assigned_at, assigned_by, reason, score) values ($1, $2, $3, $4, 5, true, $5::timestamptz, 'auto', 'between migration writes', 3.5)",
          [WINDOW_ASSIGNMENT, PROPERTY, WINDOW_TASK, HOUSEKEEPER, '2026-08-02T12:05:00Z'],
        );
        return;
      }

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
        "insert into public.component_rooms(property_id, parent_room_number, child_room_numbers) values ($1, '101', '[\"102\", \"103\"]'::jsonb), ($1, '900', '[\"100\"]'::jsonb), ($2, '101', '[\"999\"]'::jsonb) on conflict (property_id, parent_room_number) do update set child_room_numbers = excluded.child_room_numbers",
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
      await db.query(
        "alter table public.room_work add column if not exists assignment_history jsonb",
      );
      await db.query(
        "insert into public.cleaning_tasks(id, property_id, room_number, business_date, dedupe_key, cleaning_type, priority, estimated_minutes, requires_inspection, extras, rules_fired, status, source_engine_run_id, source_property_timezone, scheduled_at, last_evaluated_at) values ($1, $2, '607', $3, '607::2026-08-02', 'stayover', 'normal', 20, false, '[]'::jsonb, '[]'::jsonb, 'scheduled', $4, 'America/Chicago', $5::timestamptz, $5::timestamptz)",
        [HISTORY_ONLY_TASK, PROPERTY, BUSINESS_DATE, 'b4000000-0000-4000-8000-000000000009', '2026-07-31T12:00:00Z'],
      );
      await db.query(
        "insert into public.room_work(property_id, date, room_number, status, assigned_staff_id, assigned_source, assignment_history) values ($1, $2, '607', 'not_started', null, null, jsonb_build_array(jsonb_build_object('id', $3::uuid, 'property_id', $1::uuid, 'cleaning_task_id', $4::uuid, 'housekeeper_id', $5::uuid, 'queue_order', 8, 'is_active', true, 'assigned_at', $6::timestamptz, 'assigned_by', 'auto', 'assigned_by_user_id', $7::uuid, 'reason', 'history source', 'score', 8.5, 'created_at', $6::timestamptz, 'updated_at', $6::timestamptz, 'event', 'preexisting')))",
        [PROPERTY, BUSINESS_DATE, HISTORY_ONLY_ASSIGNMENT, HISTORY_ONLY_TASK, HOUSEKEEPER, '2026-07-31T12:01:00Z', OWNER],
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

    assert.deepEqual(
      await rows<{
        legacy_task_id: string;
        assigned_staff_id: string;
        queue_order: number;
        history_id: string;
        history_event: string;
      }>(
        "select legacy_task_id, assigned_staff_id, assignment_queue_order as queue_order, assignment_history->-1->>'id' as history_id, assignment_history->-1->>'event' as history_event from public.room_work where legacy_task_id = $1",
        [WINDOW_TASK],
      ),
      [{
        legacy_task_id: WINDOW_TASK,
        assigned_staff_id: HOUSEKEEPER,
        queue_order: 5,
        history_id: WINDOW_ASSIGNMENT,
        history_event: 'assigned',
      }],
      '0434 bridge must capture old-app writes made before 0435 begins',
    );

    assert.equal(
      await scalar<number>(
        "select count(*)::int from public.hk_assignments where property_id = $1 and cleaning_task_id = $2 and is_active",
        [PROPERTY, HISTORY_ONLY_TASK],
      ),
      0,
      'history-only restoration must not have an active legacy assignment source',
    );
    assert.equal(
      await scalar<string | null>(
        "select assignee_id from public.cleaning_tasks where id = $1",
        [HISTORY_ONLY_TASK],
      ),
      null,
      'history-only restoration must not have a task cache source',
    );
    const historyOnly = await rows<{
      assigned_staff_id: string;
      assigned_source: string;
      queue_order: number;
      assigned_at: string | null;
      assigned_at_matches: boolean;
      assigned_by: string | null;
      assigned_by_user_id: string | null;
      reason: string | null;
      score: string | null;
      history: Record<string, unknown>;
    }>(
      "select assigned_staff_id, assigned_source, assignment_queue_order as queue_order, assignment_assigned_at::text as assigned_at, assignment_assigned_at = (assignment_history->0->>'assigned_at')::timestamptz as assigned_at_matches, assignment_assigned_by as assigned_by, assignment_assigned_by_user_id as assigned_by_user_id, assignment_reason as reason, assignment_score::text as score, assignment_history->0 as history from public.room_work where property_id = $1 and date = $2 and room_number = '607'",
      [PROPERTY, BUSINESS_DATE],
    );
    assert.equal(historyOnly.length, 1);
    assert.equal(historyOnly[0].assigned_staff_id, HOUSEKEEPER);
    assert.equal(historyOnly[0].assigned_source, 'auto');
    assert.equal(historyOnly[0].queue_order, 8);
    assert.ok(historyOnly[0].assigned_at);
    assert.equal(historyOnly[0].assigned_at_matches, true);
    assert.equal(historyOnly[0].assigned_by, 'auto');
    assert.equal(historyOnly[0].assigned_by_user_id, OWNER);
    assert.equal(historyOnly[0].reason, 'history source');
    assert.equal(historyOnly[0].score, '8.5');
    assert.equal(historyOnly[0].history.id, HISTORY_ONLY_ASSIGNMENT);
    assert.equal(historyOnly[0].history.property_id, PROPERTY);
    assert.equal(historyOnly[0].history.cleaning_task_id, HISTORY_ONLY_TASK);
    assert.equal(historyOnly[0].history.housekeeper_id, HOUSEKEEPER);
    assert.equal(historyOnly[0].history.queue_order, 8);
    assert.equal(historyOnly[0].history.is_active, true);
    assert.equal(Date.parse(String(historyOnly[0].history.assigned_at)), Date.parse('2026-07-31T12:01:00Z'));
    assert.equal(historyOnly[0].history.assigned_by, 'auto');
    assert.equal(historyOnly[0].history.assigned_by_user_id, OWNER);
    assert.equal(historyOnly[0].history.reason, 'history source');
    assert.equal(historyOnly[0].history.score, 8.5);
    assert.equal(historyOnly[0].history.event, 'preexisting');
    assert.equal(
      await scalar<number>(
        "select jsonb_array_length(assignment_history)::int from public.room_work where property_id = $1 and date = $2 and room_number = '607'",
        [PROPERTY, BUSINESS_DATE],
      ),
      1,
      'history-only restoration must preserve the one valid receipt without synthesizing a duplicate',
    );

    await pg.query(
      "insert into public.pms_ingest_runs(id, property_id, source_kind, parser_name, parser_version, source_captured_at, status) values ('a9000000-0000-4000-8000-000000000001', $1, 'legacy', 'phase5-test', '1', $2::timestamptz, 'succeeded') on conflict (id) do nothing",
      [PROPERTY, '2026-08-02T12:00:00Z'],
    );
    await pg.query(
      "insert into public.pms_housekeeping_assignments(id, property_id, date, room_number, housekeeper_name, cleaning_type, notes, ingest_run_id) values ('a7000000-0000-4000-8000-000000000001', $1, $2, '701', 'PMS Name', 'stayover', 'PMS-only plan row', 'a9000000-0000-4000-8000-000000000001')",
      [PROPERTY, BUSINESS_DATE],
    );
    assert.deepEqual(
      await rows<{
        room_work_id: string;
        room_number: string;
        business_date: string;
        cleaning_type: string;
        status: string;
        pms_housekeeper_name: string;
      }>(
        "select room_work_id::text, room_number, business_date::text, cleaning_type, status, pms_housekeeper_name from public.room_work_plan_v1 where property_id = $1 and business_date = $2 and room_number = '701'",
        [PROPERTY, BUSINESS_DATE],
      ),
      [{
        room_work_id: await scalar<string>(
          "select public.housekeeping_plan_id($1, $2, '701')::text",
          [PROPERTY, BUSINESS_DATE],
        ),
        room_number: '701',
        business_date: BUSINESS_DATE,
        cleaning_type: 'stayover',
        status: 'scheduled',
        pms_housekeeper_name: 'PMS Name',
      }],
    );

    await pg.query(
      "insert into public.pms_housekeeping_assignments(id, property_id, date, room_number, housekeeper_name, cleaning_type, notes, ingest_run_id) values ('a7000000-0000-4000-8000-000000000002', $1, $2, '704', 'PMS Arrival', 'arrival', 'arrival plan', 'a9000000-0000-4000-8000-000000000001')",
      [PROPERTY, BUSINESS_DATE],
    );
    assert.equal(
      await scalar<string>(
        "select cleaning_type from public.room_work_plan_v1 where property_id = $1 and business_date = $2 and room_number = '704'",
        [PROPERTY, BUSINESS_DATE],
      ),
      'no_clean',
      'the canonical read model must expose only the valid cleaning-type vocabulary',
    );

    const privileges = await rows<{
      function_name: string;
      service_role_execute: boolean;
      anon_execute: boolean;
      authenticated_execute: boolean;
    }>(
      `select function_name,
              has_function_privilege('service_role', function_name, 'execute') as service_role_execute,
              has_function_privilege('anon', function_name, 'execute') as anon_execute,
              has_function_privilege('authenticated', function_name, 'execute') as authenticated_execute
         from (values
           ('public.housekeeping_plan_id(uuid,date,text)'::text),
           ('public._room_work_fill_identity()'::text),
           ('public._legacy_cleaning_task_to_room_work()'::text),
           ('public._legacy_hk_assignment_to_room_work()'::text),
           ('public._lock_room_work_component_set(uuid,date,text[])'::text),
           ('public._room_work_complete_components()'::text),
           ('public._activity_log_on_room_work_change()'::text),
           ('public.write_room_work_atomic(uuid,date,text,jsonb,text,boolean)'::text)
         ) functions(function_name)
        order by function_name`,
    );
    assert.deepEqual(
      privileges,
      [
        'public._activity_log_on_room_work_change()',
        'public._legacy_cleaning_task_to_room_work()',
        'public._legacy_hk_assignment_to_room_work()',
        'public._lock_room_work_component_set(uuid,date,text[])',
        'public._room_work_complete_components()',
        'public._room_work_fill_identity()',
        'public.housekeeping_plan_id(uuid,date,text)',
        'public.write_room_work_atomic(uuid,date,text,jsonb,text,boolean)',
      ].map((function_name) => ({
        function_name,
        service_role_execute: true,
        anon_execute: false,
        authenticated_execute: false,
      })),
    );

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

    await pg.query(
      "insert into public.staff(id, property_id, name, department, is_active) values ($1, $3, 'Inactive Cache Target', 'housekeeping', false), ($2, $3, 'Non-Housekeeping Cache Target', 'front_desk', true) on conflict (id) do nothing",
      [INACTIVE_STAFF, NON_HOUSEKEEPING_STAFF, PROPERTY],
    );
    const inactiveCacheError = await failsWith(
      "update public.cleaning_tasks set assignee_id = $1 where id = $2",
      [INACTIVE_STAFF, NEW_TASK],
    );
    assert.match(inactiveCacheError, /active same-property housekeeper|invalid target/i);
    const nonHousekeepingCacheError = await failsWith(
      "update public.cleaning_tasks set assignee_id = $1 where id = $2",
      [NON_HOUSEKEEPING_STAFF, NEW_TASK],
    );
    assert.match(nonHousekeepingCacheError, /active same-property housekeeper|invalid target/i);
    assert.deepEqual(
      await rows<{ assignee_id: string | null; assigned_staff_id: string | null }>(
        "select t.assignee_id, w.assigned_staff_id from public.cleaning_tasks t join public.room_work w on w.legacy_task_id = t.id where t.id = $1",
        [NEW_TASK],
      ),
      [{ assignee_id: null, assigned_staff_id: null }],
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
    const repeatedPlanUpdatedAt = await scalar<string>(
      "select updated_at::text from public.room_work where property_id = $1 and date = $2 and room_number = '301'",
      [PROPERTY, BUSINESS_DATE],
    );
    await pg.query("select * from public.upsert_room_work_plan($1, $2::jsonb)", [PROPERTY, repeatedPlan]);
    assert.equal(
      await scalar<number>(
        "select count(*)::int from public.room_work where property_id = $1 and date = $2 and room_number = '301'",
        [PROPERTY, BUSINESS_DATE],
      ),
      1,
    );
    assert.equal(
      await scalar<string>(
        "select updated_at::text from public.room_work where property_id = $1 and date = $2 and room_number = '301'",
        [PROPERTY, BUSINESS_DATE],
      ),
      repeatedPlanUpdatedAt,
      'an exact rules-engine retry must not churn updated_at',
    );

    const stableRoomId = await scalar<string>(
      "select public.housekeeping_plan_id($1, $2, '302')::text",
      [PROPERTY, BUSINESS_DATE],
    );
    await pg.query(
      "insert into public.room_work(id, property_id, date, room_number, status) values ($1, $2, $3, '302', 'not_started')",
      [stableRoomId, PROPERTY, BUSINESS_DATE],
    );
    const wrongSuppliedId = await failsWith(
      "insert into public.room_work(id, property_id, date, room_number, status) values ('a8000000-0000-4000-8000-000000000001', $1, $2, '303', 'not_started')",
      [PROPERTY, BUSINESS_DATE],
    );
    assert.match(wrongSuppliedId, /ROOM_WORK_IDENTITY_MISMATCH/i);
    const wrongUpdatedId = await failsWith(
      "update public.room_work set id = 'a8000000-0000-4000-8000-000000000002' where property_id = $1 and date = $2 and room_number = '302'",
      [PROPERTY, BUSINESS_DATE],
    );
    assert.match(wrongUpdatedId, /ROOM_WORK_IDENTITY_MISMATCH/i);
    assert.equal(
      await scalar<string>(
        "select id::text from public.room_work where property_id = $1 and date = $2 and room_number = '302'",
        [PROPERTY, BUSINESS_DATE],
      ),
      stableRoomId,
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

    const initialAssignmentHistoryCount = await scalar<number>(
      "select jsonb_array_length(assignment_history)::int from public.room_work where legacy_task_id = $1",
      [LEGACY_TASK],
    );
    await pg.query(
      "update public.hk_assignments set queue_order = 3, reason = 'metadata update', score = 6.25 where id = $1",
      [LEGACY_ASSIGNMENT],
    );
    const metadataUpdate = await rows<{
      snapshot: Record<string, unknown>;
      assigned_staff_id: string | null;
      assignment_queue_order: number;
      assignment_reason: string | null;
    }>(
      "select assignment_history->-1 as snapshot, assigned_staff_id, assignment_queue_order, assignment_reason from public.room_work where legacy_task_id = $1",
      [LEGACY_TASK],
    );
    assert.equal(metadataUpdate[0].snapshot.id, LEGACY_ASSIGNMENT);
    assert.equal(metadataUpdate[0].snapshot.property_id, PROPERTY);
    assert.equal(metadataUpdate[0].snapshot.cleaning_task_id, LEGACY_TASK);
    assert.equal(metadataUpdate[0].snapshot.housekeeper_id, HOUSEKEEPER);
    assert.equal(metadataUpdate[0].snapshot.queue_order, 3);
    assert.equal(metadataUpdate[0].snapshot.is_active, true);
    assert.equal(metadataUpdate[0].snapshot.assigned_by, 'auto');
    assert.equal(metadataUpdate[0].snapshot.reason, 'metadata update');
    assert.equal(metadataUpdate[0].snapshot.score, 6.25);
    assert.equal(metadataUpdate[0].assigned_staff_id, HOUSEKEEPER);
    assert.equal(metadataUpdate[0].assignment_queue_order, 3);
    assert.equal(metadataUpdate[0].assignment_reason, 'metadata update');
    assert.equal(
      await scalar<number>(
        "select jsonb_array_length(assignment_history)::int from public.room_work where legacy_task_id = $1",
        [LEGACY_TASK],
      ),
      initialAssignmentHistoryCount + 1,
    );

    await pg.query(
      "update public.hk_assignments set is_active = false where id = $1",
      [LEGACY_ASSIGNMENT],
    );
    const inactiveAssignment = await rows<{
      snapshot: Record<string, unknown>;
      assigned_staff_id: string | null;
      assigned_source: string | null;
      assignment_queue_order: number;
      assignment_reason: string | null;
    }>(
      "select assignment_history->-1 as snapshot, assigned_staff_id, assigned_source, assignment_queue_order, assignment_reason from public.room_work where legacy_task_id = $1",
      [LEGACY_TASK],
    );
    assert.equal(inactiveAssignment[0].snapshot.id, LEGACY_ASSIGNMENT);
    assert.equal(inactiveAssignment[0].snapshot.property_id, PROPERTY);
    assert.equal(inactiveAssignment[0].snapshot.cleaning_task_id, LEGACY_TASK);
    assert.equal(inactiveAssignment[0].snapshot.housekeeper_id, HOUSEKEEPER);
    assert.equal(inactiveAssignment[0].snapshot.queue_order, 3);
    assert.equal(inactiveAssignment[0].snapshot.is_active, false);
    assert.equal(inactiveAssignment[0].snapshot.event, 'deactivated');
    assert.equal(inactiveAssignment[0].assigned_staff_id, null);
    assert.equal(inactiveAssignment[0].assigned_source, null);
    assert.equal(inactiveAssignment[0].assignment_queue_order, 0);
    assert.equal(inactiveAssignment[0].assignment_reason, null);
    assert.equal(
      await scalar<number>(
        "select jsonb_array_length(assignment_history)::int from public.room_work where legacy_task_id = $1",
        [LEGACY_TASK],
      ),
      initialAssignmentHistoryCount + 2,
    );

    const reactivationAssignedAt = '2026-08-02T12:06:00Z';
    await pg.query(
      "update public.hk_assignments set is_active = true, queue_order = 4, assigned_at = $1::timestamptz, assigned_by = 'manual', assigned_by_user_id = $2, reason = 'reactivated', score = 7.75 where id = $3",
      [reactivationAssignedAt, OWNER, LEGACY_ASSIGNMENT],
    );
    const reactivatedAssignment = await rows<{
      snapshot: Record<string, unknown>;
      assigned_staff_id: string | null;
      assignment_queue_order: number;
      assignment_assigned_by: string | null;
      assignment_assigned_by_user_id: string | null;
      assignment_reason: string | null;
      assignment_score: number | null;
    }>(
      "select assignment_history->-1 as snapshot, assigned_staff_id, assignment_queue_order, assignment_assigned_by, assignment_assigned_by_user_id, assignment_reason, assignment_score from public.room_work where legacy_task_id = $1",
      [LEGACY_TASK],
    );
    assert.equal(reactivatedAssignment[0].snapshot.id, LEGACY_ASSIGNMENT);
    assert.equal(reactivatedAssignment[0].snapshot.property_id, PROPERTY);
    assert.equal(reactivatedAssignment[0].snapshot.cleaning_task_id, LEGACY_TASK);
    assert.equal(reactivatedAssignment[0].snapshot.housekeeper_id, HOUSEKEEPER);
    assert.equal(reactivatedAssignment[0].snapshot.queue_order, 4);
    assert.equal(reactivatedAssignment[0].snapshot.is_active, true);
    assert.equal(reactivatedAssignment[0].snapshot.event, 'reactivated');
    assert.equal(reactivatedAssignment[0].snapshot.assigned_by, 'manual');
    assert.equal(reactivatedAssignment[0].snapshot.assigned_by_user_id, OWNER);
    assert.equal(reactivatedAssignment[0].snapshot.reason, 'reactivated');
    assert.equal(reactivatedAssignment[0].snapshot.score, 7.75);
    assert.equal(reactivatedAssignment[0].assigned_staff_id, HOUSEKEEPER);
    assert.equal(reactivatedAssignment[0].assignment_queue_order, 4);
    assert.equal(reactivatedAssignment[0].assignment_assigned_by, 'manual');
    assert.equal(reactivatedAssignment[0].assignment_assigned_by_user_id, OWNER);
    assert.equal(reactivatedAssignment[0].assignment_reason, 'reactivated');
    assert.equal(reactivatedAssignment[0].assignment_score, '7.75');
    const historyAfterReactivation = await scalar<number>(
      "select jsonb_array_length(assignment_history)::int from public.room_work where legacy_task_id = $1",
      [LEGACY_TASK],
    );
    assert.equal(historyAfterReactivation, initialAssignmentHistoryCount + 3);

    await pg.query(
      "update public.hk_assignments set is_active = true, queue_order = 4, assigned_at = $1::timestamptz, assigned_by = 'manual', assigned_by_user_id = $2, reason = 'reactivated', score = 7.75 where id = $3",
      [reactivationAssignedAt, OWNER, LEGACY_ASSIGNMENT],
    );
    assert.equal(
      await scalar<number>(
        "select jsonb_array_length(assignment_history)::int from public.room_work where legacy_task_id = $1",
        [LEGACY_TASK],
      ),
      historyAfterReactivation,
      'an exact retry compares against the latest full snapshot, not historical-ever activity',
    );

    const baselineAssignment = await rows<{
      id: string;
      property_id: string;
      cleaning_task_id: string;
      housekeeper_id: string;
      is_active: boolean;
    }>(
      "select id, property_id, cleaning_task_id, housekeeper_id, is_active from public.hk_assignments where id = $1",
      [LEGACY_ASSIGNMENT],
    );
    const baselineCanonical = await rows<{
      assigned_staff_id: string | null;
      assignment_history: unknown;
    }>(
      "select assigned_staff_id, assignment_history from public.room_work where legacy_task_id = $1",
      [LEGACY_TASK],
    );
    const identityMutations: Array<{ sql: string; params: unknown[] }> = [
      {
        sql: "update public.hk_assignments set property_id = $1 where id = $2",
        params: [OTHER_PROPERTY, LEGACY_ASSIGNMENT],
      },
      {
        sql: "update public.hk_assignments set cleaning_task_id = $1 where id = $2",
        params: [NEW_TASK, LEGACY_ASSIGNMENT],
      },
      {
        sql: "update public.hk_assignments set housekeeper_id = $1 where id = $2",
        params: [SECOND_HOUSEKEEPER, LEGACY_ASSIGNMENT],
      },
    ];
    for (const mutation of identityMutations) {
      const identityError = await failsWith(mutation.sql, mutation.params);
      assert.match(identityError, /IDENTITY_MUTATION/i);
      assert.deepEqual(
        await rows(
          "select id, property_id, cleaning_task_id, housekeeper_id, is_active from public.hk_assignments where id = $1",
          [LEGACY_ASSIGNMENT],
        ),
        baselineAssignment,
      );
      assert.deepEqual(
        await rows(
          "select assigned_staff_id, assignment_history from public.room_work where legacy_task_id = $1",
          [LEGACY_TASK],
        ),
        baselineCanonical,
      );
    }
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

  test('serializes reverse-order canonical batches and resets without partial assignment state', async () => {
    const reverseOrderBatch = JSON.stringify([
      {
        property_id: PROPERTY,
        room_number: '802',
        business_date: LOCK_DATE,
        dedupe_key: '802::2026-08-03',
        cleaning_type: 'stayover',
        priority: 'normal',
        status: 'scheduled',
      },
      {
        property_id: PROPERTY,
        room_number: '801',
        business_date: LOCK_DATE,
        dedupe_key: '801::2026-08-03',
        cleaning_type: 'stayover',
        priority: 'normal',
        status: 'scheduled',
      },
    ]);
    const forwardOrderBatch = JSON.stringify([
      {
        property_id: PROPERTY,
        room_number: '801',
        business_date: LOCK_DATE,
        dedupe_key: '801::2026-08-03',
        cleaning_type: 'stayover',
        priority: 'normal',
        status: 'scheduled',
      },
      {
        property_id: PROPERTY,
        room_number: '802',
        business_date: LOCK_DATE,
        dedupe_key: '802::2026-08-03',
        cleaning_type: 'stayover',
        priority: 'normal',
        status: 'scheduled',
      },
    ]);
    const planRuns = await Promise.all([
      pg.query("select * from public.upsert_room_work_plan($1, $2::jsonb)", [PROPERTY, reverseOrderBatch]),
      pg.query("select * from public.upsert_room_work_plan($1, $2::jsonb)", [PROPERTY, forwardOrderBatch]),
    ]);
    assert.equal(planRuns.length, 2);
    assert.deepEqual(
      await rows<{ room_number: string; plan_status: string }>(
        "select room_number, plan_status from public.room_work where property_id = $1 and date = $2 and room_number in ('801','802') order by room_number",
        [PROPERTY, LOCK_DATE],
      ),
      [
        { room_number: '801', plan_status: 'scheduled' },
        { room_number: '802', plan_status: 'scheduled' },
      ],
    );

    await pg.query(
      "select * from public.assign_room_work_atomic($1, public.housekeeping_plan_id($1, $2, '801'), $3, $4, 'reverse-order test', 1, 1.0, false, 'manual')",
      [PROPERTY, LOCK_DATE, HOUSEKEEPER, OWNER],
    );
    await pg.query(
      "select * from public.assign_room_work_atomic($1, public.housekeeping_plan_id($1, $2, '802'), $3, $4, 'reverse-order test', 2, 1.0, false, 'manual')",
      [PROPERTY, LOCK_DATE, SECOND_HOUSEKEEPER, OWNER],
    );
    const resetRuns = await Promise.all([
      pg.query("select public.reset_room_work_assignments($1, $2, null)", [PROPERTY, LOCK_DATE]),
      pg.query("select public.reset_room_work_assignments($1, $2, null)", [PROPERTY, LOCK_DATE]),
    ]);
    assert.deepEqual(
      resetRuns
        .map((result) => Number((result.rows[0] as Record<string, unknown>).reset_room_work_assignments))
        .sort((a, b) => a - b),
      [0, 2],
    );
    const resetRows = await rows<{
      room_number: string;
      assigned_staff_id: string | null;
      event: string;
      snapshot_id: string | null;
    }>(
      "select room_number, assigned_staff_id, assignment_history->-1->>'event' as event, assignment_history->-1->>'id' as snapshot_id from public.room_work where property_id = $1 and date = $2 and room_number in ('801','802') order by room_number",
      [PROPERTY, LOCK_DATE],
    );
    assert.deepEqual(resetRows.map(({ room_number, assigned_staff_id, event }) => ({ room_number, assigned_staff_id, event })), [
      { room_number: '801', assigned_staff_id: null, event: 'unassigned' },
      { room_number: '802', assigned_staff_id: null, event: 'unassigned' },
    ]);
    for (const row of resetRows) assert.match(row.snapshot_id ?? '', /^[0-9a-f-]{36}$/i);
  });

  test('exposes one sorted lock contract for dormant canonical paths', async () => {
    // PGlite gives this fixture one backend session. Promise.all on this
    // handle would serialize, not exercise PostgreSQL's two-session lock
    // scheduler, so this test makes the production lock contract executable:
    // the shared helper expands parent 900 to child 100 and every mutating
    // path invokes it before changing room_work. The real two-session
    // deadlock proof must run against PostgreSQL, where advisory and row lock
    // waits are independently observable.
    const helper = await rows<{ prosrc: string }>(
      "select p.prosrc from pg_proc p where p.oid = 'public._lock_room_work_component_set(uuid,date,text[])'::regprocedure",
    );
    assert.equal(helper.length, 1);
    assert.match(helper[0].prosrc, /order by lock_keys\.room_number/i);
    assert.match(helper[0].prosrc, /pg_advisory_xact_lock/i);
    assert.match(helper[0].prosrc, /staxis\.housekeeping-plan-batch/i);
    assert.doesNotMatch(helper[0].prosrc, /staxis\.housekeeping-plan:%s:%s:%s/i);
    assert.match(helper[0].prosrc, /for update/i);

    const trigger = await rows<{ definition: string }>(
      "select pg_get_triggerdef(oid) as definition from pg_trigger where tgrelid = 'public.room_work'::regclass and tgname = 'room_work_lock_component_set'",
    );
    assert.deepEqual(trigger, [], 'row-lock trigger must stay absent because PostgreSQL locks before BEFORE triggers');
    const completionTrigger = await rows<{ tgname: string }>(
      "select tgname from pg_trigger where tgrelid = 'public.room_work'::regclass and tgname = 'room_work_complete_components'",
    );
    const auditTrigger = await rows<{ tgname: string }>(
      "select tgname from pg_trigger where tgrelid = 'public.room_work'::regclass and tgname = 'trg_activity_log_room_work_change'",
    );
    assert.deepEqual(completionTrigger, [], 'component completion remains dormant until Stage B');
    assert.deepEqual(auditTrigger, [], 'canonical activity capture remains invisible until Stage B');

    const operationSources = await rows<{ proname: string; prosrc: string }>(
      "select p.proname, p.prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname in ('upsert_room_work_plan', 'assign_room_work_atomic', 'reset_room_work_assignments', '_room_work_complete_components') order by p.proname",
    );
    assert.deepEqual(operationSources.map((row) => row.proname), [
      '_room_work_complete_components',
      'assign_room_work_atomic',
      'reset_room_work_assignments',
      'upsert_room_work_plan',
    ]);
    assert.deepEqual(
      operationSources.filter((source) => source.proname !== '_room_work_complete_components')
        .map((source) => source.proname),
      ['assign_room_work_atomic', 'reset_room_work_assignments', 'upsert_room_work_plan'],
    );
    for (const source of operationSources.filter((row) => row.proname !== '_room_work_complete_components')) {
      assert.match(source.prosrc, /_lock_room_work_component_set/);
    }

    const writerSources = await rows<{ proname: string; prosrc: string }>(
      "select p.proname, p.prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname in ('_legacy_cleaning_task_to_room_work', '_legacy_hk_assignment_to_room_work', 'apply_inspection_cleaning_plan_side_effect', 'complete_inspection_atomic', 'complete_inspection_atomic_canonical', 'touch_room_work_plan', 'write_room_work_atomic') order by p.proname",
    );
    assert.deepEqual(writerSources.map((row) => row.proname), [
      '_legacy_cleaning_task_to_room_work',
      '_legacy_hk_assignment_to_room_work',
      'apply_inspection_cleaning_plan_side_effect',
      'complete_inspection_atomic',
      'complete_inspection_atomic_canonical',
      'touch_room_work_plan',
      'write_room_work_atomic',
    ]);
    for (const source of writerSources.filter((row) => row.proname.startsWith('_legacy_') || row.proname === 'complete_inspection_atomic')) {
      assert.doesNotMatch(source.prosrc, /_lock_room_work_component_set/);
    }
    for (const source of writerSources.filter((row) => !row.proname.startsWith('_legacy_') && row.proname !== 'complete_inspection_atomic')) {
      assert.match(source.prosrc, /_lock_room_work_component_set/);
    }

    await pg.query(
      "select public._lock_room_work_component_set($1, $2, array['900']::text[])",
      [PROPERTY, LOCK_DATE],
    );
    await pg.query(
      "select * from public.upsert_room_work_plan($1, $2::jsonb)",
      [PROPERTY, JSON.stringify([
        {
          property_id: PROPERTY,
          room_number: '900',
          business_date: LOCK_DATE,
          dedupe_key: '900::2026-08-03',
          cleaning_type: 'stayover',
          priority: 'normal',
          status: 'scheduled',
        },
        {
          property_id: PROPERTY,
          room_number: '100',
          business_date: LOCK_DATE,
          dedupe_key: '100::2026-08-03',
          cleaning_type: 'stayover',
          priority: 'normal',
          status: 'scheduled',
        },
      ])],
    );
    assert.deepEqual(
      await rows<{ room_number: string; plan_status: string }>(
        "select room_number, plan_status from public.room_work where property_id = $1 and date = $2 and room_number in ('100', '900') order by room_number",
        [PROPERTY, LOCK_DATE],
      ),
      [
        { room_number: '100', plan_status: 'scheduled' },
        { room_number: '900', plan_status: 'scheduled' },
      ],
    );

    // This exercises the dormant canonical writer seam. PGlite uses one
    // backend session, so it proves the complete component set and rollback
    // behavior below, not PostgreSQL's independent two-session scheduler.
    await pg.query(
      "select public.write_room_work_atomic($1, $2, '900', '{\"status\":\"completed\",\"completed_at\":\"2026-08-03T12:00:00Z\",\"is_paused\":false}'::jsonb)",
      [PROPERTY, LOCK_DATE],
    );
    const atomicCompletionUpdatedAt = await scalar<string>(
      "select updated_at::text from public.room_work where property_id = $1 and date = $2 and room_number = '900'",
      [PROPERTY, LOCK_DATE],
    );
    await pg.query(
      "select public.write_room_work_atomic($1, $2, '900', '{\"status\":\"completed\",\"completed_at\":\"2026-08-03T12:00:00Z\",\"is_paused\":false}'::jsonb)",
      [PROPERTY, LOCK_DATE],
    );
    assert.equal(
      await scalar<string>(
        "select updated_at::text from public.room_work where property_id = $1 and date = $2 and room_number = '900'",
        [PROPERTY, LOCK_DATE],
      ),
      atomicCompletionUpdatedAt,
      'an exact backend writer retry must not churn updated_at',
    );
    assert.deepEqual(
      await rows<{ room_number: string; status: string }>(
        "select room_number, status from public.room_work where property_id = $1 and date = $2 and room_number in ('100', '900') order by room_number",
        [PROPERTY, LOCK_DATE],
      ),
      [
        { room_number: '100', status: 'completed' },
        { room_number: '900', status: 'completed' },
      ],
    );

    await pg.query(
      "insert into public.cleaning_tasks(id, property_id, room_number, business_date, dedupe_key, cleaning_type, priority, estimated_minutes, requires_inspection, extras, rules_fired, status, source_property_timezone, scheduled_at, last_evaluated_at) values ($1, $2, '900', $3, '900::bridge::2026-08-03', 'stayover', 'normal', 20, false, '[]'::jsonb, '[]'::jsonb, 'scheduled', 'America/Chicago', $4::timestamptz, $4::timestamptz)",
      [LOCK_BRIDGE_TASK, PROPERTY, LOCK_DATE, '2026-08-03T12:00:00Z'],
    );
    await pg.query(
      "insert into public.hk_assignments(id, property_id, cleaning_task_id, housekeeper_id, queue_order, is_active, assigned_at, assigned_by, reason, score) values ($1, $2, $3, $4, 1, true, $5::timestamptz, 'auto', 'lock bridge', 1.0)",
      [LOCK_BRIDGE_ASSIGNMENT, PROPERTY, LOCK_BRIDGE_TASK, HOUSEKEEPER, '2026-08-03T12:01:00Z'],
    );
    assert.deepEqual(
      await rows<{ room_number: string; assigned_staff_id: string | null }>(
        "select room_number, assigned_staff_id from public.room_work where property_id = $1 and date = $2 and room_number in ('100', '900') order by room_number",
        [PROPERTY, LOCK_DATE],
      ),
      [
        { room_number: '100', assigned_staff_id: null },
        { room_number: '900', assigned_staff_id: HOUSEKEEPER },
      ],
      'old legacy bridges retain single-row compatibility while canonical locks remain dormant',
    );
  });

  test('keeps old direct completion single-room while the canonical component RPC remains dormant', async () => {
    await pg.query(
      "insert into public.room_work(property_id, date, room_number, status) values ($1, $2, '101', 'not_started'), ($1, $2, '102', 'not_started'), ($1, $2, '103', 'not_started'), ($1, $2, '104', 'not_started') on conflict (property_id, date, room_number) do update set status = 'not_started', completed_at = null, is_paused = false",
      [PROPERTY, BUSINESS_DATE],
    );
    assert.deepEqual(
      await rows<{ tgname: string }>(
        "select tgname from pg_trigger where tgrelid = 'public.room_work'::regclass and tgname = 'room_work_complete_components'",
      ),
      [],
      'Stage A must not install the component fanout trigger',
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
      { room_number: '102', status: 'not_started' },
      { room_number: '103', status: 'not_started' },
      { room_number: '104', status: 'not_started' },
    ]);

    await pg.query(
      "update public.room_work set status = 'not_started', completed_at = null, is_paused = false where property_id = $1 and date = $2 and room_number in ('101','102','103')",
      [PROPERTY, BUSINESS_DATE],
    );
    await pg.exec("create or replace function public.phase5_fail_component() returns trigger language plpgsql as $$ begin raise exception 'phase5 child failure'; end; $$");
    await pg.exec("create trigger phase5_fail_component before update of status on public.room_work for each row when (new.room_number = '103') execute function public.phase5_fail_component()");
    const failure = await failsWith(
      "select public.write_room_work_atomic($1, $2, '101', '{\"status\":\"completed\"}'::jsonb)",
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
      "select public.write_room_work_atomic($1, $2, '101', '{\"status\":\"completed\"}'::jsonb)",
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
    const inspectionSources = await rows<{ proname: string; prosrc: string }>(
      "select p.proname, p.prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname in ('complete_inspection_atomic', 'complete_inspection_atomic_canonical') order by p.proname",
    );
    assert.deepEqual(inspectionSources.map((row) => row.proname), [
      'complete_inspection_atomic',
      'complete_inspection_atomic_canonical',
    ]);
    for (const source of inspectionSources) {
      assert.match(source.prosrc, /order by id\s+limit 1\s+for update/i);
    }
    const legacyInspectionSource = inspectionSources.find((row) => row.proname === 'complete_inspection_atomic');
    assert.ok(legacyInspectionSource);
    // The repository has no real-Postgres two-session test harness. These
    // source/behavior assertions prove the bounded order contract without
    // pretending one PGlite backend proves PostgreSQL deadlock scheduling.
    assert.ok(
      legacyInspectionSource.prosrc.indexOf('2) cleaning_tasks side-effect')
        < legacyInspectionSource.prosrc.indexOf('3) Work side-effect'),
      'the preserved inspection RPC must update cleaning_tasks before room_work',
    );
    const reassignSource = await scalar<string>(
      "select p.prosrc from pg_proc p where p.oid = 'public.reassign_cleaning_task(uuid,uuid,uuid,uuid,text)'::regprocedure",
    );
    assert.match(
      reassignSource,
      /from public\.cleaning_tasks[\s\S]*insert into public\.hk_assignments[\s\S]*update public\.cleaning_tasks/i,
      'reassignment must keep its cleaning_tasks -> hk_assignments -> room_work bridge order',
    );

    const sideEffectTask = await scalar<string>(
      "select public.housekeeping_plan_id($1, $2, '204')::text",
      [PROPERTY, BUSINESS_DATE],
    );
    await pg.query(
      "select * from public.upsert_room_work_plan($1, $2::jsonb)",
      [PROPERTY, JSON.stringify([{
        property_id: PROPERTY,
        room_number: '204',
        business_date: BUSINESS_DATE,
        dedupe_key: '204::2026-08-02',
        cleaning_type: 'stayover',
        priority: 'normal',
        status: 'scheduled',
      }])],
    );
    await pg.query(
      "select public.apply_inspection_cleaning_plan_side_effect($1, $2, 'pass', null)",
      [PROPERTY, sideEffectTask],
    );
    assert.deepEqual(
      await rows<{ room_number: string; plan_status: string }>(
        "select room_number, plan_status from public.room_work where property_id = $1 and date = $2 and room_number = '204'",
        [PROPERTY, BUSINESS_DATE],
      ),
      [{ room_number: '204', plan_status: 'inspected_pass' }],
    );

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
    assert.deepEqual(
      await rows<{ event_type: string }>(
        "select event_type from public.activity_log where property_id = $1 and target_id = $2 and event_type in ('cleaning_task_inspected_pass', 'cleaning_task_scheduled', 'cleaning_task_completed') order by event_type",
        [PROPERTY, NEW_TASK],
      ),
      [{ event_type: 'cleaning_task_inspected_pass' }],
      'the preserved old pass RPC must not add a duplicate canonical parent event',
    );
    const retry = await failsWith(
      "select * from public.complete_inspection_atomic($1, $2, 'pass', '[]'::jsonb, '[]'::jsonb, null, false, null, null, null)",
      [PASS_INSPECTION, PROPERTY],
    );
    assert.match(retry, /already/i);

    await pg.query(
      "insert into public.cleaning_tasks(id, property_id, room_number, business_date, dedupe_key, cleaning_type, priority, estimated_minutes, requires_inspection, extras, rules_fired, status, source_property_timezone, scheduled_at, last_evaluated_at) values ($1, $2, '203', $3, '203::2026-08-02', 'stayover', 'normal', 20, false, '[]'::jsonb, '[]'::jsonb, 'scheduled', 'America/Chicago', $4::timestamptz, $4::timestamptz)",
      [LEGACY_FAIL_TASK, PROPERTY, BUSINESS_DATE, '2026-08-02T13:15:00Z'],
    );
    await pg.query(
      "insert into public.inspections(id, property_id, room_number, cleaning_task_id, result, started_at) values ($1, $2, '203', $3, 'in_progress', $4::timestamptz)",
      [LEGACY_FAIL_INSPECTION, PROPERTY, LEGACY_FAIL_TASK, '2026-08-02T13:30:00Z'],
    );
    await pg.query(
      "select * from public.complete_inspection_atomic($1, $2, 'fail', '[{\"item_id\":\"mirror\"}]'::jsonb, '[]'::jsonb, null, false, null, null, 'mirror streaks')",
      [LEGACY_FAIL_INSPECTION, PROPERTY],
    );
    assert.deepEqual(
      await rows<{ status: string; plan_status: string; plan_priority: string; plan_notes: string }>(
        "select t.status, w.plan_status, w.plan_priority, w.plan_notes from public.cleaning_tasks t join public.room_work w on w.legacy_task_id = t.id where t.id = $1",
        [LEGACY_FAIL_TASK],
      ),
      [{ status: 'correction_pending', plan_status: 'correction_pending', plan_priority: 'high', plan_notes: 'mirror streaks' }],
    );
    assert.deepEqual(
      await rows<{ event_type: string }>(
        "select event_type from public.activity_log where property_id = $1 and target_id = $2 and event_type in ('cleaning_task_correction_pending', 'cleaning_task_scheduled', 'cleaning_task_completed') order by event_type",
        [PROPERTY, LEGACY_FAIL_TASK],
      ),
      [{ event_type: 'cleaning_task_correction_pending' }],
      'the preserved old fail RPC must retain one correction event without a spurious parent status event',
    );

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

    const pmsOnlyTask = await scalar<string>(
      "select public.housekeeping_plan_id($1, $2, '701')::text",
      [PROPERTY, BUSINESS_DATE],
    );
    await pg.query(
      "insert into public.inspections(id, property_id, room_number, cleaning_task_id, result, started_at) values ($1, $2, '702', $3, 'in_progress', $4::timestamptz)",
      [DIFFERENT_ROOM_INSPECTION, PROPERTY, pmsOnlyTask, '2026-08-02T14:30:00Z'],
    );
    await pg.query(
      "select * from public.complete_inspection_atomic_canonical($1, $2, 'pass', '[]'::jsonb, '[]'::jsonb, null, false, null, null, null)",
      [DIFFERENT_ROOM_INSPECTION, PROPERTY],
    );
    assert.deepEqual(
      await rows<{ room_number: string; status: string; plan_status: string | null }>(
        "select room_number, status, plan_status from public.room_work where property_id = $1 and date = $2 and room_number in ('701', '702') order by room_number",
        [PROPERTY, BUSINESS_DATE],
      ),
      [
        { room_number: '701', status: 'not_started', plan_status: 'inspected_pass' },
        { room_number: '702', status: 'completed', plan_status: null },
      ],
      'canonical inspection must lock and update the task room even when it differs from the inspection room',
    );

    await pg.query(
      "insert into public.inspections(id, property_id, room_number, cleaning_task_id, result, started_at) values ($1, $2, '703', null, 'in_progress', $3::timestamptz)",
      [ROOM_ONLY_INSPECTION, PROPERTY, '2026-08-02T15:00:00Z'],
    );
    await pg.query(
      "select * from public.complete_inspection_atomic_canonical($1, $2, 'pass', '[]'::jsonb, '[]'::jsonb, null, false, null, null, null)",
      [ROOM_ONLY_INSPECTION, PROPERTY],
    );
    assert.equal(
      await scalar<string>(
        "select status from public.room_work where property_id = $1 and date = $2 and room_number = '703'",
        [PROPERTY, BUSINESS_DATE],
      ),
      'completed',
      'canonical inspection without a task mapping must retain its room-only behavior',
    );

    await pg.query(
      "update public.room_work set status = 'not_started', completed_at = null, inspected_at = null where property_id = $1 and date = $2 and room_number in ('101', '102', '103')",
      [PROPERTY, BUSINESS_DATE],
    );
    await pg.query(
      "insert into public.inspections(id, property_id, room_number, cleaning_task_id, result, started_at) values ('a6000000-0000-4000-8000-000000000007', $1, '101', $2, 'in_progress', $3::timestamptz)",
      [PROPERTY, LEGACY_TASK, '2026-08-02T15:30:00Z'],
    );
    await pg.query(
      "select * from public.complete_inspection_atomic('a6000000-0000-4000-8000-000000000007', $1, 'pass', '[]'::jsonb, '[]'::jsonb, null, false, null, null, null)",
      [PROPERTY],
    );
    assert.deepEqual(
      await rows<{ room_number: string; status: string }>(
        "select room_number, status from public.room_work where property_id = $1 and date = $2 and room_number in ('101', '102', '103') order by room_number",
        [PROPERTY, BUSINESS_DATE],
      ),
      [
        { room_number: '101', status: 'completed' },
        { room_number: '102', status: 'not_started' },
        { room_number: '103', status: 'not_started' },
      ],
      'the old inspection RPC must not fan out to component children during expand',
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

  test('0434 preserves superseded plan semantics during backfill', async () => {
    const reconciled = await applyMigrationsToPgliteWithHook(async ({ pg: db, file }) => {
      if (file !== '0434_housekeeping_plan_reconciliation.sql') return;
      await db.query(
        "insert into auth.users(id, email) values ($1, 'phase5-superseded@example.test') on conflict (id) do nothing",
        [OWNER],
      );
      await db.query(
        "insert into public.properties(id, owner_id, name, total_rooms, timezone) values ($1, $2, 'Phase Five Inn', 60, 'America/Chicago') on conflict (id) do nothing",
        [PROPERTY, OWNER],
      );
      await db.query(
        "insert into public.cleaning_tasks(id, property_id, room_number, business_date, dedupe_key, cleaning_type, priority, estimated_minutes, requires_inspection, extras, rules_fired, status, source_engine_run_id, source_property_timezone, scheduled_at, last_evaluated_at) values ($1, $2, '711', $3, '711::2026-08-02', 'stayover', 'normal', 20, false, '[]'::jsonb, '[]'::jsonb, 'superseded', $4, 'America/Chicago', $5::timestamptz, $5::timestamptz)",
        [NEW_TASK, PROPERTY, BUSINESS_DATE, 'b4000000-0000-4000-8000-000000000021', '2026-08-02T12:00:00Z'],
      );
    });

    try {
      assert.ok(reconciled.report.applied.includes('0434_housekeeping_plan_reconciliation.sql'));
      assert.deepEqual(
        (await reconciled.pg.query<{ status: string; plan_status: string }>(
          "select status, plan_status from public.room_work where property_id = $1 and date = $2 and room_number = '711'",
          [PROPERTY, BUSINESS_DATE],
        )).rows,
        [{ status: 'skipped', plan_status: 'superseded' }],
      );
    } finally {
      await reconciled.pg.close();
    }
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

  test('0434 refuses duplicate legacy natural keys without dropping either task', async () => {
    const duplicate = await applyMigrationsToPgliteWithHook(async ({ pg: db, file }) => {
      if (file !== '0434_housekeeping_plan_reconciliation.sql') return;

      await db.query(
        "insert into auth.users(id, email) values ($1, 'phase5-duplicate@example.test') on conflict (id) do nothing",
        [OWNER],
      );
      await db.query(
        "insert into public.properties(id, owner_id, name, total_rooms, timezone) values ($1, $2, 'Phase Five Inn', 60, 'America/Chicago') on conflict (id) do nothing",
        [PROPERTY, OWNER],
      );
      await db.query(
        "insert into public.cleaning_tasks(id, property_id, room_number, business_date, dedupe_key, cleaning_type, priority, estimated_minutes, requires_inspection, extras, notes, rules_fired, rule_inputs, status, source_engine_run_id, source_property_timezone, scheduled_at, last_evaluated_at) values ($1, $3, '501', $4, '501::departure::2026-08-02', 'departure', 'normal', 30, false, '[]'::jsonb, 'first duplicate', '[]'::jsonb, '{}'::jsonb, 'scheduled', $5, 'America/Chicago', $6::timestamptz, $6::timestamptz), ($2, $3, '501', $4, '501::stayover::2026-08-02', 'stayover', 'low', 20, false, '[]'::jsonb, 'second duplicate', '[]'::jsonb, '{}'::jsonb, 'scheduled', $5, 'America/Chicago', $6::timestamptz, $6::timestamptz)",
        [DUPLICATE_TASK_ONE, DUPLICATE_TASK_TWO, PROPERTY, BUSINESS_DATE, 'b4000000-0000-4000-8000-000000000005', '2026-08-02T12:00:00Z'],
      );
    });

    try {
      const failure = duplicate.report.failedAtRuntime.find(
        (entry) => entry.file === '0434_housekeeping_plan_reconciliation.sql',
      );
      assert.ok(failure, JSON.stringify(duplicate.report.failedAtRuntime.filter((entry) => entry.file.startsWith('043'))));
      assert.match(failure.error, /natural-key group/i);
      assert.equal(
        duplicate.report.applied.includes('0434_housekeeping_plan_reconciliation.sql'),
        false,
      );
      await duplicate.pg.exec('rollback;').catch(() => undefined);
      const legacyTasks = await duplicate.pg.query<{ id: string; dedupe_key: string }>(
        "select id, dedupe_key from public.cleaning_tasks where property_id = $1 and business_date = $2 and room_number = '501' order by id",
        [PROPERTY, BUSINESS_DATE],
      );
      assert.deepEqual(legacyTasks.rows, [
        { id: DUPLICATE_TASK_ONE, dedupe_key: '501::departure::2026-08-02' },
        { id: DUPLICATE_TASK_TWO, dedupe_key: '501::stayover::2026-08-02' },
      ]);
    } finally {
      await duplicate.pg.close();
    }
  });

  test('0434 rejects history task natural-key and legacy-link mismatches before reconciliation', async () => {
    const invalid = await applyMigrationsToPgliteWithHook(async ({ pg: db, file }) => {
      if (file !== '0434_housekeeping_plan_reconciliation.sql') return;

      await seedHistoryProperty(db, 'phase5-history-task-identity@example.test');
      await db.query(
        "insert into public.cleaning_tasks(id, property_id, room_number, business_date, dedupe_key, cleaning_type, priority, estimated_minutes, requires_inspection, extras, rules_fired, status, source_property_timezone, scheduled_at, last_evaluated_at) values ($1, $3, '612', $4, '612::2026-08-02', 'stayover', 'normal', 20, false, '[]'::jsonb, '[]'::jsonb, 'scheduled', 'America/Chicago', $5::timestamptz, $5::timestamptz), ($2, $3, '615', $4, '615::2026-08-02', 'stayover', 'normal', 20, false, '[]'::jsonb, '[]'::jsonb, 'scheduled', 'America/Chicago', $5::timestamptz, $5::timestamptz)",
        [HISTORY_WRONG_ROOM_TASK, HISTORY_LINKED_TASK, PROPERTY, BUSINESS_DATE, '2026-08-02T12:00:00Z'],
      );
      await db.query("alter table public.room_work add column if not exists assignment_history jsonb");
      await db.query("alter table public.room_work add column if not exists legacy_task_id uuid");
      await db.query(
        "insert into public.room_work(property_id, date, room_number, legacy_task_id, status, assigned_staff_id, assigned_source, assignment_history) values ($1, $2, '613', null, 'not_started', null, null, jsonb_build_array(jsonb_build_object('id', $3::uuid, 'property_id', $1::uuid, 'cleaning_task_id', $4::uuid, 'housekeeper_id', $5::uuid, 'queue_order', 1, 'is_active', true, 'assigned_at', $6::timestamptz, 'assigned_by', 'auto', 'assigned_by_user_id', null, 'reason', 'wrong room', 'score', 1.0, 'created_at', $6::timestamptz, 'updated_at', $6::timestamptz))), ($1, $2, '615', $7::uuid, 'not_started', null, null, jsonb_build_array(jsonb_build_object('id', $8::uuid, 'property_id', $1::uuid, 'cleaning_task_id', $4::uuid, 'housekeeper_id', $5::uuid, 'queue_order', 2, 'is_active', true, 'assigned_at', $6::timestamptz, 'assigned_by', 'auto', 'assigned_by_user_id', null, 'reason', 'wrong linked task', 'score', 2.0, 'created_at', $6::timestamptz, 'updated_at', $6::timestamptz)))",
        [PROPERTY, BUSINESS_DATE, HISTORY_LIFECYCLE_ASSIGNMENT_ONE, HISTORY_WRONG_ROOM_TASK, HOUSEKEEPER, '2026-07-31T12:01:00Z', HISTORY_LINKED_TASK, HISTORY_LIFECYCLE_ASSIGNMENT_TWO],
      );
    });

    try {
      const failure = invalid.report.failedAtRuntime.find(
        (entry) => entry.file === '0434_housekeeping_plan_reconciliation.sql',
      );
      assert.ok(failure, JSON.stringify(invalid.report.failedAtRuntime.filter((entry) => entry.file.startsWith('043'))));
      assert.match(failure.error, /assignment history/i);
      assert.equal(invalid.report.applied.includes('0434_housekeeping_plan_reconciliation.sql'), false);
      await invalid.pg.exec('rollback;').catch(() => undefined);
      assert.deepEqual(
        (await invalid.pg.query<{ room_number: string; legacy_task_id: string | null; history_task_id: string }>(
          "select room_number, legacy_task_id, assignment_history->0->>'cleaning_task_id' as history_task_id from public.room_work where property_id = $1 and date = $2 and room_number in ('613', '615') order by room_number",
          [PROPERTY, BUSINESS_DATE],
        )).rows,
        [
          { room_number: '613', legacy_task_id: null, history_task_id: HISTORY_WRONG_ROOM_TASK },
          { room_number: '615', legacy_task_id: HISTORY_LINKED_TASK, history_task_id: HISTORY_WRONG_ROOM_TASK },
        ],
      );
    } finally {
      await invalid.pg.close();
    }
  });

  test('0434 rejects a latest active history receipt with a missing assignment id', async () => {
    const invalid = await applyMigrationsToPgliteWithHook(async ({ pg: db, file }) => {
      if (file !== '0434_housekeeping_plan_reconciliation.sql') return;

      await seedHistoryProperty(db, 'phase5-history-missing-id@example.test');
      await db.query(
        "insert into public.cleaning_tasks(id, property_id, room_number, business_date, dedupe_key, cleaning_type, priority, estimated_minutes, requires_inspection, extras, rules_fired, status, source_property_timezone, scheduled_at, last_evaluated_at) values ($1, $2, '616', $3, '616::2026-08-02', 'stayover', 'normal', 20, false, '[]'::jsonb, '[]'::jsonb, 'scheduled', 'America/Chicago', $4::timestamptz, $4::timestamptz)",
        [HISTORY_MISSING_ID_TASK, PROPERTY, BUSINESS_DATE, '2026-08-02T12:00:00Z'],
      );
      await db.query(
        "insert into public.cleaning_tasks(id, property_id, room_number, business_date, dedupe_key, cleaning_type, priority, estimated_minutes, requires_inspection, extras, rules_fired, status, source_property_timezone, scheduled_at, last_evaluated_at) values ($1, $2, '617', $3, '617::2026-08-02', 'stayover', 'normal', 20, false, '[]'::jsonb, '[]'::jsonb, 'scheduled', 'America/Chicago', $4::timestamptz, $4::timestamptz)",
        [HISTORY_WRONG_ROOM_TASK, PROPERTY, BUSINESS_DATE, '2026-08-02T12:00:00Z'],
      );
      await db.query("alter table public.room_work add column if not exists assignment_history jsonb");
      await db.query(
        "insert into public.room_work(property_id, date, room_number, status, assigned_staff_id, assigned_source, assignment_history) values ($1, $2, '616', 'not_started', null, null, jsonb_build_array(jsonb_build_object('property_id', $1::uuid, 'cleaning_task_id', $3::uuid, 'housekeeper_id', $4::uuid, 'queue_order', 1, 'is_active', true, 'assigned_at', $5::timestamptz, 'assigned_by', 'auto', 'assigned_by_user_id', null, 'reason', 'missing id', 'score', 1.0, 'created_at', $5::timestamptz, 'updated_at', $5::timestamptz)))",
        [PROPERTY, BUSINESS_DATE, HISTORY_MISSING_ID_TASK, HOUSEKEEPER, '2026-07-31T12:01:00Z'],
      );
      await db.query(
        "insert into public.room_work(property_id, date, room_number, status, assigned_staff_id, assigned_source, assignment_history) values ($1, $2, '617', 'not_started', null, null, jsonb_build_array(jsonb_build_object('id', 'not-a-uuid', 'property_id', $1::uuid, 'cleaning_task_id', $3::uuid, 'housekeeper_id', $4::uuid, 'queue_order', 1, 'is_active', true, 'assigned_at', $5::timestamptz, 'assigned_by', 'auto', 'assigned_by_user_id', null, 'reason', 'invalid id', 'score', 1.0, 'created_at', $5::timestamptz, 'updated_at', $5::timestamptz)))",
        [PROPERTY, BUSINESS_DATE, HISTORY_WRONG_ROOM_TASK, HOUSEKEEPER, '2026-07-31T12:01:00Z'],
      );
    });

    try {
      const failure = invalid.report.failedAtRuntime.find(
        (entry) => entry.file === '0434_housekeeping_plan_reconciliation.sql',
      );
      assert.ok(failure, JSON.stringify(invalid.report.failedAtRuntime.filter((entry) => entry.file.startsWith('043'))));
      assert.match(failure.error, /active room_work assignment history/i);
      assert.equal(invalid.report.applied.includes('0434_housekeeping_plan_reconciliation.sql'), false);
      await invalid.pg.exec('rollback;').catch(() => undefined);
      assert.deepEqual(
        (await invalid.pg.query<{ room_number: string; assigned_staff_id: string | null; history_id: string | null }>(
          "select room_number, assigned_staff_id, assignment_history->0->>'id' as history_id from public.room_work where property_id = $1 and date = $2 and room_number in ('616', '617') order by room_number",
          [PROPERTY, BUSINESS_DATE],
        )).rows,
        [
          { room_number: '616', assigned_staff_id: null, history_id: null },
          { room_number: '617', assigned_staff_id: null, history_id: 'not-a-uuid' },
        ],
      );
    } finally {
      await invalid.pg.close();
    }
  });

  test('0434 normalizes latest history lifecycle state before restoring current assignment', async () => {
    const reconciled = await applyMigrationsToPgliteWithHook(async ({ pg: db, file }) => {
      if (file !== '0434_housekeeping_plan_reconciliation.sql') return;

      await seedHistoryProperty(db, 'phase5-history-lifecycle@example.test');
      await db.query(
        "insert into public.cleaning_tasks(id, property_id, room_number, business_date, dedupe_key, cleaning_type, priority, estimated_minutes, requires_inspection, extras, rules_fired, status, source_property_timezone, scheduled_at, last_evaluated_at) values ($1, $4, '620', $5, '620::2026-08-02', 'stayover', 'normal', 20, false, '[]'::jsonb, '[]'::jsonb, 'scheduled', 'America/Chicago', $6::timestamptz, $6::timestamptz), ($2, $4, '621', $5, '621::2026-08-02', 'stayover', 'normal', 20, false, '[]'::jsonb, '[]'::jsonb, 'scheduled', 'America/Chicago', $6::timestamptz, $6::timestamptz), ($3, $4, '622', $5, '622::2026-08-02', 'stayover', 'normal', 20, false, '[]'::jsonb, '[]'::jsonb, 'scheduled', 'America/Chicago', $6::timestamptz, $6::timestamptz)",
        [HISTORY_LIFECYCLE_TASK_ONE, HISTORY_LIFECYCLE_TASK_TWO, HISTORY_LIFECYCLE_TASK_THREE, PROPERTY, BUSINESS_DATE, '2026-08-02T12:00:00Z'],
      );
      await db.query("alter table public.room_work add column if not exists assignment_history jsonb");
      await db.query(
        "insert into public.room_work(property_id, date, room_number, status, assigned_staff_id, assigned_source, assignment_history) values ($1, $2, '620', 'not_started', null, null, jsonb_build_array(jsonb_build_object('id', $3::uuid, 'property_id', $1::uuid, 'cleaning_task_id', $4::uuid, 'housekeeper_id', $5::uuid, 'queue_order', 1, 'is_active', true, 'assigned_at', $6::timestamptz, 'assigned_by', 'auto', 'assigned_by_user_id', null, 'reason', 'first active', 'score', 1.0, 'created_at', $6::timestamptz, 'updated_at', $6::timestamptz), jsonb_build_object('id', $3::uuid, 'property_id', $1::uuid, 'cleaning_task_id', $4::uuid, 'housekeeper_id', $5::uuid, 'queue_order', 1, 'is_active', false, 'assigned_at', $6::timestamptz, 'assigned_by', 'auto', 'assigned_by_user_id', null, 'reason', 'later inactive', 'score', 1.0, 'created_at', $6::timestamptz, 'updated_at', $7::timestamptz, 'event', 'deactivated'))), ($1, $2, '621', 'not_started', null, null, jsonb_build_array(jsonb_build_object('id', $8::uuid, 'property_id', $1::uuid, 'cleaning_task_id', $9::uuid, 'housekeeper_id', $5::uuid, 'queue_order', 2, 'is_active', true, 'assigned_at', $6::timestamptz, 'assigned_by', 'auto', 'assigned_by_user_id', null, 'reason', 'older one', 'score', 2.0, 'created_at', $6::timestamptz, 'updated_at', $6::timestamptz), jsonb_build_object('id', $10::uuid, 'property_id', $1::uuid, 'cleaning_task_id', $9::uuid, 'housekeeper_id', $5::uuid, 'queue_order', 3, 'is_active', true, 'assigned_at', $6::timestamptz, 'assigned_by', 'auto', 'assigned_by_user_id', null, 'reason', 'older two', 'score', 3.0, 'created_at', $6::timestamptz, 'updated_at', $6::timestamptz), jsonb_build_object('id', $8::uuid, 'property_id', $1::uuid, 'cleaning_task_id', $9::uuid, 'housekeeper_id', $5::uuid, 'queue_order', 2, 'is_active', false, 'assigned_at', $6::timestamptz, 'assigned_by', 'auto', 'assigned_by_user_id', null, 'reason', 'first inactive', 'score', 2.0, 'created_at', $6::timestamptz, 'updated_at', $7::timestamptz, 'event', 'deactivated'), jsonb_build_object('id', $10::uuid, 'property_id', $1::uuid, 'cleaning_task_id', $9::uuid, 'housekeeper_id', $5::uuid, 'queue_order', 3, 'is_active', false, 'assigned_at', $6::timestamptz, 'assigned_by', 'auto', 'assigned_by_user_id', null, 'reason', 'second inactive', 'score', 3.0, 'created_at', $6::timestamptz, 'updated_at', $7::timestamptz, 'event', 'deactivated'))), ($1, $2, '622', 'not_started', null, null, jsonb_build_array(jsonb_build_object('id', $11::uuid, 'property_id', $1::uuid, 'cleaning_task_id', $12::uuid, 'housekeeper_id', $5::uuid, 'queue_order', 7, 'is_active', true, 'assigned_at', $13::timestamptz, 'assigned_by', 'pms_import', 'assigned_source', 'pms_import', 'assigned_by_user_id', null, 'reason', 'PMS named staff', 'score', 7.2, 'created_at', $13::timestamptz, 'updated_at', $13::timestamptz, 'event', 'preexisting')))",
        [PROPERTY, BUSINESS_DATE, HISTORY_LIFECYCLE_ASSIGNMENT_ONE, HISTORY_LIFECYCLE_TASK_ONE, HOUSEKEEPER, '2026-07-31T12:01:00Z', '2026-07-31T12:02:00Z', HISTORY_LIFECYCLE_ASSIGNMENT_TWO, HISTORY_LIFECYCLE_TASK_TWO, HISTORY_LIFECYCLE_ASSIGNMENT_THREE, HISTORY_LIFECYCLE_ASSIGNMENT_FOUR, HISTORY_LIFECYCLE_TASK_THREE, '2026-07-31T12:03:00Z'],
      );
    });

    try {
      assert.ok(
        reconciled.report.applied.includes('0434_housekeeping_plan_reconciliation.sql'),
        JSON.stringify(reconciled.report.failedAtRuntime.filter((entry) => entry.file.startsWith('043'))),
      );
      assert.ok(
        reconciled.report.applied.includes('0435_housekeeping_canonical_operations.sql'),
        JSON.stringify(reconciled.report.failedAtRuntime.filter((entry) => entry.file.startsWith('043'))),
      );
      assert.deepEqual(
        (await reconciled.pg.query<{
          room_number: string;
          assigned_staff_id: string | null;
          assigned_source: string | null;
          queue_order: number;
          assigned_by: string | null;
          reason: string | null;
          score: string | null;
          history_count: number;
          last_id: string | null;
          last_active: boolean | null;
        }>(
          "select room_number, assigned_staff_id, assigned_source, assignment_queue_order as queue_order, assignment_assigned_by as assigned_by, assignment_reason as reason, assignment_score::text as score, jsonb_array_length(assignment_history)::int as history_count, assignment_history->-1->>'id' as last_id, (assignment_history->-1->>'is_active')::boolean as last_active from public.room_work where property_id = $1 and date = $2 and room_number in ('620', '621', '622') order by room_number",
          [PROPERTY, BUSINESS_DATE],
        )).rows,
        [
          { room_number: '620', assigned_staff_id: null, assigned_source: null, queue_order: 0, assigned_by: null, reason: null, score: null, history_count: 2, last_id: HISTORY_LIFECYCLE_ASSIGNMENT_ONE, last_active: false },
          { room_number: '621', assigned_staff_id: null, assigned_source: null, queue_order: 0, assigned_by: null, reason: null, score: null, history_count: 4, last_id: HISTORY_LIFECYCLE_ASSIGNMENT_THREE, last_active: false },
          { room_number: '622', assigned_staff_id: HOUSEKEEPER, assigned_source: 'pms_import', queue_order: 7, assigned_by: null, reason: 'PMS named staff', score: '7.2', history_count: 1, last_id: HISTORY_LIFECYCLE_ASSIGNMENT_FOUR, last_active: true },
        ],
      );
    } finally {
      await reconciled.pg.close();
    }
  });

  test('0434 appends a full current receipt for stale active history and preserves source semantics', async () => {
    const reconciled = await applyMigrationsToPgliteWithHook(async ({ pg: db, file }) => {
      if (file !== '0434_housekeeping_plan_reconciliation.sql') return;

      await seedHistoryProperty(db, 'phase5-history-stale@example.test');
      await db.query(
        "insert into public.cleaning_tasks(id, property_id, room_number, business_date, dedupe_key, cleaning_type, priority, estimated_minutes, requires_inspection, extras, rules_fired, status, assignee_id, source_property_timezone, scheduled_at, last_evaluated_at) values ($1, $2, '624', $3, '624::2026-08-02', 'stayover', 'normal', 20, false, '[]'::jsonb, '[]'::jsonb, 'scheduled', $4, 'America/Chicago', $5::timestamptz, $5::timestamptz)",
        [HISTORY_STALE_TASK, PROPERTY, BUSINESS_DATE, HOUSEKEEPER, '2026-08-02T12:00:00Z'],
      );
      await db.query("alter table public.room_work add column if not exists assignment_history jsonb");
      await db.query("alter table public.room_work add column if not exists id uuid");
      await db.query(
        "insert into public.room_work(id, property_id, date, room_number, status, assigned_staff_id, assigned_source, assignment_history) values (md5($1::text || ':' || $2::text || ':625')::uuid, $1::uuid, $2::date, '625', 'not_started', $3::uuid, 'alias_first_name', jsonb_build_array(jsonb_build_object('id', $4::uuid, 'property_id', $1::uuid, 'cleaning_task_id', md5($1::text || ':' || $2::text || ':625')::uuid, 'housekeeper_id', $3::uuid, 'queue_order', 5, 'is_active', true, 'assigned_at', $5::timestamptz, 'assigned_by', 'room_work', 'assigned_source', 'alias_first_name', 'assigned_by_user_id', null, 'reason', 'stale room receipt', 'score', 5.0, 'created_at', $5::timestamptz, 'updated_at', $5::timestamptz, 'event', 'preexisting'))), (md5($1::text || ':' || $2::text || ':624')::uuid, $1::uuid, $2::date, '624', 'not_started', $3::uuid, 'pms_import', jsonb_build_array(jsonb_build_object('id', $6::uuid, 'property_id', $1::uuid, 'cleaning_task_id', $7::uuid, 'housekeeper_id', $3::uuid, 'queue_order', 9, 'is_active', true, 'assigned_at', $5::timestamptz, 'assigned_by', 'auto', 'assigned_source', 'auto', 'assigned_by_user_id', null, 'reason', 'stale task receipt', 'score', 9.0, 'created_at', $5::timestamptz, 'updated_at', $5::timestamptz, 'event', 'preexisting')))",
        [PROPERTY, BUSINESS_DATE, HOUSEKEEPER, HISTORY_STALE_ROOM_ASSIGNMENT, '2026-07-31T12:04:00Z', HISTORY_STALE_ASSIGNMENT, HISTORY_STALE_TASK],
      );
    });

    try {
      assert.ok(
        reconciled.report.applied.includes('0434_housekeeping_plan_reconciliation.sql'),
        JSON.stringify(reconciled.report.failedAtRuntime.filter((entry) => entry.file.startsWith('043'))),
      );
      const rowsAfter = (await reconciled.pg.query<{
        room_number: string;
        assigned_staff_id: string;
        assigned_source: string;
        history_count: number;
        snapshot: Record<string, unknown>;
      }>(
        "select room_number, assigned_staff_id, assigned_source, jsonb_array_length(assignment_history)::int as history_count, assignment_history->-1 as snapshot from public.room_work where property_id = $1 and date = $2 and room_number in ('624', '625') order by room_number",
        [PROPERTY, BUSINESS_DATE],
      )).rows;
      assert.equal(rowsAfter.length, 2);
      assert.equal(rowsAfter[0].room_number, '624');
      assert.equal(rowsAfter[0].assigned_staff_id, HOUSEKEEPER);
      assert.equal(rowsAfter[0].assigned_source, 'pms_import');
      assert.equal(rowsAfter[0].history_count, 2);
      assert.equal(rowsAfter[0].snapshot.queue_order, 0);
      assert.equal(rowsAfter[0].snapshot.assigned_at, null);
      assert.equal(rowsAfter[0].snapshot.assigned_by, 'pms_import');
      assert.equal(rowsAfter[0].snapshot.assigned_source, 'pms_import');
      assert.equal(rowsAfter[0].snapshot.reason, null);
      assert.equal(rowsAfter[0].snapshot.score, null);
      assert.equal(rowsAfter[1].room_number, '625');
      assert.equal(rowsAfter[1].assigned_staff_id, HOUSEKEEPER);
      assert.equal(rowsAfter[1].assigned_source, 'alias_first_name');
      assert.equal(rowsAfter[1].history_count, 2);
      assert.equal(rowsAfter[1].snapshot.queue_order, 0);
      assert.equal(rowsAfter[1].snapshot.assigned_by, 'room_work');
      assert.equal(rowsAfter[1].snapshot.assigned_source, 'alias_first_name');
      assert.equal(rowsAfter[1].snapshot.reason, null);
      assert.equal(rowsAfter[1].snapshot.score, null);
    } finally {
      await reconciled.pg.close();
    }
  });

  test('0434 preserves valid cache-only and room-work-only assignment sources', async () => {
    const reconciled = await applyMigrationsToPgliteWithHook(async ({ pg: db, file }) => {
      if (file !== '0434_housekeeping_plan_reconciliation.sql') return;

      await db.query(
        "insert into auth.users(id, email) values ($1, 'phase5-sources@example.test') on conflict (id) do nothing",
        [OWNER],
      );
      await db.query(
        "insert into public.properties(id, owner_id, name, total_rooms, timezone) values ($1, $2, 'Phase Five Inn', 60, 'America/Chicago') on conflict (id) do nothing",
        [PROPERTY, OWNER],
      );
      await db.query(
        "insert into public.staff(id, property_id, name, department, is_active) values ($1, $3, 'Cache Housekeeper', 'housekeeping', true), ($2, $3, 'Room Work Housekeeper', 'housekeeping', true) on conflict (id) do nothing",
        [HOUSEKEEPER, SECOND_HOUSEKEEPER, PROPERTY],
      );
      await db.query(
        "insert into public.cleaning_tasks(id, property_id, room_number, business_date, dedupe_key, cleaning_type, priority, estimated_minutes, requires_inspection, extras, rules_fired, status, assignee_id, source_engine_run_id, source_property_timezone, scheduled_at, last_evaluated_at) values ($1, $2, '604', $3, '604::2026-08-02', 'stayover', 'normal', 20, false, '[]'::jsonb, '[]'::jsonb, 'scheduled', $4, $5, 'America/Chicago', $6::timestamptz, $6::timestamptz)",
        [CACHE_ONLY_TASK, PROPERTY, BUSINESS_DATE, HOUSEKEEPER, 'b4000000-0000-4000-8000-000000000007', '2026-08-02T12:00:00Z'],
      );
      await db.query(
        "insert into public.room_work(property_id, date, room_number, assigned_staff_id, assigned_source, status) values ($1, $2, '605', $3, 'manager', 'not_started')",
        [PROPERTY, BUSINESS_DATE, SECOND_HOUSEKEEPER],
      );
    });

    try {
      assert.ok(reconciled.report.applied.includes('0434_housekeeping_plan_reconciliation.sql'));
      assert.ok(reconciled.report.applied.includes('0435_housekeeping_canonical_operations.sql'));
      const cacheSource = await reconciled.pg.query<{
        assigned_staff_id: string;
        assigned_source: string;
        snapshot: Record<string, unknown>;
      }>(
        "select assigned_staff_id, assigned_source, assignment_history->-1 as snapshot from public.room_work where legacy_task_id = $1",
        [CACHE_ONLY_TASK],
      );
      assert.equal(cacheSource.rows[0].assigned_staff_id, HOUSEKEEPER);
      assert.equal(cacheSource.rows[0].assigned_source, 'pms_import');
      assert.equal(cacheSource.rows[0].snapshot.property_id, PROPERTY);
      assert.equal(cacheSource.rows[0].snapshot.cleaning_task_id, CACHE_ONLY_TASK);
      assert.equal(cacheSource.rows[0].snapshot.housekeeper_id, HOUSEKEEPER);
      assert.equal(cacheSource.rows[0].snapshot.is_active, true);
      assert.equal(cacheSource.rows[0].snapshot.event, 'reconciled_task_cache');

      const roomSource = await reconciled.pg.query<{
        assigned_staff_id: string;
        assigned_source: string;
        snapshot: Record<string, unknown>;
        canonical_id: string;
      }>(
        "select assigned_staff_id, assigned_source, assignment_history->-1 as snapshot, id::text as canonical_id from public.room_work where property_id = $1 and date = $2 and room_number = '605'",
        [PROPERTY, BUSINESS_DATE],
      );
      assert.equal(roomSource.rows[0].assigned_staff_id, SECOND_HOUSEKEEPER);
      assert.equal(roomSource.rows[0].assigned_source, 'manager');
      assert.equal(roomSource.rows[0].snapshot.property_id, PROPERTY);
      assert.equal(roomSource.rows[0].snapshot.cleaning_task_id, roomSource.rows[0].canonical_id);
      assert.equal(roomSource.rows[0].snapshot.housekeeper_id, SECOND_HOUSEKEEPER);
      assert.equal(roomSource.rows[0].snapshot.is_active, true);
      assert.equal(roomSource.rows[0].snapshot.event, 'reconciled_room_work');
    } finally {
      await reconciled.pg.close();
    }
  });

  test('0434 rejects conflicting assignment sources before reconciliation', async () => {
    const conflicting = await applyMigrationsToPgliteWithHook(async ({ pg: db, file }) => {
      if (file !== '0434_housekeeping_plan_reconciliation.sql') return;

      await db.query(
        "insert into auth.users(id, email) values ($1, 'phase5-conflict@example.test') on conflict (id) do nothing",
        [OWNER],
      );
      await db.query(
        "insert into public.properties(id, owner_id, name, total_rooms, timezone) values ($1, $2, 'Phase Five Inn', 60, 'America/Chicago') on conflict (id) do nothing",
        [PROPERTY, OWNER],
      );
      await db.query(
        "insert into public.staff(id, property_id, name, department, is_active) values ($1, $3, 'Cache Housekeeper', 'housekeeping', true), ($2, $3, 'Active Housekeeper', 'housekeeping', true) on conflict (id) do nothing",
        [HOUSEKEEPER, SECOND_HOUSEKEEPER, PROPERTY],
      );
      await db.query(
        "insert into public.cleaning_tasks(id, property_id, room_number, business_date, dedupe_key, cleaning_type, priority, estimated_minutes, requires_inspection, extras, rules_fired, status, assignee_id, source_engine_run_id, source_property_timezone, scheduled_at, last_evaluated_at) values ($1, $2, '606', $3, '606::2026-08-02', 'stayover', 'normal', 20, false, '[]'::jsonb, '[]'::jsonb, 'scheduled', $4, $5, 'America/Chicago', $6::timestamptz, $6::timestamptz)",
        [CACHE_ONLY_TASK, PROPERTY, BUSINESS_DATE, HOUSEKEEPER, 'b4000000-0000-4000-8000-000000000008', '2026-08-02T12:00:00Z'],
      );
      await db.query(
        "insert into public.hk_assignments(id, property_id, cleaning_task_id, housekeeper_id, is_active, assigned_by) values ($1, $2, $3, $4, true, 'auto')",
        [NEW_ASSIGNMENT, PROPERTY, CACHE_ONLY_TASK, SECOND_HOUSEKEEPER],
      );
    });

    try {
      const failure = conflicting.report.failedAtRuntime.find(
        (entry) => entry.file === '0434_housekeeping_plan_reconciliation.sql',
      );
      assert.ok(failure, JSON.stringify(conflicting.report.failedAtRuntime.filter((entry) => entry.file.startsWith('043'))));
      assert.match(failure.error, /assignment source group/i);
      assert.equal(conflicting.report.applied.includes('0434_housekeeping_plan_reconciliation.sql'), false);
      await conflicting.pg.exec('rollback;').catch(() => undefined);
      assert.deepEqual(
        (await conflicting.pg.query<{ assignee_id: string }>(
          "select assignee_id from public.cleaning_tasks where id = $1",
          [CACHE_ONLY_TASK],
        )).rows,
        [{ assignee_id: HOUSEKEEPER }],
      );
      assert.deepEqual(
        (await conflicting.pg.query<{ housekeeper_id: string }>(
          "select housekeeper_id from public.hk_assignments where id = $1",
          [NEW_ASSIGNMENT],
        )).rows,
        [{ housekeeper_id: SECOND_HOUSEKEEPER }],
      );
    } finally {
      await conflicting.pg.close();
    }
  });

  test('0434 rejects an inactive same-property cache assignee before reconciliation', async () => {
    const invalid = await applyMigrationsToPgliteWithHook(async ({ pg: db, file }) => {
      if (file !== '0434_housekeeping_plan_reconciliation.sql') return;

      await db.query(
        "insert into auth.users(id, email) values ($1, 'phase5-ineligible-cache@example.test') on conflict (id) do nothing",
        [OWNER],
      );
      await db.query(
        "insert into public.properties(id, owner_id, name, total_rooms, timezone) values ($1, $2, 'Phase Five Inn', 60, 'America/Chicago') on conflict (id) do nothing",
        [PROPERTY, OWNER],
      );
      await db.query(
        "insert into public.staff(id, property_id, name, department, is_active) values ($1, $2, 'Inactive Housekeeper', 'housekeeping', false) on conflict (id) do nothing",
        [INACTIVE_STAFF, PROPERTY],
      );
      await db.query(
        "insert into public.cleaning_tasks(id, property_id, room_number, business_date, dedupe_key, cleaning_type, priority, estimated_minutes, requires_inspection, extras, rules_fired, status, assignee_id, source_engine_run_id, source_property_timezone, scheduled_at, last_evaluated_at) values ($1, $2, '608', $3, '608::2026-08-02', 'stayover', 'normal', 20, false, '[]'::jsonb, '[]'::jsonb, 'scheduled', $4, $5, 'America/Chicago', $6::timestamptz, $6::timestamptz)",
        [INELIGIBLE_TASK, PROPERTY, BUSINESS_DATE, INACTIVE_STAFF, 'b4000000-0000-4000-8000-000000000010', '2026-08-02T12:00:00Z'],
      );
    });

    try {
      const failure = invalid.report.failedAtRuntime.find(
        (entry) => entry.file === '0434_housekeeping_plan_reconciliation.sql',
      );
      assert.ok(failure, JSON.stringify(invalid.report.failedAtRuntime.filter((entry) => entry.file.startsWith('043'))));
      assert.match(failure.error, /active same-property housekeeping/i);
      assert.equal(invalid.report.applied.includes('0434_housekeeping_plan_reconciliation.sql'), false);
      await invalid.pg.exec('rollback;').catch(() => undefined);
      assert.deepEqual(
        (await invalid.pg.query<{ assignee_id: string }>(
          "select assignee_id from public.cleaning_tasks where id = $1",
          [INELIGIBLE_TASK],
        )).rows,
        [{ assignee_id: INACTIVE_STAFF }],
      );
    } finally {
      await invalid.pg.close();
    }
  });

  test('0434 rejects a same-property non-housekeeping room_work assignee before reconciliation', async () => {
    const invalid = await applyMigrationsToPgliteWithHook(async ({ pg: db, file }) => {
      if (file !== '0434_housekeeping_plan_reconciliation.sql') return;

      await db.query(
        "insert into auth.users(id, email) values ($1, 'phase5-ineligible-room-work@example.test') on conflict (id) do nothing",
        [OWNER],
      );
      await db.query(
        "insert into public.properties(id, owner_id, name, total_rooms, timezone) values ($1, $2, 'Phase Five Inn', 60, 'America/Chicago') on conflict (id) do nothing",
        [PROPERTY, OWNER],
      );
      await db.query(
        "insert into public.staff(id, property_id, name, department, is_active) values ($1, $2, 'Front Desk', 'front_desk', true) on conflict (id) do nothing",
        [NON_HOUSEKEEPING_STAFF, PROPERTY],
      );
      await db.query(
        "insert into public.room_work(property_id, date, room_number, assigned_staff_id, assigned_source, status) values ($1, $2, '609', $3, 'manager', 'not_started')",
        [PROPERTY, BUSINESS_DATE, NON_HOUSEKEEPING_STAFF],
      );
    });

    try {
      const failure = invalid.report.failedAtRuntime.find(
        (entry) => entry.file === '0434_housekeeping_plan_reconciliation.sql',
      );
      assert.ok(failure, JSON.stringify(invalid.report.failedAtRuntime.filter((entry) => entry.file.startsWith('043'))));
      assert.match(failure.error, /active same-property housekeeping/i);
      assert.equal(invalid.report.applied.includes('0434_housekeeping_plan_reconciliation.sql'), false);
      await invalid.pg.exec('rollback;').catch(() => undefined);
      assert.deepEqual(
        (await invalid.pg.query<{ assigned_staff_id: string }>(
          "select assigned_staff_id from public.room_work where property_id = $1 and date = $2 and room_number = '609'",
          [PROPERTY, BUSINESS_DATE],
        )).rows,
        [{ assigned_staff_id: NON_HOUSEKEEPING_STAFF }],
      );
    } finally {
      await invalid.pg.close();
    }
  });

  test('0434 rejects an active room-work history source targeting inactive staff', async () => {
    const invalid = await applyMigrationsToPgliteWithHook(async ({ pg: db, file }) => {
      if (file !== '0434_housekeeping_plan_reconciliation.sql') return;

      await db.query(
        "insert into auth.users(id, email) values ($1, 'phase5-ineligible-history@example.test') on conflict (id) do nothing",
        [OWNER],
      );
      await db.query(
        "insert into public.properties(id, owner_id, name, total_rooms, timezone) values ($1, $2, 'Phase Five Inn', 60, 'America/Chicago') on conflict (id) do nothing",
        [PROPERTY, OWNER],
      );
      await db.query(
        "insert into public.staff(id, property_id, name, department, is_active) values ($1, $2, 'Inactive History Housekeeper', 'housekeeping', false) on conflict (id) do nothing",
        [INACTIVE_STAFF, PROPERTY],
      );
      await db.query(
        "insert into public.cleaning_tasks(id, property_id, room_number, business_date, dedupe_key, cleaning_type, priority, estimated_minutes, requires_inspection, extras, rules_fired, status, source_engine_run_id, source_property_timezone, scheduled_at, last_evaluated_at) values ($1, $2, '610', $3, '610::2026-08-02', 'stayover', 'normal', 20, false, '[]'::jsonb, '[]'::jsonb, 'scheduled', $4, 'America/Chicago', $5::timestamptz, $5::timestamptz)",
        [INELIGIBLE_TASK, PROPERTY, BUSINESS_DATE, 'b4000000-0000-4000-8000-000000000011', '2026-08-02T12:00:00Z'],
      );
      await db.query("alter table public.room_work add column if not exists assignment_history jsonb");
      await db.query(
        "insert into public.room_work(property_id, date, room_number, status, assigned_staff_id, assigned_source, assignment_history) values ($1, $2, '610', 'not_started', null, null, jsonb_build_array(jsonb_build_object('id', $3::uuid, 'property_id', $1::uuid, 'cleaning_task_id', $4::uuid, 'housekeeper_id', $5::uuid, 'queue_order', 1, 'is_active', true, 'assigned_at', $6::timestamptz, 'assigned_by', 'auto', 'assigned_by_user_id', null, 'reason', 'inactive history', 'score', 1.0, 'created_at', $6::timestamptz, 'updated_at', $6::timestamptz)))",
        [PROPERTY, BUSINESS_DATE, HISTORY_ONLY_ASSIGNMENT, INELIGIBLE_TASK, INACTIVE_STAFF, '2026-07-31T12:01:00Z'],
      );
    });

    try {
      const failure = invalid.report.failedAtRuntime.find(
        (entry) => entry.file === '0434_housekeeping_plan_reconciliation.sql',
      );
      assert.ok(failure, JSON.stringify(invalid.report.failedAtRuntime.filter((entry) => entry.file.startsWith('043'))));
      assert.match(failure.error, /active room_work assignment history/i);
      assert.equal(invalid.report.applied.includes('0434_housekeeping_plan_reconciliation.sql'), false);
      await invalid.pg.exec('rollback;').catch(() => undefined);
      assert.deepEqual(
        (await invalid.pg.query<{ assigned_staff_id: string | null }>(
          "select assigned_staff_id from public.room_work where property_id = $1 and date = $2 and room_number = '610'",
          [PROPERTY, BUSINESS_DATE],
        )).rows,
        [{ assigned_staff_id: null }],
      );
    } finally {
      await invalid.pg.close();
    }
  });

  test('0434 preserves unchanged room-work timestamps while reconciling changed payloads', async () => {
    let unchangedUpdatedAt = '';
    let changedUpdatedAt = '';
    const reconciled = await applyMigrationsToPgliteWithHook(async ({ pg: db, file }) => {
      if (file !== '0434_housekeeping_plan_reconciliation.sql') return;

      await db.query(
        "insert into auth.users(id, email) values ($1, 'phase5-timestamp@example.test') on conflict (id) do nothing",
        [OWNER],
      );
      await db.query(
        "insert into public.properties(id, owner_id, name, total_rooms, timezone) values ($1, $2, 'Phase Five Inn', 80, 'America/Chicago') on conflict (id) do nothing",
        [PROPERTY, OWNER],
      );
      await db.query(
        "insert into public.staff(id, property_id, name, department, is_active) values ($1, $2, 'Timestamp Housekeeper', 'housekeeping', true) on conflict (id) do nothing",
        [HOUSEKEEPER, PROPERTY],
      );
      await db.query(
        `alter table public.room_work
           add column if not exists id uuid,
           add column if not exists legacy_task_id uuid,
           add column if not exists plan_dedupe_key text,
           add column if not exists plan_cleaning_type text,
           add column if not exists plan_priority text,
           add column if not exists plan_due_by timestamptz,
           add column if not exists plan_estimated_minutes integer,
           add column if not exists plan_requires_inspection boolean,
           add column if not exists plan_extras jsonb,
           add column if not exists plan_notes text,
           add column if not exists plan_rules_fired jsonb,
           add column if not exists plan_rule_inputs jsonb,
           add column if not exists plan_status text,
           add column if not exists plan_source_pms_reservation_id text,
           add column if not exists plan_source_engine_run_id uuid,
           add column if not exists plan_source_property_timezone text,
           add column if not exists plan_scheduled_at timestamptz,
           add column if not exists plan_last_evaluated_at timestamptz,
           add column if not exists assignment_queue_order integer,
           add column if not exists assignment_assigned_at timestamptz,
           add column if not exists assignment_assigned_by text,
           add column if not exists assignment_assigned_by_user_id uuid,
           add column if not exists assignment_reason text,
           add column if not exists assignment_score numeric,
           add column if not exists assignment_history jsonb`,
      );

      const unchanged = await db.query<{ updated_at: string }>(
        `insert into public.room_work(
           property_id, date, room_number, id, legacy_task_id,
           plan_dedupe_key, plan_requires_inspection, plan_extras, plan_rules_fired,
           assigned_staff_id, assigned_source, assignment_queue_order,
           assignment_assigned_at, assignment_assigned_by, assignment_assigned_by_user_id,
           assignment_reason, assignment_score, assignment_history, status, updated_at
         ) values (
           $1::uuid, $2::date, '712', md5($1::uuid::text || ':' || $2::date::text || ':712')::uuid, null,
           '712::2026-08-02', false, '[]'::jsonb, '[]'::jsonb,
           $3::uuid, 'manager', 0, $4::timestamptz, 'manual', null::uuid,
           null::text, null::numeric,
           jsonb_build_array(jsonb_build_object(
             'id', $5::uuid,
             'property_id', $1::uuid,
             'cleaning_task_id', md5($1::uuid::text || ':' || $2::date::text || ':712')::uuid,
             'housekeeper_id', $3::uuid,
             'queue_order', 0,
             'is_active', true,
             'assigned_at', $4::timestamptz,
             'assigned_by', 'manual',
             'assigned_source', 'manager',
             'assigned_by_user_id', null::uuid,
             'reason', null::text,
             'score', null::numeric,
             'created_at', $4::timestamptz,
             'updated_at', $4::timestamptz
           )),
           'not_started', $6::timestamptz
         ) returning updated_at::text`,
        [PROPERTY, BUSINESS_DATE, HOUSEKEEPER, '2026-07-30T11:00:00Z', HISTORY_ONLY_ASSIGNMENT, '2026-07-30T10:00:00Z'],
      );
      unchangedUpdatedAt = unchanged.rows[0]?.updated_at ?? '';

      await db.query(
        "insert into public.cleaning_tasks(id, property_id, room_number, business_date, dedupe_key, cleaning_type, priority, estimated_minutes, requires_inspection, extras, rules_fired, status, assignee_id, source_property_timezone, scheduled_at, last_evaluated_at) values ($1::uuid, $2::uuid, '713', $3::date, '713::2026-08-02', 'stayover', 'normal', 20, false, '[]'::jsonb, '[]'::jsonb, 'scheduled', $4::uuid, 'America/Chicago', $5::timestamptz, $5::timestamptz)",
        [NEW_TASK, PROPERTY, BUSINESS_DATE, HOUSEKEEPER, '2026-08-02T12:00:00Z'],
      );
      const changed = await db.query<{ updated_at: string }>(
        "insert into public.room_work(property_id, date, room_number, status, updated_at) values ($1::uuid, $2::date, '713', 'not_started', $3::timestamptz) returning updated_at::text",
        [PROPERTY, BUSINESS_DATE, '2026-07-30T10:00:00Z'],
      );
      changedUpdatedAt = changed.rows[0]?.updated_at ?? '';
    });

    try {
      if (!reconciled.report.applied.includes('0434_housekeeping_plan_reconciliation.sql')) {
        assert.fail(JSON.stringify(reconciled.report.failedAtRuntime.filter((entry) => entry.file.startsWith('043'))));
      }
      assert.ok(unchangedUpdatedAt);
      assert.ok(changedUpdatedAt);
      const finalRows = await reconciled.pg.query<{
        room_number: string;
        updated_at: string;
        assigned_staff_id: string | null;
        assigned_source: string | null;
        plan_cleaning_type: string | null;
        history_count: number;
      }>(
        `select room_number, updated_at::text, assigned_staff_id::text, assigned_source,
                plan_cleaning_type, jsonb_array_length(assignment_history)::int as history_count
           from public.room_work
          where property_id = $1 and date = $2 and room_number in ('712', '713')
          order by room_number`,
        [PROPERTY, BUSINESS_DATE],
      );
      assert.equal(finalRows.rows.length, 2, JSON.stringify(finalRows.rows));
      assert.deepEqual(finalRows.rows[0], {
        room_number: '712',
        updated_at: unchangedUpdatedAt,
        assigned_staff_id: HOUSEKEEPER,
        assigned_source: 'manager',
        plan_cleaning_type: null,
        history_count: 1,
      });
      assert.equal(finalRows.rows[1]?.room_number, '713');
      assert.notEqual(finalRows.rows[1]?.updated_at, changedUpdatedAt);
      assert.equal(finalRows.rows[1]?.assigned_staff_id, HOUSEKEEPER);
      assert.equal(finalRows.rows[1]?.assigned_source, 'pms_import');
      assert.equal(finalRows.rows[1]?.plan_cleaning_type, 'stayover');
    } finally {
      await reconciled.pg.close();
    }
  });
});
