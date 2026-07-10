// Snow design system primitives for the housekeeping tabs. Mirrors
// hk-shared.jsx from the Claude Design handoff (May 2026). Keep these
// in sync with the Snow CSS vars in src/app/globals.css and the
// dashboard's Frame layout — they share the same tokens by design.
//
// What's here:
//   T          — palette tokens (color values bound to CSS vars)
//   FONT_*     — font-family stacks
//   Caps/Pill/Btn/Card — primitives reused by all four tabs
//   HousekeeperDot — colored avatar circle (re-skinned `HKInitials`)
//
// Why a separate file from _shared.tsx: _shared.tsx is the historical
// helper junk-drawer (TABS, snapshotToShiftRooms, autoSelectEligible,
// etc.) and is heavy to load. The Snow primitives are visual-only and
// import nothing from the data layer, so they stay isolated.

'use client';

import React from 'react';
import type { StaffMember } from '@/types';

// ───────────────────────────────────────────────────────────────────────
// Palette tokens — bound to the --snow-* CSS vars defined in globals.css
// so any future palette swap happens in one place.
// ───────────────────────────────────────────────────────────────────────

export const T = {
  bg:         'var(--snow-bg)',
  paper:      'var(--snow-bg)',
  ink:        'var(--snow-ink)',
  inkSoft:    '#3A3F38',
  ink2:       'var(--snow-ink2)',
  ink3:       'var(--snow-ink3)',
  rule:       'var(--snow-rule)',
  ruleSoft:   'var(--snow-rule-soft)',
  sage:       'var(--snow-sage)',
  sageDeep:   'var(--snow-sage-deep)',
  sageDim:    'rgba(92,122,96,0.10)',
  caramel:    'var(--snow-caramel)',
  caramelDeep:'#8C6A33',
  warm:       'var(--snow-warm)',
  warmDim:    'rgba(184,92,61,0.10)',
  red:        '#A04A2C',
  redDim:     'rgba(160,74,44,0.10)',
  purple:     '#7B6A97',
  purpleDim:  'rgba(123,106,151,0.10)',
} as const;

export const FONT_SANS  = "var(--font-geist), -apple-system, BlinkMacSystemFont, sans-serif";
export const FONT_MONO  = "var(--font-geist-mono), ui-monospace, monospace";
export const FONT_SERIF = "var(--font-instrument-serif), 'Times New Roman', Georgia, serif";

// ───────────────────────────────────────────────────────────────────────
// Caps — the design's tiny mono-uppercase label (10px, 0.16em tracking).
// ───────────────────────────────────────────────────────────────────────

export function Caps({
  children, size = 10, tracking = '0.16em', c, weight = 500, style = {},
}: {
  children: React.ReactNode; size?: number; tracking?: string;
  c?: string; weight?: number; style?: React.CSSProperties;
}) {
  return (
    // Default color is ink2 (#5C625C, ~7.2:1 on white) — ink3 (#A6ABA6) is
    // only 1.9:1 and fails WCAG AA at the 10px size these labels render at.
    // Tab files that want the lighter ink3 tone still pass `c={T.ink3}`
    // explicitly (e.g. timestamp prefixes inside briefing items).
    <span style={{
      fontFamily: FONT_MONO, fontSize: size, fontWeight: weight,
      letterSpacing: tracking, textTransform: 'uppercase',
      color: c || T.ink2, ...style,
    }}>{children}</span>
  );
}

// ───────────────────────────────────────────────────────────────────────
// Pill — small rounded badge with toned background + matching border.
// ───────────────────────────────────────────────────────────────────────

type PillTone = 'neutral' | 'sage' | 'warm' | 'caramel' | 'red' | 'purple' | 'ink';

