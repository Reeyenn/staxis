/**
 * POST /api/auth/admin-switch-return — put the admin session back.
 *
 * WHY THIS IS NOT UNDER /api/admin/*
 * By the time this is called the browser IS the demo person. Gating it on
 * requireAdmin would make the way back unreachable, which is precisely the
 * trap that turns "become someone else" into a one-way door. It also would
 * fail the /api/admin/* auth-gate contract test for the wrong reason. So it
 * lives on the auth plane and carries its own gate.
 *
 * WHAT AUTHORIZES IT
 * Two things together, and neither alone is enough:
 *
 *   1. the httpOnly, HMAC-signed `staxis_admin_return` cookie that
 *      POST /api/admin/account-switch set, in this browser, at switch time,
 *      from a verified platform-admin session, and
 *   2. a LIVE session belonging to the demo person that same cookie names.
 *
 * The second one is the fix from the 2026-08-07 security audit. With only the
 * cookie, this endpoint was a bearer credential that outlived the act it
 * belonged to: an admin who switched into a demo person and then SIGNED OUT
 * left a browser that was one unauthenticated POST away from a platform-admin
 * session, for two hours, with no password and no second factor. Sign-out
 * cannot delete an httpOnly cookie from JavaScript, so the browser could not
 * clean up after itself. Requiring the presenting session to still be the
 * displaced identity is what makes "signed out" mean signed out. DELETE below
 * is the belt to that braces: sign-out asks the server to drop the cookie too.
 *
 * The full check list (signature, version+clock, presenting session, single-use
 * claim, live re-check that the bound admin is STILL an active admin, and
 * GoTrue consuming the one-time token) lives in
 * src/lib/admin-account-switch.ts.
 *
 * A demo user cannot read that cookie (httpOnly), forge it (the signing key is
 * derived from the service-role key and never leaves the server), or mint one
 * (minting is behind requireAdmin AND behind performAccountSwitch's own admin
 * re-verification). This endpoint therefore cannot be walked UP into the admin
 * account — it can only put back the exact identity that was displaced, in the
 * session that displaced it.
 *
 * The response body carries a one-time magic-link token hash, which the page
 * redeems with supabase.auth.verifyOtp to become the admin again. Both cookies
 * are cleared on every terminal outcome, success or refusal, so a failed
 * redeem never leaves a stale "Back to ..." button pointing at a dead token.
 */

import { NextRequest } from 'next/server';

import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { requireSession } from '@/lib/api-auth';
import { getOrMintRequestId, log } from '@/lib/log';
import { logSecurityEvent } from '@/lib/audit';
import {
  hintCookieOptions,
  livePerformReturnDeps,
  performAdminReturn,
  returnCookieOptions,
  RETURN_COOKIE_NAME,
} from '@/lib/admin-account-switch';
import type { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function clearSwitchCookies(response: NextResponse, host: string | null): NextResponse {
  for (const options of [returnCookieOptions(host), hintCookieOptions(host)]) {
    response.cookies.set({
      name: options.name,
      value: '',
      httpOnly: options.httpOnly,
      secure: options.secure,
      sameSite: options.sameSite,
      path: options.path,
      maxAge: 0,
      ...(options.domain ? { domain: options.domain } : {}),
    });
  }
  return response;
}

/**
 * Refusals that anyone on the internet can produce at will, by sending a cookie
 * header of their own invention. They are noise, not signal, and writing an
 * app_events row for each one would hand an unauthenticated caller an unbounded
 * write into the audit table. They still get a server log line.
 *
 * Everything else got PAST the HMAC, which means the token really was one we
 * minted — an expired one, a replay, a wrong-session redeem. Those are exactly
 * the events an investigation needs, so they are always recorded.
 */
const UNAUTHENTICATED_NOISE = new Set([
  'no_return_token',
  'token_malformed',
  'token_bad_signature',
]);

export async function POST(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host');

  // Who is asking. Resolved by the same gate every other user-facing route
  // uses, never from anything the caller can set. A browser with no session
  // resolves to null, which performAdminReturn refuses.
  const session = await requireSession(req, { requestId });
  const presenterAuthUserId = session.ok ? session.userId : null;

  const result = await performAdminReturn(
    {
      rawToken: req.cookies.get(RETURN_COOKIE_NAME)?.value ?? null,
      presenterAuthUserId,
      nowMs: Date.now(),
    },
    livePerformReturnDeps(),
  );

  if (!result.ok) {
    if (!UNAUTHENTICATED_NOISE.has(result.reason)) {
      await logSecurityEvent({
        action: 'admin.account_switch_return_refused',
        userId: presenterAuthUserId ?? undefined,
        requestId,
        metadata: { reason: result.reason, hadSession: presenterAuthUserId !== null },
      });
    }
    log.warn('[account-switch] return refused', { requestId, reason: result.reason });
    return clearSwitchCookies(
      err('That way back is no longer valid. Please sign in again.', {
        requestId,
        status: result.status,
        code: result.status === 403 ? ApiErrorCode.Forbidden : ApiErrorCode.Unauthorized,
      }),
      host,
    );
  }

  await logSecurityEvent({
    action: 'admin.account_switch_return',
    userId: result.adminAuthUserId,
    requestId,
    metadata: {
      accountId: result.adminAccountId,
      // Who the browser was, right up to this call. Without it the trail says
      // an admin session appeared but not which demo person it came out of.
      switchedFromAccountId: result.switchedFromAccountId,
    },
  });

  return clearSwitchCookies(
    ok(
      { tokenHash: result.adminTokenHash, displayName: result.adminDisplayName },
      { requestId },
    ),
    host,
  );
}

/**
 * DELETE — throw the way back away without using it.
 *
 * Sign-out calls this. The return cookie is httpOnly, so the browser cannot
 * remove it on its own, and until it is gone a signed-out browser is still
 * carrying a credential that names a platform admin. POST now refuses without
 * a matching live session, so this is defense in depth rather than the only
 * lock, but it is the difference between "inert" and "absent".
 *
 * Deliberately ungated. Discarding your own browser's cookie grants nobody
 * anything; the worst a forced call can do is cost an admin one convenience,
 * and the cookie is SameSite=Strict so it cannot be forced cross-site anyway.
 */
export async function DELETE(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host');
  return clearSwitchCookies(ok({ discarded: true }, { requestId }), host);
}
