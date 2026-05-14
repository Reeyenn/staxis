/**
 * GET /api/cron/walkthrough-health-alert
 *
 * Every 10 minutes. Queries the `walkthrough_runs_daily` view for today
 * and fires a Sentry alert if the bad-outcome rate is unhealthy.
 *
 * "Bad outcomes" = hit_step_cap + errored + timed_out. Deliberately EXCLUDES
 * user_stopped — a user clicking the Stop button is normal product behavior,
 * not a bug.
 *
 * Alert threshold: (hit_step_cap + errored + timed_out) / total > 0.25
 *                  AND total >= 5  (avoid alert spam on low-traffic mornings)
 *
 * Without this cron, a regression — bad Sonnet snapshot, prompt drift,
 * a deployed bug — would only surface through user support tickets days
 * later. At 300-hotel scale that's hundreds of frustrated users.
 *
 * Auth: CRON_SECRET bearer.
 *
 * Scale-readiness Phase 1C (2026-05-14).
 */

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireCronSecret } from '@/lib/api-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { writeCronHeartbeat } from '@/lib/cron-heartbeat';
import { captureMessage } from '@/lib/sentry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

const BAD_OUTCOME_THRESHOLD = 0.25;   // 25% bad-outcome rate triggers the alert
const MIN_TOTAL_FOR_ALERT = 5;        // need at least 5 walkthroughs to alert

interface DailyRow {
  day: string;
  completed: number;
  user_stopped: number;
  hit_step_cap: number;
  errored: number;
  timed_out: number;
  still_active: number;
  total: number;
  avg_steps_to_done: number | null;
}

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const cronGate = requireCronSecret(req);
  if (cronGate) return cronGate;

  try {
    // Today's row (or no row at all if no walkthroughs yet today). UTC day
    // boundary matches the rest of the cost system (agent_costs uses UTC).
    const today = new Date().toISOString().slice(0, 10);
    const { data, error } = await supabaseAdmin
      .from('walkthrough_runs_daily')
      .select('*')
      .eq('day', today)
      .maybeSingle<DailyRow>();

    if (error) {
      throw new Error(`walkthrough_runs_daily query failed: ${error.message}`);
    }

    const row = data;
    const alerted = !!row && row.total >= MIN_TOTAL_FOR_ALERT && (() => {
      const bad = row.hit_step_cap + row.errored + row.timed_out;
      return bad / row.total > BAD_OUTCOME_THRESHOLD;
    })();

    if (alerted && row) {
      const bad = row.hit_step_cap + row.errored + row.timed_out;
      const rate = bad / row.total;
      log.warn('[walkthrough-health-alert] bad-outcome rate above threshold', {
        requestId,
        rate: Math.round(rate * 1000) / 10,
        total: row.total,
        breakdown: {
          completed: row.completed,
          user_stopped: row.user_stopped,
          hit_step_cap: row.hit_step_cap,
          errored: row.errored,
          timed_out: row.timed_out,
          still_active: row.still_active,
        },
      });
      captureMessage('walkthrough bad-outcome rate above threshold', {
        subsystem: 'walkthrough',
        cron: 'walkthrough-health-alert',
        day: row.day,
        bad_outcome_pct: Math.round(rate * 1000) / 10,
        total: row.total,
        hit_step_cap: row.hit_step_cap,
        errored: row.errored,
        timed_out: row.timed_out,
      });
    }

    await writeCronHeartbeat('walkthrough-health-alert', {
      requestId,
      notes: {
        total: row?.total ?? 0,
        alerted,
      },
    });

    return ok(
      {
        day: row?.day ?? today,
        total: row?.total ?? 0,
        alerted,
        breakdown: row
          ? {
              completed: row.completed,
              user_stopped: row.user_stopped,
              hit_step_cap: row.hit_step_cap,
              errored: row.errored,
              timed_out: row.timed_out,
              still_active: row.still_active,
              avg_steps_to_done: row.avg_steps_to_done,
            }
          : null,
      },
      { requestId },
    );
  } catch (e) {
    return err(`walkthrough-health-alert cron failed: ${e instanceof Error ? e.message : String(e)}`, {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }
}
