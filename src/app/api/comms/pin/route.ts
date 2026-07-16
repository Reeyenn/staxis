/**
 * /api/comms/pin — the per-channel pinned board.
 *   GET   ?pid=...&conversationId=...     → list pinned messages
 *   POST  { pid, messageId, pinned }      → pin / unpin a message
 * Any member with access to the conversation can pin. Authenticated. NO SMS.
 */
import { ApiErrorCode } from '@/lib/api-response';
import { validateUuid } from '@/lib/api-validate';
import { checkAndIncrementRateLimit, rateLimitedResponse, hashToRateLimitKey } from '@/lib/api-ratelimit';
import { defineRoute } from '@/lib/api-route';
import { commsContext } from '@/lib/comms/route-helpers';
import { getConversation, canAccessConversation, getMessageScope, setPinned, listPinned } from '@/lib/comms/core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = defineRoute({
  resolve: (req) => commsContext(req, new URL(req.url).searchParams.get('pid')),
  handler: async (ctx) => {
    const convV = validateUuid(new URL(ctx.req.url).searchParams.get('conversationId'), 'conversationId');
    if (convV.error) return ctx.err(convV.error, { status: 400, code: ApiErrorCode.ValidationFailed });

    const rl = await checkAndIncrementRateLimit('comms-read', hashToRateLimitKey(`${ctx.pid}:${ctx.userId}`));
    if (!rl.allowed) return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);

    const convo = await getConversation(ctx.pid, convV.value!);
    if (!convo) return ctx.err('Not found', { status: 404, code: ApiErrorCode.NotFound });
    const allowed = await canAccessConversation(ctx.pid, ctx.staffId, convo, { isManager: ctx.isManager, dept: ctx.dept });
    if (!allowed) return ctx.err('Forbidden', { status: 403, code: ApiErrorCode.Forbidden });

    const pinned = await listPinned(ctx.pid, convo.id, ctx.staffId, ctx.lang);
    return ctx.ok({ pinned });
  },
});

export const POST = defineRoute({
  body: 'empty',
  resolve: (req, body: { pid?: string; messageId?: string; pinned?: boolean }) => commsContext(req, body.pid ?? null),
  handler: async (ctx) => {
    const idV = validateUuid(ctx.body.messageId, 'messageId');
    if (idV.error) return ctx.err(idV.error, { status: 400, code: ApiErrorCode.ValidationFailed });

    const rl = await checkAndIncrementRateLimit('comms-pin', hashToRateLimitKey(`${ctx.pid}:${ctx.userId}`));
    if (!rl.allowed) return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);

    // Resolve the message → its conversation → access check.
    const scope = await getMessageScope(ctx.pid, idV.value!);
    if (!scope) return ctx.err('Not found', { status: 404, code: ApiErrorCode.NotFound });
    const convo = await getConversation(ctx.pid, scope.conversationId);
    if (!convo) return ctx.err('Not found', { status: 404, code: ApiErrorCode.NotFound });
    const allowed = await canAccessConversation(ctx.pid, ctx.staffId, convo, { isManager: ctx.isManager, dept: ctx.dept });
    if (!allowed) return ctx.err('Forbidden', { status: 403, code: ApiErrorCode.Forbidden });

    const okUpdate = await setPinned(ctx.pid, idV.value!, ctx.staffId, ctx.body.pinned !== false);
    if (!okUpdate) return ctx.err('Not found', { status: 404, code: ApiErrorCode.NotFound });
    return ctx.ok({ pinned: ctx.body.pinned !== false });
  },
});
