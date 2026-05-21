// POST /api/housekeeper/exchange-code
//
// F-NEW-02 (Batch D). The housekeeper SMS link used to embed the Supabase
// magic-link hashed_token directly in the URL — a one-week capability
// credential exposed to Vercel access logs, Sentry breadcrumbs, browser
// history, Referer headers, etc.
//
// Batch D moves the credential server-side. The SMS URL now carries a
// short opaque CODE; the housekeeper page POSTs the code here, this
// route swaps it for the hashed_token (returned ONLY in the JSON body,
// never in a URL), and the page calls supabase.auth.verifyOtp with it
// to establish a session.
//
// Body: { code: string, pid: uuid, staffId: uuid }
//
// Security model:
//   • Public route (no auth) — by design. The SMS link is opened by an
//     unauthenticated housekeeper; that's the whole point of the magic-
//     link flow. The code itself is the capability.
//   • Rate-limited per source IP. The code is ~40-bit, but a rate limit
//     bounds brute-force enumeration even further.
//   • The body's staffId + pid must match what's stored on the
//     staff_magic_codes row. So a stolen code can't be redirected to a
//     different staffId/pid pairing.
//   • Atomic single-use via consumed_at CAS. A captured-in-flight code
//     can be used exactly once — by the legitimate first redeemer OR by
//     the attacker, not both. (The page is the legitimate redeemer in
//     the normal flow, so the attacker's replay fails.)
//   • The token is returned in the response body. The page calls
//     setSession with it, then it lives in browser storage exactly like
//     any other Supabase session. No URL exposure, no Referer leak.

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { log, getOrMintRequestId } from '@/lib/log';
import { validateUuid, validateString } from '@/lib/api-validate';
import { checkAndIncrementRateLimit, rateLimitedResponse, ipToRateLimitKey } from '@/lib/api-ratelimit';
import { logSecurityEvent } from '@/lib/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Body {
  code?: unknown;
  pid?: unknown;
  staffId?: unknown;
}

export async function POST(req: NextRequest) {
  const requestId = getOrMintRequestId(req);

  // Rate limit by source IP. Codes are ~40 bits of entropy; combined
  // with this cap the brute-force space is millennia-deep per real
  // code. Same shape as the auth-use-join-code limiter.
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || req.headers.get('x-real-ip')?.trim()
    || '';
  const ipKey = ipToRateLimitKey(ip);
  const rl = await checkAndIncrementRateLimit('housekeeper-exchange-code', ipKey);
  if (!rl.allowed) {
    return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return err('Invalid JSON body', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }

  const codeV = validateString(body.code, { min: 4, max: 32, label: 'code' });
  if (codeV.error) return err(codeV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  const pidV = validateUuid(body.pid, 'pid');
  if (pidV.error) return err(pidV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  const staffV = validateUuid(body.staffId, 'staffId');
  if (staffV.error) return err(staffV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });

  const code = codeV.value!.toUpperCase();
  const pid = pidV.value!;
  const staffId = staffV.value!;

  // Lookup the code with all three identity factors. Returning no row
  // could mean: (a) code was never minted, (b) code expired, (c) code
  // already consumed, (d) attacker is probing a real code with the
  // wrong staffId/pid. We don't distinguish to avoid leaking which
  // axis failed — the page just sees "code didn't work, sign in again."
  const { data: row, error: lookupErr } = await supabaseAdmin
    .from('staff_magic_codes')
    .select('code, hashed_token, expires_at, consumed_at')
    .eq('code', code)
    .eq('staff_id', staffId)
    .eq('property_id', pid)
    .maybeSingle();
  if (lookupErr) {
    log.error('[exchange-code] lookup failed', { requestId, err: lookupErr.message });
    return err('Internal server error', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }
  if (!row) {
    // Possible attack signal. Not loud enough to log every miss (would
    // flood Sentry on legitimate stale-SMS taps), but we do count via
    // the rate-limit bucket above.
    return err('Code not found or no longer valid', {
      requestId, status: 404, code: ApiErrorCode.NotFound,
    });
  }
  if (row.consumed_at) {
    return err('Code already used', { requestId, status: 410, code: ApiErrorCode.IdempotencyConflict });
  }
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    return err('Code expired', { requestId, status: 410, code: ApiErrorCode.IdempotencyConflict });
  }

  // Atomic single-use claim. The .is('consumed_at', null) clause means
  // two parallel exchanges race — only one's UPDATE returns a row.
  // The loser sees 0 rows and falls into the "already used" path.
  const nowIso = new Date().toISOString();
  const { data: claimed, error: claimErr } = await supabaseAdmin
    .from('staff_magic_codes')
    .update({ consumed_at: nowIso })
    .eq('code', code)
    .is('consumed_at', null)
    .select('hashed_token')
    .maybeSingle();
  if (claimErr) {
    log.error('[exchange-code] claim update failed', { requestId, err: claimErr.message });
    return err('Internal server error', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }
  if (!claimed) {
    // Lost the CAS race — another request just consumed it.
    return err('Code already used', { requestId, status: 410, code: ApiErrorCode.IdempotencyConflict });
  }

  // Successful exchange. Write an audit event so we can correlate later
  // (was a code actually used? when? for which staff?).
  await logSecurityEvent({
    action: 'auth.magic_code_exchanged',
    propertyId: pid,
    requestId,
    metadata: { staffId },
  });

  return ok({ hashedToken: claimed.hashed_token }, { requestId });
}
