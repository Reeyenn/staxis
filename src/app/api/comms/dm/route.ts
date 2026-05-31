/**
 * POST /api/comms/dm  — Body: { pid, otherStaffId }
 * Open (or reuse) a 1:1 conversation with another staff member. Returns the
 * conversation id. Authenticated. NO SMS.
 */
import type { NextRequest } from 'next/server';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { validateUuid } from '@/lib/api-validate';
import { checkAndIncrementRateLimit, rateLimitedResponse, hashToRateLimitKey } from '@/lib/api-ratelimit';
import { commsContext } from '@/lib/comms/route-helpers';
import { getStaffRow, ensureDmConversation } from '@/lib/comms/core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest): Promise<Response> {
  let body: { pid?: string; otherStaffId?: string };
  try { body = await req.json(); } catch { body = {}; }

  const ctx = await commsContext(req, body.pid ?? null);
  if (!ctx.ok) return ctx.response;

  const otherV = validateUuid(body.otherStaffId, 'otherStaffId');
  if (otherV.error) {
    return err(otherV.error, { requestId: ctx.requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: ctx.headers });
  }
  if (otherV.value === ctx.staffId) {
    return err('cannot message yourself', { requestId: ctx.requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: ctx.headers });
  }

  const rl = await checkAndIncrementRateLimit('comms-send', hashToRateLimitKey(`${ctx.pid}:${ctx.userId}`));
  if (!rl.allowed) return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);

  // The other staff must belong to this property (capability check).
  const other = await getStaffRow(ctx.pid, otherV.value!);
  if (!other) {
    return err('Not found', { requestId: ctx.requestId, status: 404, code: ApiErrorCode.NotFound, headers: ctx.headers });
  }

  const conversationId = await ensureDmConversation(ctx.pid, ctx.staffId, otherV.value!);
  return ok({ conversationId }, { requestId: ctx.requestId, headers: ctx.headers });
}
