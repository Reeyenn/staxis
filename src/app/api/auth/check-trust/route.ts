// POST /api/auth/check-trust
//
// Called right after a successful client-side signInWithPassword. Server reads
// the staxis_device cookie, hashes it, and looks up trusted_devices for the
// caller's account. Returns { trusted: true } if the device is currently
// trusted (cookie matches a non-expired DB row); false otherwise.
//
// On match, also bumps last_seen_at so users who keep using the same browser
// don't have their trust silently expire while they're active.
//
// The caller's account is determined from the bearer JWT, NOT from a body
// parameter — that prevents a malicious client from claiming someone else's
// account_id and probing other users' device trust state.

import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { hashDeviceToken, readDeviceCookie, trustCookieOptions } from '@/lib/trusted-device';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { log, getOrMintRequestId } from '@/lib/log';
import { env } from '@/lib/env';
import { logSecurityEvent } from '@/lib/audit';
import { isTwoFactorEnabled } from '@/lib/two-factor';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const requestId = getOrMintRequestId(req);

  // Validate JWT → auth user → accounts row.
  const auth = req.headers.get('authorization');
  const token = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return err('Unauthorized', { requestId, status: 401, code: ApiErrorCode.Unauthorized });

  const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token);
  if (userErr || !userData.user) {
    return err('Unauthorized', { requestId, status: 401, code: ApiErrorCode.Unauthorized });
  }

  const { data: account, error: acctErr } = await supabaseAdmin
    .from('accounts')
    .select('id, skip_2fa, role, property_access')
    .eq('data_user_id', userData.user.id)
    .maybeSingle();
  if (acctErr || !account) {
    return err('Account not found', { requestId, status: 404, code: ApiErrorCode.NotFound });
  }

  // Global human-2FA switch (migration 0310, admin-toggleable). When OFF,
  // every password sign-in is "trusted" — the sign-in page's existing
  // trusted→straight-in path fires and the OTP step never appears. The
  // JWT-validated account lookup above still ran, so this stays scoped to
  // real authenticated callers. Fail-safe: isTwoFactorEnabled() returns
  // true on any error, so this only fires when the flag is provably off.
  if (!(await isTwoFactorEnabled())) {
    return ok({ trusted: true }, { requestId });
  }

  // Role-demo bypass: shared investor accounts (test / testhk / testfd)
  // skip OTP. F-01 Phase 2 in the security plan — THREE gates layered now
  // (third added in the 2026-05-22 audit):
  //
  //   1. env.SKIP_2FA_ENABLED must be literal 'true'.
  //
  //   2. account.data_user_id must appear in env.SKIP_2FA_USER_IDS
  //      (comma-separated).
  //
  //   3. account.role MUST NOT be 'admin', AND property_access MUST NOT
  //      include '*'. The demo accounts are general_manager + scoped to a
  //      single property. If config drift ever flips skip_2fa=true on an
  //      admin row AND that admin's UUID lands in the env allowlist, the
  //      bypass is REFUSED at this layer regardless. A DB CHECK constraint
  //      (migration 0157) backstops this at the storage layer too.
  //
  // Any check failing falls through to the normal cookie-based trust path
  // — a legitimate admin signing in from a trusted device still works.
  // Only the *bypass-via-DB-flag* path is gated; logSecurityEvent for the
  // refusal so on-call sees the alert in Sentry the same hour it happens.
  if (account.skip_2fa) {
    const envOn = env.SKIP_2FA_ENABLED === 'true';
    const allowlist = (env.SKIP_2FA_USER_IDS ?? '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
    const onAllowlist = allowlist.includes(userData.user.id);
    const role = (account.role as string) ?? '';
    const access = (account.property_access ?? []) as string[];
    const hadWildcardAccess = access.includes('*');
    const isPrivileged = role === 'admin' || hadWildcardAccess;

    // Privileged refusal runs BEFORE the env-gate / allowlist checks.
    // Reason: even if someone (mis)configures the env allowlist to include
    // an admin's UUID, we still want this to fail loudly. The other two
    // checks would have failed silently in that scenario; this one names
    // the smoking gun.
    if (isPrivileged) {
      await logSecurityEvent({
        action: 'auth.skip_2fa_refused_privileged',
        userId: userData.user.id,
        requestId,
        metadata: {
          accountId: account.id,
          role,
          hadWildcardAccess,
        },
      });
      // Fall through to normal cookie-trust path below.
    } else if (envOn && onAllowlist) {
      await logSecurityEvent({
        action: 'auth.skip_2fa_used',
        userId: userData.user.id,
        requestId,
        metadata: { accountId: account.id },
      });
      return ok({ trusted: true }, { requestId });
    } else if (!envOn) {
      await logSecurityEvent({
        action: 'auth.skip_2fa_blocked_by_env',
        userId: userData.user.id,
        requestId,
        metadata: { accountId: account.id, envGate: env.SKIP_2FA_ENABLED ?? null },
      });
    } else {
      await logSecurityEvent({
        action: 'auth.skip_2fa_account_not_allowlisted',
        userId: userData.user.id,
        requestId,
        metadata: { accountId: account.id, allowlistSize: allowlist.length },
      });
    }
  }

  // Check the cookie.
  const cookieValue = readDeviceCookie(req);
  if (!cookieValue) {
    return ok({ trusted: false }, { requestId });
  }

  const tokenHash = hashDeviceToken(cookieValue);
  const { data: row, error: rowErr } = await supabaseAdmin
    .from('trusted_devices')
    .select('id, expires_at, absolute_expires_at')
    .eq('account_id', account.id)
    .eq('token_hash', tokenHash)
    .maybeSingle();
  if (rowErr) {
    // Fail-closed on DB errors (correct security posture) but escalate
    // visibility from console.error → log.error so Sentry sees the spike.
    // Without this, a sustained DB hiccup quietly forces OTP on every
    // sign-in fleet-wide with zero monitoring signal. Audit Flow 1 #10.
    log.error('[check-trust] lookup failed — failing closed', {
      requestId, accountId: account.id, err: rowErr.message,
      route: 'auth/check-trust',
    });
    return ok({ trusted: false }, { requestId });
  }
  if (!row) return ok({ trusted: false }, { requestId });

  // Rolling-window check: the expires_at field rolls forward on each
  // successful trust check (see the re-issue block below). If it's
  // somehow already past, treat as untrusted.
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    return ok({ trusted: false }, { requestId });
  }

  // F-03 absolute upper bound. Unlike expires_at, this field is set ONCE
  // at insert time (default: created_at + 365 days, see migration 0153)
  // and is never updated. Even an actively-used device gets re-prompted
  // for OTP once a year, capping the worst-case exposure of a leaked
  // cookie that the user never explicitly signs out of. The column is
  // NOT NULL post-0153, so the row?.absolute_expires_at check would only
  // be false on a database that's missing the migration — log + fail-
  // closed in that case.
  const absExpRaw = (row as { absolute_expires_at?: string | null }).absolute_expires_at;
  if (!absExpRaw) {
    log.error('[check-trust] absolute_expires_at missing — migration 0153 not applied?', {
      requestId, accountId: account.id, deviceId: row.id,
    });
    return ok({ trusted: false }, { requestId });
  }
  if (new Date(absExpRaw).getTime() <= Date.now()) {
    // Absolute cap reached. The user has to OTP at least once a year on
    // each device. We don't delete the row here — let it linger so the
    // next sign-in's trust-device flow either dedupes by fingerprint or
    // inserts a fresh row with a new 365-day window.
    return ok({ trusted: false }, { requestId });
  }

  // Trust granted — bump last_seen_at as a side effect. Audit Flow 1 #2:
  // the previous code didn't inspect the update result, so a DB failure
  // here silently froze the rolling-window logic. Cookie maxAge would
  // still tick down on its own and the user would get prompted for OTP
  // earlier than expected with no visible signal. Now we await + warn.
  const { error: bumpErr } = await supabaseAdmin
    .from('trusted_devices')
    .update({ last_seen_at: new Date().toISOString() })
    .eq('id', row.id);
  if (bumpErr) {
    log.warn('[check-trust] last_seen_at bump failed (non-fatal)', {
      requestId, accountId: account.id, deviceId: row.id, err: bumpErr.message,
    });
  }

  // Re-issue the cookie with a fresh maxAge so the trust window rolls
  // forward on every active sign-in. Browser caps cookies at 400 days
  // (Chrome), so without this an active user would still get prompted
  // for OTP exactly once every ~400 days. With this, as long as they
  // sign in at least once a year they'll never see the OTP step again
  // on this device.
  const response = NextResponse.json(
    { ok: true, requestId, data: { trusted: true } },
    { status: 200 },
  );
  const opts = trustCookieOptions(req.headers.get('x-forwarded-host') ?? req.headers.get('host'));
  response.cookies.set({
    name: opts.name,
    value: cookieValue,
    httpOnly: opts.httpOnly,
    secure: opts.secure,
    sameSite: opts.sameSite,
    path: opts.path,
    maxAge: opts.maxAge,
    ...(opts.domain ? { domain: opts.domain } : {}),
  });
  return response;
}
