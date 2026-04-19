'use client';

import React, { useState, useEffect, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { useLang } from '@/contexts/LanguageContext';
import { t } from '@/lib/translations';
import { signInAnonymously } from 'firebase/auth';
import { auth } from '@/lib/firebase';
import { registerForPushNotifications } from '@/lib/notifications';
import { BedDouble, Bell, CheckCircle, AlertCircle, Globe } from 'lucide-react';

interface StaffMember {
  id: string;
  name: string;
  isSenior: boolean;
}

type Step = 'loading' | 'select' | 'requesting' | 'done' | 'denied' | 'error' | 'bad-link';

export default function HousekeeperPage() {
  return (
    <Suspense fallback={<div style={{ minHeight:'100dvh', display:'flex', alignItems:'center', justifyContent:'center', background:'var(--bg)', color:'var(--text-muted)', fontFamily:'var(--font-sans)' }}>Loading…</div>}>
      <HousekeeperInner />
    </Suspense>
  );
}

function HousekeeperInner() {
  const params = useSearchParams();
  const uid = params.get('uid');
  const pid = params.get('pid');
  const { lang, setLang } = useLang();

  const [staff,      setStaff]      = useState<StaffMember[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [step,       setStep]       = useState<Step>('loading');
  const [errorMsg,   setErrorMsg]   = useState('');

  useEffect(() => {
    if (!uid || !pid) { setStep('bad-link'); return; }

    // Sign in anonymously so Firestore security rules allow room reads/updates.
    // Housekeepers don't have Google accounts - anonymous auth gives them a
    // real Firebase auth token without requiring any login UI.
    signInAnonymously(auth).catch(() => {
      // Non-fatal - staff-list API route uses firebase-admin (bypasses rules)
      // and the [id] page will retry on its own useEffect.
    });

    fetch(`/api/staff-list?uid=${uid}&pid=${pid}`)
      .then(r => r.json())
      .then(data => {
        if (!Array.isArray(data) || data.length === 0) {
          setStep('error');
          setErrorMsg(lang === 'es'
            ? 'No hay personal programado hoy. Pide a tu gerente que te agregue al horario de hoy.'
            : 'No staff scheduled today. Ask your manager to add you to today\'s schedule.');
        } else {
          setStaff(data);
          setStep('select');
        }
      })
      .catch(() => {
        setStep('error');
        setErrorMsg(lang === 'es'
          ? 'No se pudo cargar la lista. Verifica tu conexión e intenta de nuevo.'
          : 'Could not load staff list. Check your connection and try again.');
      });
  }, [uid, pid]);

  const handleSetup = async () => {
    if (!uid || !pid || !selectedId) return;
    setStep('requesting');

    const token = await registerForPushNotifications();

    if (!token) {
      const permission = typeof Notification !== 'undefined' ? Notification.permission : 'default';
      if (permission === 'denied') {
        setStep('denied');
      } else {
        setStep('error');
        setErrorMsg(lang === 'es'
          ? 'No se pudieron activar las notificaciones. En iPhone, primero agrega esta página a tu Pantalla de Inicio y luego ábrela desde allí.'
          : 'Could not enable notifications. On iPhone, you must add this page to your Home Screen first, then open it from there.');
      }
      return;
    }

    // Save token via API
    try {
      await fetch('/api/save-fcm-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uid, pid, staffId: selectedId, token }),
      });
      setStep('done');
    } catch {
      setStep('error');
      setErrorMsg(lang === 'es'
        ? 'Registrado pero no se pudo guardar. Verifica tu conexión.'
        : 'Registered but could not save. Check your connection.');
    }
  };

  const selectedName = staff.find(s => s.id === selectedId)?.name ?? '';

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
        <p style={{ color: 'var(--text-muted)', fontSize: '14px' }}>{t('loading', lang)}</p>
      )}

      {/* Bad link */}
      {step === 'bad-link' && (
        <div style={{ textAlign: 'center', maxWidth: '320px' }}>
          <AlertCircle size={40} color="#EF4444" style={{ marginBottom: '12px' }} />
          <p style={{ color: 'var(--text-secondary)', fontSize: '14px', lineHeight: 1.6 }}>
            {t('badLink', lang)}
          </p>
        </div>
      )}

      {/* Select name */}
      {step === 'select' && (
        <div style={{
          width: '100%', maxWidth: '360px',
          background: 'var(--bg-card)', border: '1px solid var(--border)',
          borderRadius: 'var(--radius-lg)', padding: '24px',
        }}>
          <h1 style={{ fontSize: '22px', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '6px', letterSpacing: '-0.02em' }}>
            {t('setupNotifications', lang)}
          </h1>
          <p style={{ fontSize: '13px', color: 'var(--text-secondary)', marginBottom: '24px', lineHeight: 1.6 }}>
            {t('selectNameDesc', lang)}
          </p>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '20px' }}>
            {staff.map(member => (
              <button key={member.id} onClick={() => setSelectedId(member.id)} style={{
                padding: '14px 16px',
                background: selectedId === member.id ? 'var(--amber-dim)' : 'var(--bg)',
                border: `1.5px solid ${selectedId === member.id ? 'var(--amber-border)' : 'var(--border)'}`,
                borderRadius: 'var(--radius-md)', textAlign: 'left', cursor: 'pointer',
                transition: 'all 120ms', fontFamily: 'var(--font-sans)',
              }}>
                <span style={{ fontSize: '15px', fontWeight: 600, color: selectedId === member.id ? 'var(--amber)' : 'var(--text-primary)' }}>
                  {member.name}{member.isSenior ? ' ⭐' : ''}
                </span>
              </button>
            ))}
          </div>

          <button onClick={handleSetup} disabled={!selectedId} style={{
            width: '100%', height: '48px',
            background: selectedId ? 'var(--navy-light)' : 'var(--border)',
            color: selectedId ? '#FFFFFF' : 'var(--text-muted)',
            border: 'none', borderRadius: 'var(--radius-md)',
            fontFamily: 'var(--font-sans)', fontWeight: 600, fontSize: '15px',
            cursor: selectedId ? 'pointer' : 'not-allowed',
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
            transition: 'all 120ms',
          }}>
            <Bell size={18} /> {t('enableNotifications', lang)}
          </button>
        </div>
      )}

      {/* Requesting */}
      {step === 'requesting' && (
        <div style={{ textAlign: 'center' }}>
          <p style={{ fontSize: '15px', color: 'var(--text-secondary)' }}>{t('settingUp', lang)}</p>
          <p style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '6px' }}>{t('tapAllow', lang)}</p>
        </div>
      )}

      {/* Done */}
      {step === 'done' && (
        <div style={{
          width: '100%', maxWidth: '360px', textAlign: 'center',
          background: 'var(--bg-card)', border: '1px solid var(--border)',
          borderRadius: 'var(--radius-lg)', padding: '32px 24px',
        }}>
          <div style={{
            width: '60px', height: '60px', borderRadius: '50%',
            background: 'var(--green-dim)', border: '1px solid rgba(34,197,94,0.3)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px',
          }}>
            <CheckCircle size={30} color="var(--green)" />
          </div>
          <h2 style={{ fontSize: '20px', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '8px' }}>
            {lang === 'en'
              ? `You're all set, ${selectedName.split(' ')[0]}!`
              : `¡Todo listo, ${selectedName.split(' ')[0]}!`}
          </h2>
          <p style={{ fontSize: '13px', color: 'var(--text-secondary)', lineHeight: 1.6 }}>
            {t('notifDoneDesc', lang)}
          </p>
          <p style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '16px' }}>{t('closeThisPage', lang)}</p>
        </div>
      )}

      {/* Denied */}
      {step === 'denied' && (
        <div style={{
          width: '100%', maxWidth: '360px', textAlign: 'center',
          background: 'var(--bg-card)', border: '1px solid var(--border)',
          borderRadius: 'var(--radius-lg)', padding: '32px 24px',
        }}>
          <AlertCircle size={40} color="var(--amber)" style={{ marginBottom: '16px' }} />
          <h2 style={{ fontSize: '18px', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '8px' }}>{t('notificationsBlocked', lang)}</h2>
          <p style={{ fontSize: '13px', color: 'var(--text-secondary)', lineHeight: 1.6 }}>
            {t('goToBrowserSettings', lang)}
          </p>
          <button onClick={() => setStep('select')} style={{
            marginTop: '20px', padding: '10px 24px',
            background: 'var(--navy-light)', color: '#FFFFFF', border: 'none',
            borderRadius: 'var(--radius-md)', fontFamily: 'var(--font-sans)', fontWeight: 600, cursor: 'pointer',
          }}>{t('tryAgain', lang)}</button>
        </div>
      )}

      {/* Error */}
      {step === 'error' && (
        <div style={{
          width: '100%', maxWidth: '360px', textAlign: 'center',
          background: 'var(--bg-card)', border: '1px solid var(--border)',
          borderRadius: 'var(--radius-lg)', padding: '32px 24px',
        }}>
          <AlertCircle size={40} color="#EF4444" style={{ marginBottom: '16px' }} />
          <h2 style={{ fontSize: '18px', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '8px' }}>{t('somethingWentWrong', lang)}</h2>
          <p style={{ fontSize: '13px', color: 'var(--text-secondary)', lineHeight: 1.6 }}>{errorMsg}</p>
          <button onClick={() => { setStep('loading'); }} style={{
            marginTop: '20px', padding: '10px 24px',
            background: 'var(--navy-light)', color: '#FFFFFF', border: 'none',
            borderRadius: 'var(--radius-md)', fontFamily: 'var(--font-sans)', fontWeight: 600, cursor: 'pointer',
          }}>{t('tryAgain', lang)}</button>
        </div>
      )}
    </div>
  );
}
