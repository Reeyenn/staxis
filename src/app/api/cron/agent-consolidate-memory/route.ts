/**
 * GET /api/cron/agent-consolidate-memory
 *
 * Nightly. For every hotel with copilot activity in the last 24h, review the
 * day's conversations and AUTO-SAVE durable facts into agent_memory
 * (self-learning Move #2). Records a per-property run for the dashboard
 * "What Staxis learned" card.
 *
 * Auth: CRON_SECRET bearer.
 */

import { NextRequest } from 'next/server';
import { requireCronSecret } from '@/lib/api-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId } from '@/lib/log';
import { writeCronHeartbeat } from '@/lib/cron-heartbeat';
import { consolidateAllProperties } from '@/lib/agent/memory-consolidate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300; // fleet-scale: concurrency + early-exits keep 300+ hotels well inside this

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const cronGate = requireCronSecret(req);
  if (cronGate) return cronGate;

  try {
    // Optional sharding: a GitHub Actions workflow can dispatch N parallel jobs
    // (?shard_offset=k&shard_count=N) once the fleet outgrows a single run.
    // Default (no params) = one shard = the nightly Vercel cron processes all.
    const sp = new URL(req.url).searchParams;
    const shardOffset = parseInt(sp.get('shard_offset') ?? '0', 10);
    const shardCount = parseInt(sp.get('shard_count') ?? '1', 10);
    const result = await consolidateAllProperties({
      shardOffset: Number.isFinite(shardOffset) ? shardOffset : 0,
      shardCount: Number.isFinite(shardCount) ? shardCount : 1,
    });

    await writeCronHeartbeat('agent-consolidate-memory', {
      requestId,
      notes: { ...result },
    });

    return ok(result, { requestId });
  } catch (e) {
    return err(`consolidate cron failed: ${e instanceof Error ? e.message : String(e)}`, {
      requestId,
      status: 500,
      code: ApiErrorCode.InternalError,
    });
  }
}
