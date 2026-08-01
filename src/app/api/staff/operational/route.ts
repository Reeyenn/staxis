import { NextRequest, NextResponse } from 'next/server';

import { buildOkBody, err, ApiErrorCode } from '@/lib/api-response';
import { validateUuid } from '@/lib/api-validate';
import { writeAudit } from '@/lib/audit';
import { toStaffRow } from '@/lib/db-mappers';
import { checkIdempotency, recordIdempotency } from '@/lib/idempotency';
import { getOrMintRequestId, log } from '@/lib/log';
import { supabaseAdmin } from '@/lib/supabase-admin';
import {
  accountCapabilityDecisionForProperty,
  type TeamCaller,
  verifyTeamManager,
} from '@/lib/team-auth';
import type { StaffDepartment } from '@/types';
import { errToString } from '@/lib/utils';
import { requireSectionEnabled } from '@/lib/sections/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DEPARTMENTS = new Set<StaffDepartment>([
  'housekeeping',
  'front_desk',
  'maintenance',
  'other',
]);

interface CreateOperationalStaffBody {
  hotelId?: string;
  name?: string;
  department?: string;
  phone?: string;
  language?: string;
}

type StaffMutationAuthorization = 'allowed' | 'denied' | 'unavailable';

/**
 * Mutation authorization must fail closed. This route also re-reads the
 * account's active state and role immediately before its service-role write,
 * so a stale TeamCaller can never authorize a staff creation.
 */
async function authorizeStaffMutation(
  caller: TeamCaller,
  hotelId: string,
): Promise<StaffMutationAuthorization> {
  // Fresh account + exact standing + per-hotel role/capability. In normalized
  // mode the legacy property_access array is rollback material, not authority;
  // consulting it here would revive access after a hotel transfer.
  return accountCapabilityDecisionForProperty(
    caller.authUserId,
    'manage_team',
    hotelId,
    { requireMutation: true },
  );
}

export async function POST(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const caller = await verifyTeamManager(req);
  if (!caller) {
    return err('Unauthorized', {
      requestId,
      status: 403,
      code: ApiErrorCode.Unauthorized,
    });
  }

  const body = await req.json().catch(() => null) as CreateOperationalStaffBody | null;
  if (!body) {
    return err('A valid JSON body is required', {
      requestId,
      status: 400,
      code: ApiErrorCode.ValidationFailed,
    });
  }

  const hotelIdCheck = validateUuid(body.hotelId, 'hotelId');
  if (hotelIdCheck.error) {
    return err(hotelIdCheck.error, {
      requestId,
      status: 400,
      code: ApiErrorCode.ValidationFailed,
    });
  }
  const hotelId = hotelIdCheck.value!;
  const authorization = await authorizeStaffMutation(caller, hotelId);
  if (authorization === 'unavailable') {
    log.error('[staff-operational:POST] authorization lookup failed', {
      requestId,
      hotelId,
      accountId: caller.accountId,
    });
    return err('Team permissions are temporarily unavailable', {
      requestId,
      status: 503,
      code: ApiErrorCode.UpstreamFailure,
      headers: { 'Retry-After': '5' },
    });
  }
  if (authorization === 'denied') {
    return err('Forbidden', {
      requestId,
      status: 403,
      code: ApiErrorCode.Forbidden,
    });
  }
  const sectionGate = await requireSectionEnabled(req, hotelId, 'staff');
  if (!sectionGate.ok) return sectionGate.response;

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const phone = typeof body.phone === 'string' ? body.phone.trim() : '';
  const department = body.department as StaffDepartment | undefined;
  const language = body.language === 'es' ? 'es' : body.language === 'en' ? 'en' : null;
  if (!name || name.length > 120) {
    return err('Name is required and must be 120 characters or fewer', {
      requestId,
      status: 400,
      code: ApiErrorCode.ValidationFailed,
    });
  }
  if (!department || !DEPARTMENTS.has(department)) {
    return err('Invalid department', {
      requestId,
      status: 400,
      code: ApiErrorCode.ValidationFailed,
    });
  }
  if (!language) {
    return err('Invalid language', {
      requestId,
      status: 400,
      code: ApiErrorCode.ValidationFailed,
    });
  }
  if (phone.length > 30) {
    return err('Phone must be 30 characters or fewer', {
      requestId,
      status: 400,
      code: ApiErrorCode.ValidationFailed,
    });
  }

  // Scope the idempotency namespace to both the exact hotel and caller. A
  // retry can safely return the first result, while the same opaque key can
  // never suppress an add at another hotel or for another manager.
  const routeKey = `staff-operational-create:${hotelId}:${caller.accountId}`;
  const idempotency = await checkIdempotency(req, routeKey);
  if (idempotency.kind === 'cached' || idempotency.kind === 'in-progress') {
    return idempotency.response;
  }

  const staffRow = {
    ...toStaffRow({
      name,
      department,
      phone,
      language,
      isSenior: false,
      // DEPRECATED (2026-07-24): staff.scheduled_today is a non-date-aware
      // boolean that nothing ever writes. Housekeeping now derives who is
      // working from scheduled_shifts (src/lib/schedule/active-crew.ts).
      // Kept only to satisfy the NOT NULL column default.
      scheduledToday: false,
      weeklyHours: 0,
      maxWeeklyHours: 40,
      maxDaysPerWeek: 5,
      vacationDates: [],
      isActive: true,
      schedulePriority: 'normal',
    }),
    property_id: hotelId,
  };
  const { data: inserted, error: insertError } = await supabaseAdmin
    .from('staff')
    .insert(staffRow)
    .select('id')
    .single();
  if (insertError || !inserted) {
    log.error('[staff-operational:POST] insert failed', {
      requestId,
      hotelId,
      msg: errToString(insertError),
    });
    return err('Failed to add staff', {
      requestId,
      status: 500,
      code: ApiErrorCode.InternalError,
    });
  }

  const staffId = String(inserted.id);
  await writeAudit({
    action: 'staff.create_schedule_only',
    actorUserId: caller.authUserId,
    targetType: 'staff',
    targetId: staffId,
    hotelId,
    metadata: { department, loginCreated: false },
  });

  const responseBody = buildOkBody({ staffId }, requestId);
  if (idempotency.kind === 'first') {
    await recordIdempotency(idempotency.key, routeKey, responseBody, 201, hotelId);
  }
  return NextResponse.json(responseBody, { status: 201 });
}

