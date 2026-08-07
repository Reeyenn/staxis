'use client';


export const dynamic = 'force-dynamic';
// /signin/verify — enter the 6-digit OTP code from email after a password
// sign-in on an unknown device. The sign-in page already called
// supabase.auth.signInWithOtp() to send the code; here we verify it and,
// optionally, mark the device as trusted for the next 30 days.
//
// Flow:
//   1. /signin signs in with password, sees device is untrusted, signs out
//      and calls signInWithOtp({email, shouldCreateUser: false}), then
//      reliably replace('/signin/verify?email=…')
//   2. This page reads `email` from the URL and renders the OTP input.
//   3. User types code, optionally checks "Trust this device".
//   4. supabase.auth.verifyOtp({email, token, type:'email'}) → fresh session.
//   5. If trust-this-device was checked, POST /api/auth/trust-device with
//      the new bearer token; cookie + DB row land.
//   6. reliably replace('/home') for a normal sign-in

import React, { useEffect, useRef, useState, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/contexts/AuthContext';
import { useLang } from '@/contexts/LanguageContext';
import { safeRedirect } from '@/lib/url-redirect';
import AuthShell, { AuthLabel, AuthError, authBackLinkStyle } from '@/components/AuthShell';
import { useNavigationReady, useReliableNavigation } from '@/lib/hooks/use-reliable-navigation';
import {
  AUTH_OPERATION_TIMEOUT_MS,
  AUTH_SESSION_OPERATION_TIMEOUT_MS,
  fetchWithAuth,
} from '@/lib/api-fetch';
import { settleSessionOperation } from '@/lib/auth/session-operation';
import { fetchWithDeadline, withPromiseDeadline } from '@/lib/fetch-deadline';

function VerifyInner() {
  const { lang } = useLang();
  const { isAuthSessionCurrent, discardAuthSession } = useAuth();
  const navigation = useReliableNavigation();
  const replaceNavigation = navigation.replace;
  const params = useSearchParams();
  const email = params.get('email') ?? '';
  // postSignup=1 means the user landed here directly from /signup. They just
  // proved ownership of the email by entering an OTP that was sent to it,
  // so we auto-trust the device and hide the checkbox entirely — Reeyen
  // wants signups to skip the extra "remember this device?" prompt.
  const postSignup = params.get('postSignup') === '1';
  const initialDeliveryFailed = params.get('delivery') === 'failed';
  // OTP completion normally resolves through the property selector. Company
  // Hub and company-invitation targets are property-independent: a new
  // invitee may not have a hotel grant until the invitation itself is
  // accepted, so routing that target through the selector would strand them
  // on the zero-property screen.
  const rawRedirect = params.get('redirect');
  const ordinaryRequestedTarget = safeRedirect(rawRedirect, '/home');
  // The retired company-invitation flow parked its token in sessionStorage and
  // resumed after OTP, which is why this page carried a handoff state machine.
  // That invitation system is gone and /invite/[token] never routes through
  // sign-in, so the requested target is simply the requested target.
  const requestedTarget = ordinaryRequestedTarget;
  const isPropertyIndependentCompanyTarget = requestedTarget === '/company';
  const redirectTarget = isPropertyIndependentCompanyTarget
    ? requestedTarget
    : postSignup || requestedTarget === '/home' || requestedTarget.startsWith('/property-selector')
      ? '/property-selector'
      : `/property-selector?redirect=${encodeURIComponent(requestedTarget)}`;
  const freshSigninHref = rawRedirect
    ? `/signin?reason=auth-retry&redirect=${encodeURIComponent(rawRedirect)}`
    : '/signin?reason=auth-retry';

  const [code, setCode] = useState('');
  const [trust, setTrust] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [requiresFreshSignin, setRequiresFreshSignin] = useState(false);
  const [error, setError] = useState('');
  const [codeDelivered, setCodeDelivered] = useState(!initialDeliveryFailed);
  const [resending, setResending] = useState(false);
  const [resendError, setResendError] = useState(
    initialDeliveryFailed
      ? ("We couldn't send the code. Send a new one to continue.")
      : '',
  );
  const [resendCooldown, setResendCooldown] = useState(0);
  const submitInFlightRef = useRef(false);
  const resendInFlightRef = useRef(false);
  const enterFreshSigninRecovery = (message: string) => {
    setRequiresFreshSignin(true);
    setSubmitting(false);
    setError(message);
    // verifyOtp/refreshSession cannot be cancelled after their outer deadline.
    // Replace the document now so Back or another auth route cannot start a
    // competing session operation in this provider/Supabase singleton.
    try { window.location.replace(freshSigninHref); } catch { /* hard-link fallback remains rendered */ }
  };

  useEffect(() => {
    if (resendCooldown <= 0) return;
    const timer = window.setInterval(() => {
      setResendCooldown((seconds) => Math.max(0, seconds - 1));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [resendCooldown]);

  const resendCode = async () => {
    if (!email || requiresFreshSignin || resendInFlightRef.current || resending || resendCooldown > 0) return;
    resendInFlightRef.current = true;
    setResending(true);
    setResendError('');
    setError('');
    try {
      const { error: otpErr } = await withPromiseDeadline(
        supabase.auth.signInWithOtp({
          email: email.trim().toLowerCase(),
          options: { shouldCreateUser: false },
        }),
        { timeoutMs: AUTH_OPERATION_TIMEOUT_MS, label: 'Send verification code' },
      );
      if (otpErr) throw otpErr;
      setCode('');
      setCodeDelivered(true);
      setResendCooldown(30);
    } catch (err) {
      console.warn('verify: resend code failed', err);
      setResendError("Couldn't send a new code. Try again.");
    } finally {
      resendInFlightRef.current = false;
      setResending(false);
    }
  };

  // No email → user landed here without going through /signin first.
  // Also: if the global human-2FA switch is off, no code email was sent —
  // bounce off this code screen so nobody is stranded waiting for a code
  // that never comes (to the app if a session already exists, else back to
  // /signin, which now goes straight in). Purely defensive: the check is
  // best-effort and ONLY an explicit `enabled === false` bounces; any
  // fetch failure or odd payload leaves the code screen as-is (fail-safe:
  // behave like 2FA is on).
  useEffect(() => {
    if (!email) {
      replaceNavigation('/signin');
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetchWithDeadline(
          '/api/auth/2fa-status',
          { cache: 'no-store' },
          { timeoutMs: AUTH_OPERATION_TIMEOUT_MS, label: '2FA status' },
        );
        const body = await res.json().catch(() => null) as {
          ok?: boolean;
          data?: { enabled?: boolean };
        } | null;
        if (cancelled || !body?.ok || body.data?.enabled !== false) return;
        const { data } = await withPromiseDeadline(
          supabase.auth.getSession(),
          { timeoutMs: AUTH_OPERATION_TIMEOUT_MS, label: 'Session check' },
        );
        if (cancelled) return;
        replaceNavigation(
          data.session
            ? redirectTarget
            : '/signin',
        );
      } catch {
        // Fail-safe: stay on the code screen (2FA-on behavior).
      }
    })();
    return () => { cancelled = true; };
  }, [email, redirectTarget, replaceNavigation]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitInFlightRef.current || requiresFreshSignin || !code.trim()) return;
    submitInFlightRef.current = true;
    setSubmitting(true);
    setError('');

    let verification: Awaited<ReturnType<typeof supabase.auth.verifyOtp>>;
    const verificationOperation = supabase.auth.verifyOtp({
      email: email.trim().toLowerCase(),
      token: code.trim(),
      type: 'email',
    });
    try {
      verification = await settleSessionOperation(verificationOperation, {
        timeoutMs: AUTH_SESSION_OPERATION_TIMEOUT_MS,
        label: 'Verify code',
        discardLateSession: discardAuthSession,
      });
    } catch (err) {
      // The code may have been consumed and the SDK may still settle a session
      // just after our outer deadline. Never re-enable this OTP form. The
      // settlement observer above discards an eventual exact-token session;
      // recovery is a full fresh sign-in.
      enterFreshSigninRecovery("We couldn't confirm the result. Please sign in again.");
      console.warn('verify: code verification failed', err);
      return;
    }

    const { data, error: verifyErr } = verification;

    if (verifyErr || !data.session) {
      submitInFlightRef.current = false;
      setSubmitting(false);
      setError(verifyErr?.message ?? ('Incorrect code.'));
      return;
    }

    let ownedSession = data.session;
    if (!isAuthSessionCurrent(ownedSession)) {
      enterFreshSigninRecovery('Sign-in state changed. Please sign in again.');
      return;
    }

    // ALWAYS secure the session, regardless of the "Trust this device" box.
    // The checkbox only controls the DURABLE remember-this-device cookie
    // (passed as `remember`); the per-session verification (the
    // mfa_verified_sessions row that mints the `mfa_verified` JWT claim) is
    // written either way. Without it the user is "signed in" but every page
    // is blank — no claim → RLS denies all reads, and /api/* routes 401.
    // Audit 2026-06-26 P1 (the unchecked-box → empty-app trap). This mirrors
    // the onboarding OTP path, which always trusts the device.
    try {
      const res = await fetchWithAuth('/api/auth/trust-device', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Authorization: `Bearer ${ownedSession.access_token}`,
        },
        credentials: 'include',
        body: JSON.stringify({ remember: trust }),
        timeoutMs: AUTH_OPERATION_TIMEOUT_MS,
      });
      if (!res.ok) throw new Error(`trust-device responded ${res.status}`);

      // Force a token refresh so the new JWT carries `mfa_verified=true` (the
      // auth hook reads the freshly-written mfa_verified_sessions row). Without
      // this the first batch of PostgREST/Realtime reads after sign-in is
      // rejected by RLS until the natural ~1h refresh — empty dashboard.
      if (!isAuthSessionCurrent(ownedSession)) {
        throw new Error('The verified session no longer owns this browser');
      }
      const refreshOperation = supabase.auth.refreshSession({
        refresh_token: ownedSession.refresh_token,
      });
      const { data: refreshData, error: refreshErr } = await settleSessionOperation(
        refreshOperation,
        {
          timeoutMs: AUTH_SESSION_OPERATION_TIMEOUT_MS,
          label: 'Secure session refresh',
          discardLateSession: discardAuthSession,
        },
      );
      if (refreshErr) throw refreshErr;
      if (!refreshData.session) throw new Error('Secure session refresh returned no session');
      if (
        refreshData.session.user.id !== ownedSession.user.id
        || !isAuthSessionCurrent(refreshData.session)
      ) {
        // If this exact unexpected result became current, remove it. A newer
        // winner with another refresh token is left untouched.
        discardAuthSession(refreshData.session);
        throw new Error('Secure session refresh lost attempt ownership');
      }
      ownedSession = refreshData.session;
    } catch (err) {
      // Fix: do NOT navigate into a half-secured (blank) app. The OTP code
      // is already consumed, so the clean recovery is a fresh sign-in.
      discardAuthSession(ownedSession);
      enterFreshSigninRecovery("Couldn't finish securing your session. Please sign in again.");
      console.warn('verify: securing session failed', err);
      return;
    }

    if (!isAuthSessionCurrent(ownedSession)) {
      enterFreshSigninRecovery('Sign-in state changed. Please sign in again.');
      return;
    }
    replaceNavigation(redirectTarget);
  };

  return (
    <AuthShell subtitle={
      postSignup
        ? ('Confirm your email')
        : ('Verify your email')
    }>

      <p style={{ fontSize: 13.5, color: '#5C625C', lineHeight: 1.5, textAlign: 'center', margin: '0 0 18px' }}>
        {codeDelivered
          ? (<>We sent a 6-digit code to <strong style={{ color: '#1F231C' }}>{email}</strong>. Enter it below.</>)
          : (<>A code has not been sent to <strong style={{ color: '#1F231C' }}>{email}</strong> yet.</>)}
      </p>

      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

        {resendError && <AuthError id="otp-resend-error">{resendError}</AuthError>}

        <div className="si-rise si-d-2" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <AuthLabel htmlFor="signin-otp">{'6-digit code'}</AuthLabel>
          <input
            id="signin-otp"
            name="one-time-code"
            className="si-input"
            type="text"
            inputMode="numeric"
            pattern="[0-9]{6}"
            maxLength={6}
            value={code}
            onChange={e => { setCode(e.target.value.replace(/\D/g, '').slice(0, 6)); setError(''); }}
            autoFocus
            autoComplete="one-time-code"
            disabled={submitting || requiresFreshSignin}
            style={{ height: 56, fontSize: 24, fontWeight: 600, letterSpacing: '0.32em', textAlign: 'center', fontFamily: 'var(--font-geist-mono), monospace' }}
          />
        </div>

        {/* Post-signup mode skips the checkbox entirely — we always trust
            the device because the user just proved ownership of the
            email and Reeyen wants returning users to skip 2FA without
            having to opt-in. Regular sign-in path still shows the
            checkbox so users keep that control. */}
        {!postSignup && (
          <label className="si-rise si-d-2" style={{
            display: 'flex', alignItems: 'center', gap: 10,
            padding: '10px 12px', borderRadius: 12,
            background: 'rgba(255,255,255,0.6)', border: '1px solid rgba(31,35,28,0.1)',
            cursor: submitting || requiresFreshSignin ? 'not-allowed' : 'pointer',
            fontSize: 13, color: '#3A3F38',
          }}>
            <input
              type="checkbox"
              checked={trust}
              onChange={e => setTrust(e.target.checked)}
              disabled={submitting || requiresFreshSignin}
              style={{ width: 16, height: 16, accentColor: '#C99644', cursor: submitting || requiresFreshSignin ? 'not-allowed' : 'pointer' }}
            />
            {'Trust this device'}
          </label>
        )}

        {error && <AuthError>{error}</AuthError>}

        <button
          type="submit"
          disabled={requiresFreshSignin || submitting || code.length !== 6}
          className={`si-btn si-rise si-d-3 ${(requiresFreshSignin || submitting || code.length !== 6) ? 'si-btn-off' : 'si-btn-on'}`}
          style={{ marginTop: 4 }}
        >
          {submitting
            ? <div className="spinner" style={{ width: 18, height: 18, borderTopColor: '#FFFFFF', borderColor: 'rgba(255,255,255,0.3)' }} />
            : ('Verify')
          }
        </button>

        <button
          type="button"
          onClick={() => void resendCode()}
          disabled={requiresFreshSignin || !email || submitting || resending || resendCooldown > 0}
          aria-describedby={resendError ? 'otp-resend-error' : undefined}
          style={{
            minHeight: 44, borderRadius: 12, border: '1px solid rgba(31,35,28,0.14)',
            background: 'rgba(255,255,255,0.72)', color: '#3A3F38',
            fontFamily: 'inherit', fontSize: 13, fontWeight: 600,
            cursor: (requiresFreshSignin || !email || submitting || resending || resendCooldown > 0) ? 'not-allowed' : 'pointer',
            opacity: (requiresFreshSignin || !email || submitting || resending || resendCooldown > 0) ? 0.58 : 1,
          }}
        >
          {resending
            ? ('Sending…')
            : resendCooldown > 0
              ? (`Resend in ${resendCooldown}s`)
              : codeDelivered
                ? ('Resend code')
                : ('Send a new code')}
        </button>

        {requiresFreshSignin ? (
          <a
            href={freshSigninHref}
            style={authBackLinkStyle}
          >
            {'← Back to sign in'}
          </a>
        ) : (
          <Link
            href={'/signin'}
            style={authBackLinkStyle}
          >
            {'← Back to sign in'}
          </Link>
        )}
      </form>
    </AuthShell>
  );
}

export default function VerifyPage() {
  useNavigationReady();
  return (
    <Suspense fallback={null}>
      <VerifyInner />
    </Suspense>
  );
}
