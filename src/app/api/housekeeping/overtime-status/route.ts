/**
 * GET /api/housekeeping/overtime-status?propertyId=&staffId=
 *
 * Returns each (or one) housekeeper's net weekly hours for the current
 * ISO week + a level flag:
 *   - 'none'         → under approaching-OT threshold (35h)
 *   - 'approaching'  → 35h ≤ hours < propertyThreshold (default 40h)
 *   - 'over'         → hours ≥ propertyThreshold
 *
 * The Schedule tab uses the list form to drop badges next to columns;
 * the per-staff form is reserved for the future push-notification
 * trigger so we can correlate the badge color with the alert payload.
 *
 * Reads through `staff_weekly_hours_view` (added migration 0229), which
 * aggregates cleaning_events (status ∈ recorded/approved) minus closed
 * lunch breaks per ISO week.
 *
 * Auth: requireSession + property-access check. Read-only.
 */

import { NextRequest } from 'next/server';
import { requireSession, userHasPropertyAccess } from '@/lib/api-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { validateUuid } from '@/lib/api-validate';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { checkAndIncrementRateLimit, hashToRateLimitKey } from '@/lib/api-ratelimit';
import { sendSms } from '@/lib/sms';
import { writeAudit } from '@/lib/audit';
import { canManageTeam, type AppRole } from '@/lib/roles';
import {
  classifyOvertimeLevel,
  isoWeekParts,
  APPROACHING_OT_HOURS,
  DEFAULT_OT_THRESHOLD_HOURS,
  type OvertimeLevel,
} from '@/lib/cost-tracking';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export interface OvertimeStatus {
  staffId: string;
  name: string | null;
  netHours: number;
  cleaningMinutes: number;
  lunchMinutes: number;
  level: OvertimeLevel;
}

