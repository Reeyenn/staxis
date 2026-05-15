/**
 * GET /api/cron/walkthrough-health-alert
 *
 * Every 10 minutes. Queries the `walkthrough_runs_daily` view for today
 * and fires a Sentry alert if the bad-outcome rate is unhealthy.
 *
 * "Bad outcomes" = hit_step_cap + errored + timed_out. Deliberately EXCLUDES:
 *   - user_stopped — a user clicking the Stop button is normal product behavior
 *   - cannot_help  — Sonnet honestly refusing an unreachable task is legitimate;
 *                    counting it as a bad outcome made the alert page on healthy
 *                    AI behavior. Split out in migration 0119 (Phase 1D).
 *
 * Alert threshold: (hit_step_cap + errored + timed_out) / total > 0.25
 *                  AND total >= MIN_TOTAL_FOR_ALERT (low-volume noise gate).
 *
 * Without this cron, a regression — bad Sonnet snapshot, prompt drift,
 * a deployed bug — would only surface through user support tickets days
 * later. At 300-hotel scale that's hundreds of frustrated users.
 *
 * Auth: CRON_SECRET bearer.
 *
 * Scale-readiness Phase 1C (2026-05-14), Phase 1D follow-up (cannot_help split + threshold tune).
 */

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireCronSecret } from '@/lib/api-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { writeCronHeartbeat } from '@/lib/cron-heartbeat';
import { captureMessage, truncateListForSentryTitle } from '@/lib/sentry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

const BAD_OUTCOME_THRESHOLD = 0.25;   // 25% bad-outcome rate triggers the alert
// Phase 1D (2026-05-14) — raised from 5 → 20. With min=5 a solo dev-test
// session that hit 2 unrelated infra blips (deploy churn, Anthropic timeout)
// trips the alarm at 40%. 20 is the rough threshold where a single bad
// outcome can't dominate the rate (5%) and the daily signal becomes about
// systemic issues, not single-session noise. Reduce back to 5–10 once daily
// volume stabilizes above ~50 across the fleet.
const MIN_TOTAL_FOR_ALERT = 20;       // need at least 20 walkthroughs to alert

interface DailyRow {
  day: string;
  completed: number;
  user_stopped: number;
  hit_step_cap: number;
  errored: number;
  timed_out: number;
  cannot_help: number;
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

      // Pull the top-failing tasks so the Sentry alert is actionable
      // without dropping into psql. Doctor's failing-check-names trick
      // (Round 16) made on-call triage hours faster — same idea here.
      // We query in the same UTC day window the daily view uses.
      const dayStart = `${row.day}T00:00:00Z`;
      const dayEnd = `${row.day}T23:59:59.999Z`;
      const { data: badRows } = await supabaseAdmin
        .from('walkthrough_runs')
        .select('task, status')
        .in('status', ['errored', 'timeout', 'capped'])
        .gte('started_at', dayStart)
        .lte('started_at', dayEnd);
      const byTask = new Map<string, number>();
      for (const r of (badRows ?? []) as Array<{ task: string }>) {
        byTask.set(r.task, (byTask.get(r.task) ?? 0) + 1);
      }
      const topTasks = [...byTask.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([t, n]) => `"${t}" (${n})`);
      // Round 18: tasks are LLM-generated and can hit the 200-char DB
      // constraint. Three of those in the title would overflow Sentry's
      // ~200-char truncation, splitting fingerprints. Cap the title at
      // SENTRY_TITLE_MAX with "+N more" overflow; full task list stays
      // in extra.top_failing_tasks for the operator to drill into.
      const prefix = `walkthrough bad-outcome rate ${Math.round(rate * 100)}% — top failing: `;
      const tailWithCap = topTasks.length > 0
        ? truncateListForSentryTitle(prefix, topTasks)
        : 'no tasks identified';
      const alertTitle = prefix + tailWithCap;

      log.warn('[walkthrough-health-alert] bad-outcome rate above threshold', {
        requestId,
        rate: Math.round(rate * 1000) / 10,
        total: row.total,
        topTasks,
        breakdown: {
          completed: row.completed,
          user_stopped: row.user_stopped,
          hit_step_cap: row.hit_step_cap,
          errored: row.errored,
          timed_out: row.timed_out,
          cannot_help: row.cannot_help,
          still_active: row.still_active,
        },
      });
      captureMessage(alertTitle, {
        subsystem: 'walkthrough',
        cron: 'walkthrough-health-alert',
        day: row.day,
        bad_outcome_pct: Math.round(rate * 1000) / 10,
        total: row.total,
        hit_step_cap: row.hit_step_cap,
        errored: row.errored,
        timed_out: row.timed_out,
        top_failing_tasks: topTasks,
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
              cannot_help: row.cannot_help,
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
