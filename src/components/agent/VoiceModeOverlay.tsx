'use client';

// ─── VoiceModeOverlay — Clicky-style bottom bar for live voice chat ──────
//
// Mounts conditionally when voicePanel.voiceModeOpen === true. Unmounts
// on close so the <audio> element from useTtsPlayer is created in the
// user-gesture frame that opened voice mode (iOS Safari autoplay rule).
//
// Visual mirrors WalkthroughOverlay.CaptionBar: fixed bottom-center,
// 640px max, dark ink background, white text, X to exit.
//
// State flow per turn:
//   1. Mount → mic auto-listens immediately
//   2. User speaks → silence-detect or 60s cap → upload to /transcribe
//   3. Transcript → useAgentChat.sendMessage(transcript)
//   4. SSE streams the reply → text shows live in the overlay
//   5. When streaming ends:
//      - If voice replies on: Nova speaks via useTtsPlayer; on done, re-arm mic
//      - If voice replies off: mic re-arms immediately after text settles
//   6. Loop until X clicked or wake-word "stop" fired

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

  // Bail-out states. The hook calls below still happen unconditionally —
  // we just don't render anything.
  const shouldRender = Boolean(voicePanel?.voiceModeOpen && user && activePropertyId);

  return shouldRender ? <ActiveOverlay /> : null;
}

function ActiveOverlay() {
  const voicePanel = useVoicePanel();
  const { activePropertyId } = useProperty();

  // Voice preference loaded once on mount.
  const [voicePref, setVoicePref] = useState<VoicePreferenceResponse | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetchWithAuth('/api/agent/voice-preference');
        if (!res.ok || cancelled) return;
        const body = await res.json();
        setVoicePref(body.data as VoicePreferenceResponse);
      } catch { /* graceful — overlay still works text-only */ }
    })();
    return () => { cancelled = true; };
  }, []);

  const speakerOn = voicePref?.voiceRepliesEnabled === true;

  // Conversation handle — shared with the chat panel so voice exchanges
  // land in the same agent_conversations row history.
  const {
    messages,
    conversationId,
    streaming,
    error,
    sendMessage,
  } = useAgentChat({ propertyId: activePropertyId, active: true });

  // TTS player for the assistant's spoken reply.
  const lastFeedRef = useRef<{ msgIndex: number; len: number }>({ msgIndex: -1, len: 0 });
  const tts = useTtsPlayer({
    propertyId: activePropertyId,
    conversationId,
    enabled: speakerOn,
    onDone: () => {
      // After Nova finishes speaking, auto-arm the mic for the next turn.
      // Small delay so the last syllable lands cleanly before recording.
      window.setTimeout(() => {
        voiceRecordingRef.current?.();
      }, 300);
    },
  });

  // Feed streaming assistant text into TTS sentence-by-sentence.
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

  // When SSE streaming ends, flush trailing buffer to TTS.
  const wasStreamingRef = useRef(false);
  useEffect(() => {
    if (wasStreamingRef.current && !streaming) {
      tts.finalizeStreamingText();
      // If voice replies are OFF, no onDone will fire (because TTS doesn't
      // play). Re-arm the mic on text-arrival in that case.
      if (!speakerOn) {
        window.setTimeout(() => {
          voiceRecordingRef.current?.();
        }, 600);
      }
    }
    wasStreamingRef.current = streaming;
  }, [streaming, tts, speakerOn]);

  // Recording machinery.
  const recording = useVoiceRecording({
    propertyId: activePropertyId,
    conversationId,
    onTranscript: (text) => { void sendMessage(text); },
    onStartRecording: () => { tts.stop(); },
  });

  // Imperative ref so the onDone TTS callback can re-arm the mic without
  // depending on `recording.start` being stable across renders.
  const voiceRecordingRef = useRef<() => void>(() => {});
  useEffect(() => {
    voiceRecordingRef.current = () => { void recording.start(); };
  }, [recording]);

  // Kick off the first recording when the overlay mounts. Inside the
  // same gesture frame as the openVoiceMode call (button click /
  // keyboard / wake) so iOS Safari permits the getUserMedia prompt.
  const startedFirstRecordingRef = useRef(false);
  useEffect(() => {
    if (startedFirstRecordingRef.current) return;
    startedFirstRecordingRef.current = true;
    void recording.start();
  }, [recording]);

  // Wake-word "stop" keyword and Esc both close the overlay.
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

  // Both `useVoiceRecording` and `useTtsPlayer` already register their
  // own unmount cleanups (release mic stream + audio context, abort
  // pending TTS fetches, revoke blob URLs). We deliberately do NOT add
  // a manual cleanup here:
  //
  // The `useEffect(() => () => { ... }, [tts, recording])` shape we had
  // before re-fired its cleanup on every render (because the hook return
  // objects are new references), which called `recording.stop()` the
  // instant state flipped 'idle' → 'recording'. That truncated every
  // utterance to ~1ms of audio, producing a 0-byte blob and the
  // "Didn't catch that — tap to try again" error.

  // ── Render ─────────────────────────────────────────────────────────────
  const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant' && !m.toolName);

  let statusLine: string;
  let dotColor: string;
  switch (recording.state.kind) {
    case 'recording':
      statusLine = `Listening… 0:${String(recording.state.durationSec).padStart(2, '0')}`;
      dotColor = '#D7563A';
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
      statusLine = streaming
        ? 'Thinking…'
        : tts.isSpeaking
          ? 'Speaking…'
          : 'Ready';
      dotColor = streaming || tts.isSpeaking ? C.sage : C.ink2;
  }

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
      {/* Left: status line + last assistant text */}
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
            animation: recording.state.kind === 'recording' || tts.isSpeaking
              ? 'staxis-voice-dot-pulse 1.2s ease-in-out infinite'
              : undefined,
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
          {recording.state.kind === 'denied' && (
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
        {lastAssistant && lastAssistant.text.trim() && (
          <div style={{
            fontFamily: FONT_SERIF,
            fontSize: 14,
            lineHeight: 1.45,
            color: 'white',
            wordBreak: 'break-word',
          }}>
            {lastAssistant.text}
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

      {/* Right: X close button */}
      <button
        onClick={() => voicePanel?.closeVoiceMode()}
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
