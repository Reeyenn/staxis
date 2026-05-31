/**
 * POST /api/comms/acknowledge  — Body: { pid, messageId }
 * Any staff member taps "I read & understand" on a require-ack announcement.
 * Idempotent: the unique(message_id, staff_id) constraint means a double-tap or
 * a replayed request can never double-count. Authenticated (commsContext). NO SMS.
 *
 * This is the HARD acknowledgement — distinct from the passive last_read_at
 * "seen" receipt that opening the feed records.
 */
import type { NextRequest } from 'next/server';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { validateUuid } from '@/lib/api-validate';
import { checkAndIncrementRateLimit, rateLimitedResponse, hashToRateLimitKey } from '@/lib/api-ratelimit';
import { commsContext } from '@/lib/comms/route-helpers';
import { getAckMessage, getConversation, canAccessConversation, acknowledgeMessage } from '@/lib/comms/core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Body { pid?: string; messageId?: string }

export async function POST(req: NextRequest): Promise<Response> {
  let body: Body;
  try { body = (await req.json()) as Body; } catch { body = {}; }

  const ctx = await commsContext(req, body.pid ?? null);
  if (!ctx.ok) return ctx.response;

  const idV = validateUuid(body.messageId, 'messageId');
  if (idV.error) {
    return err(idV.error, { requestId: ctx.requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: ctx.headers });
  }

  const rl = await checkAndIncrementRateLimit('comms-acknowledge', hashToRateLimitKey(`${ctx.pid}:${ctx.staffId}`));
  if (!rl.allowed) return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);

  const msg = await getAckMessage(ctx.pid, idV.value!);
  if (!msg) {
    return err('Not found', { requestId: ctx.requestId, status: 404, code: ApiErrorCode.NotFound, headers: ctx.headers });
  }

  // Defense in depth: the caller must be able to SEE the conversation the
  // announcement lives in (announcements are visible to all staff in a property).
  const convo = await getConversation(ctx.pid, msg.conversation_id);
  const allowed = !!convo && await canAccessConversation(ctx.pid, ctx.staffId, convo, { isManager: ctx.isManager, dept: ctx.dept });
  if (!allowed) {
    return err('Forbidden', { requestId: ctx.requestId, status: 403, code: ApiErrorCode.Forbidden, headers: ctx.headers });
  }

  const res = await acknowledgeMessage(ctx.pid, idV.value!, ctx.staffId);
  if (!res.ok) {
    if (res.reason === 'not_required') {
      return err('this announcement does not require acknowledgement', { requestId: ctx.requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: ctx.headers });
    }
    return err('Not found', { requestId: ctx.requestId, status: 404, code: ApiErrorCode.NotFound, headers: ctx.headers });
  }

  return ok(
    { acked: true, already: res.already },
    { requestId: ctx.requestId, status: res.already ? 200 : 201, headers: ctx.headers },
  );
}
