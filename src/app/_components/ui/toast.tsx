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
  markToastExiting,
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
  /**
   * Exit-transition hold (ms): a dismissed/expired toast stays in the list
   * flagged `exiting` for this long before removal, so <ToastHost
   * transition> can play its unmountStyle. Default absent = instant removal
   * (current behavior, no animation).
   */
  exitMs?: number;
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
  const exitMs = options?.exitMs;

  const clearTimer = useCallback((id: number) => {
    const timer = timersRef.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timersRef.current.delete(id);
    }
  }, []);

  // Retire a toast: instantly (default) or via the exiting-flag hold so the
  // host can play an exit transition (exitMs set).
  const beginExit = useCallback(
    (id: number) => {
      if (exitMs !== undefined && exitMs > 0) {
        setToasts((list) => markToastExiting(list, id));
        timersRef.current.set(
          id,
          setTimeout(() => {
            timersRef.current.delete(id);
            setToasts((list) => removeToast(list, id));
          }, exitMs),
        );
        return;
      }
      setToasts((list) => removeToast(list, id));
    },
    [exitMs],
  );

  const dismiss = useCallback(
    (id?: number) => {
      if (id === undefined) {
        timersRef.current.forEach((timer) => clearTimeout(timer));
        timersRef.current.clear();
        setToasts([]);
        return;
      }
      clearTimer(id);
      beginExit(id);
    },
    [clearTimer, beginExit],
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
            beginExit(id);
          }, duration),
        );
      }
      return id;
    },
    [defaultMs, max, beginExit],
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

export interface ToastTransition {
  /**
   * Style each toast STARTS at on mount (e.g. { opacity: 0, transform:
   * 'translateY(-8px)' }); it transitions to the resting style over
   * durationMs — a slide/fade-in.
   */
  mountStyle?: React.CSSProperties;
  /**
   * Style an exiting toast transitions TO before unmount. Only plays when
   * the owning useToast() was given exitMs (which holds the toast in the
   * list long enough for this to be visible).
   */
  unmountStyle?: React.CSSProperties;
  /** Transition duration in ms. Default 200. */
  durationMs?: number;
  /** CSS transition easing. Default 'ease'. */
  easing?: string;
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
  /**
   * Optional enter/exit animation (slide/fade). Default absent = no
   * animation, exactly today's rendering. Exit additionally needs
   * useToast({ exitMs }) so the toast is held while unmountStyle plays.
   */
  transition?: ToastTransition;
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
  transition,
}: ToastHostProps): React.ReactElement | null {
  if (toasts.length === 0) return null;
  const clickable = dismissOnClick ?? onDismiss !== undefined;

  return (
    <div style={toastContainerStyle(position, offset, zIndex)}>
      {toasts.map((t) => {
        const icon = renderIcon?.(t.tone);
        return (
          <ToastRow
            key={t.id}
            toast={t}
            transition={transition}
            role={ariaLive === 'assertive' ? 'alert' : 'status'}
            ariaLive={ariaLive}
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
            icon={icon}
          />
        );
      })}
    </div>
  );
}

// One rendered toast. Without `transition` this outputs exactly the same
// element as before (no transition CSS property, no extra styles). With it,
// the row mounts at mountStyle and transitions to rest (double-rAF so the
// browser paints the start state first), and transitions to unmountStyle
// while the item is flagged `exiting` (useToast's exitMs hold).
function ToastRow({
  toast,
  transition,
  role,
  ariaLive,
  onClick,
  style,
  icon,
}: {
  toast: ToastItem;
  transition?: ToastTransition;
  role: string;
  ariaLive: 'polite' | 'assertive';
  onClick?: () => void;
  style: React.CSSProperties;
  icon: React.ReactNode;
}): React.ReactElement {
  const hasEnter = transition?.mountStyle !== undefined;
  const [entered, setEntered] = useState(!hasEnter);
  useEffect(() => {
    if (entered) return;
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => setEntered(true));
    });
    return () => {
      cancelAnimationFrame(raf1);
      if (raf2) cancelAnimationFrame(raf2);
    };
  }, [entered]);

  const animStyle: React.CSSProperties = transition
    ? {
        transition: `all ${transition.durationMs ?? 200}ms ${transition.easing ?? 'ease'}`,
        ...(!entered ? transition.mountStyle : null),
        ...(toast.exiting ? transition.unmountStyle : null),
      }
    : {};

  return (
    <div
      role={role}
      aria-live={ariaLive}
      onClick={onClick}
      style={{ ...style, ...animStyle }}
    >
      {icon != null && <span style={{ flexShrink: 0 }}>{icon}</span>}
      <span style={{ flex: 1 }}>{toast.message}</span>
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
