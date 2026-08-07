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
  isSenior?: unknown;
  maxWeeklyHours?: unknown;
  maxDaysPerWeek?: unknown;
  vacationDates?: unknown;
}

interface UpdateOperationalStaffBody extends CreateOperationalStaffBody {
  staffId?: string;
}

/** A person cannot be scheduled more hours than a week contains. */
const MAX_WEEKLY_HOURS_CEILING = 168;
/** Enough vacation days to plan a year out; a bound so one row can't grow unbounded. */
const MAX_VACATION_DATES = 400;

interface RosterFields {
  name: string;
  department: StaffDepartment;
  language: 'en' | 'es';
  isSenior: boolean;
  maxWeeklyHours: number;
  maxDaysPerWeek: number;
  vacationDates: string[];
}

/**
 * Validate the roster fields shared by create and edit.
 *
 * `department` is the one that matters most: it is not decoration. It decides
 * which comms channels and which knowledge documents a person can reach
 * (src/lib/capabilities/dept-scope.ts), so moving someone between departments
 * changes what they can read. It must never be written on the strength of
 * anything but a fresh `manage_team` decision for this exact hotel.
 */
function readRosterFields(
  body: CreateOperationalStaffBody,
  fallback: { isSenior: boolean; maxWeeklyHours: number; maxDaysPerWeek: number },
): { error: string } | { value: RosterFields } {
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name || name.length > 120) {
    return { error: 'Name is required and must be 120 characters or fewer' };
  }

  const department = body.department as StaffDepartment | undefined;
  if (!department || !DEPARTMENTS.has(department)) return { error: 'Invalid department' };

  const language = body.language === 'es' ? 'es' : body.language === 'en' ? 'en' : null;
  if (!language) return { error: 'Invalid language' };

  const rawSenior: unknown = body.isSenior;
  if (rawSenior !== undefined && typeof rawSenior !== 'boolean') {
    return { error: 'isSenior must be true or false' };
  }
  const isSenior: boolean = rawSenior === undefined ? fallback.isSenior : rawSenior;

  const rawHours: unknown = body.maxWeeklyHours === undefined
    ? fallback.maxWeeklyHours
    : body.maxWeeklyHours;
  if (typeof rawHours !== 'number' || !Number.isInteger(rawHours)
    || rawHours < 1 || rawHours > MAX_WEEKLY_HOURS_CEILING) {
    return { error: `maxWeeklyHours must be a whole number between 1 and ${MAX_WEEKLY_HOURS_CEILING}` };
  }

  const rawDays: unknown = body.maxDaysPerWeek === undefined
    ? fallback.maxDaysPerWeek
    : body.maxDaysPerWeek;
  if (typeof rawDays !== 'number' || !Number.isInteger(rawDays) || rawDays < 1 || rawDays > 7) {
    return { error: 'maxDaysPerWeek must be a whole number between 1 and 7' };
  }

  const rawVacation: unknown = body.vacationDates;
  const vacationDates: string[] = [];
  if (rawVacation !== undefined) {
    if (!Array.isArray(rawVacation)) return { error: 'vacationDates must be a list of dates' };
    if (rawVacation.length > MAX_VACATION_DATES) {
      return { error: `vacationDates cannot hold more than ${MAX_VACATION_DATES} days` };
    }
    for (const raw of rawVacation as unknown[]) {
      if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
        return { error: 'vacationDates must be YYYY-MM-DD' };
      }
      if (!vacationDates.includes(raw)) vacationDates.push(raw);
    }
    vacationDates.sort();
  }

  return {
    value: {
      name,
      department,
      language,
      isSenior,
      maxWeeklyHours: rawHours,
      maxDaysPerWeek: rawDays,
      vacationDates,
    },
  };
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

  const phone = typeof body.phone === 'string' ? body.phone.trim() : '';
  if (phone.length > 30) {
    return err('Phone must be 30 characters or fewer', {
      requestId,
      status: 400,
      code: ApiErrorCode.ValidationFailed,
    });
  }
  const fields = readRosterFields(body, {
    isSenior: false,
    maxWeeklyHours: 40,
    maxDaysPerWeek: 5,
  });
  if ('error' in fields) {
    return err(fields.error, {
      requestId,
      status: 400,
      code: ApiErrorCode.ValidationFailed,
    });
  }
  const { name, department, language } = fields.value;

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
      isSenior: fields.value.isSenior,
      // DEPRECATED (2026-07-24): staff.scheduled_today is a non-date-aware
      // boolean that nothing ever writes. Housekeeping now derives who is
      // working from scheduled_shifts (src/lib/schedule/active-crew.ts).
      // Kept only to satisfy the NOT NULL column default.
      scheduledToday: false,
      weeklyHours: 0,
      maxWeeklyHours: fields.value.maxWeeklyHours,
      maxDaysPerWeek: fields.value.maxDaysPerWeek,
      vacationDates: fields.value.vacationDates,
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
 * Edit an existing roster row: name, department, language, senior flag, the
 * weekly caps, and vacation days.
 *
 * WHY THIS EXISTS (privilege fix, 2026-08-07)
 * The People card used to write these fields through the browser's anon
 * Supabase client (`updateStaffMember` in src/lib/db/staff.ts, now deleted),
 * which meant the ONLY thing deciding whether the edit was allowed was the RLS
 * predicate `staxis_user_can_manage_staff` (migration 0334). That predicate
 * resolves authority from the LEGACY globals — `accounts.role` plus the
 * `accounts.property_access` array — and every server path in this codebase
 * treats both as non-authoritative. POST above says so in its own words:
 * "the legacy property_access array is rollback material, not authority;
 * consulting it here would revive access after a hotel transfer."
 *
 * So the two authority models disagreed, and the browser was running on the
 * weaker one. A general manager demoted by a company hat, or one whose hotel
 * moved to another company while the legacy array was left behind as rollback
 * material, kept the power to edit that hotel's roster from the browser. That
 * is not cosmetic: `staff.department` gates comms-channel visibility and
 * knowledge-document access, so a stale manager could still change what a
 * colleague is able to read.
 *
 * This route decides with `accountCapabilityDecisionForProperty` — fresh
 * account, exact per-hotel standing, fail closed — exactly like POST and
 * DELETE. It also `.select()`s the row back, because an UPDATE that matches
 * zero rows is NOT a Postgres error and the old browser path could report
 * success having written nothing.
 *
 * Deliberately NOT writable here (each has its own gated route, see the header
 * of PersonEmploymentForm.tsx): hourly_wage, phone, schedule_priority. And not
 * is_active — deactivating someone is DELETE below, which reopens their shifts
 * in the same transaction.
 */
