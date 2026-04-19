'use client';

import React, { useState, useEffect, Suspense } from 'react';
import { useParams, useSearchParams } from 'next/navigation';

type PageState = 'loading' | 'ready' | 'submitting' | 'confirmed' | 'declined' | 'already' | 'error' | 'not_found';

interface ConfirmData {
  staffName: string;
  shiftDate: string;
  status: string;
  language: 'en' | 'es';
}

const copy = {
  en: {
    loading: 'Loading…',
    shift: 'Your shift',
    isComing: "I'm Coming",
    cantMake: "Can't Make It",
    confirmed: "You're confirmed! See you then.",
    declined: "Got it. We'll find someone else.",
    already: "You've already responded.",
    error: "Something went wrong. Please try again.",
    notFound: "This link isn't valid. Ask your manager to send a new one.",
    submitting: 'Sending…',
    poweredBy: 'Staxis',
  },
  es: {
    loading: 'Cargando…',
    shift: 'Tu turno',
    isComing: 'Voy a ir',
    cantMake: 'No puedo ir',
    confirmed: '¡Confirmado! Hasta pronto.',
    declined: 'Entendido. Buscaremos a alguien más.',
    already: 'Ya respondiste.',
    error: 'Algo salió mal. Intenta de nuevo.',
    notFound: 'Este enlace no es válido. Pide a tu gerente que envíe uno nuevo.',
    submitting: 'Enviando…',
    poweredBy: 'Staxis',
  },
};

function formatDate(dateStr: string, lang: 'en' | 'es'): string {
  const [year, month, day] = dateStr.split('-').map(Number);
  const d = new Date(year, month - 1, day);
  const locale = lang === 'es' ? 'es-US' : 'en-US';
  return d.toLocaleDateString(locale, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });
}

