/**
 * PATCH /api/properties/labor-budget
 *
 * Lets owners + general managers set daily + weekly labor budgets +
 * overtime threshold for a property. The labor-cost banner uses
 * these to compute over/under-budget badges; the OT-status route
 * uses the threshold to color housekeeper columns.
 *
 * Body:
 *   {
 *     propertyId: uuid,
 *     dailyBudgetCents: number | null,       // null clears the value
 *     weeklyBudgetCents: number | null,
 *     overtimeThresholdHours: number,        // required (NOT NULL on the table)
 *   }
 *
 * Auth: requireSession + owner/GM/admin role gate (canEditBudget).
 * Rate-limited: properties-labor-budget bucket.
 *
 * GET form:
 *   ?propertyId=…  → returns current values.
 */

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireSession } from '@/lib/api-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { writeAudit } from '@/lib/audit';
import { validateUuid } from '@/lib/api-validate';
import { checkAndIncrementRateLimit } from '@/lib/api-ratelimit';
import type { AppRole } from '@/lib/roles';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BUDGET_CENTS = 1_000_000_00;        // $1M / day. Sanity cap.
const MAX_OT_HOURS = 168;                     // 168 hours in a week.

interface CallerContext {
  authUserId: string;
  authEmail: string | null;
  accountId: string;
  role: AppRole;
  propertyAccess: string[];
}

async function loadCaller(authUserId: string, authEmail: string | null): Promise<CallerContext | null> {
  const { data, error } = await supabaseAdmin
    .from('accounts')
    .select('id, role, property_access')
    .eq('data_user_id', authUserId)
    .maybeSingle();
  if (error || !data) return null;
  return {
    authUserId,
    authEmail,
    accountId: data.id,
    role: data.role as AppRole,
    propertyAccess: Array.isArray(data.property_access) ? data.property_access : [],
  };
}

function canEditBudget(role: AppRole): boolean {
  return role === 'admin' || role === 'owner' || role === 'general_manager';
}

function callerHasPropertyAccess(caller: CallerContext, propertyId: string): boolean {
  if (caller.role === 'admin') return true;
  return caller.propertyAccess.includes(propertyId) || caller.propertyAccess.includes('*');
}

function normalizeBudget(v: unknown, label: string): { error?: string; value?: number | null } {
  if (v === null) return { value: null };
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    return { error: `${label} must be a number or null` };
  }
  if (!Number.isInteger(v)) return { error: `${label} must be a whole number of cents` };
  if (v < 0 || v > MAX_BUDGET_CENTS) {
    return { error: `${label} must be between 0 and ${MAX_BUDGET_CENTS}` };
  }
  return { value: v };
}

function normalizeOtHours(v: unknown): { error?: string; value?: number } {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    return { error: 'overtimeThresholdHours must be a number' };
  }
  if (v <= 0 || v > MAX_OT_HOURS) {
    return { error: `overtimeThresholdHours must be in (0, ${MAX_OT_HOURS}]` };
  }
  return { value: v };
}

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const session = await requireSession(req, { requestId });
  if (!session.ok) return session.response;

  const caller = await loadCaller(session.userId, session.email);
  if (!caller) return err('Account not found', { requestId, status: 404, code: ApiErrorCode.NotFound });
  if (!canEditBudget(caller.role)) {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Forbidden });
  }

  const url = new URL(req.url);
  const pidV = validateUuid(url.searchParams.get('propertyId'), 'propertyId');
  if (pidV.error) return err(pidV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  if (!callerHasPropertyAccess(caller, pidV.value!)) {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Forbidden });
  }

  const { data, error: qErr } = await supabaseAdmin
    .from('properties')
    .select('daily_labor_budget_cents, weekly_labor_budget_cents, overtime_threshold_hours, weekly_budget')
    .eq('id', pidV.value!)
    .maybeSingle();
  if (qErr || !data) {
    return err('Property not found', { requestId, status: 404, code: ApiErrorCode.NotFound });
  }

  return ok({
    dailyBudgetCents: data.daily_labor_budget_cents,
    weeklyBudgetCents: data.weekly_labor_budget_cents,
    legacyWeeklyBudgetDollars: data.weekly_budget,
    overtimeThresholdHours: data.overtime_threshold_hours ?? 40,
  }, { requestId });
}

interface PatchBody {
  propertyId?: unknown;
  dailyBudgetCents?: unknown;
  weeklyBudgetCents?: unknown;
  overtimeThresholdHours?: unknown;
}

export async function PATCH(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const session = await requireSession(req, { requestId });
  if (!session.ok) return session.response;

  const body = await req.json().catch(() => null) as PatchBody | null;
  if (!body) return err('Invalid JSON body', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });

  const caller = await loadCaller(session.userId, session.email);
  if (!caller) return err('Account not found', { requestId, status: 404, code: ApiErrorCode.NotFound });
  if (!canEditBudget(caller.role)) {
    return err('Only owners and general managers can change the labor budget', {
      requestId, status: 403, code: ApiErrorCode.Forbidden,
    });
  }

  const pidV = validateUuid(body.propertyId, 'propertyId');
  if (pidV.error) return err(pidV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  if (!callerHasPropertyAccess(caller, pidV.value!)) {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Forbidden });
  }

  const dailyV = normalizeBudget(body.dailyBudgetCents, 'dailyBudgetCents');
  if (dailyV.error) return err(dailyV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  const weeklyV = normalizeBudget(body.weeklyBudgetCents, 'weeklyBudgetCents');
  if (weeklyV.error) return err(weeklyV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  const otV = normalizeOtHours(body.overtimeThresholdHours);
  if (otV.error) return err(otV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });

  const rl = await checkAndIncrementRateLimit('properties-labor-budget', pidV.value!);
  if (!rl.allowed) {
    return err('Too many budget updates — try again shortly', {
      requestId, status: 429, code: ApiErrorCode.RateLimited,
      headers: { 'Retry-After': String(rl.retryAfterSec) },
    });
  }

  // Load prior values for the audit log.
  const { data: prior } = await supabaseAdmin
    .from('properties')
    .select('daily_labor_budget_cents, weekly_labor_budget_cents, overtime_threshold_hours')
    .eq('id', pidV.value!)
    .maybeSingle();

  const { error: updateErr } = await supabaseAdmin
    .from('properties')
    .update({
      daily_labor_budget_cents: dailyV.value!,
      weekly_labor_budget_cents: weeklyV.value!,
      overtime_threshold_hours: otV.value!,
    })
    .eq('id', pidV.value!);
  if (updateErr) {
    log.error('[properties/labor-budget:PATCH] update failed', { requestId, err: updateErr.message });
    return err('Failed to update labor budget', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }

  await writeAudit({
    action: 'property.labor_budget_changed',
    actorUserId: caller.authUserId,
    actorEmail: caller.authEmail ?? undefined,
    targetType: 'property',
    targetId: pidV.value!,
    hotelId: pidV.value!,
    metadata: {
      requestId,
      old: {
        dailyBudgetCents: prior?.daily_labor_budget_cents ?? null,
        weeklyBudgetCents: prior?.weekly_labor_budget_cents ?? null,
        overtimeThresholdHours: prior?.overtime_threshold_hours ?? 40,
      },
      new: {
        dailyBudgetCents: dailyV.value!,
        weeklyBudgetCents: weeklyV.value!,
        overtimeThresholdHours: otV.value!,
      },
    },
  });

  return ok({
    dailyBudgetCents: dailyV.value!,
    weeklyBudgetCents: weeklyV.value!,
    overtimeThresholdHours: otV.value!,
  }, { requestId });
}
