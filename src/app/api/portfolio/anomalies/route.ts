/**
 * GET /api/portfolio/anomalies
 *
 * Returns only the anomaly list + count for the caller's accessible
 * properties. Computed from the same per-property snapshot the /tiles
 * route returns — exists as a focused endpoint for callers that need
 * just "are there anomalies and what?" without the heavier tile data
 * (e.g. a header notification badge or a future Slack/email digest).
 *
 * Auth: requireSession.
 * Rate-limit: 240/hr per user.
 */

import { NextRequest } from 'next/server';
import { requireSession } from '@/lib/api-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import {
  checkAndIncrementRateLimit,
  rateLimitedResponse,
  hashToRateLimitKey,
} from '@/lib/api-ratelimit';
import '@/lib/portfolio';
import { buildPortfolioSnapshot } from '@/lib/portfolio/server-fetch';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);

  const auth = await requireSession(req, { requestId });
  if (!auth.ok) return auth.response;

  const rlKey = hashToRateLimitKey(auth.userId);
  const rl = await checkAndIncrementRateLimit('portfolio-anomalies', rlKey);
  if (!rl.allowed) return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);

  try {
    const snapshot = await buildPortfolioSnapshot(auth.userId);
    return ok({
      anomalies: snapshot.anomalies,
      count: snapshot.anomalies.length,
    }, { requestId });
  } catch (e) {
    log.error('[portfolio/anomalies] failed', {
      requestId, userId: auth.userId,
      err: e instanceof Error ? e.message : String(e),
    });
    return err('anomaly fetch failed', {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }
}
