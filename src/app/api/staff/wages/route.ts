/**
 * Staff hourly-wage read + write — MANAGEMENT ONLY, service-role.
 *
 * WHY THIS EXISTS (privacy fix, 2026-05-31)
 * `staff.hourly_wage` is per-person payroll data. The `staff` table's RLS is
 * row-level only ("owner rw staff", migration 0001) and Postgres RLS has no
 * column-level restriction — so EVERY authenticated property user
 * (front_desk, housekeeping, maintenance, …) could read AND write every
 * colleague's wage straight through the anon browser client. The anon read
 * projection (STAFF_COLS in src/lib/db/staff.ts) and the anon write helpers
 * no longer touch hourly_wage; the column is now reachable only through this
 * route, which:
 *   - requires a valid session (requireSession)
 *   - gates on management roles (canManageTeam → admin / owner / general_manager)
 *   - verifies the caller actually manages the target property
 *   - verifies the staff row belongs to that property (no cross-property IDOR)
 *
 * Mirrors the projection discipline in /api/staff-list ("NEVER add
 * hourly_wage") and the management role-gate shape in /api/settings/users.
 *
 *   GET  ?propertyId=<uuid>
 *     200 → { ok, requestId, data: { wages: { [staffId]: number | null } } }
 *
 *   PUT  { propertyId, staffId, hourlyWage }
 *     hourlyWage: number in [0, 10000], or null to clear.
 *     200 → { ok, requestId, data: { staffId, hourlyWage } }
 *
 * Auth: requireSession (the manager/owner) — NOT requireCronSecret.
 */

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireSession } from '@/lib/api-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { validateUuid } from '@/lib/api-validate';
import { canManageTeam, type AppRole } from '@/lib/roles';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// North of $10k/hr is not a real hotel wage — almost certainly a fat-finger
// or an overflow attempt. Cap it so a typo can't poison the numeric column.
const MAX_WAGE = 10000;

export interface Caller {
  role: AppRole;
  propertyAccess: string[];
}

async function loadCaller(authUserId: string): Promise<Caller | null> {
  const { data, error } = await supabaseAdmin
    .from('accounts')
    .select('role, property_access')
    .eq('data_user_id', authUserId)
    .maybeSingle();
  if (error || !data) return null;
  return {
    role: (data as { role: string }).role as AppRole,
    propertyAccess: Array.isArray((data as { property_access?: unknown }).property_access)
      ? ((data as { property_access: string[] }).property_access)
      : [],
  };
}

// Exported for unit tests (mirrors denyRoleChange in /api/settings/users).
export function callerManagesProperty(caller: Caller, propertyId: string): boolean {
  if (caller.role === 'admin') return true;
  if (caller.propertyAccess.includes('*')) return true;
  return caller.propertyAccess.includes(propertyId);
}

/**
 * null/absent → clear the wage. Otherwise a finite number in [0, MAX_WAGE],
 * rounded to cents. Exported for unit tests.
 */
export function validateWage(v: unknown): { error?: string; value?: number | null } {
  if (v === null || v === undefined) return { value: null };
  const n =
    typeof v === 'number' ? v :
    typeof v === 'string' && v.trim() !== '' ? Number(v) :
    NaN;
  if (!Number.isFinite(n)) return { error: 'hourlyWage must be a number or null' };
  if (n < 0) return { error: 'hourlyWage cannot be negative' };
  if (n > MAX_WAGE) return { error: `hourlyWage cannot exceed ${MAX_WAGE}` };
  return { value: Math.round(n * 100) / 100 };
}

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const session = await requireSession(req, { requestId });
  if (!session.ok) return session.response;

  const caller = await loadCaller(session.userId);
  if (!caller) return err('Account not found', { requestId, status: 404, code: ApiErrorCode.NotFound });
  if (!canManageTeam(caller.role)) {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Forbidden });
  }

  const pidV = validateUuid(new URL(req.url).searchParams.get('propertyId'), 'propertyId');
  if (pidV.error) return err(pidV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  if (!callerManagesProperty(caller, pidV.value!)) {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Forbidden });
  }

  const { data, error: qErr } = await supabaseAdmin
    .from('staff')
    .select('id, hourly_wage')
    .eq('property_id', pidV.value!);
  if (qErr) {
    log.error('[staff/wages:GET] query failed', { requestId, err: qErr.message });
    return err('Failed to load wages', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }

  const wages: Record<string, number | null> = {};
  for (const row of (data ?? []) as Array<{ id: string; hourly_wage: number | null }>) {
    wages[String(row.id)] = row.hourly_wage == null ? null : Number(row.hourly_wage);
  }
  return ok({ wages }, { requestId });
}

interface PutBody {
  propertyId?: unknown;
  staffId?: unknown;
  hourlyWage?: unknown;
}

export async function PUT(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const session = await requireSession(req, { requestId });
  if (!session.ok) return session.response;

  const body = (await req.json().catch(() => null)) as PutBody | null;
  if (!body) return err('Invalid JSON body', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });

  const caller = await loadCaller(session.userId);
  if (!caller) return err('Account not found', { requestId, status: 404, code: ApiErrorCode.NotFound });
  if (!canManageTeam(caller.role)) {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Forbidden });
  }

  const pidV = validateUuid(body.propertyId, 'propertyId');
  if (pidV.error) return err(pidV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  if (!callerManagesProperty(caller, pidV.value!)) {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Forbidden });
  }

  const sidV = validateUuid(body.staffId, 'staffId');
  if (sidV.error) return err(sidV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });

  const wageV = validateWage(body.hourlyWage);
  if (wageV.error) return err(wageV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });

  // Confirm the staff row belongs to the named property BEFORE writing. This
  // closes the cross-property IDOR: a manager of property A must not be able
  // to set a wage on a staff row in property B by pairing B's staffId with
  // A's propertyId (the property-access check above only proves they manage A).
  const { data: staffRow, error: sErr } = await supabaseAdmin
    .from('staff')
    .select('id, property_id')
    .eq('id', sidV.value!)
    .maybeSingle();
  if (sErr) {
    log.error('[staff/wages:PUT] staff lookup failed', { requestId, err: sErr.message });
    return err('Failed to update wage', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }
  if (!staffRow || (staffRow as { property_id?: string }).property_id !== pidV.value!) {
    return err('Staff member not found for this property', { requestId, status: 404, code: ApiErrorCode.NotFound });
  }

  const { error: upErr } = await supabaseAdmin
    .from('staff')
    .update({ hourly_wage: wageV.value })
    .eq('id', sidV.value!)
    .eq('property_id', pidV.value!);
  if (upErr) {
    log.error('[staff/wages:PUT] update failed', { requestId, err: upErr.message });
    return err('Failed to update wage', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }

  return ok({ staffId: sidV.value!, hourlyWage: wageV.value }, { requestId });
}
