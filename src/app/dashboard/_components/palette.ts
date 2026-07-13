// Area-local palette + type ramp for the owner Dashboard — the ONE home for
// the color/font/label constants previously duplicated across page.tsx and
// every dashboard card. Two deliberate families, kept exactly as shipped
// (NOT normalized to each other):
//
//   • C / SANS / MONO / LABEL / RING / STATUS_* — the "Staxis · Today" hero.
//   • CARD / CARD_MONO / CARD_LABEL — the additive cards below the hero
//     (slightly different ink ramp + shorter font stacks).
//
// Restyled for the Concourse shell: Concourse ink/sage/amber/rust tokens,
// Geist for all display type (no serif), Geist Mono eyebrows (9.5px,
// uppercase, .14em tracking).
//
// Area-local on purpose: these are this page's exact shipped values, not
// global design tokens.

import type React from 'react';

// ─── hero palette (Concourse tokens, on the app-wide radial wash) ──────
export const C = {
  paper:  '#FFFFFF',   // white — chart marker fills / card surfaces
  paper2: 'rgba(158,183,166,.16)', // sage wash fill for the active KPI cell
  card:   '#FFFFFF',
  ink:    '#1F231C',
  ink2:   '#5C625C',
  ink3:   '#8A9187',
  ink4:   '#A6ABA6',
  green:  '#356B4C',
  greenL: '#5C7A60',
  sage:   '#9EB7A6',
  rust:   '#B85C3D',
  rustD:  '#B85C3D',
  rustBg: 'rgba(184,92,61,.10)',
  gold:   '#C99644',
  line:   'rgba(31,35,28,0.08)',
  line2:  'rgba(31,35,28,0.14)',
} as const;

export const SANS  = 'var(--font-geist), system-ui, -apple-system, sans-serif';
export const MONO  = 'var(--font-geist-mono), ui-monospace, "SF Mono", Menlo, monospace';

export type RingKey = 'occupied' | 'departing' | 'arriving' | 'clean' | 'dirty' | 'inprog' | 'ooo' | 'none';

export const RING: Record<RingKey, string> = {
  occupied: '#356B4C', departing: '#C99644', arriving: '#5C7A60',
  clean: 'rgba(158,183,166,.45)', dirty: '#B85C3D', inprog: '#9EB7A6', ooo: '#A6ABA6', none: 'rgba(31,35,28,.10)',
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
  fontFamily: MONO, textTransform: 'uppercase', letterSpacing: '0.14em',
  fontWeight: 600, fontSize: 9.5, color: C.ink4,
};

// ─── card palette (the additive cards below the hero) ──────────────────
export const CARD = {
  ink: '#1F231C',
  ink2: '#5C625C',
  ink3: '#A6ABA6',
  rule: 'rgba(31,35,28,0.06)',
  green: '#356B4C',       // LogBook / Calendar deep-link accent
  terracotta: '#B85C3D',  // Worklist overdue accent
  attn: '#8C6A33',        // amber-ink for "noticed" attention insights
  attnRule: 'rgba(201,150,68,0.25)',
} as const;

export const CARD_MONO = 'var(--font-geist-mono), ui-monospace, monospace';

export const CARD_LABEL: React.CSSProperties = {
  fontFamily: CARD_MONO,
  fontSize: 9.5,
  letterSpacing: '0.14em',
  textTransform: 'uppercase',
  color: CARD.ink3,
  fontWeight: 600,
};
