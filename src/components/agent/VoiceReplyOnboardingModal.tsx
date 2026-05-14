'use client';

// ─── VoiceReplyOnboardingModal — first-time voice opt-in ─────────────────
//
// Shows the very first time a user taps the mic OR triggers the wake word
// AND their accounts.voice_onboarded_at is still NULL. Records their
// choice (yes/no), stamps voice_onboarded_at, and never shows again.
//
// Even if they pick "No", the speaker toggle in the ChatPanel header
// stays visible — they can flip voice replies on later without re-prompt.

import { fetchWithAuth } from '@/lib/api-fetch';
import { useState } from 'react';
import { X } from 'lucide-react';

const C = {
  bg:       'var(--snow-bg, #FFFFFF)',
  ink:      'var(--snow-ink, #1F231C)',
  ink2:     'var(--snow-ink2, #5C625C)',
  rule:     'var(--snow-rule, rgba(31, 35, 28, 0.08))',
  sageDeep: 'var(--snow-sage-deep, #5C7A60)',
};

const FONT_SANS  = "var(--font-geist), -apple-system, BlinkMacSystemFont, sans-serif";
const FONT_SERIF = "var(--font-instrument-serif), 'Times New Roman', Georgia, serif";

export interface VoiceReplyOnboardingModalProps {
  open: boolean;
  onDone: (chosen: { voiceReplies: boolean }) => void;
  onDismiss: () => void;
}

export function VoiceReplyOnboardingModal({ open, onDone, onDismiss }: VoiceReplyOnboardingModalProps) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  const choose = async (voiceReplies: boolean) => {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetchWithAuth('/api/agent/voice-preference', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ voiceReplies }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError(body?.error ?? 'Couldn\'t save your choice — try again.');
        return;
      }
      onDone({ voiceReplies });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Voice replies setup"
      style={{
        position: 'fixed', inset: 0, zIndex: 200,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'rgba(31, 35, 28, 0.32)',
        padding: 16,
        animation: 'staxis-fade-in 0.18s ease-out',
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onDismiss(); }}
    >
      <div
        style={{
          width: 'min(420px, 100%)',
          background: C.bg,
          borderRadius: 16,
          padding: '28px 28px 24px',
          boxShadow: '0 20px 60px rgba(31, 35, 28, 0.18)',
          animation: 'staxis-pop-in 0.2s ease-out',
          position: 'relative',
        }}
      >
        <button
          onClick={onDismiss}
          aria-label="Close"
          style={{
            position: 'absolute', top: 12, right: 12,
            width: 28, height: 28,
            border: 'none', cursor: 'pointer',
            borderRadius: 6, background: 'transparent',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
        >
          <X size={15} color={C.ink2} />
        </button>

        <div style={{
          fontFamily: FONT_SERIF,
          fontSize: 30,
          lineHeight: 1.1,
          color: C.ink,
          letterSpacing: '-0.01em',
          marginBottom: 10,
        }}>
          Want me to talk back to you?
        </div>
        <p style={{
          fontFamily: FONT_SANS,
          fontSize: 14,
          lineHeight: 1.5,
          color: C.ink2,
          margin: '0 0 22px',
        }}>
          When you ask Staxis something out loud, I can read the answer to you in a friendly voice — so you can keep your hands free.
          You can change this anytime from the speaker icon at the top of the chat.
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <button
            onClick={() => void choose(true)}
            disabled={saving}
            style={{
              padding: '14px 18px',
              fontFamily: FONT_SANS, fontSize: 15, fontWeight: 600,
              color: 'white',
              background: saving ? C.rule : C.sageDeep,
              border: 'none', borderRadius: 12,
              cursor: saving ? 'default' : 'pointer',
              textAlign: 'left',
            }}
          >
            Yes, talk to me
          </button>
          <button
            onClick={() => void choose(false)}
            disabled={saving}
            style={{
              padding: '14px 18px',
              fontFamily: FONT_SANS, fontSize: 15, fontWeight: 600,
              color: C.ink,
              background: 'transparent',
              border: `1px solid ${C.rule}`,
              borderRadius: 12,
              cursor: saving ? 'default' : 'pointer',
              textAlign: 'left',
            }}
          >
            No, just type
          </button>
        </div>

        {error && (
          <div style={{
            marginTop: 14,
            fontFamily: FONT_SANS, fontSize: 13,
            color: 'var(--snow-warm, #B85C3D)',
          }}>
            {error}
          </div>
        )}
      </div>
    </div>
  );
}
