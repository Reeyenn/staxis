/**
 * GET /api/housekeeping/labor-cost?propertyId=&businessDate=
 *
 * Powers the LaborCostBanner on the Schedule tab + the per-housekeeper
 * cost overlay on the Auto-Assign board + the Labor Cost section on the
 * Performance tab. Returns:
 *
 *   {
 *     totalCents, perHousekeeper[], byCleaningType,
 *     accruedCents, projectedCents, remainingEstimateCents,
 *     basedOnHistoricalPace,
 *     dailyBudgetCents, weeklyBudgetCents,
 *     anyWageUnknown, asOf,
 *   }
 *
 * Auth: requireSession + property-access check. Caller does NOT have to
 * be owner/GM — any team member with property access can read aggregate
 * cost. Wages-of-individuals are not exposed (only the post-rollup
 * cents per housekeeper); the housekeepers themselves would still need
 * to know their own row's identity to "back out" their wage, which the
 * /staff page rejects already. The Schedule tab is canManageTeam-gated
 * upstream, so this is a defense-in-depth gate, not the primary one.
 *
 * Rate limit: housekeeping-labor-cost, keyed on (userId, propertyId).
 */

import { NextRequest } from 'next/server';
import { requireSession, userHasPropertyAccess } from '@/lib/api-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { validateUuid } from '@/lib/api-validate';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { checkAndIncrementRateLimit, hashToRateLimitKey } from '@/lib/api-ratelimit';
import { projectEndOfDayCost } from '@/lib/cost-tracking';
import { canManageTeam, type AppRole } from '@/lib/roles';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DATE_RX = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const session = await requireSession(req, { requestId });
  if (!session.ok) return session.response;

  const url = new URL(req.url);
  const pidV = validateUuid(url.searchParams.get('propertyId'), 'propertyId');
  if (pidV.error) return err(pidV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });

  const propertyId = pidV.value!;
  if (!(await userHasPropertyAccess(session.userId, propertyId))) {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Forbidden });
  }

  // Manager+ gate (adversarial review M2). The response contains
  // per-housekeeper cents + minutes, from which a peer could recover
  // each coworker's hourly wage by division. Cost data is for
  // managers, not the housekeeping/front_desk/maintenance roles.
  const { data: callerAccount } = await supabaseAdmin
    .from('accounts')
    .select('role')
    .eq('data_user_id', session.userId)
    .maybeSingle();
  const callerRole = callerAccount?.role as AppRole | undefined;
  if (!callerRole || !canManageTeam(callerRole)) {
    log.warn('[labor-cost:GET] role gate rejected non-manager', { requestId, role: callerRole });
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Forbidden });
  }

  const businessDate = url.searchParams.get('businessDate') ?? todayInUtc();
  if (!DATE_RX.test(businessDate)) {
    return err('businessDate must be YYYY-MM-DD', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }

  // Rate limit per (user, property). Keyed via hash so the api_limits
  // table's UUID-shaped key column accepts arbitrary input.
  const rlKey = hashToRateLimitKey(`${session.userId}:${propertyId}`);
  const rl = await checkAndIncrementRateLimit('housekeeping-labor-cost', rlKey);
  if (!rl.allowed) {
    return err('Too many cost-banner refreshes — slow down', {
      requestId, status: 429, code: ApiErrorCode.RateLimited,
      headers: { 'Retry-After': String(rl.retryAfterSec) },
    });
  }

  // Load day cost + projection in one pass.
  const result = await projectEndOfDayCost({ propertyId, businessDate });
  if (!result) {
    return err('Failed to load labor cost', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }

  // Pull the property's budgets. Read the new cents columns first, fall
  // back to weekly_budget (dollars) for properties whose owner hasn't
  // set the new field yet.
  const { data: prop } = await supabaseAdmin
    .from('properties')
    .select('daily_labor_budget_cents, weekly_labor_budget_cents, weekly_budget, overtime_threshold_hours')
    .eq('id', propertyId)
    .maybeSingle();

  let dailyBudgetCents: number | null = prop?.daily_labor_budget_cents ?? null;
  let weeklyBudgetCents: number | null = prop?.weekly_labor_budget_cents ?? null;
  // Daily fallback: 1/7 of weekly when daily isn't set explicitly.
  if (dailyBudgetCents === null && weeklyBudgetCents !== null) {
    dailyBudgetCents = Math.round(weeklyBudgetCents / 7);
  }
  // Legacy fallback: weekly_budget dollars → cents.
  if (weeklyBudgetCents === null && prop?.weekly_budget !== null && prop?.weekly_budget !== undefined) {
    weeklyBudgetCents = Math.round(Number(prop.weekly_budget) * 100);
    if (dailyBudgetCents === null) dailyBudgetCents = Math.round(weeklyBudgetCents / 7);
  }

  return ok({
    propertyId,
    businessDate,
    totalCents: result.dayCost.totalCents,
    perHousekeeper: result.dayCost.perHousekeeper,
    byCleaningType: result.dayCost.byCleaningType,
    anyWageUnknown: result.dayCost.anyWageUnknown,
    asOf: result.dayCost.asOf,
    accruedCents: result.projection.accruedCents,
    remainingEstimateCents: result.projection.remainingEstimateCents,
    projectedCents: result.projection.projectedCents,
    basedOnHistoricalPace: result.projection.basedOnHistoricalPace,
    dailyBudgetCents,
    weeklyBudgetCents,
    overtimeThresholdHours: prop?.overtime_threshold_hours ?? 40,
  }, { requestId });
}

function todayInUtc(): string {
  return new Date().toISOString().slice(0, 10);
}
