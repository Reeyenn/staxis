// ═══════════════════════════════════════════════════════════════════════════
// Invoice commit planner — turn a reviewed invoice (operator-confirmed line
// matches) into a normalized, validated, executable plan.
//
// Pure + dependency-free so it's fully unit-testable. The sheet's executor
// runs the plan against the db/* helpers; this module decides WHAT to write:
//
//   • orders[]        one inventory_orders row per received line (ledger fidelity)
//   • creates[]       one new inventory item per "create" line (stock = received)
//   • stockUpdates[]  one stock write per MATCHED item — quantities are
//                     COALESCED by itemId so two lines on the same item don't
//                     race on an absolute current_stock write (Codex C1).
//
// Stock semantics = re-baseline: finalStock = max(0, round(onHandEstimate)) +
// receivedQty (the manager-visible "on hand → after"), overridable per item
// when the estimate looks stale. See plan §3.
// ═══════════════════════════════════════════════════════════════════════════

export type LineDecision = 'match' | 'create' | 'skip';
export type InvCategory = 'housekeeping' | 'maintenance' | 'breakfast';

export interface ReviewLineInput {
  /** Stable key for retry tracking + create→order linking. */
  key: string;
  /** Raw invoice line name (snapshotted onto the order). */
  itemName: string;
  decision: LineDecision;
  matchedItemId: string | null;
  /** Qty received (UI holds a string; coerced here). */
  qty: number | string;
  quantityCases?: number | null;
  unitCost?: number | string | null;
  /** Matched lines: current estimated on-hand, for the re-baseline. */
  onHandEstimate?: number;
  /** Matched lines: operator override of the resulting stock (absolute). */
  afterOverride?: number | string | null;
  /** Create lines: new-item fields. */
  newItem?: { category: InvCategory; unit: string; parLevel: number | string };
}

export interface ReviewDraftInput {
  vendorName?: string | null;
  invoiceDate?: string | null; // YYYY-MM-DD
  invoiceNumber?: string | null;
  lines: ReviewLineInput[];
}

export interface CommitOrder {
  lineKey: string;
  /** Resolved item id for matched lines; null for create lines (resolved at
   *  exec time from the created item via createKey). */
  itemId: string | null;
  createKey?: string;
  itemName: string;
  quantity: number;
  quantityCases: number | null;
  unitCost: number | undefined;
}

export interface CommitStockUpdate {
  itemId: string;
  finalStock: number;
}

export interface CommitCreate {
  createKey: string;
  name: string;
  category: InvCategory;
  unit: string;
  parLevel: number;
  unitCost: number | undefined;
  initialStock: number;
}

export interface CommitPlan {
  vendorName: string | undefined;
  receivedAt: Date;
  notesTag: string;
  orders: CommitOrder[];
  stockUpdates: CommitStockUpdate[];
  creates: CommitCreate[];
}

function toFiniteNumber(x: unknown): number | undefined {
  if (x === null || x === undefined || x === '') return undefined;
  const n = typeof x === 'number' ? x : Number(x);
  return Number.isFinite(n) ? n : undefined;
}

function toPositiveQty(x: unknown): number | null {
  const n = toFiniteNumber(x);
  return n !== undefined && n > 0 ? n : null;
}

function toCases(x: unknown): number | null {
  const n = toFiniteNumber(x);
  return n !== undefined && n > 0 ? n : null;
}

/** Soft dedupe marker stamped on the order notes. Only carries an inv# when a
 *  number was extracted; otherwise it's a generic source tag. */
export function buildNotesTag(invoiceNumber?: string | null, vendorName?: string | null): string {
  const num = (invoiceNumber ?? '').trim();
  if (!num) return 'Invoice scan';
  const vendor = (vendorName ?? '').trim().toLowerCase();
  return `Invoice scan · inv#${num}@${vendor}`;
}

/** Warning-only duplicate check: true when an existing order note already
 *  carries this invoice's (numbered) tag. Not a hard guarantee — see plan §4. */
export function invoiceAlreadyRecorded(existingNotes: readonly (string | null | undefined)[], notesTag: string): boolean {
  if (!notesTag.startsWith('Invoice scan · inv#')) return false; // unnumbered → can't dedupe
  return existingNotes.some((n) => typeof n === 'string' && n.includes(notesTag));
}

function parseReceivedAt(invoiceDate: string | null | undefined, now: Date): Date {
  const raw = (invoiceDate ?? '').trim();
  if (raw) {
    const d = new Date(raw.length === 10 ? `${raw}T12:00:00` : raw); // noon avoids tz day-flip
    if (!Number.isNaN(d.getTime())) return d;
  }
  return now;
}

/**
 * Build the executable commit plan. `now` is injectable for deterministic
 * tests; in the app it defaults to the current time.
 */
export function buildCommitPlan(draft: ReviewDraftInput, now: Date = new Date()): CommitPlan {
  const vendorName = (draft.vendorName ?? '').trim() || undefined;
  const receivedAt = parseReceivedAt(draft.invoiceDate, now);
  const notesTag = buildNotesTag(draft.invoiceNumber, vendorName);

  const orders: CommitOrder[] = [];
  const creates: CommitCreate[] = [];
  // Coalesce matched lines by itemId.
  const byItem = new Map<string, { qty: number; onHand: number; override: number | undefined }>();

  for (const line of draft.lines) {
    if (line.decision === 'skip') continue;
    const qty = toPositiveQty(line.qty);
    if (qty === null) continue; // can't receive a non-positive quantity
    const unitCost = (() => {
      const n = toFiniteNumber(line.unitCost);
      return n !== undefined && n >= 0 ? n : undefined;
    })();
    const quantityCases = toCases(line.quantityCases);

    if (line.decision === 'create') {
      if (!line.newItem) continue;
      const parLevel = toFiniteNumber(line.newItem.parLevel) ?? 0;
      creates.push({
        createKey: line.key,
        name: line.itemName.trim(),
        category: line.newItem.category,
        unit: line.newItem.unit.trim() || 'each',
        parLevel: Math.max(0, parLevel),
        unitCost,
        initialStock: qty,
      });
      orders.push({ lineKey: line.key, itemId: null, createKey: line.key, itemName: line.itemName.trim(), quantity: qty, quantityCases, unitCost });
      continue;
    }

    // decision === 'match'
    if (!line.matchedItemId) continue; // defensive: a match line must have an id
    orders.push({ lineKey: line.key, itemId: line.matchedItemId, itemName: line.itemName.trim(), quantity: qty, quantityCases, unitCost });

    const prev = byItem.get(line.matchedItemId);
    const onHand = Math.max(0, Math.round(line.onHandEstimate ?? 0));
    const override = toFiniteNumber(line.afterOverride);
    if (prev) {
      prev.qty += qty;
      if (override !== undefined) prev.override = override; // last explicit override wins
    } else {
      byItem.set(line.matchedItemId, { qty, onHand, override: override !== undefined ? override : undefined });
    }
  }

  const stockUpdates: CommitStockUpdate[] = [];
  for (const [itemId, g] of byItem) {
    const finalStock = g.override !== undefined ? Math.max(0, g.override) : g.onHand + g.qty;
    stockUpdates.push({ itemId, finalStock });
  }

  return { vendorName, receivedAt, notesTag, orders, stockUpdates, creates };
}