export interface OvertimeStatusResponse {
  isoYear: number;
  isoWeek: number;
  thresholdHours: number;
  approachingHours: number;
  byStaff: OvertimeStatus[];
}

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

  // Manager+ gate (adversarial review M2). Net weekly hours per
  // coworker is the same wage-leak vector as the labor-cost route.
  const { data: callerAccount } = await supabaseAdmin
    .from('accounts')
    .select('role')
    .eq('data_user_id', session.userId)
    .maybeSingle();
  const callerRole = callerAccount?.role as AppRole | undefined;
  if (!callerRole || !canManageTeam(callerRole)) {
    log.warn('[overtime-status:GET] role gate rejected non-manager', { requestId, role: callerRole });
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Forbidden });
  }

  // Optional staffId filter — when present, return a single row.
  const staffIdParam = url.searchParams.get('staffId');
  let staffFilter: string | null = null;
  if (staffIdParam) {
    const staffIdV = validateUuid(staffIdParam, 'staffId');
    if (staffIdV.error) return err(staffIdV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
    staffFilter = staffIdV.value!;
  }

  const rlKey = hashToRateLimitKey(`${session.userId}:${propertyId}`);
  const rl = await checkAndIncrementRateLimit('housekeeping-overtime-status', rlKey);
  if (!rl.allowed) {
    return err('Too many overtime checks — slow down', {
      requestId, status: 429, code: ApiErrorCode.RateLimited,
      headers: { 'Retry-After': String(rl.retryAfterSec) },
    });
  }

  // Load property OT threshold + timezone. We need the timezone to
  // compute the ISO week in the property's local time (otherwise the
  // JS week rolls over before the view's business_date does for any
  // property west of UTC). Adversarial review M7.
  const { data: prop } = await supabaseAdmin
    .from('properties')
    .select('overtime_threshold_hours, timezone')
    .eq('id', propertyId)
    .maybeSingle();
  const thresholdHours = prop?.overtime_threshold_hours ?? DEFAULT_OT_THRESHOLD_HOURS;
  const propertyTz = prop?.timezone ?? 'UTC';

  // Convert "now" to a property-local date, then compute ISO week on
  // that local date. Using en-CA gives YYYY-MM-DD natively.
  const nowLocal = (() => {
    try {
      const ymd = new Intl.DateTimeFormat('en-CA', {
        timeZone: propertyTz,
        year: 'numeric', month: '2-digit', day: '2-digit',
      }).format(new Date());
      // Anchor at noon local to avoid DST edge cases when feeding back
      // into JS Date for isoWeekParts.
      return new Date(`${ymd}T12:00:00Z`);
    } catch {
      return new Date();
    }
  })();
  const { isoYear, isoWeek } = isoWeekParts(nowLocal);

  // Load the view rows for this property/week.
  let viewQuery = supabaseAdmin
    .from('staff_weekly_hours_view')
    .select('staff_id, cleaning_minutes, lunch_minutes, net_hours')
    .eq('property_id', propertyId)
    .eq('iso_year', isoYear)
    .eq('iso_week', isoWeek);
  if (staffFilter) viewQuery = viewQuery.eq('staff_id', staffFilter);

  const { data: hoursRows, error: hoursErr } = await viewQuery;
  if (hoursErr) {
    return err('Failed to load overtime hours', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }

  // Load staff names so the badge has something to render.
  const staffIds = (hoursRows ?? []).map(r => r.staff_id).filter(Boolean) as string[];
  let namesByStaff = new Map<string, string>();
  if (staffIds.length > 0) {
    const { data: staffRows } = await supabaseAdmin
      .from('staff')
      .select('id, name')
      .in('id', staffIds);
    namesByStaff = new Map((staffRows ?? []).map(r => [r.id, r.name as string]));
  }

  const byStaff: OvertimeStatus[] = (hoursRows ?? []).map(r => {
    const netHours = Number(r.net_hours ?? 0);
    return {
      staffId: String(r.staff_id),
      name: namesByStaff.get(String(r.staff_id)) ?? null,
      netHours,
      cleaningMinutes: Number(r.cleaning_minutes ?? 0),
      lunchMinutes: Number(r.lunch_minutes ?? 0),
      level: classifyOvertimeLevel(netHours, thresholdHours),
    };
  });

  // Fire one-shot alerts + audit rows for first-time crossings this
  // ISO week. We don't block the response on this — the dispatch is
  // best-effort and uses Promise.all under the hood, but any failure
  // is logged, not propagated.
  void maybeFireOvertimeAlerts({
    propertyId,
    isoYear,
    isoWeek,
    byStaff,
    thresholdHours,
  });

  const response: OvertimeStatusResponse = {
    isoYear,
    isoWeek,
    thresholdHours,
    approachingHours: APPROACHING_OT_HOURS,
    byStaff,
  };
  return ok(response, { requestId });
}

// ───────────────────────────────────────────────────────────────────────
// Alert + audit pipeline
//
// For each crossing this poll observes, we try to insert a row into
// `overtime_alerts` with the unique constraint
//   (property_id, staff_id, iso_year, iso_week, level)
// Postgres dedupes the concurrent-poll race — only ONE of N parallel
// calls actually inserts, the rest get nothing back from the `.select()`
// after the upsert and skip the SMS step. (Adversarial review M1.)
//
// For 'over' level crossings that we DID just claim, we also try to
// send an SMS to the active scheduling manager. If the housekeeper
// crossing OT IS the scheduling manager, we skip (don't SMS them
// about themselves — adversarial review M9). The SMS dispatch result
// is recorded back on the alert row for diagnostics.
// ───────────────────────────────────────────────────────────────────────

async function maybeFireOvertimeAlerts(args: {
  propertyId: string;
  isoYear: number;
  isoWeek: number;
  byStaff: OvertimeStatus[];
  thresholdHours: number;
}): Promise<void> {
  const crossings = args.byStaff.filter(s => s.level !== 'none');
  if (crossings.length === 0) return;

  try {
    // Atomic insert with ON CONFLICT DO NOTHING. The `.select()` after
    // the insert returns rows for INSERTed claims only — anything that
    // conflicted (already alerted) returns empty.
    const rowsToInsert = crossings.map(s => ({
      property_id: args.propertyId,
      staff_id: s.staffId,
      staff_name_at_alert: s.name,
      iso_year: args.isoYear,
      iso_week: args.isoWeek,
      level: s.level,
      net_hours: s.netHours,
      threshold_hours: args.thresholdHours,
    }));

    const { data: claimedRows, error: insertErr } = await supabaseAdmin
      .from('overtime_alerts')
      .upsert(rowsToInsert, {
        onConflict: 'property_id,staff_id,iso_year,iso_week,level',
        ignoreDuplicates: true,
      })
      .select('id, staff_id, level, net_hours');

    if (insertErr) {
      log.error('[overtime-status] overtime_alerts insert failed', {
        pid: args.propertyId, err: insertErr.message,
      });
      return;
    }
    const claimed = (claimedRows ?? []) as Array<{
      id: string; staff_id: string; level: string; net_hours: number;
    }>;
    if (claimed.length === 0) return;

    // Mirror into admin_audit_log for the per-hotel activity timeline.
    for (const row of claimed) {
      const crossing = crossings.find(c => c.staffId === row.staff_id);
      await writeAudit({
        action: 'housekeeping.overtime_crossed',
        targetType: 'staff',
        targetId: row.staff_id,
        hotelId: args.propertyId,
        metadata: {
          staff_name: crossing?.name ?? null,
          iso_year: args.isoYear,
          iso_week: args.isoWeek,
          level: row.level,
          net_hours: Number(row.net_hours),
          threshold_hours: args.thresholdHours,
        },
      });
    }

    // SMS dispatch for 'over' crossings only.
    const overClaims = claimed.filter(r => r.level === 'over');
    if (overClaims.length === 0) return;

    const { data: smRow } = await supabaseAdmin
      .from('staff')
      .select('id, name, phone')
      .eq('property_id', args.propertyId)
      .eq('is_scheduling_manager', true)
      .eq('is_active', true)
      .maybeSingle();
    const schedulingManagerPhone =
      smRow && typeof smRow.phone === 'string' && smRow.phone.length > 0 ? smRow.phone : null;
    const schedulingManagerName =
      smRow && typeof smRow.name === 'string' ? smRow.name : null;
    const schedulingManagerId = smRow?.id ?? null;

    for (const r of overClaims) {
      // Don't SMS the scheduling manager about themselves crossing OT.
      // Adversarial review M9.
      if (schedulingManagerId && r.staff_id === schedulingManagerId) {
        await supabaseAdmin
          .from('overtime_alerts')
          .update({ sms_status: 'skipped', sms_error: 'recipient_would_be_self' })
          .eq('id', r.id);
        continue;
      }
      if (!schedulingManagerPhone) {
        await supabaseAdmin
          .from('overtime_alerts')
          .update({ sms_status: 'skipped', sms_error: 'no_scheduling_manager_phone' })
          .eq('id', r.id);
        continue;
      }

      const crossing = crossings.find(c => c.staffId === r.staff_id);
      const name = crossing?.name ?? 'a housekeeper';
      const sm = schedulingManagerName ?? 'manager';
      const msg = `Staxis · ${name} just crossed ${args.thresholdHours}h this week (${crossing?.netHours.toFixed(1) ?? Number(r.net_hours).toFixed(1)}h). Heads up, ${sm}.`;
      try {
        await sendSms(schedulingManagerPhone, msg);
        await supabaseAdmin
          .from('overtime_alerts')
          .update({ sms_status: 'sent' })
          .eq('id', r.id);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        log.warn('[overtime-status] SMS send failed', {
          pid: args.propertyId, staffId: r.staff_id, err: errMsg,
        });
        await supabaseAdmin
          .from('overtime_alerts')
          .update({ sms_status: 'failed', sms_error: errMsg.slice(0, 500) })
          .eq('id', r.id);
      }
    }
  } catch (err) {
    log.error('[overtime-status] maybeFireOvertimeAlerts threw', {
      pid: args.propertyId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}
