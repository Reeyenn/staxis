/**
 * GET /api/cron/process-agent-schedules
 *
 * Every five minutes, delivers due one-shot reminders and materializes due
 * recurring Communications tasks. These jobs used to be invoked by the
 * retired process-sms-jobs worker; keeping them on their own cron avoids
 * coupling agent scheduling to the SMS transport.
 *
 * Auth: CRON_SECRET bearer (attached by Vercel cron).
 */

import { NextRequest } from 'next/server';
import { requireCronSecret } from '@/lib/api-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { writeCronHeartbeat } from '@/lib/cron-heartbeat';
import { fireDueReminders } from '@/lib/reminders/store';
import { spawnDueRecurringTodos } from '@/lib/recurring-tasks/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const cronGate = requireCronSecret(req);
  if (cronGate) return cronGate;

  try {
    const now = new Date();
    const [reminders, recurringTodos] = await Promise.all([
      fireDueReminders(now),
      spawnDueRecurringTodos(now),
    ]);

    // Per-row isolation lets the batch make progress, but any failed row must
    // still fail the invocation so Vercel retries and operators do not see a
    // green scheduler run for partially undelivered work.
    if (reminders.failed > 0 || recurringTodos.failed > 0) {
      throw new Error(
        `${reminders.failed} reminder(s) and ${recurringTodos.failed} recurring task(s) failed`,
      );
    }

    const result = { reminders, recurringTodos };
    await writeCronHeartbeat('process-agent-schedules', {
      requestId,
      notes: result,
    });

    return ok(result, { requestId });
  } catch (error) {
    log.error('[process-agent-schedules] failed', {
      requestId,
      err: error instanceof Error ? error.message : String(error),
    });
    return err(
      'agent schedule processing failed',
      { requestId, status: 500, code: ApiErrorCode.InternalError },
    );
  }
}
