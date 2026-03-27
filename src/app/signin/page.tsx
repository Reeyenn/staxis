'use client';

import React, { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { useLang } from '@/contexts/LanguageContext';
import { t } from '@/lib/translations';
import { DollarSign, Zap, Clock, Globe } from 'lucide-react';

export default function SignInPage() {
  const { user, loading, signIn } = useAuth();
  const router = useRouter();
  const { lang, setLang } = useLang();
  const [signing, setSigning] = React.useState(false);

  useEffect(() => {
    if (!loading && user) router.replace('/');
  }, [user, loading, router]);

  const handleSignIn = async () => {
    setSigning(true);
    try { await signIn(); }
    catch (err) { console.error(err); }
    finally { setSigning(false); }
  };

  if (loading) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg)' }}>
        <div className="spinner" style={{ width: '32px', height: '32px' }} />
      </div>
    );
  }

  const features = [
    { icon: DollarSign, text: t('signInFeature1', lang), color: 'var(--green)' },
    { icon: Zap,        text: t('signInFeature2', lang), color: 'var(--amber)' },
    { icon: Clock,      text: t('signInFeature3', lang), color: 'var(--text-secondary)' },
  ];

  return (
    <div style={{
      minHeight: '100vh',
      background: 'var(--bg)',
      display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
      padding: '32px 24px',
    }}>
      <div style={{ width: '100%', maxWidth: '380px' }}>

        {/* Language toggle */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '16px' }}>
          <button
            onClick={() => setLang(lang === 'en' ? 'es' : 'en')}
            style={{
              display: 'flex', alignItems: 'center', gap: '6px',
              background: 'var(--bg-card)', border: '1px solid var(--border)',
              borderRadius: 'var(--radius-md)', padding: '7px 12px',
              color: 'var(--text-secondary)', fontSize: '13px', fontWeight: 600,
              cursor: 'pointer', fontFamily: 'var(--font-sans)',
            }}
          >
            <Globe size={13} />
            {lang === 'en' ? 'Español' : 'English'}
          </button>
        </div>

        {/* Logo mark */}
        <div style={{ marginBottom: '40px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '24px' }}>
            <div style={{
              width: '36px', height: '36px', borderRadius: '9px',
              background: 'var(--amber)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <span style={{ fontSize: '18px', fontWeight: 700, color: '#0A0A0A', fontFamily: 'var(--font-mono)' }}>H</span>
            </div>
            <span style={{ fontFamily: 'var(--font-sans)', fontWeight: 600, fontSize: '18px', color: 'var(--text-primary)', letterSpacing: '-0.01em' }}>
              HotelOps <span style={{ color: 'var(--amber)' }}>AI</span>
            </span>
          </div>

          <h1 style={{
            fontFamily: 'var(--font-sans)', fontWeight: 700,
            fontSize: '28px', letterSpacing: '-0.02em',
            color: 'var(--text-primary)', lineHeight: 1.2,
            marginBottom: '8px',
          }}>
            {t('signInHeroTitle', lang)}
          </h1>
          <p style={{ color: 'var(--text-muted)', fontSize: '14px', lineHeight: 1.5 }}>
            {t('signInSubtitle', lang)}
          </p>
        </div>

        {/* Features */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1px', marginBottom: '32px', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', overflow: 'hidden' }}>
          {features.map(({ icon: Icon, text, color }, i) => (
            <div key={i} style={{
              display: 'flex', alignItems: 'center', gap: '12px',
              padding: '14px 16px',
              background: 'var(--bg-card)',
              borderBottom: i < features.length - 1 ? '1px solid var(--border)' : 'none',
            }}>
              <Icon size={15} color={color} strokeWidth={2} style={{ flexShrink: 0 }} />
              <span style={{ fontSize: '13px', color: 'var(--text-secondary)', lineHeight: 1.4 }}>{text}</span>
            </div>
          ))}
        </div>

        {/* Sign in button */}
        <button
          onClick={handleSignIn}
          disabled={signing}
          style={{
            width: '100%', height: '48px',
            borderRadius: 'var(--radius-md)',
            background: signing ? 'rgba(212,144,64,0.5)' : 'var(--amber)',
            color: '#0A0A0A',
            fontFamily: 'var(--font-sans)', fontWeight: 600, fontSize: '15px',
            border: 'none', cursor: signing ? 'wait' : 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '10px',
            transition: 'all 120ms',
            marginBottom: '12px',
          }}
        >
          {signing ? (
            <div className="spinner" style={{ width: '18px', height: '18px', borderTopColor: '#0A0A0A', borderColor: 'rgba(0,0,0,0.2)' }} />
          ) : (
            <>
              <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden>
                <path fill="#FFC107" d="M43.611,20.083H42V20H24v8h11.303c-1.649,4.657-6.08,8-11.303,8c-6.627,0-12-5.373-12-12c0-6.627,5.373-12,12-12c3.059,0,5.842,1.154,7.961,3.039l5.657-5.657C34.046,6.053,29.268,4,24,4C12.955,4,4,12.955,4,24c0,11.045,8.955,20,20,20c11.045,0,20-8.955,20-20C44,22.659,43.862,21.35,43.611,20.083z"/>
                <path fill="#FF3D00" d="M6.306,14.691l6.571,4.819C14.655,15.108,19.003,12,24,12c3.059,0,5.842,1.154,7.961,3.039l5.657-5.657C34.046,6.053,29.268,4,24,4C16.318,4,9.656,8.337,6.306,14.691z"/>
                <path fill="#4CAF50" d="M24,44c5.166,0,9.86-1.977,13.409-5.192l-6.19-5.238C29.211,35.091,26.715,36,24,36c-5.202,0-9.619-3.317-11.283-7.946l-6.522,5.025C9.505,39.556,16.227,44,24,44z"/>
                <path fill="#1976D2" d="M43.611,20.083H42V20H24v8h11.303c-0.792,2.237-2.231,4.166-4.087,5.571l6.19,5.238C36.971,39.205,44,34,44,24C44,22.659,43.862,21.35,43.611,20.083z"/>
              </svg>
              {t('signIn', lang)}
            </>
          )}
        </button>

        <p style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: '11px', letterSpacing: '0.02em' }}>
          {t('signInSecure', lang)}
        </p>

      </div>
    </div>
  );
}
