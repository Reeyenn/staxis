/**
 * GET /api/dashboard/labor-cost?pid=…
 *
 * Today's whole-hotel labor cost as a % of revenue, for the Dashboard tile.
 *
 *   labor cost = Σ over every PUBLISHED, filled shift today
 *                  (scheduled hours per shift × that person's resolved wage),
 *                with daily overtime (>8h/person) paid at 1.5×.
 *   revenue    = pms_revenue_daily.total_revenue_cents for today — the SAME
 *                canonical PMS table the Financials summary + owner Dashboard
 *                read (src/lib/financials/revenue.ts), so the numbers reconcile.
 *                Empty (cold-start CA franchise PMS) → null, NOT 0.
 *
 * Hours source: scheduled_shifts (migration 0147). Only PUBLISHED, filled
 * shifts count — kind='shift', staff_id not null, status in
 * ('published','sent','confirmed'). Draft (unpublished), declined, and open
 * (unfilled) rows are excluded. Overnight shifts (end_time < start_time) are
 * handled by shiftMinutes(). See src/lib/labor-cost.ts for the pure math.
 *
 * Wage resolution per person: per-person override → role default →
 * staff.hourly_wage (dollars→cents) → benchmark. The first three live in
 * labor_wage_settings (service-role-only, migration 0245); the benchmark is
 * the forecast's DEFAULT_HOURLY_WAGE_CENTS. missing_wages=true when anyone
 * scheduled fell through to the benchmark.
 *
 * Auth: requireSession + userHasPropertyAccess + a management role gate
 * (admin / owner / general_manager via canViewLaborCost). Labor dollars +
 * individual wages are sensitive pay data — front-desk / housekeeping /
 * maintenance must never reach this route. Service-role DB reads.
 *
 * Honest empty states (no fabricated numbers):
 *   - schedule_published=false → the UI shows "Publish this week's schedule".
 *   - missing_wages=true       → the UI shows a "Set wages" prompt.
 *   - revenue null/0           → pct + status are null; the UI shows cost only.
 *
 * Graceful degrade: a missing/again-unavailable table (e.g. labor_wage_settings
 * before migration 0245 lands, or pms_revenue_daily empty) degrades that read
 * to its honest empty value rather than 500ing the dashboard.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireSession, userHasPropertyAccess } from '@/lib/api-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { validateUuid } from '@/lib/api-validate';
import { todayInTz, addDays } from '@/lib/forecast';
import { canForProperty } from '@/lib/capabilities/server';
import {
  shiftMinutes,
  resolveWageCents,
  totalLaborCents,
  laborCostPct,
  classifyLaborBand,
  isLaborRole,
  DEFAULT_LABOR_TARGET_PCT,
  type LaborRole,
} from '@/lib/labor-cost';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Published-and-worked statuses. 'draft' = not yet published; 'declined' =
// staff bailed (that slot isn't worked by them). Mirrors the staff My Shifts
// filter in db/staff-schedule.ts.
const PUBLISHED_STATUSES = ['published', 'sent', 'confirmed'] as const;

interface ShiftRow {
  staff_id: string | null;
  start_time: string | null;
  end_time: string | null;
}
interface StaffRow {
  id: string;
  department: string | null;
  hourly_wage: number | null;
}
interface WageSettingRow {
  scope: string;
  role: string | null;
  staff_id: string | null;
  hourly_wage_cents: number | null;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const requestId = getOrMintRequestId(req);
  const auth = await requireSession(req, { requestId });
  if (!auth.ok) return auth.response;

  try {
    const url = new URL(req.url);
    const pidCheck = validateUuid(url.searchParams.get('pid'), 'pid');
    if (pidCheck.error) {
      return err(pidCheck.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
    }
    const propertyId = pidCheck.value!;

    // Tenant scope.
    if (!(await userHasPropertyAccess(auth.userId, propertyId))) {
      return err('forbidden — no access to this property', {
        requestId, status: 403, code: ApiErrorCode.Forbidden,
      });
    }

    // Role gate — sensitive pay data, management only.
    const { data: accountRow, error: accountErr } = await supabaseAdmin
      .from('accounts')
      .select('role')
      .eq('data_user_id', auth.userId)
      .maybeSingle();
    if (accountErr) {
      log.error('labor-cost: accounts lookup failed', { requestId, msg: accountErr.message });
      return err('account lookup failed', { requestId, status: 500, code: ApiErrorCode.UpstreamFailure });
    }
    if (!(await canForProperty({ role: (accountRow?.role as string | undefined) ?? null }, 'view_wages', propertyId))) {
      return err('forbidden — role does not have labor cost access', {
        requestId, status: 403, code: ApiErrorCode.Forbidden,
      });
    }

    // Property timezone → "today" anchor.
    const { data: propRow } = await supabaseAdmin
      .from('properties')
      .select('id, timezone')
      .eq('id', propertyId)
      .maybeSingle<{ id: string; timezone: string | null }>();
    const timezone = propRow?.timezone || 'America/Chicago';
    const today = todayInTz(timezone);
    const weekFloor = addDays(today, -6); // any Monday whose 7-day span covers today

    // Parallel reads — none depends on another.
    const [shiftsRes, staffRes, wageRes, revenueRes, pubRes] = await Promise.all([
      supabaseAdmin
        .from('scheduled_shifts')
        .select('staff_id, start_time, end_time')
        .eq('property_id', propertyId)
        .eq('shift_date', today)
        .eq('kind', 'shift')
        .not('staff_id', 'is', null)
        .in('status', PUBLISHED_STATUSES as unknown as string[])
        .returns<ShiftRow[]>(),
      supabaseAdmin
        .from('staff')
        .select('id, department, hourly_wage')
        .eq('property_id', propertyId)
        .returns<StaffRow[]>(),
      supabaseAdmin
        .from('labor_wage_settings')
        .select('scope, role, staff_id, hourly_wage_cents')
        .eq('property_id', propertyId)
        .returns<WageSettingRow[]>(),
      supabaseAdmin
        .from('pms_revenue_daily')
        .select('total_revenue_cents')
        .eq('property_id', propertyId)
        .eq('date', today)
        .maybeSingle<{ total_revenue_cents: number | null }>(),
      supabaseAdmin
        .from('week_publications')
        .select('week_start')
        .eq('property_id', propertyId)
        .gte('week_start', weekFloor)
        .lte('week_start', today)
        .limit(1),
    ]);

    // Published-shift read is the spine of the tile. A hard error here means we
    // genuinely don't know the schedule — degrade to the "not published" empty
    // state rather than 500ing the whole dashboard, and DON'T let the
    // week-publication fallback fabricate a $0 (see schedule_published below).
    const shiftsOk = !shiftsRes.error;
    const shifts: ShiftRow[] = degrade(shiftsRes, 'scheduled_shifts', requestId);
    const staff: StaffRow[] = degrade(staffRes, 'staff', requestId);
    // labor_wage_settings may not exist until migration 0245 is applied — that
    // error degrades to "no settings", so wages fall back to staff.hourly_wage
    // / benchmark and the tile still works.
    const wageSettings: WageSettingRow[] = degrade(wageRes, 'labor_wage_settings', requestId);

    // Revenue: empty / unavailable → null (cost-only), never 0.
    let revenueCents: number | null = null;
    if (revenueRes.error) {
      log.warn('labor-cost: pms_revenue_daily read failed; treating revenue as unknown', {
        requestId, msg: revenueRes.error.message,
      });
    } else {
      const tr = revenueRes.data?.total_revenue_cents;
      revenueCents = typeof tr === 'number' && Number.isFinite(tr) ? tr : null;
    }

    const weekPublished = !pubRes.error && (pubRes.data?.length ?? 0) > 0;

    // ── Build wage lookups from settings ──────────────────────────────
    const roleDefaultCents = new Map<LaborRole, number>();
    const personOverrideCents = new Map<string, number>();
    for (const w of wageSettings) {
      const cents = typeof w.hourly_wage_cents === 'number' ? w.hourly_wage_cents : null;
      if (cents == null || cents <= 0) continue;
      if (w.scope === 'role' && isLaborRole(w.role)) roleDefaultCents.set(w.role, cents);
      else if (w.scope === 'person' && w.staff_id) personOverrideCents.set(w.staff_id, cents);
    }

    const staffById = new Map<string, StaffRow>();
    for (const s of staff) staffById.set(s.id, s);

    // ── Collapse shifts → minutes per person (OT is per-person/day) ───
    const minutesByStaff = new Map<string, number>();
    for (const s of shifts) {
      if (!s.staff_id) continue;
      const mins = shiftMinutes(s.start_time, s.end_time);
      if (mins <= 0) continue;
      minutesByStaff.set(s.staff_id, (minutesByStaff.get(s.staff_id) ?? 0) + mins);
    }

    // ── Resolve each person's wage + cost ─────────────────────────────
    const perStaff: Array<{ minutes: number; wageCents: number }> = [];
    let missingWages = false;
    for (const [staffId, minutes] of minutesByStaff) {
      const sRow = staffById.get(staffId);
      // Role default follows the staff member's HOME department (staff.department),
      // not the department of the shift they picked up — pay rate is a property
      // of the person, not the slot. A per-person override still wins over this.
      const dept = isLaborRole(sRow?.department) ? (sRow!.department as LaborRole) : null;
      const resolved = resolveWageCents({
        personOverrideCents: personOverrideCents.get(staffId) ?? null,
        roleDefaultCents: dept ? roleDefaultCents.get(dept) ?? null : null,
        staffHourlyWageDollars: sRow?.hourly_wage ?? null,
      });
      if (resolved.source === 'default') missingWages = true;
      perStaff.push({ minutes, wageCents: resolved.cents });
    }

    const scheduledStaffCount = perStaff.length;
    const laborCostCents = totalLaborCents(perStaff);
    // schedule_published: published shifts exist today → clearly yes. Zero
    // published shifts but the week IS published (everyone off today) → still
    // "published" with $0 labor; only when neither holds do we prompt to
    // publish. The weekPublished fallback is gated on a SUCCESSFUL shift read —
    // if the shift query errored we don't know the labor, so we must not pair a
    // fabricated $0 with "published"; fall back to the neutral publish prompt.
    const schedulePublished = scheduledStaffCount > 0 || (shiftsOk && weekPublished);

    const pct = laborCostPct(laborCostCents, revenueCents);
    const status = pct == null ? null : classifyLaborBand(pct, DEFAULT_LABOR_TARGET_PCT);

    return ok(
      {
        labor_cost_cents: laborCostCents,
        revenue_cents: revenueCents,
        pct,
        status,
        missing_wages: missingWages,
        schedule_published: schedulePublished,
        target_pct: DEFAULT_LABOR_TARGET_PCT,
        scheduled_staff_count: scheduledStaffCount,
        today,
      },
      { requestId },
    );
  } catch (e) {
    log.error('labor-cost: unexpected error', {
      requestId, err: e instanceof Error ? e : new Error(String(e)),
    });
    return err('labor cost failed', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }
}

/**
 * Treat a "table/column missing" or transient read error as an empty array
 * (graceful degrade) so a freshly-migrated DB or a momentary hiccup renders an
 * honest empty tile instead of 500ing the dashboard. Same posture as the
 * forecast route's unwrap().
 */
function degrade<T>(
  res: { data: T[] | null; error: { message: string } | null },
  label: string,
  requestId: string,
): T[] {
  if (res.error) {
    log.warn(`labor-cost: ${label} read failed; degrading to empty`, {
      requestId, msg: res.error.message,
    });
    return [];
  }
  return (res.data ?? []) as T[];
}
