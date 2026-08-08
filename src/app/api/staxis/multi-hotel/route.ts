import type { NextRequest } from 'next/server';

import { requireSession } from '@/lib/api-auth';
import { ApiErrorCode, err, ok } from '@/lib/api-response';
import { validateUuid } from '@/lib/api-validate';
import { checkAndIncrementRateLimit, hashToRateLimitKey, rateLimitedResponse } from '@/lib/api-ratelimit';
import { getOrMintRequestId, log } from '@/lib/log';
import { loadSessionAccount } from '@/lib/team-auth';
import {
  multiHotelScopeStillCurrent,
  resolveMultiHotelScope,
} from '@/lib/staxis/multi-hotel-scope';
import { readLogRepliesForHotel, readMultiHotelSurface } from '@/lib/staxis/multi-hotel';
import type { MultiHotelSurface } from '@/lib/staxis/multi-hotel-types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/** Aggregate reads fan out with bounded per-hotel work and a 30s service budget. */
export const maxDuration = 40;

const SURFACES: readonly MultiHotelSurface[] = ['logbook', 'assigned-by-me', 'knows'];

function isSurface(value: string | null): value is MultiHotelSurface {
  return !!value && (SURFACES as readonly string[]).includes(value);
}

function refusal(
  reason: 'invalid_request' | 'forbidden' | 'unavailable' | 'scope_changed' | 'too_large',
  requestId: string,
) {
  if (reason === 'invalid_request') {
    return err('Invalid multi-hotel request', {
      requestId, status: 400, code: ApiErrorCode.ValidationFailed,
    });
  }
  if (reason === 'too_large') {
    return err('That hotel scope is too large to load safely', {
      requestId, status: 413, code: ApiErrorCode.ValidationFailed,
    });
  }
  if (reason === 'unavailable') {
    return err('Could not verify your current hotel access', {
      requestId,
      status: 503,
      code: ApiErrorCode.UpstreamFailure,
      headers: { 'Retry-After': '5' },
    });
  }
  if (reason === 'scope_changed') {
    return err('Your hotel access changed while this screen was loading', {
      requestId, status: 409, code: ApiErrorCode.IdempotencyConflict,
    });
  }
  return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Forbidden });
}

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = getOrMintRequestId(req);
  const session = await requireSession(req, { requestId });
  if (!session.ok) return session.response;

  const params = new URL(req.url).searchParams;
  const surfaceRaw = params.get('surface');
  if (!isSurface(surfaceRaw)) {
    return refusal('invalid_request', requestId);
  }
  const organizationValues = params.getAll('organizationId');
  if (organizationValues.length > 1) return refusal('invalid_request', requestId);
  const organizationId = organizationValues[0] ?? null;
  const propertyIdRaw = params.get('propertyId');
  const entryIdRaw = params.get('entryId');
  if ((propertyIdRaw && !entryIdRaw) || (!propertyIdRaw && entryIdRaw)) {
    return refusal('invalid_request', requestId);
  }
  const propertyId = propertyIdRaw ? validateUuid(propertyIdRaw, 'propertyId') : null;
  const entryId = entryIdRaw ? validateUuid(entryIdRaw, 'entryId') : null;
  if (propertyId?.error || entryId?.error) return refusal('invalid_request', requestId);

  const account = await loadSessionAccount(session.userId);
  if (!account) return refusal('forbidden', requestId);
  const rateLimit = await checkAndIncrementRateLimit(
    'comms-read',
    hashToRateLimitKey(`${account.accountId}:${organizationId ?? 'authority'}`),
  );
  if (!rateLimit.allowed) return rateLimitedResponse(rateLimit.current, rateLimit.cap, rateLimit.retryAfterSec);
  const resolved = await resolveMultiHotelScope({
    accountId: account.accountId,
    authUserId: session.userId,
    organizationId,
  });
  if (!resolved.ok) return refusal(resolved.reason, requestId);

  try {
    if (propertyId?.value && entryId?.value) {
      if (surfaceRaw !== 'logbook') return refusal('invalid_request', requestId);
      const hotel = resolved.scope.hotels.find((candidate) => candidate.propertyId === propertyId.value);
      if (!hotel) return refusal('forbidden', requestId);
      const replies = await readLogRepliesForHotel(hotel, entryId.value);
      const current = await multiHotelScopeStillCurrent(resolved.scope);
      if (!current.ok) return refusal(current.reason, requestId);
      if (!replies.ok) {
        return err('Could not load this log book entry', {
          requestId, status: 503, code: ApiErrorCode.UpstreamFailure, headers: { 'Retry-After': '5' },
        });
      }
      return ok({
        surface: surfaceRaw,
        hotel: { propertyId: hotel.propertyId, hotelName: hotel.hotelName, timezone: hotel.timezone },
        entryId: entryId.value,
        replies: replies.value,
        ready: true,
      }, { requestId });
    }
    const payload = await readMultiHotelSurface(resolved.scope, surfaceRaw);
    // A receipt is the exact selected-company grant. Reassert it after all
    // service-role reads, immediately before any aggregate data leaves the
    // server. Hotel-only authority is re-read through the same helper.
    const current = await multiHotelScopeStillCurrent(resolved.scope);
    if (!current.ok) return refusal(current.reason, requestId);
    return ok(
      {
        surface: surfaceRaw,
        hotels: payload.hotels,
        coverage: payload.coverage,
        ...(payload.entries ? { entries: payload.entries } : {}),
        ...(payload.assigned ? { assigned: payload.assigned } : {}),
        ...(payload.items ? { items: payload.items } : {}),
        ready: payload.coverage.complete,
      },
      { requestId },
    );
  } catch (error) {
    log.error('[staxis:multi-hotel] aggregate read failed', {
      requestId,
      surface: surfaceRaw,
      err: error instanceof Error ? error.message : String(error),
    });
    return err('Could not load this hotel view', {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }
}
