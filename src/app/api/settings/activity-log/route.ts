/**
 * GET /api/settings/activity-log
 *
 * Paginated timeline read for the Settings → Activity Log page.
 *
 * Query string:
 *   propertyId    (required) — UUID of the hotel
 *   from, to      ISO timestamps (occurred_at >= from < to)
 *   category      can repeat or be a comma list (housekeeping,maintenance,…)
 *   source        can repeat or be a comma list (housekeeper_app,pms_sync,…)
 *   search        free text (matched against description / actor / target)
 *   actorAccountId, targetType, targetId  optional scope filters
 *   page          1-based page index (default 1)
 *   pageSize      default 50, cap 200
 *
 * Auth: requireSession (via verifyTeamManager) — admin / owner /
 *       general_manager only. Other roles get 403.
 *
 * Tenant guard: admin can read any hotel; owner/GM can only read hotels
 *       in their property_access array.
 *
 * Returns:
 *   { ok, requestId, data: { rows, total, page, pageSize } }
 */

import type { NextRequest, NextResponse } from 'next/server';
import { ok, err } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import { queryActivityLog } from '@/lib/activity-log/query';
import { gateActivityLogAccess, parseActivityFilters } from '@/lib/activity-log/route-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<NextResponse> {
  const requestId = getOrMintRequestId(req);
  try {
    const parsed = parseActivityFilters(req.nextUrl.searchParams);
    if (!parsed.ok) {
      return err(parsed.error, { requestId, status: 400, code: 'validation_failed' });
    }
    const filters = parsed.filters;

    const gate = await gateActivityLogAccess(req, filters.propertyId);
    if (!gate.ok) {
      return err(gate.error, { requestId, status: gate.status, code: gate.code });
    }

    const result = await queryActivityLog(filters);
    return ok(result, { requestId });
  } catch (e) {
    log.error('activity-log list failed', { requestId, error: errToString(e) });
    return err('Failed to load activity log.', { requestId, status: 500, code: 'internal_error' });
  }
}
