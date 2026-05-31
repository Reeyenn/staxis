// ═══════════════════════════════════════════════════════════════════════════
// Inventory name matching — map a free-text invoice line ("Bounty Paper
// Towels 12pk") to an existing inventory item.
//
// Pure + dependency-free so it's fully unit-testable and reusable from the
// invoice-scan review UI. Inventory items have NO sku/barcode — only a
// free-text `name` — so matching is name-based: normalize → tokenize → score
// by token overlap (token-set Jaccard + directional containment + a
// whole-string substring bonus), with generic color/size/unit words
// down-weighted so "White Towel" doesn't look like "White Cups".
//
// Auto-select is deliberately conservative: a wrong auto-match pre-fills a
// stock write, so we only auto-select unambiguous, non-generic matches with
// no unit conflict. Everything else is shown for the operator to confirm.
//
// Migration 0089 enforces a case-insensitive unique index on
// (property_id, name), so candidates always resolve to DISTINCT items; the
// normalized-name-tie guard below is belt-and-suspenders.
// ═══════════════════════════════════════════════════════════════════════════

export interface MatchableItem {
  id: string;
  name: string;
}

export type MatchTier = 'exact' | 'normalized' | 'strong' | 'weak';

export interface MatchCandidate {
  id: string;
  name: string;
  score: number; // 0..1
  tier: MatchTier;
}

export interface MatchResult {
  /** Highest-scoring candidate above WEAK_FLOOR, or null. */
  best: MatchCandidate | null;
  /** Candidates above WEAK_FLOOR, score desc, capped at MAX_CANDIDATES. */
  candidates: MatchCandidate[];
  /** Safe to pre-select without operator confirmation. */
  autoSelect: boolean;
  /** Two+ candidates effectively tied — operator must choose. */
  ambiguous: boolean;
}

// Tuned against hotel-supply fixtures; exported so tests pin them and any
// future retune is a conscious, test-gated change.
export const STRONG_THRESHOLD = 0.62;
export const WEAK_FLOOR = 0.34;
export const AMBIGUITY_DELTA = 0.08;
export const MAX_CANDIDATES = 5;

// Color/size/marketing words that shouldn't, on their own, make two different
// products look like a match. Down-weighted (not removed) in scoring.
const GENERIC_TOKENS = new Set([
  'white', 'black', 'blue', 'green', 'red', 'grey', 'gray', 'tan', 'clear', 'natural',
  'small', 'medium', 'large', 'jumbo', 'mini', 'regular', 'standard', 'xl', 'xxl',
  'premium', 'value', 'economy', 'bulk', 'assorted', 'new', 'original',
]);

// Packaging/unit words — used for conflict detection (a "case" line shouldn't
// silently auto-match an "each" item) and also treated as generic in scoring.
const UNIT_TOKENS = new Set([
  'case', 'cases', 'cs', 'pack', 'packs', 'pk', 'box', 'boxes', 'bag', 'bags', 'ct', 'count',
  'each', 'ea', 'unit', 'units', 'roll', 'rolls', 'bottle', 'bottles', 'can', 'cans',
  'carton', 'cartons', 'dozen', 'dz', 'pair', 'pairs', 'sleeve', 'sleeves',
  'oz', 'ml', 'l', 'liter', 'litre', 'lb', 'lbs', 'kg', 'g', 'gal', 'gallon', 'inch', 'in', 'ft', 'cm', 'mm',
]);

