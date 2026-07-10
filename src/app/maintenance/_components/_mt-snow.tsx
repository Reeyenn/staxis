// Maintenance-specific Snow primitives. Ports maintenance-shared.jsx +
// the modal / form pieces shared by the WorkOrders and Preventive tabs.
//
// Reuses the housekeeping `_snow.tsx` tokens (palette + fonts + Btn / Pill /
// Caps / Card) so the Maintenance tab stays visually locked to the rest of
// the app. The extras here are: priority dot/pill, person avatar, modal
// shell, form fields, chip chooser, photo placeholder, relative-time helper.

'use client';

import React, { useEffect, useRef } from 'react';
import { useLang } from '@/contexts/LanguageContext';
import {
  T, FONT_SANS, FONT_MONO, FONT_SERIF, Caps, Card,
} from '@/app/housekeeping/_components/_snow';

// Re-export the shared Snow primitives so the maintenance tabs have a single
// import source (tokens + Caps/Card live in housekeeping/_snow). Pill and Btn
// are defined locally below with the Concourse skin — mono badge pills and
// sage primary buttons — so the maintenance section reads native to the shell.
export { T, FONT_SANS, FONT_MONO, FONT_SERIF, Caps, Card };
export type Priority = 'urgent' | 'normal' | 'low';

// ── Concourse motion + card tokens (mirror concourse-css.tsx) ──────────────
export const CX_SPRING = 'cubic-bezier(.22,1,.36,1)';
export const CX_CARD_SHADOW = '0 6px 16px -14px rgba(31,42,32,0.35)';
export const CX_CARD_SHADOW_HOVER = '0 18px 36px -20px rgba(62,92,72,0.5)';
export const CX_CARD_BORDER_HOVER = 'rgba(92,122,96,0.45)';

// ── Pill — Concourse badge: Geist Mono 10px/600 uppercase on a toned wash ──
type PillTone = 'neutral' | 'sage' | 'warm' | 'caramel' | 'red' | 'purple' | 'ink';

export function Pill({
  children, tone = 'neutral', style = {},
}: {
  children: React.ReactNode; tone?: PillTone; style?: React.CSSProperties;
}) {
  const palette = {
    neutral: { bg: 'rgba(31,35,28,0.06)',   fg: '#5C625C' },
    sage:    { bg: 'rgba(53,107,76,0.10)',  fg: '#356B4C' },
    warm:    { bg: 'rgba(184,92,61,0.10)',  fg: '#B85C3D' },
    caramel: { bg: 'rgba(201,150,68,0.14)', fg: '#8C6A33' },
    red:     { bg: 'rgba(184,92,61,0.10)',  fg: '#B85C3D' },
    purple:  { bg: 'rgba(31,35,28,0.06)',   fg: '#5C625C' },
    ink:     { bg: '#1F231C',               fg: '#FFFFFF' },
  }[tone];
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5,
      padding: '3px 9px', borderRadius: 999, height: 22,
      background: palette.bg, color: palette.fg,
      fontFamily: FONT_MONO, fontSize: 10, fontWeight: 600,
      letterSpacing: '0.06em', textTransform: 'uppercase',
      whiteSpace: 'nowrap', ...style,
    }}>{children}</span>
  );
}

// ── Btn — Concourse pill button: sage primary, hairline secondary ──────────
type BtnVariant = 'primary' | 'ghost' | 'sage' | 'paper';
type BtnSize = 'sm' | 'md' | 'lg';

