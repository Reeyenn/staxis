'use client';

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { T, fonts } from '../tokens';
import { Caps } from '../Caps';
import { Serif } from '../Serif';
import { EASE } from '../motion';

// SSR-safe layout effect: the entrance animation must apply its hidden
// start-state BEFORE the first paint (see the entrance effect below), which a
// plain useEffect (runs after paint) can't do. On the server it falls back to
// useEffect so React doesn't warn.
const useIsoLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

// Triage modal shell used by every overlay. Click-outside or ESC closes.
// Blurred ink scrim, white card (radius 18), eyebrow + serif title header with
// a rounded-square ✕, optional left accent stripe, scrollable body, optional
// sticky footer.
//
// Motion: spring-up entrance and a short settle-down exit. The card stays
// mounted for ~200ms after `open` flips false so the exit can play (presence
// management) — callers keep the exact same `open`/`onClose` contract.
// WAAPI throughout, so it plays under prefers-reduced-motion.
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

const EXIT_MS = 190;

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
  // Presence: keep rendering during the exit animation, then unmount.
  const [render, setRender] = useState(open);

  useEffect(() => {
    if (open) {
      setRender(true);
      return;
    }
    if (!render) return;
    scrimRef.current?.animate(
      [{ opacity: 1 }, { opacity: 0 }],
      { duration: EXIT_MS, easing: 'ease-in', fill: 'forwards' },
    );
    cardRef.current?.animate(
      [
        { opacity: 1, transform: 'none' },
        { opacity: 0, transform: full ? 'scale(.99)' : 'translateY(12px) scale(.985)' },
      ],
      { duration: EXIT_MS, easing: 'ease-in', fill: 'forwards' },
    );
    const timer = setTimeout(() => setRender(false), EXIT_MS + 30);
    return () => clearTimeout(timer);
  }, [open, full, render]);

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

  // WAAPI entrance. Runs as a LAYOUT effect so the from-keyframe (opacity 0)
  // takes effect BEFORE the first paint of the freshly-mounted card. With a
  // plain useEffect the card paints once at its resting style, then the
  // animation restarts it from the start — that "settled → gone → animate in"
  // flash reads as the modal flickering / popping up twice (Reeyen, 2026-07-14).
  // delay is dropped (was 10ms) for the same reason: with fill:'none' a pre-
  // active delay window would show the resting style. fill stays 'none' so the
  // resting state after the animation is the element's own visible style (never
  // stuck invisible if the timeline is throttled). Keyed on `render` too: the
  // first open mounts the DOM one commit after `open` flips, when the refs exist.
  useIsoLayoutEffect(() => {
    if (!open || !render) return;
    scrimRef.current?.animate(
      [{ opacity: 0 }, { opacity: 1 }],
      { duration: 200, easing: 'ease-out', fill: 'none' },
    );
    cardRef.current?.animate(
      [
        { opacity: 0, transform: full ? 'scale(.985)' : 'translateY(20px) scale(.97)' },
        { opacity: 1, transform: 'none' },
      ],
      { duration: 380, easing: EASE.spring, fill: 'none' },
    );
  }, [open, render, full]);

  if (!render) return null;

  return (
    <div
      ref={scrimRef}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 2000,
        background: 'rgba(31,35,28,0.28)',
        backdropFilter: 'blur(3px)',
        WebkitBackdropFilter: 'blur(3px)',
        display: 'flex',
        alignItems: full ? 'stretch' : 'center',
        justifyContent: 'center',
        padding: full ? 0 : '32px 24px',
        overflow: 'auto',
        pointerEvents: open ? 'auto' : 'none',
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
          boxShadow: full ? 'none' : '0 30px 80px -20px rgba(31,42,32,0.35)',
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
              borderRadius: 999,
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
