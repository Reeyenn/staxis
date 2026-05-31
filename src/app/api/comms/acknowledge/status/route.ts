/**
 * GET /api/comms/acknowledge/status?pid=...&messageId=...
 * Manager-only live tracker for ONE require-ack announcement:
 *   { total, acked, ackedList: [{name, at}], pending: [{name}] }
 * Authenticated (commsContext) + manager-gated. NO SMS.
 */
import type { NextRequest } from 'next/server';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { validateUuid } from '@/lib/api-validate';
import { checkAndIncrementRateLimit, rateLimitedResponse, hashToRateLimitKey } from '@/lib/api-ratelimit';
import { commsContext } from '@/lib/comms/route-helpers';
import { getAckStatus } from '@/lib/comms/core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<Response> {
  const { searchParams } = new URL(req.url);
  const ctx = await commsContext(req, searchParams.get('pid'));
  if (!ctx.ok) return ctx.response;

  if (!ctx.isManager) {
    return err('only managers can view acknowledgement status', { requestId: ctx.requestId, status: 403, code: ApiErrorCode.Forbidden, headers: ctx.headers });
  }

  const idV = validateUuid(searchParams.get('messageId'), 'messageId');
  if (idV.error) {
    return err(idV.error, { requestId: ctx.requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: ctx.headers });
  }

  // Polled by the open tracker — reuse the comms-read bucket.
  const rl = await checkAndIncrementRateLimit('comms-read', hashToRateLimitKey(`${ctx.pid}:${ctx.userId}`));
  if (!rl.allowed) return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);

  const status = await getAckStatus(ctx.pid, idV.value!);
  if (!status) {
    return err('Not found', { requestId: ctx.requestId, status: 404, code: ApiErrorCode.NotFound, headers: ctx.headers });
  }

  return ok(status, { requestId: ctx.requestId, headers: ctx.headers });
}
