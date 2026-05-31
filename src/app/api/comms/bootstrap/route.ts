/**
 * GET /api/comms/bootstrap?pid=...
 * Everything the Communications tab needs on load: the caller's identity,
 * their conversation list (with unread counts), the staff directory (for the
 * DM picker), and the total unread badge. Authenticated (requireSession + 2FA)
 * via commsContext. NO SMS.
 */
import type { NextRequest } from 'next/server';
import { ok } from '@/lib/api-response';
import { checkAndIncrementRateLimit, rateLimitedResponse, hashToRateLimitKey } from '@/lib/api-ratelimit';
import { commsContext } from '@/lib/comms/route-helpers';
import { listConversationsForStaff, listStaff } from '@/lib/comms/core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<Response> {
  const { searchParams } = new URL(req.url);
  const ctx = await commsContext(req, searchParams.get('pid'));
  if (!ctx.ok) return ctx.response;

  const rl = await checkAndIncrementRateLimit('comms-read', hashToRateLimitKey(`${ctx.pid}:${ctx.userId}`));
  if (!rl.allowed) return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);

  const [conversations, staff] = await Promise.all([
    listConversationsForStaff(ctx.pid, ctx.staffId, { isManager: ctx.isManager, dept: ctx.dept, floorMode: false }),
    listStaff(ctx.pid),
  ]);
  const unreadTotal = conversations.reduce((s, c) => s + c.unread, 0);

  return ok(
    {
      me: { staffId: ctx.staffId, role: ctx.role, isManager: ctx.isManager, dept: ctx.dept, lang: ctx.lang, displayName: ctx.displayName },
      conversations,
      staff: staff.filter((s) => s.id !== ctx.staffId),
      unreadTotal,
    },
    { requestId: ctx.requestId, headers: ctx.headers },
  );
}
