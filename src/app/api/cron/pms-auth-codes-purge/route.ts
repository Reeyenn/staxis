/**
 * GET /api/cron/pms-auth-codes-purge
 *
 * Runs daily. Purges old rows from pms_auth_codes (0274) and pms_inbox_messages
 * (0275). Codes are single-use and valid for only minutes — we keep 7 days for
 * the masked /admin/pms-inbox viewer, then delete. Full setup emails are needed
 * during the onboarding window, so they get a longer 30-day retention, then are
 * purged too. Both bound the (sensitive) tables — spent 2FA codes and setup
 * links — at rest.
 *
 * Auth: CRON_SECRET bearer.
 * Returns: { purged, cutoff, retentionDays, messagesPurged, msgCutoff, messagesRetentionDays }
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
// Setup-link emails are needed during onboarding, so they live longer than codes.
const MSG_RETENTION_DAYS = 30;

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

  // Full-message purge (0275). NON-FATAL relative to the codes purge above —
  // the codes are already deleted; a messages-table hiccup must not fail the run.
  const msgCutoff = new Date(Date.now() - MSG_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { data: msgData, error: msgError } = await supabaseAdmin
    .from('pms_inbox_messages')
    .delete()
    .lt('received_at', msgCutoff)
    .select('id');
  let messagesPurged = (msgData ?? []).length;
  if (msgError) {
    log.error('[cron/pms-auth-codes-purge] messages delete failed', { requestId, error: msgError.message });
    messagesPurged = -1; // sentinel: codes purged OK, messages purge failed (see logs)
  }

  await writeCronHeartbeat('pms-auth-codes-purge', { requestId, notes: { purged, messagesPurged } });

  return ok(
    {
      purged,
      cutoff,
      retentionDays: RETENTION_DAYS,
      messagesPurged,
      msgCutoff,
      messagesRetentionDays: MSG_RETENTION_DAYS,
    },
    { requestId },
  );
}
