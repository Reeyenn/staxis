// POST /api/housekeeper/log-legacy-token
//
// Fire-and-forget telemetry endpoint. Counts every redemption of the
// legacy ?token=<hashed_token> URL format on the housekeeper page so we
// know when in-flight pre-Batch-D SMSes have fully drained and the
// legacy branch can be deleted.
//
// Codex's adversarial review of Batch D flagged that the page's else if
// (token) branch had no expiry date, no flag, and no metric — meaning
// the unsafe URL-borne-credential path could persist indefinitely with
// no production evidence to decide cutover. This route writes an
// `auth.legacy_token_redeemed` SecurityEvent on every hit. Operator
// watches the count via `app_events`; once it stays at zero for ~1
// week, delete the page's legacy branch and this route.
//
// Body: { pid: uuid, staffId: uuid } — optional context for the event.
//
// Security model:
//   • Public route (no auth) — anon housekeeper page hits it.
//   • Rate-limited per source IP at 30/hr to bound abuse.
//   • The route does NOT verify the token itself — the page is already
//     about to call verifyOtp with it on the next line. This is JUST
//     telemetry; lying about a token here costs the attacker nothing
//     and gains them nothing beyond polluting our metric.

import { NextRequest } from 'next/server';
import { ok } from '@/lib/api-response';
import { getOrMintRequestId } from '@/lib/log';
import { validateUuid } from '@/lib/api-validate';
import { checkAndIncrementRateLimit, rateLimitedResponse, clientIpRateLimitKey } from '@/lib/api-ratelimit';
import { logSecurityEvent } from '@/lib/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Body {
  pid?: unknown;
  staffId?: unknown;
}

export async function POST(req: NextRequest) {
  const requestId = getOrMintRequestId(req);

  // Non-spoofable client IP (security audit 2026-06-26).
  const ipKey = clientIpRateLimitKey(req);
  const rl = await checkAndIncrementRateLimit('housekeeper-log-legacy-token', ipKey);
  if (!rl.allowed) {
    return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);
  }

  let body: Body = {};
  try {
    body = (await req.json()) as Body;
  } catch {
    // Empty body is OK — telemetry is best-effort. We still log the event
    // even without staff/property context (the count alone is the signal).
  }

  // Soft validation — if the page sends garbage we just log without
  // those fields. We don't want to 400 telemetry calls because that
  // would make the metric unreliable (failures hide the real volume).
  const pidV = body.pid !== undefined ? validateUuid(body.pid, 'pid') : null;
  const staffV = body.staffId !== undefined ? validateUuid(body.staffId, 'staffId') : null;

  await logSecurityEvent({
    action: 'auth.legacy_token_redeemed',
    propertyId: pidV?.value ?? undefined,
    requestId,
    metadata: {
      staffId: staffV?.value ?? null,
      route: '/api/housekeeper/log-legacy-token',
      // The presence of this event means the housekeeper page hit the
      // pre-Batch-D ?token= URL path. Once we see zero events for a
      // week, the page's legacy branch + this route can be deleted.
    },
  });

  return ok({ logged: true }, { requestId });
}

// Other HTTP verbs aren't exported — Next.js returns 405 by default for
// any verb we don't handle, so an explicit GET handler isn't needed.
