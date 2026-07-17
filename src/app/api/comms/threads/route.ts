/**
 * GET /api/comms/threads?pid=...
 * Every top-level message that has threaded replies, across the conversations
 * the caller can see (the "Threads" view). Authenticated. NO SMS.
 */
import type { NextRequest } from 'next/server';
import { ok } from '@/lib/api-response';
import { checkAndIncrementRateLimit, rateLimitedResponse, hashToRateLimitKey } from '@/lib/api-ratelimit';
import { commsContext } from '@/lib/comms/route-helpers';
import { listThreads } from '@/lib/comms/core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(req: NextRequest): Promise<Response> {
  const deadlineAt = Date.now() + 24_000;
  const { searchParams } = new URL(req.url);
  const ctx = await commsContext(req, searchParams.get('pid'));
  if (!ctx.ok) return ctx.response;

  const rl = await checkAndIncrementRateLimit('comms-read', hashToRateLimitKey(`${ctx.pid}:${ctx.userId}`));
  if (!rl.allowed) return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);

  const threads = await listThreads(
    ctx.pid,
    ctx.staffId,
    ctx.lang,
    { isManager: ctx.isManager, dept: ctx.dept },
    {
      ai: {
        deadlineAt,
        abortSignal: req.signal,
        ledger: {
          userId: ctx.accountId,
          propertyId: ctx.pid,
          requestId: ctx.requestId,
          feature: 'communications.message_translation',
        },
      },
    },
  );
  return ok({ threads }, { requestId: ctx.requestId, headers: ctx.headers });
}
