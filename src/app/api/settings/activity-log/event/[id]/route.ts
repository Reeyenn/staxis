/**
 * GET /api/settings/activity-log/event/[id]?propertyId=…
 *
 * Returns the full metadata (jsonb payload, actor / target snapshot,
 * timestamps) for one activity_log row. Powers the side-panel detail
 * view on the Settings → Activity Log page.
 *
 * Auth: requireSession via verifyTeamManager — admin / owner / GM only.
 * Tenant guard: propertyId must match the row + the caller's access.
 */

import type { NextRequest, NextResponse } from 'next/server';
import { ok, err } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import { validateUuid } from '@/lib/api-validate';
import { getActivityEvent } from '@/lib/activity-log/query';
import { gateActivityLogAccess } from '@/lib/activity-log/route-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const requestId = getOrMintRequestId(req);
  try {
    const { id } = await ctx.params;
    const idCheck = validateUuid(id, 'id');
    if (idCheck.error || !idCheck.value) {
      return err(idCheck.error ?? 'id required', { requestId, status: 400, code: 'validation_failed' });
    }

    const propertyId = req.nextUrl.searchParams.get('propertyId') ?? '';
    const pidCheck = validateUuid(propertyId, 'propertyId');
    if (pidCheck.error || !pidCheck.value) {
      return err(pidCheck.error ?? 'propertyId required', { requestId, status: 400, code: 'validation_failed' });
    }

    const gate = await gateActivityLogAccess(req, pidCheck.value);
    if (!gate.ok) {
      return err(gate.error, { requestId, status: gate.status, code: gate.code });
    }

    const row = await getActivityEvent(pidCheck.value, idCheck.value);
    if (!row) {
      return err('Event not found.', { requestId, status: 404, code: 'not_found' });
    }
    return ok(row, { requestId });
  } catch (e) {
    log.error('activity-log event lookup failed', { requestId, error: errToString(e) });
    return err('Failed to load event.', { requestId, status: 500, code: 'internal_error' });
  }
}
