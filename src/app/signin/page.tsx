'use client';


export const dynamic = 'force-dynamic';
import React, { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { useAuth } from '@/contexts/AuthContext';
import { useLang } from '@/contexts/LanguageContext';
import { supabase } from '@/lib/supabase';
import { t } from '@/lib/translations';
import { parseCheckTrustResponse } from '@/lib/api-validate';
import { safeRedirect } from '@/lib/url-redirect';
import {
  COMPANY_INVITATION_HANDOFF_PARAM,
  COMPANY_INVITATION_HANDOFF_VALUE,
  COMPANY_INVITATION_RESUME_PATH,
  COMPANY_INVITATION_SIGN_IN_HREF,
  companyInvitationTokenFromPath,
  readCompanyInvitationHandoff,
  storeCompanyInvitationHandoff,
} from '@/lib/company-access/invitation-handoff';
import AuthShell, { AuthLabel, AuthError, authLinkStyle, AUTH_LINK } from '@/components/AuthShell';

/**
 * Banner shown when fetchWithAuth signed the user out and bounced them
 * here. Distinct from a fresh visit — they didn't choose to sign out, the
 * app evicted them. Acknowledging that explicitly is the difference
 * between "weird, why am I here" and "ah, session expired".
 */
function SessionEndedBanner() {
  const params = useSearchParams();
  const reason = params.get('reason');
  if (reason !== 'session-ended' && reason !== 'config-error') return null;
  const isConfig = reason === 'config-error';
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
        ? 'Sign-in is temporarily unavailable. Our team has been notified — please try again in a few minutes.'
        : 'Your session ended. Sign in to continue.'}
    </div>
  );
}

