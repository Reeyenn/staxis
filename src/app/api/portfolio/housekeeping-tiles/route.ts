/**
 * GET /api/portfolio/housekeeping-tiles?propertyIds=a,b,c
 *
 * Returns the housekeeping tile payload for each property the caller
 * has access to. When `propertyIds` is omitted, returns tiles for ALL
 * accessible properties. When provided, the route INTERSECTS the
 * requested list with the caller's `property_access` array — passing
 * an id the caller doesn't own silently drops it (no enumeration leak).
 *
 * The response includes the averages + anomalies for the same scope so
 * the page renders in one round-trip.
 *
 * Auth: requireSession.
 * Rate-limit: 120/hr per user.
 *
 * The route name is `housekeeping-tiles` to honor the orchestrator's
 * design — when a second module ships, the response shape can be
 * extended (or renamed to /tiles) without breaking the page since the
 * tiles[] array is already discriminated on `module`.
 */

import { NextRequest } from 'next/server';
import { requireSession } from '@/lib/api-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { validateUuid } from '@/lib/api-validate';
import {
  checkAndIncrementRateLimit,
  rateLimitedResponse,
  hashToRateLimitKey,
} from '@/lib/api-ratelimit';
// Side-effecting import: registers all built-in adapters at module load.
import '@/lib/portfolio';
import { buildPortfolioSnapshot } from '@/lib/portfolio/server-fetch';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;       // longer ceiling for cross-property fan-out

/** Parse the comma-separated propertyIds query param. Returns null if absent. */
function parseRequestedIds(raw: string | null): { error?: string; value?: string[] } {
  if (!raw) return { value: undefined };
  const parts = raw.split(',').map(s => s.trim()).filter(Boolean);
  if (parts.length === 0) return { value: [] };
  // Cap the requested set so a misbehaving client can't trigger an
  // arbitrarily wide fan-out — 50 properties is well above a realistic
  // single owner's portfolio and a useful guardrail.
  if (parts.length > 50) {
    return { error: 'propertyIds: too many ids (max 50)' };
  }
  const out: string[] = [];
  for (const p of parts) {
    const v = validateUuid(p, 'propertyId');
    if (v.error) return { error: v.error };
    out.push(v.value!);
  }
  return { value: out };
}

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);

  const auth = await requireSession(req, { requestId });
  if (!auth.ok) return auth.response;

  const rlKey = hashToRateLimitKey(auth.userId);
  const rl = await checkAndIncrementRateLimit('portfolio-tiles', rlKey);
  if (!rl.allowed) return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);

  const { searchParams } = new URL(req.url);
  const requested = parseRequestedIds(searchParams.get('propertyIds'));
  if (requested.error) {
    return err(requested.error, {
      requestId, status: 400, code: ApiErrorCode.ValidationFailed,
    });
  }

  try {
    const snapshot = await buildPortfolioSnapshot(auth.userId, requested.value);
    return ok(snapshot, { requestId });
  } catch (e) {
    log.error('[portfolio/housekeeping-tiles] snapshot failed', {
      requestId, userId: auth.userId,
      err: e instanceof Error ? e.message : String(e),
    });
    return err('portfolio fetch failed', {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }
}
