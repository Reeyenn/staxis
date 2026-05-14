'use client';

// ─── VoiceModeOverlay — Clicky-style bottom bar for live voice chat ──────
//
// One file, two implementations behind a feature flag:
//
//   - `ElevenLabsActiveOverlay` (default, prod-on)
//     Talks directly to ElevenLabs Conversational AI over WebSocket via
//     `useConversationalSession`. ElevenLabs handles ASR / TTS / VAD /
//     barge-in; our /api/agent/voice-brain webhook supplies replies from
//     the same Claude brain text mode uses. Target turn time ~1.5–2s
//     ear-to-ear.
//
//   - `LegacyActiveOverlay` (NEXT_PUBLIC_VOICE_SURFACE=legacy)
//     The pre-2026-05-14 pipeline: client-side mic recording → upload
//     to /api/agent/transcribe (Whisper) → /api/agent/command (Claude) →
//     /api/agent/speak (OpenAI TTS). Kept as a one-flag-flip rollback
//     for the first week the ElevenLabs path is live. Will be removed
//     in a follow-up PR after the new surface stabilises.
//
// Visual layout is byte-identical between the two: fixed bottom-center,
// dark ink background, white text, animated status dot, X to exit.

import { useEffect, useRef, useState } from 'react';
import { X, HelpCircle } from 'lucide-react';
import Link from 'next/link';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { fetchWithAuth } from '@/lib/api-fetch';
import { useVoicePanel } from './VoicePanelContext';
import { useAgentChat } from './useAgentChat';
import { useVoiceRecording } from './useVoiceRecording';
import { useTtsPlayer } from './useTtsPlayer';
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

interface VoicePreferenceResponse {
  voiceRepliesEnabled: boolean;
  wakeWordEnabled: boolean;
  voiceOnboardedAt: string | null;
}

export function VoiceModeOverlay() {
  const voicePanel = useVoicePanel();
  const { user } = useAuth();
  const { activePropertyId } = useProperty();

  const shouldRender = Boolean(voicePanel?.voiceModeOpen && user && activePropertyId);
  if (!shouldRender) return null;

  // The flag is read once per overlay mount. Switching surfaces requires
  // a re-deploy (env var) and a fresh voice-mode open — that's fine,
  // the user never changes it mid-session.
  const surface = process.env.NEXT_PUBLIC_VOICE_SURFACE ?? 'elevenlabs';
  if (surface === 'legacy') return <LegacyActiveOverlay />;
  return <ElevenLabsActiveOverlay />;
}

// ─── Shared chrome ────────────────────────────────────────────────────────

interface ChromeProps {
  statusLine: string;
  dotColor: string;
  dotPulse: boolean;
  showMicHelp: boolean;
  bodyText: string;
  errorText: string | null;
  onClose: () => void;
}

