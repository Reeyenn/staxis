/**
 * POST /api/comms/summary  — Body: { pid }
 * "What did I miss" — AI summary of the caller's unread messages across all
 * conversations, in their language. RATE LIMIT: RAW pid.
 */
import { checkAndIncrementRateLimit, rateLimitedResponse } from '@/lib/api-ratelimit';
import { defineRoute } from '@/lib/api-route';
import { commsContext } from '@/lib/comms/route-helpers';
import { getUnreadDigest } from '@/lib/comms/core';
import { summarizeUnread } from '@/lib/comms/assistant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export const POST = defineRoute({
  body: 'empty',
  resolve: (req, body: { pid?: string }) => commsContext(req, body.pid ?? null),
  handler: async (ctx) => {
    const deadlineAt = Date.now() + 24_000;
    const rl = await checkAndIncrementRateLimit('comms-summary', ctx.pid);
    if (!rl.allowed) return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);

    const digest = await getUnreadDigest(ctx.pid, ctx.staffId, { isManager: ctx.isManager, dept: ctx.dept, floorMode: false });
    if (digest.length === 0) {
      return ctx.ok({ summary: '', count: 0 });
    }
    const summary = await summarizeUnread(digest, ctx.lang, {
      deadlineAt,
      abortSignal: ctx.req.signal,
      ledger: {
        userId: ctx.accountId,
        propertyId: ctx.pid,
        requestId: ctx.requestId,
        feature: 'communications.unread_summary',
      },
    });
    return ctx.ok({ summary, count: digest.length });
  },
});
