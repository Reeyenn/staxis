'use client';

// Small Snow-design primitives + API helpers shared across the Financials tabs.
// Reuses the locked palette/fonts from the housekeeping snow tokens (via the
// maintenance re-export) so Financials is visually identical to the rest of the
// cockpit. All money is integer cents; dollars only appear as display/input.

import React from 'react';
import { T, FONT_SANS, FONT_MONO, FONT_SERIF } from '@/app/maintenance/_components/_mt-snow';
import { fetchWithAuth } from '@/lib/api-fetch';
import { readEnvelope, type EnvelopeResult } from '@/lib/api-envelope';
import { EmptyState } from '@/app/_components/ui/EmptyState';
import { formatCents, type BudgetStatus } from '@/lib/financials/shared';

export { T, FONT_SANS, FONT_MONO, FONT_SERIF };

export const STATUS_COLOR: Record<BudgetStatus, string> = {
  good: T.sageDeep,
  warn: T.caramelDeep,
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
    borderRadius: 10,
    fontFamily: FONT_SANS,
    fontSize: 13,
    fontWeight: 600,
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.5 : 1,
    whiteSpace: 'nowrap',
    transition: 'all 0.15s',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 7,
    ...style,
  };
  const variants: Record<string, React.CSSProperties> = {
    primary: { background: T.ink, color: T.bg, border: `1px solid ${T.ink}` },
    ghost: { background: 'transparent', color: T.ink, border: `1px solid ${T.rule}` },
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
        padding: '3px 9px',
        borderRadius: 999,
        background: `${color}14`,
        color,
        border: `1px solid ${color}33`,
        fontFamily: FONT_SANS,
        fontSize: 11,
        fontWeight: 600,
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
          border: `1px solid ${T.rule}`,
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
    <div style={{ width: '100%', height, borderRadius: 999, background: T.rule, overflow: 'hidden', position: 'relative' }}>
      <div
        style={{
          height: '100%',
          width: `${fill * 100}%`,
          background: budgetCents > 0 ? color : T.ink3,
          borderRadius: 999,
          transition: 'width 0.3s ease',
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
