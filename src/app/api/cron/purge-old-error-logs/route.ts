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

  return ok({
    purged: (deleted ?? []).length,
    cutoff,
    retentionHours: RETENTION_HOURS,
  }, { requestId });
}
