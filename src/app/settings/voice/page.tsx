'use client';

// ─── /settings/voice — voice preferences ─────────────────────────────────
//
// Two toggles, both server-backed in accounts.voice_replies_enabled /
// accounts.wake_word_enabled.
//
//   1. Voice replies  — Staxis speaks responses aloud (Nova voice)
//   2. Hey Staxis     — Wake-word listener that opens chat + records
//                       on hearing "Hey Staxis" / "Oye Staxis"
//
// The wake-word toggle is HIDDEN entirely unless the deploy has both
// .ppn keyword files in public/wake-words/ AND PICOVOICE_ACCESS_KEY set
// (probed via /api/agent/wake-word-available). This keeps the UI honest
// — no toggle for a feature that won't work.

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { AppLayout } from '@/components/layout/AppLayout';
import { useAuth } from '@/contexts/AuthContext';
import { useLang } from '@/contexts/LanguageContext';
import { fetchWithAuth } from '@/lib/api-fetch';
import { Volume2, Mic, ChevronLeft, Loader2 } from 'lucide-react';

interface VoicePreference {
  voiceRepliesEnabled: boolean;
  wakeWordEnabled: boolean;
  voiceOnboardedAt: string | null;
}

export default function VoiceSettingsPage() {
  const { user, loading: authLoading } = useAuth();
  const { lang } = useLang();
  const isEs = lang === 'es';

  const [pref, setPref] = useState<VoicePreference | null>(null);
  const [wakeWordAvailable, setWakeWordAvailable] = useState<boolean | null>(null);
  const [savingKey, setSavingKey] = useState<'voiceReplies' | 'wakeWord' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [wakeWordToastShown, setWakeWordToastShown] = useState(false);

  // Load preferences + wake-word availability on mount.
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      try {
        const [prefRes, availRes] = await Promise.all([
          fetchWithAuth('/api/agent/voice-preference'),
          fetchWithAuth('/api/agent/wake-word-available'),
        ]);
        if (cancelled) return;
        if (prefRes.ok) {
          const body = await prefRes.json();
          setPref(body.data as VoicePreference);
        }
        if (availRes.ok) {
          const body = await availRes.json();
          setWakeWordAvailable(body.data?.available === true);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [user]);

  const updatePref = async (
    key: 'voiceReplies' | 'wakeWord',
    next: boolean,
  ) => {
    if (!pref) return;
    setSavingKey(key);
    setError(null);
    // Optimistic update.
    setPref(prev => prev ? {
      ...prev,
      voiceRepliesEnabled: key === 'voiceReplies' ? next : prev.voiceRepliesEnabled,
      wakeWordEnabled: key === 'wakeWord' ? next : prev.wakeWordEnabled,
    } : prev);

    try {
      const body = key === 'voiceReplies'
        ? { voiceReplies: next }
        : { wakeWordEnabled: next };
      const res = await fetchWithAuth('/api/agent/voice-preference', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        // Roll back.
        setPref(prev => prev ? {
          ...prev,
          voiceRepliesEnabled: key === 'voiceReplies' ? !next : prev.voiceRepliesEnabled,
          wakeWordEnabled: key === 'wakeWord' ? !next : prev.wakeWordEnabled,
        } : prev);
        const errBody = await res.json().catch(() => null);
        setError(errBody?.error ?? (isEs ? 'No se pudo guardar.' : 'Couldn\'t save.'));
        return;
      }
      const ok = await res.json();
      setPref(ok.data as VoicePreference);

      // One-time toast when wake word is first turned on.
      if (key === 'wakeWord' && next && !wakeWordToastShown) {
        setWakeWordToastShown(true);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingKey(null);
    }
  };

  if (authLoading) {
    return (
      <AppLayout>
        <div style={{ padding: 24, fontFamily: 'var(--font-sans)' }}>
          <Loader2 className="staxis-spin" size={18} />
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div style={{ padding: '20px 16px', display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Link
          href="/settings"
          style={{
            display: 'flex', alignItems: 'center', gap: 6,
            fontFamily: 'var(--font-sans)', fontSize: 13,
            color: 'var(--text-muted)',
            textDecoration: 'none',
          }}
        >
          <ChevronLeft size={14} />
          {isEs ? 'Configuración' : 'Settings'}
        </Link>

        <h1 style={{
          fontFamily: 'var(--font-sans)',
          fontWeight: 700,
          fontSize: 17,
          color: 'var(--text-primary)',
          letterSpacing: '-0.01em',
        }}>
          {isEs ? 'Voz' : 'Voice'}
        </h1>

        <ToggleCard
          icon={Volume2}
          title={isEs ? 'Respuestas habladas' : 'Voice replies'}
          desc={isEs
            ? 'Staxis lee las respuestas en voz alta (voz Nova).'
            : 'Staxis reads responses out loud (Nova voice).'}
          checked={pref?.voiceRepliesEnabled ?? false}
          disabled={!pref || savingKey === 'voiceReplies'}
          saving={savingKey === 'voiceReplies'}
          onToggle={(next) => void updatePref('voiceReplies', next)}
        />

        {wakeWordAvailable && (
          <ToggleCard
            icon={Mic}
            title={isEs ? 'Palabra de activación "Hey Staxis"' : '“Hey Staxis” wake word'}
            desc={isEs
              ? 'Escucha en segundo plano mientras Staxis está abierto en una pestaña. Puede usar batería. Requiere permiso del micrófono.'
              : 'Listens in the background while Staxis is open in a tab. May use battery. Requires microphone permission.'}
            checked={pref?.wakeWordEnabled ?? false}
            disabled={!pref || savingKey === 'wakeWord'}
            saving={savingKey === 'wakeWord'}
            onToggle={(next) => void updatePref('wakeWord', next)}
          />
        )}

        {wakeWordAvailable === false && (
          <div style={{
            padding: '14px 16px',
            background: 'var(--snow-rule-soft, rgba(31, 35, 28, 0.04))',
            borderRadius: 12,
            fontFamily: 'var(--font-sans)',
            fontSize: 12,
            color: 'var(--text-muted)',
            lineHeight: 1.5,
          }}>
            {isEs
              ? 'La palabra de activación aún no está configurada en este despliegue. Hablar con Reeyen para habilitarlo.'
              : 'Wake word isn’t set up on this deploy yet. Ask Reeyen to enable it.'}
          </div>
        )}

        {wakeWordToastShown && (
          <div style={{
            padding: '12px 14px',
            background: 'rgba(94, 122, 96, 0.10)',
            border: '1px solid rgba(94, 122, 96, 0.25)',
            borderRadius: 10,
            fontFamily: 'var(--font-sans)',
            fontSize: 12,
            color: 'var(--snow-sage-deep, #5C7A60)',
            lineHeight: 1.5,
          }}>
            {isEs
              ? 'La palabra de activación usa batería continuamente. Es mejor dejarla apagada hasta que la necesites.'
              : 'Heads up — wake word uses some battery. Best to leave off until you need it.'}
          </div>
        )}

        {error && (
          <div style={{
            padding: '10px 12px',
            background: 'rgba(184, 92, 61, 0.08)',
            border: '1px solid rgba(184, 92, 61, 0.20)',
            borderRadius: 8,
            color: 'var(--snow-warm, #B85C3D)',
            fontFamily: 'var(--font-sans)',
            fontSize: 13,
          }}>
            {error}
          </div>
        )}
      </div>
    </AppLayout>
  );
}

interface ToggleCardProps {
  icon: React.ComponentType<{ size?: number; color?: string }>;
  title: string;
  desc: string;
  checked: boolean;
  disabled?: boolean;
  saving?: boolean;
  onToggle: (next: boolean) => void;
}

function ToggleCard({ icon: Icon, title, desc, checked, disabled, saving, onToggle }: ToggleCardProps) {
  return (
    <div
      className="card"
      style={{
        padding: '16px 18px',
        display: 'flex',
        alignItems: 'center',
        gap: 16,
      }}
    >
      <div style={{
        width: 48, height: 48, borderRadius: 13, flexShrink: 0,
        background: 'rgba(27, 58, 92, 0.06)',
        border: '1px solid rgba(27, 58, 92, 0.12)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <Icon size={21} color="var(--navy)" />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <p style={{
          fontWeight: 700, fontSize: 16,
          color: 'var(--text-primary)',
          marginBottom: 3, lineHeight: 1.2,
        }}>
          {title}
        </p>
        <p style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.4 }}>
          {desc}
        </p>
      </div>
      <button
        onClick={() => onToggle(!checked)}
        disabled={disabled}
        aria-pressed={checked}
        aria-label={`Toggle ${title}`}
        style={{
          width: 46, height: 26,
          borderRadius: 999,
          border: 'none',
          cursor: disabled ? 'default' : 'pointer',
          background: checked ? 'var(--snow-sage-deep, #5C7A60)' : 'var(--snow-rule, rgba(31, 35, 28, 0.12))',
          position: 'relative',
          transition: 'background 0.18s ease',
          flexShrink: 0,
          opacity: saving ? 0.7 : 1,
        }}
      >
        <span style={{
          position: 'absolute',
          top: 3,
          left: checked ? 23 : 3,
          width: 20, height: 20,
          borderRadius: '50%',
          background: 'white',
          transition: 'left 0.18s ease',
          boxShadow: '0 1px 3px rgba(0, 0, 0, 0.18)',
        }} />
      </button>
    </div>
  );
}
