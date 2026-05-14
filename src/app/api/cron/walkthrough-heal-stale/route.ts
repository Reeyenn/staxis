/**
 * GET /api/cron/walkthrough-heal-stale
 *
 * Every 30 minutes. Closes `walkthrough_runs` rows still in 'active' status
 * after 30 minutes — they're orphans from a browser crash, network drop,
 * or any path where the client's /api/walkthrough/end call never fired.
 *
 * Without this cron the partial-unique-active index permanently blocks
 * the user from starting another walkthrough until staff intervention.
 *
 * Auth: CRON_SECRET bearer.
 *
 * Scale-readiness Phase 1B (2026-05-14): added when prepping for the
 * 300-hotel onboarding. At 1500 active users a 0.1% browser-crash rate
 * is 1-2 stuck users/day; without this they'd file support tickets.
 */

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireCronSecret } from '@/lib/api-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { writeCronHeartbeat } from '@/lib/cron-heartbeat';
import { captureMessage } from '@/lib/sentry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const cronGate = requireCronSecret(req);
  if (cronGate) return cronGate;

  try {
    const { data, error } = await supabaseAdmin.rpc('staxis_walkthrough_heal_stale', {
      p_dry_run: false,
    });

    if (error) {
      throw new Error(`walkthrough heal RPC failed: ${error.message}`);
    }

    const healedCount = (data as number) ?? 0;

    // Healed rows mean SOMETHING happened that prevented a clean /end call:
    // browser crash, tab killed mid-step, network drop. A few per day is
    // expected at 300-hotel scale; a SPIKE (e.g. 50 in one firing) is a
    // signal of a real problem (deploy with broken /end, etc.).
    if (healedCount > 0) {
      log.warn('[walkthrough-heal-stale] closed orphans', { requestId, healedCount });
      // Only escalate to Sentry on a meaningful number — single orphans
      // are routine background noise.
      if (healedCount >= 5) {
        captureMessage('walkthrough-heal-stale: unusual orphan count', {
          subsystem: 'walkthrough',
          cron: 'walkthrough-heal-stale',
          healed_count: healedCount,
        });
      }
    }

    await writeCronHeartbeat('walkthrough-heal-stale', {
      requestId,
      notes: { healedCount },
    });

    return ok({ healedCount }, { requestId });
  } catch (e) {
    return err(`walkthrough-heal-stale cron failed: ${e instanceof Error ? e.message : String(e)}`, {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }
}
