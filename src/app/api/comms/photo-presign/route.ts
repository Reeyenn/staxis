/**
 * POST /api/comms/photo-presign  — Body: { pid, conversationId, kind, filename }
 * Returns a short-lived signed-upload URL for a photo/voice attachment in a
 * conversation the caller can access (private bucket). Mirrors the housekeeper
 * photo-presign pattern. Authenticated.
 */
import type { NextRequest } from 'next/server';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { validateUuid, validateString, validateEnum } from '@/lib/api-validate';
import { checkAndIncrementRateLimit, rateLimitedResponse, hashToRateLimitKey } from '@/lib/api-ratelimit';
import { commsContext } from '@/lib/comms/route-helpers';
import { getConversation, canAccessConversation, presignAttachment } from '@/lib/comms/core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest): Promise<Response> {
  let body: { pid?: string; conversationId?: string; kind?: string; filename?: string };
  try { body = await req.json(); } catch { body = {}; }

  const ctx = await commsContext(req, body.pid ?? null);
  if (!ctx.ok) return ctx.response;

  const convV = validateUuid(body.conversationId, 'conversationId');
  if (convV.error) return err(convV.error, { requestId: ctx.requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: ctx.headers });
  const kindV = validateEnum(body.kind, ['photo', 'voice'] as const, 'kind');
  if (kindV.error) return err(kindV.error, { requestId: ctx.requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: ctx.headers });
  const fnameV = validateString(body.filename, { max: 200, label: 'filename' });
  if (fnameV.error) return err(fnameV.error, { requestId: ctx.requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: ctx.headers });

  const rl = await checkAndIncrementRateLimit('comms-photo-presign', hashToRateLimitKey(`${ctx.pid}:${ctx.userId}`));
  if (!rl.allowed) return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);

  const convo = await getConversation(ctx.pid, convV.value!);
  if (!convo) return err('Not found', { requestId: ctx.requestId, status: 404, code: ApiErrorCode.NotFound, headers: ctx.headers });
  const allowed = await canAccessConversation(ctx.pid, ctx.staffId, convo, { isManager: ctx.isManager, dept: ctx.dept });
  if (!allowed) return err('Forbidden', { requestId: ctx.requestId, status: 403, code: ApiErrorCode.Forbidden, headers: ctx.headers });

  const res = await presignAttachment(ctx.pid, convo.id, kindV.value as 'photo' | 'voice', fnameV.value!);
  if (!res) return err('Internal server error', { requestId: ctx.requestId, status: 500, code: ApiErrorCode.InternalError, headers: ctx.headers });
  return ok(res, { requestId: ctx.requestId, headers: ctx.headers });
}
