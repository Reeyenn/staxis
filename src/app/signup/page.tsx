'use client';

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
  const [done, setDone] = useState(false);

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
      setDone(true);
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
    <div style={{
      minHeight: '100dvh',
      background: 'var(--bg)',
      display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
      padding: '32px 24px',
    }}>
      <div style={{ width: '100%', maxWidth: '380px' }}>

        <div style={{ marginBottom: '24px', textAlign: 'center' }}>
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
            fontSize: '22px', color: 'var(--text-primary)',
            marginBottom: '6px',
          }}>
            {lang === 'es' ? 'Crear cuenta' : 'Create account'}
          </h1>
          <p style={{ color: 'var(--text-muted)', fontSize: '13px', lineHeight: 1.5 }}>
            {lang === 'es'
              ? 'Usa el código que te dio el dueño del hotel.'
              : 'Use the code your hotel owner gave you.'}
          </p>
        </div>

        {done ? (
          <div style={{
            background: 'var(--bg-card)', border: '1px solid var(--border)',
            borderRadius: 'var(--radius-lg)', padding: '24px 20px', textAlign: 'center',
          }}>
            <p style={{ fontSize: '14px', color: 'var(--text-primary)', marginBottom: '14px' }}>
              {lang === 'es' ? '¡Cuenta creada! Inicia sesión para continuar.' : 'Account created! Sign in to continue.'}
            </p>
            <button onClick={() => router.replace('/signin')} style={primaryBtnStyle(false)}>
              {lang === 'es' ? 'Iniciar sesión' : 'Sign in'}
            </button>
          </div>
        ) : (
          <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <label style={labelStyle}>{lang === 'es' ? 'Código del hotel' : 'Hotel code'}</label>
              <input
                type="text"
                value={code}
                onChange={e => { setCode(e.target.value.toUpperCase()); setError(''); }}
                disabled={submitting}
                autoFocus={!codeFromUrl}
                placeholder="BEAU-K9F2"
                style={{ ...inputStyle, fontFamily: 'var(--font-mono)', letterSpacing: '0.1em' }}
              />
            </div>

            <Input label={lang === 'es' ? 'Nombre completo' : 'Full name'} value={displayName} onChange={setDisplayName} disabled={submitting} autoFocus={!!codeFromUrl} />
            <Input label={lang === 'es' ? 'Correo electrónico' : 'Email'} type="email" value={email} onChange={setEmail} disabled={submitting} autoComplete="email" />
            <Input label={lang === 'es' ? 'Teléfono' : 'Phone'} type="tel" value={phone} onChange={setPhone} disabled={submitting} autoComplete="tel" placeholder="(555) 123-4567" />

            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <label style={labelStyle}>{lang === 'es' ? 'Tu rol' : 'Your role'}</label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                {(['front_desk', 'housekeeping', 'maintenance'] as SignupRole[]).map(r => (
                  <button
                    type="button"
                    key={r}
                    onClick={() => setRole(r)}
                    disabled={submitting}
                    style={{
                      flex: '1 1 100px', minWidth: '100px', height: '38px',
                      borderRadius: 'var(--radius-sm)',
                      background: role === r ? 'var(--amber-dim)' : 'var(--bg-card)',
                      border: `1px solid ${role === r ? 'var(--amber-border)' : 'var(--border)'}`,
                      color: role === r ? 'var(--amber)' : 'var(--text-secondary)',
                      fontSize: '13px', fontWeight: role === r ? 600 : 500,
                      cursor: submitting ? 'not-allowed' : 'pointer',
                      fontFamily: 'var(--font-sans)',
                    }}
                  >
                    {roleLabel(r)}
                  </button>
                ))}
              </div>
            </div>

            <Input label={lang === 'es' ? 'Contraseña' : 'Password'} type="password" value={password} onChange={setPassword} disabled={submitting} autoComplete="new-password" />
            <Input label={lang === 'es' ? 'Confirmar contraseña' : 'Confirm password'} type="password" value={confirm} onChange={setConfirm} disabled={submitting} autoComplete="new-password" />

            {error && <ErrorMsg>{error}</ErrorMsg>}

            <button type="submit" disabled={!canSubmit} style={primaryBtnStyle(!canSubmit)}>
              {submitting
                ? <div className="spinner" style={{ width: '18px', height: '18px', borderTopColor: '#FFFFFF', borderColor: 'rgba(255,255,255,0.3)' }} />
                : (lang === 'es' ? 'Crear cuenta' : 'Create account')}
            </button>

            <Link href="/signin" style={{
              display: 'block', textAlign: 'center', marginTop: '4px',
              fontSize: '13px', color: 'var(--text-muted)',
              textDecoration: 'none', fontFamily: 'var(--font-sans)',
            }}>
              {lang === 'es' ? '← Ya tengo una cuenta' : '← I already have an account'}
            </Link>
          </form>
        )}
      </div>
    </div>
  );
}

export default function SignupPage() {
  return (
    <Suspense fallback={null}>
      <SignupInner />
    </Suspense>
  );
}

const labelStyle: React.CSSProperties = {
  fontSize: '12px', fontWeight: 600,
  letterSpacing: '0.04em', color: 'var(--text-secondary)',
  textTransform: 'uppercase', fontFamily: 'var(--font-sans)',
};
const inputStyle: React.CSSProperties = {
  height: '44px', borderRadius: 'var(--radius-md)',
  background: 'var(--bg-card)', border: '1px solid var(--border)',
  padding: '0 14px', color: 'var(--text-primary)',
  fontSize: '15px', fontFamily: 'var(--font-sans)', outline: 'none',
};

function Input({ label, type='text', value, onChange, disabled, autoComplete, autoFocus, placeholder }: {
  label: string; type?: string; value: string; onChange: (v: string)=>void;
  disabled?: boolean; autoComplete?: string; autoFocus?: boolean; placeholder?: string;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
      <label style={labelStyle}>{label}</label>
      <input
        type={type}
        value={value}
        onChange={e => onChange(e.target.value)}
        disabled={disabled}
        autoComplete={autoComplete}
        autoFocus={autoFocus}
        placeholder={placeholder}
        style={{ ...inputStyle, opacity: disabled ? 0.6 : 1 }}
      />
    </div>
  );
}

function ErrorMsg({ children }: { children: React.ReactNode }) {
  return (
    <p style={{
      fontSize: '13px', color: 'var(--red)',
      background: 'var(--red-dim)',
      border: '1px solid var(--red-border, rgba(239,68,68,0.2))',
      borderRadius: 'var(--radius-sm)', padding: '10px 12px', margin: 0,
    }}>
      {children}
    </p>
  );
}

function primaryBtnStyle(disabled: boolean): React.CSSProperties {
  return {
    width: '100%', height: '48px',
    borderRadius: 'var(--radius-md)',
    background: disabled ? 'rgba(37,99,235,0.4)' : 'var(--navy-light)',
    color: '#FFFFFF',
    fontFamily: 'var(--font-sans)', fontWeight: 600, fontSize: '15px',
    border: 'none', cursor: disabled ? 'not-allowed' : 'pointer',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  };
}