/**
 * Archive an operational staff profile without deleting schedule history.
 * Current/future assignments are reopened for coverage atomically with the
 * deactivation; past shifts keep their original staff attribution.
 */
export async function DELETE(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const caller = await verifyTeamManager(req);
  if (!caller) {
    return err('Unauthorized', {
      requestId,
      status: 403,
      code: ApiErrorCode.Unauthorized,
    });
  }

  const { searchParams } = new URL(req.url);
  const hotelIdCheck = validateUuid(searchParams.get('hotelId'), 'hotelId');
  if (hotelIdCheck.error) {
    return err(hotelIdCheck.error, {
      requestId,
      status: 400,
      code: ApiErrorCode.ValidationFailed,
    });
  }
  const staffIdCheck = validateUuid(searchParams.get('staffId'), 'staffId');
  if (staffIdCheck.error) {
    return err(staffIdCheck.error, {
      requestId,
      status: 400,
      code: ApiErrorCode.ValidationFailed,
    });
  }
  const hotelId = hotelIdCheck.value!;
  const staffId = staffIdCheck.value!;

  const authorization = await authorizeStaffMutation(caller, hotelId);
  if (authorization === 'unavailable') {
    return err('Team permissions are temporarily unavailable', {
      requestId,
      status: 503,
      code: ApiErrorCode.UpstreamFailure,
      headers: { 'Retry-After': '5' },
    });
  }
  if (authorization === 'denied') {
    return err('Forbidden', {
      requestId,
      status: 403,
      code: ApiErrorCode.Forbidden,
    });
  }
  const sectionGate = await requireSectionEnabled(req, hotelId, 'staff');
  if (!sectionGate.ok) return sectionGate.response;

  const { data, error } = await supabaseAdmin.rpc('staxis_archive_staff_member', {
    p_property_id: hotelId,
    p_staff_id: staffId,
    p_archived_by: caller.accountId,
  });
  if (error) {
    log.error('[staff-operational:DELETE] archive failed', {
      requestId,
      hotelId,
      staffId,
      msg: errToString(error),
    });
    return err('Failed to archive staff profile', {
      requestId,
      status: 500,
      code: ApiErrorCode.InternalError,
    });
  }

  const result = data && typeof data === 'object'
    ? data as Record<string, unknown>
    : null;
  if (!result || result.ok !== true) {
    if (result?.reason === 'not_found') {
      return err('Staff profile not found', {
        requestId,
        status: 404,
        code: ApiErrorCode.NotFound,
      });
    }
    return err('Failed to archive staff profile', {
      requestId,
      status: 500,
      code: ApiErrorCode.InternalError,
    });
  }

  await writeAudit({
    action: 'staff.archive_schedule_profile',
    actorUserId: caller.authUserId,
    targetType: 'staff',
    targetId: staffId,
    hotelId,
    metadata: {
      openedShifts: Number(result.openedShifts ?? 0),
      cancelledConfirmations: Number(result.cancelledConfirmations ?? 0),
      cancelledTimeOffRequests: Number(result.cancelledTimeOffRequests ?? 0),
      deactivatedLinks: Number(result.deactivatedLinks ?? 0),
      clearedLegacyLinks: Number(result.clearedLegacyLinks ?? 0),
    },
  });

  return NextResponse.json(buildOkBody({
    archived: true,
    alreadyArchived: result.alreadyArchived === true,
    openedShifts: Number(result.openedShifts ?? 0),
    cancelledConfirmations: Number(result.cancelledConfirmations ?? 0),
    cancelledTimeOffRequests: Number(result.cancelledTimeOffRequests ?? 0),
    deactivatedLinks: Number(result.deactivatedLinks ?? 0),
  }, requestId));
}
