// POST /api/auth/trust-device
//
// Called from /signin/verify after the user successfully verifies their OTP
// AND checks "Trust this device for 30 days". Issues an httpOnly cookie and
// writes a corresponding sha256(token) → trusted_devices row.
//
// The caller's account is determined from the bearer JWT (which exists
// because verifyOtp issued a fresh session). No body params are needed for
// account identification.
//
// Cookie + DB row both expire after TRUST_DURATION_DAYS. The check-trust
// endpoint enforces the expiry; cookie maxAge just hints to the browser.

import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import {
  generateDeviceToken,
  hashDeviceToken,
  trustCookieOptions,
  TRUST_DURATION_DB_MS,
} from '@/lib/trusted-device';
import { err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId } from '@/lib/log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const requestId = getOrMintRequestId(req);

  const auth = req.headers.get('authorization');
  const token = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return err('Unauthorized', { requestId, status: 401, code: ApiErrorCode.Unauthorized });

  const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token);
  if (userErr || !userData.user) {
    return err('Unauthorized', { requestId, status: 401, code: ApiErrorCode.Unauthorized });
  }

  const { data: account, error: acctErr } = await supabaseAdmin
    .from('accounts')
    .select('id')
    .eq('data_user_id', userData.user.id)
    .maybeSingle();
  if (acctErr || !account) {
    return err('Account not found', { requestId, status: 404, code: ApiErrorCode.NotFound });
  }

  const newToken = generateDeviceToken();
  const tokenHash = hashDeviceToken(newToken);
  const expiresAt = new Date(Date.now() + TRUST_DURATION_DB_MS).toISOString();
  const ua = req.headers.get('user-agent') ?? null;
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    ?? req.headers.get('x-real-ip')
    ?? null;

  const { error: insErr } = await supabaseAdmin.from('trusted_devices').insert({
    account_id: account.id,
    token_hash: tokenHash,
    user_agent: ua,
    ip,
    expires_at: expiresAt,
  });
  if (insErr) {
    console.error('[trust-device] insert failed', insErr);
    return err('Failed to register trusted device', {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }

  const response = NextResponse.json(
    { ok: true, requestId, data: { success: true } },
    { status: 200 },
  );
  const opts = trustCookieOptions();
  response.cookies.set({
    name: opts.name,
    value: newToken,
    httpOnly: opts.httpOnly,
    secure: opts.secure,
    sameSite: opts.sameSite,
    path: opts.path,
    maxAge: opts.maxAge,
  });
  return response;
}
