/**
 * Server-side retention sweep for the PMS report-intake raw zone.
 *
 * Kept outside the cron route because Next route modules may export only
 * handlers and recognized route configuration. The route owns scheduling and
 * response semantics; this module owns the reusable/testable sweep itself.
 */

import { log } from '@/lib/log';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { PMS_RAW_BUCKET } from '@/lib/pms-inbox/report-files';

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