export function Btn({
  variant = 'ghost', size = 'md', children, onClick, disabled, style = {}, type, title, ariaLabel,
}: {
  variant?: BtnVariant; size?: BtnSize;
  children: React.ReactNode;
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  disabled?: boolean;
  style?: React.CSSProperties;
  type?: 'button' | 'submit' | 'reset';
  title?: string;
  ariaLabel?: string;
}) {
  const sizes = {
    sm: { h: 28, px: 12, fs: 11.5 },
    md: { h: 36, px: 16, fs: 12.5 },
    lg: { h: 44, px: 22, fs: 13.5 },
  }[size];
  const variants = {
    primary: { bg: '#3E5C48',                fg: '#FFFFFF', br: 'transparent' },
    ghost:   { bg: 'transparent',            fg: '#5C625C', br: 'rgba(31,35,28,0.14)' },
    sage:    { bg: 'rgba(92,122,96,0.14)',   fg: '#356B4C', br: 'rgba(92,122,96,0.30)' },
    paper:   { bg: '#FFFFFF',                fg: T.ink,     br: T.rule },
  }[variant];
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      type={type ?? 'button'}
      title={title}
      aria-label={ariaLabel}
      style={{
        height: sizes.h, padding: `0 ${sizes.px}px`, borderRadius: 999,
        background: variants.bg, color: variants.fg,
        border: `1px solid ${variants.br}`,
        fontFamily: FONT_SANS, fontSize: sizes.fs, fontWeight: 600,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        display: 'inline-flex', alignItems: 'center', gap: 6,
        whiteSpace: 'nowrap', flexShrink: 0,
        transition: `background .3s ${CX_SPRING}, color .3s ${CX_SPRING}, border-color .3s ${CX_SPRING}`,
        ...style,
      }}
    >{children}</button>
  );
}

// ── Priority colors ────────────────────────────────────────────────────────
export const prioColor: Record<Priority, string> = {
  urgent: '#B85C3D',
  normal: '#C99644',
  low:    '#5C7A60',
};
export const prioLabel: Record<Priority, string> = {
  urgent: 'Urgent',
  normal: 'Normal',
  low:    'Low',
};
export const prioOrder: Priority[] = ['urgent', 'normal', 'low'];

export function PrioDot({ p, size = 10, ring = false, style = {} }: {
  p: Priority; size?: number; ring?: boolean; style?: React.CSSProperties;
}) {
  const c = prioColor[p];
  return (
    <span style={{
      display: 'inline-block', width: size, height: size, borderRadius: '50%',
      background: c, boxShadow: ring ? `0 0 0 3px ${c}22` : 'none',
      flexShrink: 0, ...style,
    }}/>
  );
}

export function PrioPill({ p, style = {} }: { p: Priority; style?: React.CSSProperties }) {
  const c = prioColor[p];
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 6,
      padding: '3px 10px 3px 8px', borderRadius: 999, height: 22,
      background: `${c}1A`, color: c,
      fontFamily: FONT_MONO, fontSize: 10, fontWeight: 600,
      letterSpacing: '0.06em', textTransform: 'uppercase',
      whiteSpace: 'nowrap', ...style,
    }}>
      <PrioDot p={p} size={6}/>
      {prioLabel[p]}
    </span>
  );
}

// ── Avatar — initials in a tinted circle ──────────────────────────────────
// Deterministic color from a name: the same person always lands on the same
// tone (mirrors staffTone in housekeeping/_snow). Callers can still override
// with an explicit `tone`.
// Concourse retint: avatar tones drawn from the Concourse hues (rust / sage
// accent / brand sage / warn text / deep ok / secondary ink) — all on palette,
// all dark enough for white initials. Mirrors STAFF_TONES in housekeeping/_snow.
const AVATAR_TONES = ['#B85C3D', '#5C7A60', '#3E5C48', '#8C6A33', '#356B4C', '#5C625C'];
export function toneFor(name: string): string {
  let h = 0;
  for (const ch of (name || '')) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return AVATAR_TONES[Math.abs(h) % AVATAR_TONES.length];
}

