'use client';

// Small Concourse-design primitives + API helpers shared across the Financials
// tabs. Tokens follow the Concourse shell style contract (see
// src/components/concourse/concourse-css.tsx) so Financials sits natively on
// the app-wide radial wash: Geist for UI, Geist Mono for data, sage/amber/rust
// accents, hairline cards. All money is integer cents; dollars only appear as
// display/input.

import React from 'react';
import { fetchWithAuth } from '@/lib/api-fetch';
import { readEnvelope, type EnvelopeResult } from '@/lib/api-envelope';
import { EmptyState } from '@/app/_components/ui/EmptyState';
import { formatCents, type BudgetStatus } from '@/lib/financials/shared';

export const FONT_SANS = 'var(--font-geist), -apple-system, BlinkMacSystemFont, sans-serif';
export const FONT_MONO = 'var(--font-geist-mono), ui-monospace, monospace';
// Concourse has no serif display face — former serif/italic display type
// renders as Geist 600. Kept as a named export so call sites keep compiling.
export const FONT_SERIF = FONT_SANS;

// Concourse ink + brand tokens (raw hex — badges derive alpha washes from
// these, which CSS variables can't do).
export const T = {
  bg: '#FFFFFF',
  paper: '#FFFFFF',
  ink: '#1F231C',
  ink2: '#5C625C',
  ink3: '#8A9187',
  faint: '#A6ABA6',
  rule: 'rgba(31,35,28,0.08)',
  ruleSoft: 'rgba(31,35,28,0.05)',
  ruleInput: 'rgba(31,35,28,0.14)',
  sage: '#5C7A60',
  sageBrand: '#3E5C48',
  sageDeep: '#356B4C',
  sageDim: 'rgba(92,122,96,0.14)',
  caramel: '#C99644',
  caramelDeep: '#8C6A33',
  warm: '#B85C3D',
  warmDim: 'rgba(184,92,61,0.10)',
} as const;

export const SPRING = 'cubic-bezier(.22,1,.36,1)';
export const CARD_SHADOW = '0 6px 16px -14px rgba(31,42,32,0.35)';
export const CARD_SHADOW_HOVER = '0 18px 36px -20px rgba(62,92,72,0.5)';

export const STATUS_COLOR: Record<BudgetStatus, string> = {
  good: T.sageDeep,
  warn: T.caramel,
  over: T.warm,
  none: T.ink3,
};

// ── API helpers ─────────────────────────────────────────────────────────────
// Imperative envelope calls (F2's readEnvelope) for one-off reads/writes.
// Interval-free page reads use useApiResource directly; these never throw
// (network / session errors become an error result — no financials surface
// renders the message text, only "could not save/load" strings).
export async function finGet<T>(url: string): Promise<EnvelopeResult<T>> {
  try {
    return await readEnvelope<T>(await fetchWithAuth(url));
  } catch (e) {
    return { error: e instanceof Error && e.message ? e.message : 'network' };
  }
}

