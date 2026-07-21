import { NextRequest, NextResponse } from 'next/server';

import { buildOkBody, err, ApiErrorCode } from '@/lib/api-response';
import { validateUuid } from '@/lib/api-validate';
import { writeAudit } from '@/lib/audit';
import { toStaffRow } from '@/lib/db-mappers';
import { checkIdempotency, recordIdempotency } from '@/lib/idempotency';
import { getOrMintRequestId, log } from '@/lib/log';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { type TeamCaller, verifyTeamManager } from '@/lib/team-auth';
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
  const { data: account, error: accountError } = await supabaseAdmin
    .from('accounts')
    .select('active, role, property_access')
    .eq('id', caller.accountId)
    .maybeSingle();
  if (accountError) return 'unavailable';
  if (!account?.active) return 'denied';
  const currentRole = account.role;
  if (currentRole === 'admin') return 'allowed';
  if (currentRole !== 'owner' && currentRole !== 'general_manager') return 'denied';
  const currentHotelAccess = (account.property_access ?? []) as string[];
  if (!currentHotelAccess.includes(hotelId)) return 'denied';

  const { data: override, error: overrideError } = await supabaseAdmin
    .from('capability_overrides')
    .select('allowed')
    .eq('property_id', hotelId)
    .eq('capability', 'manage_team')
    .eq('role', currentRole)
    .maybeSingle();
  if (overrideError) return 'unavailable';
  return override?.allowed === false ? 'denied' : 'allowed';
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
