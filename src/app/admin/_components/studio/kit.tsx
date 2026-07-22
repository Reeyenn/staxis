'use client';

/* ───────────────────────────────────────────────────────────────────────
   Admin Studio — shared kit: tokens + primitives + motion + formatters.

   This is the production port of the design handoff's kit.jsx
   (window.KIT). Two differences from the prototype, both required by the
   codebase's accessibility standard:

     1. All motion respects `prefers-reduced-motion`. The prototype used
        WAAPI specifically to PLAY under reduce-motion; in production we do
        the opposite — we skip the tween but always leave the correct
        resting state (final number, final width, swapped face). Every
        helper below is written so the resting state is correct even if the
        animation never runs.

     2. Primitives are real React components (not window globals) and read
        their colors from the `.admin-studio`-scoped CSS vars in studio.css.

   Colors are referenced as `var(--forest)` etc. so a component works on
   both light and dark studio surfaces — the surface decides text color.
   ─────────────────────────────────────────────────────────────────────── */

import React, { useEffect, useLayoutEffect, useRef } from 'react';

// ── Font stacks (mirror studio.css --serif/--sans/--mono) ───────────────
export const FONT_SERIF = 'var(--serif)';
export const FONT_SANS  = 'var(--sans)';
export const FONT_MONO  = 'var(--mono)';

export const EASE = 'cubic-bezier(.22,.61,.36,1)';
export const EASE_OUT = 'cubic-bezier(.16,1,.3,1)';

// ── Reduced motion ──────────────────────────────────────────────────────
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; }
  catch { return false; }
}

type El = HTMLElement | null | undefined;

// Rise + fade in.
export function riseIn(el: El, { delay = 0, dy = 14, dur = 520 }: { delay?: number; dy?: number; dur?: number } = {}) {
  if (!el) return null;
  if (prefersReducedMotion() || typeof el.animate !== 'function') { el.style.opacity = '1'; el.style.transform = 'none'; return null; }
  return el.animate(
    [{ opacity: 0, transform: `translateY(${dy}px)` }, { opacity: 1, transform: 'translateY(0)' }],
    { duration: dur, delay, easing: EASE_OUT, fill: 'both' },
  );
}

// SSR-safe layout effect (falls back to useEffect on the server so React does
// not warn). Used by useRiseIn below.
const useIsoLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

// Run riseIn as a LAYOUT effect so its from-keyframe (opacity 0) is applied
// BEFORE the browser's first paint of the freshly-mounted element. Calling
// riseIn from a plain post-paint useEffect paints the element once at its
// resting (visible) style, then the animation snaps it to opacity 0 and eases
// back — that "settled → gone → animate in" flash reads as a dialog popping
// open twice. Mirrors the inventory Overlay entrance fix (2026-07-14). Safe by
// construction: riseIn sets opacity:1 outright under reduced motion, and its
// fill:'both' keyframes end visible, so nothing can be left stuck invisible.
export function useRiseIn<T extends HTMLElement>(
  ref: React.RefObject<T | null>,
  opts?: { delay?: number; dy?: number; dur?: number },
  deps: React.DependencyList = [],
) {
  useIsoLayoutEffect(() => {
    riseIn(ref.current, opts);
  }, deps);
}

// Count a number up from→to, writing formatted text into el. Resting value
// is set first so it's correct even if the frame clock never advances.
export function countUp(el: El, from: number, to: number, { dur = 900, fmt = (v: number) => Math.round(v).toLocaleString() }: { dur?: number; fmt?: (v: number) => string } = {}) {
  if (!el) return;
  el.textContent = fmt(to);
  if (prefersReducedMotion() || typeof requestAnimationFrame === 'undefined') return;
  const start = performance.now();
  function frame(now: number) {
    const k = Math.min(1, (now - start) / dur);
    const e = 1 - Math.pow(1 - k, 3);
    if (el) el.textContent = fmt(from + (to - from) * e);
    if (k < 1) requestAnimationFrame(frame);
    else if (el) el.textContent = fmt(to);
  }
  requestAnimationFrame(frame);
}