function ConfirmContent() {
  const params = useParams();
  const searchParams = useSearchParams();
  const token = params.token as string;
  const uid = searchParams.get('uid') ?? '';
  const pid = searchParams.get('pid') ?? '';

  const [state, setState] = useState<PageState>('loading');
  const [data, setData] = useState<ConfirmData | null>(null);
  const [lang, setLang] = useState<'en' | 'es'>('en');

  useEffect(() => {
    if (!token || !uid || !pid) {
      setState('error');
      return;
    }
    fetch(`/api/confirmation?token=${encodeURIComponent(token)}&uid=${encodeURIComponent(uid)}&pid=${encodeURIComponent(pid)}`)
      .then(r => r.json())
      .then((d: ConfirmData & { error?: string }) => {
        if (d.error) {
          setState(d.error === 'Confirmation not found' ? 'not_found' : 'error');
          return;
        }
        setData(d);
        setLang(d.language ?? 'en');
        setState(d.status !== 'pending' ? 'already' : 'ready');
      })
      .catch(() => setState('error'));
  }, [token, uid, pid]);

  const respond = async (response: 'confirmed' | 'declined') => {
    setState('submitting');
    try {
      const res = await fetch('/api/confirmation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, uid, pid, response }),
      });
      const result = await res.json() as { ok?: boolean; error?: string };
      if (result.error) throw new Error(result.error);
      setState(response === 'confirmed' ? 'confirmed' : 'declined');
    } catch {
      setState('error');
    }
  };

  const c = copy[lang];

  return (
    <div style={{
      minHeight: '100dvh',
      background: '#FFFFFF',
      color: '#1A1A2E',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '24px',
      position: 'relative',
    }}>

      {/* Language toggle */}
      <div style={{ position: 'absolute', top: '20px', right: '20px', display: 'flex', gap: '4px' }}>
        {(['en', 'es'] as const).map(l => (
          <button
            key={l}
            onClick={() => setLang(l)}
            style={{
              padding: '6px 12px',
              border: `1px solid ${lang === l ? '#1B3A5C' : 'rgba(0,0,0,0.12)'}`,
              background: lang === l ? 'rgba(27,58,92,0.08)' : 'transparent',
              color: lang === l ? '#1B3A5C' : '#9CA3AF',
              borderRadius: '8px',
              fontSize: '12px',
              fontWeight: 600,
              cursor: 'pointer',
              letterSpacing: '0.05em',
            }}
          >
            {l.toUpperCase()}
          </button>
        ))}
      </div>

      <div style={{ width: '100%', maxWidth: '380px', textAlign: 'center' }}>

        {/* Logo */}
        <div style={{
          fontSize: '11px',
          fontWeight: 700,
          letterSpacing: '0.12em',
          textTransform: 'uppercase',
          color: '#1B3A5C',
          marginBottom: '48px',
        }}>
          Staxis
        </div>

        {/* States */}
        {state === 'loading' && (
          <p style={{ color: '#9CA3AF', fontSize: '16px' }}>{c.loading}</p>
        )}

        {state === 'not_found' && (
          <p style={{ color: '#6B7280', fontSize: '17px', lineHeight: 1.5 }}>{c.notFound}</p>
        )}

        {state === 'error' && (
          <p style={{ color: '#DC2626', fontSize: '17px', lineHeight: 1.5 }}>{c.error}</p>
        )}

        {state === 'confirmed' && (
          <>
            <div style={{ fontSize: '60px', marginBottom: '20px', lineHeight: 1 }}>✅</div>
            <p style={{ fontSize: '22px', fontWeight: 600, color: '#16A34A', lineHeight: 1.3 }}>{c.confirmed}</p>
          </>
        )}

        {state === 'declined' && (
          <>
            <div style={{ fontSize: '60px', marginBottom: '20px', lineHeight: 1 }}>👍</div>
            <p style={{ fontSize: '22px', fontWeight: 600, color: '#6B7280', lineHeight: 1.3 }}>{c.declined}</p>
          </>
        )}

        {state === 'already' && (
          <p style={{ color: '#9CA3AF', fontSize: '18px' }}>{c.already}</p>
        )}

        {(state === 'ready' || state === 'submitting') && data && (
          <>
            {/* Shift label */}
            <p style={{
              fontSize: '12px',
              fontWeight: 600,
              textTransform: 'uppercase',
              letterSpacing: '0.1em',
              color: '#9CA3AF',
              marginBottom: '10px',
            }}>
              {c.shift}
            </p>

            {/* Name */}
            <p style={{
              fontSize: '36px',
              fontWeight: 700,
              color: '#1A1A2E',
              lineHeight: 1.1,
              marginBottom: '10px',
            }}>
              {data.staffName.split(' ')[0]}
            </p>

            {/* Date */}
            <p style={{
              fontSize: '19px',
              fontWeight: 500,
              color: '#6B7280',
              marginBottom: '52px',
              lineHeight: 1.3,
            }}>
              {formatDate(data.shiftDate, lang)}
            </p>

            {/* Yes button */}
            <button
              onClick={() => state === 'ready' && respond('confirmed')}
              disabled={state === 'submitting'}
              style={{
                width: '100%',
                padding: '22px 20px',
                background: '#16A34A',
                color: '#FFFFFF',
                border: 'none',
                borderRadius: '18px',
                fontSize: '22px',
                fontWeight: 700,
                cursor: state === 'submitting' ? 'not-allowed' : 'pointer',
                marginBottom: '14px',
                opacity: state === 'submitting' ? 0.5 : 1,
                transition: 'opacity 0.15s',
                fontFamily: 'inherit',
                letterSpacing: '-0.01em',
                boxShadow: '0 2px 8px rgba(22,163,74,0.25)',
              }}
            >
              {state === 'submitting' ? c.submitting : c.isComing}
            </button>

            {/* No button */}
            <button
              onClick={() => state === 'ready' && respond('declined')}
              disabled={state === 'submitting'}
              style={{
                width: '100%',
                padding: '22px 20px',
                background: 'rgba(220,38,38,0.06)',
                color: '#DC2626',
                border: '1px solid rgba(220,38,38,0.2)',
                borderRadius: '18px',
                fontSize: '22px',
                fontWeight: 700,
                cursor: state === 'submitting' ? 'not-allowed' : 'pointer',
                opacity: state === 'submitting' ? 0.5 : 1,
                transition: 'opacity 0.15s',
                fontFamily: 'inherit',
                letterSpacing: '-0.01em',
              }}
            >
              {state === 'submitting' ? c.submitting : c.cantMake}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

export default function ConfirmPage() {
  return (
    <Suspense fallback={
      <div style={{
        minHeight: '100dvh',
        background: '#FFFFFF',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}>
        <p style={{ color: '#9CA3AF', fontFamily: 'sans-serif', fontSize: '16px' }}>Loading…</p>
      </div>
    }>
      <ConfirmContent />
    </Suspense>
  );
}
