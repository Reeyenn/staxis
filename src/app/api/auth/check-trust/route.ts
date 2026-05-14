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
import { getOrMintRequestId } from '@/lib/log';

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

  // Demo bypass: shared investor account skips OTP unconditionally.
  // No device cookie is set/refreshed — bypass lives entirely in the DB flag.
  if (account.skip_2fa) {
    return ok({ trusted: true }, { requestId });
  }

  // Check the cookie.
  const cookieValue = readDeviceCookie(req);
  if (!cookieValue) {
    return ok({ trusted: false }, { requestId });
  }

  const tokenHash = hashDeviceToken(cookieValue);
  const { data: row, error: rowErr } = await supabaseAdmin
    .from('trusted_devices')
    .select('id, expires_at')
    .eq('account_id', account.id)
    .eq('token_hash', tokenHash)
    .maybeSingle();
  if (rowErr) {
    console.error('[check-trust] lookup failed', rowErr);
    // Fail-closed: treat as untrusted on DB errors.
    return ok({ trusted: false }, { requestId });
  }
  if (!row) return ok({ trusted: false }, { requestId });

  if (new Date(row.expires_at).getTime() <= Date.now()) {
    return ok({ trusted: false }, { requestId });
  }

  // Trust granted — bump last_seen_at as a side effect.
  await supabaseAdmin
    .from('trusted_devices')
    .update({ last_seen_at: new Date().toISOString() })
    .eq('id', row.id);

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
