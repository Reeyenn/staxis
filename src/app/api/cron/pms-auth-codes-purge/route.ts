/**
 * GET /api/cron/pms-auth-codes-purge
 *
 * Runs daily. Owns retention for the whole PMS-inbox table family:
 *
 *   - pms_auth_codes (0274) — single-use 2FA codes, valid for minutes. Kept 7
 *     days for the masked /admin/pms-inbox viewer, then deleted.
 *   - pms_inbox_messages (0275) — full setup/report emails. 30 days.
 *   - pms_report_files (0340) — the raw report zone. Three sweeps, added here
 *     rather than in a new cron because this route already owns this family
 *     and its cadence:
 *       1. Stuck 'pending_upload' rows older than an hour → 'failed'. An
 *          abandoned upload becomes a VISIBLE row instead of a silent loss.
 *       2. Quarantined-PAN files → raw object deleted IMMEDIATELY, receipt
 *          kept. Holding cardholder data for a retention window is exactly the
 *          PCI scope we refuse to take on.
 *       3. Retention purge, per-hotel POLICY (scraper_credentials
 *          .report_raw_retention_days). NULL means keep forever, which is the
 *          default — the founder has not decided a window, and this code must
 *          not decide one for him. Purging nulls storage_path and stamps
 *          raw_purged_at in the same write (the 0340 CHECK enforces the pair),
 *          so the receipt always outlives the file.
 *
 * Auth: CRON_SECRET bearer.
 */

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireCronSecret } from '@/lib/api-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { writeCronHeartbeat } from '@/lib/cron-heartbeat';
import {
  sweepReportIntake,
  type ReportIntakeSweepResult,
} from '@/lib/pms-inbox/report-intake-sweep';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

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

  // Raw report zone (0340). NON-FATAL for the same reason as the messages
  // purge: the codes are already deleted and this run must still be recorded.
  let intake: ReportIntakeSweepResult = {
    stuckFailed: 0, quarantinePurged: 0, retentionPurged: 0, errors: [],
  };
  try {
    intake = await sweepReportIntake(requestId);
    if (intake.errors.length > 0) {
      log.error('[cron/pms-auth-codes-purge] report intake sweep had errors', {
        requestId, errors: intake.errors,
      });
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    intake.errors.push(message);
    log.error('[cron/pms-auth-codes-purge] report intake sweep threw', { requestId, error: message });
  }

  await writeCronHeartbeat('pms-auth-codes-purge', {
    requestId,
    notes: {
      purged,
      messagesPurged,
      reportStuckFailed: intake.stuckFailed,
      reportQuarantinePurged: intake.quarantinePurged,
      reportRetentionPurged: intake.retentionPurged,
    },
  });

  return ok(
    {
      purged,
      cutoff,
      retentionDays: RETENTION_DAYS,
      messagesPurged,
      msgCutoff,
      messagesRetentionDays: MSG_RETENTION_DAYS,
      reportIntake: intake,
    },
    { requestId },
  );
}
