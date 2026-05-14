'use client';

// ─── StopStaxisOverlay — interrupt button + tap-anywhere catcher ─────────
//
// Renders only while TTS is playing. Two interrupt affordances:
//   1. A big "Stop" button in the center-bottom of the ChatPanel — the
//      discoverable mechanism.
//   2. A transparent surface that covers the rest of the panel and
//      forwards any tap to the same stop() handler — the power-user
//      shortcut documented as "tap anywhere to interrupt."
//
// The mic button itself ALSO interrupts (4th path), but it lives in the
// composer and isn't covered by this overlay — it stays interactive so a
// single tap stops TTS AND begins recording.
//
// This component is positioned absolutely; the parent should be `position:
// relative` for proper z-ordering.

import { Square } from 'lucide-react';

const C = {
  ink:  'var(--snow-ink, #1F231C)',
  ink2: 'var(--snow-ink2, #5C625C)',
  warm: 'var(--snow-warm, #B85C3D)',
};

const FONT_SANS = "var(--font-geist), -apple-system, BlinkMacSystemFont, sans-serif";
const FONT_MONO = "var(--font-geist-mono), ui-monospace, monospace";

export interface StopStaxisOverlayProps {
  visible: boolean;
  onStop: () => void;
  /** Optional offset from the panel bottom so the button doesn't collide
   *  with the composer. Defaults to a reasonable inset. */
  bottomOffset?: number;
}

export function StopStaxisOverlay({ visible, onStop, bottomOffset = 100 }: StopStaxisOverlayProps) {
  if (!visible) return null;

  return (
    <>
      {/* Tap-anywhere catcher — covers the panel body. Doesn't sit over the
          composer (top: 0, bottom: ~76px from composer height + margin). */}
      <div
        onClick={onStop}
        aria-hidden
        style={{
          position: 'absolute',
          top: 0, left: 0, right: 0,
          bottom: bottomOffset,
          background: 'rgba(255, 255, 255, 0.6)',
          backdropFilter: 'blur(2px)',
          WebkitBackdropFilter: 'blur(2px)',
          zIndex: 10,
          cursor: 'pointer',
          animation: 'staxis-fade-in 0.16s ease-out',
        }}
      />
      {/* Big Stop button, center-bottom of the body. */}
      <button
        onClick={(e) => { e.stopPropagation(); onStop(); }}
        aria-label="Stop Staxis"
        style={{
          position: 'absolute',
          bottom: bottomOffset + 24,
          left: '50%',
          transform: 'translateX(-50%)',
          padding: '14px 22px',
          fontFamily: FONT_SANS,
          fontSize: 15,
          fontWeight: 600,
          color: 'white',
          background: C.ink,
          border: 'none',
          borderRadius: 999,
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          boxShadow: '0 8px 24px rgba(31, 35, 28, 0.20)',
          zIndex: 11,
          animation: 'staxis-pop-in 0.16s ease-out',
        }}
      >
        <Square size={13} fill="white" strokeWidth={0} />
        Stop
      </button>
      <div
        aria-hidden
        style={{
          position: 'absolute',
          bottom: bottomOffset + 4,
          left: 0, right: 0,
          textAlign: 'center',
          fontFamily: FONT_MONO,
          fontSize: 10,
          letterSpacing: '0.1em',
          textTransform: 'uppercase',
          color: C.ink2,
          zIndex: 11,
          pointerEvents: 'none',
        }}
      >
        Tap anywhere to interrupt
      </div>
    </>
  );
}
