/**
 * GET /api/comms/thread?pid=...&conversationId=...&parentId=...
 * The parent message + its threaded replies (translated for the reader).
 * Posting a reply goes through /api/comms/send with { parentMessageId }.
 * Authenticated. NO SMS.
 */
import type { NextRequest } from 'next/server';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { validateUuid } from '@/lib/api-validate';
import { checkAndIncrementRateLimit, rateLimitedResponse, hashToRateLimitKey } from '@/lib/api-ratelimit';
import { commsContext } from '@/lib/comms/route-helpers';
import { getConversation, canAccessConversation, getThreadReplies } from '@/lib/comms/core';
import { mergeAiUsage, type AiUsageReport } from '@/lib/ai/usage';
import { recordAiUsageBestEffort } from '@/lib/ai/usage-ledger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(req: NextRequest): Promise<Response> {
  const deadlineAt = Date.now() + 24_000;
  const { searchParams } = new URL(req.url);
  const ctx = await commsContext(req, searchParams.get('pid'));
  if (!ctx.ok) return ctx.response;

  const convV = validateUuid(searchParams.get('conversationId'), 'conversationId');
  if (convV.error) return err(convV.error, { requestId: ctx.requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: ctx.headers });
  const parentV = validateUuid(searchParams.get('parentId'), 'parentId');
  if (parentV.error) return err(parentV.error, { requestId: ctx.requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: ctx.headers });

  const rl = await checkAndIncrementRateLimit('comms-read', hashToRateLimitKey(`${ctx.pid}:${ctx.userId}`));
  if (!rl.allowed) return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);

  const convo = await getConversation(ctx.pid, convV.value!);
  if (!convo) return err('Not found', { requestId: ctx.requestId, status: 404, code: ApiErrorCode.NotFound, headers: ctx.headers });
  const allowed = await canAccessConversation(ctx.pid, ctx.staffId, convo, { isManager: ctx.isManager, dept: ctx.dept });
  if (!allowed) return err('Forbidden', { requestId: ctx.requestId, status: 403, code: ApiErrorCode.Forbidden, headers: ctx.headers });

  let usage: AiUsageReport | null = null;
  const thread = await getThreadReplies(ctx.pid, convo.id, parentV.value!, ctx.staffId, ctx.lang, {
    ai: {
      deadlineAt,
      abortSignal: req.signal,
      onUsage: (value) => { usage = mergeAiUsage(usage, value); },
    },
  });
  await recordAiUsageBestEffort({
    usage,
    userId: ctx.accountId,
    propertyId: ctx.pid,
    kind: 'background',
    requestId: ctx.requestId,
    feature: 'communications.message_translation',
  });
  return ok(thread, { requestId: ctx.requestId, headers: ctx.headers });
}