export async function finSend<T = unknown>(
  url: string,
  method: 'POST' | 'PATCH' | 'DELETE',
  body: unknown,
): Promise<EnvelopeResult<T>> {
  try {
    return await readEnvelope<T>(
      await fetchWithAuth(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
  } catch (e) {
    return { error: e instanceof Error && e.message ? e.message : 'network' };
  }
}

// ── Money display ───────────────────────────────────────────────────────────
export function Money({
  cents,
  size = 14,
  weight = 600,
  color,
  showCents = true,
}: {
  cents: number | null | undefined;
  size?: number;
  weight?: number;
  color?: string;
  showCents?: boolean;
}) {
  return (
    <span style={{ fontFamily: FONT_MONO, fontSize: size, fontWeight: weight, color: color ?? T.ink, letterSpacing: '-0.01em', whiteSpace: 'nowrap' }}>
      {formatCents(cents, { showCents })}
    </span>
  );
}

// ── Buttons ─────────────────────────────────────────────────────────────────
export function Btn({
  children,
  onClick,
  variant = 'primary',
  disabled = false,
  type = 'button',
  style = {},
}: {
  children: React.ReactNode;
  onClick?: () => void;
  variant?: 'primary' | 'ghost' | 'danger';
  disabled?: boolean;
  type?: 'button' | 'submit';
  style?: React.CSSProperties;
}) {
  const base: React.CSSProperties = {
    padding: '9px 16px',
    borderRadius: 999,
    fontFamily: FONT_SANS,
    fontSize: 12.5,
    fontWeight: 600,
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.5 : 1,
    whiteSpace: 'nowrap',
    transition: `all 0.3s ${SPRING}`,
    display: 'inline-flex',
    alignItems: 'center',
    gap: 7,
    ...style,
  };
  const variants: Record<string, React.CSSProperties> = {
    primary: { background: T.sageBrand, color: '#fff', border: `1px solid ${T.sageBrand}` },
    ghost: { background: 'transparent', color: T.ink2, border: `1px solid ${T.ruleInput}` },
    danger: { background: 'transparent', color: T.warm, border: `1px solid ${T.warm}44` },
  };
  return (
    <button type={type} onClick={onClick} disabled={disabled} style={{ ...base, ...variants[variant] }}>
      {children}
    </button>
  );
}

// ── Status pill ───────────────────────────────────────────────────────────
export function Pill({ label, color, style = {} }: { label: string; color: string; style?: React.CSSProperties }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        padding: '4px 9px',
        borderRadius: 999,
        background: `${color}1A`,
        color,
        fontFamily: FONT_MONO,
        fontSize: 10,
        fontWeight: 600,
        letterSpacing: '0.06em',
        textTransform: 'uppercase',
        whiteSpace: 'nowrap',
        ...style,
      }}
    >
      {label}
    </span>
  );
}

// ── Dollar input (text → parent keeps the raw string; convert on save) ──────
export function DollarInput({
  value,
  onChange,
  placeholder = '0.00',
  autoFocus = false,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  return (
    <div style={{ position: 'relative', width: '100%' }}>
      <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', fontFamily: FONT_MONO, fontSize: 14, color: T.ink3 }}>$</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        inputMode="decimal"
        autoFocus={autoFocus}
        style={{
          height: 40,
          padding: '0 14px 0 24px',
          borderRadius: 10,
          background: T.bg,
          border: `1px solid ${T.ruleInput}`,
          fontFamily: FONT_MONO,
          fontSize: 14,
          color: T.ink,
          width: '100%',
          boxSizing: 'border-box',
          outline: 'none',
        }}
      />
    </div>
  );
}

// ── Budget bar ───────────────────────────────────────────────────────────
export function BudgetBar({
  actualCents,
  budgetCents,
  status,
  height = 8,
}: {
  actualCents: number;
  budgetCents: number;
  status: BudgetStatus;
  height?: number;
}) {
  const color = STATUS_COLOR[status];
  const ratio = budgetCents > 0 ? actualCents / budgetCents : 0;
  const fill = Math.max(0, Math.min(1, ratio));
  return (
    <div style={{ width: '100%', height, borderRadius: 999, background: 'rgba(31,35,28,0.06)', overflow: 'hidden', position: 'relative' }}>
      <div
        style={{
          height: '100%',
          width: `${fill * 100}%`,
          background: budgetCents > 0 ? color : T.ink3,
          borderRadius: 999,
          transition: `width 0.3s ${SPRING}`,
        }}
      />
    </div>
  );
}

// ── Card shell ───────────────────────────────────────────────────────────
export function Card({ children, style = {} }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div
      style={{
        background: T.paper,
        border: `1px solid ${T.rule}`,
        borderRadius: 16,
        padding: 18,
        boxShadow: CARD_SHADOW,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

// ── Empty / error state ──────────────────────────────────────────────────
// Financials-themed shared EmptyState (F11). Same signature as the old local
// Notice; the click-anywhere-to-retry affordance rides EmptyState's container
// onClick, and the exact prior visuals come in via theme props.
export function Notice({ text, onRetry }: { text: string; onRetry?: () => void }) {
  return (
    <EmptyState
      body={text}
      onClick={onRetry}
      color={T.ink2}
      fontFamily={FONT_SANS}
      style={{ cursor: onRetry ? 'pointer' : 'default' }}
    />
  );
}
