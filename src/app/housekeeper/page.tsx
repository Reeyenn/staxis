'use client';


export const dynamic = 'force-dynamic';
import React, { useState, useEffect, Suspense } from 'react';
import { useLang } from '@/contexts/LanguageContext';
import { t } from '@/lib/translations';
import { BedDouble, AlertCircle, Globe } from 'lucide-react';

// Security audit 2026-06-26 #1: the FCM-era "pick who you are" roster flow is
// retired (it required /api/staff-list to hand out every staff UUID). Each
// staff member now opens their OWN per-staff link straight to /housekeeper/[id].
// This generic page only shows loading / a "use your personal link" message.
type Step = 'loading' | 'error';

export default function HousekeeperPage() {
  return (
    <Suspense fallback={<div style={{ minHeight:'100dvh', display:'flex', alignItems:'center', justifyContent:'center', background:'var(--bg)', color:'var(--text-muted)', fontFamily:'var(--font-sans)' }}>Loading…</div>}>
      <HousekeeperInner />
    </Suspense>
  );
}

function HousekeeperInner() {
  const { lang, setLang } = useLang();

  const [step,       setStep]       = useState<Step>('loading');
  const [errorMsg,   setErrorMsg]   = useState('');

  useEffect(() => {
    // Security audit 2026-06-26 #1: the "pick who you are" roster flow is
    // retired. It required /api/staff-list to hand every scheduled staff UUID
    // to any unauthenticated caller who knew the property id — the root cause
    // of the public staffId-enumeration hole. Each staff member now opens their
    // OWN personal link (with a per-staff token) straight to /housekeeper/[id];
    // this generic /housekeeper page can no longer identify or list anyone
    // without handing out credentials, so it just tells the visitor to use the
    // personal link from their text message.
    setStep('error');
    setErrorMsg(lang === 'es'
      ? 'Abre tu enlace personal del mensaje de texto para ver tus habitaciones. Si no lo tienes, pide a tu gerente que te lo reenvíe.'
      : 'Open your personal link from your text message to see your rooms. If you don\'t have it, ask your manager to resend it.');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);


  return (
    <div style={{
      minHeight: '100dvh', background: 'var(--bg)',
      display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
      padding: '24px', fontFamily: 'var(--font-sans)',
    }}>
      {/* Language toggle - critical for housekeepers */}
      <div style={{ position: 'fixed', top: '16px', right: '16px', zIndex: 50 }}>
        <button
          onClick={() => setLang(lang === 'en' ? 'es' : 'en')}
          style={{
            display: 'flex', alignItems: 'center', gap: '6px',
            background: 'var(--bg-card)', border: '1px solid var(--border)',
            borderRadius: 'var(--radius-md)', padding: '8px 14px',
            color: 'var(--text-secondary)', fontSize: '14px', fontWeight: 600,
            cursor: 'pointer', fontFamily: 'var(--font-sans)',
            boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
          }}
        >
          <Globe size={14} />
          {lang === 'en' ? 'Español' : 'English'}
        </button>
      </div>

      {/* Logo */}
      <div style={{ marginBottom: '32px', textAlign: 'center' }}>
        <div style={{
          width: '56px', height: '56px', borderRadius: '16px',
          background: 'var(--amber-dim)', border: '1px solid var(--amber-border)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 12px',
        }}>
          <BedDouble size={28} color="var(--amber)" />
        </div>
        <p style={{ fontSize: '11px', fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--text-muted)' }}>
          Staxis
        </p>
      </div>

      {/* Loading */}
      {step === 'loading' && (
        <div style={{ textAlign: 'center' }}>
          <div style={{
            width: '32px', height: '32px', border: '4px solid var(--border)',
            borderTopColor: 'var(--amber)', borderRadius: '50%',
            animation: 'spin 0.8s linear infinite', margin: '0 auto 12px',
          }} />
          <p style={{ color: 'var(--text-muted)', fontSize: '14px' }}>{t('loading', lang)}</p>
          <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
        </div>
      )}

      {/* Select name */}
      {/* Use-your-personal-link (security audit 2026-06-26 #1). The staff
          picker was retired; this generic page just directs the visitor to
          the per-staff link from their SMS. */}
      {step === 'error' && (
        <div style={{
          width: '100%', maxWidth: '360px', textAlign: 'center',
          background: 'var(--bg-card)', border: '1px solid var(--border)',
          borderRadius: 'var(--radius-lg)', padding: '32px 24px',
        }}>
          <AlertCircle size={40} color="var(--red)" style={{ marginBottom: '16px' }} />
          <h2 style={{ fontSize: '18px', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '8px' }}>{t('somethingWentWrong', lang)}</h2>
          <p style={{ fontSize: '13px', color: 'var(--text-secondary)', lineHeight: 1.6 }}>{errorMsg}</p>
        </div>
      )}
    </div>
  );
}
