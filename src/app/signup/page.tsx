'use client';


export const dynamic = 'force-dynamic';
// /signup — Public signup with a hotel join code.
//
// Owner gives the staff member a code (Settings → Account & Team →
// Generate code). Staff member opens /signup, types the code, their
// info, picks their role (front_desk / housekeeping / maintenance),
// and is created on the owner's hotel.
//
// Owner / general_manager accounts cannot be created here — those go
// through the email-invite flow where the inviter explicitly picks the
// role. See /api/auth/use-join-code for the server-side enforcement.

import React, { Suspense, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useLang } from '@/contexts/LanguageContext';
import { roleLabel } from '@/lib/roles';
import { supabase } from '@/lib/supabase';
import AuthShell, { AuthLabel, AuthError, authBackLinkStyle } from '@/components/AuthShell';

type SignupRole = 'front_desk' | 'housekeeping' | 'maintenance';

function SignupInner() {
  const { lang } = useLang();
  const router = useRouter();
  const params = useSearchParams();
  const codeFromUrl = params.get('code') ?? '';

  const [code, setCode] = useState(codeFromUrl.toUpperCase());
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [role, setRole] = useState<SignupRole>('housekeeping');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: React.FormEvent) => {
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
    try {
      const res = await fetch('/api/auth/use-join-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: code.trim(),
          email: email.trim(),
          displayName: displayName.trim(),
          password,
          role,
          phone: phone.trim() || null,
        }),
      });
      const body = await res.json() as { ok?: boolean; error?: string };
      if (!res.ok || !body.ok) {
        setError(body.error ?? (lang === 'es' ? 'No se pudo crear la cuenta.' : 'Failed to create account.'));
        setSubmitting(false);
        return;
      }

      // Account created but email is unverified. Send the OTP and bounce
      // to /signin/verify with postSignup=1 so the verify page auto-trusts
      // this browser (no extra checkbox needed — Reeyen wants the device
      // remembered automatically right after signup).
      const normalizedEmail = email.trim().toLowerCase();
      try {
        await supabase.auth.signInWithOtp({
          email: normalizedEmail,
          options: { shouldCreateUser: false },
        });
      } catch (otpErr) {
        // Non-fatal — the account exists, they can still hit /signin and
        // go through the normal OTP path. Just log and proceed.
        console.warn('signInWithOtp after signup failed', otpErr);
      }
      router.replace(`/signin/verify?email=${encodeURIComponent(normalizedEmail)}&postSignup=1`);
    } catch {
      setError(lang === 'es' ? 'Algo salió mal.' : 'Something went wrong.');
      setSubmitting(false);
    }
  };

  const canSubmit = code.trim().length > 0
    && email.trim().length > 0
    && displayName.trim().length > 0
    && password.length >= 6
    && confirm.length >= 6
    && !submitting;

  return (
    <AuthShell maxWidth={420} subtitle={
      lang === 'es'
        ? 'Usa el código que te dio el dueño del hotel.'
        : 'Use the code your hotel owner gave you.'
    }>

      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <AuthLabel>{lang === 'es' ? 'Código del hotel' : 'Hotel code'}</AuthLabel>
          <input
            className="si-input"
            type="text"
            value={code}
            onChange={e => { setCode(e.target.value.toUpperCase()); setError(''); }}
            disabled={submitting}
            autoFocus={!codeFromUrl}
            placeholder="BEAU-K9F2"
            style={{ fontFamily: 'var(--font-geist-mono), monospace', letterSpacing: '0.1em' }}
          />
        </div>

        <Input label={lang === 'es' ? 'Nombre completo' : 'Full name'} value={displayName} onChange={setDisplayName} disabled={submitting} autoFocus={!!codeFromUrl} />
        <Input label={lang === 'es' ? 'Correo electrónico' : 'Email'} type="email" value={email} onChange={setEmail} disabled={submitting} autoComplete="email" placeholder="you@hotel.com" />
        <Input label={lang === 'es' ? 'Teléfono' : 'Phone'} type="tel" value={phone} onChange={setPhone} disabled={submitting} autoComplete="tel" placeholder="(555) 123-4567" />

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <AuthLabel>{lang === 'es' ? 'Tu rol' : 'Your role'}</AuthLabel>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {(['front_desk', 'housekeeping', 'maintenance'] as SignupRole[]).map(r => {
              const active = role === r;
              return (
                <button
                  type="button"
                  key={r}
                  onClick={() => setRole(r)}
                  disabled={submitting}
                  style={{
                    flex: '1 1 100px', minWidth: 100, height: 42,
                    borderRadius: 12,
                    background: active ? 'rgba(201,150,68,0.16)' : 'rgba(255,255,255,0.7)',
                    border: `1px solid ${active ? '#C99644' : 'rgba(31,35,28,0.1)'}`,
                    color: active ? '#8C6A33' : '#5C625C',
                    fontSize: 13, fontWeight: active ? 600 : 500,
                    cursor: submitting ? 'not-allowed' : 'pointer',
                    fontFamily: 'inherit',
                    transition: 'background .15s, border-color .15s, color .15s',
                  }}
                >
                  {roleLabel(r)}
                </button>
              );
            })}
          </div>
        </div>

        <Input label={lang === 'es' ? 'Contraseña' : 'Password'} type="password" value={password} onChange={setPassword} disabled={submitting} autoComplete="new-password" placeholder="••••••••" />
        <Input label={lang === 'es' ? 'Confirmar contraseña' : 'Confirm password'} type="password" value={confirm} onChange={setConfirm} disabled={submitting} autoComplete="new-password" placeholder="••••••••" />

        {error && <AuthError>{error}</AuthError>}

        <button
          type="submit"
          disabled={!canSubmit}
          className={`si-btn ${!canSubmit ? 'si-btn-off' : 'si-btn-on'}`}
          style={{ marginTop: 4 }}
        >
          {submitting
            ? <div className="spinner" style={{ width: 18, height: 18, borderTopColor: '#FFFFFF', borderColor: 'rgba(255,255,255,0.3)' }} />
            : (lang === 'es' ? 'Crear cuenta' : 'Create account')}
        </button>

        <Link href="/signin" style={authBackLinkStyle}>
          {lang === 'es' ? '← Ya tengo una cuenta' : '← I already have an account'}
        </Link>
      </form>
    </AuthShell>
  );
}

export default function SignupPage() {
  return (
    <Suspense fallback={null}>
      <SignupInner />
    </Suspense>
  );
}

function Input({ label, type = 'text', value, onChange, disabled, autoComplete, autoFocus, placeholder }: {
  label: string; type?: string; value: string; onChange: (v: string) => void;
  disabled?: boolean; autoComplete?: string; autoFocus?: boolean; placeholder?: string;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <AuthLabel>{label}</AuthLabel>
      <input
        className="si-input"
        type={type}
        value={value}
        onChange={e => onChange(e.target.value)}
        disabled={disabled}
        autoComplete={autoComplete}
        autoFocus={autoFocus}
        placeholder={placeholder}
      />
    </div>
  );
}
