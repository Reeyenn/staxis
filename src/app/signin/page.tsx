'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { useLang } from '@/contexts/LanguageContext';
import { t } from '@/lib/translations';

export default function SignInPage() {
  const { user, loading, signIn } = useAuth();
  const { lang } = useLang();
  const router = useRouter();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [signing, setSigning] = useState(false);

  useEffect(() => {
    if (!loading && user) router.replace('/property-selector');
  }, [user, loading, router]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password) return;

    setSigning(true);
    setError('');

    try {
      const err = await signIn(username.trim(), password);
      if (err) {
        setError(err);
        setSigning(false);
      }
      // On success, onAuthStateChanged → redirect via useEffect above
    } catch {
      setError(t('invalidCredentials', lang));
      setSigning(false);
    }
  };

  if (loading) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg)' }}>
        <div className="spinner" style={{ width: '32px', height: '32px' }} />
      </div>
    );
  }

  return (
    <div style={{
      minHeight: '100vh',
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
              {t('username', lang)}
            </label>
            <input
              type="text"
              value={username}
              onChange={e => { setUsername(e.target.value); setError(''); }}
              autoComplete="username"
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
            <label style={{
              fontSize: '12px', fontWeight: 600, letterSpacing: '0.04em',
              color: 'var(--text-secondary)', textTransform: 'uppercase',
              fontFamily: 'var(--font-sans)',
            }}>
              {t('password', lang)}
            </label>
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
            disabled={signing || !username.trim() || !password}
            style={{
              width: '100%', height: '48px', marginTop: '4px',
              borderRadius: 'var(--radius-md)',
              background: (signing || !username.trim() || !password)
                ? 'rgba(37,99,235,0.4)'
                : 'var(--navy-light)',
              color: '#FFFFFF',
              fontFamily: 'var(--font-sans)', fontWeight: 600, fontSize: '15px',
              border: 'none',
              cursor: (signing || !username.trim() || !password) ? 'not-allowed' : 'pointer',
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
