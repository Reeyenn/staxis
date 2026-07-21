/**
 * POST /api/complaints/draft
 *
 * AI-draft a service-recovery message + recommended make-good for an existing
 * complaint. Staff edit before sending — this is a suggestion, not an auto-send.
 *
 * Session-gated + per-property capability check + cross-tenant guard. Rate
 * limited as a billing endpoint (Claude tokens) so it fails closed on a DB blip.
 */

import type { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { log, getOrMintRequestId } from '@/lib/log';
import { errToString } from '@/lib/utils';
import { validateUuid } from '@/lib/api-validate';
import { requireSession, userHasPropertyAccess } from '@/lib/api-auth';
import { capabilityDecisionForUserId } from '@/lib/capabilities/server';
import { capabilityUnavailableResponse } from '@/lib/capabilities/api-gate';
import { checkAndIncrementRateLimit, rateLimitedResponse } from '@/lib/api-ratelimit';
import { draftServiceRecovery } from '@/lib/complaints-ai';
import { fromComplaintRow } from '@/lib/complaints-shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

interface Body {
  pid?: string;
  complaintId?: string;
}

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = getOrMintRequestId(req);
  const deadlineAt = Date.now() + 22_000;
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

  const cidV = validateUuid(body.complaintId, 'complaintId');
  if (cidV.error) return err(cidV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers });
  const complaintId = cidV.value!;

  const hasAccess = await userHasPropertyAccess(session.userId, pid);
  if (!hasAccess) return err('property access denied', { requestId, status: 403, code: ApiErrorCode.Forbidden, headers });
  const capabilityDecision = await capabilityDecisionForUserId(
    session.userId,
    'use_complaints',
    pid,
  );
  if (capabilityDecision === 'unavailable') {
    return capabilityUnavailableResponse(requestId);
  }
  if (capabilityDecision === 'denied') {
    return err('forbidden — complaints are restricted for your role at this property', { requestId, status: 403, code: ApiErrorCode.Forbidden, headers });
  }

  // Per-PROPERTY billing bucket — key must be a real properties.id (FK), not a
  // hashed composite, or the fail-closed limiter 429s every call. See log/route.
  const rl = await checkAndIncrementRateLimit('complaints-draft', pid);
  if (!rl.allowed) return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);

  try {
    // Scope the read by BOTH id AND property_id and return a single 404 for
    // any miss — so a complaint belonging to another hotel is indistinguishable
    // from a nonexistent one (no 403-vs-404 existence oracle). Mirrors the
    // hardened complaints/update pattern. (Security audit 2026-06-26.)
    const { data: row, error: readErr } = await supabaseAdmin
      .from('complaints')
      .select('*')
      .eq('id', complaintId)
      .eq('property_id', pid)
      .maybeSingle();
    if (readErr) {
      log.error('complaints/draft: read failed', { requestId, err: errToString(readErr) });
      return err('Internal server error', { requestId, status: 500, code: ApiErrorCode.InternalError, headers });
    }
    if (!row) return err('complaint not found', { requestId, status: 404, code: ApiErrorCode.NotFound, headers });

    const c = fromComplaintRow(row as Record<string, unknown>);
    const { data: account } = await supabaseAdmin
      .from('accounts')
      .select('id')
      .eq('data_user_id', session.userId)
      .maybeSingle();
    const accountId = typeof account?.id === 'string' ? account.id : null;
    const draft = await draftServiceRecovery({
      description: c.description,
      category: c.category,
      severity: c.severity,
      guestName: c.guestName,
      roomNumber: c.roomNumber,
    }, {
      deadlineAt,
      abortSignal: req.signal,
      ledger: accountId
        ? { userId: accountId, propertyId: pid, requestId, feature: 'complaints.recovery_draft' }
        : undefined,
    });

    return ok(draft, { requestId, headers });
  } catch (caughtErr) {
    log.error('complaints/draft: unexpected error', { requestId, err: errToString(caughtErr) });
    return err('Internal server error', { requestId, status: 500, code: ApiErrorCode.InternalError, headers });
  }
}
