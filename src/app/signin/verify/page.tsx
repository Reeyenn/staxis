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
//      router.replace('/signin/verify?email=…')
//   2. This page reads `email` from the URL and renders the OTP input.
//   3. User types code, optionally checks "Trust this device".
//   4. supabase.auth.verifyOtp({email, token, type:'email'}) → fresh session.
//   5. If trust-this-device was checked, POST /api/auth/trust-device with
//      the new bearer token; cookie + DB row land.
//   6. router.replace('/home') for a normal sign-in

import React, { useEffect, useState, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { supabase } from '@/lib/supabase';
import { useLang } from '@/contexts/LanguageContext';
import AuthShell, { AuthLabel, AuthError, authBackLinkStyle } from '@/components/AuthShell';

function VerifyInner() {
  const { lang } = useLang();
  const router = useRouter();
  const params = useSearchParams();
  const email = params.get('email') ?? '';
  // postSignup=1 means the user landed here directly from /signup. They just
  // proved ownership of the email by entering an OTP that was sent to it,
  // so we auto-trust the device and hide the checkbox entirely — Reeyen
  // wants signups to skip the extra "remember this device?" prompt.
  const postSignup = params.get('postSignup') === '1';
  // Every ordinary hotel sign-in enters through Home. A brand-new signup still
  // passes through the property selector so unfinished setup can resume first.
  const redirectTarget = postSignup ? '/property-selector' : '/home';

  const [code, setCode] = useState('');
  const [trust, setTrust] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

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
      router.replace('/signin');
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/auth/2fa-status', { cache: 'no-store' });
        const body = await res.json().catch(() => null) as {
          ok?: boolean;
          data?: { enabled?: boolean };
        } | null;
        if (cancelled || !body?.ok || body.data?.enabled !== false) return;
        const { data } = await supabase.auth.getSession();
        if (cancelled) return;
        router.replace(data.session ? redirectTarget : '/signin');
      } catch {
        // Fail-safe: stay on the code screen (2FA-on behavior).
      }
    })();
    return () => { cancelled = true; };
  }, [email, redirectTarget, router]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!code.trim()) return;
    setSubmitting(true);
    setError('');

    const { data, error: verifyErr } = await supabase.auth.verifyOtp({
      email: email.trim().toLowerCase(),
      token: code.trim(),
      type: 'email',
    });

    if (verifyErr || !data.session) {
      setSubmitting(false);
      setError(verifyErr?.message ?? (lang === 'es' ? 'Código incorrecto.' : 'Incorrect code.'));
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
      const res = await fetch('/api/auth/trust-device', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Authorization: `Bearer ${data.session.access_token}`,
        },
        credentials: 'include',
        body: JSON.stringify({ remember: trust }),
      });
      if (!res.ok) throw new Error(`trust-device responded ${res.status}`);

      // Force a token refresh so the new JWT carries `mfa_verified=true` (the
      // auth hook reads the freshly-written mfa_verified_sessions row). Without
      // this the first batch of PostgREST/Realtime reads after sign-in is
      // rejected by RLS until the natural ~1h refresh — empty dashboard.
      const { error: refreshErr } = await supabase.auth.refreshSession();
      if (refreshErr) throw refreshErr;
    } catch (err) {
      // Fix: do NOT navigate into a half-secured (blank) app. The OTP code
      // is already consumed, so the clean recovery is a fresh sign-in.
      setSubmitting(false);
      setError(lang === 'es'
        ? 'No pudimos terminar de proteger tu sesión. Inicia sesión de nuevo.'
        : "Couldn't finish securing your session — please sign in again.");
      console.warn('verify: securing session failed', err);
      return;
    }

    router.replace(redirectTarget);
  };

  return (
    <AuthShell subtitle={
      postSignup
        ? (lang === 'es' ? 'Confirma tu correo' : 'Confirm your email')
        : (lang === 'es' ? 'Verifica tu correo' : 'Verify your email')
    }>

      <p style={{ fontSize: 13.5, color: '#5C625C', lineHeight: 1.5, textAlign: 'center', margin: '0 0 18px' }}>
        {lang === 'es'
          ? <>Enviamos un código de 6 dígitos a <strong style={{ color: '#1F231C' }}>{email}</strong>. Ingrésalo abajo.</>
          : <>We sent a 6-digit code to <strong style={{ color: '#1F231C' }}>{email}</strong>. Enter it below.</>}
      </p>

      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

        <div className="si-rise si-d-2" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <AuthLabel>{lang === 'es' ? 'Código de 6 dígitos' : '6-digit code'}</AuthLabel>
          <input
            className="si-input"
            type="text"
            inputMode="numeric"
            pattern="[0-9]{6}"
            maxLength={6}
            value={code}
            onChange={e => { setCode(e.target.value.replace(/\D/g, '').slice(0, 6)); setError(''); }}
            autoFocus
            autoComplete="one-time-code"
            disabled={submitting}
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
            cursor: submitting ? 'not-allowed' : 'pointer',
            fontSize: 13, color: '#3A3F38',
          }}>
            <input
              type="checkbox"
              checked={trust}
              onChange={e => setTrust(e.target.checked)}
              disabled={submitting}
              style={{ width: 16, height: 16, accentColor: '#C99644', cursor: submitting ? 'not-allowed' : 'pointer' }}
            />
            {lang === 'es' ? 'Confiar en este dispositivo' : 'Trust this device'}
          </label>
        )}

        {error && <AuthError>{error}</AuthError>}

        <button
          type="submit"
          disabled={submitting || code.length !== 6}
          className={`si-btn si-rise si-d-3 ${(submitting || code.length !== 6) ? 'si-btn-off' : 'si-btn-on'}`}
          style={{ marginTop: 4 }}
        >
          {submitting
            ? <div className="spinner" style={{ width: 18, height: 18, borderTopColor: '#FFFFFF', borderColor: 'rgba(255,255,255,0.3)' }} />
            : (lang === 'es' ? 'Verificar' : 'Verify')
          }
        </button>

        <Link href="/signin" style={authBackLinkStyle}>
          {lang === 'es' ? '← Volver al inicio de sesión' : '← Back to sign in'}
        </Link>
      </form>
    </AuthShell>
  );
}

export default function VerifyPage() {
  return (
    <Suspense fallback={null}>
      <VerifyInner />
    </Suspense>
  );
}
