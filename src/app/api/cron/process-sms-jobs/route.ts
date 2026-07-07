/**
 * GET /api/cron/process-sms-jobs
 *
 * Worker tick for the SMS jobs queue. Vercel cron hits this every minute
 * (configured in vercel.json). Two phases:
 *
 *   1. Reset rows stuck in 'sending' for >5min (worker died mid-call).
 *   2. Claim a batch and send each via Twilio. Successes flip to 'sent';
 *      transient failures bounce back to 'queued' with exponential backoff;
 *      terminal failures or exhausted retries flip to 'dead'.
 *
 * Auth: CRON_SECRET bearer token, same model as every other cron endpoint
 * in this codebase.
 *
 * Response: structured JSON summary of the tick. Useful for the
 * post-deploy smoke test and ad-hoc curl.
 */

import { NextRequest } from 'next/server';
import { requireCronSecret } from '@/lib/api-auth';
import { processSmsJobs, resetStuckSmsJobs } from '@/lib/sms-jobs';
import { getOrMintRequestId, log } from '@/lib/log';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { writeCronHeartbeat } from '@/lib/cron-heartbeat';
import { fireDueReminders } from '@/lib/reminders/store';
import { spawnDueRecurringTodos } from '@/lib/recurring-tasks/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Explicit cap (May 2026 audit pass-6). Vercel Pro default would be 300s
// but pinning here is defensive against future runtime upgrades AND
// documents the expected upper bound: TICK_LIMIT × per-job Twilio
// latency ≈ 50 × ~1s = ~50s, with headroom for slow Twilio calls.
export const maxDuration = 60;

// Hard cap on how many jobs one tick will process. Prevents a backlog
// from blowing the 30s function limit if Twilio is slow. Tune up if we
// add multi-property load.
const TICK_LIMIT = 50;

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const startedAt = Date.now();

  const unauth = requireCronSecret(req);
  if (unauth) return unauth;

  try {
    const stuckReset = await resetStuckSmsJobs(300); // 5 min
    const result = await processSmsJobs(TICK_LIMIT);

    // Ride this 5-minute tick to fire due AI-assistant reminders (0302) and
    // spawn today's recurring to-do instances (0303). Both are independent of
    // SMS and wrapped so a failure here can NEVER break the SMS worker — the
    // reminder/todo systems are best-effort per tick and self-heal (overdue
    // reminders fire next tick; recurring spawns are idempotent per day).
    let reminders = { due: 0, fired: 0, failed: 0 };
    try {
      reminders = await fireDueReminders();
    } catch (remErr) {
      log.error('[cron/process-sms-jobs] reminder firing failed (non-fatal)', {
        requestId, msg: remErr instanceof Error ? remErr.message : String(remErr),
      });
    }
    let recurring = { properties: 0, spawned: 0, skipped: 0 };
    try {
      recurring = await spawnDueRecurringTodos();
    } catch (recErr) {
      log.error('[cron/process-sms-jobs] recurring-todo spawn failed (non-fatal)', {
        requestId, msg: recErr instanceof Error ? recErr.message : String(recErr),
      });
    }

    const durationMs = Date.now() - startedAt;

    log.info('[cron/process-sms-jobs] tick', {
      requestId,
      stuckReset,
      ...result,
      reminders,
      recurring,
      durationMs,
    });

    await writeCronHeartbeat('process-sms-jobs', {
      requestId,
      notes: {
        claimed: result.claimed, sent: result.sent, retried: result.retried, dead: result.dead,
        remindersFired: reminders.fired, recurringSpawned: recurring.spawned,
      },
    });
    return ok({
      stuckReset,
      claimed: result.claimed,
      sent: result.sent,
      retried: result.retried,
      dead: result.dead,
      reminders,
      recurring,
      durationMs,
    }, { requestId });
  } catch (caughtErr) {
    const msg = caughtErr instanceof Error ? caughtErr.message : String(caughtErr);
    log.error('[cron/process-sms-jobs] failed', { requestId, msg });
    return err('process-sms-jobs failed', {
      requestId, status: 500, code: ApiErrorCode.InternalError, details: { detail: msg },
    });
  }
}
