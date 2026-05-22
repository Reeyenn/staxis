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
import { log, getOrMintRequestId } from '@/lib/log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Decode the `iat` (issued-at) claim from a Supabase JWT without verifying
 * the signature. Used only for session-age comparison after the token has
 * already been verified via supabaseAdmin.auth.getUser — no security
 * boundary here.
 */
function decodeJwtIat(token: string): number | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = Buffer.from(b64, 'base64').toString('utf8');
    const obj = JSON.parse(json) as { iat?: unknown };
    return typeof obj.iat === 'number' ? obj.iat : null;
  } catch {
    return null;
  }
}

/**
 * Decode the `session_id` claim from a Supabase JWT. Phase 2B (audit
 * 2026-05-22): trust-device binds the issued staxis_device cookie to
 * the specific auth.sessions row by writing a mfa_verified_sessions
 * row keyed on this session_id. The custom_access_token_hook checks
 * for that row to compute mfa_verified=true. An attacker creating a
 * fresh signInWithPassword session would have a different session_id
 * with no matching row → the hook computes mfa_verified=false → RLS
 * denies via mfa_verified_or_grace().
 *
 * Same caveat as decodeJwtIat: no signature verification here. Caller
 * must have already validated the token via supabaseAdmin.auth.getUser.
 */
function decodeJwtSessionId(token: string): string | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = Buffer.from(b64, 'base64').toString('utf8');
    const obj = JSON.parse(json) as { session_id?: unknown };
    return typeof obj.session_id === 'string' && obj.session_id.length > 0
      ? obj.session_id
      : null;
  } catch {
    return null;
  }
}

export async function POST(req: NextRequest) {
  const requestId = getOrMintRequestId(req);

  const auth = req.headers.get('authorization');
  const token = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return err('Unauthorized', { requestId, status: 401, code: ApiErrorCode.Unauthorized });

  const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token);
  if (userErr || !userData.user) {
    return err('Unauthorized', { requestId, status: 401, code: ApiErrorCode.Unauthorized });
  }

  // Session-age guard. Audit Flow 1 #5: the /signin/verify postSignup=1
  // path auto-trusts the device without showing the "Trust this device"
  // checkbox. That's correct UX (user just proved email ownership), but
  // it means anyone who can replay a captured OTP-session JWT — even
  // hours later — could mint a trust cookie. Bind trust-device to a
  // session minted in the last 5 minutes. Real OTP flows are seconds
  // long; legitimate users never hit this. Replay windows do.
  const iatClaim = decodeJwtIat(token);
  const MAX_SESSION_AGE_SEC = 5 * 60;
  if (iatClaim !== null) {
    const ageSec = Math.floor(Date.now() / 1000) - iatClaim;
    if (ageSec > MAX_SESSION_AGE_SEC) {
      log.warn('[trust-device] stale session — refusing trust', {
        requestId, userId: userData.user.id, ageSec,
      });
      return err(
        'Session too old to establish device trust. Please sign in again.',
        { requestId, status: 401, code: ApiErrorCode.Unauthorized },
      );
    }
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

  // Dedup-by-fingerprint within the last 7 days. The original code only
  // INSERTed, so every "Trust this device" tap accumulated a new row
  // (cleared cookies, incognito, browser reset, OS reinstall — all the
  // common reasons a user re-trusts the "same" device). Audit Flow 1 #1
  // flagged the unbounded growth: a single account using 3-4 browsers
  // over a year could rack up 50+ rows. The check-trust path scans them
  // all on every sign-in, so the lookup degrades silently as rows
  // accumulate. Deleting matching-fingerprint rows from the last week
  // before insert keeps the table small without losing legitimate
  // multi-device entries (a phone vs laptop have different UA + IP).
  if (ua || ip) {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const dedup = supabaseAdmin
      .from('trusted_devices')
      .delete()
      .eq('account_id', account.id)
      .gte('created_at', sevenDaysAgo);
    if (ua) dedup.eq('user_agent', ua);
    if (ip) dedup.eq('ip', ip);
    const { error: dedupErr } = await dedup;
    if (dedupErr) {
      // Non-fatal — the insert below will still succeed; we just accept
      // the row growth for this account. Surface to Sentry via log.warn.
      log.warn('[trust-device] dedup delete failed (non-fatal)', {
        requestId, accountId: account.id, err: dedupErr.message,
      });
    }
  }

  const { error: insErr } = await supabaseAdmin.from('trusted_devices').insert({
    account_id: account.id,
    token_hash: tokenHash,
    user_agent: ua,
    ip,
    expires_at: expiresAt,
  });
  if (insErr) {
    log.error('[trust-device] insert failed', { requestId, accountId: account.id, err: insErr.message });
    return err('Failed to register trusted device', {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }

  // Phase 2B (audit 2026-05-22): bind THIS session to the trust we just
  // established. The custom_access_token_hook reads session_id from the
  // JWT event payload and checks mfa_verified_sessions to compute
  // mfa_verified=true. An attacker calling supabase.auth.signInWithPassword
  // directly with a stolen password would get a NEW session_id with no
  // matching row → hook computes mfa_verified=false → RLS denies via
  // public.mfa_verified_or_grace(). Closes Door B (PostgREST/Realtime
  // bypass) for users with existing trust — the original user-bound design
  // was theater because a user with any trusted device anywhere had every
  // JWT flagged.
  //
  // Idempotent on conflict (a repeat trust-device call for the same session
  // should not 500). Non-fatal on other errors — the trusted_devices row
  // is in place; worst case the user hits RLS denials and re-runs OTP.
  const sessionId = decodeJwtSessionId(token);
  if (sessionId) {
    const { error: mfaErr } = await supabaseAdmin
      .from('mfa_verified_sessions')
      .insert({
        session_id: sessionId,
        user_id: userData.user.id,
        verified_from_ip: ip,
        verified_from_ua: ua,
      });
    if (mfaErr && mfaErr.code !== '23505') {
      log.warn('[trust-device] mfa_verified_sessions insert failed (non-fatal)', {
        requestId, sessionId, userId: userData.user.id, err: mfaErr.message,
      });
    }
  } else {
    // JWT has no session_id claim — shouldn't happen with current Supabase
    // versions (added 2024-ish). Log so we notice if Supabase ever changes
    // the claim shape and the hook stops binding correctly.
    log.warn('[trust-device] JWT missing session_id claim — mfa_verified_sessions skipped', {
      requestId, userId: userData.user.id,
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
