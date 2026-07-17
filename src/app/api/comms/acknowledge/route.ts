/**
 * POST /api/comms/acknowledge  — Body: { pid, messageId }
 * Any staff member taps "I read & understand" on a require-ack announcement.
 * Idempotent: the unique(message_id, staff_id) constraint means a double-tap or
 * a replayed request can never double-count. Authenticated (commsContext). NO SMS.
 *
 * This is the HARD acknowledgement — distinct from the passive last_read_at
 * "seen" receipt that opening the feed records.
 */
import { ApiErrorCode } from '@/lib/api-response';
import { validateUuid } from '@/lib/api-validate';
import { checkAndIncrementRateLimit, rateLimitedResponse, hashToRateLimitKey } from '@/lib/api-ratelimit';
import { defineRoute } from '@/lib/api-route';
import { commsContext } from '@/lib/comms/route-helpers';
import { getAckMessage, getConversation, canAccessConversation, acknowledgeMessage } from '@/lib/comms/core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = defineRoute({
  body: 'empty',
  resolve: (req, body: { pid?: string; messageId?: string }) => commsContext(req, body.pid ?? null),
  handler: async (ctx) => {
    const idV = validateUuid(ctx.body.messageId, 'messageId');
    if (idV.error) {
      return ctx.err(idV.error, { status: 400, code: ApiErrorCode.ValidationFailed });
    }

    const rl = await checkAndIncrementRateLimit('comms-acknowledge', hashToRateLimitKey(`${ctx.pid}:${ctx.staffId}`));
    if (!rl.allowed) return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);

    const msg = await getAckMessage(ctx.pid, idV.value!);
    if (!msg) {
      return ctx.err('Not found', { status: 404, code: ApiErrorCode.NotFound });
    }

    // Defense in depth: the caller must be able to SEE the conversation the
    // announcement lives in (announcements are visible to all staff in a property).
    const convo = await getConversation(ctx.pid, msg.conversation_id);
    const allowed = !!convo && await canAccessConversation(ctx.pid, ctx.staffId, convo, { isManager: ctx.isManager, dept: ctx.dept });
    if (!allowed) {
      return ctx.err('Forbidden', { status: 403, code: ApiErrorCode.Forbidden });
    }

    const res = await acknowledgeMessage(ctx.pid, idV.value!, ctx.staffId);
    if (!res.ok) {
      if (res.reason === 'not_required') {
        return ctx.err('this announcement does not require acknowledgement', { status: 400, code: ApiErrorCode.ValidationFailed });
      }
      return ctx.err('Not found', { status: 404, code: ApiErrorCode.NotFound });
    }

    return ctx.ok(
      { acked: true, already: res.already },
      { status: res.already ? 200 : 201 },
    );
  },
});
