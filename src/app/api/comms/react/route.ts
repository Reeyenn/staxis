/**
 * POST /api/comms/react — toggle the caller's ✓ acknowledgement reaction on a
 * message (the casual "read/got it" pill; NOT the formal require-ack flow).
 * Body: { pid, messageId }. Idempotent toggle. Authenticated. NO SMS.
 */
import { ApiErrorCode } from '@/lib/api-response';
import { validateUuid } from '@/lib/api-validate';
import { checkAndIncrementRateLimit, rateLimitedResponse, hashToRateLimitKey } from '@/lib/api-ratelimit';
import { defineRoute } from '@/lib/api-route';
import { commsContext } from '@/lib/comms/route-helpers';
import { getConversation, canAccessConversation, getMessageScope, toggleReaction } from '@/lib/comms/core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = defineRoute({
  body: 'empty',
  resolve: (req, body: { pid?: string; messageId?: string }) => commsContext(req, body.pid ?? null),
  handler: async (ctx) => {
    const idV = validateUuid(ctx.body.messageId, 'messageId');
    if (idV.error) return ctx.err(idV.error, { status: 400, code: ApiErrorCode.ValidationFailed });

    const rl = await checkAndIncrementRateLimit('comms-react', hashToRateLimitKey(`${ctx.pid}:${ctx.userId}`));
    if (!rl.allowed) return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);

    const scope = await getMessageScope(ctx.pid, idV.value!);
    if (!scope) return ctx.err('Not found', { status: 404, code: ApiErrorCode.NotFound });
    const convo = await getConversation(ctx.pid, scope.conversationId);
    if (!convo) return ctx.err('Not found', { status: 404, code: ApiErrorCode.NotFound });
    const allowed = await canAccessConversation(ctx.pid, ctx.staffId, convo, { isManager: ctx.isManager, dept: ctx.dept });
    if (!allowed) return ctx.err('Forbidden', { status: 403, code: ApiErrorCode.Forbidden });

    const res = await toggleReaction(ctx.pid, idV.value!, ctx.staffId);
    return ctx.ok(res);
  },
});
