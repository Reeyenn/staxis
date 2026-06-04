/**
 * GET /api/cron/pms-sync-watchdog  (Phase 3.3)
 *
 * Every 5 min: for each property with PMS write-back enabled, detect a "stuck"
 * sync and text the founder ONCE per incident (+ one on recovery). Stuck =
 *   - a pms.write job that FAILED (gave up; max_attempts=1) in the last 30 min, OR
 *   - a pms.write job stuck 'queued'/'running' for >10 min (worker down / wedged).
 *
 * Dedupe via pms_sync_alert_state (per-property state machine) so a bad PMS hour
 * can't flood the phone: one "stuck" text on the ok->alerting edge, one
 * "recovered" text on the alerting->ok edge.
 *
 * Auth: CRON_SECRET bearer, same as every other cron here. Founder phone =
 * OPS_ALERT_PHONE. Worker *aliveness* with no pending work is covered separately
 * by /api/admin/doctor (cua_sessions_alive) — this watchdog is about writes that
 * are actually failing to land.
 */
import { NextRequest } from 'next/server';
import { requireCronSecret } from '@/lib/api-auth';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { sendSms } from '@/lib/sms';
import { env } from '@/lib/env';
import { getOrMintRequestId, log } from '@/lib/log';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { writeCronHeartbeat } from '@/lib/cron-heartbeat';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const FAILED_LOOKBACK_MS = 30 * 60_000; // a write that gave up in the last 30 min
const PENDING_STUCK_MS = 10 * 60_000; // a write not drained within 10 min

/**
 * A terminally-failed pms.write (max_attempts=1, never retried) is an UNRESOLVED
 * incident, not a transient blip. It only lands in the FAILED_LOOKBACK_MS window
 * for 30 min, after which the "stuck" check stops seeing it — so without this
 * guard a property would "recover" purely by aging out, firing a false
 * "PMS sync recovered" text even though the write never happened.
 *
 * This compares the most-recent FAILED pms.write against the most-recent
 * COMPLETED one (both stamp completed_at via the workflow-runtime). A failure
 * with no newer success means the write still hasn't landed → the incident is
 * unresolved and recovery must NOT fire. Once a real successful write lands
 * (its completed_at is newer than the last failure's, or there was never a
 * failure), this returns false and the honest recovery edge can proceed.
 */
