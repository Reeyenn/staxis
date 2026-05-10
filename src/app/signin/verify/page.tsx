'use client';

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
//   6. router.replace('/property-selector')

import React, { useEffect, useState, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { supabase } from '@/lib/supabase';
import { useLang } from '@/contexts/LanguageContext';

function VerifyInner() {
  const { lang } = useLang();
  const router = useRouter();
  const params = useSearchParams();
  const email = params.get('email') ?? '';

  const [code, setCode] = useState('');
  const [trust, setTrust] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  // No email → user landed here without going through /signin first.
  useEffect(() => {
    if (!email) router.replace('/signin');
  }, [email, router]);

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

    if (trust) {
      try {
        await fetch('/api/auth/trust-device', {
          method: 'POST',
          headers: { Authorization: `Bearer ${data.session.access_token}` },
          credentials: 'include',
        });
      } catch (err) {
        // Non-fatal — we still log the user in, they'll just get prompted
        // again on their next sign-in from this device.
        console.warn('trust-device call failed', err);
      }
    }

    router.replace('/property-selector');
  };

  return (
    <div style={{
      minHeight: '100dvh',
      background: 'var(--bg)',
      display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
      padding: '32px 24px',
    }}>
      <div style={{ width: '100%', maxWidth: '360px' }}>

        <div style={{ marginBottom: '32px', textAlign: 'center' }}>
          <div style={{
            width: '44px', height: '44px', borderRadius: '11px',
            background: 'var(--amber)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            margin: '0 auto 16px',
          }}>
            <span style={{ fontSize: '22px', fontWeight: 700, color: '#FFFFFF', fontFamily: 'var(--font-mono)' }}>S</span>
          </div>
          <h1 style={{
            fontFamily: 'var(--font-sans)', fontWeight: 700,
            fontSize: '22px', letterSpacing: '-0.02em',
            color: 'var(--text-primary)', marginBottom: '6px',
          }}>
            {lang === 'es' ? 'Verifica tu correo' : 'Verify your email'}
          </h1>
          <p style={{ color: 'var(--text-muted)', fontSize: '14px', lineHeight: 1.5 }}>
            {lang === 'es'
              ? <>Enviamos un código de 6 dígitos a <strong>{email}</strong>. Ingrésalo abajo.</>
              : <>We sent a 6-digit code to <strong>{email}</strong>. Enter it below.</>}
          </p>
        </div>

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <label style={{
              fontSize: '12px', fontWeight: 600, letterSpacing: '0.04em',
              color: 'var(--text-secondary)', textTransform: 'uppercase',
              fontFamily: 'var(--font-sans)',
            }}>
              {lang === 'es' ? 'Código de 6 dígitos' : '6-digit code'}
            </label>
            <input
              type="text"
              inputMode="numeric"
              pattern="[0-9]{6}"
              maxLength={6}
              value={code}
              onChange={e => { setCode(e.target.value.replace(/\D/g, '').slice(0, 6)); setError(''); }}
              autoFocus
              autoComplete="one-time-code"
              disabled={submitting}
              style={{
                height: '52px', borderRadius: 'var(--radius-md)',
                background: 'var(--bg-card)', border: '1px solid var(--border)',
                padding: '0 14px',
                color: 'var(--text-primary)',
                fontSize: '22px', fontWeight: 600, letterSpacing: '0.3em',
                fontFamily: 'var(--font-mono)',
                textAlign: 'center',
                outline: 'none',
                opacity: submitting ? 0.6 : 1,
              }}
            />
          </div>

          <label style={{
            display: 'flex', alignItems: 'center', gap: '10px',
            padding: '10px 12px', borderRadius: 'var(--radius-md)',
            background: 'var(--bg-card)', border: '1px solid var(--border)',
            cursor: submitting ? 'not-allowed' : 'pointer',
            fontSize: '13px', color: 'var(--text-secondary)',
            fontFamily: 'var(--font-sans)',
          }}>
            <input
              type="checkbox"
              checked={trust}
              onChange={e => setTrust(e.target.checked)}
              disabled={submitting}
              style={{ width: '16px', height: '16px', cursor: submitting ? 'not-allowed' : 'pointer' }}
            />
            {lang === 'es' ? 'Confiar en este dispositivo por 30 días' : 'Trust this device for 30 days'}
          </label>

          {error && (
            <p style={{
              fontSize: '13px', color: 'var(--red)',
              background: 'var(--red-dim)',
              border: '1px solid var(--red-border, rgba(239,68,68,0.2))',
              borderRadius: 'var(--radius-sm)',
              padding: '10px 12px',
              margin: 0,
            }}>
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={submitting || code.length !== 6}
            style={{
              width: '100%', height: '48px', marginTop: '4px',
              borderRadius: 'var(--radius-md)',
              background: (submitting || code.length !== 6)
                ? 'rgba(37,99,235,0.4)'
                : 'var(--navy-light)',
              color: '#FFFFFF',
              fontFamily: 'var(--font-sans)', fontWeight: 600, fontSize: '15px',
              border: 'none',
              cursor: (submitting || code.length !== 6) ? 'not-allowed' : 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >
            {submitting
              ? <div className="spinner" style={{ width: '18px', height: '18px', borderTopColor: '#FFFFFF', borderColor: 'rgba(255,255,255,0.3)' }} />
              : (lang === 'es' ? 'Verificar' : 'Verify')
            }
          </button>

          <Link
            href="/signin"
            style={{
              display: 'block', textAlign: 'center', marginTop: '4px',
              fontSize: '13px', color: 'var(--text-muted)',
              textDecoration: 'none', fontFamily: 'var(--font-sans)',
            }}
          >
            {lang === 'es' ? '← Volver al inicio de sesión' : '← Back to sign in'}
          </Link>
        </form>

      </div>
    </div>
  );
}

export default function VerifyPage() {
  return (
    <Suspense fallback={null}>
      <VerifyInner />
    </Suspense>
  );
}
