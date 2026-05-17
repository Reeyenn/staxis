'use client';

import React, { useEffect } from 'react';
import { T, fonts } from '../tokens';
import { Caps } from '../Caps';

// Modal shell used by every overlay. Click-outside or ESC closes.
// Optional accent stripe on the left of the header, sticky header,
// scrollable body, optional sticky footer.
interface OverlayProps {
  open: boolean;
  onClose: () => void;
  title?: React.ReactNode;
  italic?: React.ReactNode;
  suffix?: React.ReactNode;
  eyebrow?: React.ReactNode;
  accent?: string;
  width?: number;
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
  footer,
  children,
}: OverlayProps) {
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

  if (!open) return null;

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        background: 'rgba(31,35,28,0.32)',
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        padding: '40px 24px',
        overflow: 'auto',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%',
          maxWidth: width,
          background: T.paper,
          borderRadius: 22,
          border: `1px solid ${T.rule}`,
          boxShadow: '0 24px 60px rgba(31,35,28,0.18)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          minHeight: 200,
          maxHeight: 'calc(100vh - 80px)',
        }}
      >
        <div
          style={{
            padding: '22px 28px 18px',
            borderBottom: `1px solid ${T.rule}`,
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            gap: 18,
            position: 'relative',
          }}
        >
          {accent && (
            <span
              style={{
                position: 'absolute',
                left: 0,
                top: 0,
                bottom: 0,
                width: 4,
                background: accent,
              }}
            />
          )}
          <div style={{ minWidth: 0 }}>
            {eyebrow && <Caps>{eyebrow}</Caps>}
            <h2
              style={{
                fontFamily: fonts.serif,
                fontSize: 28,
                color: T.ink,
                margin: '4px 0 0',
                letterSpacing: '-0.02em',
                fontWeight: 400,
                lineHeight: 1.2,
              }}
            >
              {italic && <span style={{ fontStyle: 'italic' }}>{italic}</span>}
              {italic && title ? ' ' : null}
              {title}
              {suffix && <span style={{ color: T.ink3 }}> · {suffix}</span>}
            </h2>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{
              width: 34,
              height: 34,
              borderRadius: '50%',
              cursor: 'pointer',
              background: 'transparent',
              border: `1px solid ${T.rule}`,
              color: T.ink2,
              fontSize: 14,
              lineHeight: 1,
              flexShrink: 0,
            }}
          >
            ✕
          </button>
        </div>
        <div style={{ padding: '24px 28px', flex: 1, overflow: 'auto' }}>
          {children}
        </div>
        {footer && (
          <div
            style={{
              padding: '16px 28px',
              borderTop: `1px solid ${T.rule}`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'flex-end',
              gap: 8,
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