async function hasUnresolvedWriteFailure(propId: string): Promise<boolean> {
  const [lastFailed, lastCompleted] = await Promise.all([
    supabaseAdmin
      .from('workflow_jobs')
      .select('completed_at')
      .eq('property_id', propId)
      .eq('kind', 'pms.write')
      .eq('status', 'failed')
      .not('completed_at', 'is', null)
      .order('completed_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabaseAdmin
      .from('workflow_jobs')
      .select('completed_at')
      .eq('property_id', propId)
      .eq('kind', 'pms.write')
      .eq('status', 'completed')
      .not('completed_at', 'is', null)
      .order('completed_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);
  const failedAt = (lastFailed.data?.completed_at as string | null) ?? null;
  if (!failedAt) return false; // no terminal failure on record → nothing unresolved
  const completedAt = (lastCompleted.data?.completed_at as string | null) ?? null;
  // Unresolved iff no successful write has landed AT OR AFTER the last failure.
  return !completedAt || completedAt < failedAt;
}

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const unauth = requireCronSecret(req);
  if (unauth) return unauth;

  try {
    const phone = (env.OPS_ALERT_PHONE || '').trim();
    const nowMs = Date.now();
    const failedCutoff = new Date(nowMs - FAILED_LOOKBACK_MS).toISOString();
    const pendingCutoff = new Date(nowMs - PENDING_STUCK_MS).toISOString();

    // The gated set: properties with write-back currently enabled.
    const { data: props, error: propErr } = await supabaseAdmin
      .from('properties')
      .select('id, name')
      .eq('pms_writeback_enabled', true);
    if (propErr) throw new Error(`properties read: ${propErr.message}`);

    // Fix (#1 blind-when-disabled): the documented mitigation for a misbehaving
    // write-back is to flip pms_writeback_enabled OFF — which drops the property
    // from the gated set above and makes any still-queued/running/failed pms.write
    // job invisible (so it never alerts). Detect stuck/failed pms.write jobs
    // INDEPENDENTLY of the gate: scan ALL properties for failed/queued/running
    // pms.write jobs in the relevant windows, then union those property ids with
    // the gated set so the per-property checks below cover both.
    const propMap = new Map<string, string>();
    for (const p of props ?? []) {
      propMap.set(p.id as string, ((p.name as string | null) ?? (p.id as string)));
    }

    const [ungatedFailed, ungatedPending] = await Promise.all([
      supabaseAdmin
        .from('workflow_jobs')
        .select('property_id')
        .eq('kind', 'pms.write')
        .eq('status', 'failed')
        .gte('completed_at', failedCutoff),
      supabaseAdmin
        .from('workflow_jobs')
        .select('property_id')
        .eq('kind', 'pms.write')
        .in('status', ['queued', 'running'])
        .lt('created_at', pendingCutoff),
    ]);
    if (ungatedFailed.error) throw new Error(`ungated failed-jobs read: ${ungatedFailed.error.message}`);
    if (ungatedPending.error) throw new Error(`ungated pending-jobs read: ${ungatedPending.error.message}`);

    const extraIds = new Set<string>();
    for (const row of [...(ungatedFailed.data ?? []), ...(ungatedPending.data ?? [])]) {
      const pid = (row.property_id as string | null) ?? null;
      if (pid && !propMap.has(pid)) extraIds.add(pid);
    }
    if (extraIds.size > 0) {
      const { data: extraProps, error: extraErr } = await supabaseAdmin
        .from('properties')
        .select('id, name')
        .in('id', [...extraIds]);
      if (extraErr) throw new Error(`extra properties read: ${extraErr.message}`);
      for (const p of extraProps ?? []) {
        propMap.set(p.id as string, ((p.name as string | null) ?? (p.id as string)));
      }
      // Any id with jobs but no properties row still gets checked, named by id.
      for (const pid of extraIds) {
        if (!propMap.has(pid)) propMap.set(pid, pid);
      }
    }

    let checked = 0;
    let alerted = 0;
    let recovered = 0;

    for (const [propIdKey, propNameVal] of propMap) {
      checked++;
      const propId = propIdKey;
      const propName = propNameVal;

      const [failedRes, pendingRes] = await Promise.all([
        supabaseAdmin
          .from('workflow_jobs')
          .select('id', { count: 'exact', head: true })
          .eq('property_id', propId)
          .eq('kind', 'pms.write')
          .eq('status', 'failed')
          .gte('completed_at', failedCutoff),
        supabaseAdmin
          .from('workflow_jobs')
          .select('id', { count: 'exact', head: true })
          .eq('property_id', propId)
          .eq('kind', 'pms.write')
          .in('status', ['queued', 'running'])
          .lt('created_at', pendingCutoff),
      ]);
      const failedCount = failedRes.count ?? 0;
      const pendingCount = pendingRes.count ?? 0;
      const stuck = failedCount > 0 || pendingCount > 0;
      const reason = !stuck
        ? null
        : failedCount > 0
          ? `${failedCount} PMS write(s) failing`
          : `${pendingCount} PMS write(s) not syncing`;

      const { data: st } = await supabaseAdmin
        .from('pms_sync_alert_state')
        .select('state')
        .eq('property_id', propId)
        .maybeSingle();
      const wasAlerting = st?.state === 'alerting';

      if (stuck && !wasAlerting) {
        if (phone) {
          await sendSms(
            phone,
            `Staxis: PMS sync is stuck at ${propName} — ${reason}. Check /admin/property-sessions.`,
          ).catch((e) => log.error('[pms-sync-watchdog] alert sms failed', { err: (e as Error).message }));
        }
        await supabaseAdmin.from('pms_sync_alert_state').upsert(
          { property_id: propId, state: 'alerting', last_alert_at: new Date().toISOString(), last_reason: reason, updated_at: new Date().toISOString() },
          { onConflict: 'property_id' },
        );
        alerted++;
      } else if (!stuck && wasAlerting) {
        // A terminally-failed pms.write only sits in the failed-lookback window
        // for 30 min, so `stuck` can flip false purely by aging out even though
        // the write never landed. Don't call that "recovered": only recover once
        // a subsequent successful write exists. Until then, stay 'alerting' (and
        // refresh the reason) so the incident isn't silently auto-resolved.
        if (await hasUnresolvedWriteFailure(propId)) {
          await supabaseAdmin.from('pms_sync_alert_state').upsert(
            {
              property_id: propId,
              state: 'alerting',
              last_reason: 'PMS write still failed — manual fix needed',
              updated_at: new Date().toISOString(),
            },
            { onConflict: 'property_id' },
          );
        } else {
          if (phone) {
            await sendSms(phone, `Staxis: PMS sync recovered at ${propName}.`).catch((e) =>
              log.error('[pms-sync-watchdog] recovery sms failed', { err: (e as Error).message }),
            );
          }
          await supabaseAdmin.from('pms_sync_alert_state').upsert(
            { property_id: propId, state: 'ok', last_recovery_at: new Date().toISOString(), last_reason: null, updated_at: new Date().toISOString() },
            { onConflict: 'property_id' },
          );
          recovered++;
        }
      }
    }

    // Fix (#2 dedupe wedge): a property that was 'alerting' and then got write-back
    // disabled would never fire its recovery edge (it dropped out of the loop),
    // staying wedged in 'alerting' forever — which suppresses ALL future incidents
    // (the stuck guard sees wasAlerting=true). The un-gated scan in #1 largely
    // subsumes this (a property with an outstanding stuck job is now in propMap),
    // but sweep explicitly for orphaned alerts to be safe: rows still 'alerting'
    // that are NOT in the merged set get a recovery text and flip back to 'ok'
    // once we confirm they have no outstanding stuck/failed pms.write job.
    const { data: orphanAlerts, error: orphanErr } = await supabaseAdmin
      .from('pms_sync_alert_state')
      .select('property_id')
      .eq('state', 'alerting');
    if (orphanErr) throw new Error(`orphan alert-state read: ${orphanErr.message}`);

    for (const row of orphanAlerts ?? []) {
      const propId = (row.property_id as string | null) ?? null;
      if (!propId || propMap.has(propId)) continue; // already handled in the main loop

      const [failedRes, pendingRes] = await Promise.all([
        supabaseAdmin
          .from('workflow_jobs')
          .select('id', { count: 'exact', head: true })
          .eq('property_id', propId)
          .eq('kind', 'pms.write')
          .eq('status', 'failed')
          .gte('completed_at', failedCutoff),
        supabaseAdmin
          .from('workflow_jobs')
          .select('id', { count: 'exact', head: true })
          .eq('property_id', propId)
          .eq('kind', 'pms.write')
          .in('status', ['queued', 'running'])
          .lt('created_at', pendingCutoff),
      ]);
      if ((failedRes.count ?? 0) > 0 || (pendingRes.count ?? 0) > 0) continue; // still genuinely stuck

      // Same aging-out trap as the main loop: a terminal failure that has fallen
      // out of the 30-min window leaves both counts at 0, but the write still
      // never landed. Don't auto-recover it here — keep the row 'alerting' until
      // a subsequent successful write exists.
      if (await hasUnresolvedWriteFailure(propId)) continue;

      const { data: prop } = await supabaseAdmin
        .from('properties')
        .select('name')
        .eq('id', propId)
        .maybeSingle();
      const propName = (prop?.name as string | null) ?? propId;

      if (phone) {
        await sendSms(phone, `Staxis: PMS sync recovered at ${propName}.`).catch((e) =>
          log.error('[pms-sync-watchdog] recovery sms failed', { err: (e as Error).message }),
        );
      }
      await supabaseAdmin.from('pms_sync_alert_state').upsert(
        { property_id: propId, state: 'ok', last_recovery_at: new Date().toISOString(), last_reason: null, updated_at: new Date().toISOString() },
        { onConflict: 'property_id' },
      );
      recovered++;
    }

    await writeCronHeartbeat('pms-sync-watchdog', { requestId, notes: { checked, alerted, recovered } });
    return ok({ checked, alerted, recovered }, { requestId });
  } catch (e) {
    log.error('[cron/pms-sync-watchdog] failed', { requestId, err: e });
    return err('pms-sync-watchdog failed', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }
}
