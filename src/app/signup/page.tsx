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
import AuthShell, { AuthLabel, AuthError, authBackLinkStyle, authLabelStyle } from '@/components/AuthShell';

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
    // Phone is required for staff signups — the hotel texts staff their
    // schedules, so a signup with no reachable number is useless. Require a
    // non-empty value with at least 7 digits (the server normalizes any
    // formatting like "(555) 123-4567" down to digits).
    if (phone.replace(/\D/g, '').length < 7) {
      setError(lang === 'es'
        ? 'Ingresa un número de teléfono válido — el hotel te enviará tu horario por mensaje.'
        : 'Enter a valid phone number — the hotel texts you your schedule.');
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
          language: lang,
        }),
      });
      const body = await res.json() as {
        ok?: boolean;
        error?: string;
        data?: { email?: string; twoFactorEnabled?: boolean; pendingApproval?: boolean };
      };
      if (!res.ok || !body.ok) {
        setError(body.error ?? (lang === 'es' ? 'No se pudo crear la cuenta.' : 'Failed to create account.'));
        setSubmitting(false);
        return;
      }

      const normalizedEmail = email.trim().toLowerCase();

      // Global human-2FA switch: when the server says it's OFF, the account
      // was created ready to sign in (email already confirmed), so sign in
      // with the password the user just typed and go straight to the app —
      // no code email, no verify screen. Fail-safe: ONLY an explicit
      // `false` takes this path; a missing/odd value or a failed password
      // sign-in falls through to the normal OTP flow below.
      if (body.data?.twoFactorEnabled === false) {
        try {
          const { data: signInData, error: signInErr } = await supabase.auth.signInWithPassword({
            email: normalizedEmail,
            password,
          });
          if (!signInErr && signInData.session) {
            router.replace('/property-selector');
            return;
          }
          console.warn('post-signup signInWithPassword failed — falling back to OTP flow', signInErr);
        } catch (signInErr) {
          console.warn('post-signup signInWithPassword threw — falling back to OTP flow', signInErr);
        }
      }

      // 2FA on (or the fast path above failed): send the OTP and bounce
      // to /signin/verify with postSignup=1 so the verify page auto-trusts
      // this browser (no extra checkbox needed — Reeyen wants the device
      // remembered automatically right after signup).
      let otpDeliveryFailed = false;
      try {
        const { error: otpErr } = await supabase.auth.signInWithOtp({
          email: normalizedEmail,
          options: { shouldCreateUser: false },
        });
        if (otpErr) {
          otpDeliveryFailed = true;
          console.warn('signInWithOtp after signup failed', otpErr);
        }
      } catch (otpErr) {
        otpDeliveryFailed = true;
        console.warn('signInWithOtp after signup failed', otpErr);
      }
      // The account already exists at this point, so re-submitting the signup
      // form is not a safe recovery. Move to the verification screen, but make
      // an initial delivery failure explicit there and offer a checked resend
      // action instead of falsely claiming that a code was sent.
      router.replace(`/signin/verify?email=${encodeURIComponent(normalizedEmail)}&postSignup=1${
        otpDeliveryFailed ? '&delivery=failed' : ''
      }`);
    } catch {
      setError(lang === 'es' ? 'Algo salió mal.' : 'Something went wrong.');
      setSubmitting(false);
    }
  };

  const canSubmit = code.trim().length > 0
    && email.trim().length > 0
    && displayName.trim().length > 0
    && phone.replace(/\D/g, '').length >= 7
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
          <AuthLabel htmlFor="signup-hotel-code">{lang === 'es' ? 'Código del hotel' : 'Hotel code'}</AuthLabel>
          <input
            id="signup-hotel-code"
            name="hotel-code"
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

        <Input id="signup-display-name" label={lang === 'es' ? 'Nombre completo' : 'Full name'} value={displayName} onChange={setDisplayName} disabled={submitting} autoFocus={!!codeFromUrl} />
        <Input id="signup-email" label={lang === 'es' ? 'Correo electrónico' : 'Email'} type="email" value={email} onChange={setEmail} disabled={submitting} autoComplete="email" placeholder="you@hotel.com" />
        <Input id="signup-phone" label={lang === 'es' ? 'Teléfono' : 'Phone'} type="tel" value={phone} onChange={setPhone} disabled={submitting} autoComplete="tel" placeholder="(555) 123-4567" />

        <fieldset style={{ display: 'flex', flexDirection: 'column', gap: 6, margin: 0, padding: 0, border: 0 }}>
          <legend style={{ ...authLabelStyle, padding: 0, marginBottom: 6 }}>
            {lang === 'es' ? 'Departamento' : 'Department'}
          </legend>
          <div role="radiogroup" style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {(['front_desk', 'housekeeping', 'maintenance'] as SignupRole[]).map(r => {
              const active = role === r;
              return (
                <button
                  type="button"
                  key={r}
                  role="radio"
                  aria-checked={active}
                  onClick={() => setRole(r)}
                  disabled={submitting}
                  style={{
                    flex: '1 1 100px', minWidth: 100, minHeight: 44,
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
        </fieldset>

        <Input id="signup-password" label={lang === 'es' ? 'Contraseña' : 'Password'} type="password" value={password} onChange={setPassword} disabled={submitting} autoComplete="new-password" placeholder="••••••••" />
        <Input id="signup-password-confirm" label={lang === 'es' ? 'Confirmar contraseña' : 'Confirm password'} type="password" value={confirm} onChange={setConfirm} disabled={submitting} autoComplete="new-password" placeholder="••••••••" />

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

function Input({ id, label, type = 'text', value, onChange, disabled, autoComplete, autoFocus, placeholder }: {
  id: string; label: string; type?: string; value: string; onChange: (v: string) => void;
  disabled?: boolean; autoComplete?: string; autoFocus?: boolean; placeholder?: string;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <AuthLabel htmlFor={id}>{label}</AuthLabel>
      <input
        id={id}
        name={id}
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
