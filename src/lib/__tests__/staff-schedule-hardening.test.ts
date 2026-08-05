import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { scheduleRevisionStillOwned } from '@/lib/schedule/save-revision';
import { fromScheduledShiftRow } from '@/lib/db-mappers';
import { staffScheduleGuardConflict } from '@/lib/schedule/assignment-guards';
import { staffVisibleInWeekRoster } from '@/lib/schedule/week-roster-staff';
import type { StaffMember } from '@/types';

const source = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

describe('staff schedule hardening contracts', () => {
  test('every schedule mutation handler rechecks authoritative hotel write standing', () => {
    const expectedCalls: Record<string, number> = {
      'src/app/api/staff-schedule/fill/route.ts': 1,
      'src/app/api/staff-schedule/pickup/route.ts': 1,
      'src/app/api/staff-schedule/presets/route.ts': 1,
      'src/app/api/staff-schedule/shifts/route.ts': 2,
      'src/app/api/staff-schedule/templates/route.ts': 2,
      'src/app/api/staff-schedule/time-off/route.ts': 2,
      'src/app/api/staff-schedule/week-done/route.ts': 1,
    };
    for (const [path, expected] of Object.entries(expectedCalls)) {
      const route = source(path);
      const calls = route.match(/await hotelWriteDecisionForUserId\(/g) ?? [];
      assert.equal(calls.length, expected, `${path} needs one fresh check per write handler`);
      assert.match(route, /commitDecision === 'unavailable'/, `${path} must fail closed on lookup failure`);
      assert.match(route, /commitDecision === 'denied'/, `${path} must reject lost hotel standing`);
    }
  });

  test('employee identity is property-scoped throughout My Shifts actions', () => {
    const identity = source('src/lib/schedule/staff-identity.ts');
    assert.match(identity, /account_property_staff_links/);
    assert.match(identity, /\.eq\('account_id', accountId\)/);
    assert.match(identity, /\.eq\('property_id', propertyId\)/);
    assert.match(identity, /\.eq\('is_active', true\)/);

    for (const path of [
      'src/app/api/staff-schedule/pickup/route.ts',
      'src/app/api/staff-schedule/time-off/route.ts',
    ]) {
      const route = source(path);
      assert.match(route, /activeStaffIdForAccountAtProperty\(account\.accountId, hotelId\)/);
      assert.doesNotMatch(route, /account\.staffId/);
    }

    const myShifts = source('src/app/staff/_components/MyShifts.tsx');
    const hook = source('src/app/staff/_components/useActiveStaffIdentity.ts');
    assert.match(myShifts, /useActiveStaffIdentity\(activePropertyId/);
    assert.doesNotMatch(myShifts, /user\?\.staffId/);
    assert.match(hook, /\/api\/staff-schedule\/me\?hotelId=/);
  });

  test('manager and employee calendars use property-local Sunday weeks', () => {
    const myShifts = source('src/app/staff/_components/MyShifts.tsx');
    const weekHook = source('src/app/staff/_components/useWeekShifts.ts');
    const managerHook = source('src/app/staff/_components/schedule/useScheduleData.ts');
    const managerSurface = source('src/app/staff/_components/schedule/index.tsx');
    const timeOffRoute = source('src/app/api/staff-schedule/time-off/route.ts');

    assert.match(myShifts, /propertyLocalToday\(new Date\(\), activeProperty\?\.timezone \?\? null\)/);
    assert.match(myShifts, /sundayOf\(today\)/);
    assert.match(weekHook, /DAY_KEYS[^=]*= \['sun','mon','tue','wed','thu','fri','sat'\]/);
    assert.match(managerSurface, /useScheduleData\(activePropertyId, staff, activeProperty\?\.timezone \?\? null\)/);
    assert.match(managerHook, /propertyLocalToday\(new Date\(\), timezone\)/);
    assert.match(timeOffRoute, /select\('timezone'\)/);
    assert.match(timeOffRoute, /propertyLocalToday\(new Date\(\), property\.timezone \?\? null\)/);
    assert.match(timeOffRoute, /addDaysInTz\(localToday, 730\)/);
  });

  test('time-off decisions and staff archive are database-atomic', () => {
    const helper = source('src/lib/schedule/decide-time-off.ts');
    const migration = source('supabase/migrations/0412_staff_schedule_authority_and_history.sql');
    const staffApi = source('src/app/api/staff/operational/route.ts');
    const employmentUi = source('src/app/(hotel)/company/_components/PersonEmploymentForm.tsx');
    const staffDb = source('src/lib/db/staff.ts');

    assert.match(helper, /rpc\('staxis_apply_time_off_decision'/);
    assert.doesNotMatch(helper, /\.from\('time_off_requests'\)|\.from\('scheduled_shifts'\)/);
    assert.match(migration, /select request_row\.\* into v_request[\s\S]*for update/);
    assert.match(migration, /delete from public\.scheduled_shifts/);
    assert.match(migration, /v_request\.request_date < v_today[\s\S]*'past_date'/);
    assert.match(source('src/app/api/staff-schedule/time-off/route.ts'), /case 'past_date':[\s\S]*status: 409/);
    assert.match(staffApi, /rpc\('staxis_archive_staff_member'/);
    assert.match(migration, /filled_by_history[\s\S]*jsonb_build_array\(v_staff\.id::text\)/);
    assert.match(migration, /update public\.account_property_staff_links[\s\S]*is_active = false/);
    assert.match(migration, /cancelledTimeOffRequests/);
    assert.match(staffApi, /cancelledTimeOffRequests/);
    assert.match(migration, /create policy staff_archive_instead_of_delete[\s\S]*using \(false\)/);
    assert.match(employmentUi, /Past schedule history is kept/);
    assert.doesNotMatch(employmentUi, /On the active roster/);
    assert.doesNotMatch(employmentUi, /isActive: draft\.isActive/);
    assert.doesNotMatch(employmentUi, /deleteStaffMember/);
    assert.doesNotMatch(staffDb, /from\('staff'\)[\s\S]*?\.delete\(\)/);
  });

  test('archived assignment history still hydrates as staff UUID strings', () => {
    const priorStaffId = 'b3000000-0000-4000-8000-000000000003';
    const shift = fromScheduledShiftRow({
      id: 'b4000000-0000-4000-8000-000000000009',
      property_id: 'b2000000-0000-4000-8000-000000000001',
      staff_id: null,
      department: 'maintenance',
      shift_date: '2026-08-01',
      start_time: '08:00:00',
      end_time: '16:00:00',
      kind: 'open',
      status: 'published',
      filled_by_history: [priorStaffId],
    });
    assert.deepEqual(shift.filledByHistory, [priorStaffId]);
    assert.notEqual(shift.filledByHistory[0], '[object Object]');
  });

  test('failed queued saves cannot clear a newer local edit revision', () => {
    assert.equal(scheduleRevisionStillOwned(4, 4), true);
    assert.equal(scheduleRevisionStillOwned(5, 4), false);

    const hook = source('src/app/staff/_components/schedule/useScheduleData.ts');
    assert.match(hook, /revisionByDate\.current\[date\].*\+ 1/);
    assert.match(hook, /clearOwnedOverrides\(dates, ownedRevisions\)/);
    assert.doesNotMatch(hook, /clearOverrides\(dates\)/);
  });

  test('browser RLS separates full manager reads from employee-owned rows', () => {
    const migration = source('supabase/migrations/0412_staff_schedule_authority_and_history.sql');
    assert.match(migration, /staxis_user_can_read_full_staff_schedule/);
    assert.match(migration, /staxis_user_can_read_staff_schedule_row/);
    assert.match(migration, /p_kind = 'shift' and p_staff_id = v_staff_id/);
    assert.match(migration, /p_kind = 'open'.*p_department = v_department/);
    assert.match(migration, /staxis_user_can_read_time_off_row/);
    assert.match(migration, /p_staff_id = v_staff_id/);
  });

  test('database guards serialize leave, assignment, archive, and live-request uniqueness', () => {
    const migration = source('supabase/migrations/0412_staff_schedule_authority_and_history.sql');
    const pickup = source('src/app/api/staff-schedule/pickup/route.ts');
    const fill = source('src/app/api/staff-schedule/fill/route.ts');
    const shifts = source('src/app/api/staff-schedule/shifts/route.ts');
    const timeOff = source('src/app/api/staff-schedule/time-off/route.ts');
    const agentActions = source('src/lib/agent/tools/schedule-actions.ts');

    assert.ok((migration.match(/pg_advisory_xact_lock\(hashtextextended\(/g) ?? []).length >= 2);
    assert.match(migration, /staxis_guard_scheduled_shift_assignment/);
    assert.match(migration, /for key share/);
    assert.match(migration, /scheduled_shifts_approved_time_off_guard/);
    assert.match(migration, /scheduled_shifts_active_staff_guard/);
    assert.match(migration, /staxis_guard_time_off_request_staff/);
    assert.match(migration, /time_off_requests_one_live_per_staff_date/);
    assert.match(migration, /staxis_protect_archived_shift_history/);
    assert.match(migration, /scheduled_shifts_archived_history_guard/);
    assert.match(migration, /create policy staff_manage_update[\s\S]*and is_active is true[\s\S]*with check[\s\S]*and is_active is true/);

    assert.match(pickup, /staffScheduleGuardConflict\(upErr\)/);
    assert.match(pickup, /guardConflict === 'approved_time_off'[\s\S]*status: 409/);
    assert.match(pickup, /guardConflict === 'inactive_staff'[\s\S]*status: 409/);
    assert.match(pickup, /time_off_override: false/);
    assert.match(fill, /rpc\('staxis_replace_staff_schedule_days'/);
    assert.match(migration, /inactive_staff\.is_active is false/);
    assert.match(migration, /v_has_approved_leave and v_override_time_off/);
    assert.match(shifts, /time_off_override: false/);
    assert.match(agentActions, /time_off_override: false/);
    assert.match(timeOff, /error\.code === '23505'[\s\S]*status: 409/);
  });

  test('stable scheduling guard errors map to their intended conflicts', () => {
    assert.equal(staffScheduleGuardConflict({
      code: '23514',
      message: 'Cannot assign a staff member on approved time off',
    }), 'approved_time_off');
    assert.equal(staffScheduleGuardConflict({
      code: '23514',
      message: 'Cannot assign an inactive staff member',
    }), 'inactive_staff');
    assert.equal(staffScheduleGuardConflict({
      code: '23514',
      message: 'Cannot erase an archived historical shift assignment',
    }), 'archived_history');
    assert.equal(staffScheduleGuardConflict({ code: '23505', message: 'duplicate' }), null);
  });

  test('week roster shows archived staff only when displayed history references them', () => {
    const member = (id: string, isActive: boolean): StaffMember => ({
      id,
      name: id,
      language: 'en',
      isSenior: false,
      department: 'housekeeping',
      scheduledToday: false,
      weeklyHours: 0,
      maxWeeklyHours: 40,
      isActive,
    });
    const active = member('active', true);
    const archivedWithHistory = member('archived-history', false);
    const archivedWithoutHistory = member('archived-empty', false);

    assert.deepEqual(
      staffVisibleInWeekRoster(
        [active, archivedWithHistory, archivedWithoutHistory],
        new Set([archivedWithHistory.id]),
      ).map(row => row.id),
      [active.id, archivedWithHistory.id],
    );

    const dayBoard = source('src/app/staff/_components/schedule/DayBoard.tsx');
    assert.match(dayBoard, /readOnlyStaffIds/);
    assert.match(dayBoard, /Archived history/);
  });
});