export function Pill({
  children, tone = 'neutral', style = {},
}: {
  children: React.ReactNode; tone?: PillTone; style?: React.CSSProperties;
}) {
  const palette = {
    neutral: { bg: 'transparent',                     fg: T.ink2,        br: T.rule },
    sage:    { bg: T.sageDim,                         fg: T.sageDeep,    br: 'rgba(104,131,114,0.25)' },
    warm:    { bg: T.warmDim,                         fg: T.warm,        br: 'rgba(184,119,94,0.25)' },
    caramel: { bg: 'rgba(215,176,126,0.14)',          fg: T.caramelDeep, br: 'rgba(140,106,51,0.25)' },
    red:     { bg: T.redDim,                          fg: T.red,         br: 'rgba(160,74,44,0.25)' },
    purple:  { bg: T.purpleDim,                       fg: T.purple,      br: 'rgba(123,106,151,0.25)' },
    ink:     { bg: T.ink,                             fg: T.bg,          br: T.ink },
  }[tone];
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5,
      padding: '3px 9px', borderRadius: 999, height: 22,
      background: palette.bg, color: palette.fg,
      border: `1px solid ${palette.br}`,
      fontFamily: FONT_SANS, fontSize: 11, fontWeight: 500,
      whiteSpace: 'nowrap', ...style,
    }}>{children}</span>
  );
}

// ───────────────────────────────────────────────────────────────────────
// Btn — pill-shaped action button. Three sizes, four variants.
// ───────────────────────────────────────────────────────────────────────

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
    sm: { h: 28, px: 12, fs: 12 },
    md: { h: 36, px: 16, fs: 13 },
    lg: { h: 44, px: 22, fs: 14 },
  }[size];
  const variants = {
    primary: { bg: T.ink,         fg: T.bg,        br: 'transparent' },
    ghost:   { bg: 'transparent', fg: T.ink,       br: T.rule },
    sage:    { bg: T.sageDim,     fg: T.sageDeep,  br: 'rgba(104,131,114,0.3)' },
    paper:   { bg: T.paper,       fg: T.ink,       br: T.rule },
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
        fontFamily: FONT_SANS, fontSize: sizes.fs, fontWeight: 500,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        display: 'inline-flex', alignItems: 'center', gap: 6,
        whiteSpace: 'nowrap', flexShrink: 0, ...style,
      }}
    >{children}</button>
  );
}

// ───────────────────────────────────────────────────────────────────────
// Card — the design's standard card (white, 18px radius, hairline border).
// ───────────────────────────────────────────────────────────────────────

export function Card({
  children, style = {}, padding = '20px 22px',
}: {
  children: React.ReactNode; style?: React.CSSProperties; padding?: string;
}) {
  return (
    <div style={{
      background: T.paper, border: `1px solid ${T.rule}`, borderRadius: 18,
      padding, ...style,
    }}>{children}</div>
  );
}

// ───────────────────────────────────────────────────────────────────────
// HousekeeperDot — colored circle with initials. Single source of truth
// for housekeeper avatars across the housekeeping tabs.
// ───────────────────────────────────────────────────────────────────────

const STAFF_TONES = ['#B8775E', '#688372', '#7B6A97', '#8C6A33', '#5E7A8C', '#6A8C70'];

export function staffTone(staff: Pick<StaffMember, 'id'>): string {
  // Stable hash → palette index. Same id always lands on the same color
  // so a housekeeper's dot color doesn't flip between renders / sessions.
  let h = 0;
  for (const ch of staff.id) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return STAFF_TONES[Math.abs(h) % STAFF_TONES.length];
}

export function staffInitials(staff: Pick<StaffMember, 'name'>): string {
  const parts = (staff.name || '').trim().split(/\s+/);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function HousekeeperDot({
  staff, size = 18, ring,
}: {
  staff: Pick<StaffMember, 'id' | 'name'>; size?: number; ring?: string;
}) {
  return (
    <span style={{
      width: size, height: size, borderRadius: '50%',
      background: staffTone(staff), color: '#fff',
      fontFamily: FONT_SANS, fontSize: Math.round(size * 0.45), fontWeight: 600,
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      flexShrink: 0,
      boxShadow: ring ? `0 0 0 2px ${ring}` : undefined,
    }}>{staffInitials(staff)}</span>
  );
}

