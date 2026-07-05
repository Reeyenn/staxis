// ═══════════════════════════════════════════════════════════════════════════
// Per-staff link-token verification — the credential for the public mobile
// surface (housekeeper / laundry / engineer / save-fcm-token).
//
// SECURITY AUDIT 2026-06-26 #1 (HIGH — public staffId enumeration).
//
// BEFORE: every public mobile route trusted the (pid, staffId) tuple from the
// SMS-link URL as its only credential — "does a staff row with this id on this
// property exist and is it active?". pid leaks (SMS forwarding, browser
// history, Referer, carrier logs) and /api/staff-list handed out live staff
// UUIDs, so anyone with a pid could enumerate staff and act as any of them.
//
// AFTER: the SMS link carries a per-staff bearer token (`&tok=<raw>`), minted
// at send time (src/lib/staff-auth.ts → mintStaffLinkToken), stored HASHED in
// staff_link_tokens (0295). This helper resolves identity FROM the token:
//   token_hash → staff row → the URL's pid/staffId must match that row.
// A raw (pid, staffId) with no valid token is rejected. staffId may still ride
// in URLs for back-compat parsing but is no longer sufficient.
//
// This is the ONE place the check lives. The three capability choke points —
// gateHousekeeperRequest (housekeeper-workflow POSTs), checkStaffCapability
// (engineer routes), and the inline (pid,staffId) lookups on the remaining
// GET/POST routes — all call verifyStaffLinkToken. Do not re-implement the
// hash/lookup anywhere else.
// ═══════════════════════════════════════════════════════════════════════════

import { createHash } from 'node:crypto';
import type { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { err, ApiErrorCode } from '@/lib/api-response';
import { errToString } from '@/lib/utils';
import { log } from '@/lib/log';
import {
  checkAndIncrementRateLimit,
  rateLimitedResponse,
  clientIpRateLimitKey,
} from '@/lib/api-ratelimit';

/**
 * sha256(rawToken) → hex. Same idiom as trusted-device.ts hashDeviceToken.
 * The raw token lives only in the SMS URL + the browser; only this hash is
 * ever persisted (staff_link_tokens.token_hash).
 */
export function hashStaffLinkToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}

export interface StaffLinkIdentity {
  staffId: string;
  propertyId: string;
  name: string;
  language: string;
  department: string | null;
  isSenior: boolean;
}

export type StaffLinkResult =
  | { ok: true; staff: StaffLinkIdentity }
  | { ok: false; response: NextResponse };

/**
 * Pull the raw link token from a request. GETs carry it in the query string
 * (`?tok=`); POSTs may carry it in the query OR the parsed JSON body. Callers
 * that already parsed the body pass it via `bodyToken`.
 */
export function extractStaffLinkToken(req: NextRequest, bodyToken?: unknown): string | null {
  const q = new URL(req.url).searchParams.get('tok');
  if (typeof q === 'string' && q.length > 0) return q;
  if (typeof bodyToken === 'string' && bodyToken.length > 0) return bodyToken;
  return null;
}

/**
 * The core credential check for the public mobile surface.
 *
 * Given a request + the (pid, staffId) the route parsed from the URL, verify
 * the accompanying `tok` bearer:
 *   1. Rate-limit verification FAILURES per source IP (bounds token-spray).
 *   2. Resolve token_hash → staff_link_tokens row (unexpired, unrevoked).
 *   3. The row's staff_id / property_id MUST equal the URL's staffId / pid.
 *   4. The staff row must still be active.
 *
 * Returns the resolved identity, or a Response the route returns immediately.
 * We never distinguish "no token" / "bad token" / "wrong pair" to the caller —
 * a single 401 avoids leaking which axis failed.
 *
 * @param opts.requestId    request id for the error envelope
 * @param opts.bodyToken    token already parsed from a POST body, if any
 * @param opts.consumeRateLimit  set false to skip the failure rate-limit
 *                                increment (e.g. a route that already ran its
 *                                own IP limiter). Defaults true.
 */
