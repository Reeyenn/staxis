// ═══════════════════════════════════════════════════════════════════════════
// Inventory → Financials expense bridge.
//
// A scanned supply invoice committed on the Inventory page is real spend, but
// until 2026-08 it never reached the Financials Checkbook: the manager either
// typed the same paper twice or the department spend read $0. This module is
// the pure half of the fix. After the delivery commit succeeds, the sheet
// books ONE matching Checkbook expense through the existing
// POST /api/financials/expenses route.
//
// Double-count safety, in order of defense:
//   1. The expense row's primary key (operationId) is DERIVED from the
//      invoice's durable business key (property + the notes tag that already
//      carries `inv#<number>@<vendor>`). Re-running the booking for the same
//      committed invoice replays the same UUID, so Postgres can never hold two
//      auto-booked rows for one invoice.
//   2. The route also refuses to create when any expense already carries the
//      same invoice reference for this property (covers the paper being typed
//      or scanned into Financials FIRST, which uses a random operationId).
//
// Pure + dependency-light so both the sheet and the Node test runner can use
// it. Web Crypto (globalThis.crypto.subtle) exists in every supported browser
// and in Node 18+.
// ═══════════════════════════════════════════════════════════════════════════

import type { Department } from '@/lib/financials/shared';

/** The three built-in inventory categories map onto their Checkbook
 * departments 1:1. Custom-tab and unknown items land in 'other' rather than
 * guessing a department the hotel never chose. */
export type BridgeCategory = 'housekeeping' | 'maintenance' | 'breakfast' | 'other';

export interface BridgeLine {
  category: BridgeCategory;
  quantity: number;
  /** Per-unit cost in DOLLARS (the inventory ledger's legacy unit). */
  unitCost: number | null | undefined;
}

const CATEGORY_TO_DEPARTMENT: Record<BridgeCategory, Department> = {
  housekeeping: 'housekeeping',
  maintenance: 'maintenance',
  breakfast: 'breakfast',
  other: 'other',
};

function lineDollars(line: BridgeLine): number {
  const qty = Number(line.quantity);
  const cost = Number(line.unitCost);
  if (!Number.isFinite(qty) || qty <= 0 || !Number.isFinite(cost) || cost < 0) return 0;
  return qty * cost;
}

/** Invoice total in integer cents. Line math stays in dollars (matching how
 * unitCost was derived from the scanned line total) and rounds ONCE at the
 * end, so per-line float noise cannot accumulate into a wrong cent. */
export function expenseAmountCentsFromLines(lines: readonly BridgeLine[]): number {
  const dollars = lines.reduce((sum, line) => sum + lineDollars(line), 0);
  return Math.max(0, Math.round(dollars * 100));
}

/** Dollars-weighted majority department across the invoice's lines. Ties
 * resolve in CATEGORY order below so the suggestion is deterministic. The
 * manager can always override in the sheet before committing. */
export function suggestExpenseDepartment(lines: readonly BridgeLine[]): Department {
  const order: readonly BridgeCategory[] = ['housekeeping', 'maintenance', 'breakfast', 'other'];
  const weights = new Map<BridgeCategory, number>();
  for (const line of lines) {
    weights.set(line.category, (weights.get(line.category) ?? 0) + lineDollars(line));
  }
  let best: BridgeCategory = 'housekeeping';
  let bestWeight = -1;
  for (const category of order) {
    const weight = weights.get(category) ?? 0;
    if (weight > bestWeight) {
      best = category;
      bestWeight = weight;
    }
  }
  return CATEGORY_TO_DEPARTMENT[best];
}

/**
 * Deterministic expense primary key for one committed invoice at one hotel.
 * SHA-256 of the scoped business key, folded into a well-formed UUID (version
 * and variant nibbles set so strict validators accept it). Same invoice →
 * same UUID forever; the create route's exact-retry machinery does the rest.
 */
export async function expenseOperationIdForInvoice(
  propertyId: string,
  notesTag: string,
): Promise<string> {
  const keyBytes = new TextEncoder().encode(`inventory-expense-bridge:${propertyId}:${notesTag}`);
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', keyBytes));
  const hex = Array.from(digest.slice(0, 16), (b) => b.toString(16).padStart(2, '0')).join('');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `8${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join('-');
}

/** Checkbook notes line. Plain provenance so a manager reading the register
 * knows the row was booked by the scanner, not typed. The tag carries the
 * invoice reference for tracing back to the delivery. */
export function inventoryExpenseNotes(notesTag: string): string {
  return `Booked automatically from the Inventory invoice scan. ${notesTag}`;
}

/** Recover the normalized invoice reference from a delivery notes tag
 * (`… · inv#<reference>@<vendor>`). The reference validator refuses '@' and
 * the vendor normalizer strips it, so the first '@' after 'inv#' is always
 * the reference/vendor boundary. Null for legacy unnumbered tags. */
export function invoiceReferenceFromNotesTag(notesTag: string | null | undefined): string | null {
  const match = /inv#([^@]+)@/u.exec(notesTag ?? '');
  const reference = match?.[1]?.trim() ?? '';
  return reference.length > 0 ? reference : null;
}
