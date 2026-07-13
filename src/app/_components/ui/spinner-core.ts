// Pure logic for the shared Spinner primitive (F8) — keyframes CSS constant
// and style computation. No 'use client', no React runtime import, so the
// node:test suite (--conditions=react-server) can import it directly.

import type { CSSProperties } from 'react';

// The animation name + the one @keyframes declaration for the whole app.
// Spinner.tsx injects this into <head> exactly once (id-guarded), replacing
// the per-page `<style>{'@keyframes spin …'}</style>` copies.
export const SPIN_ANIMATION_NAME = 'staxis-ui-spin';
export const SPIN_KEYFRAMES_ID = 'staxis-ui-spin-keyframes';
export const SPIN_KEYFRAMES_CSS = `@keyframes ${SPIN_ANIMATION_NAME} { to { transform: rotate(360deg) } }`;

export interface SpinnerStyleOptions {
  /** Diameter in px. Default 20. */
  size?: number;
  /** Arc color. Default 'currentColor' so it inherits the page's text color. */
  color?: string;
  /** Ring/track color behind the arc. Default a faint neutral. */
  track?: string;
  /** Ring thickness in px. Default scales with size (min 2). */
  thickness?: number;
  /** One revolution, in ms. Default 800. */
  speedMs?: number;
}

export function resolveSpinnerThickness(size: number, thickness?: number): number {
  if (thickness !== undefined) return thickness;
  return Math.max(2, Math.round(size / 10));
}

export function spinnerStyle(opts: SpinnerStyleOptions = {}): CSSProperties {
  const size = opts.size ?? 20;
  const color = opts.color ?? 'currentColor';
  const track = opts.track ?? 'rgba(0,0,0,0.12)';
  const thickness = resolveSpinnerThickness(size, opts.thickness);
  const speedMs = opts.speedMs ?? 800;
  return {
    display: 'inline-block',
    width: size,
    height: size,
    boxSizing: 'border-box',
    border: `${thickness}px solid ${track}`,
    borderTopColor: color,
    borderRadius: '50%',
    animation: `${SPIN_ANIMATION_NAME} ${speedMs}ms linear infinite`,
    flex: 'none',
  };
}
