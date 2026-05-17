// Staff design tokens — Cloud palette + serif/sans/mono fonts + primitives.
// Mirrors the Claude Design handoff (Staff.html, hk-shared.jsx). The
// brand-level --snow-* vars in globals.css match this palette 1:1; this
// module exists so the staff page can use inline styles without touching
// CSS vars (keeps the JSX close to the design source).

import React from 'react';

export const T = {
  bg:        '#FFFFFF',
  paper:     '#FFFFFF',
  ink:       '#1F231C',
  inkSoft:   '#3A3F38',
  ink2:      '#5C625C',
  ink3:      '#A6ABA6',
  rule:      'rgba(31,35,28,0.08)',
  ruleSoft:  'rgba(31,35,28,0.04)',
  sage:      '#9EB7A6',
  sageDeep:  '#5C7A60',
  sageDim:   'rgba(92,122,96,0.10)',
  caramel:   '#C99644',
  caramelDeep:'#8C6A33',
  warm:      '#B85C3D',
  warmDim:   'rgba(184,92,61,0.10)',
  red:       '#A04A2C',
  redDim:    'rgba(160,74,44,0.10)',
  purple:    '#7B6A97',
  purpleDim: 'rgba(123,106,151,0.10)',
} as const;

export const fonts = {
  sans:  "'Geist', system-ui, sans-serif",
  mono:  "'Geist Mono', ui-monospace, monospace",
  serif: "'Instrument Serif', Georgia, serif",
} as const;

// Department visual tokens. Shared by Avatar rings, DeptChip, dept-grouped rows.
export const deptMeta = {
  housekeeping: { label: 'Housekeeping', short: 'HK', tone: '#5C7A60', dim: 'rgba(92,122,96,0.10)' },
  front_desk:   { label: 'Front desk',   short: 'FD', tone: '#3A5670', dim: 'rgba(58,86,112,0.10)' },
  maintenance:  { label: 'Maintenance',  short: 'MT', tone: '#B85C3D', dim: 'rgba(184,92,61,0.10)' },
  other:        { label: 'Other',        short: 'OT', tone: '#7B6A97', dim: 'rgba(123,106,151,0.10)' },
} as const;

export type DeptKey = keyof typeof deptMeta;

/** Resolve a possibly-undefined StaffMember.department to a known DeptKey. */
export function asDeptKey(d?: string | null): DeptKey {
  if (d && d in deptMeta) return d as DeptKey;
  return 'housekeeping';
}

// ── Caps — uppercase mono eyebrow ──────────────────────────────────────────
export function Caps({
  children, size = 10, tracking = '0.16em', c, weight = 500, style = {},
}: {
  children: React.ReactNode;
  size?: number;
  tracking?: string;
  c?: string;
  weight?: number;
  style?: React.CSSProperties;
}) {
  return (
    <span style={{
      fontFamily: fonts.mono, fontSize: size, fontWeight: weight,
      letterSpacing: tracking, textTransform: 'uppercase',
      color: c || T.ink3, ...style,
    }}>{children}</span>
  );
}

// ── Pill ──────────────────────────────────────────────────────────────────
export type PillTone = 'neutral' | 'sage' | 'warm' | 'caramel' | 'red' | 'purple' | 'ink';

export function Pill({
  children, tone = 'neutral', style = {},
}: {
  children: React.ReactNode;
  tone?: PillTone;
  style?: React.CSSProperties;
}) {
  const p = {
    neutral: { bg: 'transparent', fg: T.ink2, br: T.rule },
    sage:    { bg: T.sageDim, fg: T.sageDeep, br: 'rgba(104,131,114,0.25)' },
    warm:    { bg: T.warmDim, fg: T.warm, br: 'rgba(184,119,94,0.25)' },
    caramel: { bg: 'rgba(215,176,126,0.14)', fg: T.caramelDeep, br: 'rgba(140,106,51,0.25)' },
    red:     { bg: T.redDim, fg: T.red, br: 'rgba(160,74,44,0.25)' },
    purple:  { bg: T.purpleDim, fg: T.purple, br: 'rgba(123,106,151,0.25)' },
    ink:     { bg: T.ink, fg: T.bg, br: T.ink },
  }[tone];
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5,
      padding: '3px 9px', borderRadius: 999, height: 22,
      background: p.bg, color: p.fg, border: `1px solid ${p.br}`,
      fontFamily: fonts.sans, fontSize: 11, fontWeight: 500,
      whiteSpace: 'nowrap', ...style,
    }}>{children}</span>
  );
}

// ── Btn ──────────────────────────────────────────────────────────────────
export type BtnVariant = 'primary' | 'ghost' | 'sage' | 'paper';
export type BtnSize = 'sm' | 'md' | 'lg';

export function Btn({
  variant = 'ghost', size = 'md', children, onClick, disabled, title, style = {},
}: {
  variant?: BtnVariant;
  size?: BtnSize;
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  title?: string;
  style?: React.CSSProperties;
}) {
  const sizes = {
    sm: { h: 28, px: 12, fs: 12 },
    md: { h: 36, px: 16, fs: 13 },
    lg: { h: 44, px: 22, fs: 14 },
  }[size];
  const variants = {
    primary: { bg: T.ink, fg: T.bg, br: 'transparent' },
    ghost:   { bg: 'transparent', fg: T.ink, br: T.rule },
    sage:    { bg: T.sageDim, fg: T.sageDeep, br: 'rgba(104,131,114,0.3)' },
    paper:   { bg: T.paper, fg: T.ink, br: T.rule },
  }[variant];
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        height: sizes.h, padding: `0 ${sizes.px}px`, borderRadius: 999,
        background: variants.bg, color: variants.fg,
        border: `1px solid ${variants.br}`,
        fontFamily: fonts.sans, fontSize: sizes.fs, fontWeight: 500,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.55 : 1,
        display: 'inline-flex', alignItems: 'center', gap: 6,
        whiteSpace: 'nowrap', flexShrink: 0, ...style,
      }}
    >{children}</button>
  );
}

// ── Card ─────────────────────────────────────────────────────────────────
export function Card({
  children, style = {},
}: {
  children: React.ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <div style={{
      background: T.paper, border: `1px solid ${T.rule}`, borderRadius: 18,
      padding: '20px 22px', ...style,
    }}>{children}</div>
  );
}
