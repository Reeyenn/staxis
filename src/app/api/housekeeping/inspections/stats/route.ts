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

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayIso = todayStart.toISOString();

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
