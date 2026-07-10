// Area-local palette + type ramp for the owner Dashboard — the ONE home for
// the color/font/label constants previously duplicated across page.tsx and
// every dashboard card. Two deliberate families, kept exactly as shipped
// (NOT normalized to each other):
//
//   • C / SERIF / SANS / MONO / LABEL / RING / STATUS_* — the "Staxis ·
//     Today" hero (design-handoff colors on the kept white surface).
//   • CARD / CARD_SERIF / CARD_MONO / CARD_LABEL — the frosted glass cards
//     below the hero (slightly different ink ramp + shorter font stacks).
//
// Area-local on purpose: these are this page's exact shipped values, not
// global design tokens.

import type React from 'react';

// ─── hero palette (design colors, on our kept #F8F8F5 background) ──────
export const C = {
  paper:  '#FFFFFF',   // white — every other page renders a white surface
  paper2: '#F1F2F4',   // subtle light-gray fill for the active KPI / pill (shows on white)
  card:   '#FFFFFF',
  ink:    '#20251F',
  ink2:   '#4A5249',
  ink3:   '#8A9187',
  ink4:   '#B4B9AE',
  green:  '#356B4C',
  greenL: '#5C8E6F',
  sage:   '#9DB8A6',
  rust:   '#BC5E37',
  rustD:  '#9A4A29',
  rustBg: '#F4E2D6',
  gold:   '#C09A3C',
  line:   'rgba(32,37,31,0.10)',
  line2:  'rgba(32,37,31,0.16)',
} as const;

export const SERIF = 'var(--font-fraunces), Georgia, "Times New Roman", serif';
export const SANS  = 'var(--font-geist), system-ui, -apple-system, sans-serif';
export const MONO  = 'var(--font-geist-mono), ui-monospace, "SF Mono", Menlo, monospace';

export type RingKey = 'occupied' | 'departing' | 'arriving' | 'clean' | 'dirty' | 'inprog' | 'ooo' | 'none';

export const RING: Record<RingKey, string> = {
  occupied: '#356B4C', departing: '#C79A3C', arriving: '#6FA384',
  clean: '#CBDBCF', dirty: '#C2704E', inprog: '#9DB8A6', ooo: '#B4B9AE', none: '#E2E5DE',
};
export const STATUS_EN: Record<RingKey, string> = {
  occupied: 'Occupied', departing: 'Departing', arriving: 'Arriving soon',
  clean: 'Clean / ready', dirty: 'Dirty', inprog: 'Being cleaned', ooo: 'Out of order', none: 'No data yet',
};
export const STATUS_ES: Record<RingKey, string> = {
  occupied: 'Ocupada', departing: 'Saliendo', arriving: 'Por llegar',
  clean: 'Limpia / lista', dirty: 'Sucia', inprog: 'En limpieza', ooo: 'Fuera de servicio', none: 'Sin datos',
};

export const LABEL: React.CSSProperties = {
  fontFamily: SANS, textTransform: 'uppercase', letterSpacing: '0.14em',
  fontWeight: 600, fontSize: 11, color: C.ink3,
};

// ─── glass-card palette (the additive cards below the hero) ─────────────
export const CARD = {
  ink: '#15191A',
  ink2: '#586056',
  ink3: '#9CA29C',
  rule: 'rgba(15,20,17,0.07)',
  green: '#2F7A51',       // LogBook / Calendar deep-link accent
  terracotta: '#C2562E',  // Worklist overdue accent
  attn: '#9A5B0B',        // amber-ink for "noticed" attention insights
  attnRule: 'rgba(154,91,11,0.16)',
} as const;

export const CARD_SERIF = 'var(--font-fraunces), Georgia, serif';
export const CARD_MONO = 'var(--font-geist-mono), ui-monospace, monospace';

export const CARD_LABEL: React.CSSProperties = {
  fontFamily: CARD_MONO,
  fontSize: 10,
  letterSpacing: '0.18em',
  textTransform: 'uppercase',
  color: CARD.ink3,
  fontWeight: 600,
};
