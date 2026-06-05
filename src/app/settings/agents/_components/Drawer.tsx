'use client';

// Right-side drawer for run receipts. No shared focus-trap util exists in the
// repo, so it's hand-rolled here: initial focus, Tab/Shift-Tab cycle, focus
// restore on close, Esc to close, aria-modal + aria-labelledby, body-scroll lock.

import React, { useEffect, useId, useRef } from 'react';
import { X } from 'lucide-react';
import { T, fonts } from './_tokens';
import { s, type Lang } from '../_lib/strings';

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

export function Drawer({
  open, onClose, title, lang, children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  lang: Lang;
  children: React.ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const prevFocus = useRef<HTMLElement | null>(null);
  const titleId = useId();

  useEffect(() => {
    if (!open) return;
    prevFocus.current = (document.activeElement as HTMLElement | null) ?? null;
    const panel = panelRef.current;
    const initial = panel?.querySelector<HTMLElement>(FOCUSABLE);
    (initial ?? panel)?.focus();

    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
      if (e.key !== 'Tab' || !panel) return;
      const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => !el.hasAttribute('disabled') && el.getAttribute('aria-hidden') !== 'true',
      );
      if (items.length === 0) { e.preventDefault(); return; }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
    }

    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
      prevFocus.current?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{ position: 'fixed', inset: 0, background: 'rgba(31,35,28,0.28)', zIndex: 60, display: 'flex', justifyContent: 'flex-end' }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        style={{
          width: 'min(540px, 96vw)', height: '100vh', overflowY: 'auto',
          background: T.paper, borderLeft: `1px solid ${T.rule}`, padding: '20px 22px', outline: 'none',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14, gap: 12 }}>
          <h2 id={titleId} style={{ fontFamily: fonts.serif, fontSize: 24, color: T.ink, fontStyle: 'italic', margin: 0, fontWeight: 400, lineHeight: 1.15 }}>
            {title}
          </h2>
          <button
            onClick={onClose}
            aria-label={s(lang, 'close')}
            style={{
              background: 'transparent', border: `1px solid ${T.rule}`, borderRadius: 999,
              width: 32, height: 32, flexShrink: 0, display: 'inline-flex', alignItems: 'center',
              justifyContent: 'center', cursor: 'pointer', color: T.ink2,
            }}
          >
            <X size={16} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
