'use client';

// Shared Modal primitive (F6) for the staff-pages overhaul.
//
// Based on the best existing implementation — src/app/inventory/_components/
// overlays/Overlay.tsx — but theme-parameterized (NO palette baked in) so
// every area keeps its exact current look. Behaviors carried over:
//
//   - Presence management: the card stays mounted for ~200ms after `open`
//     flips false so the exit animation can play. Callers keep the plain
//     `open`/`onClose` contract.
//   - WAAPI enter/exit (element.animate) so motion survives
//     prefers-reduced-motion (see inventory/_components/motion.ts).
//   - ESC to close (opt-out via escToClose={false} for modals that lack it
//     today), click-outside-to-close (opt-out via scrimClose={false}),
//     body scroll lock while open.
//
// New over Overlay: variant 'sheet' (bottom sheet), and portal (createPortal
// to document.body) so housekeeping/maintenance modals can escape
// transform/overflow containers.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  modalCardStyle,
  modalEnterTransform,
  modalExitTransform,
  modalScrimStyle,
  resolveModalTheme,
  type ModalTheme,
  type ModalVariant,
} from './modal-core';

const EXIT_MS = 190;
const ENTER_MS = 380;
// Slight-overshoot arrival — same "spring" easing as inventory's motion.ts.
const ENTER_EASE = 'cubic-bezier(.22,1.4,.36,1)';

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  /** 'center' (default) = centered card; 'sheet' = bottom sheet. */
  variant?: ModalVariant;
  /** true = createPortal to document.body (escapes transform containers). Default false. */
  portal?: boolean;
  /** Default true. Pass false to replicate modals that lack ESC today. */
  escToClose?: boolean;
  /** Default true. Pass false to disable click-outside-to-close. */
  scrimClose?: boolean;
  /** id of the element that titles this dialog (aria-labelledby). */
  labelledBy?: string;
  theme?: ModalTheme;
  children: React.ReactNode;
}

export function Modal({
  open,
  onClose,
  variant = 'center',
  portal = false,
  escToClose = true,
  scrimClose = true,
  labelledBy,
  theme,
  children,
}: ModalProps): React.ReactElement | null {
  const scrimRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  // Presence: keep rendering during the exit animation, then unmount.
  const [render, setRender] = useState(open);
  // Portal target only exists client-side; never touch document during SSR.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const t = useMemo(() => resolveModalTheme(theme), [theme]);

  // Exit: play the fade/settle-out, then unmount after EXIT_MS.
  useEffect(() => {
    if (open) {
      setRender(true);
      return;
    }
    if (!render) return;
    scrimRef.current?.animate(
      [{ opacity: 1 }, { opacity: 0 }],
      { duration: EXIT_MS, easing: 'ease-in', fill: 'forwards' },
    );
    cardRef.current?.animate(
      [
        { opacity: 1, transform: 'none' },
        { opacity: variant === 'sheet' ? 1 : 0, transform: modalExitTransform(variant) },
      ],
      { duration: EXIT_MS, easing: 'ease-in', fill: 'forwards' },
    );
    const timer = setTimeout(() => setRender(false), EXIT_MS + 30);
    return () => clearTimeout(timer);
  }, [open, variant, render]);

  // ESC + body scroll lock while open.
  useEffect(() => {
    if (!open) return;
    const onKey = escToClose
      ? (e: KeyboardEvent) => {
          if (e.key === 'Escape') onClose();
        }
      : null;
    if (onKey) window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      if (onKey) window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open, escToClose, onClose]);

  // WAAPI entrance — fill:'none' so the resting state is the element's own
  // visible style (never stuck invisible if the timeline is throttled). Keyed
  // on `render` too: the first open mounts the DOM one commit after `open`
  // flips, and the animation must run on that commit, when the refs exist.
  // Also keyed on `mounted` for portal modals mounted with open=true — their
  // first commit returns null (portal target not ready), so the animation
  // must run on the later commit where the DOM finally exists. The played
  // guard keeps dep changes mid-open (mounted flip, variant change) from
  // replaying the entrance.
  const enterPlayedRef = useRef(false);
  useEffect(() => {
    if (!open || !render) {
      enterPlayedRef.current = false;
      return;
    }
    // Refs are null while a portal modal waits for `mounted` — skip WITHOUT
    // marking played so the mounted-flip re-run animates for real.
    if (!scrimRef.current || !cardRef.current) return;
    if (enterPlayedRef.current) return;
    enterPlayedRef.current = true;
    scrimRef.current.animate(
      [{ opacity: 0 }, { opacity: 1 }],
      { duration: 200, delay: 10, easing: 'ease-out', fill: 'none' },
    );
    cardRef.current.animate(
      [
        { opacity: variant === 'sheet' ? 1 : 0, transform: modalEnterTransform(variant) },
        { opacity: 1, transform: 'none' },
      ],
      {
        duration: ENTER_MS,
        delay: 10,
        easing: variant === 'sheet' ? 'cubic-bezier(.16,.84,.3,1)' : ENTER_EASE,
        fill: 'none',
      },
    );
  }, [open, render, mounted, variant]);

  if (!render) return null;
  if (portal && !mounted) return null;

  const content = (
    <div
      ref={scrimRef}
      onMouseDown={(e) => {
        if (scrimClose && e.target === e.currentTarget) onClose();
      }}
      style={{ ...modalScrimStyle(variant, t), pointerEvents: open ? 'auto' : 'none' }}
    >
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        onMouseDown={(e) => e.stopPropagation()}
        style={modalCardStyle(variant, t)}
      >
        {children}
      </div>
    </div>
  );

  return portal ? createPortal(content, document.body) : content;
}