export function Avatar({
  name, tone, size = 28, style = {},
}: {
  name: string; tone?: string; size?: number; style?: React.CSSProperties;
}) {
  const initials = (() => {
    const parts = (name || '').trim().split(/\s+/);
    if (parts.length === 0) return '?';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  })();
  return (
    <span style={{
      width: size, height: size, borderRadius: '50%',
      background: tone ?? toneFor(name), color: '#fff',
      fontFamily: FONT_SANS, fontSize: Math.round(size * 0.36), fontWeight: 600,
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      flexShrink: 0, ...style,
    }}>{initials}</span>
  );
}

// ── Modal shell ────────────────────────────────────────────────────────────
export function Modal({
  open, onClose, title, subtitle, children, footer, width = 580,
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
  subtitle?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  width?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose(); }
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
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, zIndex: 1000,
      background: 'rgba(31,35,28,0.32)',
      display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
      padding: '48px 24px', overflow: 'auto',
    }}>
      <div ref={ref} onClick={e => e.stopPropagation()} style={{
        width: '100%', maxWidth: width, background: '#FFFFFF', borderRadius: 18,
        border: `1px solid ${T.rule}`,
        boxShadow: '0 24px 60px rgba(31,35,28,0.18)',
        display: 'flex', flexDirection: 'column',
      }}>
        <div style={{
          padding: '22px 26px 18px', borderBottom: `1px solid ${T.rule}`,
          display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 18,
        }}>
          <div style={{ minWidth: 0 }}>
            {title && (
              <h2 style={{ fontFamily: FONT_SANS, fontSize: 20, color: T.ink, margin: 0, letterSpacing: '-0.02em', fontWeight: 600, lineHeight: 1.25 }}>
                {title}
              </h2>
            )}
            {subtitle && (
              <p style={{ fontFamily: FONT_SANS, fontSize: 12, color: T.ink2, margin: '4px 0 0' }}>
                {subtitle}
              </p>
            )}
          </div>
          <button onClick={onClose} aria-label="Close" style={{
            width: 32, height: 32, borderRadius: '50%', cursor: 'pointer',
            background: 'transparent', border: `1px solid ${T.rule}`,
            color: T.ink2, fontSize: 14, lineHeight: 1, flexShrink: 0,
          }}>✕</button>
        </div>
        <div style={{ padding: '22px 26px', flex: 1, minHeight: 0 }}>{children}</div>
        {footer && (
          <div style={{
            padding: '18px 26px', borderTop: `1px solid ${T.rule}`,
            display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8,
            flexWrap: 'wrap', background: 'rgba(31,35,28,0.025)', borderBottomLeftRadius: 18, borderBottomRightRadius: 18,
          }}>{footer}</div>
        )}
      </div>
    </div>
  );
}

// ── Form primitives ───────────────────────────────────────────────────────
export function Field({
  label, hint, required, children, style = {},
}: {
  label: string; hint?: string; required?: boolean;
  children: React.ReactNode; style?: React.CSSProperties;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, ...style }}>
      <span style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <span style={{ fontFamily: FONT_MONO, fontSize: 9.5, color: T.ink2, letterSpacing: '0.14em', textTransform: 'uppercase', fontWeight: 600 }}>
          {label}{required && <span style={{ color: T.warm, marginLeft: 4 }}>*</span>}
        </span>
        {hint && <span style={{ fontFamily: FONT_SANS, fontSize: 11, color: T.ink3 }}>{hint}</span>}
      </span>
      {children}
    </div>
  );
}

