'use client';

import React, { useEffect, useLayoutEffect, useRef } from 'react';
import { T, fonts } from './tokens';
import { EASE } from './motion';

// A small Staxis-styled confirmation dialog — the custom replacement for the
// native browser confirm(). Centered card over a blurred ink scrim. ESC or a
// scrim click cancels; Enter or the primary button confirms. The confirm
// button auto-focuses. WAAPI entrance so it plays under prefers-reduced-motion,
// matching Overlay.tsx.
const useIsoLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message?: string;
  confirmLabel: string;
  cancelLabel: string;
  /** Style the confirm button as a destructive (rust) action. */
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  cancelLabel,
  danger,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const scrimRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  // Keyboard: ESC cancels, Enter confirms. Capture phase + stopPropagation so a
  // parent Overlay's window-level ESC handler never also fires.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onCancel(); }
      else if (e.key === 'Enter') { e.stopPropagation(); onConfirm(); }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [open, onCancel, onConfirm]);

  useIsoLayoutEffect(() => {
    if (!open) return;
    confirmRef.current?.focus();
    scrimRef.current?.animate(
      [{ opacity: 0 }, { opacity: 1 }],
      { duration: 160, easing: 'ease-out', fill: 'none' },
    );
    cardRef.current?.animate(
      [
        { opacity: 0, transform: 'translateY(10px) scale(.97)' },
        { opacity: 1, transform: 'none' },
      ],
      { duration: 260, easing: EASE.spring, fill: 'none' },
    );
  }, [open]);

  if (!open) return null;

  return (
    <div
      ref={scrimRef}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}
      style={{
        position: 'fixed', inset: 0, zIndex: 3000,
        background: 'rgba(31,35,28,0.34)',
        backdropFilter: 'blur(3px)', WebkitBackdropFilter: 'blur(3px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
      }}
    >
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          width: 'min(100%, 380px)', background: T.bg, borderRadius: 16,
          border: `1px solid ${T.rule}`, boxShadow: '0 30px 80px -20px rgba(31,42,32,0.4)',
          padding: '22px 22px 18px',
        }}
      >
        <div style={{ fontFamily: fonts.sans, fontSize: 16, fontWeight: 600, color: T.ink, marginBottom: message ? 8 : 16 }}>
          {title}
        </div>
        {message && (
          <div style={{ fontFamily: fonts.sans, fontSize: 13.5, lineHeight: 1.5, color: T.ink2, marginBottom: 18 }}>
            {message}
          </div>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
          <button
            type="button"
            onClick={onCancel}
            style={{
              height: 36, padding: '0 16px', borderRadius: 999, cursor: 'pointer',
              background: 'transparent', border: `1px solid ${T.rule}`, color: T.ink2,
              fontFamily: fonts.sans, fontSize: 13, fontWeight: 500,
            }}
          >
            {cancelLabel}
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={onConfirm}
            style={{
              height: 36, padding: '0 18px', borderRadius: 999, cursor: 'pointer',
              background: danger ? T.terra : T.ink, border: '1px solid transparent', color: '#FFFFFF',
              fontFamily: fonts.sans, fontSize: 13, fontWeight: 600,
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
