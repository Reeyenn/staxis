'use client';


export const dynamic = 'force-dynamic';
import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { supabase } from '@/lib/supabase';
import { useLang } from '@/contexts/LanguageContext';
import AuthShell, { AuthLabel, AuthError, AuthPanel, AUTH_LINK } from '@/components/AuthShell';

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
      // F-02: revoke trusted-device cookie + DB row BEFORE the sign-out.
      // Password reset is the canonical recovery flow for a compromised
      // credential — without this, a stolen cookie outlives the password
      // rotation and the attacker can still skip OTP on next sign-in.
      // Best-effort with 2s abort: a slow network never blocks the
      // reset → signin redirect.
      try {
        const { data: { session } } = await supabase.auth.getSession();
        const accessToken = session?.access_token;
        if (accessToken) {
          const controller = new AbortController();
          const tid = setTimeout(() => controller.abort(), 2000);
          try {
            await fetch('/api/auth/revoke-trust', {
              method: 'POST',
              credentials: 'include',
              signal: controller.signal,
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${accessToken}`,
              },
              body: JSON.stringify({ source: 'password_reset' }),
            });
          } catch {
            // network / abort — proceed with sign-out regardless
          } finally {
            clearTimeout(tid);
          }
        }
      } catch {
        // getSession failure — proceed with sign-out
      }
      await supabase.auth.signOut();
      router.replace('/signin');
    }, 1500);
  };

  const disabled = submitting || !password || !confirm;

  return (
    <AuthShell subtitle={lang === 'es' ? 'Elige una nueva contraseña' : 'Choose a new password'}>

      {hasRecovery === false ? (
        <AuthPanel>
          <p style={{ fontSize: 14, color: '#1F231C', lineHeight: 1.5, marginBottom: 16 }}>
            {lang === 'es'
              ? 'Este enlace no es válido o ha expirado. Solicita uno nuevo.'
              : 'This link is invalid or has expired. Request a new one.'}
          </p>
          <Link href="/signin/forgot" style={{ fontSize: 14, color: AUTH_LINK, textDecoration: 'none', fontWeight: 600 }}>
            {lang === 'es' ? 'Pedir un nuevo enlace' : 'Request a new link'}
          </Link>
        </AuthPanel>
      ) : done ? (
        <AuthPanel>
          <p style={{ fontSize: 14, color: '#1F231C' }}>
            {lang === 'es' ? 'Contraseña actualizada. Redirigiendo…' : 'Password updated. Redirecting…'}
          </p>
        </AuthPanel>
      ) : (
        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

          <div className="si-rise si-d-2" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <AuthLabel>{lang === 'es' ? 'Nueva contraseña' : 'New password'}</AuthLabel>
            <input
              className="si-input"
              type="password"
              value={password}
              onChange={e => { setPassword(e.target.value); setError(''); }}
              autoComplete="new-password"
              disabled={submitting}
              placeholder="••••••••"
            />
          </div>

          <div className="si-rise si-d-2" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <AuthLabel>{lang === 'es' ? 'Confirmar contraseña' : 'Confirm password'}</AuthLabel>
            <input
              className="si-input"
              type="password"
              value={confirm}
              onChange={e => { setConfirm(e.target.value); setError(''); }}
              autoComplete="new-password"
              disabled={submitting}
              placeholder="••••••••"
            />
          </div>

          {error && <AuthError>{error}</AuthError>}

          <button
            type="submit"
            disabled={disabled}
            className={`si-btn si-rise si-d-3 ${disabled ? 'si-btn-off' : 'si-btn-on'}`}
            style={{ marginTop: 4 }}
          >
            {submitting
              ? <div className="spinner" style={{ width: 18, height: 18, borderTopColor: '#FFFFFF', borderColor: 'rgba(255,255,255,0.3)' }} />
              : (lang === 'es' ? 'Guardar contraseña' : 'Save password')
            }
          </button>
        </form>
      )}
    </AuthShell>
  );
}
