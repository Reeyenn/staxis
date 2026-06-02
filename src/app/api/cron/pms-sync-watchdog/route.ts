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

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const unauth = requireCronSecret(req);
  if (unauth) return unauth;

  try {
    const { data: props, error: propErr } = await supabaseAdmin
      .from('properties')
      .select('id, name')
      .eq('pms_writeback_enabled', true);
    if (propErr) throw new Error(`properties read: ${propErr.message}`);

    const phone = (env.OPS_ALERT_PHONE || '').trim();
    const nowMs = Date.now();
    const failedCutoff = new Date(nowMs - FAILED_LOOKBACK_MS).toISOString();
    const pendingCutoff = new Date(nowMs - PENDING_STUCK_MS).toISOString();

    let checked = 0;
    let alerted = 0;
    let recovered = 0;

    for (const p of props ?? []) {
      checked++;
      const propId = p.id as string;
      const propName = (p.name as string | null) ?? propId;

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

    await writeCronHeartbeat('pms-sync-watchdog', { requestId, notes: { checked, alerted, recovered } });
    return ok({ checked, alerted, recovered }, { requestId });
  } catch (e) {
    log.error('[cron/pms-sync-watchdog] failed', { requestId, err: e });
    return err('pms-sync-watchdog failed', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }
}
