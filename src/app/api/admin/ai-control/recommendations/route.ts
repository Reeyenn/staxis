/**
 * POST /api/admin/ai-control/recommendations
 *
 * Generates the Recommendations tab's content on demand: current per-feature
 * configs + priced model catalog + 30-day spend → one Claude call that writes
 * plain-English model advice (see src/lib/ai/recommendations.ts). Admin-only,
 * billable (roughly a few cents per run), rate-limited, never cached.
 */
import type { NextRequest } from 'next/server';
import { requireAdmin } from '@/lib/admin-auth';
import { ok } from '@/lib/api-response';
import { getOrMintRequestId } from '@/lib/log';
import { checkAndIncrementRateLimit, hashToRateLimitKey, rateLimitedResponse } from '@/lib/api-ratelimit';
import { generateAiModelRecommendations } from '@/lib/ai/recommendations';
import { aiControlError, NO_STORE_HEADERS } from '../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;
const EXECUTION_BUDGET_MS = 50_000;

export async function POST(req: NextRequest): Promise<Response> {
  const deadlineAt = Date.now() + EXECUTION_BUDGET_MS;
  const requestId = getOrMintRequestId(req);
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  const rateLimit = await checkAndIncrementRateLimit(
    'admin-ai-recommendations',
    hashToRateLimitKey(`admin-ai-control:${auth.accountId}`),
  );
  if (!rateLimit.allowed) {
    return rateLimitedResponse(rateLimit.current, rateLimit.cap, rateLimit.retryAfterSec);
  }

  try {
    const data = await generateAiModelRecommendations({ deadlineAt, abortSignal: req.signal });
    return ok(data, { requestId, headers: NO_STORE_HEADERS });
  } catch (error) {
    return aiControlError(error, requestId);
  }
}
