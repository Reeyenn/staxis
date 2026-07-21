'use client';


export const dynamic = 'force-dynamic';
import React, { useState } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabase';
import { useLang } from '@/contexts/LanguageContext';
import AuthShell, { AuthLabel, AuthError, AuthPanel, authBackLinkStyle, AUTH_LINK } from '@/components/AuthShell';

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
      const { error: resetErr } = await supabase.auth.resetPasswordForEmail(
        email.trim().toLowerCase(),
        { redirectTo },
      );
      // Supabase reports most delivery failures as a resolved `{ error }`, not
      // a thrown promise. Never show the success state unless it confirmed the
      // request was accepted.
      if (resetErr) throw resetErr;
      setSent(true);
    } catch (err) {
      console.error('resetPasswordForEmail failed', err);
      setError(lang === 'es' ? 'Algo salió mal. Intenta de nuevo.' : 'Something went wrong. Try again.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AuthShell subtitle={
      lang === 'es'
        ? 'Ingresa tu correo y te enviaremos un enlace para restablecer tu contraseña.'
        : 'Enter your email and we’ll send a link to reset your password.'
    }>

      {sent ? (
        <AuthPanel>
          <p style={{ fontSize: 14, color: '#1F231C', marginBottom: 12, lineHeight: 1.5 }}>
            {lang === 'es'
              ? 'Si existe una cuenta para ese correo, recibirás un enlace para restablecer tu contraseña en breve.'
              : 'If an account exists for that email, you’ll receive a password-reset link shortly.'}
          </p>
          <p style={{ fontSize: 13, color: '#5C625C' }}>
            {lang === 'es' ? 'Revisa tu bandeja de entrada (y spam).' : 'Check your inbox (and spam).'}
          </p>
          <Link href="/signin" style={{ display: 'inline-block', marginTop: 20, fontSize: 13, color: AUTH_LINK, textDecoration: 'none', fontWeight: 600 }}>
            {lang === 'es' ? '← Volver al inicio de sesión' : '← Back to sign in'}
          </Link>
        </AuthPanel>
      ) : (
        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

          <div className="si-rise si-d-2" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <AuthLabel htmlFor="forgot-email">{lang === 'es' ? 'Correo electrónico' : 'Email'}</AuthLabel>
            <input
              id="forgot-email"
              name="email"
              className="si-input"
              type="email"
              value={email}
              onChange={e => { setEmail(e.target.value); setError(''); }}
              autoComplete="email"
              autoCapitalize="off"
              spellCheck={false}
              disabled={submitting}
              placeholder="you@hotel.com"
            />
          </div>

          {error && <AuthError>{error}</AuthError>}

          <button
            type="submit"
            disabled={submitting || !email.trim()}
            className={`si-btn si-rise si-d-3 ${(submitting || !email.trim()) ? 'si-btn-off' : 'si-btn-on'}`}
            style={{ marginTop: 4 }}
          >
            {submitting
              ? <div className="spinner" style={{ width: 18, height: 18, borderTopColor: '#FFFFFF', borderColor: 'rgba(255,255,255,0.3)' }} />
              : (lang === 'es' ? 'Enviar enlace' : 'Send reset link')
            }
          </button>

          <Link href="/signin" style={authBackLinkStyle}>
            {lang === 'es' ? '← Volver al inicio de sesión' : '← Back to sign in'}
          </Link>
        </form>
      )}
    </AuthShell>
  );
}
