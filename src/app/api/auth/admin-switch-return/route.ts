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
 * Nothing the browser says. The only credential is the httpOnly, HMAC-signed
 * `staxis_admin_return` cookie that POST /api/admin/account-switch set, in
 * this browser, at switch time, from a verified platform-admin session. The
 * five checks (signature, version+clock, single-use claim, live re-check that
 * the bound admin is STILL an active admin, and GoTrue consuming the one-time
 * token) are documented in src/lib/admin-account-switch.ts.
 *
 * A demo user cannot read that cookie (httpOnly), forge it (the signing key is
 * derived from the service-role key and never leaves the server), or mint one
 * (minting is behind requireAdmin AND behind performAccountSwitch's own admin
 * re-verification). This endpoint therefore cannot be walked UP into the admin
 * account — it can only put back the exact identity that was displaced.
 *
 * The response body carries a one-time magic-link token hash, which the page
 * redeems with supabase.auth.verifyOtp to become the admin again. Both cookies
 * are cleared on every terminal outcome, success or refusal, so a failed
 * redeem never leaves a stale "Back to ..." button pointing at a dead token.
 */

import { NextRequest } from 'next/server';

import { ok, err, ApiErrorCode } from '@/lib/api-response';
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

export async function POST(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host');

  const result = await performAdminReturn(
    {
      rawToken: req.cookies.get(RETURN_COOKIE_NAME)?.value ?? null,
      nowMs: Date.now(),
    },
    livePerformReturnDeps(),
  );

  if (!result.ok) {
    if (result.reason !== 'no_return_token') {
      // Everything except "there was no cookie" is worth a security breadcrumb:
      // a bad signature, an expired token, or a replay all mean somebody or
      // something tried a return that was not the one we minted.
      await logSecurityEvent({
        action: 'admin.account_switch_return_refused',
        requestId,
        metadata: { reason: result.reason },
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
    metadata: { accountId: result.adminAccountId },
  });

  return clearSwitchCookies(
    ok(
      { tokenHash: result.adminTokenHash, displayName: result.adminDisplayName },
      { requestId },
    ),
    host,
  );
}
