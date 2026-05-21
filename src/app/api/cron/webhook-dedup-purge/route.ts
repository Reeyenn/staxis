/**
 * GET /api/cron/webhook-dedup-purge
 *
 * Runs daily. Purges old rows from the three webhook-dedup tables:
 *   - processed_twilio_webhooks
 *   - processed_sentry_webhooks
 *   - stripe_processed_events
 *
 * Each table exists to absorb duplicate webhook deliveries from the
 * upstream provider. Their dedup windows are SHORT — Twilio retries
 * for hours, Stripe for up to 3 days, Sentry for minutes. So a 30-day
 * retention is comfortably past any provider's retry window while
 * keeping the tables bounded.
 *
 * Audit Batch 2 (F-09). Each table has a `processed_at` index already
 * (per migrations 0035 and 0139), so the cutoff range scan is cheap.
 *
 * Auth: CRON_SECRET bearer.
 *
 * Returns: { twilio: n, sentry: n, stripe: n, cutoff: ISO }
 */

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireCronSecret } from '@/lib/api-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { writeCronHeartbeat } from '@/lib/cron-heartbeat';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const RETENTION_DAYS = 30;

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);

  const cronGate = requireCronSecret(req);
  if (cronGate) return cronGate;

  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();

  // Each table has its own PK column. Supabase-js's `.delete().select(col)`
  // returns the deleted rows projected onto `col`, which is how we count.
  // The original (audit-02 ship) passed `.select('1')` — `'1'` isn't a real
  // column, so PostgREST returned an error and the count metric was always
  // `-1`. Per-table PK names live here:
  //   processed_twilio_webhooks → message_sid (PK)
  //   processed_sentry_webhooks → event_id    (PK)
  //   stripe_processed_events   → event_id    (PK)
  async function purge(table: string, countColumn: string): Promise<number> {
    const { data, error } = await supabaseAdmin
      .from(table)
      .delete()
      .lt('processed_at', cutoff)
      .select(countColumn);
    if (error) {
      // Don't fail the whole cron on a single-table error — log it and
      // continue. The next tick retries; meanwhile the other tables
      // still get pruned.
      log.error(`[cron/webhook-dedup-purge] ${table} delete failed`, {
        requestId,
        error: error.message,
      });
      return -1;
    }
    return (data ?? []).length;
  }

  const [twilio, sentry, stripe] = await Promise.all([
    purge('processed_twilio_webhooks', 'message_sid'),
    purge('processed_sentry_webhooks', 'event_id'),
    purge('stripe_processed_events',   'event_id'),
  ]);

  const anyFailed = twilio < 0 || sentry < 0 || stripe < 0;
  if (anyFailed) {
    // At least one table failed. Still write the heartbeat so monitoring
    // sees the run, but return a non-2xx so the workflow alerts.
    await writeCronHeartbeat('webhook-dedup-purge', {
      requestId,
      notes: { twilio, sentry, stripe, partial: true },
    });
    return err('Partial purge failure — see server logs', {
      requestId,
      status: 500,
      code: ApiErrorCode.InternalError,
      details: { twilio, sentry, stripe, cutoff },
    });
  }

  await writeCronHeartbeat('webhook-dedup-purge', {
    requestId,
    notes: { twilio, sentry, stripe },
  });

  return ok({
    twilio,
    sentry,
    stripe,
    cutoff,
    retentionDays: RETENTION_DAYS,
  }, { requestId });
}
