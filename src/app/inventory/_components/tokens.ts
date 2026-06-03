// Triage design tokens for the inventory tab.
// Brand palette + typography from the "Inventory — Triage" Claude Design
// handoff (May 2026). Pure white paper, ink/forest/terra/gold/teal, with
// Newsreader (serif) / Hanken Grotesk (sans) / JetBrains Mono (mono).
//
// The keys below the "back-compat aliases" line map the older Snow token
// names (sageDeep / caramel / warm / purple …) onto the Triage palette so
// every existing component + overlay restyles without a prop change:
//   good → forest   low → gold   critical → terra
//   AI accent (purple) → teal     delete/shrinkage (warm) → terra

export const T = {
  // ── Triage palette (non-negotiable brand values) ──────────────────────
  bg:        '#FFFFFF',
  paper:     '#FFFFFF',
  ink:       '#181611',
  ink2:      '#5B564C',
  ink3:      '#928C7F',   // tertiary / dim (existing code reads T.ink3)
  dim:       '#928C7F',
  rule:      'rgba(24,22,17,0.12)',
  ruleSoft:  'rgba(24,22,17,0.06)',
  ruleFaint: 'rgba(24,22,17,0.035)',
  inkWash:   'rgba(24,22,17,0.04)',
  forest:    '#3C9C68',
  terra:     '#C2562E',
  gold:      '#C99A2E',
  teal:      '#3389A0',
  forestDim: 'rgba(60,156,104,0.12)',
  terraDim:  'rgba(194,86,46,0.12)',
  goldDim:   'rgba(201,154,46,0.14)',
  tealDim:   'rgba(51,137,160,0.12)',
  tealText:  '#2A6E82',   // legible teal for body text on tint
  forestText:'#2C6B47',   // legible forest for body text on tint

  // ── back-compat aliases (older component/overlay code references these) ──
  inkSoft:     '#3A3F38',
  sage:        '#3C9C68',
  sageDeep:    '#3C9C68',                 // → forest  (good / spend / received)
  sageDim:     'rgba(60,156,104,0.12)',   // → forestDim
  caramel:     '#C99A2E',                 // → gold
  caramelDeep: '#C99A2E',
  warm:        '#C2562E',                 // → terra  (delete / shrinkage)
  warmDim:     'rgba(194,86,46,0.12)',    // → terraDim
  red:         '#C2562E',
  purple:      '#3389A0',                 // → teal   (AI accent)
  purpleDim:   'rgba(51,137,160,0.12)',   // → tealDim
} as const;

export const fonts = {
  sans:  "'Hanken Grotesk', system-ui, sans-serif",
  mono:  "'JetBrains Mono', ui-monospace, monospace",
  serif: "'Newsreader', Georgia, serif",
} as const;

// Stock status — derived from estimated/par ratio (see inv-page rules):
//   ratio < 0.5  → critical
//   ratio < 1.0  → low
//   ratio ≥ 1.0  → good
export type StockStatus = 'good' | 'low' | 'critical';

export const statusColor: Record<StockStatus, string> = {
  good:     T.forest,
  low:      T.gold,
  critical: T.terra,
};
// Soft tint per status — column backgrounds, pills, banners.
export const statusTint: Record<StockStatus, string> = {
  good:     T.forestDim,
  low:      T.goldDim,
  critical: T.terraDim,
};
export const statusLabel: Record<StockStatus, string> = {
  good:     'Good',
  low:      'Low',
  critical: 'Critical',
};

// Our DB uses 'breakfast'; the design called it 'fnb'. Display layer maps fnb → breakfast.
export type InvCat = 'housekeeping' | 'maintenance' | 'breakfast';

// Category accent only tints the item monogram chips (status color always
// drives stock bars / day labels / pills):
//   Housekeeping → teal   Maintenance → gold   Food & Beverage → terra
export const catColor: Record<InvCat, string> = {
  housekeeping: T.teal,
  maintenance:  T.gold,
  breakfast:    T.terra,
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

// Board bucket toggle:
//   all       = every item
//   general   = housekeeping + maintenance
//   breakfast = breakfast only
export type StockBucket = 'all' | 'general' | 'breakfast';

export function bucketFor(cat: InvCat): Exclude<StockBucket, 'all'> {
  return cat === 'breakfast' ? 'breakfast' : 'general';
}

// Does an item's category belong in the currently-selected bucket?
export function inBucket(cat: InvCat, bucket: StockBucket): boolean {
  if (bucket === 'all') return true;
  if (bucket === 'breakfast') return cat === 'breakfast';
  return cat !== 'breakfast';
}

// Two-letter monogram from an item name (e.g. "Bath towels, white" → "BT").
// Used by the category-tinted Thumb chip.
export function monogram(name: string): string {
  const letters = (name || '')
    .replace(/[^A-Za-z ]/g, '')
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase();
  return letters || '—';
}
