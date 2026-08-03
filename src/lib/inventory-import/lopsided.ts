// ═══════════════════════════════════════════════════════════════════════════
// "I have your inventory from March to June, but no occupancy for those months."
//
// The inventory model learns from PAIRS: two counts, and what the hotel was
// doing between them. A hotel that imports three years of count sheets and no
// occupancy has given the model nothing it can use, and will conclude the AI
// does not work. The only honest thing to do is say so, once, in the
// companion's ordinary voice.
//
// THE BAR FOR SAYING ANYTHING
//   • We must actually hold the months we claim to hold.
//   • We must actually be missing the months we claim to be missing.
//   • One sentence, one ask, and never a number we did not count.
// A hotel with a tidy history hears nothing from this file at all.
// ═══════════════════════════════════════════════════════════════════════════

import { monthRangeLabel } from './occupancy';

/** Below this many months on the held side there is nothing worth asking for:
 *  the model needs a run of months, and one lonely sheet is not a run. */
export const LOPSIDED_MIN_MONTHS = 2;

export type LopsidedSide = 'occupancy_missing' | 'inventory_missing';

export interface LopsidedHistory {
  side: LopsidedSide;
  /** Months we hold on the side that has data, oldest first. */
  heldMonths: string[];
  /** Months we hold data for but have nothing on the other side, oldest first. */
  missingMonths: string[];
  /** The whole thing, as one sentence. */
  text: string;
  /** The follow-up, so the companion asks rather than announces. */
  question: string;
}

export interface LopsidedInput {
  /** First-of-month dates (YYYY-MM-01) we have dated inventory history for. */
  inventoryMonths: readonly string[];
  /** First-of-month dates we have any occupancy for, from any source. */
  occupancyMonths: readonly string[];
}

/**
 * Returns the ONE thing worth saying, or null.
 *
 * When both sides are lopsided (which happens: a hotel imports 2024 inventory
 * and 2026 occupancy), the side with more missing months wins, because that is
 * the one costing them more learning.
 */
export function findLopsidedHistory(input: LopsidedInput): LopsidedHistory | null {
  const inventory = uniqueSorted(input.inventoryMonths);
  const occupancy = uniqueSorted(input.occupancyMonths);

  const occupancySet = new Set(occupancy);
  const inventorySet = new Set(inventory);

  const occupancyMissing = inventory.filter((m) => !occupancySet.has(m));
  const inventoryMissing = occupancy.filter((m) => !inventorySet.has(m));

  const occupancyCase = inventory.length >= LOPSIDED_MIN_MONTHS && occupancyMissing.length >= LOPSIDED_MIN_MONTHS
    ? { side: 'occupancy_missing' as const, held: inventory, missing: occupancyMissing }
    : null;
  const inventoryCase = occupancy.length >= LOPSIDED_MIN_MONTHS && inventoryMissing.length >= LOPSIDED_MIN_MONTHS
    ? { side: 'inventory_missing' as const, held: occupancy, missing: inventoryMissing }
    : null;

  const winner = occupancyCase && inventoryCase
    ? (inventoryCase.missing.length > occupancyCase.missing.length ? inventoryCase : occupancyCase)
    : (occupancyCase ?? inventoryCase);
  if (!winner) return null;

  const missingRange = monthRangeLabel(winner.missing);
  const text = winner.side === 'occupancy_missing'
    ? `I have your inventory counts for ${missingRange}, but no occupancy for those months.`
    : `I have your occupancy for ${missingRange}, but no inventory counts for those months.`;
  const question = winner.side === 'occupancy_missing'
    ? 'Add the occupancy and I can start learning how fast you use things. Want to do that now?'
    : 'Add those count sheets and I can start learning how fast you use things. Want to do that now?';

  return {
    side: winner.side,
    heldMonths: winner.held,
    missingMonths: winner.missing,
    text,
    question,
  };
}

/** Stable topic handle, so a No sticks to the right thing and a later month
 *  arriving does not re-ask about the same gap under a new name. */
export function lopsidedTopic(side: LopsidedSide): string {
  return `import:lopsided:${side}`;
}

function uniqueSorted(months: readonly string[]): string[] {
  return [...new Set(months.filter((m) => /^\d{4}-\d{2}-01$/.test(m)))].sort();
}
