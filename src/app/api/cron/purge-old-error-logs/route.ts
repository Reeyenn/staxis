/**
 * GET /api/cron/purge-old-error-logs
 *
 * Runs daily via .github/workflows/purge-old-error-logs-cron.yml.
 *
 * Deletes rows in `error_logs` older than 72 hours. The admin Live
 * Hotels tab's "Recent errors" widget reads from this table — the
 * widget caps the displayed window at 72h, so anything older is dead
 * weight in the database. Without this purge, error_logs grows
 * unboundedly and the (property_id, ts desc) index from migration 0066
 * spends more pages on noise.
 *
 * Conservative retention: 72h matches the widget's display window. If
 * we ever want forensic history beyond that, we should pipe errors to
 * Sentry / a log store with longer retention rather than letting the
 * primary DB hold them indefinitely.
 *
 * Auth: CRON_SECRET bearer.
 *
 * Returns: { purged: number, cutoff: ISO }
 */

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireCronSecret } from '@/lib/api-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId } from '@/lib/log';
import { writeCronHeartbeat } from '@/lib/cron-heartbeat';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const RETENTION_HOURS = 72;

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);

  const cronGate = requireCronSecret(req);
  if (cronGate) return cronGate;

  const cutoff = new Date(Date.now() - RETENTION_HOURS * 60 * 60 * 1000).toISOString();

  // DELETE … RETURNING id — gives us a count without an extra COUNT
  // round-trip. supabase-js's .delete() returns the deleted rows when
  // you chain .select(); we only need ids, not the bodies.
  const { data: deleted, error } = await supabaseAdmin
    .from('error_logs')
    .delete()
    .lt('ts', cutoff)
    .select('id');

  if (error) {
    return err(`Could not purge error_logs: ${error.message}`, {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }

  const purgedCount = (deleted ?? []).length;

  // ── api_limits janitor (May 2026 audit pass-4) ─────────────────────
  // staxis_api_limit_cleanup() drops rows with hour_bucket > 48h old.
  // The doctor's api_limits_writable probe writes one row every 5 min
  // (288/day), so without periodic cleanup the table accumulates the
  // probe rows + any real rate-limit rows from SMS-firing endpoints.
  // The cleanup function existed since migration 0008 but nothing
  // ever called it. Wiring it into this daily janitor cron keeps the
  // table small without spinning up a separate workflow.
  let apiLimitsPurged: number | null = null;
  try {
    const { data: cleanupCount, error: cleanupErr } = await supabaseAdmin.rpc(
      'staxis_api_limit_cleanup',
    );
    if (cleanupErr) {
      // Don't fail the cron — error_logs purge already succeeded.
      // The next tick will retry the api_limits cleanup.
      apiLimitsPurged = null;
    } else {
      apiLimitsPurged = Number(cleanupCount) || 0;
    }
  } catch {
    apiLimitsPurged = null;
  }

  await writeCronHeartbeat('purge-old-error-logs', {
    requestId,
    notes: { purged: purgedCount, api_limits_purged: apiLimitsPurged },
  });
  return ok({
    purged: purgedCount,
    api_limits_purged: apiLimitsPurged,
    cutoff,
    retentionHours: RETENTION_HOURS,
  }, { requestId });
}
