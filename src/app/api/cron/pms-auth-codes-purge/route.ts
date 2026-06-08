/**
 * GET /api/cron/pms-auth-codes-purge
 *
 * Runs daily. Purges old rows from pms_auth_codes (migration 0274). Codes are
 * single-use and operationally valid for only minutes, but we keep a short
 * audit trail for the masked /admin/pms-inbox viewer, then delete. 7 days is
 * comfortably past any operational use and keeps the (sensitive) table — and
 * the count of spent 2FA codes lingering at rest — bounded.
 *
 * Auth: CRON_SECRET bearer.
 * Returns: { purged: n, cutoff: ISO }
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

const RETENTION_DAYS = 7;

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);

  const cronGate = requireCronSecret(req);
  if (cronGate) return cronGate;

  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();

  // Purge by received_at — covers both consumed and stale-unconsumed rows.
  // `.delete().select('id')` returns the deleted PKs so we can count them.
  const { data, error } = await supabaseAdmin
    .from('pms_auth_codes')
    .delete()
    .lt('received_at', cutoff)
    .select('id');

  if (error) {
    log.error('[cron/pms-auth-codes-purge] delete failed', { requestId, error: error.message });
    await writeCronHeartbeat('pms-auth-codes-purge', {
      requestId,
      notes: { purged: -1, partial: true },
    });
    return err('purge failed — see server logs', {
      requestId,
      status: 500,
      code: ApiErrorCode.InternalError,
      details: { cutoff },
    });
  }

  const purged = (data ?? []).length;
  await writeCronHeartbeat('pms-auth-codes-purge', { requestId, notes: { purged } });

  return ok({ purged, cutoff, retentionDays: RETENTION_DAYS }, { requestId });
}
