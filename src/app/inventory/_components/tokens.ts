// Concourse design tokens for the inventory tab.
// Palette + typography from the "Concourse" global shell (July 2026): pages
// sit on the app-wide soft radial wash, UI type is Geist, data/eyebrows/
// badges are Geist Mono, and the brand hues are sage / amber / rust.
//
// The keys below the "back-compat aliases" line map the older token names
// (sageDeep / caramel / warm / purple … and the Triage-era forest / terra /
// gold / teal) onto the Concourse palette so every existing component +
// overlay restyles without a prop change:
//   good → sage   low → amber   critical → rust
//   AI accent (teal/purple) → sage primary   delete/shrinkage (warm) → rust

export const T = {
  // ── Concourse palette (non-negotiable brand values) ────────────────────
  bg:        '#FFFFFF',
  paper:     '#FFFFFF',
  ink:       '#1F231C',
  ink2:      '#5C625C',
  ink3:      '#8A9187',   // tertiary / dim (existing code reads T.ink3)
  dim:       '#8A9187',
  faint:     '#A6ABA6',   // eyebrows / faintest text
  rule:      'rgba(31,35,28,0.08)',
  ruleSoft:  'rgba(31,35,28,0.06)',
  ruleFaint: 'rgba(31,35,28,0.05)',
  inkWash:   'rgba(31,35,28,0.05)',
  brand:     '#3E5C48',   // primary action / active sage
  forest:    '#5C7A60',   // accent / ok sage
  terra:     '#B85C3D',   // rust alert
  gold:      '#C99644',   // amber warn
  teal:      '#3E5C48',   // AI accent → primary sage
  forestDim: 'rgba(53,107,76,0.10)',
  terraDim:  'rgba(184,92,61,0.10)',
  goldDim:   'rgba(201,150,68,0.14)',
  tealDim:   'rgba(158,183,166,0.16)',
  tealText:  '#356B4C',   // legible sage for body text on tint
  forestText:'#356B4C',   // deep ok — legible sage for body text on tint
  goldText:  '#8C6A33',   // warn-text amber for body text on tint

  // ── back-compat aliases (older component/overlay code references these) ──
  inkSoft:     '#1F231C',
  sage:        '#5C7A60',
  sageDeep:    '#5C7A60',                 // → ok sage  (good / spend / received)
  sageDim:     'rgba(53,107,76,0.10)',    // → forestDim
  caramel:     '#C99644',                 // → amber
  caramelDeep: '#C99644',
  warm:        '#B85C3D',                 // → rust  (delete / shrinkage)
  warmDim:     'rgba(184,92,61,0.10)',    // → terraDim
  red:         '#B85C3D',
  purple:      '#3E5C48',                 // → sage   (AI accent)
  purpleDim:   'rgba(158,183,166,0.16)',  // → tealDim
} as const;

export const fonts = {
  sans:  'var(--font-geist), -apple-system, BlinkMacSystemFont, sans-serif',
  mono:  'var(--font-geist-mono), ui-monospace, monospace',
  // Legacy alias — the old serif display type is now Geist (weight handled by
  // the components; Serif.tsx renders 600).
  serif: 'var(--font-geist), -apple-system, BlinkMacSystemFont, sans-serif',
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
// Legible text color per status — pills / day labels / numerals (the bright
// bar hues stay in statusColor for dots, bars and rings).
export const statusText: Record<StockStatus, string> = {
  good:     T.forestText,
  low:      T.goldText,
  critical: T.terra,
};

// Our DB uses 'breakfast'; the design called it 'fnb'. Display layer maps fnb → breakfast.
export type InvCat = 'housekeeping' | 'maintenance' | 'breakfast';

// Category accent only tints the item monogram chips (status color always
// drives stock bars / day labels / pills):
//   Housekeeping → sage   Maintenance → amber   Food & Beverage → rust
export const catColor: Record<InvCat, string> = {
  housekeeping: T.teal,
  maintenance:  T.gold,
  breakfast:    T.terra,
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
// Filter buckets: the built-in All / General / Breakfast, plus `custom:<id>`
// for a hotel-defined category tab (migration 0307).
export type StockBucket = 'all' | 'general' | 'breakfast' | `custom:${string}`;

// Does an item's category belong in the currently-selected bucket?
// Whether an item belongs in a filter bucket. Additive custom-category rule
// (0307): an item WITH a custom category lives ONLY under its custom tab (and
// All) — never in the built-in General/Breakfast buckets. Items WITHOUT one
// (every legacy item) behave exactly as before.
export function inBucket(item: { cat: InvCat; customCategoryId?: string | null }, bucket: StockBucket): boolean {
  if (bucket === 'all') return true;
  if (bucket.startsWith('custom:')) return item.customCategoryId === bucket.slice(7);
  if (item.customCategoryId) return false; // custom items stay out of General/Breakfast
  if (bucket === 'breakfast') return item.cat === 'breakfast';
  return item.cat !== 'breakfast'; // 'general'
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