export function TextInput({
  value, onChange, placeholder, type = 'text', ...rest
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type'>) {
  return (
    <input
      type={type}
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
      style={{
        height: 40, padding: '0 14px', borderRadius: 10,
        background: '#FFFFFF', border: '1px solid rgba(31,35,28,0.14)',
        fontFamily: FONT_SANS, fontSize: 14, color: T.ink, width: '100%',
        boxSizing: 'border-box', outline: 'none',
      }}
      {...rest}
    />
  );
}

export function TextArea({
  value, onChange, placeholder, rows = 3,
}: {
  value: string; onChange: (v: string) => void;
  placeholder?: string; rows?: number;
}) {
  return (
    <textarea
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
      rows={rows}
      style={{
        padding: '10px 14px', borderRadius: 10,
        background: '#FFFFFF', border: '1px solid rgba(31,35,28,0.14)',
        fontFamily: FONT_SANS, fontSize: 14, color: T.ink, width: '100%',
        boxSizing: 'border-box', outline: 'none', resize: 'vertical',
        lineHeight: 1.5,
      }}
    />
  );
}

// Segmented chooser for fixed-option fields (priority chips).
export function ChipChoose<V extends string>({
  options, value, onChange, render,
}: {
  options: { value: V; label: string }[];
  value: V;
  onChange: (v: V) => void;
  render?: (opt: { value: V; label: string }, active: boolean) => React.ReactNode;
}) {
  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      {options.map(opt => {
        const active = value === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            style={{
              padding: '8px 14px', borderRadius: 999, cursor: 'pointer',
              background: active ? '#3E5C48' : 'transparent',
              color: active ? '#FFFFFF' : T.ink2,
              border: `1px solid ${active ? '#3E5C48' : 'rgba(31,35,28,0.14)'}`,
              fontFamily: FONT_SANS, fontSize: 12.5, fontWeight: active ? 600 : 500,
              display: 'inline-flex', alignItems: 'center', gap: 8,
              whiteSpace: 'nowrap',
              transition: `background .3s ${CX_SPRING}, color .3s ${CX_SPRING}, border-color .3s ${CX_SPRING}`,
            }}
          >
            {render ? render(opt, active) : opt.label}
          </button>
        );
      })}
    </div>
  );
}

// ── Photo slot — file-picker masquerading as the design's striped tile ────
// Mirrors hk-shared.jsx PhotoSlot: tap to open a hidden <input type="file">.
// Caller stores the File and a preview URL; passes them back on submit.
export function PhotoSlot({
  file, onFileChange, label = 'Photo (optional)', height = 140,
}: {
  file: File | null;
  onFileChange: (f: File | null) => void;
  label?: string;
  height?: number;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const attached = !!file;
  return (
    <>
      <button
        type="button"
        onClick={() => {
          if (attached) onFileChange(null);
          else inputRef.current?.click();
        }}
        style={{
          width: '100%', height, borderRadius: 12, cursor: 'pointer',
          background: attached
            ? 'repeating-linear-gradient(135deg, rgba(92,122,96,0.10) 0 10px, rgba(92,122,96,0.04) 10px 20px)'
            : 'repeating-linear-gradient(135deg, rgba(31,35,28,0.04) 0 10px, transparent 10px 20px)',
          border: `1px dashed ${attached ? 'rgba(92,122,96,0.4)' : T.rule}`,
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          gap: 6, fontFamily: FONT_MONO, fontSize: 11,
          color: attached ? T.sageDeep : T.ink3,
          letterSpacing: '0.06em', textTransform: 'uppercase', fontWeight: 500,
        }}
      >
        <span style={{ fontSize: 20, color: attached ? T.sageDeep : T.ink2, letterSpacing: 0 }}>
          {attached ? '✓' : '+'}
        </span>
        {attached
          ? `Photo attached · ${file.name.length > 24 ? file.name.slice(0, 22) + '…' : file.name} · tap to remove`
          : label}
        {!attached && (
          <span style={{ fontFamily: FONT_SANS, fontSize: 11, color: T.ink3, textTransform: 'none', letterSpacing: 0 }}>
            Tap to take or upload
          </span>
        )}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        capture="environment"
        style={{ display: 'none' }}
        onChange={e => {
          const f = e.target.files?.[0] ?? null;
          onFileChange(f);
          // Reset input so picking the same file twice still fires onChange.
          if (e.target) e.target.value = '';
        }}
      />
    </>
  );
}

// ── Date helpers ──────────────────────────────────────────────────────────
// Relative-time string from "days from today" (negative = overdue).
export function relTime(days: number): string {
  if (days === 0)  return 'today';
  if (days < 0)    return `${-days}d overdue`;
  if (days === 1)  return 'tomorrow';
  if (days <= 7)   return `in ${days}d`;
  if (days <= 60)  return `in ${Math.round(days / 7)}w`;
  return `in ${Math.round(days / 30)}mo`;
}

export function fmtDate(d: Date): string {
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function fmtDateShort(d: Date): string {
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// "May 12 · 7:51 AM" / "May 11 · 1d ago" — used in the open-card byline.
export function fmtSubmittedAt(d: Date | null, now: Date = new Date()): string {
  if (!d) return '';
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) {
    return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }) + ' · today';
  }
  const daysAgo = Math.floor((now.getTime() - d.getTime()) / (24 * 60 * 60 * 1000));
  if (daysAgo === 1) return `${fmtDateShort(d)} · 1d ago`;
  if (daysAgo < 7)   return `${fmtDateShort(d)} · ${daysAgo}d ago`;
  return fmtDate(d);
}

