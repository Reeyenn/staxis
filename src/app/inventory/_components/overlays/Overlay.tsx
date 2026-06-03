'use client';

import React, { useEffect, useRef } from 'react';
import { T, fonts } from '../tokens';
import { Caps } from '../Caps';
import { Serif } from '../Serif';

// Triage modal shell used by every overlay. Click-outside or ESC closes.
// Blurred ink scrim, white card (radius 18), eyebrow + serif title header with
// a rounded-square ✕, optional left accent stripe, scrollable body, optional
// sticky footer. Entrance via WAAPI (plays under prefers-reduced-motion).
interface OverlayProps {
  open: boolean;
  onClose: () => void;
  title?: React.ReactNode;
  italic?: React.ReactNode;
  suffix?: React.ReactNode;
  eyebrow?: React.ReactNode;
  accent?: string;
  width?: number;
  /** Full-screen variant (e.g. the walk & tally count sheet). */
  full?: boolean;
  footer?: React.ReactNode;
  children?: React.ReactNode;
}

export function Overlay({
  open,
  onClose,
  title,
  italic,
  suffix,
  eyebrow,
  accent,
  width = 1080,
  full = false,
  footer,
  children,
}: OverlayProps) {
  const scrimRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  // WAAPI entrance — fill:'none' so the resting state is the element's own
  // visible style (never stuck invisible if the timeline is throttled).
  useEffect(() => {
    if (!open) return;
    scrimRef.current?.animate(
      [{ opacity: 0 }, { opacity: 1 }],
      { duration: 180, delay: 20, easing: 'ease-out', fill: 'none' },
    );
    cardRef.current?.animate(
      [
        { opacity: 0, transform: full ? 'scale(.99)' : 'translateY(14px) scale(.985)' },
        { opacity: 1, transform: 'none' },
      ],
      { duration: 300, delay: 20, easing: 'cubic-bezier(.16,.84,.3,1)', fill: 'none' },
    );
  }, [open, full]);

  if (!open) return null;

  return (
    <div
      ref={scrimRef}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 2000,
        background: 'rgba(24,22,17,0.28)',
        backdropFilter: 'blur(2px)',
        WebkitBackdropFilter: 'blur(2px)',
        display: 'flex',
        alignItems: full ? 'stretch' : 'center',
        justifyContent: 'center',
        padding: full ? 0 : '32px 24px',
        overflow: 'auto',
      }}
    >
      <div
        ref={cardRef}
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          width: full ? '100%' : `min(100%, ${width}px)`,
          maxHeight: full ? '100%' : '90vh',
          background: T.bg,
          borderRadius: full ? 0 : 18,
          border: full ? 'none' : `1px solid ${T.rule}`,
          boxShadow: full ? 'none' : '0 30px 80px -20px rgba(24,22,17,0.35)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            padding: '18px 26px',
            borderBottom: `1px solid ${T.rule}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 20,
            position: 'relative',
          }}
        >
          {accent && (
            <span
              style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 4, background: accent }}
            />
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
            {eyebrow && <Caps color={accent}>{eyebrow}</Caps>}
            <span>
              <Serif size={24}>
                {italic}
                {italic && title ? ' ' : null}
                {title}
              </Serif>
              {suffix && (
                <span style={{ fontFamily: fonts.sans, fontSize: 13, color: T.dim, marginLeft: 8 }}>
                  {suffix}
                </span>
              )}
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{
              width: 30,
              height: 30,
              borderRadius: 8,
              cursor: 'pointer',
              background: 'transparent',
              border: `1px solid ${T.rule}`,
              color: T.ink2,
              fontFamily: fonts.sans,
              fontSize: 16,
              lineHeight: 1,
              flex: 'none',
            }}
          >
            ✕
          </button>
        </div>
        <div style={{ padding: full ? '24px 48px 64px' : '22px 26px 26px', flex: 1, overflow: 'auto' }}>
          {children}
        </div>
        {footer && (
          <div
            style={{
              padding: '14px 26px',
              borderTop: `1px solid ${T.rule}`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'flex-end',
              gap: 10,
              flexWrap: 'wrap',
              background: T.bg,
            }}
          >
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
