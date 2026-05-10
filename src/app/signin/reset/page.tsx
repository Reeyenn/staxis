'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { supabase } from '@/lib/supabase';
import { useLang } from '@/contexts/LanguageContext';

export default function ResetPasswordPage() {
  const { lang } = useLang();
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [hasRecovery, setHasRecovery] = useState<boolean | null>(null);

  // Supabase's resetPasswordForEmail link redirects here with a hash that the
  // Supabase client auto-parses on load, firing onAuthStateChange with the
  // PASSWORD_RECOVERY event. We listen for that to confirm the user actually
  // followed a real recovery link.
  useEffect(() => {
    const { data: sub } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'PASSWORD_RECOVERY') setHasRecovery(true);
    });

    // If the hash is already gone (e.g. user refreshed), check for an active
    // session instead — Supabase keeps the session after the hash is consumed.
    void supabase.auth.getSession().then(({ data }) => {
      if (data.session) setHasRecovery(true);
      else if (hasRecovery === null) setHasRecovery(false);
    });

    return () => sub.subscription.unsubscribe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (password.length < 6) {
      setError(lang === 'es' ? 'La contraseña debe tener al menos 6 caracteres.' : 'Password must be at least 6 characters.');
      return;
    }
    if (password !== confirm) {
      setError(lang === 'es' ? 'Las contraseñas no coinciden.' : 'Passwords do not match.');
      return;
    }
    setSubmitting(true);
    const { error: updErr } = await supabase.auth.updateUser({ password });
    setSubmitting(false);
    if (updErr) {
      setError(updErr.message);
      return;
    }
    setDone(true);
    // Sign out and bounce back to /signin after a beat so the user has to
    // re-authenticate with the new password.
    setTimeout(async () => {
      await supabase.auth.signOut();
      router.replace('/signin');
    }, 1500);
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
            fontSize: '22px', letterSpacing: '-0.02em',
            color: 'var(--text-primary)', marginBottom: '6px',
          }}>
            {lang === 'es' ? 'Nueva contraseña' : 'Set new password'}
          </h1>
        </div>

        {hasRecovery === false ? (
          <div style={{
            background: 'var(--bg-card)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-lg)',
            padding: '24px 20px', textAlign: 'center',
          }}>
            <p style={{ fontSize: '14px', color: 'var(--text-primary)', lineHeight: 1.5, marginBottom: '16px' }}>
              {lang === 'es'
                ? 'Este enlace no es válido o ha expirado. Solicita uno nuevo.'
                : 'This link is invalid or has expired. Request a new one.'}
            </p>
            <Link
              href="/signin/forgot"
              style={{
                fontSize: '14px', color: 'var(--navy-light)',
                textDecoration: 'none', fontFamily: 'var(--font-sans)',
              }}
            >
              {lang === 'es' ? 'Pedir un nuevo enlace' : 'Request a new link'}
            </Link>
          </div>
        ) : done ? (
          <div style={{
            background: 'var(--bg-card)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-lg)',
            padding: '24px 20px', textAlign: 'center',
          }}>
            <p style={{ fontSize: '14px', color: 'var(--text-primary)' }}>
              {lang === 'es' ? 'Contraseña actualizada. Redirigiendo…' : 'Password updated. Redirecting…'}
            </p>
          </div>
        ) : (
          <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <label style={{
                fontSize: '12px', fontWeight: 600, letterSpacing: '0.04em',
                color: 'var(--text-secondary)', textTransform: 'uppercase',
                fontFamily: 'var(--font-sans)',
              }}>
                {lang === 'es' ? 'Nueva contraseña' : 'New password'}
              </label>
              <input
                type="password"
                value={password}
                onChange={e => { setPassword(e.target.value); setError(''); }}
                autoComplete="new-password"
                disabled={submitting}
                style={{
                  height: '44px', borderRadius: 'var(--radius-md)',
                  background: 'var(--bg-card)', border: '1px solid var(--border)',
                  padding: '0 14px',
                  color: 'var(--text-primary)', fontSize: '15px',
                  fontFamily: 'var(--font-sans)',
                  outline: 'none',
                  opacity: submitting ? 0.6 : 1,
                }}
              />
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <label style={{
                fontSize: '12px', fontWeight: 600, letterSpacing: '0.04em',
                color: 'var(--text-secondary)', textTransform: 'uppercase',
                fontFamily: 'var(--font-sans)',
              }}>
                {lang === 'es' ? 'Confirmar contraseña' : 'Confirm password'}
              </label>
              <input
                type="password"
                value={confirm}
                onChange={e => { setConfirm(e.target.value); setError(''); }}
                autoComplete="new-password"
                disabled={submitting}
                style={{
                  height: '44px', borderRadius: 'var(--radius-md)',
                  background: 'var(--bg-card)', border: '1px solid var(--border)',
                  padding: '0 14px',
                  color: 'var(--text-primary)', fontSize: '15px',
                  fontFamily: 'var(--font-sans)',
                  outline: 'none',
                  opacity: submitting ? 0.6 : 1,
                }}
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
              disabled={submitting || !password || !confirm}
              style={{
                width: '100%', height: '48px', marginTop: '4px',
                borderRadius: 'var(--radius-md)',
                background: (submitting || !password || !confirm)
                  ? 'rgba(37,99,235,0.4)'
                  : 'var(--navy-light)',
                color: '#FFFFFF',
                fontFamily: 'var(--font-sans)', fontWeight: 600, fontSize: '15px',
                border: 'none',
                cursor: (submitting || !password || !confirm) ? 'not-allowed' : 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}
            >
              {submitting
                ? <div className="spinner" style={{ width: '18px', height: '18px', borderTopColor: '#FFFFFF', borderColor: 'rgba(255,255,255,0.3)' }} />
                : (lang === 'es' ? 'Guardar contraseña' : 'Save password')
              }
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