// Days between two dates ignoring time-of-day. Positive = b is later.
export function daysBetween(a: Date, b: Date): number {
  const aa = new Date(a.getFullYear(), a.getMonth(), a.getDate());
  const bb = new Date(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((bb.getTime() - aa.getTime()) / (24 * 60 * 60 * 1000));
}

// Due-relative string from "days until due" (negative = overdue). Used on the
// Preventive board cards. Spanish variants for the bilingual UI.
export function relDue(days: number, es = false): string {
  if (days === 0)  return es ? 'vence hoy'    : 'due today';
  if (days < 0)    return es ? `${-days}d vencido` : `${-days}d overdue`;
  if (days === 1)  return es ? 'vence mañana' : 'due tomorrow';
  if (days <= 7)   return es ? `en ${days}d`  : `in ${days}d`;
  if (days <= 60)  return es ? `en ${Math.round(days / 7)}sem` : `in ${Math.round(days / 7)}w`;
  return es ? `en ${Math.round(days / 30)}mes` : `in ${Math.round(days / 30)}mo`;
}

// Format a location for display: bare room numbers get a "Rm " prefix; named
// areas ("Lobby", "Pool Deck") pass through verbatim.
export function displayLoc(loc: string, es = false): string {
  const t = (loc || '').trim();
  return /^\d{1,4}$/.test(t) ? `${es ? 'Hab' : 'Rm'} ${t}` : t;
}

// ── Board primitives (shared by the three maintenance tabs) ────────────────

// Page header: mono eyebrow + serif headline (italic lead · faint rest) +
// right-aligned actions. Mirrors the prototype's PageHead.
export function PageHead({
  eyebrow, lead, rest, actions,
}: {
  eyebrow: string; lead: string; rest?: string; actions?: React.ReactNode;
}) {
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end',
      marginBottom: 20, gap: 24, flexWrap: 'wrap',
    }}>
      <div>
        <span style={{ fontFamily: FONT_MONO, fontSize: 9.5, color: T.ink3, letterSpacing: '0.14em', textTransform: 'uppercase', fontWeight: 600 }}>
          {eyebrow}
        </span>
        <h1 style={{ fontFamily: FONT_SANS, fontSize: 26, color: T.ink, margin: '5px 0 0', letterSpacing: '-0.02em', lineHeight: 1.25, fontWeight: 600 }}>
          <span>{lead}</span>
          {rest && <span style={{ color: T.ink3, fontWeight: 500 }}> · {rest}</span>}
        </h1>
      </div>
      {actions && <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>{actions}</div>}
    </div>
  );
}

