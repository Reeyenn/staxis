// Pure style/theme logic for the shared Modal primitive (F6).
//
// Lives in its own file (no 'use client', no React runtime import) so the
// node:test suite can exercise it directly — the test runner executes with
// --conditions=react-server, which cannot load client-component modules.
//
// NOTHING in here bakes in a palette. Every color/size comes from the caller
// via ModalTheme; the defaults below are deliberately neutral so a page that
// forgets to theme still renders something legible, but every real consumer
// passes its own area's exact current look.

import type { CSSProperties } from 'react';

export type ModalVariant = 'center' | 'sheet';

export interface ModalTheme {
  /** Scrim (backdrop) color, e.g. 'rgba(24,22,17,0.28)'. */
  scrim?: string;
  /** Scrim backdrop-filter, e.g. 'blur(3px)' (inventory's Overlay). Default none. */
  scrimFilter?: string;
  /** Card background. */
  bg?: string;
  /** Card border (CSS shorthand), e.g. `1px solid ${T.rule}`. Default none. */
  border?: string;
  /** Card border-radius (CSS length). Sheets apply it to the top corners only. */
  radius?: string;
  /** Card max-width (CSS length). Ignored by the sheet variant (full width). */
  maxWidth?: string;
  /** Card padding (CSS shorthand). */
  padding?: string;
  /** Card box-shadow. */
  shadow?: string;
  /** Scrim z-index. */
  zIndex?: number;
}

export interface ResolvedModalTheme {
  scrim: string;
  scrimFilter: string;
  bg: string;
  border: string;
  radius: string;
  maxWidth: string;
  padding: string;
  shadow: string;
  zIndex: number;
}

// Neutral fallbacks only — consumers always pass their area's real theme.
export const MODAL_THEME_DEFAULTS: ResolvedModalTheme = {
  scrim: 'rgba(0,0,0,0.35)',
  scrimFilter: 'none',
  bg: '#FFFFFF',
  border: 'none',
  radius: '16px',
  maxWidth: '560px',
  padding: '20px',
  shadow: '0 24px 64px -16px rgba(0,0,0,0.3)',
  zIndex: 1000,
};

export function resolveModalTheme(theme?: ModalTheme): ResolvedModalTheme {
  return {
    scrim: theme?.scrim ?? MODAL_THEME_DEFAULTS.scrim,
    scrimFilter: theme?.scrimFilter ?? MODAL_THEME_DEFAULTS.scrimFilter,
    bg: theme?.bg ?? MODAL_THEME_DEFAULTS.bg,
    border: theme?.border ?? MODAL_THEME_DEFAULTS.border,
    radius: theme?.radius ?? MODAL_THEME_DEFAULTS.radius,
    maxWidth: theme?.maxWidth ?? MODAL_THEME_DEFAULTS.maxWidth,
    padding: theme?.padding ?? MODAL_THEME_DEFAULTS.padding,
    shadow: theme?.shadow ?? MODAL_THEME_DEFAULTS.shadow,
    zIndex: theme?.zIndex ?? MODAL_THEME_DEFAULTS.zIndex,
  };
}

/** Fixed full-viewport scrim. Centers for 'center', bottom-aligns for 'sheet'. */
export function modalScrimStyle(variant: ModalVariant, t: ResolvedModalTheme): CSSProperties {
  return {
    position: 'fixed',
    inset: 0,
    zIndex: t.zIndex,
    background: t.scrim,
    backdropFilter: t.scrimFilter,
    WebkitBackdropFilter: t.scrimFilter, // iOS Safari — most housekeeper devices
    display: 'flex',
    alignItems: variant === 'sheet' ? 'flex-end' : 'center',
    justifyContent: 'center',
    padding: variant === 'sheet' ? 0 : '32px 24px',
    overflow: 'auto',
  };
}

/** The dialog card itself. Sheet = full-width, top corners rounded only. */
export function modalCardStyle(variant: ModalVariant, t: ResolvedModalTheme): CSSProperties {
  if (variant === 'sheet') {
    return {
      width: '100%',
      maxHeight: '92vh',
      background: t.bg,
      border: t.border,
      borderRadius: `${t.radius} ${t.radius} 0 0`,
      boxShadow: t.shadow,
      padding: t.padding,
      overflow: 'auto',
      boxSizing: 'border-box',
    };
  }
  return {
    width: `min(100%, ${t.maxWidth})`,
    maxHeight: '90vh',
    background: t.bg,
    border: t.border,
    borderRadius: t.radius,
    boxShadow: t.shadow,
    padding: t.padding,
    overflow: 'auto',
    boxSizing: 'border-box',
  };
}

// Entrance/exit transforms per variant — used by the WAAPI animations in
// Modal.tsx (same presence-managed pattern as inventory's Overlay.tsx).
export function modalEnterTransform(variant: ModalVariant): string {
  return variant === 'sheet' ? 'translateY(100%)' : 'translateY(20px) scale(.97)';
}

export function modalExitTransform(variant: ModalVariant): string {
  return variant === 'sheet' ? 'translateY(100%)' : 'translateY(12px) scale(.985)';
}