// ── useConfirm ─────────────────────────────────────────────────────────────
// Promise-based two-button (optionally typed) confirmation built on Modal.
// Replaces the hand-rolled window.confirm / bespoke confirm-modals across
// staff pages. Theme-parameterized like Modal — no palette inside.
//
//   const { confirm, element } = useConfirm();
//   ...
//   if (await confirm({ title: 'Delete room?', confirmLabel: 'Delete' })) { ... }
//   ...
//   return <>{page}{element}</>;

export interface ConfirmTheme extends ModalTheme {
  /** Body text color. */
  text?: string;
  /** Secondary text color (message under the title). */
  dim?: string;
  /** Border COLOR for the cancel button + typed input. (The card's own
   *  border comes from ModalTheme.border, a full CSS shorthand.) */
  controlBorder?: string;
  fontFamily?: string;
  confirmBg?: string;
  confirmColor?: string;
  cancelBg?: string;
  cancelColor?: string;
}

export interface ConfirmOptions {
  title?: React.ReactNode;
  message?: React.ReactNode;
  confirmLabel?: React.ReactNode;
  cancelLabel?: React.ReactNode;
  /** If set, the user must type this exact string before Confirm enables. */
  typedText?: string;
  typedPlaceholder?: string;
  variant?: ModalVariant;
  portal?: boolean;
  theme?: ConfirmTheme;
}

interface PendingConfirm {
  opts: ConfirmOptions;
  resolve: (value: boolean) => void;
}

export function useConfirm(defaults?: ConfirmOptions): {
  confirm: (opts?: ConfirmOptions) => Promise<boolean>;
  element: React.ReactElement;
} {
  const [pending, setPending] = useState<PendingConfirm | null>(null);
  const [typed, setTyped] = useState('');
  const titleId = React.useId();
  // settle() nulls `pending` immediately, but the Modal keeps rendering its
  // children for ~EXIT_MS while the exit animation plays. Hold the last
  // options so the dialog doesn't blank/restyle mid-exit (title/labels/theme
  // stay put, and variant/portal stay stable so the exit transform and the
  // portal target don't switch under the animation).
  const lastOptsRef = useRef<ConfirmOptions>({});

  const confirm = React.useCallback(
    (opts?: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        setTyped('');
        const merged = { ...defaults, ...opts };
        lastOptsRef.current = merged;
        setPending((prev) => {
          // A second confirm() while one is open cancels the first.
          prev?.resolve(false);
          return { opts: merged, resolve };
        });
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- defaults is a config literal; consumers pass a stable one
    [],
  );

  const settle = (value: boolean) => {
    setPending((prev) => {
      prev?.resolve(value);
      return null;
    });
  };

  const opts = pending?.opts ?? lastOptsRef.current;
  const th = opts.theme ?? {};
  const needsTyping = typeof opts.typedText === 'string' && opts.typedText.length > 0;
  const confirmEnabled = !needsTyping || typed === opts.typedText;

  const buttonBase: React.CSSProperties = {
    padding: '10px 16px',
    borderRadius: 10,
    fontSize: 14,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: th.fontFamily ?? 'inherit',
    lineHeight: 1.2,
  };

  const element = (
    <Modal
      open={pending !== null}
      onClose={() => settle(false)}
      variant={opts.variant ?? 'center'}
      portal={opts.portal ?? false}
      labelledBy={opts.title ? titleId : undefined}
      theme={{ maxWidth: '420px', ...th }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14, fontFamily: th.fontFamily ?? 'inherit' }}>
        {opts.title != null && (
          <div id={titleId} style={{ fontSize: 17, fontWeight: 700, color: th.text ?? 'inherit' }}>
            {opts.title}
          </div>
        )}
        {opts.message != null && (
          <div style={{ fontSize: 14, lineHeight: 1.45, color: th.dim ?? th.text ?? 'inherit' }}>
            {opts.message}
          </div>
        )}
        {needsTyping && (
          <input
            type="text"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={opts.typedPlaceholder ?? opts.typedText}
            autoFocus
            style={{
              padding: '10px 12px',
              borderRadius: 10,
              border: `1px solid ${th.controlBorder ?? 'rgba(0,0,0,0.2)'}`,
              fontSize: 14,
              fontFamily: th.fontFamily ?? 'inherit',
              color: th.text ?? 'inherit',
              background: 'transparent',
              outline: 'none',
              width: '100%',
              boxSizing: 'border-box',
            }}
          />
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 4 }}>
          <button
            type="button"
            onClick={() => settle(false)}
            style={{
              ...buttonBase,
              background: th.cancelBg ?? 'transparent',
              color: th.cancelColor ?? th.text ?? 'inherit',
              border: `1px solid ${th.controlBorder ?? 'rgba(0,0,0,0.2)'}`,
            }}
          >
            {opts.cancelLabel ?? 'Cancel'}
          </button>
          <button
            type="button"
            onClick={() => settle(true)}
            disabled={!confirmEnabled}
            style={{
              ...buttonBase,
              background: th.confirmBg ?? '#111111',
              color: th.confirmColor ?? '#FFFFFF',
              border: '1px solid transparent',
              opacity: confirmEnabled ? 1 : 0.45,
              cursor: confirmEnabled ? 'pointer' : 'not-allowed',
            }}
          >
            {opts.confirmLabel ?? 'Confirm'}
          </button>
        </div>
      </div>
    </Modal>
  );

  return { confirm, element };
}
