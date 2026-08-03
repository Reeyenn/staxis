// ═══════════════════════════════════════════════════════════════════════════
// From an approved draft to an executable plan.
//
// Pure and dependency-light on purpose: the executor in db/inventory-imports.ts
// runs whatever this returns, and this is where every rule about WHAT may be
// written lives, so the rules are unit-testable without a database.
//
// THE RULE THIS FILE EXISTS TO ENFORCE
// An old sheet may never touch today's stock. Not by mistake, not because the
// manager ticked something, not because the client sent a mode string. The
// mode is recomputed HERE from the as-of date and today's date, and the client
// has no vote. A `history_only` plan simply has no stock updates in it — the
// executor cannot write what it was not given.
//
// WHY IMPORTED ITEMS ARE CREATED AT ZERO
// Starting an item at a non-zero stock is an opening adjustment: it puts value
// on the books that no invoice paid for, which is why the Add-item sheet makes
// a manager confirm it against a cost. An import creates the item at zero and
// then COUNTS it. A count is the ordinary way stock arrives at a number, it is
// already dated, and it is already what the model reads.
// ═══════════════════════════════════════════════════════════════════════════

import { localDateTimeToUtc, propertyLocalDate } from '@/lib/rules-engine/time-utils';
import { centsToDollars } from './money';
import { decideAsOfMode, isIsoDate, type AsOfMode, type BuiltInCategory } from './draft';
import { displayUnit } from './units';

export class ImportCommitError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'ImportCommitError';
  }
}

/** One line as the manager left it on the confirm screen. */
export interface ConfirmedLine {
  key: string;
  rowIndex: number;
  name: string;
  unit: string;
  category: BuiltInCategory;
  customCategoryId: string | null;
  unitCostCents: number | null;
  vendorName: string | null;
  quantity: number | null;
  parLevel: number | null;
  asOfDate: string | null;
  /**
   * Every dated observation of this item in the file, oldest first. One count
   * teaches the model nothing; a run of months is the entire reason an import
   * is worth doing. Empty or absent falls back to the single `quantity`.
   */
  historyPoints?: ReadonlyArray<{ asOfDate: string; quantity: number }>;
  /** 'merge' needs mergeItemId; 'skip' drops the line entirely. */
  decision: 'merge' | 'create' | 'skip';
  mergeItemId: string | null;
}

export interface ConfirmedSkip {
  rowIndex: number;
  reason: string;
  text: string;
}

export interface BuildCommitPlanInput {
  propertyTimezone: string;
  asOfDate: string;
  todayLocal: string;
  lines: readonly ConfirmedLine[];
  skipped?: readonly ConfirmedSkip[];
  /** Ids that actually exist at this hotel. A merge target outside it is a
   *  client bug or a probe, and either way it is refused. */
  existingItemIds: ReadonlySet<string>;
  /** itemId → the last time it was counted, so an old sheet can never move a
   *  newer count backwards even in `current` mode. */
  lastCountedAtByItem?: ReadonlyMap<string, string | null>;
  /** Custom category ids that belong to this hotel. */
  customCategoryIds?: ReadonlySet<string>;
  now?: Date;
}

export interface PlannedCreate {
  lineKey: string;
  name: string;
  unit: string;
  category: BuiltInCategory;
  customCategoryId: string | null;
  parLevel: number;
  /** The legacy dollars column. Converted from cents exactly once, here. */
  unitCostDollars: number | null;
}

export interface PlannedCount {
  lineKey: string;
  /** Null when the item is created by this same plan; resolved at exec time. */
  itemId: string | null;
  createKey: string | null;
  itemName: string;
  countedStock: number;
  unitCostDollars: number | null;
  /** The instant stored on the count row (hotel-local noon, in UTC). */
  countedAt: string;
  /** The hotel calendar date that instant belongs to. Carried explicitly
   *  because slicing the UTC string gives the wrong day for a hotel east of
   *  UTC, which is precisely the kind of off-by-one nobody notices. */
  asOfDate: string;
}

export interface PlannedStockUpdate {
  lineKey: string;
  itemId: string | null;
  createKey: string | null;
  currentStock: number;
  lastCountedAt: string;
}

export interface PlannedRow {
  lineKey: string | null;
  rowIndex: number;
  rawName: string;
  outcome: 'created' | 'merged' | 'history_only' | 'skipped';
  skipReason: string | null;
  mergeItemId: string | null;
  quantity: number | null;
  unit: string | null;
  unitCostCents: number | null;
  vendorName: string | null;
  asOfDate: string | null;
}

