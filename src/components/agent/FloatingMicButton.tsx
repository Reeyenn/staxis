'use client';

// ─── FloatingMicButton — page-level voice FAB ────────────────────────────
//
// Sits in the bottom-right corner of every page, above the existing
// FloatingChatButton. Tap to open the floating ChatPanel AND immediately
// start recording on its embedded VoiceButton. One tap, end-to-end.
//
// We piggy-back on VoicePanelContext: openPanelAndRecord() flips the
// panel open AND sets `voiceRecordingRequested`. ChatPanel watches that
// flag and triggers its VoiceButton.start() on next render.
//
// Hidden if no propertyId is configured (a logged-out user, or before
// the AuthContext loads). Aria-hidden during the panel-open animation
// so screen readers don't double-announce.

import { Mic } from 'lucide-react';
import { useVoicePanel } from './VoicePanelContext';

const C = {
  ink:  'var(--snow-ink, #1F231C)',
  ink2: 'var(--snow-ink2, #5C625C)',
  bg:   'var(--snow-bg, #FFFFFF)',
};

export interface FloatingMicButtonProps {
  /** Hides the button when no property is in scope. */
  available: boolean;
}

export function FloatingMicButton({ available }: FloatingMicButtonProps) {
  const ctx = useVoicePanel();
  if (!ctx || !available) return null;

  // Don't double-up the buttons while the panel is open — the embedded
  // VoiceButton inside ChatPanel takes over from here.
  if (ctx.panelOpen) return null;

  return (
    <button
      type="button"
      onClick={() => ctx.openPanelAndRecord()}
      aria-label="Talk to Staxis"
      title="Talk to Staxis"
      style={{
        position: 'fixed',
        right: 'max(20px, env(safe-area-inset-right, 20px))',
        // Stacks ABOVE the existing FloatingChatButton (52px tall, at
        // bottom: 84). 84 + 52 + 12 gap = 148. Uses the same safe-area
        // inset math so both buttons handle notched mobile correctly.
        bottom: 'calc(max(20px, env(safe-area-inset-bottom, 20px)) + 128px)',
        width: 56,
        height: 56,
        borderRadius: 28,
        background: C.ink,
        color: C.bg,
        border: 'none',
        cursor: 'pointer',
        boxShadow: '0 8px 22px rgba(31, 35, 28, 0.22)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 79, // just below ChatPanel (80/81)
        transition: 'transform 0.16s ease',
      }}
      onMouseDown={(e) => { e.currentTarget.style.transform = 'scale(0.94)'; }}
      onMouseUp={(e) => { e.currentTarget.style.transform = 'scale(1)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.transform = 'scale(1)'; }}
    >
      <Mic size={24} strokeWidth={2.2} />
    </button>
  );
}
