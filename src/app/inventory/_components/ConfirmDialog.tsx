'use client';

import React, { useEffect, useId, useLayoutEffect, useRef } from 'react';
import { T, fonts } from './tokens';
import { EASE } from './motion';

// A small Staxis-styled confirmation dialog — the custom replacement for the
// native browser confirm(). Centered card over a blurred ink scrim. ESC or a
// scrim click cancels; Enter or the primary button confirms. The confirm
// button auto-focuses. WAAPI entrance is skipped when the guest has requested
// reduced motion.
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
  const titleId = useId();
  const messageId = useId();
  const scrimRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  useIsoLayoutEffect(() => {
    if (!open) return;
    returnFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    return () => {
      const target = returnFocusRef.current;
      returnFocusRef.current = null;
      if (target?.isConnected) requestAnimationFrame(() => target.focus());
    };
  }, [open]);

  // Keyboard: ESC cancels and Tab stays within the two dialog actions. Native
  // button activation owns Enter/Space; a document-level Enter handler would
  // wrongly confirm even while keyboard focus is on Cancel.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onCancel();
      } else if (e.key === 'Tab') {
        const actions = [cancelRef.current, confirmRef.current].filter(
          (action): action is HTMLButtonElement => action !== null,
        );
        if (actions.length === 0) return;
        const current = actions.indexOf(document.activeElement as HTMLButtonElement);
        const next = e.shiftKey
          ? (current <= 0 ? actions.length - 1 : current - 1)
          : (current < 0 || current === actions.length - 1 ? 0 : current + 1);
        e.preventDefault();
        e.stopPropagation();
        actions[next]?.focus();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [open, onCancel, onConfirm]);

  useIsoLayoutEffect(() => {
    if (!open) return;
    confirmRef.current?.focus();
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
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
      onMouseDown={(e) => { if (!danger && e.target === e.currentTarget) onCancel(); }}
      style={{
        position: 'fixed', inset: 0, zIndex: 3000,
        background: 'rgba(31,35,28,0.34)',
        backdropFilter: 'blur(3px)', WebkitBackdropFilter: 'blur(3px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
      }}
    >
      <div
        ref={cardRef}
        role={danger ? 'alertdialog' : 'dialog'}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={message ? messageId : undefined}
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          width: 'min(100%, 380px)', background: T.bg, borderRadius: 16,
          border: `1px solid ${T.rule}`, boxShadow: '0 30px 80px -20px rgba(31,42,32,0.4)',
          padding: '22px 22px 18px',
        }}
      >
        <div id={titleId} style={{ fontFamily: fonts.sans, fontSize: 16, fontWeight: 600, color: T.ink, marginBottom: message ? 8 : 16 }}>
          {title}
        </div>
        {message && (
          <div id={messageId} style={{ fontFamily: fonts.sans, fontSize: 13.5, lineHeight: 1.5, color: T.ink2, marginBottom: 18 }}>
            {message}
          </div>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            style={{
              minHeight: 44, padding: '0 16px', borderRadius: 999, cursor: 'pointer',
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
              minHeight: 44, padding: '0 18px', borderRadius: 999, cursor: 'pointer',
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
