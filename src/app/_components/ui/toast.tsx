'use client';

// Shared toast primitive (F7): useToast() + <ToastHost/> + <Banner/>.
//
// Replaces the hand-rolled toasts in housekeeper/[id]/page.tsx (error toast,
// timer-reset on re-show), front-desk/page.tsx (success pill), and
// inventory's banner() (inline strip). Everything visual is parameterized —
// position, offset, and full colors come from the page so each area keeps
// its exact current look/placement. No palette constants in this file.
//
// Usage:
//   const { toasts, show, dismiss } = useToast({ durationMs: 4500 });
//   show('Saved', { tone: 'success' });
//   ...
//   <ToastHost
//     toasts={toasts}
//     onDismiss={dismiss}
//     position="top"
//     offset="env(safe-area-inset-top, 12px)"
//     toneStyles={{ error: { background: '#DC2626', color: '#fff' } }}
//   />

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  addToast,
  removeToast,
  resolveDurationMs,
  toastContainerStyle,
  bannerStyle,
  type BannerStyleOptions,
  type ToastItem,
  type ToastPosition,
} from './toast-core';

export type { ToastItem, ToastPosition } from './toast-core';

export interface ShowToastOptions {
  /** Tone key mapped to colors by <ToastHost toneStyles>. Default 'default'. */
  tone?: string;
  /** Auto-dismiss after this many ms. `null` = sticky until dismissed. */
  durationMs?: number | null;
}

export interface UseToastOptions {
  /** Default auto-dismiss (ms). Default 4000. */
  durationMs?: number;
  /** Cap on simultaneously visible toasts; oldest is dropped. Default 3. */
  max?: number;
}

export function useToast(options?: UseToastOptions): {
  toasts: ToastItem[];
  show: (message: React.ReactNode, opts?: ShowToastOptions) => number;
  dismiss: (id?: number) => void;
} {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const timersRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());
  const seqRef = useRef(0);
  const defaultMs = options?.durationMs ?? 4000;
  const max = options?.max ?? 3;

  const clearTimer = useCallback((id: number) => {
    const timer = timersRef.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timersRef.current.delete(id);
    }
  }, []);

  const dismiss = useCallback(
    (id?: number) => {
      if (id === undefined) {
        timersRef.current.forEach((timer) => clearTimeout(timer));
        timersRef.current.clear();
        setToasts([]);
        return;
      }
      clearTimer(id);
      setToasts((list) => removeToast(list, id));
    },
    [clearTimer],
  );

  const show = useCallback(
    (message: React.ReactNode, opts?: ShowToastOptions): number => {
      const id = ++seqRef.current;
      setToasts((list) => addToast(list, { id, message, tone: opts?.tone ?? 'default' }, max));
      const duration = resolveDurationMs(opts?.durationMs, defaultMs);
      if (duration !== null) {
        timersRef.current.set(
          id,
          setTimeout(() => {
            timersRef.current.delete(id);
            setToasts((list) => removeToast(list, id));
          }, duration),
        );
      }
      return id;
    },
    [defaultMs, max],
  );

  // Clear all pending timers on unmount.
  useEffect(
    () => () => {
      timersRef.current.forEach((timer) => clearTimeout(timer));
      timersRef.current.clear();
    },
    [],
  );

  return { toasts, show, dismiss };
}

export interface ToastHostProps {
  toasts: ToastItem[];
  onDismiss?: (id: number) => void;
  /** Edge the stack anchors to. Default 'top'. */
  position?: ToastPosition;
  /** CSS length from that edge, e.g. '24px' or 'env(safe-area-inset-top, 12px)'. */
  offset?: string;
  zIndex?: number;
  /** Per-tone styling — THE look lives here, passed by the page. */
  toneStyles?: Record<string, React.CSSProperties>;
  /** Base style merged under every tone (page's shared pill/card shape). */
  toastStyle?: React.CSSProperties;
  /** Optional leading icon per tone (front-desk's check_circle, hk's triangle). */
  renderIcon?: (tone: string) => React.ReactNode;
  /** Tapping a toast dismisses it. Default true when onDismiss is provided. */
  dismissOnClick?: boolean;
  /** Screen-reader urgency. Default 'polite'; housekeeper errors use 'assertive'. */
  ariaLive?: 'polite' | 'assertive';
}

export function ToastHost({
  toasts,
  onDismiss,
  position = 'top',
  offset = '16px',
  zIndex = 1100,
  toneStyles,
  toastStyle,
  renderIcon,
  dismissOnClick,
  ariaLive = 'polite',
}: ToastHostProps): React.ReactElement | null {
  if (toasts.length === 0) return null;
  const clickable = dismissOnClick ?? onDismiss !== undefined;

  return (
    <div style={toastContainerStyle(position, offset, zIndex)}>
      {toasts.map((t) => {
        const icon = renderIcon?.(t.tone);
        return (
          <div
            key={t.id}
            role={ariaLive === 'assertive' ? 'alert' : 'status'}
            aria-live={ariaLive}
            onClick={clickable && onDismiss ? () => onDismiss(t.id) : undefined}
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 10,
              pointerEvents: 'auto',
              cursor: clickable ? 'pointer' : 'default',
              ...toastStyle,
              ...toneStyles?.[t.tone],
            }}
          >
            {icon != null && <span style={{ flexShrink: 0 }}>{icon}</span>}
            <span style={{ flex: 1 }}>{t.message}</span>
          </div>
        );
      })}
    </div>
  );
}

// ── Banner ─────────────────────────────────────────────────────────────────
// Inline (non-floating) notice strip — parameterized version of inventory's
// banner(color). Renders in normal flow where the page places it; sticky
// until the state that shows it clears (or via the optional dismiss ✕).

export interface BannerProps extends BannerStyleOptions {
  children: React.ReactNode;
  onDismiss?: () => void;
  dismissLabel?: string;
  style?: React.CSSProperties;
}

export function Banner({
  children,
  onDismiss,
  dismissLabel = 'Dismiss',
  style,
  ...styleOpts
}: BannerProps): React.ReactElement {
  return (
    <div
      role="status"
      style={{
        ...bannerStyle(styleOpts),
        ...(onDismiss
          ? { display: 'flex', alignItems: 'flex-start', gap: 10 }
          : null),
        ...style,
      }}
    >
      {onDismiss ? <span style={{ flex: 1 }}>{children}</span> : children}
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label={dismissLabel}
          style={{
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
            padding: 0,
            lineHeight: 1,
            fontSize: 14,
            color: 'inherit',
            flexShrink: 0,
          }}
        >
          ✕
        </button>
      )}
    </div>
  );
}