function OverlayChrome({ statusLine, dotColor, dotPulse, showMicHelp, bodyText, errorText, onClose }: ChromeProps) {
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
          marginBottom: bodyText ? 6 : 0,
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
          {showMicHelp && (
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
        {bodyText && bodyText.trim() && (
          <div style={{
            fontFamily: FONT_SERIF,
            fontSize: 14,
            lineHeight: 1.45,
            color: 'white',
            wordBreak: 'break-word',
          }}>
            {bodyText}
          </div>
        )}
        {errorText && (
          <div style={{
            marginTop: 6,
            fontSize: 12,
            color: 'rgba(255, 255, 255, 0.7)',
          }}>
            {errorText}
          </div>
        )}
      </div>

      <button
        onClick={onClose}
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

// ─── ElevenLabs implementation (new default) ──────────────────────────────

function ElevenLabsActiveOverlay() {
  const voicePanel = useVoicePanel();
  const { activePropertyId } = useProperty();

  const { status, lastAssistant, error, stop } = useConversationalSession({
    propertyId: activePropertyId,
    active: true,
  });

  // Esc + wake-word "stop" event both close the overlay. Wake word fires
  // a 'staxis:tts-stop' window event — same wiring the legacy overlay
  // uses, kept here so wake-word "stop" continues to work on either path.
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
  return (
    <OverlayChrome
      statusLine={statusLine}
      dotColor={dotColor}
      dotPulse={dotPulse}
      showMicHelp={status === 'denied'}
      bodyText={lastAssistant}
      errorText={error}
      onClose={() => { stop(); voicePanel?.closeVoiceMode(); }}
    />
  );
}

function statusFor(s: ConversationStatus): { statusLine: string; dotColor: string; dotPulse: boolean } {
  switch (s) {
    case 'connecting': return { statusLine: 'Connecting…',  dotColor: C.ink2, dotPulse: false };
    case 'listening':  return { statusLine: 'Listening…',   dotColor: '#D7563A', dotPulse: true };
    case 'thinking':   return { statusLine: 'Thinking…',    dotColor: '#C99644', dotPulse: false };
    case 'speaking':   return { statusLine: 'Speaking…',    dotColor: C.sage,    dotPulse: true };
    case 'denied':     return { statusLine: 'Mic blocked',  dotColor: C.warm,    dotPulse: false };
    case 'capped':     return { statusLine: "You've hit today's voice limit", dotColor: C.warm, dotPulse: false };
    case 'error':      return { statusLine: 'Error',        dotColor: C.warm,    dotPulse: false };
    default:           return { statusLine: 'Ready',        dotColor: C.ink2,    dotPulse: false };
  }
}

// ─── Legacy implementation (NEXT_PUBLIC_VOICE_SURFACE=legacy fallback) ───
//
// This is the pre-2026-05-14 pipeline. Left intact behind the feature
// flag so we can flip back in 60 seconds via Vercel env if the ElevenLabs
// path has an outage in week one. Slated for deletion in a follow-up PR
// after the new surface stabilises.

function LegacyActiveOverlay() {
  const voicePanel = useVoicePanel();
  const { activePropertyId } = useProperty();

  const [voicePref, setVoicePref] = useState<VoicePreferenceResponse | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetchWithAuth('/api/agent/voice-preference');
        if (!res.ok || cancelled) return;
        const body = await res.json();
        setVoicePref(body.data as VoicePreferenceResponse);
      } catch { /* graceful */ }
    })();
    return () => { cancelled = true; };
  }, []);

  const speakerOn = voicePref?.voiceRepliesEnabled === true;

  const {
    messages,
    conversationId,
    streaming,
    error,
    sendMessage,
  } = useAgentChat({ propertyId: activePropertyId, active: true });

  const lastFeedRef = useRef<{ msgIndex: number; len: number }>({ msgIndex: -1, len: 0 });
  const tts = useTtsPlayer({
    propertyId: activePropertyId,
    conversationId,
    enabled: speakerOn,
    onDone: () => {
      window.setTimeout(() => { voiceRecordingRef.current?.(); }, 300);
    },
  });

  useEffect(() => {
    if (!speakerOn) return;
    if (messages.length === 0) return;
    const lastIdx = messages.length - 1;
    const last = messages[lastIdx];
    if (last.role !== 'assistant') return;

    if (lastFeedRef.current.msgIndex !== lastIdx) {
      tts.reset();
      lastFeedRef.current = { msgIndex: lastIdx, len: 0 };
    }
    if (last.text.length > lastFeedRef.current.len) {
      tts.feedStreamingText(last.text);
      lastFeedRef.current.len = last.text.length;
    }
  }, [messages, speakerOn, tts]);

  const wasStreamingRef = useRef(false);
  useEffect(() => {
    if (wasStreamingRef.current && !streaming) {
      tts.finalizeStreamingText();
      if (!speakerOn) {
        window.setTimeout(() => { voiceRecordingRef.current?.(); }, 600);
      }
    }
    wasStreamingRef.current = streaming;
  }, [streaming, tts, speakerOn]);

  const recording = useVoiceRecording({
    propertyId: activePropertyId,
    conversationId,
    onTranscript: (text) => { void sendMessage(text); },
    onStartRecording: () => { tts.stop(); },
  });

  const voiceRecordingRef = useRef<() => void>(() => {});
  useEffect(() => {
    voiceRecordingRef.current = () => { void recording.start(); };
  }, [recording]);

  const startedFirstRecordingRef = useRef(false);
  useEffect(() => {
    if (startedFirstRecordingRef.current) return;
    startedFirstRecordingRef.current = true;
    void recording.start();
  }, [recording]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onTtsStop = () => tts.stop();
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') voicePanel?.closeVoiceMode();
    };
    window.addEventListener('staxis:tts-stop', onTtsStop);
    window.addEventListener('keydown', onEsc);
    return () => {
      window.removeEventListener('staxis:tts-stop', onTtsStop);
      window.removeEventListener('keydown', onEsc);
    };
  }, [tts, voicePanel]);

  const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant' && !m.toolName);

  let statusLine: string;
  let dotColor: string;
  let dotPulse = false;
  switch (recording.state.kind) {
    case 'recording':
      statusLine = `Listening… 0:${String(recording.state.durationSec).padStart(2, '0')}`;
      dotColor = '#D7563A';
      dotPulse = true;
      break;
    case 'uploading':
      statusLine = 'Got it…';
      dotColor = '#C99644';
      break;
    case 'denied':
      statusLine = 'Mic blocked';
      dotColor = C.warm;
      break;
    case 'error':
      statusLine = recording.state.message;
      dotColor = C.warm;
      break;
    case 'capped':
      statusLine = "You've hit today's voice limit";
      dotColor = C.warm;
      break;
    default:
      statusLine = streaming ? 'Thinking…' : tts.isSpeaking ? 'Speaking…' : 'Ready';
      dotColor = streaming || tts.isSpeaking ? C.sage : C.ink2;
      dotPulse = tts.isSpeaking;
  }

  return (
    <OverlayChrome
      statusLine={statusLine}
      dotColor={dotColor}
      dotPulse={dotPulse}
      showMicHelp={recording.state.kind === 'denied'}
      bodyText={lastAssistant?.text ?? ''}
      errorText={error}
      onClose={() => voicePanel?.closeVoiceMode()}
    />
  );
}
