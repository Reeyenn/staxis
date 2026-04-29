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

import { NextRequest, NextResponse } from 'next/server';
import { requireCronSecret } from '@/lib/api-auth';
import { processSmsJobs, resetStuckSmsJobs } from '@/lib/sms-jobs';
import { getOrMintRequestId, log } from '@/lib/log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

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
    const durationMs = Date.now() - startedAt;

    log.info('[cron/process-sms-jobs] tick', {
      requestId,
      stuckReset,
      ...result,
      durationMs,
    });

    return NextResponse.json({
      ok: true,
      requestId,
      stuckReset,
      claimed: result.claimed,
      sent: result.sent,
      retried: result.retried,
      dead: result.dead,
      durationMs,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('[cron/process-sms-jobs] failed', { requestId, msg });
    return NextResponse.json(
      { ok: false, requestId, error: 'process-sms-jobs failed', detail: msg },
      { status: 500 },
    );
  }
}
