'use client';

// ─── VoiceModeOverlay — Clicky-style bottom bar for live voice chat ──────
//
// Talks directly to ElevenLabs Conversational AI over WebSocket via
// `useConversationalSession`. ElevenLabs handles ASR / TTS / VAD /
// barge-in; our /api/agent/voice-brain webhook supplies replies from
// the same Claude brain text mode uses. Target turn time ~1.5-2s
// ear-to-ear.
//
// Visual layout: fixed bottom-center, dark ink background, white text,
// animated status dot, X to exit. Mirrors the WalkthroughOverlay caption
// bar pattern so the whole product reads as one voice surface.

import { useEffect } from 'react';
import { X, HelpCircle } from 'lucide-react';
import Link from 'next/link';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { useVoicePanel } from './VoicePanelContext';
import { useConversationalSession, type ConversationStatus } from './useConversationalSession';

const C = {
  ink:  'var(--snow-ink, #1F231C)',
  ink2: 'var(--snow-ink2, #5C625C)',
  warm: 'var(--snow-warm, #B85C3D)',
  sage: 'var(--snow-sage, #9EB7A6)',
};

const FONT_SANS = "var(--font-geist), -apple-system, sans-serif";
const FONT_SERIF = "var(--font-instrument-serif), 'Times New Roman', Georgia, serif";
const FONT_MONO = "var(--font-geist-mono), ui-monospace, monospace";

export function VoiceModeOverlay() {
  const voicePanel = useVoicePanel();
  const { user } = useAuth();
  const { activePropertyId } = useProperty();

  const shouldRender = Boolean(voicePanel?.voiceModeOpen && user && activePropertyId);
  if (!shouldRender) return null;

  return <ActiveOverlay />;
}

function ActiveOverlay() {
  const voicePanel = useVoicePanel();
  const { activePropertyId } = useProperty();

  const { status, lastAssistant, error, stop } = useConversationalSession({
    propertyId: activePropertyId,
    active: true,
  });

  // Esc + wake-word "stop" event both close the overlay.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onTtsStop = () => { stop(); voicePanel?.closeVoiceMode(); };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { stop(); voicePanel?.closeVoiceMode(); }
    };
    window.addEventListener('staxis:tts-stop', onTtsStop);
    window.addEventListener('keydown', onEsc);
    return () => {
      window.removeEventListener('staxis:tts-stop', onTtsStop);
      window.removeEventListener('keydown', onEsc);
    };
  }, [stop, voicePanel]);

  const { statusLine, dotColor, dotPulse } = statusFor(status);
  const closeOverlay = () => { stop(); voicePanel?.closeVoiceMode(); };

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: 'fixed',
        bottom: 'max(24px, env(safe-area-inset-bottom, 24px))',
        left: '50%',
        transform: 'translateX(-50%)',
        maxWidth: 'min(640px, 92vw)',
        background: C.ink,
        color: 'white',
        padding: '14px 18px',
        borderRadius: 14,
        boxShadow: '0 12px 32px rgba(31, 35, 28, 0.22), 0 3px 8px rgba(31, 35, 28, 0.12)',
        zIndex: 9999,
        display: 'flex',
        alignItems: 'flex-start',
        gap: 14,
        fontFamily: FONT_SANS,
        animation: 'staxis-fade-in 0.18s ease-out, staxis-slide-up 0.22s ease-out',
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          marginBottom: lastAssistant ? 6 : 0,
        }}>
          <span style={{
            width: 8, height: 8, borderRadius: '50%',
            background: dotColor,
            animation: dotPulse ? 'staxis-voice-dot-pulse 1.2s ease-in-out infinite' : undefined,
            flexShrink: 0,
          }} />
          <span style={{
            fontFamily: FONT_MONO,
            fontSize: 10,
            letterSpacing: '0.12em',
            textTransform: 'uppercase',
            opacity: 0.7,
          }}>
            {statusLine}
          </span>
          {status === 'denied' && (
            <Link
              href="/settings/voice"
              title="Enable mic in browser settings"
              style={{
                display: 'inline-flex', alignItems: 'center',
                color: 'white', opacity: 0.7, textDecoration: 'none',
              }}
            >
              <HelpCircle size={14} />
            </Link>
          )}
        </div>
        {lastAssistant && lastAssistant.trim() && (
          <div style={{
            fontFamily: FONT_SERIF,
            fontSize: 14,
            lineHeight: 1.45,
            color: 'white',
            wordBreak: 'break-word',
          }}>
            {lastAssistant}
          </div>
        )}
        {error && (
          <div style={{
            marginTop: 6,
            fontSize: 12,
            color: 'rgba(255, 255, 255, 0.7)',
          }}>
            {error}
          </div>
        )}
      </div>

      <button
        onClick={closeOverlay}
        aria-label="Exit voice mode"
        title="Exit voice mode"
        style={{
          flexShrink: 0,
          width: 32, height: 32,
          borderRadius: 8,
          border: 'none',
          background: 'rgba(255, 255, 255, 0.12)',
          color: 'white',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          transition: 'background 0.14s ease',
        }}
        onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255, 255, 255, 0.20)'; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255, 255, 255, 0.12)'; }}
      >
        <X size={16} strokeWidth={2.4} />
      </button>
    </div>
  );
}

function statusFor(s: ConversationStatus): { statusLine: string; dotColor: string; dotPulse: boolean } {
  switch (s) {
    case 'connecting': return { statusLine: 'Connecting…',  dotColor: C.ink2,    dotPulse: false };
    case 'listening':  return { statusLine: 'Listening…',   dotColor: '#D7563A', dotPulse: true };
    case 'thinking':   return { statusLine: 'Thinking…',    dotColor: '#C99644', dotPulse: false };
    case 'speaking':   return { statusLine: 'Speaking…',    dotColor: C.sage,    dotPulse: true };
    case 'denied':     return { statusLine: 'Mic blocked',  dotColor: C.warm,    dotPulse: false };
    case 'capped':     return { statusLine: "You've hit today's voice limit", dotColor: C.warm, dotPulse: false };
    case 'error':      return { statusLine: 'Error',        dotColor: C.warm,    dotPulse: false };
    default:           return { statusLine: 'Ready',        dotColor: C.ink2,    dotPulse: false };
  }
}
