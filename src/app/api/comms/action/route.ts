/**
 * POST /api/comms/action
 * Body: { pid, kind:'work_order'|'complaint', description, roomNumber?, severity?,
 *         guestName?, category?, conversationId?, sourceMessageId? }
 * Execute the one-tap action surfaced by message→action detection. Reuses the
 * real work-order + complaint creation paths. Posts a confirmation system
 * message into the conversation when one is given. Per-user rate limit. NO SMS.
 */
import { ApiErrorCode } from '@/lib/api-response';
import { validateString, validateEnum } from '@/lib/api-validate';
import { checkAndIncrementRateLimit, rateLimitedResponse, hashToRateLimitKey } from '@/lib/api-ratelimit';
import { defineRoute } from '@/lib/api-route';
import { commsContext } from '@/lib/comms/route-helpers';
import {
  createWorkOrderForComms, createComplaintForComms,
  getConversation, canAccessConversation, postMessage,
} from '@/lib/comms/core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Body {
  pid?: string; kind?: string; description?: string; roomNumber?: string;
  severity?: string; guestName?: string; category?: string; conversationId?: string;
}

export const POST = defineRoute({
  body: 'empty',
  resolve: (req, body: Body) => commsContext(req, body.pid ?? null),
  handler: async (ctx) => {
    const body = ctx.body;
    const kindV = validateEnum(body.kind, ['work_order', 'complaint'] as const, 'kind');
    if (kindV.error) return ctx.err(kindV.error, { status: 400, code: ApiErrorCode.ValidationFailed });
    const descV = validateString(body.description, { max: 2000, label: 'description' });
    if (descV.error) return ctx.err(descV.error, { status: 400, code: ApiErrorCode.ValidationFailed });

    const rl = await checkAndIncrementRateLimit('comms-action', hashToRateLimitKey(`${ctx.pid}:${ctx.userId}`));
    if (!rl.allowed) return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);

    let id: string;
    let label: string;
    if (kindV.value === 'work_order') {
      const wo = await createWorkOrderForComms(ctx.pid, {
        roomNumber: body.roomNumber ?? null,
        description: descV.value!,
        severity: body.severity ?? 'medium',
        byName: ctx.displayName,
      });
      id = wo.id;
      label = `🔧 Work order created${body.roomNumber ? ` for room ${body.roomNumber}` : ''}`;
    } else {
      const cp = await createComplaintForComms(ctx.pid, {
        description: descV.value!,
        roomNumber: body.roomNumber ?? null,
        guestName: body.guestName ?? null,
        severity: body.severity ?? 'medium',
        category: body.category ?? null,
        byName: ctx.displayName,
      });
      id = cp.id;
      label = '📣 Complaint logged';
    }

    // Optional: drop a confirmation note into the conversation it came from.
    if (body.conversationId) {
      const convo = await getConversation(ctx.pid, body.conversationId);
      if (convo) {
        const allowed = await canAccessConversation(ctx.pid, ctx.staffId, convo, { isManager: ctx.isManager, dept: ctx.dept });
        if (allowed) {
          await postMessage(ctx.pid, convo.id, {
            senderStaffId: ctx.staffId, senderKind: 'system', body: label, sourceLang: ctx.lang, msgType: 'system',
          });
        }
      }
    }

    return ctx.ok({ id, kind: kindV.value }, { status: 201 });
  },
});
