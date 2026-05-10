'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useAuth } from '@/contexts/AuthContext';
import { useLang } from '@/contexts/LanguageContext';
import { supabase } from '@/lib/supabase';
import { t } from '@/lib/translations';

export default function SignInPage() {
  const { user, loading, signIn } = useAuth();
  const { lang } = useLang();
  const router = useRouter();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [signing, setSigning] = useState(false);

  // Auto-redirect users with an existing session AWAY from /signin — but
  // skip the redirect while a sign-in is in flight. Without that guard,
  // signIn()'s setUser() fires this useEffect and lands the user on
  // /property-selector BEFORE handleSubmit can run the trust check + OTP
  // step (which itself signs the user out again and redirects to
  // /signin/verify). That race produced the "flash dashboard then bounce
  // back to signin" loop reported on 2026-05-10.
  useEffect(() => {
    if (!loading && user && !signing) router.replace('/property-selector');
  }, [user, loading, router, signing]);

  // Sign-in flow (Phase 2 + Resend email):
  //   1. signInWithPassword — verifies the password, issues a session.
  //   2. Trust check — if the device has a valid staxis_device cookie +
  //      matching trusted_devices row, skip OTP and go straight in.
  //   3. Otherwise: signOut() the session, send a 6-digit OTP via
  //      signInWithOtp (delivered by Resend through Supabase custom SMTP),
  //      route to /signin/verify?email=… for code entry.
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !password) return;

    setSigning(true);
    setError('');

    try {
      const normalizedEmail = email.trim().toLowerCase();
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
            const body = await res.json() as { data?: { trusted?: boolean } };
            trusted = !!body.data?.trusted;
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
      router.replace(`/signin/verify?email=${encodeURIComponent(normalizedEmail)}`);
    } catch {
      setError(t('invalidCredentials', lang));
      setSigning(false);
    }
  };

  if (loading) {
    return (
      <div style={{ minHeight: '100dvh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg)' }}>
        <div className="spinner" style={{ width: '32px', height: '32px' }} />
      </div>
    );
  }

  return (
    <div style={{
      minHeight: '100dvh',
      background: 'var(--bg)',
      display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
      padding: '32px 24px',
    }}>
      <div style={{ width: '100%', maxWidth: '360px' }}>

        {/* Logo */}
        <div style={{ marginBottom: '40px', textAlign: 'center' }}>
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
            fontSize: '26px', letterSpacing: '-0.02em',
            color: 'var(--text-primary)', marginBottom: '6px',
          }}>
            Staxis
          </h1>
          <p style={{ color: 'var(--text-muted)', fontSize: '14px' }}>{t('signInPrompt', lang)}</p>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <label style={{
              fontSize: '12px', fontWeight: 600, letterSpacing: '0.04em',
              color: 'var(--text-secondary)', textTransform: 'uppercase',
              fontFamily: 'var(--font-sans)',
            }}>
              {lang === 'es' ? 'Correo electrónico' : 'Email'}
            </label>
            <input
              type="email"
              value={email}
              onChange={e => { setEmail(e.target.value); setError(''); }}
              autoComplete="email"
              autoCapitalize="off"
              spellCheck={false}
              disabled={signing}
              style={{
                height: '44px', borderRadius: 'var(--radius-md)',
                background: 'var(--bg-card)', border: '1px solid var(--border)',
                padding: '0 14px',
                color: 'var(--text-primary)', fontSize: '15px',
                fontFamily: 'var(--font-sans)',
                outline: 'none',
                transition: 'border-color 120ms',
                opacity: signing ? 0.6 : 1,
              }}
              onFocus={e => { e.currentTarget.style.borderColor = 'var(--border-focus)'; }}
              onBlur={e => { e.currentTarget.style.borderColor = 'var(--border)'; }}
            />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <label style={{
                fontSize: '12px', fontWeight: 600, letterSpacing: '0.04em',
                color: 'var(--text-secondary)', textTransform: 'uppercase',
                fontFamily: 'var(--font-sans)',
              }}>
                {t('password', lang)}
              </label>
              <Link
                href="/signin/forgot"
                style={{
                  fontSize: '12px', color: 'var(--navy-light)',
                  textDecoration: 'none', fontFamily: 'var(--font-sans)',
                }}
              >
                {lang === 'es' ? '¿Olvidaste tu contraseña?' : 'Forgot password?'}
              </Link>
            </div>
            <input
              type="password"
              value={password}
              onChange={e => { setPassword(e.target.value); setError(''); }}
              autoComplete="current-password"
              disabled={signing}
              style={{
                height: '44px', borderRadius: 'var(--radius-md)',
                background: 'var(--bg-card)', border: '1px solid var(--border)',
                padding: '0 14px',
                color: 'var(--text-primary)', fontSize: '15px',
                fontFamily: 'var(--font-sans)',
                outline: 'none',
                transition: 'border-color 120ms',
                opacity: signing ? 0.6 : 1,
              }}
              onFocus={e => { e.currentTarget.style.borderColor = 'var(--border-focus)'; }}
              onBlur={e => { e.currentTarget.style.borderColor = 'var(--border)'; }}
            />
          </div>

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
            disabled={signing || !email.trim() || !password}
            style={{
              width: '100%', height: '48px', marginTop: '4px',
              borderRadius: 'var(--radius-md)',
              background: (signing || !email.trim() || !password)
                ? 'rgba(37,99,235,0.4)'
                : 'var(--navy-light)',
              color: '#FFFFFF',
              fontFamily: 'var(--font-sans)', fontWeight: 600, fontSize: '15px',
              border: 'none',
              cursor: (signing || !email.trim() || !password) ? 'not-allowed' : 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              transition: 'all 120ms',
            }}
          >
            {signing
              ? <div className="spinner" style={{ width: '18px', height: '18px', borderTopColor: '#FFFFFF', borderColor: 'rgba(255,255,255,0.3)' }} />
              : t('signIn', lang)
            }
          </button>

        </form>

      </div>
    </div>
  );
}
