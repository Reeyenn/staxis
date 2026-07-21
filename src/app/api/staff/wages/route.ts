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
 *   - gates on the view_wages capability (default: every role; restricted per hotel)
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
import { type AppRole } from '@/lib/roles';
import { capabilityDecisionForProperty } from '@/lib/capabilities/server';
import { capabilityUnavailableResponse } from '@/lib/capabilities/api-gate';
import {
  callerManagesProperty,
  validateWage,
  type WageCaller,
} from '@/lib/staff-wages';
import { requireSectionEnabled } from '@/lib/sections/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function loadCaller(authUserId: string): Promise<WageCaller | null> {
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

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const session = await requireSession(req, { requestId });
  if (!session.ok) return session.response;

  const caller = await loadCaller(session.userId);
  if (!caller) return err('Account not found', { requestId, status: 404, code: ApiErrorCode.NotFound });

  const pidV = validateUuid(new URL(req.url).searchParams.get('propertyId'), 'propertyId');
  if (pidV.error) return err(pidV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  if (!callerManagesProperty(caller, pidV.value!)) {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Forbidden });
  }
  const capabilityDecision = await capabilityDecisionForProperty(
    { role: caller.role },
    'view_wages',
    pidV.value!,
  );
  if (capabilityDecision === 'unavailable') return capabilityUnavailableResponse(requestId);
  if (capabilityDecision === 'denied') {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Forbidden });
  }
  const sectionGate = await requireSectionEnabled(req, pidV.value!, 'staff');
  if (!sectionGate.ok) return sectionGate.response;

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

  const pidV = validateUuid(body.propertyId, 'propertyId');
  if (pidV.error) return err(pidV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  if (!callerManagesProperty(caller, pidV.value!)) {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Forbidden });
  }
  const capabilityDecision = await capabilityDecisionForProperty(
    { role: caller.role },
    'view_wages',
    pidV.value!,
  );
  if (capabilityDecision === 'unavailable') return capabilityUnavailableResponse(requestId);
  if (capabilityDecision === 'denied') {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Forbidden });
  }
  const sectionGate = await requireSectionEnabled(req, pidV.value!, 'staff');
  if (!sectionGate.ok) return sectionGate.response;

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