// Inner component that uses `useSearchParams`. Wrapped below in a Suspense
// boundary so Next.js's static prerender pass doesn't choke on the hook —
// matches the same pattern as SessionEndedBanner above.
function SignInInner() {
  const { user, loading, signIn } = useAuth();
  const { lang } = useLang();
  const router = useRouter();
  const params = useSearchParams();

  const rawRedirect = params.get('redirect');
  const ordinaryRequestedTarget = safeRedirect(rawRedirect, '/home');
  const legacyInvitationToken = companyInvitationTokenFromPath(ordinaryRequestedTarget);
  const usesCompanyInvitationHandoff = params.get(COMPANY_INVITATION_HANDOFF_PARAM)
    === COMPANY_INVITATION_HANDOFF_VALUE || legacyInvitationToken !== null;
  const handoffIdentity = usesCompanyInvitationHandoff
    ? legacyInvitationToken ?? COMPANY_INVITATION_HANDOFF_VALUE
    : null;
  const [resolvedHandoff, setResolvedHandoff] = useState<{
    identity: string;
    target: string | null;
  } | null>(null);

  // Invitation tokens stay in sessionStorage while auth pages carry only an
  // opaque marker. Legacy token-bearing sign-in links are cleaned with a
  // history replacement and are never propagated to the OTP URL.
  useEffect(() => {
    if (!handoffIdentity) {
      setResolvedHandoff(null);
      return;
    }
    if (legacyInvitationToken) {
      storeCompanyInvitationHandoff(legacyInvitationToken);
      router.replace(COMPANY_INVITATION_SIGN_IN_HREF);
    }
    setResolvedHandoff({
      identity: handoffIdentity,
      target: readCompanyInvitationHandoff() ? COMPANY_INVITATION_RESUME_PATH : null,
    });
  }, [handoffIdentity, legacyInvitationToken, router]);

  const handoffResolved = handoffIdentity === null || resolvedHandoff?.identity === handoffIdentity;
  const requestedTarget = usesCompanyInvitationHandoff
    ? resolvedHandoff?.identity === handoffIdentity
      ? resolvedHandoff.target ?? '/company'
      : '/company'
    : ordinaryRequestedTarget;
  // Company access is intentionally property-independent during the
  // normalized-access rollout. Keep this bypass narrow: zero-legacy-property
  // accounts may open only the Company hub or finish a company invitation.
  const isPropertyIndependentCompanyTarget = requestedTarget === '/company'
    || requestedTarget.startsWith('/company-invite/');
  const needsPropertySelection = Boolean(
    user && !isPropertyIndependentCompanyTarget && (
      user.role === 'admin' ||
      user.propertyAccess.includes('*') ||
      user.propertyAccess.length !== 1
    )
  );
  const redirectTarget = needsPropertySelection
    ? `/property-selector${
        requestedTarget === '/home' || requestedTarget.startsWith('/property-selector')
          ? ''
          : `?redirect=${encodeURIComponent(requestedTarget)}`
      }`
    : requestedTarget;

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [signing, setSigning] = useState(false);

  // Auto-redirect users with an existing session AWAY from /signin — but
  // skip the redirect while a sign-in is in flight. Without that guard,
  // signIn()'s setUser() fires this useEffect and lands the user on
  // /home BEFORE handleSubmit can run the trust check + OTP
  // step (which itself signs the user out again and redirects to
  // /signin/verify). That race produced the "flash dashboard then bounce
  // back to signin" loop reported on 2026-05-10.
  useEffect(() => {
    if (handoffResolved && !loading && user && !signing) router.replace(redirectTarget);
  }, [user, loading, router, signing, redirectTarget, handoffResolved]);

  // Sign-in flow (Phase 2 + Resend email):
  //   1. signInWithPassword — verifies the password, issues a session.
  //   2. Trust check — if the device has a valid staxis_device cookie +
  //      matching trusted_devices row, skip OTP and go straight in.
  //   3. Otherwise: signOut() the session, send a 6-digit OTP via
  //      signInWithOtp (delivered by Resend through Supabase custom SMTP),
  //      route to /signin/verify?email=… for code entry.
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!handoffResolved || !email.trim() || !password) return;

    setSigning(true);
    setError('');

    try {
      const trimmed = email.trim().toLowerCase();
      // If the user typed a bare username (no @), treat it as a synthetic
      // ${username}@staxis.local login. Lets the shared "test" investor
      // account sign in by typing just "test"; real-email accounts (jay,
      // reeyen, etc.) keep working because their input already has an @.
      const normalizedEmail = trimmed.includes('@') ? trimmed : `${trimmed}@staxis.local`;
      const errMsg = await signIn(normalizedEmail, password);
      if (errMsg) {
        setError(errMsg);
        setSigning(false);
        return;
      }

      // Password verified. Pull session for the trust-check API.
      const { data: sessionData } = await supabase.auth.getSession();
      const accessToken = sessionData.session?.access_token;

      let trusted = false;
      if (accessToken) {
        try {
          const res = await fetch('/api/auth/check-trust', {
            method: 'POST',
            headers: { Authorization: `Bearer ${accessToken}` },
            credentials: 'include',
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
        // Drop the signing guard so the useEffect can navigate.
        setSigning(false);
        return;
      }

      // Untrusted → send OTP, route to verify screen.
      await supabase.auth.signOut();
      const { error: otpErr } = await supabase.auth.signInWithOtp({
        email: normalizedEmail,
        options: { shouldCreateUser: false },
      });
      if (otpErr) {
        setError(otpErr.message);
        setSigning(false);
        return;
      }
      // Preserve a protected deep link through OTP. The verify page routes via
      // the property selector, so multi-hotel users choose the hotel before the
      // target opens; an ordinary login still falls through to Home.
      const verifyUrl = `/signin/verify?email=${encodeURIComponent(normalizedEmail)}${
        usesCompanyInvitationHandoff
          ? `&${COMPANY_INVITATION_HANDOFF_PARAM}=${COMPANY_INVITATION_HANDOFF_VALUE}`
          : rawRedirect ? `&redirect=${encodeURIComponent(rawRedirect)}` : ''
      }`;
      router.replace(verifyUrl);
    } catch {
      setError(t('invalidCredentials', lang));
      setSigning(false);
    }
  };

  if (loading) {
    return (
      <div style={{ minHeight: '100dvh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#F2EFE8' }}>
        <div className="spinner" style={{ width: '32px', height: '32px', borderTopColor: '#C99644', borderColor: 'rgba(201,150,68,0.25)' }} />
      </div>
    );
  }

  const disabled = !handoffResolved || signing || !email.trim() || !password;

  return (
    <AuthShell subtitle={t('signInPrompt', lang)}>

      <Suspense fallback={null}>
        <SessionEndedBanner />
      </Suspense>

      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

        <div className="si-rise si-d-2" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <AuthLabel htmlFor="signin-email">{lang === 'es' ? 'Correo electrónico' : 'Email'}</AuthLabel>
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
            disabled={signing}
            placeholder="you@hotel.com"
          />
        </div>

        <div className="si-rise si-d-2" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <AuthLabel htmlFor="signin-password">{t('password', lang)}</AuthLabel>
            <Link href="/signin/forgot" style={authLinkStyle}>
              {lang === 'es' ? '¿Olvidaste tu contraseña?' : 'Forgot password?'}
            </Link>
          </div>
          <input
            id="signin-password"
            name="password"
            className="si-input"
            type="password"
            value={password}
            onChange={e => { setPassword(e.target.value); setError(''); }}
            autoComplete="current-password"
            disabled={signing}
            placeholder="••••••••"
          />
        </div>

        {error && <AuthError>{error}</AuthError>}

        <button
          type="submit"
          disabled={disabled}
          className={`si-btn si-rise si-d-3 ${disabled ? 'si-btn-off' : 'si-btn-on'}`}
          style={{ marginTop: 6 }}
        >
          {signing
            ? <div className="spinner" style={{ width: 18, height: 18, borderTopColor: '#FFFFFF', borderColor: 'rgba(255,255,255,0.3)' }} />
            : t('signIn', lang)
          }
        </button>

        {/* Create-account link — staff sign up at /signup using a code
            the hotel owner generated. Existing users sign in above. */}
        <p className="si-rise si-d-3" style={{ textAlign: 'center', marginTop: 8, fontSize: 13, color: '#5C625C' }}>
          {lang === 'es' ? '¿No tienes una cuenta? ' : "Don't have an account? "}
          <Link href="/signup" style={{ color: AUTH_LINK, textDecoration: 'none', fontWeight: 600 }}>
            {lang === 'es' ? 'Crear cuenta' : 'Create account'}
          </Link>
        </p>

      </form>
    </AuthShell>
  );
}

export default function SignInPage() {
  return (
    <Suspense fallback={null}>
      <SignInInner />
    </Suspense>
  );
}
