/**
 * GET /api/complaints/summary?pid=...
 *
 * Count-only Dashboard projection. Raw complaints contain guest PII and are
 * route-only: this boundary requires current authoritative hotel reach, the
 * same manager/front-desk operational-role policy as the unified worklist,
 * and the property's complaint capability before it runs service-role counts.
 * A safe aggregate does not require hotel mutation standing, so read-only
 * management-company oversight can still see the main operations signal.
 */

import type { NextRequest } from 'next/server';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { requireSession } from '@/lib/api-auth';
import { validateUuid } from '@/lib/api-validate';
import { getOrMintRequestId, log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import {
  callerReachesHotel,
  callerRoleAtHotel,
  loadSessionAccount,
} from '@/lib/team-auth';
import { capabilityDecisionForProperty } from '@/lib/capabilities/server';
import { capabilityUnavailableResponse } from '@/lib/capabilities/api-gate';
import { worklistSeesAllSources } from '@/lib/worklist/core';
import { loadComplaintDashboardSummary } from '@/lib/complaints-summary-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = getOrMintRequestId(req);
  const headers = {
    'x-request-id': requestId,
    'Cache-Control': 'private, no-store, max-age=0',
  };
  const pidResult = validateUuid(new URL(req.url).searchParams.get('pid'), 'pid');
  if (pidResult.error) {
    return err(pidResult.error, {
      requestId,
      status: 400,
      code: ApiErrorCode.ValidationFailed,
      headers,
    });
  }
  const propertyId = pidResult.value!;

  const session = await requireSession(req, { requestId });
  if (!session.ok) return session.response;

  const caller = await loadSessionAccount(session.userId);
  if (!caller || !callerReachesHotel(caller, propertyId)) {
    return err('property access denied', {
      requestId,
      status: 403,
      code: ApiErrorCode.Forbidden,
      headers,
    });
  }

  const role = callerRoleAtHotel(caller, propertyId);
  if (!role || !worklistSeesAllSources(role)) {
    // Local floor staff can load the Dashboard without learning whether the
    // hotel has complaints. A successful hidden projection also avoids a
    // misleading repeated error banner for data their role is not meant to see.
    return ok({ visible: false as const }, { requestId, headers });
  }

  const capability = await capabilityDecisionForProperty(
    { role },
    'use_complaints',
    propertyId,
  );
  if (capability === 'unavailable') return capabilityUnavailableResponse(requestId);
  if (capability === 'denied') {
    return ok({ visible: false as const }, { requestId, headers });
  }

  try {
    const summary = await loadComplaintDashboardSummary(propertyId);
    return ok(summary, { requestId, headers });
  } catch (error) {
    log.error('complaints/summary: failed', {
      requestId,
      propertyId,
      err: errToString(error),
    });
    return err('Could not load complaint summary', {
      requestId,
      status: 500,
      code: ApiErrorCode.InternalError,
      headers,
    });
  }
}
