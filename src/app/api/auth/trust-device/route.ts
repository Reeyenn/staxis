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
import { logSecurityEvent } from '@/lib/audit';
import { trustedClientIp } from '@/lib/api-ratelimit';

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

  // `remember` gates ONLY the durable "remember this device" artifacts (the
  // trusted_devices row + the long-lived staxis_device cookie). It defaults to
  // TRUE so existing callers that send no body keep today's behavior (the
  // onboarding OTP step posts with no body; an empty/absent body makes
  // req.json() throw → caught → remember=true). When the /signin/verify user
  // UNCHECKS "Trust this device", the page posts { remember: false }: we still
  // mint the per-session verification (mfa_verified_sessions row) below so the
  // app actually loads, but we skip the durable cookie. Audit 2026-06-26 P1.
  let remember = true;
  try {
    const body = (await req.json()) as { remember?: unknown } | null;
    if (body && typeof body.remember === 'boolean') remember = body.remember;
  } catch {
    // No body / invalid JSON → keep the default (remember = true).
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

  // Phase A (Hole #1 fix, audit 2026-05-22): require an atomically-claimed
  // password_signin_proofs row. Written by custom_access_token_hook when
  // Supabase tags the JWT issuance with authentication_method='password'.
  // Attackers calling supabase.auth.signInWithOtp directly cannot fake the
  // method — the hook tags 'otp' and no proof gets written. So they have
  // a valid Supabase JWT but no proof → 403 here → can't mint trust.
  //
  // The claim is via an RPC (migration 0164) instead of SELECT+UPDATE to
  // close a race where two concurrent OTP verifications could both
  // consume the same proof and mint two trusted devices. FOR UPDATE
  // SKIP LOCKED inside the RPC ensures exactly one caller wins the row.
  const { data: claimedProofId, error: proofClaimErr } = await supabaseAdmin.rpc(
    'staxis_claim_password_signin_proof',
    { p_user_id: userData.user.id },
  );
  if (proofClaimErr) {
    log.error('[trust-device] password proof RPC failed — failing closed', {
      requestId, userId: userData.user.id, err: proofClaimErr.message,
    });
    return err('Trust-device temporarily unavailable, please retry', {
      requestId, status: 503, code: ApiErrorCode.InternalError,
    });
  }
  if (!claimedProofId) {
    await logSecurityEvent({
      action: 'auth.trust_device_blocked_no_password_proof',
      userId: userData.user.id,
      requestId,
      metadata: { reason: 'password_signin_proof_missing_or_expired_or_used' },
    });
    return err(
      'Password sign-in required before this device can be trusted. Please sign in again with your password.',
      { requestId, status: 403, code: ApiErrorCode.Unauthorized },
    );
  }

  const { data: account, error: acctErr } = await supabaseAdmin
    .from('accounts')
    .select('id')
    .eq('data_user_id', userData.user.id)
    .maybeSingle();
  if (acctErr || !account) {
    // Release the claimed proof so the user can retry without losing it.
    try {
      await supabaseAdmin.rpc('staxis_release_password_signin_proof', { p_id: claimedProofId });
    } catch {
      // Best-effort — the user will need to re-sign-in with their password
      // if the release also fails. Logged via Sentry from the route caller.
    }
    return err('Account not found', { requestId, status: 404, code: ApiErrorCode.NotFound });
  }

  // ua/ip are diagnostic fields on the mfa_verified_sessions row too, so we
  // compute them regardless of `remember`. The durable trusted_devices token
  // is only minted when the user opted to remember this device.
  const ua = req.headers.get('user-agent') ?? null;
  // Use the platform-trusted client IP, not the spoofable leftmost XFF token,
  // so the value stored on the trust/audit row can't be poisoned for
  // forensics (security audit 2026-06-26).
  const ip = trustedClientIp(req) || null;

  let newToken: string | null = null;

  if (remember) {
    newToken = generateDeviceToken();
    const tokenHash = hashDeviceToken(newToken);
    const expiresAt = new Date(Date.now() + TRUST_DURATION_DB_MS).toISOString();

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
      // Release the claimed proof so the user can retry without re-doing
      // their password sign-in. Otherwise a transient DB error burns the
      // proof and forces them all the way back to /signin.
      try {
        await supabaseAdmin.rpc('staxis_release_password_signin_proof', { p_id: claimedProofId });
      } catch {
        // Best-effort.
      }
      return err('Failed to register trusted device', {
        requestId, status: 500, code: ApiErrorCode.InternalError,
      });
    }
  }

  // Phase 2B (audit 2026-05-22): bind THIS session to the verification we just
  // performed. The custom_access_token_hook reads session_id from the JWT event
  // payload and checks mfa_verified_sessions to compute mfa_verified=true. An
  // attacker calling supabase.auth.signInWithPassword directly with a stolen
  // password would get a NEW session_id with no matching row → hook computes
  // mfa_verified=false → RLS denies via public.mfa_verified_or_grace().
  //
  // This ALWAYS runs now (both remember values) — it's the per-session
  // verification that makes the app actually load after OTP (it mints the
  // mfa_verified claim Door A / RLS and Door B / validateDeviceTrust both
  // gate on). When the user UNCHECKED "Trust this device" there is NO durable
  // cookie, so this row is the ONLY thing opening both doors: we retry once on
  // a transient blip and treat a persistent failure as fatal rather than
  // dropping the user into a blank app (audit 2026-06-26 empty-app P1).
  //
  // Note: the password proof was already marked consumed inside the
  // staxis_claim_password_signin_proof RPC at the top of this handler
  // (atomic UPDATE returning the claimed id), so no separate mark-used
  // step is needed here.
  let mfaVerified = false;
  const sessionId = decodeJwtSessionId(token);
  if (sessionId) {
    const insertMfaSession = async (): Promise<boolean> => {
      const { error: mfaErr } = await supabaseAdmin
        .from('mfa_verified_sessions')
        .insert({
          session_id: sessionId,
          user_id: userData.user.id,
          verified_from_ip: ip,
          verified_from_ua: ua,
        });
      // 23505 = duplicate session_id → a repeat call for the same session;
      // idempotent success, not a failure.
      if (!mfaErr || mfaErr.code === '23505') return true;
      log.warn('[trust-device] mfa_verified_sessions insert failed', {
        requestId, sessionId, userId: userData.user.id, remember,
        err: mfaErr.message, code: mfaErr.code ?? null,
      });
      return false;
    };
    mfaVerified = await insertMfaSession();
    // remember=false has no trusted_devices cookie covering Door B, so the
    // row is load-bearing — retry once to ride out a transient blip.
    if (!mfaVerified && !remember) {
      mfaVerified = await insertMfaSession();
    }
  } else {
    // JWT has no session_id claim — shouldn't happen with current Supabase
    // versions (added 2024-ish). Log so we notice if Supabase ever changes
    // the claim shape and the hook stops binding correctly.
    log.warn('[trust-device] JWT missing session_id claim — mfa_verified_sessions skipped', {
      requestId, userId: userData.user.id, remember,
    });
  }

  // remember=false depends entirely on the per-session verification row. If we
  // couldn't write it, fail loudly (release the proof so a fresh sign-in isn't
  // blocked) instead of returning 200 into an empty app. remember=true still
  // has the trusted_devices cookie covering Door B, so a missing row there is
  // non-fatal — the user re-OTPs naturally on the next RLS denial.
  if (!remember && !mfaVerified) {
    try {
      await supabaseAdmin.rpc('staxis_release_password_signin_proof', { p_id: claimedProofId });
    } catch {
      // Best-effort.
    }
    return err('Could not finish securing your session. Please sign in again.', {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }

  const response = NextResponse.json(
    { ok: true, requestId, data: { success: true, remembered: remember } },
    { status: 200 },
  );
  // Durable "remember this device" cookie — set ONLY when the user opted in.
  // remember=false relies purely on the per-session mfa_verified_sessions row
  // above (cleared on sign-out / session end), so the next sign-in correctly
  // re-prompts for OTP.
  if (remember && newToken) {
    const opts = trustCookieOptions(req.headers.get('x-forwarded-host') ?? req.headers.get('host'));
    response.cookies.set({
      name: opts.name,
      value: newToken,
      httpOnly: opts.httpOnly,
      secure: opts.secure,
      sameSite: opts.sameSite,
      path: opts.path,
      maxAge: opts.maxAge,
      ...(opts.domain ? { domain: opts.domain } : {}),
    });
  }
  return response;
}