/** lowercase, strip accents, punctuation → space, collapse whitespace. */
export function normalizeName(raw: string): string {
  return (raw ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip combining accent marks
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/** Split a normalized string into tokens with light plural-stripping. */
export function tokenize(normalized: string): string[] {
  if (!normalized) return [];
  return normalized.split(' ').filter(Boolean).map(singularize);
}

function singularize(tok: string): string {
  // Only strip a trailing plural 's' on longer, non-numeric tokens. Leaves
  // "gas"/"ss"/short tokens/SKUs intact.
  if (tok.length > 3 && tok.endsWith('s') && !tok.endsWith('ss') && !/\d/.test(tok)) {
    return tok.slice(0, -1);
  }
  return tok;
}

function weightOf(tok: string): number {
  return GENERIC_TOKENS.has(tok) || UNIT_TOKENS.has(tok) ? 0.5 : 1;
}

/** Symmetric 0..1 similarity between two free-text item names. */
export function scoreNames(a: string, b: string): number {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;

  const ta = [...new Set(tokenize(na))];
  const tb = [...new Set(tokenize(nb))];
  if (ta.length === 0 || tb.length === 0) return 0;

  const setB = new Set(tb);
  const shared = ta.filter((t) => setB.has(t));
  const sharedWeight = shared.reduce((s, t) => s + weightOf(t), 0);
  if (sharedWeight === 0) return 0;

  const sizeA = ta.reduce((s, t) => s + weightOf(t), 0);
  const sizeB = tb.reduce((s, t) => s + weightOf(t), 0);

  const jaccard = sharedWeight / (sizeA + sizeB - sharedWeight);
  const containment = sharedWeight / Math.min(sizeA, sizeB);
  const substring = na.includes(nb) || nb.includes(na) ? 0.1 : 0;

  return Math.max(0, Math.min(1, 0.5 * jaccard + 0.4 * containment + substring));
}

function unitsOf(name: string): Set<string> {
  const u = new Set<string>();
  for (const t of tokenize(normalizeName(name))) if (UNIT_TOKENS.has(t)) u.add(t);
  return u;
}

/** True only when BOTH names carry unit words and they don't overlap. */
function hasUnitConflict(a: string, b: string): boolean {
  const ua = unitsOf(a);
  const ub = unitsOf(b);
  if (ua.size === 0 || ub.size === 0) return false;
  for (const t of ua) if (ub.has(t)) return false;
  return true;
}

/** Names too weak to safely auto-apply to a stock write. */
function isRiskyName(name: string): boolean {
  const norm = normalizeName(name);
  if (!norm) return true;
  const toks = tokenize(norm);
  if (toks.length === 0) return true;
  if (toks.length === 1 && (toks[0].length <= 4 || GENERIC_TOKENS.has(toks[0]) || UNIT_TOKENS.has(toks[0]))) {
    return true;
  }
  const nonSpace = norm.replace(/\s/g, '');
  const digits = norm.replace(/[^0-9]/g, '').length;
  return nonSpace.length > 0 && digits / nonSpace.length > 0.5;
}

function tierFor(invoiceName: string, item: MatchableItem, score: number): MatchTier {
  const ni = normalizeName(invoiceName);
  const nm = normalizeName(item.name);
  if (ni === nm) {
    // 'exact' = identical raw text (after trim); 'normalized' = same only
    // after case/accent/punctuation folding. Both auto-select; the tier is
    // just for display/telemetry.
    return invoiceName.trim() === item.name.trim() ? 'exact' : 'normalized';
  }
  return score >= STRONG_THRESHOLD ? 'strong' : 'weak';
}

export function matchInvoiceLine(
  invoiceName: string,
  items: readonly MatchableItem[],
): MatchResult {
  const scored: MatchCandidate[] = [];
  for (const it of items) {
    const score = scoreNames(invoiceName, it.name);
    if (score >= WEAK_FLOOR) {
      scored.push({ id: it.id, name: it.name, score, tier: tierFor(invoiceName, it, score) });
    }
  }
  scored.sort((x, y) => y.score - x.score);
  const candidates = scored.slice(0, MAX_CANDIDATES);
  const best = candidates[0] ?? null;

  // Ambiguous: top two effectively tied, OR two candidates share a normalized
  // name (shouldn't happen given the unique index — never auto-apply if so).
  let ambiguous = false;
  if (candidates.length >= 2) {
    if (candidates[0].score - candidates[1].score < AMBIGUITY_DELTA) ambiguous = true;
    const topNorm = normalizeName(candidates[0].name);
    if (candidates.slice(1).some((c) => normalizeName(c.name) === topNorm)) ambiguous = true;
  }

  const exactish = !!best && (best.tier === 'exact' || best.tier === 'normalized');
  const autoSelect =
    !!best &&
    !ambiguous &&
    !hasUnitConflict(invoiceName, best.name) &&
    (exactish || (best.tier === 'strong' && !isRiskyName(invoiceName)));

  return { best, candidates, autoSelect, ambiguous };
}
