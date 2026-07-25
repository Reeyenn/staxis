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
import { PMS_RAW_BUCKET } from '@/lib/pms-inbox/report-files';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const RETENTION_DAYS = 7;
// Setup-link emails are needed during onboarding, so they live longer than codes.
const MSG_RETENTION_DAYS = 30;
/** An upload that hasn't landed in an hour is never going to. */
const PENDING_UPLOAD_STALE_MINUTES = 60;
/** Bound each sweep so one run can't blow the function's time budget. */
const SWEEP_BATCH = 500;

export interface ReportIntakeSweepResult {
  stuckFailed: number;
  quarantinePurged: number;
  retentionPurged: number;
  errors: string[];
}

/**
 * Exported for testing: the whole report-intake sweep, with Supabase reached
 * only through the module-level supabaseAdmin so tests can stub it.
 */
export async function sweepReportIntake(requestId: string): Promise<ReportIntakeSweepResult> {
  const result: ReportIntakeSweepResult = {
    stuckFailed: 0,
    quarantinePurged: 0,
    retentionPurged: 0,
    errors: [],
  };

  // ── 1. Stuck pending uploads → failed ───────────────────────────────────
  const staleCutoff = new Date(Date.now() - PENDING_UPLOAD_STALE_MINUTES * 60 * 1000).toISOString();
  const { data: stuck, error: stuckErr } = await supabaseAdmin
    .from('pms_report_files')
    .update({
      status: 'failed',
      last_error: `upload never completed within ${PENDING_UPLOAD_STALE_MINUTES} minutes`,
    })
    .eq('status', 'pending_upload')
    .lt('received_at', staleCutoff)
    .select('id');
  if (stuckErr) {
    result.errors.push(`stuck sweep: ${stuckErr.message}`);
  } else {
    result.stuckFailed = (stuck ?? []).length;
  }

  // ── 2. Quarantined PAN → delete the bytes now, keep the receipt ─────────
  result.quarantinePurged = await purgeRawObjects(
    await selectPurgeable({ status: 'quarantined_pan' }, result),
    result,
    requestId,
  );

  // ── 3. Per-hotel retention policy ───────────────────────────────────────
  const { data: policies, error: policyErr } = await supabaseAdmin
    .from('scraper_credentials')
    .select('property_id, report_raw_retention_days')
    .not('report_raw_retention_days', 'is', null);
  if (policyErr) {
    result.errors.push(`retention policy read: ${policyErr.message}`);
    return result;
  }
  for (const row of (policies ?? []) as Array<{ property_id: string; report_raw_retention_days: number }>) {
    const days = Number(row.report_raw_retention_days);
    if (!Number.isFinite(days) || days <= 0) continue;
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const expired = await selectPurgeable(
      { propertyId: row.property_id, receivedBefore: cutoff },
      result,
    );
    result.retentionPurged += await purgeRawObjects(expired, result, requestId);
  }

  return result;
}

interface PurgeableRow {
  id: string;
  storage_path: string;
}

/** Rows that still hold bytes and match the given scope. */
async function selectPurgeable(
  scope: { status?: string; propertyId?: string; receivedBefore?: string },
  result: ReportIntakeSweepResult,
): Promise<PurgeableRow[]> {
  let q = supabaseAdmin
    .from('pms_report_files')
    .select('id, storage_path')
    .not('storage_path', 'is', null)
    .limit(SWEEP_BATCH);
  if (scope.status) q = q.eq('status', scope.status);
  if (scope.propertyId) q = q.eq('property_id', scope.propertyId);
  if (scope.receivedBefore) q = q.lt('received_at', scope.receivedBefore);
  const { data, error } = await q;
  if (error) {
    result.errors.push(`purge select: ${error.message}`);
    return [];
  }
  return ((data ?? []) as Array<{ id: string; storage_path: string | null }>)
    .filter((r): r is PurgeableRow => typeof r.storage_path === 'string' && r.storage_path.length > 0);
}

/**
 * Delete the objects, then null storage_path + stamp raw_purged_at TOGETHER —
 * the 0340 CHECK ((raw_purged_at is null) = (storage_path is not null))
 * rejects the write otherwise, which is what guarantees a purge can never
 * erase the record that a number came from somewhere.
 *
 * Order matters: objects first. If the DB update then fails, the next run
 * re-attempts and Storage remove() is idempotent. The reverse order could
 * leave a live object with no path recorded — an orphan nobody can find.
 */
async function purgeRawObjects(
  rows: PurgeableRow[],
  result: ReportIntakeSweepResult,
  requestId: string,
): Promise<number> {
  if (rows.length === 0) return 0;
  const paths = rows.map((r) => r.storage_path);
  const { error: rmErr } = await supabaseAdmin.storage.from(PMS_RAW_BUCKET).remove(paths);
  if (rmErr) {
    result.errors.push(`storage remove: ${rmErr.message}`);
    log.error('[cron/pms-auth-codes-purge] raw object remove failed', { requestId, error: rmErr.message });
    return 0;
  }
  const { data: updated, error: updErr } = await supabaseAdmin
    .from('pms_report_files')
    .update({ storage_path: null, raw_purged_at: new Date().toISOString() })
    .in('id', rows.map((r) => r.id))
    .select('id');
  if (updErr) {
    result.errors.push(`purge stamp: ${updErr.message}`);
    return 0;
  }
  return (updated ?? []).length;
}

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
