/**
 * GET  /api/admin/account-switch  — the demo people this admin may become.
 * POST /api/admin/account-switch  — become one of them.
 *
 * Both are behind `requireAdmin` (session + accounts.role='admin' + active),
 * which is also what src/lib/__tests__/admin-routes-auth-gate.test.ts enforces
 * for everything under /api/admin/*. The switch additionally re-verifies the
 * caller against the database inside performAccountSwitch, so the capability
 * does not rest on a single gate.
 *
 * The listable AND switchable set is computed server-side every time
 * (src/lib/admin-account-switch.ts). A POST naming an account outside that
 * set is refused with 403 regardless of what the client believes — the GET
 * response is a convenience for drawing a menu, never an authorization.
 *
 * The way back (POST /api/auth/admin-switch-return) cannot live under
 * /api/admin/* : by the time it is called the browser IS the demo person, so
 * it must not be admin-gated. See that file's header for the token design.
 */

import { NextRequest } from 'next/server';

import { requireAdmin } from '@/lib/admin-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { logSecurityEvent } from '@/lib/audit';
import { isUuid } from '@/lib/api-validate';
import { trustCookieOptions, TRUST_COOKIE_NAME } from '@/lib/trusted-device';
import {
  hintCookieOptions,
  listSwitchableDemoAccounts,
  liveSwitchableListDeps,
  livePerformSwitchDeps,
  performAccountSwitch,
  returnCookieOptions,
} from '@/lib/admin-account-switch';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const admin = await requireAdmin(req);
  if (!admin.ok) return admin.response;

  const accounts = await listSwitchableDemoAccounts(liveSwitchableListDeps());
  if (!accounts) {
    return err('Could not read the demo accounts right now.', {
      requestId,
      status: 503,
      code: ApiErrorCode.UpstreamFailure,
    });
  }
  return ok({ accounts }, { requestId });
}

export async function POST(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const admin = await requireAdmin(req);
  if (!admin.ok) return admin.response;

  let accountId: unknown;
  try {
    const body = (await req.json()) as { accountId?: unknown } | null;
    accountId = body?.accountId;
  } catch {
    accountId = undefined;
  }
  if (!isUuid(accountId)) {
    return err('Pick one of the demo people.', {
      requestId,
      status: 400,
      code: ApiErrorCode.ValidationFailed,
    });
  }

  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host');
  const result = await performAccountSwitch(
    {
      callerAccountId: admin.accountId,
      callerAuthUserId: admin.userId,
      targetAccountId: accountId,
      deviceCookieValue: req.cookies.get(TRUST_COOKIE_NAME)?.value ?? null,
      nowMs: Date.now(),
    },
    livePerformSwitchDeps(),
  );

  if (!result.ok) {
    // A refused target is the interesting case: it is either a bug in the menu
    // or somebody hand-rolling a request at a real customer's account.
    if (result.reason.startsWith('not_switchable')) {
      await logSecurityEvent({
        action: 'admin.account_switch_refused',
        userId: admin.userId,
        requestId,
        metadata: { targetAccountId: accountId, reason: result.reason },
      });
    } else {
      log.warn('[account-switch] switch refused', { requestId, reason: result.reason });
    }
    return err('That account cannot be switched into.', {
      requestId,
      status: result.status,
      code: result.status === 403 ? ApiErrorCode.Forbidden : ApiErrorCode.UpstreamFailure,
    });
  }

  await logSecurityEvent({
    action: 'admin.account_switch',
    userId: admin.userId,
    requestId,
    metadata: { targetAccountId: accountId },
  });

  const response = ok(
    {
      tokenHash: result.targetTokenHash,
      displayName: result.targetDisplayName,
      returnTo: result.adminDisplayName,
    },
    { requestId },
  );

  const returnCookie = returnCookieOptions(host);
  response.cookies.set({
    name: returnCookie.name,
    value: result.returnToken,
    httpOnly: returnCookie.httpOnly,
    secure: returnCookie.secure,
    sameSite: returnCookie.sameSite,
    path: returnCookie.path,
    maxAge: returnCookie.maxAge,
    ...(returnCookie.domain ? { domain: returnCookie.domain } : {}),
  });

  // Cosmetic only. Lets the menu say "you are switched" and name the way back
  // without a network read on every page load, for every user in the product.
  const hintCookie = hintCookieOptions(host);
  response.cookies.set({
    name: hintCookie.name,
    value: encodeURIComponent(result.adminDisplayName),
    httpOnly: hintCookie.httpOnly,
    secure: hintCookie.secure,
    sameSite: hintCookie.sameSite,
    path: hintCookie.path,
    maxAge: hintCookie.maxAge,
    ...(hintCookie.domain ? { domain: hintCookie.domain } : {}),
  });

  if (result.deviceTrust.newDeviceToken) {
    const trust = trustCookieOptions(host);
    response.cookies.set({
      name: trust.name,
      value: result.deviceTrust.newDeviceToken,
      httpOnly: trust.httpOnly,
      secure: trust.secure,
      sameSite: trust.sameSite,
      path: trust.path,
      maxAge: trust.maxAge,
      ...(trust.domain ? { domain: trust.domain } : {}),
    });
  }

  return response;
}
