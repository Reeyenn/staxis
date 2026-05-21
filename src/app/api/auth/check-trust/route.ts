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
    .select('id, skip_2fa')
    .eq('data_user_id', userData.user.id)
    .maybeSingle();
  if (acctErr || !account) {
    return err('Account not found', { requestId, status: 404, code: ApiErrorCode.NotFound });
  }

  // Role-demo bypass: shared investor accounts (test / testhk / testfd)
  // skip OTP. F-01 Phase 2 in the security plan — two gates layered:
  //
  //   1. env.SKIP_2FA_ENABLED must be literal 'true' (Phase 1's grace-
  //      period default-honored is over). A future SQL typo flipping
  //      skip_2fa=true on a real customer doesn't matter if the env
  //      gate isn't on.
  //
  //   2. account.data_user_id must appear in env.SKIP_2FA_USER_IDS
  //      (comma-separated). Even with the env gate on, a non-allowlisted
  //      account with skip_2fa=true is refused — and the attempt is
  //      logged via logSecurityEvent so on-call sees the alert in Sentry
  //      the same hour it happens.
  //
  // Either check failing falls through to the normal cookie-based trust
  // path — a legitimate user with a real trusted-device cookie still
  // gets the trust granted; only the *bypass-via-DB-flag* path is
  // gated.
  if (account.skip_2fa) {
    const envOn = env.SKIP_2FA_ENABLED === 'true';
    const allowlist = (env.SKIP_2FA_USER_IDS ?? '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
    const onAllowlist = allowlist.includes(userData.user.id);

    if (envOn && onAllowlist) {
      await logSecurityEvent({
        action: 'auth.skip_2fa_used',
        userId: userData.user.id,
        requestId,
        metadata: { accountId: account.id },
      });
      return ok({ trusted: true }, { requestId });
    }

    // Bypass blocked. Two distinct reasons → two distinct events so
    // the Sentry filter can alert specifically on "skip_2fa=true on an
    // account NOT in the allowlist" — that's the smoking-gun signal
    // for the failure mode this gate exists to catch.
    if (!envOn) {
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
  const opts = trustCookieOptions();
  response.cookies.set({
    name: opts.name,
    value: cookieValue,
    httpOnly: opts.httpOnly,
    secure: opts.secure,
    sameSite: opts.sameSite,
    path: opts.path,
    maxAge: opts.maxAge,
  });
  return response;
}