export async function verifyStaffLinkToken(
  req: NextRequest,
  args: { pid: string; staffId: string; requestId: string; bodyToken?: unknown },
): Promise<StaffLinkResult> {
  const { pid, staffId, requestId } = args;

  const fail = (): { ok: false; response: NextResponse } => ({
    ok: false,
    response: err('Invalid or missing link token', {
      requestId,
      status: 401,
      code: ApiErrorCode.Unauthorized,
    }),
  });

  const rawToken = extractStaffLinkToken(req, args.bodyToken);

  // Rate-limit verification FAILURES per source IP so an attacker can't spray
  // guesses across the ~256-bit token space (already infeasible, but this
  // bounds it further and de-fangs a pid+staffId enumeration retry loop). We
  // increment only when there is no valid outcome — a legitimate holder never
  // trips it. Keyed on the trusted client IP via clientIpRateLimitKey (NOT a
  // raw pid — that would FK-violate api_limits; ipToRateLimitKey shape is a
  // hashed UUID that is safe as the property_id column).
  const bumpFailure = async () => {
    try {
      await checkAndIncrementRateLimit('staff-link-verify-fail', clientIpRateLimitKey(req));
    } catch (e) {
      // Never let a rate-limit backend blip turn a real failure into a pass or
      // a 500 — log and proceed to return the 401.
      log.warn('[staff-link-auth] failure rate-limit bump errored', {
        requestId,
        msg: errToString(e),
      });
    }
  };

  if (!rawToken) {
    // Before returning, check the failure budget so a tokenless enumeration
    // storm gets 429'd rather than a cheap 401 per attempt.
    const rl = await checkAndIncrementRateLimit('staff-link-verify-fail', clientIpRateLimitKey(req));
    if (!rl.allowed) return { ok: false, response: rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec) };
    return fail();
  }

  let row:
    | { staff_id: string; property_id: string; expires_at: string; revoked_at: string | null }
    | null = null;
  try {
    const { data, error } = await supabaseAdmin
      .from('staff_link_tokens')
      .select('staff_id, property_id, expires_at, revoked_at')
      .eq('token_hash', hashStaffLinkToken(rawToken))
      .maybeSingle();
    if (error) {
      log.error('[staff-link-auth] token lookup failed', { requestId, msg: errToString(error) });
      return {
        ok: false,
        response: err('Internal server error', {
          requestId,
          status: 500,
          code: ApiErrorCode.InternalError,
        }),
      };
    }
    row = data;
  } catch (e) {
    log.error('[staff-link-auth] token lookup threw', { requestId, msg: errToString(e) });
    return {
      ok: false,
      response: err('Internal server error', {
        requestId,
        status: 500,
        code: ApiErrorCode.InternalError,
      }),
    };
  }

  // Any of: unknown token, expired, revoked, or bound to a different
  // staff/property than the URL claims → indistinguishable 401 + failure bump.
  const now = Date.now();
  if (
    !row ||
    row.revoked_at !== null ||
    new Date(row.expires_at).getTime() <= now ||
    row.staff_id !== staffId ||
    row.property_id !== pid
  ) {
    const rl = await checkAndIncrementRateLimit('staff-link-verify-fail', clientIpRateLimitKey(req));
    if (!rl.allowed) return { ok: false, response: rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec) };
    return fail();
  }

  // Token is valid + bound to (pid, staffId). Load the staff row to confirm
  // it's still active and return the identity fields the routes need.
  let staff:
    | { id: string; name: string | null; language: string | null; department: string | null; is_senior: boolean | null; is_active: boolean | null }
    | null = null;
  try {
    const { data, error } = await supabaseAdmin
      .from('staff')
      .select('id, name, language, department, is_senior, is_active')
      .eq('id', staffId)
      .eq('property_id', pid)
      .maybeSingle();
    if (error) {
      log.error('[staff-link-auth] staff lookup failed', { requestId, msg: errToString(error) });
      return {
        ok: false,
        response: err('Internal server error', {
          requestId,
          status: 500,
          code: ApiErrorCode.InternalError,
        }),
      };
    }
    staff = data;
  } catch (e) {
    log.error('[staff-link-auth] staff lookup threw', { requestId, msg: errToString(e) });
    return {
      ok: false,
      response: err('Internal server error', {
        requestId,
        status: 500,
        code: ApiErrorCode.InternalError,
      }),
    };
  }

  // Deactivated staff keep the token row but must not act on it (fired-employee
  // stale-link replay). is_active is null-as-active per app convention.
  if (!staff || staff.is_active === false) {
    await bumpFailure();
    return fail();
  }

  // Best-effort touch of last_used_at — never block the request on it.
  void supabaseAdmin
    .from('staff_link_tokens')
    .update({ last_used_at: new Date().toISOString() })
    .eq('token_hash', hashStaffLinkToken(rawToken))
    .then(({ error }) => {
      if (error) log.warn('[staff-link-auth] last_used_at touch failed', { requestId, msg: errToString(error) });
    });

  return {
    ok: true,
    staff: {
      staffId: String(staff.id),
      propertyId: pid,
      name: String(staff.name ?? ''),
      language: typeof staff.language === 'string' ? staff.language : 'en',
      department: typeof staff.department === 'string' ? staff.department : null,
      isSenior: staff.is_senior === true,
    },
  };
}
