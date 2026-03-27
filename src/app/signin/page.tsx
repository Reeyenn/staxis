'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';

export default function SignInPage() {
  const { user, loading, signIn } = useAuth();
  const router = useRouter();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [signing, setSigning] = useState(false);

  useEffect(() => {
    if (!loading && user) router.replace('/');
  }, [user, loading, router]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password) return;

    setSigning(true);
    setError('');

    const err = await signIn(username.trim(), password);
    if (err) {
      setError(err);
      setSigning(false);
    }
    // On success, onAuthStateChanged → redirect via useEffect above
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
            <span style={{ fontSize: '22px', fontWeight: 700, color: '#0A0A0A', fontFamily: 'var(--font-mono)' }}>H</span>
          </div>
          <h1 style={{
            fontFamily: 'var(--font-sans)', fontWeight: 700,
            fontSize: '26px', letterSpacing: '-0.02em',
            color: 'var(--text-primary)', marginBottom: '6px',
          }}>
            HotelOps <span style={{ color: 'var(--amber)' }}>AI</span>
          </h1>
          <p style={{ color: 'var(--text-muted)', fontSize: '14px' }}>Sign in to your account</p>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <label style={{
              fontSize: '12px', fontWeight: 600, letterSpacing: '0.04em',
              color: 'var(--text-secondary)', textTransform: 'uppercase',
              fontFamily: 'var(--font-sans)',
            }}>
              Username
            </label>
            <input
              type="text"
              value={username}
              onChange={e => setUsername(e.target.value)}
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
              onFocus={e => { e.currentTarget.style.borderColor = 'var(--amber-border)'; }}
              onBlur={e => { e.currentTarget.style.borderColor = 'var(--border)'; }}
            />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <label style={{
              fontSize: '12px', fontWeight: 600, letterSpacing: '0.04em',
              color: 'var(--text-secondary)', textTransform: 'uppercase',
              fontFamily: 'var(--font-sans)',
            }}>
              Password
            </label>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
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
              onFocus={e => { e.currentTarget.style.borderColor = 'var(--amber-border)'; }}
              onBlur={e => { e.currentTarget.style.borderColor = 'var(--border)'; }}
            />
          </div>

          {error && (
            <p style={{
              fontSize: '13px', color: 'var(--red)',
              background: 'rgba(239,68,68,0.08)',
              border: '1px solid rgba(239,68,68,0.2)',
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
                ? 'rgba(212,144,64,0.4)'
                : 'var(--amber)',
              color: '#0A0A0A',
              fontFamily: 'var(--font-sans)', fontWeight: 600, fontSize: '15px',
              border: 'none',
              cursor: (signing || !username.trim() || !password) ? 'not-allowed' : 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              transition: 'all 120ms',
            }}
          >
            {signing
              ? <div className="spinner" style={{ width: '18px', height: '18px', borderTopColor: '#0A0A0A', borderColor: 'rgba(0,0,0,0.2)' }} />
              : 'Sign in'
            }
          </button>

        </form>

      </div>
    </div>
  );
}