// Board column: lane dot + mono CAPS label in the lane color + right-aligned
// serif-italic count, over a 2px lane-color underline. Empty lanes show a
// faint serif-italic note.
export function BoardColumn({
  color, label, count, empty, children,
}: {
  color: string; label: string; count: number;
  empty?: string; children: React.ReactNode;
}) {
  const hasItems = React.Children.count(children) > 0;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '0 2px 11px', borderBottom: `2px solid ${color}`, marginBottom: 12 }}>
        <span style={{ width: 10, height: 10, borderRadius: '50%', background: color, flexShrink: 0 }} />
        <span style={{ fontFamily: FONT_MONO, fontSize: 10, fontWeight: 600, letterSpacing: '0.14em', textTransform: 'uppercase', color }}>
          {label}
        </span>
        <span style={{ marginLeft: 'auto', fontFamily: FONT_SANS, fontWeight: 600, fontSize: 20, color, lineHeight: 1, letterSpacing: '-0.02em' }}>{count}</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
        {hasItems
          ? children
          : <span style={{ fontFamily: FONT_SANS, fontSize: 13, color: T.ink3, padding: '6px 2px' }}>{empty || 'Nothing here.'}</span>}
      </div>
    </div>
  );
}

// Board card: white, hairline border, 14px radius, 4px left accent bar. Hover
// darkens the border and lifts 1px. Clickable when onClick is provided.
export function BoardCard({
  accent, onClick, children, dataId,
}: {
  accent: string;
  onClick?: () => void;
  children: React.ReactNode;
  /** Stamped as data-wo-id — used by the Work Orders FLIP animation. */
  dataId?: string;
}) {
  return (
    <div
      onClick={onClick}
      data-wo-id={dataId}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } } : undefined}
      onMouseEnter={onClick ? (e) => { e.currentTarget.style.borderColor = CX_CARD_BORDER_HOVER; e.currentTarget.style.transform = 'translateY(-5px)'; e.currentTarget.style.boxShadow = CX_CARD_SHADOW_HOVER; } : undefined}
      onMouseLeave={onClick ? (e) => { e.currentTarget.style.borderColor = T.rule; e.currentTarget.style.transform = 'translateY(0)'; e.currentTarget.style.boxShadow = CX_CARD_SHADOW; } : undefined}
      style={{
        textAlign: 'left', cursor: onClick ? 'pointer' : 'default',
        background: '#FFFFFF', border: `1px solid ${T.rule}`, borderRadius: 14,
        padding: '14px 16px 13px 19px', display: 'flex', flexDirection: 'column', gap: 9,
        width: '100%', position: 'relative', overflow: 'hidden',
        boxShadow: CX_CARD_SHADOW,
        transition: `border-color .55s ${CX_SPRING}, transform .55s ${CX_SPRING}, box-shadow .55s ${CX_SPRING}`,
      }}
    >
      <span style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 4, background: accent }} />
      {children}
    </div>
  );
}

// Centered board: lays out non-empty bands in a row that centers whatever
// remains (each column 280–392px). Used by Preventive + Equipment.
export function CenteredBoard({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: 22, alignItems: 'flex-start', justifyContent: 'center', flexWrap: 'wrap' }}>
      {React.Children.map(children, (c) => (
        // Grow each band to fill wide screens (up to 520px) while staying
        // centered when there are only one or two bands.
        <div style={{ flex: '1 1 0', minWidth: 280, maxWidth: 520 }}>{c}</div>
      ))}
    </div>
  );
}

