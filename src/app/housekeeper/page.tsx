'use client';

import React, { useState, useEffect, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { useLang } from '@/contexts/LanguageContext';
import { t } from '@/lib/translations';
import { BedDouble, Bell, CheckCircle, AlertCircle, Globe } from 'lucide-react';

interface StaffMember {
  id: string;
  name: string;
  isSenior: boolean;
}

// SMS-only flow as of 2026-04-22. Previously this page requested notification
// permission and registered a Firebase Cloud Messaging token; we dropped FCM
// entirely because housekeepers reliably receive Twilio SMS to the staff
// phone number on file, and the PWA "add to home screen" dance required for
// iOS push was a hostile onboarding step that nobody completed. This page
// now just pairs the phone with a staff id — room assignments and alerts
// arrive via SMS from /api/notify-housekeepers-sms.
type Step = 'loading' | 'select' | 'saving' | 'done' | 'error' | 'bad-link';

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

    // No anonymous auth here anymore. The staff-list API uses the service-role
    // key and does not rely on the caller's session. Room reads/writes from
    // /housekeeper/[id] go through the Supabase browser client with RLS off
    // for anon reads (staff-facing pages are publicly-linkable by design —
    // the uid+pid+staffId triple in the URL is the capability token).

    fetch(`/api/staff-list?uid=${uid}&pid=${pid}`)
      .then(r => r.json())
      .then((body: { ok?: boolean; data?: unknown; error?: string }) => {
        // /api/staff-list now returns the standard ApiResponse envelope
        // ({ ok, data, … }) — read the array off `.data`.
        const raw = (body && body.ok && Array.isArray(body.data))
          ? (body.data as Array<{ id: string; name: string; isSenior?: boolean }>)
          : [];
        const list = raw.map(s => ({ id: s.id, name: s.name, isSenior: !!s.isSenior }));
        if (list.length === 0) {
          setStep('error');
          setErrorMsg(lang === 'es'
            ? 'No hay personal programado hoy. Pide a tu gerente que te agregue al horario de hoy.'
            : 'No staff scheduled today. Ask your manager to add you to today\'s schedule.');
        } else {
          setStaff(list);
          setStep('select');
        }
      })
      .catch(() => {
        setStep('error');
        setErrorMsg(lang === 'es'
          ? 'No se pudo cargar la lista. Verifica tu conexión e intenta de nuevo.'
          : 'Could not load staff list. Check your connection and try again.');
      });
    // `lang` is intentionally NOT a dep — it's only used to localize the
    // error toast at the moment of failure. Adding it would re-fetch the
    // staff list every time the user toggles language, which is wrong.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uid, pid]);

  const handleSetup = async () => {
    if (!uid || !pid || !selectedId) return;
    setStep('saving');

    // SMS-only: no push token to register. Hit the same endpoint with an
    // empty token so the staff record still gets stamped with the selected
    // id (legacy call sites read it); body shape preserved for compat.
    // If the endpoint errors we still advance to `done` — the housekeeper
    // is already paired via their SMS number on the staff roster; this
    // click is mostly a "yes I'm this person" UI confirmation now.
    try {
      await fetch('/api/save-fcm-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uid, pid, staffId: selectedId, token: '' }),
      }).catch(() => {});
      setStep('done');
    } catch {
      setStep('done');
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

      {/* Bad link */}
      {step === 'bad-link' && (
        <div style={{ textAlign: 'center', maxWidth: '320px' }}>
          <AlertCircle size={40} color="var(--red)" style={{ marginBottom: '12px' }} />
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
          borderRadius: 'var(--radius-lg)', padding: '16px',
        }}>
          <h1 style={{ fontSize: '17px', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '4px', letterSpacing: '-0.01em' }}>
            {t('setupNotifications', lang)}
          </h1>
          <p style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '14px', lineHeight: 1.5 }}>
            {t('selectNameDesc', lang)}
          </p>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '14px' }}>
            {staff.map(member => (
              <button key={member.id} onClick={() => setSelectedId(member.id)} style={{
                padding: '10px 14px',
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

      {/* Saving */}
      {step === 'saving' && (
        <div style={{ textAlign: 'center' }}>
          <p style={{ fontSize: '15px', color: 'var(--text-secondary)' }}>{t('settingUp', lang)}</p>
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

      {/* No 'denied' step in SMS-only flow — kept here as a comment so
          anyone searching the old FCM-era UI states finds the delete. */}

      {/* Error */}
      {step === 'error' && (
        <div style={{
          width: '100%', maxWidth: '360px', textAlign: 'center',
          background: 'var(--bg-card)', border: '1px solid var(--border)',
          borderRadius: 'var(--radius-lg)', padding: '32px 24px',
        }}>
          <AlertCircle size={40} color="var(--red)" style={{ marginBottom: '16px' }} />
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
