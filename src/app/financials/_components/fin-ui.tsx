'use client';

// Small Snow-design primitives + API helpers shared across the Financials tabs.
// Reuses the locked palette/fonts from the housekeeping snow tokens (via the
// maintenance re-export) so Financials is visually identical to the rest of the
// cockpit. All money is integer cents; dollars only appear as display/input.

import React from 'react';
import { T, FONT_SANS, FONT_MONO, FONT_SERIF } from '@/app/maintenance/_components/_mt-snow';
import { fetchWithAuth } from '@/lib/api-fetch';
import { formatCents, type BudgetStatus } from '@/lib/financials/shared';

export { T, FONT_SANS, FONT_MONO, FONT_SERIF };

export const STATUS_COLOR: Record<BudgetStatus, string> = {
  good: T.sageDeep,
  warn: T.caramelDeep,
  over: T.warm,
  none: T.ink3,
};

// ── API envelope helpers (unwrap { ok, data, error } from fetchWithAuth) ────
export interface ApiResult<T> {
  ok: boolean;
  status: number;
  data: T | null;
  error: string | null;
  code: string | null;
}

async function unwrap<T>(res: Response): Promise<ApiResult<T>> {
  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    /* non-JSON */
  }
  return {
    ok: res.ok && body.ok === true,
    status: res.status,
    data: (body.data as T) ?? null,
    error: (body.error as string) ?? (res.ok ? null : `HTTP ${res.status}`),
    code: (body.code as string) ?? null,
  };
}

export async function apiGet<T>(url: string): Promise<ApiResult<T>> {
  try {
    const res = await fetchWithAuth(url);
    return unwrap<T>(res);
  } catch (e) {
    return { ok: false, status: 0, data: null, error: e instanceof Error ? e.message : 'network', code: 'network' };
  }
}

export async function apiSend<T>(
  url: string,
  method: 'POST' | 'PATCH' | 'DELETE',
  body: unknown,
): Promise<ApiResult<T>> {
  try {
    const res = await fetchWithAuth(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return unwrap<T>(res);
  } catch (e) {
    return { ok: false, status: 0, data: null, error: e instanceof Error ? e.message : 'network', code: 'network' };
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
export function Notice({ text, onRetry }: { text: string; onRetry?: () => void }) {
  return (
    <div
      onClick={onRetry}
      style={{
        padding: '40px 20px',
        textAlign: 'center',
        fontFamily: FONT_SANS,
        fontSize: 14,
        color: T.ink2,
        cursor: onRetry ? 'pointer' : 'default',
      }}
    >
      {text}
    </div>
  );
}
