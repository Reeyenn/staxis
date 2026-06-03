/**
 * /api/comms/pin — the per-channel pinned board.
 *   GET   ?pid=...&conversationId=...     → list pinned messages
 *   POST  { pid, messageId, pinned }      → pin / unpin a message
 * Any member with access to the conversation can pin. Authenticated. NO SMS.
 */
import type { NextRequest } from 'next/server';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { validateUuid } from '@/lib/api-validate';
import { checkAndIncrementRateLimit, rateLimitedResponse, hashToRateLimitKey } from '@/lib/api-ratelimit';
import { commsContext } from '@/lib/comms/route-helpers';
import { getConversation, canAccessConversation, getMessageScope, setPinned, listPinned } from '@/lib/comms/core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<Response> {
  const { searchParams } = new URL(req.url);
  const ctx = await commsContext(req, searchParams.get('pid'));
  if (!ctx.ok) return ctx.response;

  const convV = validateUuid(searchParams.get('conversationId'), 'conversationId');
  if (convV.error) return err(convV.error, { requestId: ctx.requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: ctx.headers });

  const rl = await checkAndIncrementRateLimit('comms-read', hashToRateLimitKey(`${ctx.pid}:${ctx.userId}`));
  if (!rl.allowed) return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);

  const convo = await getConversation(ctx.pid, convV.value!);
  if (!convo) return err('Not found', { requestId: ctx.requestId, status: 404, code: ApiErrorCode.NotFound, headers: ctx.headers });
  const allowed = await canAccessConversation(ctx.pid, ctx.staffId, convo, { isManager: ctx.isManager, dept: ctx.dept });
  if (!allowed) return err('Forbidden', { requestId: ctx.requestId, status: 403, code: ApiErrorCode.Forbidden, headers: ctx.headers });

  const pinned = await listPinned(ctx.pid, convo.id, ctx.staffId, ctx.lang);
  return ok({ pinned }, { requestId: ctx.requestId, headers: ctx.headers });
}

export async function POST(req: NextRequest): Promise<Response> {
  let body: { pid?: string; messageId?: string; pinned?: boolean };
  try { body = await req.json(); } catch { body = {}; }

  const ctx = await commsContext(req, body.pid ?? null);
  if (!ctx.ok) return ctx.response;

  const idV = validateUuid(body.messageId, 'messageId');
  if (idV.error) return err(idV.error, { requestId: ctx.requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: ctx.headers });

  const rl = await checkAndIncrementRateLimit('comms-pin', hashToRateLimitKey(`${ctx.pid}:${ctx.userId}`));
  if (!rl.allowed) return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);

  // Resolve the message → its conversation → access check.
  const scope = await getMessageScope(ctx.pid, idV.value!);
  if (!scope) return err('Not found', { requestId: ctx.requestId, status: 404, code: ApiErrorCode.NotFound, headers: ctx.headers });
  const convo = await getConversation(ctx.pid, scope.conversationId);
  if (!convo) return err('Not found', { requestId: ctx.requestId, status: 404, code: ApiErrorCode.NotFound, headers: ctx.headers });
  const allowed = await canAccessConversation(ctx.pid, ctx.staffId, convo, { isManager: ctx.isManager, dept: ctx.dept });
  if (!allowed) return err('Forbidden', { requestId: ctx.requestId, status: 403, code: ApiErrorCode.Forbidden, headers: ctx.headers });

  const okUpdate = await setPinned(ctx.pid, idV.value!, ctx.staffId, body.pinned !== false);
  if (!okUpdate) return err('Not found', { requestId: ctx.requestId, status: 404, code: ApiErrorCode.NotFound, headers: ctx.headers });
  return ok({ pinned: body.pinned !== false }, { requestId: ctx.requestId, headers: ctx.headers });
}
