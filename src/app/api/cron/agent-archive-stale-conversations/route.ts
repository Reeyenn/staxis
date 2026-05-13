/**
 * GET /api/cron/agent-archive-stale-conversations
 *
 * Daily cron at 03:00 UTC. Scans agent_conversations for rows whose
 * updated_at is >90 days old; archives them in batches of up to 500.
 * Each archive is atomic (DB-side RPC under per-conversation advisory
 * lock) so a concurrent user POST can't race the cron.
 *
 * Longevity L4 part A, 2026-05-13.
 *
 * Auth: CRON_SECRET bearer.
 */

import { NextRequest } from 'next/server';
import { requireCronSecret } from '@/lib/api-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId } from '@/lib/log';
import { writeCronHeartbeat } from '@/lib/cron-heartbeat';
import { archiveStaleBatch } from '@/lib/agent/archival';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const cronGate = requireCronSecret(req);
  if (cronGate) return cronGate;

  try {
    const result = await archiveStaleBatch();

    await writeCronHeartbeat('agent-archive-stale-conversations', {
      requestId,
      notes: { ...result },
    });

    return ok(result, { requestId });
  } catch (e) {
    return err(`archive cron failed: ${e instanceof Error ? e.message : String(e)}`, {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }
}
