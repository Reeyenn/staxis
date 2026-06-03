/**
 * GET /api/comms/search?pid=...&q=...
 * The jump-to / search palette: channels + people (always) and message bodies
 * (when q is non-empty), scoped to what the caller can see. Authenticated. NO SMS.
 */
import type { NextRequest } from 'next/server';
import { ok } from '@/lib/api-response';
import { checkAndIncrementRateLimit, rateLimitedResponse, hashToRateLimitKey } from '@/lib/api-ratelimit';
import { commsContext } from '@/lib/comms/route-helpers';
import { searchComms } from '@/lib/comms/core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<Response> {
  const { searchParams } = new URL(req.url);
  const ctx = await commsContext(req, searchParams.get('pid'));
  if (!ctx.ok) return ctx.response;

  const rl = await checkAndIncrementRateLimit('comms-read', hashToRateLimitKey(`${ctx.pid}:${ctx.userId}`));
  if (!rl.allowed) return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);

  const q = (searchParams.get('q') ?? '').slice(0, 100);
  const hits = await searchComms(ctx.pid, ctx.staffId, q, { isManager: ctx.isManager, dept: ctx.dept });
  return ok({ hits }, { requestId: ctx.requestId, headers: ctx.headers });
}
