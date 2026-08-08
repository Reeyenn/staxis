process.env.DISABLE_SERVER_2FA_ENFORCEMENT = 'true';

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { NextRequest } from 'next/server';
import type { PGlite } from '@electric-sql/pglite';

import { applyMigrationsToPgliteWithHook } from '../../../tests/fixtures/pglite-migrate';
import { createPglitePostgrest, loadCatalog } from '../../../tests/fixtures/postgrest-pglite';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { POST as fillSchedule } from '@/app/api/staff-schedule/fill/route';
import {
  POST as writeShift,
  DELETE as deleteShift,
} from '@/app/api/staff-schedule/shifts/route';
import {
  POST as createTemplate,
  DELETE as deleteTemplate,
} from '@/app/api/staff-schedule/templates/route';
import { POST as setWeekDone } from '@/app/api/staff-schedule/week-done/route';
import { PUT as replacePresets } from '@/app/api/staff-schedule/presets/route';
import {
  POST as submitTimeOff,
  PUT as decideTimeOff,
  DELETE as cancelTimeOff,
} from '@/app/api/staff-schedule/time-off/route';

const MANAGER_USER = 'b1000000-0000-4000-8000-000000000001';
const EMPLOYEE_USER = 'b1000000-0000-4000-8000-000000000002';
const UNLINKED_USER = 'b1000000-0000-4000-8000-000000000003';
const ARCHIVE_USER = 'b1000000-0000-4000-8000-000000000004';
const LEGACY_POINTER_USER = 'b1000000-0000-4000-8000-000000000006';
const PROPERTY = 'b2000000-0000-4000-8000-000000000001';
const EMPLOYEE_STAFF = 'b3000000-0000-4000-8000-000000000001';
const COWORKER_STAFF = 'b3000000-0000-4000-8000-000000000002';
const ARCHIVED_STAFF = 'b3000000-0000-4000-8000-000000000003';
const OWN_SHIFT = 'b4000000-0000-4000-8000-000000000001';
const OWN_DRAFT = 'b4000000-0000-4000-8000-000000000002';
const COWORKER_SHIFT = 'b4000000-0000-4000-8000-000000000003';
const OPEN_OWN_DEPT = 'b4000000-0000-4000-8000-000000000004';
const OPEN_OTHER_DEPT = 'b4000000-0000-4000-8000-000000000005';
const OWN_TIME_OFF = 'b5000000-0000-4000-8000-000000000001';
const COWORKER_TIME_OFF = 'b5000000-0000-4000-8000-000000000002';
const ATOMIC_TIME_OFF = 'b5000000-0000-4000-8000-000000000003';
const ATOMIC_SHIFT = 'b4000000-0000-4000-8000-000000000006';
const ARCHIVE_PAST = 'b4000000-0000-4000-8000-000000000007';
const ARCHIVE_TODAY = 'b4000000-0000-4000-8000-000000000008';
const ARCHIVE_FUTURE = 'b4000000-0000-4000-8000-000000000009';
const HISTORY_USER = 'b1000000-0000-4000-8000-000000000005';
const HISTORY_PROPERTY = 'b2000000-0000-4000-8000-000000000002';
const HISTORY_STAFF = 'b3000000-0000-4000-8000-000000000004';
const HISTORY_INACTIVE_STAFF = 'b3000000-0000-4000-8000-000000000005';
const HISTORY_INACTIVE_ACCOUNT = 'b6000000-0000-4000-8000-000000000001';
const HISTORY_PAST_SHIFT = 'b4000000-0000-4000-8000-000000000010';
const HISTORY_FUTURE_SHIFT = 'b4000000-0000-4000-8000-000000000011';
const HISTORY_INACTIVE_FUTURE_SHIFT = 'b4000000-0000-4000-8000-000000000012';
const HISTORY_PAST_LEAVE = 'b5000000-0000-4000-8000-000000000010';
const HISTORY_FUTURE_LEAVE = 'b5000000-0000-4000-8000-000000000011';
const HISTORY_DUPLICATE_LEAVE_A = 'b5000000-0000-4000-8000-000000000012';
const HISTORY_DUPLICATE_LEAVE_B = 'b5000000-0000-4000-8000-000000000013';
const HISTORY_INACTIVE_PENDING_LEAVE = 'b5000000-0000-4000-8000-000000000014';
const HISTORY_INACTIVE_APPROVED_LEAVE = 'b5000000-0000-4000-8000-000000000015';
const ASSIGNMENT_FIRST_LEAVE = 'b5000000-0000-4000-8000-000000000020';
const ASSIGNMENT_FIRST_SHIFT = 'b4000000-0000-4000-8000-000000000020';
const APPROVAL_FIRST_LEAVE = 'b5000000-0000-4000-8000-000000000021';
const APPROVAL_FIRST_OVERRIDE_SHIFT = 'b4000000-0000-4000-8000-000000000021';
const ARCHIVE_PENDING_LEAVE = 'b5000000-0000-4000-8000-000000000022';
const LATE_APPROVAL_LEAVE = 'b5000000-0000-4000-8000-000000000023';
const LATE_APPROVAL_SHIFT = 'b4000000-0000-4000-8000-000000000022';
const ATOMIC_FILL_FIRST_SHIFT = 'b4000000-0000-4000-8000-000000000023';

let pg: PGlite;
let managerAccountId: string;
let employeeAccountId: string;
let routeUserId: string | null = EMPLOYEE_USER;

const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);
const originalRpc = supabaseAdmin.rpc.bind(supabaseAdmin);
const originalGetUser = supabaseAdmin.auth.getUser.bind(supabaseAdmin.auth);

async function asUser(
  userId: string,
  sql: string,
  params: unknown[] = [],
): Promise<Array<Record<string, unknown>>> {
  await pg.exec('begin');
  try {
    await pg.exec('set local role authenticated');
    await pg.query(`select set_config('request.jwt.claim.sub', $1, true)`, [userId]);
    await pg.query(`select set_config('request.jwt.claim.role', 'authenticated', true)`);
    await pg.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({
      sub: userId,
      role: 'authenticated',
      mfa_verified: true,
    })]);
    const result = await pg.query(sql, params) as { rows: Array<Record<string, unknown>> };
    await pg.exec('commit');
    return result.rows;
  } catch (error) {
    await pg.exec('rollback').catch(() => undefined);
    throw error;
  }
}

