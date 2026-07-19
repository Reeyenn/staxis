'use client';

/* ───────────────────────────────────────────────────────────────────────
   Shared dark-surface chrome used by every Studio surface, so the five
   screens stay visually identical where they overlap (dark stage card,
   per-surface radial glow, translucent-white cards, modal backdrop).

   Each surface picks its glow per the design handoff:
     Onboarding  forestTR   Live  tealTL   System  forestTop
     Money       forestTR   ML    tealTL
   ─────────────────────────────────────────────────────────────────────── */

import React from 'react';
import { FONT_SERIF } from './kit';

// Translucent white at opacity `a` — for text/borders/cards on the dark ink.
export const dimWhite = (a: number) => `rgba(255,255,255,${a})`;

export const GLOW: Record<string, string> = {
  forestTR:  'radial-gradient(120% 80% at 100% 0%, rgba(60,156,104,.14), transparent 60%)',
  tealTL:    'radial-gradient(120% 80% at 0% 0%, rgba(51,137,160,.16), transparent 60%)',
  forestTop: 'radial-gradient(100% 80% at 50% 0%, rgba(60,156,104,.13), transparent 62%)',
  tealTop:   'radial-gradient(100% 80% at 50% 0%, rgba(51,137,160,.14), transparent 62%)',
};

/** Full-bleed dark page scope — breaks out of the app's centered column to
 *  paint the ink canvas edge-to-edge under a studio route. The three admin
 *  studio pages (mapper, coverage) each hand-wrote this. */
export function DarkScope({ children }: { children: React.ReactNode }) {
  return (
    <div className="admin-studio" style={{
      background: 'var(--ink)', color: '#fff',
      marginLeft: 'calc(50% - 50vw)', marginRight: 'calc(50% - 50vw)',
      minHeight: 'calc(100vh - 64px)',
    }}>
      {children}
    </div>
  );
}

/** Dark editorial stage section with a configurable radial glow. Seamless
 *  with the full-bleed dark admin canvas (no card chrome) — just padding +
 *  the per-surface glow over the shared ink background. */
export function SurfaceShell({ glow = 'forestTR', children, style }: { glow?: keyof typeof GLOW | string; children: React.ReactNode; style?: React.CSSProperties }) {
  const bg = GLOW[glow] ?? glow;
  return (
    <div style={{ background: 'transparent', padding: '24px 32px 8px', color: '#fff', position: 'relative', ...style }}>
      <div style={{ position: 'absolute', inset: 0, background: bg, pointerEvents: 'none' }} />
      <div style={{ position: 'relative' }}>{children}</div>
    </div>
  );
}

/** Translucent-white card on dark — the standard panel on every surface. */
export function DarkCard({ children, style, onClick }: { children: React.ReactNode; style?: React.CSSProperties; onClick?: (e: React.MouseEvent) => void }) {
  return (
    <div onClick={onClick} style={{ background: dimWhite(.06), border: `1px solid ${dimWhite(.14)}`, borderRadius: 14, padding: '14px 16px', ...style }}>
      {children}
    </div>
  );
}

/** Loading spinner sized for a dark surface. */
export function DarkSpinner({ size = 22 }: { size?: number }) {
  return <span className="spinner" style={{ width: size, height: size, display: 'inline-block', borderColor: dimWhite(.2), borderTopColor: '#fff' }} />;
}

/** Dashed empty-state on dark. */
export function DarkEmpty({ text }: { text: string }) {
  return <div style={{ padding: '16px 14px', textAlign: 'center', border: `1px dashed ${dimWhite(.18)}`, borderRadius: 12, color: dimWhite(.45), fontFamily: FONT_SERIF, fontStyle: 'italic', fontSize: 13 }}>{text}</div>;
}

/** A surface header: dim caps eyebrow + serif headline with one italic span. */
export function SurfaceHead({ caps, children, right }: { caps: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <header style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', marginBottom: 22, position: 'relative' }}>
      <div style={{ minWidth: 0 }}>
        <span className="caps" style={{ color: dimWhite(.55) }}>{caps}</span>
        <h1 style={{ fontFamily: FONT_SERIF, fontSize: 32, fontWeight: 400, letterSpacing: '-0.02em', margin: '4px 0 0', color: '#fff', lineHeight: 1.1 }}>{children}</h1>
      </div>
      {right}
    </header>
  );
}

// ── Modals — light card on a blurred ink backdrop, click-outside closes ──
export const MODAL_CARD: React.CSSProperties = {
  background: '#fff',
  borderRadius: 18,
  padding: 26,
  width: 440,
  maxWidth: '100%',
  maxHeight: 'calc(100dvh - 48px)',
  overflowY: 'auto',
  boxShadow: 'var(--shadow-lg)',
  color: 'var(--ink)',
};

export function Backdrop({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div
      data-studio-modal-backdrop
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 200,
        background: 'rgba(24,22,17,.5)',
        backdropFilter: 'blur(4px)', WebkitBackdropFilter: 'blur(4px)',
        overflowY: 'auto', padding: 24,
      }}
    >
      <div style={{ minHeight: '100%', width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {children}
      </div>
    </div>
  );
}
