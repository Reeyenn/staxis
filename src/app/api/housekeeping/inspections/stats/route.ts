/**
 * GET /api/housekeeping/inspections/stats?pid=
 *
 * Returns aggregated stats for the InspectionsTab sidebar.
 *  - today pass rate
 *  - week pass rate
 *  - re-clean rate
 *  - avg inspection duration
 *  - top failing items
 *  - inspector leaderboard
 */

import { NextRequest } from 'next/server';
import { requireSession, userHasPropertyAccess } from '@/lib/api-auth';
import { validateUuid } from '@/lib/api-validate';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { fromInspectionRow, lookupStaffNames } from '@/lib/db/inspections';
import { APP_TIMEZONE } from '@/lib/utils';
import type { Inspection, InspectionStats } from '@/types/inspections';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 10;

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);

  const auth = await requireSession(req, { requestId });
  if (!auth.ok) return auth.response;

  const { searchParams } = new URL(req.url);
  const pidV = validateUuid(searchParams.get('pid'), 'pid');
  if (pidV.error) {
    return err(pidV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  const pid = pidV.value!;

  const hasAccess = await userHasPropertyAccess(auth.userId, pid);
  if (!hasAccess) {
    return err('forbidden — no access to this property', {
      requestId, status: 403, code: ApiErrorCode.Forbidden,
    });
  }

  try {
    const stats = await buildStats(pid);
    return ok(stats, { requestId });
  } catch (e: unknown) {
    log.error('[inspections/stats] failed', { requestId, pid, msg: errToString(e) });
    return err('Internal server error', {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }
}

async function buildStats(pid: string): Promise<InspectionStats> {
  // Codex post-merge follow-up — use the property's local timezone for
  // the "today" boundary, not the server-local boundary. A property in
  // EST seeing inspections "today" via a server in UTC otherwise
  // mis-classified anything between local-midnight and UTC-midnight.
  //
  // properties.timezone is the IANA name set at onboarding (migration
  // 0016). If it's null / unset we fall back to APP_TIMEZONE so
  // multi-property accounts keep working before timezone is filled in.
  const propertyTz = await getPropertyTimezone(pid);

  // Pull last 7 days of completed (pass / fail) inspections in one shot.
  const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const { data, error } = await supabaseAdmin
    .from('inspections')
    .select('*')
    .eq('property_id', pid)
    .neq('result', 'in_progress')
    .neq('result', 'cancelled')
    .gte('started_at', sevenDaysAgo);
  if (error) throw error;
  const inspections = (data ?? []).map((r) => fromInspectionRow(r as Parameters<typeof fromInspectionRow>[0]));

  // Compute property-local "today midnight" as a UTC ISO that we can
  // compare directly against the inspection.startedAt UTC string.
  const todayIso = propertyMidnightIso(propertyTz);

  const today = inspections.filter((i) => i.startedAt >= todayIso);
  const week = inspections;

  const todayPass = today.filter((i) => i.result === 'pass').length;
  const weekPass = week.filter((i) => i.result === 'pass').length;
  const todayPassRate = today.length ? todayPass / today.length : 0;
  const weekPassRate = week.length ? weekPass / week.length : 0;

  const weekFails = week.filter((i) => i.result === 'fail').length;
  const reCleanRatePct = week.length ? (weekFails / week.length) * 100 : 0;

  let totalDurationSec = 0;
  let durationCount = 0;
  for (const i of week) {
    if (!i.completedAt) continue;
    const dur = (new Date(i.completedAt).getTime() - new Date(i.startedAt).getTime()) / 1000;
    if (dur > 0 && dur < 60 * 60) {
      totalDurationSec += dur;
      durationCount += 1;
    }
  }
  const avgInspectionDurationSec = durationCount ? totalDurationSec / durationCount : 0;

  // Top failure items by frequency.
  const failureCounts = new Map<string, number>();
  for (const i of week) {
    if (i.result !== 'fail') continue;
    for (const item of i.failedItems) {
      const key = item.label;
      failureCounts.set(key, (failureCounts.get(key) ?? 0) + 1);
    }
  }
  const topFailureItems = Array.from(failureCounts.entries())
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  // Inspector leaderboard.
  const byInspector = new Map<string, { passes: number; total: number }>();
  for (const i of week) {
    if (!i.inspectorStaffId) continue;
    const cur = byInspector.get(i.inspectorStaffId) ?? { passes: 0, total: 0 };
    cur.total += 1;
    if (i.result === 'pass') cur.passes += 1;
    byInspector.set(i.inspectorStaffId, cur);
  }
  const names = await lookupStaffNames(Array.from(byInspector.keys()));
  const inspectorLeaderboard = Array.from(byInspector.entries())
    .map(([id, agg]) => ({
      inspectorName: names.get(id) ?? 'Inspector',
      passRate: agg.total ? agg.passes / agg.total : 0,
      count: agg.total,
    }))
    .sort((a, b) => b.passRate - a.passRate)
    .slice(0, 10);

  return {
    todayPassRate,
    weekPassRate,
    reCleanRatePct,
    avgInspectionDurationSec,
    totalInspectionsToday: today.length,
    totalInspectionsWeek: week.length,
    topFailureItems,
    inspectorLeaderboard,
  };
}

// Local type guard helper to keep TS happy for unused import.
type _Unused = Inspection;

/**
 * Look up the property's IANA timezone (set at onboarding, migration
 * 0016). Returns APP_TIMEZONE as fallback so multi-property accounts
 * where one property has timezone=null don't break.
 */
async function getPropertyTimezone(pid: string): Promise<string> {
  try {
    const { data } = await supabaseAdmin
      .from('properties')
      .select('timezone')
      .eq('id', pid)
      .maybeSingle();
    const tz = (data as { timezone?: string | null } | null)?.timezone;
    if (typeof tz === 'string' && tz.length > 0) return tz;
  } catch {
    // fall through to default
  }
  return APP_TIMEZONE;
}

/**
 * Compute the UTC ISO string for "today at 00:00 in the given IANA
 * timezone." That's the value we compare inspection.startedAt against
 * to decide today vs not-today.
 *
 * Codex M4 follow-up — the original implementation used the *current*
 * wall-clock offset to translate midnight into UTC. That broke on DST
 * transition days: in America/New_York on 2026-03-08, the live offset
 * during the day is EDT (-04:00) but local midnight that same date was
 * still EST (-05:00). The function returned a UTC instant one hour off,
 * mis-attributing the last hour of "yesterday" to "today" and vice
 * versa for fall-back days.
 *
 * The fix uses Intl.DateTimeFormat as an oracle for "what wall-clock
 * time does this UTC instant show in tz?" and converges via a small
 * fixed-point loop on the right UTC instant for midnight on the target
 * local date. Robust to DST and to fractional-hour offsets (e.g.
 * Asia/Kathmandu = UTC+05:45, Australia/Adelaide = UTC+09:30).
 */
export function propertyMidnightIso(tz: string): string {
  const now = new Date();

  // 1. Today's YYYY-MM-DD in the target tz.
  const datePartsFmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const dateParts = datePartsFmt.formatToParts(now);
  const get = (parts: Intl.DateTimeFormatPart[], t: string): number =>
    Number(parts.find((p) => p.type === t)?.value ?? '0');
  const y = get(dateParts, 'year');
  const m = get(dateParts, 'month');
  const d = get(dateParts, 'day');

  // 2. Resolve the UTC instant that formats to "y-m-d 00:00:00" in tz.
  //    Start with the naive guess (UTC midnight on the target date),
  //    then format it in tz and adjust by the observed difference.
  //    Converges in ≤2 iterations for any IANA tz including DST.
  const fullFmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });

  let utc = Date.UTC(y, m - 1, d, 0, 0, 0);
  for (let iter = 0; iter < 4; iter++) {
    const parts = fullFmt.formatToParts(new Date(utc));
    const oy = get(parts, 'year');
    const om = get(parts, 'month');
    const od = get(parts, 'day');
    let oh = get(parts, 'hour');
    const omi = get(parts, 'minute');
    const os = get(parts, 'second');
    // Some locales emit "24" for the midnight hour in 24-hour format.
    // Normalize to 0 for consistent arithmetic.
    if (oh === 24) oh = 0;

    if (oy === y && om === m && od === d && oh === 0 && omi === 0 && os === 0) {
      return new Date(utc).toISOString();
    }
    const observedAsUtc = Date.UTC(oy, om - 1, od, oh, omi, os);
    const targetAsUtc = Date.UTC(y, m - 1, d, 0, 0, 0);
    utc += targetAsUtc - observedAsUtc;
  }
  // If we didn't converge (shouldn't happen for any real tz), return
  // the last candidate — better than throwing in a stats endpoint.
  return new Date(utc).toISOString();
}
