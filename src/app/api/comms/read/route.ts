/**
 * POST /api/comms/read  — Body: { pid, conversationId }
 * Mark a conversation read up to now (clears its unread badge). Authenticated.
 */
import { ApiErrorCode } from '@/lib/api-response';
import { validateUuid } from '@/lib/api-validate';
import { checkAndIncrementRateLimit, rateLimitedResponse, hashToRateLimitKey } from '@/lib/api-ratelimit';
import { defineRoute } from '@/lib/api-route';
import { commsContext } from '@/lib/comms/route-helpers';
import { getConversation, canAccessConversation, markConversationRead } from '@/lib/comms/core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = defineRoute({
  body: 'empty',
  resolve: (req, body: { pid?: string; conversationId?: string }) => commsContext(req, body.pid ?? null),
  handler: async (ctx) => {
    const convV = validateUuid(ctx.body.conversationId, 'conversationId');
    if (convV.error) {
      return ctx.err(convV.error, { status: 400, code: ApiErrorCode.ValidationFailed });
    }

    const rl = await checkAndIncrementRateLimit('comms-read', hashToRateLimitKey(`${ctx.pid}:${ctx.userId}`));
    if (!rl.allowed) return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);

    const convo = await getConversation(ctx.pid, convV.value!);
    if (!convo) {
      return ctx.err('Not found', { status: 404, code: ApiErrorCode.NotFound });
    }
    const allowed = await canAccessConversation(ctx.pid, ctx.staffId, convo, { isManager: ctx.isManager, dept: ctx.dept });
    if (!allowed) {
      return ctx.err('Forbidden', { status: 403, code: ApiErrorCode.Forbidden });
    }

    await markConversationRead(ctx.pid, convo.id, ctx.staffId);
    return ctx.ok({ marked: true });
  },
});
