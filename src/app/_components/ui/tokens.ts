// Small, neutral UI tokens shared by the light Concourse surfaces.
//
// These values already ship in the staff, inventory, and dashboard surfaces.
// Keeping them here is intentionally narrower than a full design system: the
// area modules still own their semantic aliases and status palettes, while
// this file owns only values that are byte-for-byte identical across them.

export const CONCOURSE_COLORS = {
  bg: '#FFFFFF',
  paper: '#FFFFFF',
  ink: '#1F231C',
  inkSoft: '#3A3F38',
  ink2: '#5C625C',
  ink3: '#A6ABA6',
  rule: 'rgba(31,35,28,0.08)',
  ruleSoft: 'rgba(31,35,28,0.05)',
  sage: '#9EB7A6',
  sageDeep: '#5C7A60',
  sageDim: 'rgba(92,122,96,0.14)',
  okDeep: '#356B4C',
  okDim: 'rgba(53,107,76,0.10)',
  caramel: '#C99644',
  caramelDeep: '#8C6A33',
  warm: '#B85C3D',
  warmDim: 'rgba(184,92,61,0.10)',
  purple: '#5C625C',
  purpleDim: 'rgba(31,35,28,0.06)',
} as const;

export const CONCOURSE_FONTS = {
  sans: 'var(--font-geist), -apple-system, BlinkMacSystemFont, sans-serif',
  mono: 'var(--font-geist-mono), ui-monospace, monospace',
  // The current Concourse surfaces intentionally use Geist for the legacy
  // display slot too. Keep the alias so existing call sites stay unchanged.
  serif: 'var(--font-geist), -apple-system, BlinkMacSystemFont, sans-serif',
} as const;

export const UI_RADII = {
  card: 18,
  pill: 999,
} as const;

export const UI_SHADOWS = {
  card: '0 6px 16px -14px rgba(31,42,32,0.35)',
} as const;

export const UI_FOCUS = {
  ring: '#5C7A60',
} as const;
