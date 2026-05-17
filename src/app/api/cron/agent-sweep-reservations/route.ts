/**
 * GET /api/cron/agent-sweep-reservations
 *
 * Run every 5 minutes by Vercel cron. Cancels agent_costs rows stuck in
 * 'reserved' state for more than 5 minutes — these stranded holds happen
 * when finalize + cancel both fail (transient Supabase outage, server
 * crash mid-request, etc.). Without this sweeper:
 *   1. Stranded rows inflate the daily-cap math (the cap RPC sums both
 *      'reserved' + 'finalized' state), permanently shrinking the user's
 *      daily budget until UTC midnight.
 *   2. They're invisible to /admin/agent (metrics filters to 'finalized').
 *
 * Codex round-5 fix R2, 2026-05-13.
 *
 * Auth: CRON_SECRET bearer header.
 * Returns: { sweptCount, oldestAgeSeconds }
 */

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireCronSecret } from '@/lib/api-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { log, getOrMintRequestId } from '@/lib/log';
import { writeCronHeartbeat } from '@/lib/cron-heartbeat';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);

  const cronGate = requireCronSecret(req);
  if (cronGate) return cronGate;

  const { data, error } = await supabaseAdmin.rpc('staxis_sweep_stale_reservations', {
    p_max_age_minutes: 5,
  });

  if (error) {
    log.error('agent-sweep-reservations: RPC failed', { err: error, requestId });
    return err('sweep RPC failed', {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }

  // RPC returns table(swept_count, oldest_age_seconds) — supabase-js gives an array.
  const row = Array.isArray(data) ? data[0] : data;
  const sweptCount = (row?.swept_count as number) ?? 0;
  const oldestAgeSeconds = (row?.oldest_age_seconds as number) ?? 0;

  await writeCronHeartbeat('agent-sweep-reservations', {
    requestId,
    notes: { sweptCount, oldestAgeSeconds },
  });

  return ok({ sweptCount, oldestAgeSeconds }, { requestId });
}