// Quick attention pulse (scale).
export function pulse(el: El, { scale = 1.06, dur = 360 }: { scale?: number; dur?: number } = {}) {
  if (!el || prefersReducedMotion() || typeof el.animate !== 'function') return;
  el.animate([{ transform: 'scale(1)' }, { transform: `scale(${scale})` }, { transform: 'scale(1)' }], { duration: dur, easing: EASE });
}

// Sweep a bar/width from 0 to target. The resting width is applied directly
// (so the bar is correct without the tween).
export function sweepWidth(el: El, toPct: number, { dur = 760, delay = 0 }: { dur?: number; delay?: number } = {}) {
  if (!el) return;
  const w = Math.max(0, Math.min(100, toPct));
  el.style.width = w + '%';
  if (prefersReducedMotion() || typeof el.animate !== 'function') return;
  el.animate([{ width: '0%' }, { width: w + '%' }], { duration: dur, delay, easing: EASE_OUT, fill: 'both' });
}

// ── Formatters ──────────────────────────────────────────────────────────
export const usd = (cents: number): string => {
  const d = cents / 100, s = d < 0 ? '-' : '', a = Math.abs(d);
  return a >= 1000 ? `${s}$${a.toLocaleString('en-US', { maximumFractionDigits: 0 })}` : `${s}$${a.toFixed(2)}`;
};
export const age = (iso: string | number | null | undefined): string => {
  if (iso == null) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  if (!isFinite(ms)) return '—';
  const s = Math.floor(ms / 1000); if (s < 60) return `${Math.max(0, s)}s`;
  const m = Math.floor(s / 60); if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
};
export const ageIn = (iso: string | number | null | undefined): string => {
  if (iso == null) return '—';
  const ms = new Date(iso).getTime() - Date.now();
  const m = Math.max(0, Math.floor(ms / 60000)); if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h`;
};
export const freshLabel = (min: number | null | undefined): string => {
  if (min == null) return '—';
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60); if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
};

// ── Primitives ───────────────────────────────────────────────────────────

export function Caps({ children, size = 10, c, style }: { children: React.ReactNode; size?: number; c?: string; style?: React.CSSProperties }) {
  return (
    <span style={{ fontFamily: FONT_MONO, fontSize: size, fontWeight: 500, letterSpacing: '0.16em', textTransform: 'uppercase', color: c || 'var(--dim)', ...style }}>
      {children}
    </span>
  );
}

export type PillTone = 'neutral' | 'forest' | 'terracotta' | 'gold' | 'teal' | 'ink';
const PILL_TONE: Record<PillTone, { bg: string; fg: string; br: string }> = {
  neutral:    { bg: 'transparent',        fg: 'var(--dim)',            br: 'var(--rule)' },
  forest:     { bg: 'var(--forest-dim)',  fg: 'var(--forest-deep)',    br: 'rgba(60,156,104,.3)' },
  terracotta: { bg: 'var(--terracotta-dim)', fg: 'var(--terracotta-deep)', br: 'rgba(194,86,46,.3)' },
  gold:       { bg: 'var(--gold-dim)',    fg: 'var(--gold-deep)',      br: 'rgba(201,154,46,.32)' },
  teal:       { bg: 'var(--teal-dim)',    fg: 'var(--teal-deep)',      br: 'rgba(51,137,160,.3)' },
  ink:        { bg: 'var(--ink)',         fg: '#fff',                  br: 'var(--ink)' },
};
export function Pill({ children, tone = 'neutral', style }: { children: React.ReactNode; tone?: PillTone; style?: React.CSSProperties }) {
  const p = PILL_TONE[tone] || PILL_TONE.neutral;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5, padding: '3px 9px', borderRadius: 999,
      background: p.bg, color: p.fg, border: `1px solid ${p.br}`,
      fontFamily: FONT_SANS, fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap', lineHeight: 1.4, ...style,
    }}>{children}</span>
  );
}

export type DotTone = 'forest' | 'gold' | 'terracotta' | 'teal' | 'ink' | 'muted';
const DOT_COLOR: Record<DotTone, string> = {
  forest: 'var(--forest)', gold: 'var(--gold)', terracotta: 'var(--terracotta)',
  teal: 'var(--teal)', ink: 'var(--ink)', muted: 'var(--dim2)',
};
export function Dot({ tone = 'forest', size = 8, style }: { tone?: DotTone; size?: number; style?: React.CSSProperties }) {
  return <span style={{ display: 'inline-block', width: size, height: size, borderRadius: '50%', background: DOT_COLOR[tone], flexShrink: 0, ...style }} />;
}

export function SerifNum({ children, size = 48, italic = true, c, style }: { children: React.ReactNode; size?: number | string; italic?: boolean; c?: string; style?: React.CSSProperties }) {
  return (
    <span className="serif-num" style={{ fontSize: size, fontStyle: italic ? 'italic' : 'normal', color: c || 'var(--ink)', ...style }}>
      {children}
    </span>
  );
}

export type BtnVariant = 'primary' | 'ghost' | 'forest' | 'terracotta';
export type BtnSize = 'sm' | 'md' | 'lg';
const BTN_SIZE: Record<BtnSize, { h: number; px: number; fs: number }> = {
  sm: { h: 28, px: 12, fs: 12 }, md: { h: 34, px: 15, fs: 12.5 }, lg: { h: 44, px: 22, fs: 14 },
};
const BTN_VARIANT: Record<BtnVariant, { bg: string; fg: string; br: string }> = {
  primary:    { bg: 'var(--ink)', fg: '#fff', br: 'var(--ink)' },
  ghost:      { bg: 'transparent', fg: 'var(--ink)', br: 'var(--rule)' },
  forest:     { bg: 'var(--forest-dim)', fg: 'var(--forest-deep)', br: 'rgba(60,156,104,.32)' },
  terracotta: { bg: 'var(--terracotta-dim)', fg: 'var(--terracotta-deep)', br: 'rgba(194,86,46,.32)' },
};
export function Btn({
  children, variant = 'ghost', size = 'md', onClick, disabled, style, title, href, type, ariaLabel,
}: {
  children: React.ReactNode; variant?: BtnVariant; size?: BtnSize;
  onClick?: (e: React.MouseEvent) => void; disabled?: boolean; style?: React.CSSProperties;
  title?: string; href?: string; type?: 'button' | 'submit' | 'reset'; ariaLabel?: string;
}) {
  const s = BTN_SIZE[size];
  const v = BTN_VARIANT[variant];
  const css: React.CSSProperties = {
    height: s.h, padding: `0 ${s.px}px`, borderRadius: 999, background: v.bg, color: v.fg,
    border: `1px solid ${v.br}`, fontFamily: FONT_SANS, fontSize: s.fs, fontWeight: 600,
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, whiteSpace: 'nowrap',
    opacity: disabled ? 0.45 : 1, cursor: disabled ? 'not-allowed' : 'pointer',
    transition: 'background .15s, border-color .15s', textDecoration: 'none', flexShrink: 0, ...style,
  };
  const onMouseDown = (e: React.MouseEvent) => { if (!disabled) pulse(e.currentTarget as HTMLElement, { scale: 0.96, dur: 200 }); };
  if (href && !disabled) {
    return <a href={href} style={css} title={title} aria-label={ariaLabel} onMouseDown={onMouseDown} onClick={onClick}>{children}</a>;
  }
  return (
    <button type={type ?? 'button'} onClick={onClick} disabled={disabled} title={title} aria-label={ariaLabel} onMouseDown={onMouseDown} style={css}>
      {children}
    </button>
  );
}
