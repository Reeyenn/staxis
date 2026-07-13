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

interface TrustJwtPayload {
  sub?: unknown;
  iat?: unknown;
  session_id?: unknown;
  amr?: unknown;
}

/**
 * Decode claims from a Supabase JWT after `supabaseAdmin.auth.getUser(token)`
 * has verified it. This decoder never establishes authenticity on its own.
 */
function decodeTrustJwtPayload(token: string): TrustJwtPayload | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = Buffer.from(b64, 'base64').toString('utf8');
    const obj = JSON.parse(json) as unknown;
    return obj && typeof obj === 'object' ? obj as TrustJwtPayload : null;
  } catch {
    return null;
  }
}

/**
 * Verify that an already-authenticated Supabase JWT represents the fresh OTP
 * session required by this endpoint. A valid password JWT is deliberately not
 * enough: trust-device is the bridge that mints both durable device trust and
 * the session-bound MFA claim.
 *
 * Supabase documents `iat`, `session_id`, and object-form `amr` claims on its
 * signed access tokens. The SDK also supports RFC-8176 string AMR entries, so a
 * signed `"otp"` string is accepted using the fresh JWT iat as its timestamp.
 */
export function validateFreshOtpSessionClaims(
  token: string,
  expectedUserId: string,
  nowSec = Math.floor(Date.now() / 1000),
): { ok: true; sessionId: string } | { ok: false; reason: string } {
  const payload = decodeTrustJwtPayload(token);
  if (!payload) return { ok: false, reason: 'malformed_jwt_payload' };
  if (payload.sub !== expectedUserId) return { ok: false, reason: 'subject_mismatch' };

  const MAX_AGE_SEC = 5 * 60;
  const MAX_FUTURE_SKEW_SEC = 30;
  if (typeof payload.iat !== 'number' || !Number.isFinite(payload.iat)) {
    return { ok: false, reason: 'missing_iat' };
  }
  const sessionAgeSec = nowSec - payload.iat;
  if (sessionAgeSec > MAX_AGE_SEC) return { ok: false, reason: 'stale_session' };
  if (sessionAgeSec < -MAX_FUTURE_SKEW_SEC) return { ok: false, reason: 'future_session' };

  if (typeof payload.session_id !== 'string' || payload.session_id.length === 0) {
    return { ok: false, reason: 'missing_session_id' };
  }
  if (!Array.isArray(payload.amr)) return { ok: false, reason: 'missing_amr' };

  let sawOtp = false;
  for (const entry of payload.amr) {
    if (entry === 'otp') {
      sawOtp = true;
      break;
    }
    if (!entry || typeof entry !== 'object') continue;
    const method = (entry as { method?: unknown }).method;
    if (method !== 'otp') continue;
    sawOtp = true;
    const timestamp = (entry as { timestamp?: unknown }).timestamp;
    if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) {
      return { ok: false, reason: 'invalid_otp_timestamp' };
    }
    const otpAgeSec = nowSec - timestamp;
    if (otpAgeSec > MAX_AGE_SEC) return { ok: false, reason: 'stale_otp' };
    if (otpAgeSec < -MAX_FUTURE_SKEW_SEC) return { ok: false, reason: 'future_otp' };
    break;
  }

  if (!sawOtp) return { ok: false, reason: 'otp_method_missing' };
  return { ok: true, sessionId: payload.session_id };
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

  // Critical 2FA boundary: require BOTH a password proof (claimed below) and a
  // freshly OTP-authenticated, session-bound JWT. The old user-scoped password
  // proof alone let a fresh signInWithPassword JWT call this route directly and
  // mint its own mfa_verified_sessions row, bypassing the emailed code entirely.
  const otpSession = validateFreshOtpSessionClaims(token, userData.user.id);
  if (!otpSession.ok) {
    log.warn('[trust-device] non-OTP or stale session — refusing trust', {
      requestId, userId: userData.user.id, reason: otpSession.reason,
    });
    await logSecurityEvent({
      action: 'auth.trust_device_blocked_without_fresh_otp',
      userId: userData.user.id,
      requestId,
      metadata: { reason: otpSession.reason },
    });
    return err(
      'A fresh one-time-code verification is required before this device can be trusted.',
      { requestId, status: 403, code: ApiErrorCode.Unauthorized },
    );
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
  let newTokenHash: string | null = null;

  if (remember) {
    newToken = generateDeviceToken();
    const tokenHash = hashDeviceToken(newToken);
    newTokenHash = tokenHash;
    const expiresAt = new Date(Date.now() + TRUST_DURATION_DB_MS).toISOString();

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

  // Phase 2B (audit 2026-05-22): bind THIS OTP-authenticated session to the
  // verification we just performed. The custom_access_token_hook reads
  // session_id from the JWT event payload and checks mfa_verified_sessions to
  // compute mfa_verified=true. The fresh-OTP AMR gate above prevents a password
  // session from writing this row for itself.
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
  const sessionId = otpSession.sessionId;
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
  if (!mfaVerified) mfaVerified = await insertMfaSession();

  // Every successful response must have the per-session verification row.
  // The durable cookie cannot satisfy database RLS by itself; returning 200
  // without this row sends the user into a blank app after token refresh. Roll
  // back any durable trust row, release the proof, and fail closed.
  if (!mfaVerified) {
    if (newTokenHash) {
      const { error: rollbackErr } = await supabaseAdmin
        .from('trusted_devices')
        .delete()
        .eq('account_id', account.id)
        .eq('token_hash', newTokenHash);
      if (rollbackErr) {
        log.error('[trust-device] trusted-device rollback failed after MFA-session failure', {
          requestId, accountId: account.id, err: rollbackErr.message,
        });
      }
    }
    try {
      await supabaseAdmin.rpc('staxis_release_password_signin_proof', { p_id: claimedProofId });
    } catch {
      // Best-effort.
    }
    return err('Could not finish securing your session. Please sign in again.', {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }

  // Deduplicate matching recent device fingerprints only AFTER the new
  // session's MFA row is durable. Doing this before MFA persistence could
  // revoke an already-working cookie and then fail the replacement. Exclude
  // the new token itself so it remains the canonical row on success.
  if (remember && newTokenHash && (ua || ip)) {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const dedup = supabaseAdmin
      .from('trusted_devices')
      .delete()
      .eq('account_id', account.id)
      .neq('token_hash', newTokenHash)
      .gte('created_at', sevenDaysAgo);
    if (ua) dedup.eq('user_agent', ua);
    if (ip) dedup.eq('ip', ip);
    const { error: dedupErr } = await dedup;
    if (dedupErr) {
      // Non-fatal — trust is established; this only permits temporary row
      // growth until a later successful trust operation deduplicates it.
      log.warn('[trust-device] dedup delete failed (non-fatal)', {
        requestId, accountId: account.id, err: dedupErr.message,
      });
    }
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
  }
  return response;
}
