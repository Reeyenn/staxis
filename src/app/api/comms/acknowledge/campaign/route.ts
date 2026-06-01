/**
 * GET /api/comms/acknowledge/campaign?pid=...&campaignId=...
 * Manager-only aggregate completion of an org-wide mandatory-read campaign:
 *   { total, acked, properties: [{ propertyName, total, acked }] }
 * The aggregate is limited to the properties the caller can access — it never
 * leaks acknowledgement data from a hotel they aren't scoped to. `pid` is the
 * active property (used to authenticate via commsContext). NO SMS.
 */
import type { NextRequest } from 'next/server';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { validateUuid } from '@/lib/api-validate';
import { checkAndIncrementRateLimit, rateLimitedResponse, hashToRateLimitKey } from '@/lib/api-ratelimit';
import { commsContext, listAccessiblePropertyIds } from '@/lib/comms/route-helpers';
import { getCampaignStatus } from '@/lib/comms/core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<Response> {
  const { searchParams } = new URL(req.url);
  const ctx = await commsContext(req, searchParams.get('pid'));
  if (!ctx.ok) return ctx.response;

  if (!ctx.isManager) {
    return err('only managers can view campaign status', { requestId: ctx.requestId, status: 403, code: ApiErrorCode.Forbidden, headers: ctx.headers });
  }

  const campV = validateUuid(searchParams.get('campaignId'), 'campaignId');
  if (campV.error) {
    return err(campV.error, { requestId: ctx.requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: ctx.headers });
  }

  const rl = await checkAndIncrementRateLimit('comms-read', hashToRateLimitKey(`${ctx.pid}:${ctx.userId}`));
  if (!rl.allowed) return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);

  const allowed = await listAccessiblePropertyIds(ctx.role, ctx.propertyAccess);
  const status = await getCampaignStatus(campV.value!, allowed);
  if (!status) {
    return err('Not found', { requestId: ctx.requestId, status: 404, code: ApiErrorCode.NotFound, headers: ctx.headers });
  }

  return ok(status, { requestId: ctx.requestId, headers: ctx.headers });
}
