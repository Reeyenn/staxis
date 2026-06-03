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

export async function GET(req: NextRequest): Promise<Response> {
  const { searchParams } = new URL(req.url);
  const ctx = await commsContext(req, searchParams.get('pid'));
  if (!ctx.ok) return ctx.response;

  const rl = await checkAndIncrementRateLimit('comms-read', hashToRateLimitKey(`${ctx.pid}:${ctx.userId}`));
  if (!rl.allowed) return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);

  const threads = await listThreads(ctx.pid, ctx.staffId, ctx.lang, { isManager: ctx.isManager, dept: ctx.dept });
  return ok({ threads }, { requestId: ctx.requestId, headers: ctx.headers });
}
