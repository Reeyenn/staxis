// Staff design tokens — Concourse skin (soft radial wash + sage brand) +
// Geist/Geist Mono type + primitives. Palette and card/button treatments
// mirror src/components/concourse/concourse-css.tsx 1:1; this module exists
// so the staff page can use inline styles without touching CSS vars (keeps
// the JSX close to the design source).

import React from 'react';
import {
  CONCOURSE_COLORS,
  CONCOURSE_FONTS,
  UI_FOCUS,
  UI_RADII,
  UI_SHADOWS,
} from '@/app/_components/ui/tokens';
import { UiButton, type UiButtonTheme } from '@/app/_components/ui/Button';
import { SurfaceCard } from '@/app/_components/ui/SurfaceCard';

export const T = {
  ...CONCOURSE_COLORS,
  brand:     '#3E5C48',
  red:       '#B85C3D',
  redDim:    'rgba(184,92,61,0.10)',
  cardShadow: UI_SHADOWS.card,
} as const;

export const fonts = {
  ...CONCOURSE_FONTS,
  // Concourse drops serif display type — kept as a Geist alias so the many
  // settings/staff callers of fonts.serif restyle in place without a sweep.
} as const;

// Department visual tokens. Shared by Avatar rings, DeptChip, dept-grouped rows.
export const deptMeta = {
  housekeeping: { label: 'Housekeeping', short: 'HK', tone: '#5C7A60', dim: 'rgba(92,122,96,0.14)' },
  front_desk:   { label: 'Front desk',   short: 'FD', tone: '#8C6A33', dim: 'rgba(201,150,68,0.14)' },
  maintenance:  { label: 'Maintenance',  short: 'MT', tone: '#B85C3D', dim: 'rgba(184,92,61,0.10)' },
  other:        { label: 'Other',        short: 'OT', tone: '#5C625C', dim: 'rgba(31,35,28,0.06)' },
} as const;

export type DeptKey = keyof typeof deptMeta;

/** Resolve a possibly-undefined StaffMember.department to a known DeptKey. */
export function asDeptKey(d?: string | null): DeptKey {
  if (d && d in deptMeta) return d as DeptKey;
  return 'housekeeping';
}

// ── Caps — uppercase mono eyebrow ──────────────────────────────────────────
export function Caps({
  children, size = 9.5, tracking = '0.14em', c, weight = 500, style = {},
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
    sage:    { bg: T.sageDim, fg: T.sageDeep, br: 'rgba(92,122,96,0.25)' },
    warm:    { bg: T.warmDim, fg: T.warm, br: 'rgba(184,92,61,0.25)' },
    caramel: { bg: 'rgba(201,150,68,0.14)', fg: T.caramelDeep, br: 'rgba(140,106,51,0.25)' },
    red:     { bg: T.redDim, fg: T.red, br: 'rgba(184,92,61,0.25)' },
    purple:  { bg: T.purpleDim, fg: T.purple, br: 'rgba(31,35,28,0.14)' },
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

const STAFF_BUTTON_THEME: UiButtonTheme = {
  sizes: {
    sm: { height: 28, padding: '0 12px', fontSize: 12 },
    md: { height: 36, padding: '0 16px', fontSize: 12.5 },
    lg: { height: 44, padding: '0 22px', fontSize: 14 },
  },
  variants: {
    primary: { background: T.brand, color: '#FFFFFF', border: 'transparent', fontWeight: 600 },
    ghost: { background: 'transparent', color: T.ink2, border: 'rgba(31,35,28,0.14)', fontWeight: 500 },
    sage: { background: T.sageDim, color: T.sageDeep, border: 'rgba(92,122,96,0.3)', fontWeight: 600 },
    paper: { background: T.paper, color: T.ink, border: T.rule, fontWeight: 500 },
  },
  fontFamily: fonts.sans,
  disabledOpacity: 0.55,
  gap: 6,
  borderRadius: UI_RADII.pill,
  flexShrink: 0,
  focusRing: UI_FOCUS.ring,
};

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
  return (
    <UiButton
      theme={STAFF_BUTTON_THEME}
      variant={variant}
      size={size}
      onClick={onClick}
      disabled={disabled}
      title={title}
      type="button"
      style={{
        ...style,
      }}
    >{children}</UiButton>
  );
}

// ── Card ─────────────────────────────────────────────────────────────────
export function Card({
  children, style = {},
}: {
  children: React.ReactNode;
  style?: React.CSSProperties;
}) {
  return <SurfaceCard
    surface={T.paper}
    border={`1px solid ${T.rule}`}
    radius={UI_RADII.card}
    shadow={T.cardShadow}
    padding="20px 22px"
    style={style}
  >{children}</SurfaceCard>;
}
