/**
 * /api/comms/logbook/replies — threaded replies on a Shift Log Book recap.
 *   GET   ?pid=...&entryId=...        → list replies (oldest first)
 *   POST  { pid, entryId, body }       → post a reply
 * Authenticated (requireSession + 2FA + property access) via commsContext.
 * Any authenticated staffer with property access can reply — NOT manager-gated.
 * createLogReply confirms the recap is in this property, so a guessed entryId
 * from another hotel returns 404 (no cross-tenant write). NO SMS.
 */
import type { NextRequest } from 'next/server';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { validateUuid, validateString } from '@/lib/api-validate';
import { checkAndIncrementRateLimit, rateLimitedResponse, hashToRateLimitKey } from '@/lib/api-ratelimit';
import { commsContext } from '@/lib/comms/route-helpers';
import { listLogReplies, createLogReply } from '@/lib/comms/core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<Response> {
  const { searchParams } = new URL(req.url);
  const ctx = await commsContext(req, searchParams.get('pid'));
  if (!ctx.ok) return ctx.response;

  const idV = validateUuid(searchParams.get('entryId'), 'entryId');
  if (idV.error) return err(idV.error, { requestId: ctx.requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: ctx.headers });

  const rl = await checkAndIncrementRateLimit('comms-logbook', hashToRateLimitKey(`${ctx.pid}:${ctx.userId}`));
  if (!rl.allowed) return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);

  const replies = await listLogReplies(ctx.pid, idV.value!);
  return ok({ replies }, { requestId: ctx.requestId, headers: ctx.headers });
}

export async function POST(req: NextRequest): Promise<Response> {
  let body: { pid?: string; entryId?: string; body?: string };
  try { body = await req.json(); } catch { body = {}; }

  const ctx = await commsContext(req, body.pid ?? null);
  if (!ctx.ok) return ctx.response;

  const idV = validateUuid(body.entryId, 'entryId');
  if (idV.error) return err(idV.error, { requestId: ctx.requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: ctx.headers });

  const text = typeof body.body === 'string' ? body.body.trim() : body.body;
  const bodyV = validateString(text, { max: 5000, label: 'body' });
  if (bodyV.error) return err(bodyV.error, { requestId: ctx.requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: ctx.headers });

  const rl = await checkAndIncrementRateLimit('comms-logbook', hashToRateLimitKey(`${ctx.pid}:${ctx.userId}`));
  if (!rl.allowed) return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);

  const res = await createLogReply(ctx.pid, idV.value!, { authorStaffId: ctx.staffId, body: bodyV.value! });
  if (!res) return err('Recap not found', { requestId: ctx.requestId, status: 404, code: ApiErrorCode.NotFound, headers: ctx.headers });
  return ok({ id: res.id }, { requestId: ctx.requestId, status: 201, headers: ctx.headers });
}
