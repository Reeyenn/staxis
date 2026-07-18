// Pure logic for the shared toast primitive (F7) — list operations, duration
// resolution, and container placement styles.
//
// No 'use client', no React runtime import: the node:test suite runs with
// --conditions=react-server and imports this file directly.
//
// Capability set matches the three hand-rolled implementations it replaces:
//   - housekeeper/[id]/page.tsx  — single error toast, 4.5s auto-dismiss,
//     re-show resets the timer, fixed top-center.
//   - front-desk/page.tsx        — success/error pill, 2.5s auto-dismiss,
//     fixed top-center.
//   - inline strips, tone = border color, no timer (see <Banner/> in toast.tsx).

import type { CSSProperties, ReactNode } from 'react';

export type ToastPosition = 'top' | 'bottom';

export interface ToastItem {
  id: number;
  message: ReactNode;
  /** Free-form tone key ('success', 'error', …) — the host maps it to colors. */
  tone: string;
  /** True while the toast is playing its exit transition (only ever set when
   *  useToast is given exitMs; absent otherwise — removal is instant). */
  exiting?: boolean;
}

/** Append a toast; when `max` is set, drop the oldest beyond it. */
export function addToast(list: ToastItem[], item: ToastItem, max?: number): ToastItem[] {
  const next = [...list.filter((t) => t.id !== item.id), item];
  if (max !== undefined && max > 0 && next.length > max) {
    return next.slice(next.length - max);
  }
  return next;
}

export function removeToast(list: ToastItem[], id: number): ToastItem[] {
  return list.filter((t) => t.id !== id);
}

/** Flag a toast as exiting (kept in the list so the host can play its exit
 *  transition before removeToast). Unknown id / already-exiting = no-op. */
export function markToastExiting(list: ToastItem[], id: number): ToastItem[] {
  if (!list.some((t) => t.id === id && !t.exiting)) return list;
  return list.map((t) => (t.id === id ? { ...t, exiting: true } : t));
}

/**
 * Auto-dismiss duration: explicit number wins, `null` means sticky (no
 * timer), undefined falls back to the hook default.
 */
export function resolveDurationMs(
  durationMs: number | null | undefined,
  defaultMs: number,
): number | null {
  if (durationMs === null) return null;
  if (typeof durationMs === 'number') return durationMs;
  return defaultMs;
}

/**
 * Fixed, centered container for floating toasts. `offset` is a CSS length
 * from the chosen edge (housekeeper uses 'env(safe-area-inset-top, 12px)',
 * front-desk uses '24px').
 */
export function toastContainerStyle(
  position: ToastPosition,
  offset: string,
  zIndex: number,
): CSSProperties {
  return {
    position: 'fixed',
    [position === 'top' ? 'top' : 'bottom']: offset,
    left: '50%',
    transform: 'translateX(-50%)',
    zIndex,
    display: 'flex',
    flexDirection: position === 'top' ? 'column' : 'column-reverse',
    alignItems: 'center',
    gap: 8,
    maxWidth: 'calc(100vw - 24px)',
    pointerEvents: 'none',
  };
}

export interface BannerStyleOptions {
  background?: string;
  /** All-around border color (inventory passes the tone color). */
  borderColor?: string;
  /** Thicker left stripe color; defaults to borderColor. */
  accentColor?: string;
  color?: string;
  radius?: number | string;
  padding?: string;
  fontFamily?: string;
  fontSize?: number | string;
}

/**
 * Inline banner strip — parameterized version of inventory's banner():
 * 1px border in the tone color, 3px left stripe, rounded, small text.
 */
export function bannerStyle(opts: BannerStyleOptions = {}): CSSProperties {
  const border = opts.borderColor ?? 'rgba(0,0,0,0.2)';
  return {
    background: opts.background ?? 'transparent',
    border: `1px solid ${border}`,
    borderLeft: `3px solid ${opts.accentColor ?? border}`,
    borderRadius: opts.radius ?? 10,
    padding: opts.padding ?? '10px 14px',
    fontFamily: opts.fontFamily ?? 'inherit',
    fontSize: opts.fontSize ?? 13,
    color: opts.color ?? 'inherit',
  };
}
