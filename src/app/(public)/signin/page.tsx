'use client';


export const dynamic = 'force-dynamic';
import React, { Suspense, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { useAuth } from '@/contexts/AuthContext';
import { useLang } from '@/contexts/LanguageContext';
import { supabase } from '@/lib/supabase';
import { t } from '@/lib/translations';
import { parseCheckTrustResponse } from '@/lib/api-validate';
import { safeRedirect } from '@/lib/url-redirect';
import AuthShell, { AuthLabel, AuthError, authLinkStyle, AUTH_LINK } from '@/components/AuthShell';
import { AUTH_OPERATION_TIMEOUT_MS, fetchWithAuth } from '@/lib/api-fetch';
import { withPromiseDeadline } from '@/lib/fetch-deadline';
import { useNavigationReady, useReliableNavigation } from '@/lib/hooks/use-reliable-navigation';
import {
  shouldAutoRedirectExistingSession,
  signInRedirectTarget,
} from '@/lib/auth/signin-navigation-policy';
import { useFreshSignInRecovery } from '@/lib/auth/use-fresh-signin-recovery';

/**
 * Banner shown when fetchWithAuth signed the user out and bounced them
 * here. Distinct from a fresh visit — they didn't choose to sign out, the
 * app evicted them. Acknowledging that explicitly is the difference
 * between "weird, why am I here" and "ah, session expired".
 */
function SessionEndedBanner({ freshRetryReady }: { freshRetryReady: boolean }) {
  const params = useSearchParams();
  const reason = params.get('reason');
  if (reason !== 'session-ended' && reason !== 'config-error' && reason !== 'auth-retry') return null;
  const isConfig = reason === 'config-error';
  const isFreshRetry = reason === 'auth-retry';
  return (
    <div
      role="status"
      style={{
        marginBottom: '20px',
        padding: '12px 14px',
        borderRadius: '12px',
        background: isConfig ? 'rgba(184,92,61,0.10)' : 'rgba(255,255,255,0.6)',
        border: '1px solid ' + (isConfig ? 'rgba(184,92,61,0.30)' : 'rgba(31,35,28,0.10)'),
        color: isConfig ? '#B85C3D' : '#3A3F38',
        fontSize: '13px',
        lineHeight: 1.45,
        textAlign: 'center',
      }}
    >
      {isConfig
        ? 'Sign-in is temporarily unavailable. Our team has been notified. Please try again in a few minutes.'
        : isFreshRetry
          ? freshRetryReady
            ? 'The previous sign-in was safely reset. Enter your credentials to try again.'
            : 'Resetting the previous sign-in before another attempt…'
          : 'Your session ended. Sign in to continue.'}
    </div>
  );
}

// Inner component that uses `useSearchParams`. Wrapped below in a Suspense
// boundary so Next.js's static prerender pass doesn't choke on the hook —
// matches the same pattern as SessionEndedBanner above.
function SignInInner() {
  const {
    user,
    loading,
    signIn,
    isAuthSessionCurrent,
    discardAuthSession,
    resetForFreshSignIn,
  } = useAuth();
  const { lang } = useLang();
  const navigation = useReliableNavigation();
  const replaceNavigation = navigation.replace;
  const params = useSearchParams();
  const isFreshRetry = params.get('reason') === 'auth-retry';

  const rawRedirect = params.get('redirect');
  const ordinaryRequestedTarget = safeRedirect(rawRedirect, '/home');
  // The retired company-invitation flow used to park its token in
  // sessionStorage and walk the visitor through sign-in mid-invitation, so this
  // page carried a whole handoff state machine to resolve where to send them
  // afterwards. That invitation system is gone: /invite/[token] collects a name
  // and password on its own page and never routes through sign-in, so there is
  // nothing to hand off and the requested target is simply the requested target.
  const requestedTarget = ordinaryRequestedTarget;
  // Company access is intentionally property-independent during the
  // normalized-access rollout. Keep this bypass narrow: zero-legacy-property
  // accounts may open only the Company hub.
  const isPropertyIndependentCompanyTarget = requestedTarget === '/company';
  const redirectTarget = signInRedirectTarget({
    user,
    requestedTarget,
    propertyIndependent: isPropertyIndependentCompanyTarget,
  });
  const freshSigninHref = rawRedirect
    ? `/signin?reason=auth-retry&redirect=${encodeURIComponent(rawRedirect)}`
    : '/signin?reason=auth-retry';

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [signing, setSigning] = useState(false);
  const [requiresFreshSignin, setRequiresFreshSignin] = useState(false);
  const submitInFlightRef = useRef(false);
  const explicitAttemptStartedRef = useRef(false);
  const freshRecovery = useFreshSignInRecovery({
    required: isFreshRetry,
    authLoading: loading,
    hasUser: Boolean(user),
    attemptInFlight: signing,
    resetLocalSession: resetForFreshSignIn,
  });

  // Auto-redirect users with an existing session AWAY from /signin — but
  // skip the redirect while a sign-in is in flight. Without that guard,
  // signIn()'s setUser() fires this useEffect and lands the user on
  // /home BEFORE handleSubmit can run the trust check + OTP
  // step (which itself signs the user out again and redirects to
  // /signin/verify). That race produced the "flash dashboard then bounce
  // back to signin" loop reported on 2026-05-10.
  useEffect(() => {
    if (shouldAutoRedirectExistingSession({
      // Nothing defers this page any more; the handoff it waited on is gone.
      handoffResolved: true,
      explicitAttemptStarted: explicitAttemptStartedRef.current,
      freshRetry: isFreshRetry,
      loading,
      hasUser: Boolean(user),
      signing,
    })) {
      replaceNavigation(redirectTarget);
    }
  }, [user, loading, replaceNavigation, signing, redirectTarget, isFreshRetry]);

  // Sign-in flow (Phase 2 + Resend email):
  //   1. signInWithPassword — verifies the password, issues a session.
  //   2. Trust check — if the device has a valid staxis_device cookie +
  //      matching trusted_devices row, skip OTP and go straight in.
  //   3. Otherwise: discard only this temporary session, send a 6-digit OTP via
  //      signInWithOtp (delivered by Resend through Supabase custom SMTP),
  //      route to /signin/verify?email=… for code entry.
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (
      submitInFlightRef.current
      || !freshRecovery.ready
      || !email.trim()
      || !password
    ) return;

    submitInFlightRef.current = true;
    setSigning(true);
    setError('');

    let passwordSession: Awaited<ReturnType<typeof signIn>>['session'] = null;
    const finish = () => {
      submitInFlightRef.current = false;
      setSigning(false);
    };
    const clearPasswordSession = () => {
      if (!passwordSession) return true;
      const discarded = discardAuthSession(passwordSession);
      passwordSession = null;
      return discarded;
    };

    try {
      if (isFreshRetry) {
        // Re-run the local reset at the click boundary. A late Session A may
        // have arrived after the page's initial recovery pass; it must be
        // discarded before Attempt B is allowed to create another session.
        const reset = await freshRecovery.resetBeforeSubmit();
        if (!reset) {
          setError(
            freshRecovery.error
            ?? ('We could not safely reset the previous sign-in. Try the reset again.'),
          );
          finish();
          return;
        }
      }
      // From this point forward only this attempt's explicit trust/OTP outcome
      // may navigate. A cross-tab auth event must not turn a failed submit into
      // an unchecked protected-route redirect. Set the latch only after the
      // recovery reset, so Attempt B's own SIGNED_IN event is never re-cleared.
      explicitAttemptStartedRef.current = true;

      const trimmed = email.trim().toLowerCase();
      // If the user typed a bare username (no @), treat it as a synthetic
      // ${username}@staxis.local login. Lets the shared "test" investor
      // account sign in by typing just "test"; real-email accounts (jay,
      // reeyen, etc.) keep working because their input already has an @.
      const normalizedEmail = trimmed.includes('@') ? trimmed : `${trimmed}@staxis.local`;
      const result = await signIn(normalizedEmail, password);
      if (result.error || !result.session || !result.user) {
        if (result.requiresFreshSignin) {
          setRequiresFreshSignin(true);
          // Replace the entire document immediately. GoTrue's original,
          // uncancellable Promise may still be alive; keeping this App Router
          // tree would let Back or another auth screen start competing work in
          // the same Supabase singleton before its exact-session observer runs.
          try { window.location.replace(freshSigninHref); } catch { /* render the hard-link fallback below */ }
        }
        setError(result.error ?? t('invalidCredentials', lang));
        finish();
        return;
      }
      passwordSession = result.session;
      const authenticatedRedirectTarget = signInRedirectTarget({
        user: result.user,
        requestedTarget,
        propertyIndependent: isPropertyIndependentCompanyTarget,
      });

      // Use the exact session returned by this attempt. A separate getSession
      // can observe a different tab's newer login and make this attempt's
      // trust decision operate on the wrong account.
      const accessToken = passwordSession.access_token;

      let trusted = false;
      if (accessToken) {
        try {
          // This is a read even though the route uses POST. Give both the
          // request and its JSON body a firm auth-operation deadline so a
          // dropped connection cannot leave the Sign In form disabled forever.
          // The explicit bearer token also keeps this pre-session check out of
          // fetchWithAuth's 401 recovery/sign-out policy.
          const res = await fetchWithAuth('/api/auth/check-trust', {
            method: 'POST',
            headers: { Authorization: `Bearer ${accessToken}` },
            credentials: 'include',
            timeoutMs: AUTH_OPERATION_TIMEOUT_MS,
          });
          if (res.ok) {
            const raw = await res.json();
            // Runtime parser (audit Flow 1 #4): the previous code did
            // `body.data?.trusted` with an `as` cast that silently
            // coerced any shape drift to false. parseCheckTrustResponse
            // returns a typed value or an error string so we can tell
            // "server returned trusted=false" from "server changed shape".
            const parsed = parseCheckTrustResponse(raw);
            if (parsed.value) {
              trusted = parsed.value.trusted;
            } else {
              console.warn('check-trust response shape unexpected:', parsed.error);
            }
          }
        } catch (err) {
          console.warn('check-trust failed', err);
        }
      }

      if (trusted) {
        if (!isAuthSessionCurrent(passwordSession)) {
          passwordSession = null;
          setError('Sign-in state changed. Please try again.');
          finish();
          return;
        }
        // Trust was checked for this exact session; navigate explicitly. The
        // generic existing-session effect remains latched off for this submit.
        // Keep `signing` true until this page unmounts so fresh-retry recovery
        // cannot mistake B's expected SIGNED_IN event for another late A while
        // the reliable navigation is committing.
        passwordSession = null;
        replaceNavigation(authenticatedRedirectTarget);
        return;
      }

      // Untrusted → send OTP, route to verify screen.
      if (!clearPasswordSession()) {
        setError('Sign-in state changed. Please try again.');
        finish();
        return;
      }
      const { error: otpErr } = await withPromiseDeadline(
        supabase.auth.signInWithOtp({
          email: normalizedEmail,
          options: { shouldCreateUser: false },
        }),
        { timeoutMs: AUTH_OPERATION_TIMEOUT_MS, label: 'Send verification code' },
      );
      if (otpErr) {
        setError(otpErr.message);
        finish();
        return;
      }
      // Preserve a protected deep link through OTP. The verify page routes via
      // the property selector, so multi-hotel users choose the hotel before the
      // target opens; an ordinary login still falls through to Home.
      const verifyUrl = `/signin/verify?email=${encodeURIComponent(normalizedEmail)}${
        rawRedirect ? `&redirect=${encodeURIComponent(rawRedirect)}` : ''
      }`;
      replaceNavigation(verifyUrl);
    } catch {
      clearPasswordSession();
      setError(t('invalidCredentials', lang));
      finish();
    }
  };

  if (loading) {
    return (
      <div style={{ minHeight: '100dvh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#F2EFE8' }}>
        <div className="spinner" style={{ width: '32px', height: '32px', borderTopColor: '#C99644', borderColor: 'rgba(201,150,68,0.25)' }} />
      </div>
    );
  }

  const recoveryBusy = isFreshRetry && !freshRecovery.ready && !freshRecovery.error;
  const disabled = requiresFreshSignin
    || !freshRecovery.ready
    || signing
    || !email.trim()
    || !password;

  return (
    <AuthShell subtitle={t('signInPrompt', lang)}>

      <Suspense fallback={null}>
        <SessionEndedBanner freshRetryReady={freshRecovery.ready} />
      </Suspense>

      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

        <div className="si-rise si-d-2" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <AuthLabel htmlFor="signin-email">{'Email'}</AuthLabel>
          <input
            id="signin-email"
            name="email"
            className="si-input"
            type="text"
            inputMode="email"
            value={email}
            onChange={e => { setEmail(e.target.value); setError(''); }}
            autoComplete="username"
            autoCapitalize="off"
            spellCheck={false}
            disabled={signing || requiresFreshSignin || !freshRecovery.ready}
            placeholder="you@hotel.com"
          />
        </div>

        <div className="si-rise si-d-2" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <AuthLabel htmlFor="signin-password">{t('password', lang)}</AuthLabel>
            {requiresFreshSignin ? (
              <a href="/signin/forgot" style={authLinkStyle}>
                {'Forgot password?'}
              </a>
            ) : (
              <Link href="/signin/forgot" style={authLinkStyle}>
                {'Forgot password?'}
              </Link>
            )}
          </div>
          <input
            id="signin-password"
            name="password"
            className="si-input"
            type="password"
            value={password}
            onChange={e => { setPassword(e.target.value); setError(''); }}
            autoComplete="current-password"
            disabled={signing || requiresFreshSignin || !freshRecovery.ready}
            placeholder="••••••••"
          />
        </div>

        {error && <AuthError>{error}</AuthError>}

        {recoveryBusy && (
          <div role="status" aria-live="polite" aria-busy="true" style={{ textAlign: 'center', color: '#5C625C', fontSize: 13 }}>
            {'Safely resetting the previous sign-in…'}
          </div>
        )}

        {freshRecovery.error && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <AuthError>{freshRecovery.error}</AuthError>
            <button
              type="button"
              onClick={() => void freshRecovery.retry()}
              style={{ ...authLinkStyle, minHeight: 44, border: 0, background: 'transparent', cursor: 'pointer' }}
            >
              {'Try reset again'}
            </button>
          </div>
        )}

        {requiresFreshSignin && (
          <a
            href={freshSigninHref}
            style={{ ...authLinkStyle, minHeight: 44, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
          >
            {'Start fresh sign-in'}
          </a>
        )}

        <button
          type="submit"
          disabled={disabled}
          className={`si-btn si-rise si-d-3 ${disabled ? 'si-btn-off' : 'si-btn-on'}`}
          style={{ marginTop: 6 }}
        >
          {signing || recoveryBusy
            ? <div className="spinner" style={{ width: 18, height: 18, borderTopColor: '#FFFFFF', borderColor: 'rgba(255,255,255,0.3)' }} />
            : t('signIn', lang)
          }
        </button>

        {/* Create-account link — staff sign up at /signup using a code
            the hotel owner generated. Existing users sign in above. */}
        <p className="si-rise si-d-3" style={{ textAlign: 'center', marginTop: 8, fontSize: 13, color: '#5C625C' }}>
          {"Don't have an account? "}
          {requiresFreshSignin ? (
            <a href="/signup" style={{ color: AUTH_LINK, textDecoration: 'none', fontWeight: 600 }}>
              {'Create account'}
            </a>
          ) : (
            <Link href="/signup" style={{ color: AUTH_LINK, textDecoration: 'none', fontWeight: 600 }}>
              {'Create account'}
            </Link>
          )}
        </p>

      </form>
    </AuthShell>
  );
}

export default function SignInPage() {
  useNavigationReady();
  return (
    <Suspense fallback={null}>
      <SignInInner />
    </Suspense>
  );
}
