// Snow design tokens for the inventory rebuild.
// Mirrors hk-shared.jsx T + fonts so the inline-style React components match
// the prototype's visual values 1:1.

export const T = {
  bg:          '#FFFFFF',
  paper:       '#FFFFFF',
  ink:         '#1F231C',
  inkSoft:     '#3A3F38',
  ink2:        '#5C625C',
  ink3:        '#A6ABA6',
  rule:        'rgba(31,35,28,0.08)',
  ruleSoft:    'rgba(31,35,28,0.04)',
  sage:        '#9EB7A6',
  sageDeep:    '#5C7A60',
  sageDim:     'rgba(92,122,96,0.10)',
  caramel:     '#C99644',
  caramelDeep: '#8C6A33',
  warm:        '#B85C3D',
  warmDim:     'rgba(184,92,61,0.10)',
  red:         '#A04A2C',
  purple:      '#7B6A97',
  purpleDim:   'rgba(123,106,151,0.10)',
} as const;

export const fonts = {
  sans:  "'Geist', system-ui, sans-serif",
  mono:  "'Geist Mono', ui-monospace, monospace",
  serif: "'Instrument Serif', Georgia, serif",
} as const;

// Stock status — derived from estimated/par ratio (see inv-page rules):
//   ratio < 0.5  → critical
//   ratio < 1.0  → low
//   ratio ≥ 1.0  → good
export type StockStatus = 'good' | 'low' | 'critical';

export const statusColor: Record<StockStatus, string> = {
  good:     T.sageDeep,
  low:      T.caramel,
  critical: T.warm,
};
export const statusLabel: Record<StockStatus, string> = {
  good:     'Good',
  low:      'Low',
  critical: 'Critical',
};

// Our DB uses 'breakfast'; the design used 'fnb'. Display layer maps fnb → breakfast.
export type InvCat = 'housekeeping' | 'maintenance' | 'breakfast';

export const catColor: Record<InvCat, string> = {
  housekeeping: '#5C7A60', // sage-deep
  maintenance:  '#8C6A33', // caramel-deep
  breakfast:    '#7B6A97', // purple — "food & beverage"
};
export const catLabel: Record<InvCat, string> = {
  housekeeping: 'Housekeeping',
  maintenance:  'Maintenance',
  breakfast:    'Food & Beverage',
};
export const catGlyph: Record<InvCat, string> = {
  housekeeping: 'HK',
  maintenance:  'MX',
  breakfast:    'FB',
};

// "General inventory" bucket = housekeeping + maintenance.
// "Breakfast inventory" bucket = breakfast only.
export type StockBucket = 'general' | 'breakfast';

export function bucketFor(cat: InvCat): StockBucket {
  return cat === 'breakfast' ? 'breakfast' : 'general';
}
