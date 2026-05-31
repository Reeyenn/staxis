/**
 * POST /api/complaints/log
 *
 * Log a guest complaint from the authed manager UI (Front Desk > Complaints).
 * Shares createComplaint() with the agent/voice tool so the AI categorize +
 * severity + auto-route-to-work-order behaviour is identical across surfaces.
 *
 * Session-gated (manager is signed in) + per-property capability check.
 */

import type { NextRequest } from 'next/server';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { log, getOrMintRequestId } from '@/lib/log';
import { errToString } from '@/lib/utils';
import { validateUuid, validateString, validateEnum } from '@/lib/api-validate';
import { requireSession, userHasPropertyAccess } from '@/lib/api-auth';
import { checkAndIncrementRateLimit, rateLimitedResponse, hashToRateLimitKey } from '@/lib/api-ratelimit';
import { createComplaint } from '@/lib/complaints-create';
import { COMPLAINT_CATEGORIES, COMPLAINT_SEVERITIES } from '@/lib/complaints-shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30; // AI classify + auto-route can take a few seconds

interface Body {
  pid?: string;
  description?: string;
  roomNumber?: string;
  guestName?: string;
  guestContact?: string;
  category?: string;
  severity?: string;
  createdByName?: string;
}

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = getOrMintRequestId(req);
  const headers = { 'x-request-id': requestId };

  const session = await requireSession(req, { requestId });
  if (!session.ok) return session.response;

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return err('invalid json', { requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers });
  }

  const pidV = validateUuid(body.pid, 'pid');
  if (pidV.error) return err(pidV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers });
  const pid = pidV.value!;

  const descV = validateString(body.description, { max: 2000, label: 'description' });
  if (descV.error) return err(descV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers });

  // Optional fields — category/severity are auto-classified when omitted.
  let category: (typeof COMPLAINT_CATEGORIES)[number] | undefined;
  if (body.category != null && body.category !== '') {
    const cV = validateEnum(body.category, COMPLAINT_CATEGORIES, 'category');
    if (cV.error) return err(cV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers });
    category = cV.value;
  }
  let severity: (typeof COMPLAINT_SEVERITIES)[number] | undefined;
  if (body.severity != null && body.severity !== '') {
    const sV = validateEnum(body.severity, COMPLAINT_SEVERITIES, 'severity');
    if (sV.error) return err(sV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers });
    severity = sV.value;
  }
  for (const [val, lbl, max] of [
    [body.roomNumber, 'roomNumber', 20], [body.guestName, 'guestName', 120],
    [body.guestContact, 'guestContact', 200], [body.createdByName, 'createdByName', 120],
  ] as [string | undefined, string, number][]) {
    if (val != null) {
      const v = validateString(val, { max, label: lbl, allowEmpty: true });
      if (v.error) return err(v.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers });
    }
  }

  const hasAccess = await userHasPropertyAccess(session.userId, pid);
  if (!hasAccess) return err('property access denied', { requestId, status: 403, code: ApiErrorCode.Forbidden, headers });

  const rl = await checkAndIncrementRateLimit('complaints-log', hashToRateLimitKey(`${pid}:${session.userId}`));
  if (!rl.allowed) return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);

  try {
    const result = await createComplaint({
      propertyId: pid,
      description: descV.value!,
      roomNumber: body.roomNumber?.trim() || null,
      guestName: body.guestName?.trim() || null,
      guestContact: body.guestContact?.trim() || null,
      category: category ?? null,
      severity: severity ?? null,
      source: 'front_desk',
      createdBy: session.userId,
      createdByName: body.createdByName?.trim() || null,
    });
    return ok(
      {
        complaint: result.complaint,
        linkedWorkOrderId: result.linkedWorkOrderId,
        aiClassified: result.aiClassified,
        repeatCount: result.repeatCount,
      },
      { requestId, status: 201, headers },
    );
  } catch (caughtErr) {
    log.error('complaints/log: failed', { requestId, err: errToString(caughtErr) });
    return err('Could not log complaint', { requestId, status: 500, code: ApiErrorCode.InternalError, headers });
  }
}
