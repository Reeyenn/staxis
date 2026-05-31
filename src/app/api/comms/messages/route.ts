/**
 * GET /api/comms/messages?pid=...&conversationId=...
 * Returns the messages in a conversation, each translated into the reader's
 * chosen language (cache-first), with read-receipts on the reader's own
 * messages. Opening a thread marks it read. Authenticated. NO SMS.
 */
import type { NextRequest } from 'next/server';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { validateUuid } from '@/lib/api-validate';
import { checkAndIncrementRateLimit, rateLimitedResponse, hashToRateLimitKey } from '@/lib/api-ratelimit';
import { commsContext } from '@/lib/comms/route-helpers';
import { getConversation, canAccessConversation, getMessages, markConversationRead } from '@/lib/comms/core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30; // translation of a fresh thread can fan out

export async function GET(req: NextRequest): Promise<Response> {
  const { searchParams } = new URL(req.url);
  const ctx = await commsContext(req, searchParams.get('pid'));
  if (!ctx.ok) return ctx.response;

  const convV = validateUuid(searchParams.get('conversationId'), 'conversationId');
  if (convV.error) {
    return err(convV.error, { requestId: ctx.requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: ctx.headers });
  }

  const rl = await checkAndIncrementRateLimit('comms-read', hashToRateLimitKey(`${ctx.pid}:${ctx.userId}`));
  if (!rl.allowed) return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);

  const convo = await getConversation(ctx.pid, convV.value!);
  if (!convo) {
    return err('Not found', { requestId: ctx.requestId, status: 404, code: ApiErrorCode.NotFound, headers: ctx.headers });
  }
  const allowed = await canAccessConversation(ctx.pid, ctx.staffId, convo, { isManager: ctx.isManager, dept: ctx.dept });
  if (!allowed) {
    return err('Forbidden', { requestId: ctx.requestId, status: 403, code: ApiErrorCode.Forbidden, headers: ctx.headers });
  }

  const messages = await getMessages(ctx.pid, convo.id, ctx.staffId, ctx.lang, { withReceipts: true });
  await markConversationRead(ctx.pid, convo.id, ctx.staffId);

  return ok(
    {
      conversation: { id: convo.id, kind: convo.kind, channelKey: convo.channel_key, title: convo.title },
      messages,
    },
    { requestId: ctx.requestId, headers: ctx.headers },
  );
}
