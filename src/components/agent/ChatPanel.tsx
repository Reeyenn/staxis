'use client';

// ─── ChatPanel — slide-in panel triggered by FloatingChatButton ───────────
// Compact chat surface for quick asks from anywhere in the app. On desktop
// it slides in from the right as a 420px-wide panel; on mobile it covers
// the screen.
//
// 2026-05-13 voice surface additions:
//   - Speaker toggle (Volume2 / VolumeX) in the header — flips voice replies
//     on/off, persisted via /api/agent/voice-preference
//   - VoiceButton in the composer (left of Send) — tap to record
//   - TTS player feeds streaming assistant text sentence-by-sentence to
//     /api/agent/speak when speaker is on
//   - StopStaxisOverlay shows while TTS is playing — big Stop button + tap
//     anywhere to interrupt
//   - VoiceReplyOnboardingModal shows the first time a user taps the mic
//     when they haven't yet picked yes/no on voice replies
//   - Auto-arm mic when Staxis finishes speaking (per locked product
//     decision: voice mode is sticky; mic re-opens for the next utterance)

import { useEffect, useRef, useState } from 'react';
import { X, Send, Plus, ExternalLink, Volume2, VolumeX } from 'lucide-react';
import Link from 'next/link';
import { MessageList } from './MessageList';
import { useAgentChat } from './useAgentChat';
import { useTtsPlayer } from './useTtsPlayer';
import { VoiceButton, type VoiceButtonHandle } from './VoiceButton';
import { VoiceReplyOnboardingModal } from './VoiceReplyOnboardingModal';
import { StopStaxisOverlay } from './StopStaxisOverlay';
import { useVoicePanel } from './VoicePanelContext';
import { fetchWithAuth } from '@/lib/api-fetch';

const C = {
  bg:       'var(--snow-bg, #FFFFFF)',
  ink:      'var(--snow-ink, #1F231C)',
  ink2:     'var(--snow-ink2, #5C625C)',
  ink3:     'var(--snow-ink3, #A6ABA6)',
  rule:     'var(--snow-rule, rgba(31, 35, 28, 0.08))',
  ruleSoft: 'var(--snow-rule-soft, rgba(31, 35, 28, 0.04))',
  sageDeep: 'var(--snow-sage-deep, #5C7A60)',
};

const FONT_SANS  = "var(--font-geist), -apple-system, BlinkMacSystemFont, sans-serif";
const FONT_MONO  = "var(--font-geist-mono), ui-monospace, monospace";
const FONT_SERIF = "var(--font-instrument-serif), 'Times New Roman', Georgia, serif";

export interface ChatPanelProps {
  open: boolean;
  onClose: () => void;
  propertyId: string | null;
}

interface VoicePreferenceResponse {
  voiceRepliesEnabled: boolean;
  wakeWordEnabled: boolean;
  voiceOnboardedAt: string | null;
}