// Error boundary: catches a render error in the maintenance subtree and shows
// a recover card instead of a blank screen (the white-screen-on-tab bug class).
export class MaintenanceErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { err: Error | null }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { err: null };
  }
  static getDerivedStateFromError(err: Error) { return { err }; }
  render() {
    if (this.state.err) {
      return (
        <div style={{ minHeight: '60dvh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'transparent', fontFamily: FONT_SANS, padding: 24 }}>
          <div style={{ maxWidth: 420, textAlign: 'center', background: '#FFFFFF', border: `1px solid ${T.rule}`, borderRadius: 18, padding: '32px 28px', boxShadow: CX_CARD_SHADOW }}>
            <div style={{ fontFamily: FONT_SANS, fontSize: 21, fontWeight: 600, color: T.ink, letterSpacing: '-0.02em' }}>Something hiccuped.</div>
            <p style={{ fontFamily: FONT_SANS, fontSize: 14, color: T.ink2, lineHeight: 1.5, margin: '10px 0 18px' }}>
              The page hit a snag — your data is safe. Reload to pick back up.
            </p>
            <Btn variant="primary" onClick={() => location.reload()}>↻ Reload</Btn>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

// ── Maintenance sub-tab bar ────────────────────────────────────────────────
export type MaintenanceTabKey = 'work' | 'preventive' | 'equipment';

export function MTSubTabBar({
  tab, onTab,
}: {
  tab: MaintenanceTabKey;
  onTab: (t: MaintenanceTabKey) => void;
}) {
  const { lang } = useLang();
  const es = lang === 'es';
  const tabs: { key: MaintenanceTabKey; label: string }[] = [
    { key: 'work',       label: es ? 'Órdenes de trabajo' : 'Work orders' },
    { key: 'preventive', label: es ? 'Preventivo'         : 'Preventive'  },
    { key: 'equipment',  label: es ? 'Equipo'             : 'Equipment'   },
  ];
  return (
    <div style={{
      padding: '18px 48px 0',
      background: 'rgba(255,255,255,.72)',
      backdropFilter: 'blur(12px)',
      WebkitBackdropFilter: 'blur(12px)',
      borderBottom: `1px solid ${T.rule}`,
      position: 'sticky', top: 64, zIndex: 10,
    }}>
      <nav style={{ display: 'flex', gap: 28 }}>
        {tabs.map(t => {
          const active = tab === t.key;
          return (
            <button
              key={t.key}
              onClick={() => onTab(t.key)}
              style={{
                background: 'transparent', border: 'none', cursor: 'pointer',
                padding: '8px 0 14px', position: 'relative',
                fontFamily: FONT_SANS, fontSize: 14,
                fontWeight: active ? 600 : 500,
                color: active ? T.ink : T.ink2,
                borderBottom: active ? '1.5px solid #3E5C48' : '1.5px solid transparent',
                marginBottom: -1,
                whiteSpace: 'nowrap',
                transition: `color .3s ${CX_SPRING}, border-color .3s ${CX_SPRING}`,
              }}
            >{t.label}</button>
          );
        })}
      </nav>
    </div>
  );
}

// ── Image preview from Storage path. Used in the Detail modals. ──────────
// Lazy import of supabase to keep this primitives file out of the data
// layer's dependency graph.
export function StorageImage({
  path, alt = 'photo', height = 180,
}: {
  path: string;
  alt?: string;
  height?: number;
}) {
  const [url, setUrl] = React.useState<string | null>(null);
  React.useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const { supabase } = await import('@/lib/supabase');
        const { data, error } = await supabase.storage
          .from('maintenance-photos')
          .createSignedUrl(path, 60 * 5);
        if (!alive) return;
        if (error || !data?.signedUrl) setUrl(null);
        else setUrl(data.signedUrl);
      } catch {
        // Thumbnail render is best-effort — dynamic import or auth failure
        // just hides the image.
        if (alive) setUrl(null);
      }
    })();
    return () => { alive = false; };
  }, [path]);

  if (!url) {
    return (
      <div style={{
        height, borderRadius: 12,
        background: `repeating-linear-gradient(135deg, ${T.rule} 0 10px, transparent 10px 20px), ${T.bg}`,
        border: `1px solid ${T.rule}`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontFamily: FONT_MONO, fontSize: 11, color: T.ink3,
        letterSpacing: '0.08em', textTransform: 'uppercase',
      }}>
        Loading photo…
      </div>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={url}
      alt={alt}
      style={{
        height, width: '100%', objectFit: 'cover',
        borderRadius: 12, border: `1px solid ${T.rule}`, display: 'block',
      }}
    />
  );
}
