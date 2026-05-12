/**
 * Cron heartbeat helper. Call `writeCronHeartbeat(name)` at the end of
 * every successful cron route. The doctor's `cron_heartbeats_fresh`
 * check reads back and reports any cron whose last heartbeat is older
 * than 2× its expected cadence.
 *
 * Why this exists:
 *   GitHub Actions tells us a workflow "succeeded" if its HTTP call to
 *   the cron route returned 200. The route can return 200 even when
 *   every per-property write failed — the silent-success bug class we
 *   spent two audit passes closing. A heartbeat written AS THE LAST
 *   THING the route does, AFTER every real-work write, is a much
 *   tighter signal: if it lands, the cron actually finished its job.
 *
 *   See FAILSAFES.md "Cron heartbeats" section for the contract.
 *
 * Idempotent. Failure is logged but never thrown — the cron's
 * customer-facing work already succeeded; we don't want a heartbeat
 * write failure to mark the cron as failed.
 */

import { supabaseAdmin } from '@/lib/supabase-admin';
import { log } from '@/lib/log';

export interface CronHeartbeatExtras {
  requestId?: string;
  notes?: Record<string, unknown>;
}

/**
 * Upsert the cron's heartbeat row. Names must match the values the
 * doctor's expected-crons list checks — see FAILSAFES.md for the
 * canonical list.
 */
export async function writeCronHeartbeat(
  cronName: string,
  extras: CronHeartbeatExtras = {},
): Promise<void> {
  try {
    const { error } = await supabaseAdmin
      .from('cron_heartbeats')
      .upsert(
        {
          cron_name: cronName,
          last_success_at: new Date().toISOString(),
          last_request_id: extras.requestId ?? null,
          notes: extras.notes ?? {},
        },
        { onConflict: 'cron_name' },
      );
    if (error) {
      log.warn('cron-heartbeat: upsert failed', {
        requestId: extras.requestId,
        cronName,
        err: error as unknown as Error,
      });
    }
  } catch (err) {
    log.warn('cron-heartbeat: upsert threw', {
      requestId: extras.requestId,
      cronName,
      err: err as Error,
    });
  }
}
