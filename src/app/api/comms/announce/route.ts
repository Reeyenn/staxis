/**
 * POST /api/comms/announce  — Body: { pid, body }
 * Managers broadcast an announcement to everyone. This is the ONE broadcast
 * path: it posts to the Communications announcement feed AND mirrors to the
 * legacy housekeeping_notices banner (so housekeeper phones still show it).
 * Each reader sees it auto-translated into their language. NO SMS.
 */
import type { NextRequest } from 'next/server';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { checkAndIncrementRateLimit, rateLimitedResponse, hashToRateLimitKey } from '@/lib/api-ratelimit';
import { commsContext } from '@/lib/comms/route-helpers';
import { postAnnouncement } from '@/lib/comms/core';
import { translateNoticeToSpanish } from '@/lib/notice-translate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 20;

export async function POST(req: NextRequest): Promise<Response> {
  let body: { pid?: string; body?: string };
  try { body = await req.json(); } catch { body = {}; }

  const ctx = await commsContext(req, body.pid ?? null);
  if (!ctx.ok) return ctx.response;

  if (!ctx.isManager) {
    return err('only managers can post announcements', { requestId: ctx.requestId, status: 403, code: ApiErrorCode.Forbidden, headers: ctx.headers });
  }

  const text = (body.body ?? '').trim();
  if (!text) {
    return err('announcement is empty', { requestId: ctx.requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: ctx.headers });
  }
  if (text.length > 2000) {
    return err('announcement too long (max 2000 chars)', { requestId: ctx.requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: ctx.headers });
  }

  const rl = await checkAndIncrementRateLimit('comms-send', hashToRateLimitKey(`${ctx.pid}:${ctx.userId}`));
  if (!rl.allowed) return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);

  // Translate to Spanish once for the legacy notice banner (best-effort).
  const bodyEs = ctx.lang === 'es' ? text : await translateNoticeToSpanish(text);

  const res = await postAnnouncement(ctx.pid, {
    body: text,
    sourceLang: ctx.lang,
    senderStaffId: ctx.staffId,
    senderAccountId: ctx.accountId,
    bodyEs,
  });

  return ok({ id: res.id }, { requestId: ctx.requestId, status: 201, headers: ctx.headers });
}
