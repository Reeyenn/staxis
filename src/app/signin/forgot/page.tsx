'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabase';
import { useLang } from '@/contexts/LanguageContext';

export default function ForgotPasswordPage() {
  const { lang } = useLang();
  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;
    setSubmitting(true);
    setError('');
    try {
      const redirectTo = `${window.location.origin}/signin/reset`;
      await supabase.auth.resetPasswordForEmail(email.trim().toLowerCase(), { redirectTo });
      setSent(true);
    } catch (err) {
      console.error('resetPasswordForEmail failed', err);
      setError(lang === 'es' ? 'Algo salió mal. Intenta de nuevo.' : 'Something went wrong. Try again.');
    } finally {
      setSubmitting(false);
    }
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
            {lang === 'es' ? 'Restablecer contraseña' : 'Reset password'}
          </h1>
          <p style={{ color: 'var(--text-muted)', fontSize: '14px', lineHeight: 1.5 }}>
            {lang === 'es'
              ? 'Ingresa tu correo y te enviaremos un enlace para restablecer tu contraseña.'
              : 'Enter your email and we’ll send a link to reset your password.'}
          </p>
        </div>

        {sent ? (
          <div style={{
            background: 'var(--bg-card)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-lg)',
            padding: '24px 20px',
            textAlign: 'center',
          }}>
            <p style={{ fontSize: '14px', color: 'var(--text-primary)', marginBottom: '12px', lineHeight: 1.5 }}>
              {lang === 'es'
                ? 'Si existe una cuenta para ese correo, recibirás un enlace para restablecer tu contraseña en breve.'
                : 'If an account exists for that email, you’ll receive a password-reset link shortly.'}
            </p>
            <p style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
              {lang === 'es' ? 'Revisa tu bandeja de entrada (y spam).' : 'Check your inbox (and spam).'}
            </p>
            <Link
              href="/signin"
              style={{
                display: 'inline-block', marginTop: '20px',
                fontSize: '13px', color: 'var(--navy-light)',
                textDecoration: 'none', fontFamily: 'var(--font-sans)',
              }}
            >
              {lang === 'es' ? '← Volver al inicio de sesión' : '← Back to sign in'}
            </Link>
          </div>
        ) : (
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
              disabled={submitting || !email.trim()}
              style={{
                width: '100%', height: '48px', marginTop: '4px',
                borderRadius: 'var(--radius-md)',
                background: (submitting || !email.trim())
                  ? 'rgba(37,99,235,0.4)'
                  : 'var(--navy-light)',
                color: '#FFFFFF',
                fontFamily: 'var(--font-sans)', fontWeight: 600, fontSize: '15px',
                border: 'none',
                cursor: (submitting || !email.trim()) ? 'not-allowed' : 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}
            >
              {submitting
                ? <div className="spinner" style={{ width: '18px', height: '18px', borderTopColor: '#FFFFFF', borderColor: 'rgba(255,255,255,0.3)' }} />
                : (lang === 'es' ? 'Enviar enlace' : 'Send reset link')
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
        )}
      </div>
    </div>
  );
}