export function ChatPanel({ open, onClose, propertyId }: ChatPanelProps) {
  const {
    messages,
    conversationId,
    streaming,
    error,
    sendMessage,
    startNew,
  } = useAgentChat({ propertyId, active: open });

  const [input, setInput] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const voiceButtonRef = useRef<VoiceButtonHandle>(null);

  // ── Voice preferences (server-backed, loaded once per open) ────────────
  const [voicePref, setVoicePref] = useState<VoicePreferenceResponse | null>(null);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const voicePanel = useVoicePanel();

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetchWithAuth('/api/agent/voice-preference');
        if (!res.ok) return;
        const body = await res.json();
        if (cancelled) return;
        setVoicePref(body.data as VoicePreferenceResponse);
      } catch { /* silent — voice surface degrades gracefully */ }
    })();
    return () => { cancelled = true; };
  }, [open]);

  // ── TTS player ─────────────────────────────────────────────────────────
  const speakerOn = voicePref?.voiceRepliesEnabled === true;
  const tts = useTtsPlayer({
    propertyId,
    conversationId,
    enabled: speakerOn,
    onDone: () => {
      // Auto-arm mic when Staxis finishes speaking. Per locked product
      // decision (master prompt 2026-05-13). Only when the panel is still
      // open and we're not already capped on cost.
      if (!open) return;
      // Small delay so the user hears the last syllable before recording.
      window.setTimeout(() => {
        voiceButtonRef.current?.start().catch(() => {});
      }, 300);
    },
  });

  // ── Wire useAgentChat streaming → TTS player ───────────────────────────
  // Look at the last message; if it's an assistant bubble, feed its
  // cumulative text to the TTS hook. When `streaming` flips false, flush
  // any remaining buffer as the final sentence.
  const lastFeedRef = useRef<{ msgIndex: number; len: number }>({ msgIndex: -1, len: 0 });
  useEffect(() => {
    if (!speakerOn) return;
    if (messages.length === 0) return;
    const lastIdx = messages.length - 1;
    const last = messages[lastIdx];
    if (last.role !== 'assistant') return;

    // If a new assistant bubble started, reset the player buffer.
    if (lastFeedRef.current.msgIndex !== lastIdx) {
      tts.reset();
      lastFeedRef.current = { msgIndex: lastIdx, len: 0 };
    }
    if (last.text.length > lastFeedRef.current.len) {
      tts.feedStreamingText(last.text);
      lastFeedRef.current.len = last.text.length;
    }
  }, [messages, speakerOn, tts]);

  // When streaming finishes, finalize the buffer (flush trailing
  // punctuation-less text as a sentence).
  const wasStreamingRef = useRef(false);
  useEffect(() => {
    if (wasStreamingRef.current && !streaming) {
      tts.finalizeStreamingText();
    }
    wasStreamingRef.current = streaming;
  }, [streaming, tts]);

  // ── Consume the "auto-record" flag from VoicePanelContext ──────────────
  useEffect(() => {
    if (!open || !voicePanel?.voiceRecordingRequested) return;
    voicePanel.consumeVoiceRecordingRequest();
    // Decide if the onboarding modal needs to show first.
    if (voicePref && voicePref.voiceOnboardedAt === null) {
      setShowOnboarding(true);
    } else {
      // Slight delay so the panel slide-in settles before mic prompts perms.
      window.setTimeout(() => {
        voiceButtonRef.current?.start().catch(() => {});
      }, 260);
    }
  }, [open, voicePanel, voicePref]);

  // ── Scroll to bottom on new messages ───────────────────────────────────
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, streaming]);

  // ── Auto-focus textarea on open ────────────────────────────────────────
  useEffect(() => {
    if (open) {
      const t = setTimeout(() => textareaRef.current?.focus(), 220);
      return () => clearTimeout(t);
    }
  }, [open]);

  // ── Esc to close ───────────────────────────────────────────────────────
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (tts.isSpeaking) {
          tts.stop();
          return;
        }
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose, tts]);

  // ── Clean up TTS when panel closes ─────────────────────────────────────
  useEffect(() => {
    if (!open) {
      tts.stop();
      lastFeedRef.current = { msgIndex: -1, len: 0 };
    }
  }, [open, tts]);

  const handleSend = async () => {
    if (!input.trim() || streaming) return;
    const text = input.trim();
    setInput('');
    await sendMessage(text);
  };

  const handleVoiceTranscript = async (text: string) => {
    if (!text) return;
    // Auto-send per locked product decision — no review step.
    await sendMessage(text);
  };

  const handleStartRecordingFromMic = () => {
    // Mic-tap-during-TTS = 4th interrupt path: stop playback immediately.
    if (tts.isSpeaking) tts.stop();
  };

  const handleSpeakerToggle = async () => {
    if (!voicePref) return;
    const next = !voicePref.voiceRepliesEnabled;
    // If we're turning OFF mid-utterance, stop right away.
    if (!next) tts.stop();

    // Optimistic update.
    setVoicePref({ ...voicePref, voiceRepliesEnabled: next });
    try {
      const res = await fetchWithAuth('/api/agent/voice-preference', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ voiceReplies: next }),
      });
      if (!res.ok) {
        setVoicePref({ ...voicePref, voiceRepliesEnabled: !next });  // rollback
      } else {
        const body = await res.json();
        setVoicePref(body.data as VoicePreferenceResponse);
      }
    } catch { /* leave optimistic state */ }
  };

  const handleOnboardingDone = ({ voiceReplies }: { voiceReplies: boolean }) => {
    setShowOnboarding(false);
    // Reflect the just-saved state and stamp onboarded-at locally so the
    // modal doesn't re-trigger on the next mic tap before the GET refreshes.
    setVoicePref((prev) => prev ? {
      ...prev,
      voiceRepliesEnabled: voiceReplies,
      voiceOnboardedAt: new Date().toISOString(),
    } : prev);
    // Now proceed with the recording the user was originally trying to start.
    window.setTimeout(() => {
      voiceButtonRef.current?.start().catch(() => {});
    }, 80);
  };

  if (!open) return null;

  return (
    <>
      {/* Backdrop — clicking it closes the panel on desktop. */}
      <div
        onClick={onClose}
        aria-hidden
        style={{
          position: 'fixed', inset: 0,
          background: 'rgba(31, 35, 28, 0.15)',
          zIndex: 80,
          animation: 'staxis-fade-in 0.18s ease-out',
        }}
      />

      <aside
        role="dialog"
        aria-label="Staxis chat"
        style={{
          position: 'fixed',
          top: 0, right: 0,
          height: '100vh',
          width: 'min(420px, 100vw)',
          background: C.bg,
          borderLeft: `1px solid ${C.rule}`,
          boxShadow: '-12px 0 32px rgba(31, 35, 28, 0.06)',
          zIndex: 81,
          display: 'flex',
          flexDirection: 'column',
          animation: 'staxis-slide-in 0.22s ease-out',
        }}
      >
        {/* Header */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '16px 16px 12px 20px',
          borderBottom: `1px solid ${C.rule}`,
        }}>
          <div>
            <div style={{
              fontFamily: FONT_SERIF,
              fontSize: 24,
              lineHeight: 1,
              color: C.ink,
              letterSpacing: '-0.01em',
            }}>
              Staxis
            </div>
            <div style={{
              marginTop: 2,
              fontFamily: FONT_MONO,
              fontSize: 9,
              textTransform: 'uppercase',
              letterSpacing: '0.1em',
              color: C.ink3,
            }}>
              Quick chat
            </div>
          </div>
          <div style={{ display: 'flex', gap: 4 }}>
            <button
              onClick={startNew}
              title="New conversation"
              aria-label="New conversation"
              style={iconBtnStyle}
              onMouseEnter={(e) => { e.currentTarget.style.background = C.ruleSoft; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
            >
              <Plus size={15} strokeWidth={2.2} color={C.ink2} />
            </button>
            <button
              onClick={handleSpeakerToggle}
              title={speakerOn ? 'Mute voice replies' : 'Speak responses out loud'}
              aria-label={speakerOn ? 'Mute voice replies' : 'Speak responses out loud'}
              aria-pressed={speakerOn}
              style={iconBtnStyle}
              onMouseEnter={(e) => { e.currentTarget.style.background = C.ruleSoft; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
            >
              {speakerOn ? (
                <Volume2 size={15} strokeWidth={2.2} color={C.sageDeep} />
              ) : (
                <VolumeX size={15} strokeWidth={2.2} color={C.ink2} />
              )}
            </button>
            <Link
              href="/chat"
              title="Open full chat"
              aria-label="Open full chat"
              style={{ ...iconBtnStyle, textDecoration: 'none' }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = C.ruleSoft; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
            >
              <ExternalLink size={15} strokeWidth={2.2} color={C.ink2} />
            </Link>
            <button
              onClick={onClose}
              aria-label="Close"
              style={iconBtnStyle}
              onMouseEnter={(e) => { e.currentTarget.style.background = C.ruleSoft; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
            >
              <X size={16} strokeWidth={2.2} color={C.ink2} />
            </button>
          </div>
        </div>

        {/* Messages */}
        <div
          ref={scrollRef}
          style={{ flex: 1, overflowY: 'auto', scrollBehavior: 'smooth', position: 'relative' }}
        >
          <MessageList
            messages={messages}
            streaming={streaming}
            emptyHint={
              <>
                Ask anything. Try{' '}
                <em style={{ color: C.ink2 }}>&ldquo;what&rsquo;s the occupancy&rdquo;</em> or{' '}
                <em style={{ color: C.ink2 }}>&ldquo;mark 302 clean&rdquo;</em>.
              </>
            }
          />
          {error && (
            <div style={{
              margin: '8px 16px 16px',
              padding: '10px 12px',
              background: 'rgba(184, 92, 61, 0.08)',
              border: '1px solid rgba(184, 92, 61, 0.20)',
              borderRadius: 8,
              color: 'var(--snow-warm, #B85C3D)',
              fontFamily: FONT_SANS,
              fontSize: 13,
            }}>
              {error}
            </div>
          )}
        </div>

        {/* Stop overlay — visible only while TTS is playing. Sits ABOVE the
            messages list AND below the composer. */}
        <StopStaxisOverlay visible={tts.isSpeaking} onStop={() => tts.stop()} />

        {/* Composer */}
        <div style={{
          padding: '12px 16px 16px',
          borderTop: `1px solid ${C.rule}`,
          background: C.bg,
          position: 'relative',
          zIndex: 12, // above StopStaxisOverlay's tap-catcher
        }}>
          <div style={{ position: 'relative' }}>
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void handleSend();
                }
              }}
              placeholder="Ask Staxis…"
              disabled={streaming}
              rows={1}
              style={{
                width: '100%',
                resize: 'none',
                padding: '12px 80px 12px 14px',  // room for mic + send buttons
                fontFamily: FONT_SANS,
                fontSize: 14,
                lineHeight: 1.5,
                color: C.ink,
                background: C.bg,
                border: `1px solid ${C.rule}`,
                borderRadius: 12,
                outline: 'none',
                minHeight: 44,
                maxHeight: 160,
              }}
              onFocus={(e) => { e.currentTarget.style.borderColor = C.sageDeep; }}
              onBlur={(e) => { e.currentTarget.style.borderColor = C.rule; }}
            />
            <div style={{
              position: 'absolute',
              right: 8, bottom: 8,
              display: 'flex',
              gap: 6,
              alignItems: 'center',
            }}>
              <VoiceButton
                ref={voiceButtonRef}
                propertyId={propertyId}
                conversationId={conversationId}
                size="small"
                disabled={streaming}
                onTranscript={handleVoiceTranscript}
                onStartRecording={handleStartRecordingFromMic}
              />
              <button
                onClick={handleSend}
                disabled={streaming || !input.trim()}
                aria-label="Send"
                style={{
                  width: 28, height: 28,
                  borderRadius: 7,
                  border: 'none',
                  cursor: streaming || !input.trim() ? 'default' : 'pointer',
                  background: streaming || !input.trim() ? C.rule : C.ink,
                  color: streaming || !input.trim() ? C.ink3 : 'white',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Send size={13} strokeWidth={2.5} />
              </button>
            </div>
          </div>
        </div>
      </aside>

      <VoiceReplyOnboardingModal
        open={showOnboarding}
        onDone={handleOnboardingDone}
        onDismiss={() => setShowOnboarding(false)}
      />
    </>
  );
}

const iconBtnStyle: React.CSSProperties = {
  width: 30, height: 30,
  background: 'transparent',
  border: 'none',
  cursor: 'pointer',
  borderRadius: 6,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
};
