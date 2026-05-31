/**
 * POST /api/comms/summary  — Body: { pid }
 * "What did I miss" — AI summary of the caller's unread messages across all
 * conversations, in their language. RATE LIMIT: RAW pid.
 */
import type { NextRequest } from 'next/server';
import { ok } from '@/lib/api-response';
import { checkAndIncrementRateLimit, rateLimitedResponse } from '@/lib/api-ratelimit';
import { commsContext } from '@/lib/comms/route-helpers';
import { getUnreadDigest } from '@/lib/comms/core';
import { summarizeUnread } from '@/lib/comms/assistant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function POST(req: NextRequest): Promise<Response> {
  let body: { pid?: string };
  try { body = await req.json(); } catch { body = {}; }

  const ctx = await commsContext(req, body.pid ?? null);
  if (!ctx.ok) return ctx.response;

  const rl = await checkAndIncrementRateLimit('comms-summary', ctx.pid);
  if (!rl.allowed) return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);

  const digest = await getUnreadDigest(ctx.pid, ctx.staffId, { isManager: ctx.isManager, dept: ctx.dept, floorMode: false });
  if (digest.length === 0) {
    return ok({ summary: '', count: 0 }, { requestId: ctx.requestId, headers: ctx.headers });
  }
  const summary = await summarizeUnread(digest, ctx.lang);
  return ok({ summary, count: digest.length }, { requestId: ctx.requestId, headers: ctx.headers });
}
