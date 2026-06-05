/**
 * GET /api/cron/run-auto-assign
 *
 * Continuous auto-assignment cron. Scheduled every 15 min (UTC) by
 * Vercel; see vercel.json crons section + cron-schedule-registry.ts.
 *
 * Schedule choice (2026-05-25):
 *   Picked "every 15 min, unconditional" over the two alternatives the
 *   orchestrator surfaced (fixed 11:30 UTC = 6:30am CT only, vs.
 *   per-property local-time gate). The reasons:
 *
 *     1. The engine is already idempotent — `runAutoAssignForProperty`
 *        only touches tasks WITHOUT an active hk_assignments row.
 *        Re-running every 15 min has no side effects once the day's work
 *        is placed.
 *
 *     2. `runAutoAssignForProperty(propertyId, tz)` resolves "today" via
 *        the property's OWN timezone (`todayInTz`). That means a single
 *        UTC-tick cron line correctly handles every timezone the fleet
 *        could add. No hardcoded 11:30 UTC bias, no per-property gating
 *        code path that would need updates when we cross DST.
 *
 *     3. New cleaning_tasks created by the rules-engine cron mid-day
 *        (e.g. late-checkin guests, rush flags) get picked up within
 *        15 min of creation — instead of sitting unassigned until the
 *        next morning's shift-start tick.
 *
 *     4. The "shift-start guarantee" is preserved as a special case:
 *        by 6:30am local at any property, every tick since 6am UTC has
 *        already run, and all tasks for the day are assigned.
 *
 *   Trade-off: 96 invocations/day instead of 1. Vercel cron is metered
 *   on plan minutes — at the route's ~1s typical duration with zero
 *   property work to do, that's ~96s/day of Pro-plan budget. Negligible.
 *
 * Concurrency:
 *   Two overlapping ticks (or a manager's manual Auto-assign click —
 *   POST /api/housekeeping/auto-assign, same runner) can race on the
 *   partial unique index on hk_assignments(cleaning_task_id) WHERE
 *   is_active. The runner catches the resulting 23505 unique-violation
 *   and treats it as a no-op. Net result: whichever runner lost the race
 *   silently steps aside; the task ends up assigned exactly once.
 *
 * The per-property worker lives in src/lib/auto-assign-runner.ts so the
 * manager-facing "Auto-assign" button can reuse the identical engine +
 * persistence path. This route owns ONLY the fan-out across properties
 * and the doctor heartbeat.
 *
 * Auth: Bearer ${CRON_SECRET}.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireCronSecret } from '@/lib/api-auth';
import { ok, err } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { writeCronHeartbeat } from '@/lib/cron-heartbeat';
import {
  runAutoAssignForProperty,
  type PropertyRunResult,
} from '@/lib/auto-assign-runner';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// ───────────────────────────────────────────────────────────────────────
// Route handler
// ───────────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest): Promise<NextResponse> {
  const requestId = getOrMintRequestId(req);
  const unauth = requireCronSecret(req);
  if (unauth) return unauth;

  try {
    // Honor a single-property override on the request (used by the
    // post-deploy smoke test and by manual re-runs from /admin). When
    // absent, fan out across all properties.
    const url = new URL(req.url);
    const overridePid = url.searchParams.get('propertyId');

    let propsQuery = supabaseAdmin.from('properties').select('id, timezone');
    if (overridePid) propsQuery = propsQuery.eq('id', overridePid);
    const { data: propsRows, error: propsErr } = await propsQuery;
    if (propsErr) {
      log.error('run-auto-assign: load properties failed', { requestId, msg: propsErr.message });
      return err('load properties failed', { requestId, status: 500, code: 'upstream_failure' });
    }
    const properties = (propsRows ?? []) as Array<{ id: string; timezone: string | null }>;

    const results: PropertyRunResult[] = [];
    for (const p of properties) {
      try {
        // Cron defaults: respectScheduledToday=true, respectPriority=false,
        // businessDate=today-in-tz, assignedBy='auto'. Unchanged from the
        // pre-extraction behaviour.
        const r = await runAutoAssignForProperty(p.id, p.timezone);
        results.push(r);
      } catch (e) {
        log.error('run-auto-assign: property failed', {
          requestId, propertyId: p.id, msg: errToString(e),
        });
        results.push({
          propertyId: p.id, assigned: 0, unassigned: 0, skippedAlreadyAssigned: 0,
          reason: `error: ${errToString(e)}`,
        });
      }
    }

    const totals = results.reduce(
      (acc, r) => ({
        assigned: acc.assigned + r.assigned,
        unassigned: acc.unassigned + r.unassigned,
        skipped: acc.skipped + r.skippedAlreadyAssigned,
      }),
      { assigned: 0, unassigned: 0, skipped: 0 },
    );

    log.info('run-auto-assign: complete', { requestId, ...totals, properties: results.length });

    // Heartbeat the doctor's cron_heartbeats_fresh check. Status:
    // 'degraded' if any property's run had a reason field set (caught
    // error, missing tz, insert failure, etc.), so per-property errors
    // don't get swallowed into a false-green.
    const propsWithIssues = results.filter(r => r.reason);
    const status = propsWithIssues.length > 0 ? 'degraded' : 'ok';
    await writeCronHeartbeat('run-auto-assign', {
      requestId,
      status,
      notes: {
        ...totals,
        properties: results.length,
        propertiesWithIssues: propsWithIssues.length,
        issueReasons: propsWithIssues.map(p => ({ propertyId: p.propertyId, reason: p.reason })),
        scoped: Boolean(overridePid),
      },
    });

    return ok({ totals, perProperty: results, status }, { requestId });
  } catch (e) {
    log.error('run-auto-assign: unexpected error', { requestId, msg: errToString(e) });
    return err('run failed', { requestId, status: 500, code: 'internal_error' });
  }
}