export async function PUT(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const caller = await verifyTeamManager(req);
  if (!caller) {
    return err('Unauthorized', {
      requestId,
      status: 403,
      code: ApiErrorCode.Unauthorized,
    });
  }

  const body = await req.json().catch(() => null) as UpdateOperationalStaffBody | null;
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
  const staffIdCheck = validateUuid(body.staffId, 'staffId');
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
    log.error('[staff-operational:PUT] authorization lookup failed', {
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

  const fields = readRosterFields(body, {
    isSenior: false,
    maxWeeklyHours: 40,
    maxDaysPerWeek: 5,
  });
  if ('error' in fields) {
    return err(fields.error, {
      requestId,
      status: 400,
      code: ApiErrorCode.ValidationFailed,
    });
  }

  // Column names spelled out rather than run through toStaffRow, so this
  // statement cannot carry `phone` or `hourly_wage` even by accident. Both
  // predicates on the write, not just the id: pairing another hotel's staffId
  // with a hotel this caller does manage must not reach that row.
  const { data: updated, error: updateError } = await supabaseAdmin
    .from('staff')
    .update({
      name: fields.value.name,
      department: fields.value.department,
      language: fields.value.language,
      is_senior: fields.value.isSenior,
      max_weekly_hours: fields.value.maxWeeklyHours,
      max_days_per_week: fields.value.maxDaysPerWeek,
      vacation_dates: fields.value.vacationDates,
    })
    .eq('id', staffId)
    .eq('property_id', hotelId)
    .select('id')
    .maybeSingle();
  if (updateError) {
    log.error('[staff-operational:PUT] update failed', {
      requestId,
      hotelId,
      staffId,
      msg: errToString(updateError),
    });
    return err('Failed to save this person', {
      requestId,
      status: 500,
      code: ApiErrorCode.InternalError,
    });
  }
  if (!updated) {
    // Zero rows is a real refusal, never a quiet success.
    return err('Staff profile not found', {
      requestId,
      status: 404,
      code: ApiErrorCode.NotFound,
    });
  }

  await writeAudit({
    action: 'staff.update_schedule_profile',
    actorUserId: caller.authUserId,
    targetType: 'staff',
    targetId: staffId,
    hotelId,
    metadata: { department: fields.value.department },
  });

  return NextResponse.json(buildOkBody({ staffId }, requestId));
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