export interface ImportCommitPlan {
  mode: AsOfMode;
  asOfDate: string;
  countedAt: string;
  creates: PlannedCreate[];
  counts: PlannedCount[];
  stockUpdates: PlannedStockUpdate[];
  rows: PlannedRow[];
  vendorNames: string[];
  itemCount: number;
  skippedCount: number;
}

function toQuantity(v: number | null): number | null {
  if (v === null || !Number.isFinite(v) || v < 0) return null;
  return v;
}

/**
 * The instant a count from a past date is recorded at: noon, hotel-local, on
 * the as-of date. Noon is unambiguous on both ends of a daylight-saving
 * change, which matters because the model buckets counts by local day.
 */
export function countedAtFor(asOfDate: string, propertyTimezone: string): string {
  const instant = localDateTimeToUtc(asOfDate, '12:00:00', propertyTimezone);
  if (!instant || propertyLocalDate(instant, propertyTimezone) !== asOfDate) {
    throw new ImportCommitError(
      'as_of_timezone_invalid',
      'We could not place that date in this hotel\'s timezone. Check the hotel timezone and try again.',
    );
  }
  return instant.toISOString();
}

export function buildImportCommitPlan(input: BuildCommitPlanInput): ImportCommitPlan {
  const { propertyTimezone, asOfDate, todayLocal } = input;
  if (!isIsoDate(asOfDate)) {
    throw new ImportCommitError('as_of_date_invalid', 'Pick the date this sheet was current.');
  }
  if (!isIsoDate(todayLocal)) {
    throw new ImportCommitError('today_invalid', 'We could not work out today\'s date at this hotel.');
  }
  if (asOfDate > todayLocal) {
    throw new ImportCommitError('as_of_date_future', 'That date is in the future. Pick the date the sheet was current.');
  }

  // Recomputed, never accepted from the caller.
  const mode = decideAsOfMode(asOfDate, todayLocal);
  const countedAt = countedAtFor(asOfDate, propertyTimezone);

  const creates: PlannedCreate[] = [];
  const counts: PlannedCount[] = [];
  const stockUpdates: PlannedStockUpdate[] = [];
  const rows: PlannedRow[] = [];
  const vendorNames = new Set<string>();
  const usedNames = new Set<string>();
  const mergedItemIds = new Set<string>();

  /**
   * The dated observations for one line, oldest first, de-duplicated by date
   * and clamped to dates at or before the batch's as-of date. A point dated
   * after the sheet was current is a misread, and a misread date is exactly
   * how an old number ends up looking like today's.
   */
  const pointsFor = (line: ConfirmedLine): Array<{ asOfDate: string; quantity: number }> => {
    const raw = line.historyPoints && line.historyPoints.length > 0
      ? line.historyPoints
      : (toQuantity(line.quantity) !== null
        ? [{ asOfDate: isIsoDate(line.asOfDate) ? line.asOfDate : asOfDate, quantity: line.quantity as number }]
        : []);
    const byDate = new Map<string, number>();
    for (const p of raw) {
      const date = isIsoDate(p.asOfDate) && p.asOfDate <= asOfDate ? p.asOfDate : asOfDate;
      const qty = toQuantity(p.quantity);
      if (qty === null) continue;
      byDate.set(date, qty);
    }
    return [...byDate.entries()]
      .map(([asOf, quantity]) => ({ asOfDate: asOf, quantity }))
      .sort((a, b) => (a.asOfDate < b.asOfDate ? -1 : a.asOfDate > b.asOfDate ? 1 : 0));
  };

  for (const line of input.lines) {
    const name = (line.name ?? '').trim();
    const vendorName = (line.vendorName ?? '').trim() || null;
    const quantity = toQuantity(line.quantity);
    const rowAsOf = isIsoDate(line.asOfDate) ? line.asOfDate : asOfDate;

    if (line.decision === 'skip') {
      rows.push({
        lineKey: line.key, rowIndex: line.rowIndex, rawName: name || '(blank)',
        outcome: 'skipped', skipReason: 'manager_removed', mergeItemId: null,
        quantity, unit: line.unit ?? null, unitCostCents: line.unitCostCents ?? null,
        vendorName, asOfDate: rowAsOf,
      });
      continue;
    }

    if (!name) {
      throw new ImportCommitError('item_name_required', 'Every line needs an item name before you can save.');
    }
    if (line.unitCostCents !== null && (!Number.isInteger(line.unitCostCents) || line.unitCostCents < 0)) {
      throw new ImportCommitError('unit_cost_invalid', `Check the price on “${name}”.`);
    }
    if (line.customCategoryId && input.customCategoryIds && !input.customCategoryIds.has(line.customCategoryId)) {
      throw new ImportCommitError('category_unknown', `That category is not one of this hotel's categories.`);
    }
    if (vendorName) vendorNames.add(vendorName);

    const unitCostDollars = line.unitCostCents !== null ? centsToDollars(line.unitCostCents) : null;

    if (line.decision === 'merge') {
      const itemId = line.mergeItemId;
      if (!itemId || !input.existingItemIds.has(itemId)) {
        throw new ImportCommitError('merge_target_unknown', `Choose an item to merge “${name}” into, or add it as new.`);
      }
      if (mergedItemIds.has(itemId)) {
        throw new ImportCommitError('merge_target_repeated', `Two lines are merging into the same item. Combine them first.`);
      }
      mergedItemIds.add(itemId);

      const points = pointsFor(line);
      for (const p of points) {
        counts.push({
          lineKey: line.key, itemId, createKey: null, itemName: name,
          countedStock: p.quantity, unitCostDollars,
          countedAt: countedAtFor(p.asOfDate, propertyTimezone),
          asOfDate: p.asOfDate,
        });
      }
      const newest = points[points.length - 1];
      if (newest) {
        // A newer count already on the item outranks an imported sheet even
        // when the sheet is recent. History still gets the rows above.
        const priorCountedAt = input.lastCountedAtByItem?.get(itemId) ?? null;
        const priorIsNewer = priorCountedAt !== null && priorCountedAt > countedAt;
        if (mode === 'current' && !priorIsNewer) {
          stockUpdates.push({
            lineKey: line.key, itemId, createKey: null,
            currentStock: newest.quantity, lastCountedAt: countedAt,
          });
        }
      }
      rows.push({
        lineKey: line.key, rowIndex: line.rowIndex, rawName: name,
        outcome: mode === 'current' && quantity !== null ? 'merged' : 'history_only',
        skipReason: null, mergeItemId: itemId, quantity, unit: displayUnit(line.unit),
        unitCostCents: line.unitCostCents ?? null, vendorName, asOfDate: rowAsOf,
      });
      continue;
    }

    // decision === 'create'
    const nameKey = name.toLowerCase();
    if (usedNames.has(nameKey)) {
      throw new ImportCommitError('duplicate_new_item', `“${name}” is on the list twice. Remove one, or merge it.`);
    }
    usedNames.add(nameKey);

    const parLevel = line.parLevel !== null && Number.isFinite(line.parLevel) && line.parLevel >= 0
      ? line.parLevel
      : 0;

    creates.push({
      lineKey: line.key, name, unit: displayUnit(line.unit),
      category: line.category, customCategoryId: line.customCategoryId ?? null,
      parLevel, unitCostDollars,
    });
    const points = pointsFor(line);
    for (const p of points) {
      counts.push({
        lineKey: line.key, itemId: null, createKey: line.key, itemName: name,
        countedStock: p.quantity, unitCostDollars,
        countedAt: countedAtFor(p.asOfDate, propertyTimezone),
        asOfDate: p.asOfDate,
      });
    }
    const newestPoint = points[points.length - 1];
    if (newestPoint && mode === 'current') {
      stockUpdates.push({
        lineKey: line.key, itemId: null, createKey: line.key,
        currentStock: newestPoint.quantity, lastCountedAt: countedAt,
      });
    }
    rows.push({
      lineKey: line.key, rowIndex: line.rowIndex, rawName: name,
      outcome: 'created', skipReason: null, mergeItemId: null,
      quantity, unit: displayUnit(line.unit), unitCostCents: line.unitCostCents ?? null,
      vendorName, asOfDate: rowAsOf,
    });
  }

  for (const s of input.skipped ?? []) {
    rows.push({
      lineKey: null, rowIndex: s.rowIndex, rawName: (s.text || '(blank)').slice(0, 300),
      outcome: 'skipped', skipReason: s.reason, mergeItemId: null,
      quantity: null, unit: null, unitCostCents: null, vendorName: null, asOfDate: null,
    });
  }

  if (creates.length === 0 && counts.length === 0) {
    throw new ImportCommitError('nothing_to_import', 'There is nothing left on this list to save.');
  }

  // Belt and braces on the rule the whole file is about. If this ever throws,
  // a code path found a way to write current stock from an old sheet.
  if (mode === 'history_only' && stockUpdates.length > 0) {
    throw new ImportCommitError('history_only_violation', 'An older sheet cannot change today\'s stock.');
  }

  rows.sort((a, b) => a.rowIndex - b.rowIndex);

  return {
    mode,
    asOfDate,
    countedAt,
    creates,
    counts,
    stockUpdates,
    rows,
    vendorNames: [...vendorNames].sort(),
    itemCount: creates.length + new Set(counts.filter((c) => c.itemId).map((c) => c.itemId)).size,
    skippedCount: rows.filter((r) => r.outcome === 'skipped').length,
  };
}
