// ═══════════════════════════════════════════════════════════════════════════
// Unit normalization + cross-month conflict detection.
//
// A hotel's sheets are not consistent with themselves. March's tab says
// "cases", June's says "each", and both mean the same shelf. Silently picking
// one turns 4 cases into 4 towels, which is the kind of wrong that looks right
// on a screen and only shows up when the hotel runs out.
//
// So: we canonicalize what we can, and when two months of the SAME item
// disagree we do not resolve it quietly. We flag it, propose the most recent
// month's unit as the answer, and make the manager look at it once.
// ═══════════════════════════════════════════════════════════════════════════

/** Canonical unit → the spellings a sheet uses for it. */
const UNIT_SYNONYMS: Record<string, readonly string[]> = {
  each: ['each', 'ea', 'ea.', 'unit', 'units', 'pc', 'pcs', 'piece', 'pieces', 'item', 'items', 'qty'],
  case: ['case', 'cases', 'cs', 'cse', 'ctn', 'carton', 'cartons'],
  box: ['box', 'boxes', 'bx'],
  pack: ['pack', 'packs', 'pk', 'pkg', 'package', 'packages'],
  bag: ['bag', 'bags', 'bg'],
  roll: ['roll', 'rolls', 'rl'],
  bottle: ['bottle', 'bottles', 'btl', 'btls'],
  can: ['can', 'cans'],
  jar: ['jar', 'jars'],
  dozen: ['dozen', 'dozens', 'dz', 'doz'],
  pair: ['pair', 'pairs', 'pr'],
  sleeve: ['sleeve', 'sleeves'],
  gallon: ['gallon', 'gallons', 'gal', 'gals'],
  liter: ['liter', 'liters', 'litre', 'litres', 'l'],
  ounce: ['ounce', 'ounces', 'oz'],
  pound: ['pound', 'pounds', 'lb', 'lbs'],
  set: ['set', 'sets'],
  bundle: ['bundle', 'bundles'],
};

const CANONICAL_BY_SPELLING = new Map<string, string>();
for (const [canonical, spellings] of Object.entries(UNIT_SYNONYMS)) {
  for (const s of spellings) CANONICAL_BY_SPELLING.set(s, canonical);
}

/**
 * Fold a unit cell to a canonical unit. Returns null when the cell is blank
 * or when we do not recognize it — an unrecognized unit is kept verbatim by
 * the caller rather than coerced into "each", because "sleeve of 500" being
 * silently renamed is exactly the failure this module exists to prevent.
 */
export function canonicalUnit(raw: string | null | undefined): string | null {
  const s = (raw ?? '').trim().toLowerCase().replace(/[.\s]+$/, '');
  if (!s) return null;
  const direct = CANONICAL_BY_SPELLING.get(s);
  if (direct) return direct;
  // "case of 24", "12 pk", "box (36)" — take the first recognizable word.
  for (const word of s.split(/[^a-z]+/).filter(Boolean)) {
    const hit = CANONICAL_BY_SPELLING.get(word);
    if (hit) return hit;
  }
  return null;
}

/** Display form for a unit we are storing: canonical when known, else the
 *  manager's own words, trimmed. Never empty — falls back to "each". */
export function displayUnit(raw: string | null | undefined): string {
  const canonical = canonicalUnit(raw);
  if (canonical) return canonical;
  const trimmed = (raw ?? '').trim();
  return trimmed || 'each';
}

/** Units that mean "one of the thing" vs units that mean "a container of them".
 *  A conflict between these two groups is the one that changes the number. */
const CONTAINER_UNITS = new Set(['case', 'box', 'pack', 'bag', 'carton', 'dozen', 'sleeve', 'bundle', 'set']);

export interface UnitObservation {
  /** Normalized item name — the key two sheets agree on. */
  itemKey: string;
  /** The item name as the sheet spelled it, for the message. */
  itemName: string;
  /** The unit cell as the sheet spelled it. */
  rawUnit: string;
  /** Hotel calendar date this observation is as-of (YYYY-MM-DD). */
  asOfDate: string;
}

export interface UnitConflict {
  itemKey: string;
  itemName: string;
  /** Distinct canonical units seen, oldest observation first. */
  observations: Array<{ asOfDate: string; rawUnit: string; unit: string }>;
  /** The unit we propose keeping: the one from the most recent sheet. */
  proposedUnit: string;
  /** True when the disagreement is container-vs-single, which changes counts. */
  changesQuantity: boolean;
  /** Plain sentence for the confirm screen. */
  message: string;
}

function monthLabel(isoDate: string): string {
  const [y, m] = isoDate.split('-');
  const names = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
    'August', 'September', 'October', 'November', 'December'];
  const idx = Number(m) - 1;
  return names[idx] ? `${names[idx]} ${y}` : isoDate;
}

/**
 * Group observations by item and report the ones whose unit changed between
 * sheets. Silent when every sheet agrees.
 */
export function findUnitConflicts(observations: readonly UnitObservation[]): UnitConflict[] {
  const byItem = new Map<string, UnitObservation[]>();
  for (const o of observations) {
    if (!o.itemKey) continue;
    const list = byItem.get(o.itemKey);
    if (list) list.push(o);
    else byItem.set(o.itemKey, [o]);
  }

  const conflicts: UnitConflict[] = [];
  for (const [itemKey, list] of byItem) {
    const sorted = [...list].sort((a, b) => (a.asOfDate < b.asOfDate ? -1 : a.asOfDate > b.asOfDate ? 1 : 0));
    const seen = new Map<string, { asOfDate: string; rawUnit: string; unit: string }>();
    for (const o of sorted) {
      const unit = displayUnit(o.rawUnit);
      if (!seen.has(unit)) seen.set(unit, { asOfDate: o.asOfDate, rawUnit: o.rawUnit.trim(), unit });
    }
    if (seen.size < 2) continue;

    const observationsOut = [...seen.values()];
    const latest = sorted[sorted.length - 1];
    const proposedUnit = displayUnit(latest.rawUnit);
    const units = observationsOut.map((o) => o.unit);
    const changesQuantity = units.some((u) => CONTAINER_UNITS.has(u)) && units.some((u) => !CONTAINER_UNITS.has(u));

    const parts = observationsOut.map((o) => `${monthLabel(o.asOfDate)} says ${o.unit}`);
    conflicts.push({
      itemKey,
      itemName: sorted[0].itemName,
      observations: observationsOut,
      proposedUnit,
      changesQuantity,
      message: `${parts.join(', ')}. We will use ${proposedUnit}, from the most recent sheet.`,
    });
  }
  conflicts.sort((a, b) => (a.itemName < b.itemName ? -1 : a.itemName > b.itemName ? 1 : 0));
  return conflicts;
}
