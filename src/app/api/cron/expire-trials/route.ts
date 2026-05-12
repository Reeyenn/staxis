/**
 * GET /api/cron/expire-trials
 *
 * Run daily at 09:00 UTC by Vercel cron (vercel.json → crons[]).
 * Flips properties whose trial_ends_at is
 * in the past from subscription_status='trial' to 'past_due'. The
 * dashboard nudges past_due properties to add a card; the cua-service
 * worker can optionally skip their onboarding jobs (we don't enforce
 * that today — keep all properties working until the GM responds to
 * the nudge — but the column is the source of truth if we ever want
 * to gate features).
 *
 * Auth: CRON_SECRET bearer. Same pattern as scraper-health.
 *
 * Returns: { expired: number, sample: [{id, name, trial_ends_at}, …] }
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

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);

  const cronGate = requireCronSecret(req);
  if (cronGate) return cronGate;

  // Only flip properties whose trial has actually expired. The
  // dashboard reads subscription_status to gate "add card" prompts;
  // we don't want to spam GMs whose trial is fine.
  const { data: expired, error } = await supabaseAdmin
    .from('properties')
    .update({ subscription_status: 'past_due' })
    .eq('subscription_status', 'trial')
    .lt('trial_ends_at', new Date().toISOString())
    .select('id, name, trial_ends_at');

  if (error) {
    return err(`Could not expire trials: ${error.message}`, {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }

  const list = expired ?? [];
  await writeCronHeartbeat('expire-trials', {
    requestId,
    notes: { expired: list.length },
  });
  return ok({
    expired: list.length,
    sample: list.slice(0, 10).map((p) => ({
      id: p.id,
      name: p.name,
      trialEndsAt: p.trial_ends_at,
    })),
  }, { requestId });
}
