// Snow design system primitives for the admin tabs. Mirrors the
// housekeeping handoff (May 2026) so the admin cockpit lives in the
// same visual language as the rest of the redesigned app.
//
// Kept independent of housekeeping/_snow.tsx because that module
// imports Room/StaffMember types we don't need here.

'use client';

import React from 'react';

// ───────────────────────────────────────────────────────────────────────
// Palette tokens — bound to --snow-* CSS vars in globals.css.
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
  caramelDim: 'rgba(215,176,126,0.14)',
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
// Caps — 10px mono uppercase label, 0.16em tracking. Sits above every
// section heading and at the top of every stat row.
// ───────────────────────────────────────────────────────────────────────

export function Caps({
  children, size = 10, tracking = '0.16em', c, weight = 500, style = {},
}: {
  children: React.ReactNode; size?: number; tracking?: string;
  c?: string; weight?: number; style?: React.CSSProperties;
}) {
  return (
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

export type PillTone = 'neutral' | 'sage' | 'warm' | 'caramel' | 'red' | 'purple' | 'ink';

export function Pill({
  children, tone = 'neutral', style = {},
}: {
  children: React.ReactNode; tone?: PillTone; style?: React.CSSProperties;
}) {
  const palette = {
    neutral: { bg: 'transparent',                     fg: T.ink2,        br: T.rule },
    sage:    { bg: T.sageDim,                         fg: T.sageDeep,    br: 'rgba(104,131,114,0.25)' },
    warm:    { bg: T.warmDim,                         fg: T.warm,        br: 'rgba(184,119,94,0.25)' },
    caramel: { bg: T.caramelDim,                      fg: T.caramelDeep, br: 'rgba(140,106,51,0.25)' },
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

export type BtnVariant = 'primary' | 'ghost' | 'sage' | 'paper' | 'warm';
export type BtnSize = 'sm' | 'md' | 'lg';

export function Btn({
  variant = 'ghost', size = 'md', children, onClick, disabled,
  style = {}, type, title, ariaLabel, href,
}: {
  variant?: BtnVariant; size?: BtnSize;
  children: React.ReactNode;
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  disabled?: boolean;
  style?: React.CSSProperties;
  type?: 'button' | 'submit' | 'reset';
  title?: string;
  ariaLabel?: string;
  href?: string;
}) {
  const sizes = {
    sm: { h: 28, px: 12, fs: 12 },
    md: { h: 34, px: 14, fs: 12.5 },
    lg: { h: 44, px: 22, fs: 14 },
  }[size];
  const variants = {
    primary: { bg: T.ink,         fg: T.bg,        br: 'transparent' },
    ghost:   { bg: 'transparent', fg: T.ink,       br: T.rule },
    sage:    { bg: T.sageDim,     fg: T.sageDeep,  br: 'rgba(104,131,114,0.3)' },
    paper:   { bg: T.paper,       fg: T.ink,       br: T.rule },
    warm:    { bg: T.warmDim,     fg: T.warm,      br: 'rgba(184,119,94,0.30)' },
  }[variant];
  const css: React.CSSProperties = {
    height: sizes.h, padding: `0 ${sizes.px}px`, borderRadius: 999,
    background: variants.bg, color: variants.fg,
    border: `1px solid ${variants.br}`,
    fontFamily: FONT_SANS, fontSize: sizes.fs, fontWeight: 500,
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.5 : 1,
    display: 'inline-flex', alignItems: 'center', gap: 6,
    whiteSpace: 'nowrap', flexShrink: 0, textDecoration: 'none', ...style,
  };
  if (href && !disabled) {
    return (
      <a href={href} style={css} title={title} aria-label={ariaLabel}>{children}</a>
    );
  }
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      type={type ?? 'button'}
      title={title}
      aria-label={ariaLabel}
      style={css}
    >{children}</button>
  );
}

// ───────────────────────────────────────────────────────────────────────
// Card — design's standard card (white, 18px radius, hairline border).
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
// SerifNum — hero italic-serif number (84%, 12 rooms, etc.). The single
// visual moment in every Snow page.
// ───────────────────────────────────────────────────────────────────────

export function SerifNum({
  children, size = 54, italic = true, c, style = {},
}: {
  children: React.ReactNode; size?: number; italic?: boolean;
  c?: string; style?: React.CSSProperties;
}) {
  return (
    <span style={{
      fontFamily: FONT_SERIF, fontStyle: italic ? 'italic' : 'normal',
      fontSize: size, fontWeight: 400, lineHeight: 0.95,
      letterSpacing: '-0.03em', color: c || T.ink, ...style,
    }}>{children}</span>
  );
}

// ───────────────────────────────────────────────────────────────────────
// SectionHeader — caps label + H1 row used on every tab.
// ───────────────────────────────────────────────────────────────────────

export function SectionHeader({
  caps, title, right, italicSpan,
}: {
  caps: React.ReactNode;
  title: React.ReactNode;
  italicSpan?: React.ReactNode;
  right?: React.ReactNode;
}) {
  return (
    <div style={{
      display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between',
      gap: 16, flexWrap: 'wrap', marginBottom: 14,
    }}>
      <div style={{ minWidth: 0 }}>
        <Caps>{caps}</Caps>
        <h1 style={{
          fontFamily: FONT_SERIF, fontSize: 32, fontWeight: 400,
          letterSpacing: '-0.02em', color: T.ink, margin: '4px 0 0',
          lineHeight: 1.15,
        }}>
          {title}
          {italicSpan && (
            <> <span style={{ fontStyle: 'italic' }}>{italicSpan}</span></>
          )}
        </h1>
      </div>
      {right && <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>{right}</div>}
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────
// MonoNum — mono numeric (table cells, timestamps, money).
// ───────────────────────────────────────────────────────────────────────

export function MonoNum({
  children, size = 13, weight = 500, c, style = {},
}: {
  children: React.ReactNode; size?: number; weight?: number;
  c?: string; style?: React.CSSProperties;
}) {
  return (
    <span style={{
      fontFamily: FONT_MONO, fontSize: size, fontWeight: weight,
      color: c || T.ink, ...style,
    }}>{children}</span>
  );
}

// ───────────────────────────────────────────────────────────────────────
// StatusDot — colored circle (briefing items, severity indicators).
// ───────────────────────────────────────────────────────────────────────

export function StatusDot({ tone = 'sage', size = 7 }: { tone?: 'sage' | 'warm' | 'caramel' | 'red' | 'ink' | 'muted'; size?: number }) {
  const colors = {
    sage:    T.sageDeep,
    warm:    T.warm,
    caramel: T.caramel,
    red:     T.red,
    ink:     T.ink,
    muted:   T.ink3,
  };
  return (
    <span style={{
      display: 'inline-block', width: size, height: size, borderRadius: '50%',
      background: colors[tone], flexShrink: 0,
    }} />
  );
}
