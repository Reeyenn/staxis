// POST /api/auth/revoke-trust
//
// F-02 in the core-web/auth/RLS security plan. Sign-out and password-reset
// flows previously only cleared the Supabase session (auth.signOut), never
// touched the trusted_devices table, and never cleared the staxis_device
// cookie. That made password rotation a no-op against a stolen cookie:
// the attacker could still skip OTP on next sign-in because the DB row
// (10-year expires_at) plus the cookie (400-day maxAge, rolling) survived.
//
// This route:
//   1. Authenticates via bearer JWT (same pattern as check-trust / trust-device)
//   2. DELETEs every trusted_devices row for the caller's account
//   3. Clears the staxis_device cookie with Max-Age=0
//   4. Writes an `auth.trust_revoked` SecurityEvent (visible-on-failure
//      via logSecurityEvent, not best-effort writeAudit)
//
// Callers in this PR:
//   - AuthContext.signOut() — fired before supabase.auth.signOut(), with
//     a 2s AbortController timeout so a hung network doesn't block sign-out
//   - /signin/reset/page.tsx — fired right after password update, before
//     the existing supabase.auth.signOut() bounce-to-signin
//
// Best-effort: a non-2xx response from this route does NOT block the
// downstream auth.signOut(). The cost of a stuck trust-revoke is the
// device remains trusted until its own expires_at; the cost of a stuck
// sign-out is the user can't get out of the app. Sign-out wins.

import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { TRUST_COOKIE_NAME, trustCookieOptions } from '@/lib/trusted-device';
import { err, ApiErrorCode } from '@/lib/api-response';
import { log, getOrMintRequestId } from '@/lib/log';
import { logSecurityEvent } from '@/lib/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Body {
  /** Tag the audit event so on-call can see whether the user explicitly
   *  signed out vs. completed a password reset vs. some future "revoke
   *  all my devices" admin flow. */
  source?: 'signout' | 'password_reset' | 'manual';
}

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
    .select('id')
    .eq('data_user_id', userData.user.id)
    .maybeSingle();
  if (acctErr || !account) {
    return err('Account not found', { requestId, status: 404, code: ApiErrorCode.NotFound });
  }

  let body: Body = {};
  try {
    body = (await req.json()) as Body;
  } catch {
    // Empty body is fine — source defaults to 'signout' in the audit event.
  }
  const source: Body['source'] = body.source ?? 'signout';

  // DELETE all trusted_devices rows for this account. We could scope to the
  // current cookie's token_hash for a "revoke this device only" semantic,
  // but the user-visible action ("Sign out") is unambiguous: kill every
  // trust this account has anywhere. Different browsers / different
  // sessions of the same account are intentional re-trusts the next time
  // someone signs in on them.
  const { error: delErr, count: deletedCount } = await supabaseAdmin
    .from('trusted_devices')
    .delete({ count: 'exact' })
    .eq('account_id', account.id);
  if (delErr) {
    log.error('[revoke-trust] delete failed', {
      requestId, accountId: account.id, err: delErr.message,
    });
    // Don't block sign-out on this — the caller will continue regardless.
    // 500 here is informational, not blocking.
    return err('Failed to revoke trusted devices', {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }

  // Phase 2B (audit 2026-05-22): also revoke session-bound mfa_verified
  // for ALL of this user's sessions, not just the current one. Sign-out
  // is an unambiguous "kill every trust" action — matches the existing
  // trusted_devices semantics above. After this delete, the next JWT
  // refresh (or fresh sign-in) computes mfa_verified=false via the auth
  // hook → PostgREST + Realtime reject the user until they re-establish
  // trust through OTP + /api/auth/trust-device.
  //
  // Non-fatal: if this fails the trusted_devices delete already happened
  // (primary action), so the website-layer gate (Phase 1) is still
  // closed. Only the database-layer gate (Phase 2B) is briefly stale
  // until the FK CASCADE on auth.sessions or the janitor cron catches it.
  const { error: mfaDelErr, count: mfaDeletedCount } = await supabaseAdmin
    .from('mfa_verified_sessions')
    .delete({ count: 'exact' })
    .eq('user_id', userData.user.id);
  if (mfaDelErr) {
    log.error('[revoke-trust] mfa_verified_sessions delete failed (non-fatal)', {
      requestId, userId: userData.user.id, err: mfaDelErr.message,
    });
  }

  // Visible-on-failure security event. Distinct from writeAudit because
  // an audit gap on a revoke means we can't tell after-the-fact whether
  // a "trust still active" was the user not signing out yet or an audit
  // failure.
  await logSecurityEvent({
    action: 'auth.trust_revoked',
    userId: userData.user.id,
    requestId,
    metadata: {
      accountId: account.id,
      source,
      deletedCount: deletedCount ?? 0,
      mfaSessionsDeletedCount: mfaDeletedCount ?? 0,
    },
  });

  // Clear the cookie. We mirror trustCookieOptions's domain/path/secure
  // attributes so the browser actually evicts the original (cookies are
  // keyed on name + domain + path). Max-Age=0 tells the browser to discard
  // immediately.
  const response = NextResponse.json(
    { ok: true, requestId, data: { revoked: deletedCount ?? 0 } },
    { status: 200 },
  );
  const opts = trustCookieOptions(req.headers.get('x-forwarded-host') ?? req.headers.get('host'));
  response.cookies.set({
    name: TRUST_COOKIE_NAME,
    value: '',
    httpOnly: opts.httpOnly,
    secure: opts.secure,
    sameSite: opts.sameSite,
    path: opts.path,
    maxAge: 0,
    ...(opts.domain ? { domain: opts.domain } : {}),
  });
  return response;
}
