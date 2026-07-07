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
import { requireSectionEnabled } from '@/lib/sections/server';
import { listConversationsForStaff, listStaff, touchPresence, listOnlineStaff } from '@/lib/comms/core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<Response> {
  const { searchParams } = new URL(req.url);
  const ctx = await commsContext(req, searchParams.get('pid'));
  if (!ctx.ok) return ctx.response;

  // Section gate (add-on, on top of the comms tenant guard above): if
  // Communications is turned off for this hotel, block the tab bootstrap.
  const sectionGate = await requireSectionEnabled(req, ctx.pid, 'communications');
  if (!sectionGate.ok) return sectionGate.response;

  const rl = await checkAndIncrementRateLimit('comms-read', hashToRateLimitKey(`${ctx.pid}:${ctx.userId}`));
  if (!rl.allowed) return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);

  // Record that the caller is active right now (drives the green "on shift"
  // presence dots), then read back the whole property's online set.
  await touchPresence(ctx.pid, ctx.staffId);
  const [conversations, staff, online] = await Promise.all([
    listConversationsForStaff(ctx.pid, ctx.staffId, { isManager: ctx.isManager, dept: ctx.dept, floorMode: false }),
    listStaff(ctx.pid),
    listOnlineStaff(ctx.pid),
  ]);
  const onlineStaffIds = Array.from(online);
  // An un-acked required announcement (unread=0, pendingAck>0) still lights the
  // badge — passive "seen" doesn't clear a mandatory read.
  const unreadTotal = conversations.reduce((s, c) => s + Math.max(c.unread, c.pendingAck ?? 0), 0);

  // Can this manager launch an org-wide (all-properties) mandatory-read campaign?
  // True for admins / '*' wildcard, or anyone scoped to more than one property.
  const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const canOrgWide = ctx.isManager && (
    ctx.role === 'admin'
    || ctx.propertyAccess.includes('*')
    || ctx.propertyAccess.filter((p) => UUID_RX.test(p)).length > 1
  );

  return ok(
    {
      me: { staffId: ctx.staffId, role: ctx.role, isManager: ctx.isManager, dept: ctx.dept, lang: ctx.lang, displayName: ctx.displayName, canOrgWide },
      conversations,
      staff: staff.filter((s) => s.id !== ctx.staffId),
      unreadTotal,
      onlineStaffIds,
    },
    { requestId: ctx.requestId, headers: ctx.headers },
  );
}
