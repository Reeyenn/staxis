import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { applyMigrationsToPgliteWithHook } from '../../../tests/fixtures/pglite-migrate';

const OWNER = 'b1000000-0000-4000-8000-000000000001';
const PROPERTY = 'b2000000-0000-4000-8000-000000000001';
const OTHER_PROPERTY = 'b2000000-0000-4000-8000-000000000002';
const HOUSEKEEPER = 'b3000000-0000-4000-8000-000000000001';
const OTHER_HOUSEKEEPER = 'b3000000-0000-4000-8000-000000000002';
const TASK = 'b4000000-0000-4000-8000-000000000001';
const REVERSE_TASK = 'b4000000-0000-4000-8000-000000000002';
const INSPECTION = 'b5000000-0000-4000-8000-000000000001';
const REVERSE_INSPECTION = 'b5000000-0000-4000-8000-000000000002';
const ROLLBACK_INSPECTION = 'b5000000-0000-4000-8000-000000000003';
const BUSINESS_DATE = '2026-08-02';
const TASK_DATE = '2026-08-03';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..', '..');

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

describe('housekeeping canonical plan Stage B cutover', () => {
  before(async () => {
    const migrated = await applyMigrationsToPgliteWithHook(async ({ pg: db, file }) => {
      if (file !== '0434_housekeeping_plan_reconciliation.sql') return;

      await db.query(
        "insert into auth.users(id, email) values ($1, 'stage-b@example.test') on conflict (id) do nothing",
        [OWNER],
      );
      await db.query(
        "insert into public.properties(id, owner_id, name, total_rooms, timezone) values ($1, $3, 'Stage B Inn', 40, 'America/Chicago'), ($2, $3, 'Other Stage B Inn', 20, 'America/Chicago') on conflict (id) do nothing",
        [PROPERTY, OTHER_PROPERTY, OWNER],
      );
      await db.query(
        "insert into public.staff(id, property_id, name, department, is_active) values ($1, $3, 'Stage B Housekeeper', 'housekeeping', true), ($2, $4, 'Other Housekeeper', 'housekeeping', true) on conflict (id) do nothing",
        [HOUSEKEEPER, OTHER_HOUSEKEEPER, PROPERTY, OTHER_PROPERTY],
      );
      await db.query(
        "insert into public.component_rooms(property_id, parent_room_number, child_room_numbers) values ($1, '900', '[\"100\"]'::jsonb) on conflict (property_id, parent_room_number) do update set child_room_numbers = excluded.child_room_numbers",
        [PROPERTY],
      );
    });

    pg = migrated.pg;
    assert.ok(migrated.report.applied.includes('0434_housekeeping_plan_reconciliation.sql'));
    assert.ok(migrated.report.applied.includes('0435_housekeeping_canonical_operations.sql'));
    assert.ok(migrated.report.applied.includes('0436_housekeeping_stage_b_inspection_lock.sql'));
    assert.deepEqual(
      migrated.report.failedAtRuntime.filter((entry) => entry.file.startsWith('043')),
      [],
      'the real 0434-0436 migrations must apply without a runtime failure',
    );
  });

  after(async () => {
    await pg.close();
  });

  test('canonical manager writers and reads are active while legacy relations remain rollback-compatible', async () => {
    const relations = await rows<{ relname: string; relkind: string }>(
      "select relname, relkind from pg_class where relnamespace = 'public'::regnamespace and relname in ('cleaning_tasks', 'hk_assignments', 'room_work_plan_v1') order by relname",
    );
    assert.deepEqual(relations, [
      { relname: 'cleaning_tasks', relkind: 'r' },
      { relname: 'hk_assignments', relkind: 'r' },
      { relname: 'room_work_plan_v1', relkind: 'v' },
    ]);

    await pg.query(
      "select * from public.upsert_room_work_plan($1, $2::jsonb)",
      [PROPERTY, JSON.stringify([{
        property_id: PROPERTY,
        room_number: '300',
        business_date: BUSINESS_DATE,
        dedupe_key: '300::stage-b',
        cleaning_type: 'stayover',
        priority: 'normal',
        status: 'scheduled',
      }])],
    );
    const assigned = await rows<{ task_id: string; assignee_id: string; noop: boolean }>(
      "select * from public.assign_room_work_atomic($1, public.housekeeping_plan_id($1, $2, '300'), $3, $4, 'stage-b auto', 4, 2.5, true, 'auto')",
      [PROPERTY, BUSINESS_DATE, HOUSEKEEPER, OWNER],
    );
    assert.deepEqual(assigned, [{
      task_id: await scalar<string>(
        "select public.housekeeping_plan_id($1, $2, '300')::text",
        [PROPERTY, BUSINESS_DATE],
      ),
      assignee_id: HOUSEKEEPER,
      noop: false,
    }]);
    const repeat = await rows<{ noop: boolean }>(
      "select noop from public.assign_room_work_atomic($1, public.housekeeping_plan_id($1, $2, '300'), $3, $4, 'stage-b retry', 8, 9, true, 'auto')",
      [PROPERTY, BUSINESS_DATE, HOUSEKEEPER, OWNER],
    );
    assert.deepEqual(repeat, [{ noop: true }], 'only-if-unassigned retry must not overwrite the manager-visible assignment');
    assert.equal(
      await scalar<string>(
        "select assignee_id::text from public.room_work_plan_v1 where property_id = $1 and business_date = $2 and room_number = '300'",
        [PROPERTY, BUSINESS_DATE],
      ),
      HOUSEKEEPER,
    );

    assert.equal(
      await scalar<number>(
        "select public.reset_room_work_assignments($1, $2, public.housekeeping_plan_id($1, $2, '300'))",
        [PROPERTY, BUSINESS_DATE],
      ),
      1,
    );
    assert.equal(
      await scalar<string | null>(
        "select assignee_id::text from public.room_work_plan_v1 where property_id = $1 and business_date = $2 and room_number = '300'",
        [PROPERTY, BUSINESS_DATE],
      ),
      null,
    );

    const crossProperty = await failsWith(
      "select * from public.assign_room_work_atomic($1, public.housekeeping_plan_id($1, $2, '300'), $3, $4, 'cross property', 1, 1, false, 'manual')",
      [PROPERTY, BUSINESS_DATE, OTHER_HOUSEKEEPER, OWNER],
    );
    assert.match(crossProperty, /not found|property|housekeeper/i);

    const sourceContracts = [
      ['src/app/api/housekeeping/board/route.ts', /from\('room_work_plan_v1'\)/],
      ['src/app/api/housekeeping/timeline/route.ts', /from\('room_work_plan_v1'\)/],
      ['src/app/api/housekeeping/reassign/route.ts', /['"]assign_room_work_atomic['"]/],
      ['src/app/api/housekeeping/reset-assignments/route.ts', /['"]reset_room_work_assignments['"]/],
      ['src/lib/auto-assign-runner.ts', /['"]assign_room_work_atomic['"]/],
      ['src/lib/rules-engine/engine.ts', /['"]upsert_room_work_plan['"]|['"]touch_room_work_plan['"]/],
      ['src/lib/inspections/correction-loop.ts', /['"]complete_inspection_atomic_canonical['"]/],
    ] as const;
    for (const [relativePath, contract] of sourceContracts) {
      assert.match(readFileSync(resolve(repo, relativePath), 'utf8'), contract, relativePath);
    }
    assert.doesNotMatch(
      readFileSync(resolve(repo, 'src/app/api/housekeeping/board/route.ts'), 'utf8'),
      /\.from\(['"](?:cleaning_tasks|hk_assignments)['"]\)/,
    );
    assert.doesNotMatch(
      readFileSync(resolve(repo, 'src/app/api/housekeeping/timeline/route.ts'), 'utf8'),
      /\.from\(['"](?:cleaning_tasks|hk_assignments)['"]\)/,
    );
    for (const relativePath of [
      'src/app/api/housekeeping/reassign/route.ts',
      'src/app/api/housekeeping/reset-assignments/route.ts',
      'src/app/api/housekeeping/auto-assign/route.ts',
      'src/lib/auto-assign-runner.ts',
      'src/lib/rules-engine/engine.ts',
      'src/lib/inspections/correction-loop.ts',
    ]) {
      assert.doesNotMatch(
        readFileSync(resolve(repo, relativePath), 'utf8'),
        /(?:\.from|\.rpc)\(['"](?:cleaning_tasks|hk_assignments|reassign_cleaning_task|complete_inspection_atomic)['"]\)/,
        `${relativePath} must not have a Stage B runtime fallback to a legacy writer`,
      );
    }
  });

  test('canonical inspection locks both dates in deterministic order and preserves atomic/retry behavior', async () => {
    const source = await scalar<string>(
      "select p.prosrc from pg_proc p where p.oid = 'public.complete_inspection_atomic_canonical(uuid,uuid,text,jsonb,jsonb,text,boolean,text,timestamptz,text)'::regprocedure",
    );
    const firstLock = source.indexOf('perform public._lock_room_work_component_set');
    const firstRoomMutation = source.indexOf('insert into public.room_work');
    assert.ok(firstLock >= 0 && firstLock < firstRoomMutation, 'canonical inspection must lock before its first room_work mutation');
    assert.match(source, /v_date\s*<\s*v_task_date/);
    assert.match(source, /v_task_date\s*<\s*v_date/);
    assert.ok(
      (source.match(/perform public\._lock_room_work_component_set/g) ?? []).length >= 3,
      'same-date and both deterministic different-date branches must use the shared helper',
    );

    // PGlite gives this suite one backend session, so it cannot prove a
    // PostgreSQL two-session deadlock schedule. The executable assertions
    // below cover the actual two-date runtime path and the production
    // function's complete lock protocol; real multi-session scheduling stays
    // an explicit Postgres release-review limitation.
    await pg.query(
      "insert into public.room_work(id, property_id, date, room_number, status, plan_dedupe_key, plan_cleaning_type, plan_priority, plan_status) values (public.housekeeping_plan_id($1, $2, '900'), $1, $2, '900', 'not_started', '900::stage-b', 'stayover', 'normal', 'scheduled'), (public.housekeeping_plan_id($1, $3, '200'), $1, $3, '200', 'not_started', '200::stage-b', 'stayover', 'normal', 'scheduled')",
      [PROPERTY, BUSINESS_DATE, TASK_DATE],
    );
    await pg.query(
      "update public.room_work set legacy_task_id = $3 where property_id = $1 and date = $2 and room_number = '200'",
      [PROPERTY, TASK_DATE, TASK],
    );
    await pg.query(
      "insert into public.inspections(id, property_id, room_number, cleaning_task_id, result, started_at) values ($1, $2, '900', $3, 'in_progress', $4::timestamptz)",
      [INSPECTION, PROPERTY, TASK, `${BUSINESS_DATE}T14:00:00Z`],
    );

    await pg.query(
      "select * from public.complete_inspection_atomic_canonical($1, $2, 'pass', '[]'::jsonb, '[]'::jsonb, null, false, null, null, null)",
      [INSPECTION, PROPERTY],
    );
    assert.deepEqual(
      await rows<{ date: string; room_number: string; status: string; plan_status: string | null }>(
        "select date::text, room_number, status, plan_status from public.room_work where property_id = $1 and ((date = $2 and room_number = '900') or (date = $3 and room_number = '200')) order by date, room_number",
        [PROPERTY, BUSINESS_DATE, TASK_DATE],
      ),
      [
        { date: BUSINESS_DATE, room_number: '900', status: 'completed', plan_status: 'scheduled' },
        { date: TASK_DATE, room_number: '200', status: 'not_started', plan_status: 'inspected_pass' },
      ],
    );
    assert.equal(
      await scalar<string>("select result from public.inspections where id = $1", [INSPECTION]),
      'pass',
    );
    const retry = await failsWith(
      "select * from public.complete_inspection_atomic_canonical($1, $2, 'pass', '[]'::jsonb, '[]'::jsonb, null, false, null, null, null)",
      [INSPECTION, PROPERTY],
    );
    assert.match(retry, /already/i);

    await pg.query(
      "insert into public.room_work(id, property_id, date, room_number, status, plan_dedupe_key, plan_cleaning_type, plan_priority, plan_status) values (public.housekeeping_plan_id($1, $2, '901'), $1, $2, '901', 'not_started', '901::stage-b', 'stayover', 'normal', 'scheduled'), (public.housekeeping_plan_id($1, $3, '201'), $1, $3, '201', 'not_started', '201::stage-b', 'stayover', 'normal', 'scheduled')",
      [PROPERTY, TASK_DATE, BUSINESS_DATE],
    );
    await pg.query(
      "update public.room_work set legacy_task_id = $3 where property_id = $1 and date = $2 and room_number = '201'",
      [PROPERTY, BUSINESS_DATE, REVERSE_TASK],
    );
    await pg.query(
      "insert into public.inspections(id, property_id, room_number, cleaning_task_id, result, started_at) values ($1, $2, '901', $3, 'in_progress', $4::timestamptz)",
      [REVERSE_INSPECTION, PROPERTY, REVERSE_TASK, `${TASK_DATE}T14:00:00Z`],
    );
    await pg.query(
      "select * from public.complete_inspection_atomic_canonical($1, $2, 'fail', '[]'::jsonb, '[]'::jsonb, null, false, null, null, 'reverse date lock')",
      [REVERSE_INSPECTION, PROPERTY],
    );
    assert.deepEqual(
      await rows<{ date: string; room_number: string; status: string; plan_status: string | null }>(
        "select date::text, room_number, status, plan_status from public.room_work where property_id = $1 and ((date = $2 and room_number = '201') or (date = $3 and room_number = '901')) order by date, room_number",
        [PROPERTY, BUSINESS_DATE, TASK_DATE],
      ),
      [
        { date: BUSINESS_DATE, room_number: '201', status: 'not_started', plan_status: 'correction_pending' },
        { date: TASK_DATE, room_number: '901', status: 'not_started', plan_status: 'scheduled' },
      ],
    );

    await pg.query(
      "insert into public.room_work(id, property_id, date, room_number, status) values (public.housekeeping_plan_id($1, $2, '902'), $1, $2, '902', 'not_started')",
      [PROPERTY, BUSINESS_DATE],
    );
    await pg.query(
      "insert into public.inspections(id, property_id, room_number, cleaning_task_id, result, started_at) values ($1, $2, '902', null, 'in_progress', $3::timestamptz)",
      [ROLLBACK_INSPECTION, PROPERTY, `${BUSINESS_DATE}T15:00:00Z`],
    );
    await pg.exec("create or replace function public.stage_b_fail_inspection_room() returns trigger language plpgsql as $$ begin raise exception 'stage-b inspection room failure'; end; $$");
    await pg.exec("create trigger stage_b_fail_inspection_room before update of status on public.room_work for each row when (new.room_number = '902') execute function public.stage_b_fail_inspection_room()");
    const inspectionFailure = await failsWith(
      "select * from public.complete_inspection_atomic_canonical($1, $2, 'pass', '[]'::jsonb, '[]'::jsonb, null, false, null, null, null)",
      [ROLLBACK_INSPECTION, PROPERTY],
    );
    assert.match(inspectionFailure, /stage-b inspection room failure/i);
    assert.deepEqual(
      await rows<{ result: string; room_status: string }>(
        "select i.result, w.status as room_status from public.inspections i join public.room_work w on w.property_id = i.property_id and w.date = $2 and w.room_number = i.room_number where i.id = $1",
        [ROLLBACK_INSPECTION, BUSINESS_DATE],
      ),
      [{ result: 'in_progress', room_status: 'not_started' }],
      'a canonical inspection failure must roll back the inspection and room side effects together',
    );
    await pg.exec("drop trigger stage_b_fail_inspection_room on public.room_work; drop function public.stage_b_fail_inspection_room()");

    await pg.query(
      "insert into public.room_work(id, property_id, date, room_number, status) values (public.housekeeping_plan_id($1, $2, '100'), $1, $2, '100', 'not_started') on conflict (property_id, date, room_number) do update set status = 'not_started'",
      [PROPERTY, BUSINESS_DATE],
    );
    await pg.exec("create or replace function public.stage_b_fail_child() returns trigger language plpgsql as $$ begin raise exception 'stage-b child failure'; end; $$");
    await pg.exec("create trigger stage_b_fail_child before update of status on public.room_work for each row when (new.room_number = '100') execute function public.stage_b_fail_child()");
    const rollback = await failsWith(
      "select public.write_room_work_atomic($1, $2, '900', '{\"status\":\"completed\"}'::jsonb)",
      [PROPERTY, BUSINESS_DATE],
    );
    assert.match(rollback, /stage-b child failure/i);
    assert.deepEqual(
      await rows<{ room_number: string; status: string }>(
        "select room_number, status from public.room_work where property_id = $1 and date = $2 and room_number in ('100', '900') order by room_number",
        [PROPERTY, BUSINESS_DATE],
      ),
      [
        { room_number: '100', status: 'not_started' },
        { room_number: '900', status: 'completed' },
      ],
      'a failed component completion must leave the already-completed parent unchanged too',
    );
    await pg.exec("drop trigger stage_b_fail_child on public.room_work; drop function public.stage_b_fail_child()");

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
           ('public.complete_inspection_atomic_canonical(uuid,uuid,text,jsonb,jsonb,text,boolean,text,timestamptz,text)'::text),
           ('public.write_room_work_atomic(uuid,date,text,jsonb,text,boolean)'::text),
           ('public.assign_room_work_atomic(uuid,uuid,uuid,uuid,text,integer,numeric,boolean,text)'::text)
         ) functions(function_name)
        order by function_name`,
    );
    assert.ok(privileges.length === 3);
    for (const privilege of privileges) {
      assert.equal(privilege.service_role_execute, true, privilege.function_name);
      assert.equal(privilege.anon_execute, false, privilege.function_name);
      assert.equal(privilege.authenticated_execute, false, privilege.function_name);
    }
  });
});