async function asService(
  sql: string,
  params: unknown[] = [],
): Promise<Array<Record<string, unknown>>> {
  await pg.exec('begin');
  try {
    await pg.exec('set local role service_role');
    await pg.query(`select set_config('request.jwt.claim.role', 'service_role', true)`);
    const result = await pg.query(sql, params) as { rows: Array<Record<string, unknown>> };
    await pg.exec('commit');
    return result.rows;
  } catch (error) {
    await pg.exec('rollback').catch(() => undefined);
    throw error;
  }
}

describe('staff schedule authority and history migration 0412', () => {
  before(async () => {
    const migrated = await applyMigrationsToPgliteWithHook(async ({ pg: hookPg, file }) => {
      if (file === '0412_staff_schedule_authority_and_history.sql') {
        await hookPg.exec(`
          grant select on public.scheduled_shifts to authenticated;
          grant select on public.time_off_requests to authenticated;
        `);
        await hookPg.query(
          `insert into auth.users(id,email) values ($1,'schedule-history@example.test')
           on conflict (id) do nothing`,
          [HISTORY_USER],
        );
        await hookPg.query(
          `insert into public.properties(id,owner_id,name,total_rooms,timezone,enabled_sections)
           values ($1,$2,'Schedule History Hotel',10,'Pacific/Kiritimati','{}'::jsonb)`,
          [HISTORY_PROPERTY, HISTORY_USER],
        );
        await hookPg.query(
          `insert into public.staff(id,property_id,name,language,department,is_active)
           values
             ($1,$3,'History Person','en','housekeeping',true),
             ($2,$3,'Pre-migration Inactive Person','en','maintenance',false)`,
          [HISTORY_STAFF, HISTORY_INACTIVE_STAFF, HISTORY_PROPERTY],
        );
        await hookPg.query(
          `insert into public.accounts(
             id,username,display_name,role,property_access,data_user_id,active,staff_id
           ) values (
             $1,'schedule-history-inactive','Inactive History Person','staff',
             array[$2]::uuid[],$3,true,$4
           )`,
          [HISTORY_INACTIVE_ACCOUNT, HISTORY_PROPERTY, HISTORY_USER, HISTORY_INACTIVE_STAFF],
        );
        await hookPg.query(
          `insert into public.time_off_requests(
           id,property_id,staff_id,request_date,reason,status
           ) values
             ($1,$3,$4,'2020-01-01','Historical leave','approved'),
             ($2,$3,$4,'2099-01-01','Future leave','approved'),
             ($5,$3,$4,'2098-01-01','Duplicate A','pending'),
             ($6,$3,$4,'2098-01-01','Duplicate B','pending'),
             ($7,$3,$8,'2099-03-01','Inactive pending request','pending'),
             ($9,$3,$8,'2099-02-01','Inactive approved overlap','approved')`,
          [
            HISTORY_PAST_LEAVE,
            HISTORY_FUTURE_LEAVE,
            HISTORY_PROPERTY,
            HISTORY_STAFF,
            HISTORY_DUPLICATE_LEAVE_A,
            HISTORY_DUPLICATE_LEAVE_B,
            HISTORY_INACTIVE_PENDING_LEAVE,
            HISTORY_INACTIVE_STAFF,
            HISTORY_INACTIVE_APPROVED_LEAVE,
          ],
        );
        await hookPg.query(
          `insert into public.scheduled_shifts(
             id,property_id,staff_id,department,shift_date,start_time,end_time,kind,status
           ) values
             ($1,$3,$4,'housekeeping','2020-01-01','08:00','16:00','shift','published'),
             ($2,$3,$4,'housekeeping','2099-01-01','08:00','16:00','shift','published'),
             ($5,$3,$6,'maintenance','2099-02-01','08:00','16:00','shift','confirmed')`,
          [
            HISTORY_PAST_SHIFT,
            HISTORY_FUTURE_SHIFT,
            HISTORY_PROPERTY,
            HISTORY_STAFF,
            HISTORY_INACTIVE_FUTURE_SHIFT,
            HISTORY_INACTIVE_STAFF,
          ],
        );
        await hookPg.query(
          `insert into public.shift_confirmations(
             token,property_id,staff_id,staff_name,staff_phone,shift_date,status,language
           ) values (
             'history-inactive-future-confirmation',$1,$2,'Inactive History Person',
             '+15555550199','2099-02-01','sent','en'
           )`,
          [HISTORY_PROPERTY, HISTORY_INACTIVE_STAFF],
        );
      }
    }, { stopAfterVersion: '0425' });
    pg = migrated.pg;
    assert.ok(
      migrated.report.applied.includes('0412_staff_schedule_authority_and_history.sql'),
      `0412 must apply in PGlite: ${JSON.stringify(
        migrated.report.failedAtRuntime.filter(entry => entry.file.startsWith('0412')),
      )}`,
    );

    await pg.query(
      `insert into auth.users(id,email) values
         ($1,'schedule-manager@example.test'),
         ($2,'schedule-employee@example.test'),
         ($3,'schedule-unlinked@example.test'),
         ($4,'schedule-archive@example.test'),
         ($5,'schedule-legacy-pointer@example.test')
       on conflict (id) do nothing`,
      [MANAGER_USER, EMPLOYEE_USER, UNLINKED_USER, ARCHIVE_USER, LEGACY_POINTER_USER],
    );
    await pg.query(
      `insert into public.properties(id,owner_id,name,total_rooms,timezone,enabled_sections)
       values ($1,$2,'Schedule Authority Hotel',50,'UTC','{}'::jsonb)`,
      [PROPERTY, MANAGER_USER],
    );
    await pg.query(
      `insert into public.staff(id,property_id,name,language,department,is_active) values
         ($1,$4,'Linked Employee','en','housekeeping',true),
         ($2,$4,'Coworker','en','housekeeping',true),
         ($3,$4,'Archive Person','en','maintenance',true)`,
      [EMPLOYEE_STAFF, COWORKER_STAFF, ARCHIVED_STAFF, PROPERTY],
    );
    const accounts = await pg.query<{ id: string; username: string }>(
      `insert into public.accounts(
         username,display_name,role,property_access,data_user_id,active
       ) values
         ('schedule-authority-manager','Schedule Manager','general_manager',array[$1]::uuid[],$2,true),
         ('schedule-authority-employee','Schedule Employee','staff',array[$1]::uuid[],$3,true),
         ('schedule-authority-unlinked','Schedule Unlinked','staff',array[$1]::uuid[],$4,true)
       returning id,username`,
      [PROPERTY, MANAGER_USER, EMPLOYEE_USER, UNLINKED_USER],
    );
    managerAccountId = accounts.rows.find(row => row.username === 'schedule-authority-manager')!.id;
    employeeAccountId = accounts.rows.find(row => row.username === 'schedule-authority-employee')!.id;

    await pg.query(
      `insert into public.account_property_staff_links(
         account_id,property_id,staff_id,is_active,source,linked_by_account_id
       ) values ($1,$2,$3,true,'manual',$4)`,
      [employeeAccountId, PROPERTY, EMPLOYEE_STAFF, managerAccountId],
    );
    await pg.query(
      `insert into public.scheduled_shifts(
         id,property_id,staff_id,department,shift_date,start_time,end_time,kind,status
       ) values
         ($1,$8,$6,'housekeeping','2026-08-02','08:00','16:00','shift','published'),
         ($2,$8,$6,'housekeeping','2026-08-03','08:00','16:00','shift','draft'),
         ($3,$8,$7,'housekeeping','2026-08-02','09:00','17:00','shift','published'),
         ($4,$8,null,'housekeeping','2026-08-04','10:00','18:00','open','published'),
         ($5,$8,null,'maintenance','2026-08-04','10:00','18:00','open','published')`,
      [
        OWN_SHIFT, OWN_DRAFT, COWORKER_SHIFT, OPEN_OWN_DEPT, OPEN_OTHER_DEPT,
        EMPLOYEE_STAFF, COWORKER_STAFF, PROPERTY,
      ],
    );
    await pg.query(
      `insert into public.time_off_requests(
         id,property_id,staff_id,request_date,reason,status
       ) values
         ($1,$5,$3,'2026-08-05','Appointment','pending'),
         ($2,$5,$4,'2026-08-05','Personal','pending')`,
      [OWN_TIME_OFF, COWORKER_TIME_OFF, EMPLOYEE_STAFF, COWORKER_STAFF, PROPERTY],
    );

    const catalog = await loadCatalog(pg);
    const shim = createPglitePostgrest(pg, catalog);
    // @ts-expect-error install the PGlite-backed service client for real routes
    supabaseAdmin.from = shim.from;
    // @ts-expect-error install the PGlite-backed RPC client for real routes
    supabaseAdmin.rpc = shim.rpc;
    supabaseAdmin.auth.getUser = (async () => routeUserId
      ? {
          data: { user: { id: routeUserId, email: `${routeUserId}@schedule.test` } },
          error: null,
        }
      : {
          data: { user: null },
          error: { message: 'invalid token', status: 401, name: 'AuthApiError' },
        }) as unknown as typeof supabaseAdmin.auth.getUser;
  });

  after(async () => {
    supabaseAdmin.from = originalFrom;
    supabaseAdmin.rpc = originalRpc;
    supabaseAdmin.auth.getUser = originalGetUser;
    await pg.close();
  });

  test('line-role accounts are denied every manager scheduling API mutation', async () => {
    routeUserId = EMPLOYEE_USER;
    const request = (
      path: string,
      method: 'POST' | 'PUT' | 'DELETE',
      body?: Record<string, unknown>,
    ) => new NextRequest(`https://staxis.test${path}`, {
      method,
      headers: {
        authorization: 'Bearer line-role-schedule-test',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

    const attempts: Array<{ label: string; run: () => Promise<Response | undefined> }> = [
      {
        label: 'fill schedule',
        run: () => fillSchedule(request('/api/staff-schedule/fill', 'POST', {
          hotelId: PROPERTY,
          days: [{ date: '2026-08-09', shifts: [] }],
        })),
      },
      {
        label: 'write shift',
        run: () => writeShift(request('/api/staff-schedule/shifts', 'POST', {
          hotelId: PROPERTY,
          shift: {
            staffId: EMPLOYEE_STAFF,
            department: 'housekeeping',
            shiftDate: '2026-08-09',
            startTime: '08:00',
            endTime: '16:00',
          },
        })),
      },
      {
        label: 'delete shift',
        run: () => deleteShift(request(
          `/api/staff-schedule/shifts?hotelId=${PROPERTY}&id=${OWN_SHIFT}`,
          'DELETE',
        )),
      },
      {
        label: 'create template',
        run: () => createTemplate(request('/api/staff-schedule/templates', 'POST', {
          hotelId: PROPERTY,
          scope: 'day',
          name: 'Line role attempt',
          payload: [],
        })),
      },
      {
        label: 'delete template',
        run: () => deleteTemplate(request(
          `/api/staff-schedule/templates?hotelId=${PROPERTY}&id=${OWN_SHIFT}`,
          'DELETE',
        )),
      },
      {
        label: 'week sign-off',
        run: () => setWeekDone(request('/api/staff-schedule/week-done', 'POST', {
          hotelId: PROPERTY,
          weekStart: '2026-08-09',
          done: true,
        })),
      },
      {
        label: 'replace presets',
        run: () => replacePresets(request('/api/staff-schedule/presets', 'PUT', {
          hotelId: PROPERTY,
          presets: [],
        })),
      },
      {
        label: 'decide time off',
        run: () => decideTimeOff(request('/api/staff-schedule/time-off', 'PUT', {
          hotelId: PROPERTY,
          id: OWN_TIME_OFF,
          decision: 'approve',
        })),
      },
    ];

    for (const attempt of attempts) {
      const response = await attempt.run();
      assert.ok(response, `${attempt.label} must return an HTTP response`);
      assert.equal(response.status, 403, `${attempt.label} must reject a housekeeping role`);
    }

    const untouched = await pg.query<{ status: string; shift_exists: boolean }>(
      `select request.status,
              exists(select 1 from public.scheduled_shifts where id=$2) as shift_exists
       from public.time_off_requests request where request.id=$1`,
      [OWN_TIME_OFF, OWN_SHIFT],
    );
    assert.deepEqual(untouched.rows, [{ status: 'pending', shift_exists: true }]);
  });

  test('employees see only their visible shifts, same-department open work, and own leave', async () => {
    const employeeShifts = await asUser(
      EMPLOYEE_USER,
      `select id::text as id from public.scheduled_shifts order by id`,
    );
    assert.deepEqual(employeeShifts.map(row => row.id), [OWN_SHIFT, OPEN_OWN_DEPT]);

    const employeeTimeOff = await asUser(
      EMPLOYEE_USER,
      `select id::text as id from public.time_off_requests order by id`,
    );
    assert.deepEqual(employeeTimeOff.map(row => row.id), [OWN_TIME_OFF]);

    assert.equal((await asUser(UNLINKED_USER, `select id from public.scheduled_shifts`)).length, 0);
    assert.equal((await asUser(UNLINKED_USER, `select id from public.time_off_requests`)).length, 0);
  });

  test('migration repairs only live leave conflicts and preserves historical assignments', async () => {
    const rows = await pg.query<{ past_exists: boolean; future_exists: boolean }>(
      `select exists(select 1 from public.scheduled_shifts where id=$1) as past_exists,
              exists(select 1 from public.scheduled_shifts where id=$2) as future_exists`,
      [HISTORY_PAST_SHIFT, HISTORY_FUTURE_SHIFT],
    );
    assert.deepEqual(rows.rows, [{ past_exists: true, future_exists: false }]);

    const inactiveRepair = await pg.query<{
      staff_id: string | null;
      kind: string;
      status: string;
      history: string;
      request_status: string;
      confirmation_exists: boolean;
      link_active: boolean;
      legacy_staff_id: string | null;
    }>(
      `select shift_row.staff_id::text,
              shift_row.kind,
              shift_row.status,
              shift_row.filled_by_history::text as history,
              request_row.status as request_status,
              exists(
                select 1 from public.shift_confirmations
                where token='history-inactive-future-confirmation'
              ) as confirmation_exists,
              staff_link.is_active as link_active,
              account.staff_id::text as legacy_staff_id
       from public.scheduled_shifts shift_row
       join public.time_off_requests request_row
         on request_row.id=$2
       join public.account_property_staff_links staff_link
         on staff_link.account_id=$3 and staff_link.property_id=$4
       join public.accounts account on account.id=staff_link.account_id
       where shift_row.id=$1`,
      [
        HISTORY_INACTIVE_FUTURE_SHIFT,
        HISTORY_INACTIVE_PENDING_LEAVE,
        HISTORY_INACTIVE_ACCOUNT,
        HISTORY_PROPERTY,
      ],
    );
    assert.deepEqual(inactiveRepair.rows, [{
      staff_id: null,
      kind: 'open',
      status: 'published',
      history: `["${HISTORY_INACTIVE_STAFF}"]`,
      request_status: 'cancelled',
      confirmation_exists: false,
      link_active: false,
      legacy_staff_id: null,
    }]);
  });

  test('migration preserves duplicate request history and enforces one live request per day', async () => {
    const migratedDuplicates = await pg.query<{ status: string }>(
      `select status
       from public.time_off_requests
       where id = any($1::uuid[])
       order by status`,
      [[HISTORY_DUPLICATE_LEAVE_A, HISTORY_DUPLICATE_LEAVE_B]],
    );
    assert.deepEqual(migratedDuplicates.rows, [
      { status: 'cancelled' },
      { status: 'pending' },
    ]);

    await assert.rejects(
      () => pg.query(
        `insert into public.time_off_requests(
           property_id,staff_id,request_date,reason,status
         ) values ($1,$2,'2098-01-01','Concurrent retry','pending')`,
        [HISTORY_PROPERTY, HISTORY_STAFF],
      ),
      /time_off_requests_one_live_per_staff_date|duplicate key/i,
    );
  });

  test('authorized managers retain the complete planning and leave view', async () => {
    const shifts = await asUser(MANAGER_USER, `select id from public.scheduled_shifts`);
    const leave = await asUser(MANAGER_USER, `select id from public.time_off_requests`);
    assert.equal(shifts.length, 5);
    assert.equal(leave.length, 2);
  });

  test('time-off approval and conflicting shift deletion roll back together', async () => {
    await pg.query(
      `insert into public.time_off_requests(
         id,property_id,staff_id,request_date,reason,status
       ) values ($1,$2,$3,'2090-08-06','Family','pending')`,
      [ATOMIC_TIME_OFF, PROPERTY, EMPLOYEE_STAFF],
    );
    await pg.query(
      `insert into public.scheduled_shifts(
         id,property_id,staff_id,department,shift_date,start_time,end_time,kind,status
       ) values ($1,$2,$3,'housekeeping','2090-08-06','08:00','16:00','shift','published')`,
      [ATOMIC_SHIFT, PROPERTY, EMPLOYEE_STAFF],
    );
    await pg.exec(`
      create or replace function public.test_block_atomic_shift_delete()
      returns trigger language plpgsql as $$
      begin
        if old.id = '${ATOMIC_SHIFT}'::uuid then raise exception 'blocked delete'; end if;
        return old;
      end;
      $$;
      create trigger test_block_atomic_shift_delete
        before delete on public.scheduled_shifts
        for each row execute function public.test_block_atomic_shift_delete();
    `);

    await assert.rejects(
      () => asService(
        `select public.staxis_apply_time_off_decision($1,$2,'approve',null,$3)`,
        [PROPERTY, ATOMIC_TIME_OFF, managerAccountId],
      ),
      /blocked delete/,
    );
    const afterFailure = await pg.query<{ status: string; shift_exists: boolean }>(
      `select request.status,
              exists(select 1 from public.scheduled_shifts where id=$2) as shift_exists
       from public.time_off_requests request where request.id=$1`,
      [ATOMIC_TIME_OFF, ATOMIC_SHIFT],
    );
    assert.equal(afterFailure.rows[0].status, 'pending');
    assert.equal(afterFailure.rows[0].shift_exists, true);

    await pg.exec(`drop trigger test_block_atomic_shift_delete on public.scheduled_shifts;`);
    const decision = await asService(
      `select (result->>'ok')::boolean as ok,
              (result->>'removedShift')::boolean as removed
       from (select public.staxis_apply_time_off_decision($1,$2,'approve',null,$3) result) applied`,
      [PROPERTY, ATOMIC_TIME_OFF, managerAccountId],
    );
    assert.deepEqual(decision, [{ ok: true, removed: true }]);
    const afterSuccess = await pg.query<{ status: string; shift_exists: boolean }>(
      `select request.status,
              exists(select 1 from public.scheduled_shifts where id=$2) as shift_exists
       from public.time_off_requests request where request.id=$1`,
      [ATOMIC_TIME_OFF, ATOMIC_SHIFT],
    );
    assert.equal(afterSuccess.rows[0].status, 'approved');
    assert.equal(afterSuccess.rows[0].shift_exists, false);
  });

  test('late approval cannot erase historical schedule attribution', async () => {
    await pg.query(
      `insert into public.time_off_requests(
         id,property_id,staff_id,request_date,reason,status
       ) values ($1,$2,$3,'2020-01-02','Late approval','pending')`,
      [LATE_APPROVAL_LEAVE, PROPERTY, EMPLOYEE_STAFF],
    );
    await pg.query(
      `insert into public.scheduled_shifts(
         id,property_id,staff_id,department,shift_date,start_time,end_time,kind,status
       ) values ($1,$2,$3,'housekeeping','2020-01-02','08:00','16:00','shift','published')`,
      [LATE_APPROVAL_SHIFT, PROPERTY, EMPLOYEE_STAFF],
    );

    const decision = await asService(
      `select result->>'reason' as reason
       from (select public.staxis_apply_time_off_decision($1,$2,'approve',null,$3) result) applied`,
      [PROPERTY, LATE_APPROVAL_LEAVE, managerAccountId],
    );
    assert.deepEqual(decision, [{ reason: 'past_date' }]);
    const preserved = await pg.query<{ status: string; shift_exists: boolean }>(
      `select request.status,
              exists(select 1 from public.scheduled_shifts where id=$2) as shift_exists
       from public.time_off_requests request where request.id=$1`,
      [LATE_APPROVAL_LEAVE, LATE_APPROVAL_SHIFT],
    );
    assert.deepEqual(preserved.rows, [{ status: 'pending', shift_exists: true }]);
  });

  test('assignment and approval serialize correctly in both commit orderings', async () => {
    await pg.query(
      `insert into public.time_off_requests(
         id,property_id,staff_id,request_date,reason,status
       ) values ($1,$2,$3,'2090-01-10','Assignment first','pending')`,
      [ASSIGNMENT_FIRST_LEAVE, PROPERTY, EMPLOYEE_STAFF],
    );
    await pg.query(
      `insert into public.scheduled_shifts(
         id,property_id,staff_id,department,shift_date,start_time,end_time,kind,status,
         time_off_override
       ) values ($1,$2,$3,'housekeeping','2090-01-10','08:00','16:00','shift','published',false)`,
      [ASSIGNMENT_FIRST_SHIFT, PROPERTY, EMPLOYEE_STAFF],
    );
    await asService(
      `select public.staxis_apply_time_off_decision($1,$2,'approve',null,$3)`,
      [PROPERTY, ASSIGNMENT_FIRST_LEAVE, managerAccountId],
    );
    const assignmentFirst = await pg.query<{ shift_exists: boolean }>(
      `select exists(select 1 from public.scheduled_shifts where id=$1) as shift_exists`,
      [ASSIGNMENT_FIRST_SHIFT],
    );
    assert.deepEqual(assignmentFirst.rows, [{ shift_exists: false }]);

    await pg.query(
      `insert into public.time_off_requests(
         id,property_id,staff_id,request_date,reason,status
       ) values ($1,$2,$3,'2090-01-11','Approval first','pending')`,
      [APPROVAL_FIRST_LEAVE, PROPERTY, EMPLOYEE_STAFF],
    );
    await asService(
      `select public.staxis_apply_time_off_decision($1,$2,'approve',null,$3)`,
      [PROPERTY, APPROVAL_FIRST_LEAVE, managerAccountId],
    );

    await assert.rejects(
      () => pg.query(
        `insert into public.scheduled_shifts(
           property_id,staff_id,department,shift_date,start_time,end_time,kind,status,
           time_off_override
         ) values ($1,$2,'housekeeping','2090-01-11','08:00','16:00','shift','published',false)`,
        [PROPERTY, EMPLOYEE_STAFF],
      ),
      /approved time off/i,
    );

    await pg.query(
      `insert into public.scheduled_shifts(
         id,property_id,staff_id,department,shift_date,start_time,end_time,kind,status,
         time_off_override
       ) values ($1,$2,$3,'housekeeping','2090-01-11','08:00','16:00','shift','published',true)`,
      [APPROVAL_FIRST_OVERRIDE_SHIFT, PROPERTY, EMPLOYEE_STAFF],
    );
    const override = await pg.query<{ time_off_override: boolean }>(
      `select time_off_override from public.scheduled_shifts where id=$1`,
      [APPROVAL_FIRST_OVERRIDE_SHIFT],
    );
    assert.deepEqual(override.rows, [{ time_off_override: true }]);
  });

  test('multi-day fill rolls back every day and publication when a later row fails', async () => {
    await pg.query(
      `insert into public.scheduled_shifts(
         id,property_id,staff_id,department,shift_date,start_time,end_time,kind,status,note
       ) values ($1,$2,$3,'housekeeping','2091-04-01','08:00','16:00','shift','published','Before')`,
      [ATOMIC_FILL_FIRST_SHIFT, PROPERTY, COWORKER_STAFF],
    );
    await pg.exec(`
      create or replace function public.test_fail_second_fill_day()
      returns trigger language plpgsql as $$
      begin
        if new.shift_date = '2091-04-02'::date then
          raise exception 'forced atomic fill failure';
        end if;
        return new;
      end;
      $$;
      create trigger test_fail_second_fill_day
        before insert on public.scheduled_shifts
        for each row execute function public.test_fail_second_fill_day();
    `);

    const request = () => new NextRequest(
      'https://staxis.test/api/staff-schedule/fill',
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer manager-atomic-fill-test',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          hotelId: PROPERTY,
          days: [
            {
              date: '2091-04-01',
              shifts: [{
                staffId: COWORKER_STAFF,
                department: 'housekeeping',
                startTime: '09:00',
                endTime: '17:00',
                note: 'After',
              }],
            },
            {
              date: '2091-04-02',
              shifts: [{
                staffId: EMPLOYEE_STAFF,
                department: 'housekeeping',
                startTime: '10:00',
                endTime: '18:00',
              }],
            },
          ],
        }),
      },
    );

    routeUserId = MANAGER_USER;
    try {
      const failed = await fillSchedule(request());
      assert.ok(failed);
      assert.equal(failed.status, 500);
    } finally {
      routeUserId = EMPLOYEE_USER;
      await pg.exec('drop trigger test_fail_second_fill_day on public.scheduled_shifts;');
      await pg.exec('drop function public.test_fail_second_fill_day();');
    }

    const rolledBack = await pg.query<{
      start_time: string;
      end_time: string;
      note: string;
      second_exists: boolean;
      publication_count: number;
    }>(
      `select shift_row.start_time::text,
              shift_row.end_time::text,
              shift_row.note,
              exists(
                select 1 from public.scheduled_shifts second_day
                where second_day.property_id=$2 and second_day.shift_date='2091-04-02'
                  and second_day.kind='shift'
              ) as second_exists,
              (
                select count(*)::int from public.week_publications publication
                where publication.property_id=$2
                  and publication.week_start = (
                    '2091-04-01'::date - extract(dow from '2091-04-01'::date)::int
                  )
              ) as publication_count
       from public.scheduled_shifts shift_row where shift_row.id=$1`,
      [ATOMIC_FILL_FIRST_SHIFT, PROPERTY],
    );
    assert.deepEqual(rolledBack.rows, [{
      start_time: '08:00:00',
      end_time: '16:00:00',
      note: 'Before',
      second_exists: false,
      publication_count: 0,
    }]);

    routeUserId = MANAGER_USER;
    try {
      const retry = await fillSchedule(request());
      assert.ok(retry);
      assert.equal(retry.status, 200);
    } finally {
      routeUserId = EMPLOYEE_USER;
    }
    const committed = await pg.query<{
      first_start: string;
      second_exists: boolean;
      publication_count: number;
    }>(
      `select (
                select start_time::text from public.scheduled_shifts where id=$1
              ) as first_start,
              exists(
                select 1 from public.scheduled_shifts second_day
                where second_day.property_id=$2 and second_day.shift_date='2091-04-02'
                  and second_day.staff_id=$3 and second_day.kind='shift'
              ) as second_exists,
              (
                select count(*)::int from public.week_publications publication
                where publication.property_id=$2
                  and publication.week_start = (
                    '2091-04-01'::date - extract(dow from '2091-04-01'::date)::int
                  )
              ) as publication_count`,
      [ATOMIC_FILL_FIRST_SHIFT, PROPERTY, EMPLOYEE_STAFF],
    );
    assert.deepEqual(committed.rows, [{
      first_start: '09:00:00',
      second_exists: true,
      publication_count: 1,
    }]);
  });

  test('browser roster writes cannot bypass the archive lifecycle boundary', async () => {
    await assert.rejects(
      () => asUser(
        MANAGER_USER,
        `insert into public.staff(property_id,name,language,department,is_active)
         values ($1,'Inactive Browser Insert','en','other',false)`,
        [PROPERTY],
      ),
      /row-level security/i,
    );
    await assert.rejects(
      () => asUser(
        MANAGER_USER,
        `update public.staff set is_active=false where id=$1 and property_id=$2`,
        [COWORKER_STAFF, PROPERTY],
      ),
      /row-level security/i,
    );
  });

  test('archive preserves past attribution and deactivates every identity pointer', async () => {
    const archiveAccount = await pg.query<{ id: string }>(
      `insert into public.accounts(
         username,display_name,role,property_access,data_user_id,active,staff_id
      ) values (
         'schedule-authority-archive','Archive Person','staff',array[$1]::uuid[],$3,true,$2
       ) returning id`,
      [PROPERTY, ARCHIVED_STAFF, ARCHIVE_USER],
    );
    const archiveAccountId = archiveAccount.rows[0].id;
    const legacyPointerAccount = await pg.query<{ id: string }>(
      `insert into public.accounts(
         username,display_name,role,property_access,data_user_id,active
       ) values (
         'schedule-authority-legacy-pointer','Legacy Pointer Without Bridge','staff',
         array[$1]::uuid[],$2,true
       ) returning id`,
      [PROPERTY, LEGACY_POINTER_USER],
    );
    // Reproduce a legacy pointer that predates the account/staff bridge. The
    // reconciliation trigger would otherwise manufacture a bridge and prevent
    // this historical state through the one-active-account invariant.
    await pg.exec('alter table public.accounts disable trigger trg_accounts_reconcile_legacy_organization_access');
    try {
      await pg.query(
        `update public.accounts set staff_id=$1 where id=$2`,
        [ARCHIVED_STAFF, legacyPointerAccount.rows[0].id],
      );
    } finally {
      await pg.exec('alter table public.accounts enable trigger trg_accounts_reconcile_legacy_organization_access');
    }
    await pg.query(
      `insert into public.account_property_staff_links(
         account_id,property_id,staff_id,is_active,source,linked_by_account_id
       ) values ($1,$2,$3,true,'manual',$4)
       on conflict (account_id,property_id) do update
         set staff_id=excluded.staff_id,is_active=true,source='manual',
             deactivated_at=null,deactivated_by_account_id=null`,
      [archiveAccountId, PROPERTY, ARCHIVED_STAFF, managerAccountId],
    );
    await pg.query(
      `insert into public.scheduled_shifts(
         id,property_id,staff_id,department,shift_date,start_time,end_time,kind,status
       ) values
         ($1,$5,$4,'maintenance',(clock_timestamp() at time zone 'UTC')::date - 1,'08:00','16:00','shift','published'),
         ($2,$5,$4,'maintenance',(clock_timestamp() at time zone 'UTC')::date,'08:00','16:00','shift','confirmed'),
         ($3,$5,$4,'maintenance',(clock_timestamp() at time zone 'UTC')::date + 1,'08:00','16:00','shift','published')`,
      [ARCHIVE_PAST, ARCHIVE_TODAY, ARCHIVE_FUTURE, ARCHIVED_STAFF, PROPERTY],
    );
    await pg.query(
      `insert into public.time_off_requests(
         id,property_id,staff_id,request_date,reason,status
       ) values ($1,$2,$3,'2090-02-01','Pending before archive','pending')`,
      [ARCHIVE_PENDING_LEAVE, PROPERTY, ARCHIVED_STAFF],
    );

    const archived = await asService(
      `select (result->>'ok')::boolean as ok,
              (result->>'openedShifts')::int as opened,
              (result->>'deactivatedLinks')::int as links,
              (result->>'cancelledTimeOffRequests')::int as cancelled_leave,
              (result->>'clearedLegacyLinks')::int as cleared_legacy
       from (select public.staxis_archive_staff_member($1,$2,$3) result) applied`,
      [PROPERTY, ARCHIVED_STAFF, managerAccountId],
    );
    assert.deepEqual(archived, [{
      ok: true,
      opened: 2,
      links: 1,
      cancelled_leave: 1,
      cleared_legacy: 2,
    }]);

    const shifts = await pg.query<{
      id: string;
      staff_id: string | null;
      kind: string;
      history: string;
    }>(
      `select id::text as id,staff_id::text,kind,filled_by_history::text as history
       from public.scheduled_shifts
       where id = any($1::uuid[])
       order by id`,
      [[ARCHIVE_PAST, ARCHIVE_TODAY, ARCHIVE_FUTURE]],
    );
    assert.deepEqual(shifts.rows, [
      { id: ARCHIVE_PAST, staff_id: ARCHIVED_STAFF, kind: 'shift', history: '[]' },
      { id: ARCHIVE_TODAY, staff_id: null, kind: 'open', history: `["${ARCHIVED_STAFF}"]` },
      { id: ARCHIVE_FUTURE, staff_id: null, kind: 'open', history: `["${ARCHIVED_STAFF}"]` },
    ]);

    const identity = await pg.query<{
      staff_active: boolean;
      link_active: boolean;
      deactivated_at: string | null;
      legacy_staff_id: string | null;
    }>(
      `select staff_row.is_active as staff_active,
              staff_link.is_active as link_active,
              staff_link.deactivated_at::text,
              account.staff_id::text as legacy_staff_id
       from public.staff staff_row
       join public.account_property_staff_links staff_link
         on staff_link.staff_id=staff_row.id and staff_link.property_id=staff_row.property_id
       join public.accounts account on account.id=staff_link.account_id
       where staff_row.id=$1 and staff_row.property_id=$2`,
      [ARCHIVED_STAFF, PROPERTY],
    );
    assert.equal(identity.rows[0].staff_active, false);
    assert.equal(identity.rows[0].link_active, false);
    assert.ok(identity.rows[0].deactivated_at);
    assert.equal(identity.rows[0].legacy_staff_id, null);

    const cleanup = await pg.query<{
      remaining_legacy_pointers: number;
      request_status: string;
    }>(
      `select (
                select count(*)::int from public.accounts where staff_id=$1
              ) as remaining_legacy_pointers,
              request_row.status as request_status
       from public.time_off_requests request_row
       where request_row.id=$2`,
      [ARCHIVED_STAFF, ARCHIVE_PENDING_LEAVE],
    );
    assert.deepEqual(cleanup.rows, [{
      remaining_legacy_pointers: 0,
      request_status: 'cancelled',
    }]);

    await assert.rejects(
      () => pg.query(`delete from public.scheduled_shifts where id=$1`, [ARCHIVE_PAST]),
      /archived historical shift/i,
    );

    const pastDate = (await pg.query<{ shift_date: string }>(
      `select shift_date::text from public.scheduled_shifts where id=$1`,
      [ARCHIVE_PAST],
    )).rows[0].shift_date;
    routeUserId = MANAGER_USER;
    const fillResponse = await fillSchedule(new NextRequest(
      'https://staxis.test/api/staff-schedule/fill',
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer manager-schedule-history-test',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          hotelId: PROPERTY,
          days: [{ date: pastDate, shifts: [] }],
        }),
      },
    ));
    routeUserId = EMPLOYEE_USER;
    assert.ok(fillResponse);
    assert.equal(fillResponse.status, 200);
    assert.equal(
      (await pg.query<{ exists: boolean }>(
        `select exists(select 1 from public.scheduled_shifts where id=$1) as exists`,
        [ARCHIVE_PAST],
      )).rows[0].exists,
      true,
    );

    await assert.rejects(
      () => pg.query(
        `insert into public.scheduled_shifts(
           property_id,staff_id,department,shift_date,start_time,end_time,kind,status
         ) values ($1,$2,'maintenance','2090-03-01','08:00','16:00','shift','published')`,
        [PROPERTY, ARCHIVED_STAFF],
      ),
      /inactive staff member/i,
    );
    await assert.rejects(
      () => pg.query(
        `insert into public.time_off_requests(
           property_id,staff_id,request_date,reason,status
         ) values ($1,$2,'2090-03-01','After archive','pending')`,
        [PROPERTY, ARCHIVED_STAFF],
      ),
      /inactive staff member/i,
    );

    const reactivation = await asUser(
      MANAGER_USER,
      `update public.staff set is_active=true
       where id=$1 and property_id=$2
       returning id`,
      [ARCHIVED_STAFF, PROPERTY],
    );
    assert.deepEqual(reactivation, []);
  });

  // ── Staff self-cancel of a pending time-off request ────────────────────
  // The employee-facing half of the request loop: submitting a wrong date
  // used to be permanent, and the duplicate guard then blocked ever asking
  // for that date again.

  /** N days from now in the property's timezone (fixtures must not go stale). */
  const daysFromNowUtc = (days: number) =>
    new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

  const jsonRequest = (
    path: string,
    method: 'POST' | 'PUT' | 'DELETE',
    body?: Record<string, unknown>,
  ) => new NextRequest(`https://staxis.test${path}`, {
    method,
    headers: {
      authorization: 'Bearer schedule-self-service-test',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  const statusOf = async (id: string) => {
    const rows = await pg.query<{ status: string; decided_by: string | null }>(
      `select status, decided_by::text from public.time_off_requests where id = $1::uuid`,
      [id],
    );
    return rows.rows[0] ?? null;
  };

  test('an employee can take back only their own still-pending time-off request', async () => {
    routeUserId = EMPLOYEE_USER;
    const requestDate = daysFromNowUtc(30);

    const submitted = await submitTimeOff(jsonRequest('/api/staff-schedule/time-off', 'POST', {
      hotelId: PROPERTY,
      requestDate,
      reason: 'Wrong date on purpose',
    }));
    assert.equal(submitted.status, 200);
    const submittedBody = await submitted.json() as { data: { request: { id: string } } };
    const ownRequestId = submittedBody.data.request.id;
    assert.deepEqual(await statusOf(ownRequestId), { status: 'pending', decided_by: null });

    // Someone else's request is untouchable even with a valid row id.
    const foreign = await cancelTimeOff(jsonRequest(
      `/api/staff-schedule/time-off?hotelId=${PROPERTY}&id=${COWORKER_TIME_OFF}`,
      'DELETE',
    ));
    assert.equal(foreign.status, 403);
    assert.deepEqual(await statusOf(COWORKER_TIME_OFF), { status: 'pending', decided_by: null });

    // Own pending request cancels, and nobody is recorded as having decided it.
    const cancelled = await cancelTimeOff(jsonRequest(
      `/api/staff-schedule/time-off?hotelId=${PROPERTY}&id=${ownRequestId}`,
      'DELETE',
    ));
    assert.equal(cancelled.status, 200);
    assert.deepEqual(await statusOf(ownRequestId), { status: 'cancelled', decided_by: null });

    // Cancelling twice is a conflict, not a silent success.
    const again = await cancelTimeOff(jsonRequest(
      `/api/staff-schedule/time-off?hotelId=${PROPERTY}&id=${ownRequestId}`,
      'DELETE',
    ));
    assert.equal(again.status, 409);

    // The whole point: the date is free again. Both the route's duplicate
    // guard and the partial unique index only count pending/approved rows.
    const resubmitted = await submitTimeOff(jsonRequest('/api/staff-schedule/time-off', 'POST', {
      hotelId: PROPERTY,
      requestDate,
      reason: 'Right date this time',
    }));
    assert.equal(resubmitted.status, 200);
    const resubmittedBody = await resubmitted.json() as { data: { request: { id: string } } };
    assert.notEqual(resubmittedBody.data.request.id, ownRequestId);

    // And a second live request for that date is still refused.
    const duplicate = await submitTimeOff(jsonRequest('/api/staff-schedule/time-off', 'POST', {
      hotelId: PROPERTY,
      requestDate,
      reason: 'Third attempt',
    }));
    assert.equal(duplicate.status, 409);

    await pg.query(
      `delete from public.time_off_requests where staff_id = $1::uuid and request_date = $2::date`,
      [EMPLOYEE_STAFF, requestDate],
    );
  });

  test('a decided request can no longer be taken back by the employee', async () => {
    const requestDate = daysFromNowUtc(45);
    routeUserId = EMPLOYEE_USER;
    const submitted = await submitTimeOff(jsonRequest('/api/staff-schedule/time-off', 'POST', {
      hotelId: PROPERTY,
      requestDate,
    }));
    assert.equal(submitted.status, 200);
    const requestId = (await submitted.json() as { data: { request: { id: string } } }).data.request.id;

    routeUserId = MANAGER_USER;
    const decided = await decideTimeOff(jsonRequest('/api/staff-schedule/time-off', 'PUT', {
      hotelId: PROPERTY,
      id: requestId,
      decision: 'approve',
    }));
    assert.equal(decided.status, 200);

    routeUserId = EMPLOYEE_USER;
    const tooLate = await cancelTimeOff(jsonRequest(
      `/api/staff-schedule/time-off?hotelId=${PROPERTY}&id=${requestId}`,
      'DELETE',
    ));
    assert.equal(tooLate.status, 409);
    assert.equal((await statusOf(requestId))?.status, 'approved');

    await pg.query(
      `delete from public.time_off_requests where id = $1::uuid`,
      [requestId],
    );
  });

  // ── Manager-created open shifts ────────────────────────────────────────
  // Nothing in the UI could create one before; the archive RPC was the only
  // runtime producer. An open shift staff cannot see is not coverage.

  test('a manager-posted open shift lands published, unstaffed, and visible to its department', async () => {
    const shiftDate = daysFromNowUtc(21);
    routeUserId = MANAGER_USER;

    const created = await writeShift(jsonRequest('/api/staff-schedule/shifts', 'POST', {
      hotelId: PROPERTY,
      shift: {
        department: 'housekeeping',
        shiftDate,
        startTime: '10:00',
        endTime: '18:00',
        kind: 'open',
        staffId: null,
        note: 'Extra coverage for the tour group',
      },
    }));
    assert.equal(created.status, 200);
    const createdBody = await created.json() as {
      data: { shift: { id: string; staffId: string | null; kind: string; status: string } };
    };
    const openId = createdBody.data.shift.id;
    assert.equal(createdBody.data.shift.staffId, null);
    assert.equal(createdBody.data.shift.kind, 'open');
    assert.equal(createdBody.data.shift.status, 'published');

    // Published matters: the browser RLS row filter hides anything else from
    // staff, so a draft open shift would be a hole nobody could fill.
    const employeeView = await asUser(
      EMPLOYEE_USER,
      `select id::text as id from public.scheduled_shifts
       where property_id = $1::uuid and shift_date = $2::date`,
      [PROPERTY, shiftDate],
    );
    assert.deepEqual(employeeView.map(row => row.id), [openId]);

    // Editing an open slot keeps it open and unstaffed.
    routeUserId = MANAGER_USER;
    const edited = await writeShift(jsonRequest('/api/staff-schedule/shifts', 'POST', {
      hotelId: PROPERTY,
      shift: {
        id: openId,
        department: 'housekeeping',
        shiftDate,
        startTime: '11:00',
        endTime: '19:00',
        kind: 'open',
        staffId: null,
        note: null,
      },
    }));
    assert.equal(edited.status, 200);
    const editedRow = await pg.query<{ staff_id: string | null; kind: string; status: string; start_time: string }>(
      `select staff_id::text, kind, status, start_time::text
       from public.scheduled_shifts where id = $1::uuid`,
      [openId],
    );
    assert.deepEqual(editedRow.rows, [{
      staff_id: null, kind: 'open', status: 'published', start_time: '11:00:00',
    }]);

    // Retract removes the slot outright.
    const retracted = await deleteShift(jsonRequest(
      `/api/staff-schedule/shifts?hotelId=${PROPERTY}&id=${openId}`,
      'DELETE',
    ));
    assert.equal(retracted.status, 200);
    const gone = await pg.query(
      `select 1 from public.scheduled_shifts where id = $1::uuid`,
      [openId],
    );
    assert.equal(gone.rows.length, 0);
  });
});
