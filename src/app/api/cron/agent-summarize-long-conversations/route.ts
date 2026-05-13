/**
 * GET /api/cron/agent-summarize-long-conversations
 *
 * Every 30 minutes. Scans for conversations with >50 unsummarized
 * messages and folds the oldest batch of 50 into a single "summary"
 * assistant turn via Haiku. Replay layer skips the folded messages
 * and uses the summary as the bridge to older context.
 *
 * Longevity L4 part B, 2026-05-13.
 *
 * Auth: CRON_SECRET bearer.
 */

import { NextRequest } from 'next/server';
import { requireCronSecret } from '@/lib/api-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId } from '@/lib/log';
import { writeCronHeartbeat } from '@/lib/cron-heartbeat';
import { summarizeLongConversationsBatch } from '@/lib/agent/summarizer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const cronGate = requireCronSecret(req);
  if (cronGate) return cronGate;

  try {
    const result = await summarizeLongConversationsBatch();

    await writeCronHeartbeat('agent-summarize-long-conversations', {
      requestId,
      notes: { ...result },
    });

    return ok(result, { requestId });
  } catch (e) {
    return err(`summarize cron failed: ${e instanceof Error ? e.message : String(e)}`, {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }
}
