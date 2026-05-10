'use client';

// /join — Use a hotel join code to create an account. Owner/GM/admin shared
// the code with this person; they enter it here along with their email,
// name, and password.

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useLang } from '@/contexts/LanguageContext';

export default function JoinPage() {
  const { lang } = useLang();
  const router = useRouter();

  const [code, setCode] = useState('');
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (password.length < 6) { setError(lang === 'es' ? 'La contraseña debe tener al menos 6 caracteres.' : 'Password must be at least 6 characters.'); return; }
    if (password !== confirm) { setError(lang === 'es' ? 'Las contraseñas no coinciden.' : 'Passwords do not match.'); return; }
    setSubmitting(true);
    try {
      const res = await fetch('/api/auth/use-join-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, email, displayName, password }),
      });
      const body = await res.json() as { ok?: boolean; error?: string };
      if (!res.ok || !body.ok) {
        setError(body.error ?? 'Failed to join');
        setSubmitting(false);
        return;
      }
      setDone(true);
    } catch {
      setError(lang === 'es' ? 'Algo salió mal.' : 'Something went wrong.');
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
      <div style={{ width: '100%', maxWidth: '380px' }}>

        <div style={{ marginBottom: '32px', textAlign: 'center' }}>
          <div style={{
            width: '44px', height: '44px', borderRadius: '11px',
            background: 'var(--amber)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            margin: '0 auto 16px',
          }}>
            <span style={{ fontSize: '22px', fontWeight: 700, color: '#FFFFFF', fontFamily: 'var(--font-mono)' }}>S</span>
          </div>
          <h1 style={{ fontFamily: 'var(--font-sans)', fontWeight: 700, fontSize: '22px', color: 'var(--text-primary)', marginBottom: '6px' }}>
            {lang === 'es' ? 'Únete a un hotel' : 'Join a hotel'}
          </h1>
          <p style={{ color: 'var(--text-muted)', fontSize: '13px', lineHeight: 1.5 }}>
            {lang === 'es' ? 'Ingresa el código que te dio el dueño del hotel.' : 'Enter the code your hotel owner gave you.'}
          </p>
        </div>

        {done ? (
          <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', padding: '24px 20px', textAlign: 'center' }}>
            <p style={{ fontSize: '14px', color: 'var(--text-primary)', marginBottom: '12px' }}>
              {lang === 'es' ? 'Cuenta creada.' : 'Account created.'}
            </p>
            <button onClick={() => router.replace('/signin')} style={{
              height: '44px', borderRadius: 'var(--radius-md)',
              background: 'var(--navy-light)', color: '#FFFFFF',
              border: 'none', padding: '0 20px',
              fontFamily: 'var(--font-sans)', fontWeight: 600, fontSize: '14px',
              cursor: 'pointer',
            }}>
              {lang === 'es' ? 'Iniciar sesión' : 'Sign in'}
            </button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <label style={labelStyle}>{lang === 'es' ? 'Código' : 'Code'}</label>
              <input type="text" value={code} onChange={e => { setCode(e.target.value.toUpperCase()); setError(''); }} disabled={submitting} autoFocus placeholder="BEAU-K9F2"
                style={{ ...inputStyle, fontFamily: 'var(--font-mono)', letterSpacing: '0.1em' }} />
            </div>
            <Input label={lang === 'es' ? 'Correo electrónico' : 'Email'} type="email" value={email} onChange={setEmail} disabled={submitting} />
            <Input label={lang === 'es' ? 'Nombre completo' : 'Full name'} value={displayName} onChange={setDisplayName} disabled={submitting} />
            <Input label={lang === 'es' ? 'Contraseña' : 'Password'} type="password" value={password} onChange={setPassword} disabled={submitting} autoComplete="new-password" />
            <Input label={lang === 'es' ? 'Confirmar contraseña' : 'Confirm password'} type="password" value={confirm} onChange={setConfirm} disabled={submitting} autoComplete="new-password" />

            {error && <ErrorMsg>{error}</ErrorMsg>}

            <button type="submit" disabled={submitting || !code || !email || !displayName || !password || !confirm} style={submitStyle(submitting || !code || !email || !displayName || !password || !confirm)}>
              {submitting
                ? <div className="spinner" style={{ width: '18px', height: '18px', borderTopColor: '#FFFFFF', borderColor: 'rgba(255,255,255,0.3)' }} />
                : (lang === 'es' ? 'Crear cuenta' : 'Create account')}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

const labelStyle: React.CSSProperties = { fontSize: '12px', fontWeight: 600, letterSpacing: '0.04em', color: 'var(--text-secondary)', textTransform: 'uppercase', fontFamily: 'var(--font-sans)' };
const inputStyle: React.CSSProperties = { height: '44px', borderRadius: 'var(--radius-md)', background: 'var(--bg-card)', border: '1px solid var(--border)', padding: '0 14px', color: 'var(--text-primary)', fontSize: '15px', fontFamily: 'var(--font-sans)', outline: 'none' };

function Input({ label, type='text', value, onChange, disabled, autoComplete }: { label: string; type?: string; value: string; onChange: (v: string)=>void; disabled?: boolean; autoComplete?: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
      <label style={labelStyle}>{label}</label>
      <input type={type} value={value} onChange={e => onChange(e.target.value)} disabled={disabled} autoComplete={autoComplete}
        style={{ ...inputStyle, opacity: disabled ? 0.6 : 1 }} />
    </div>
  );
}

function ErrorMsg({ children }: { children: React.ReactNode }) {
  return <p style={{ fontSize: '13px', color: 'var(--red)', background: 'var(--red-dim)', border: '1px solid var(--red-border, rgba(239,68,68,0.2))', borderRadius: 'var(--radius-sm)', padding: '10px 12px', margin: 0 }}>{children}</p>;
}

function submitStyle(disabled: boolean): React.CSSProperties {
  return {
    width: '100%', height: '48px', marginTop: '4px',
    borderRadius: 'var(--radius-md)',
    background: disabled ? 'rgba(37,99,235,0.4)' : 'var(--navy-light)',
    color: '#FFFFFF', fontFamily: 'var(--font-sans)', fontWeight: 600, fontSize: '15px',
    border: 'none', cursor: disabled ? 'not-allowed' : 'pointer',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  };
}
