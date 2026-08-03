// ═══════════════════════════════════════════════════════════════════════════
// "Remove this import" — the window, and the order things must come out in.
//
// An import is the one action in this product that writes hundreds of rows on
// one tap. That is only safe if taking it back out is also one tap, and if
// taking it out really does take out everything it put in — including what the
// model learned from it. Anything less and the undo button is a comfort, not a
// control.
//
// THE ORDER IS THE HARD PART. Postgres will tell us if we get it wrong, and it
// is set up so that it does: prediction_log.inventory_count_id references
// inventory_counts ON DELETE NO ACTION (migration 0312). Delete an imported
// count that a shadow-mode prediction was later paired against and the delete
// is REFUSED. So the ML derivatives come out first, by design, and a future
// edit that forgets them fails loudly instead of orphaning them.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * How long a manager has to change their mind. Generous on purpose: the person
 * who imports three years of sheets on a Tuesday is not the person who notices
 * the units were wrong, and the noticing happens when somebody counts.
 */
export const INVENTORY_IMPORT_UNDO_WINDOW_DAYS = 30;

/**
 * The steps, in the only order that works. Exported so a test can pin it: this
 * list is the documentation, and a reordering that breaks the cascade should
 * break a test rather than a production delete.
 */
export const IMPORT_UNDO_STEPS = [
  // 1. Everything the model derived from the imported counts. Must precede the
  //    counts themselves or Postgres refuses the delete.
  'prediction_log',
  // 2. The dated history rows this import wrote.
  'inventory_counts',
  // 3. The per-day occupancy this import derived, restored to what was there.
  'daily_logs',
  // 4. Items that would not exist but for this import.
  'inventory',
  // 5. The batch itself, stamped rather than deleted, so the receipt survives.
  'inventory_import_batches',
] as const;

export type ImportUndoStep = typeof IMPORT_UNDO_STEPS[number];

export type UndoRefusal =
  | 'already_undone'
  | 'window_expired'
  | 'not_found';

export interface UndoDecision {
  ok: boolean;
  reason: UndoRefusal | null;
  /** Days left in the window; 0 when it has closed. */
  daysLeft: number;
}

export function importUndoDeadline(importedAt: Date): Date {
  return new Date(importedAt.getTime() + INVENTORY_IMPORT_UNDO_WINDOW_DAYS * 86_400_000);
}

export function decideImportUndo(args: {
  importedAt: Date | string;
  undoneAt: Date | string | null;
  now?: Date;
}): UndoDecision {
  const now = args.now ?? new Date();
  const importedAt = args.importedAt instanceof Date ? args.importedAt : new Date(args.importedAt);
  if (Number.isNaN(importedAt.getTime())) return { ok: false, reason: 'not_found', daysLeft: 0 };
  if (args.undoneAt) return { ok: false, reason: 'already_undone', daysLeft: 0 };

  const deadline = importUndoDeadline(importedAt);
  const msLeft = deadline.getTime() - now.getTime();
  if (msLeft <= 0) return { ok: false, reason: 'window_expired', daysLeft: 0 };
  return { ok: true, reason: null, daysLeft: Math.ceil(msLeft / 86_400_000) };
}

// ─── The cascade, as an orchestration a test can watch ─────────────────────
//
// The database work is behind an interface so the ORDER is testable without a
// database. That is the point: "prediction_log before inventory_counts" is not
// a style preference, it is the difference between an undo that works and one
// that raises a foreign-key error in front of a manager, and a comment cannot
// hold that. A fake `UndoOps` records the calls, the test asserts the sequence,
// and reordering the real function fails it.

export interface UndoRowRecord {
  itemId: string | null;
  createdItem: boolean;
  countId: string | null;
}

export interface UndoDayRestore {
  date: string;
  prior: Record<string, unknown>;
}

export interface UndoItemActivity {
  /** Null when the item is already gone. */
  exists: boolean;
  currentStock: number;
  remainingCounts: number;
  remainingOrders: number;
}

export interface UndoOps {
  loadRows(): Promise<UndoRowRecord[]>;
  /** Everything the model derived from these counts. MUST run first. */
  deletePredictions(countIds: readonly string[]): Promise<number>;
  deleteCounts(countIds: readonly string[]): Promise<number>;
  loadOccupancyDays(): Promise<UndoDayRestore[]>;
  restoreDay(day: UndoDayRestore): Promise<void>;
  itemActivity(itemId: string): Promise<UndoItemActivity>;
  deleteItem(itemId: string): Promise<void>;
  stampBatchUndone(): Promise<void>;
}

export interface UndoImportOutcome {
  removedPredictions: number;
  removedCounts: number;
  restoredDays: number;
  removedItems: number;
  keptItems: number;
}

/**
 * Take one batch back out.
 *
 * An item this import created is KEPT when the hotel has since started using
 * it: another count, a delivery against it, or stock on the shelf. Deleting a
 * shelf somebody is counting is not an undo, it is a second mistake.
 */
export async function runImportUndo(ops: UndoOps): Promise<UndoImportOutcome> {
  const rows = await ops.loadRows();
  const countIds = [...new Set(rows.map((r) => r.countId).filter((v): v is string => Boolean(v)))];
  const createdItemIds = [...new Set(
    rows.filter((r) => r.createdItem && r.itemId).map((r) => r.itemId as string),
  )];

  let removedPredictions = 0;
  let removedCounts = 0;
  if (countIds.length > 0) {
    removedPredictions = await ops.deletePredictions(countIds);
    removedCounts = await ops.deleteCounts(countIds);
  }

  let restoredDays = 0;
  for (const day of await ops.loadOccupancyDays()) {
    await ops.restoreDay(day);
    restoredDays += 1;
  }

  let removedItems = 0;
  let keptItems = 0;
  for (const itemId of createdItemIds) {
    const activity = await ops.itemActivity(itemId);
    if (!activity.exists) continue;
    if (activity.remainingCounts > 0 || activity.remainingOrders > 0 || activity.currentStock > 0) {
      keptItems += 1;
      continue;
    }
    await ops.deleteItem(itemId);
    removedItems += 1;
  }

  await ops.stampBatchUndone();
  return { removedPredictions, removedCounts, restoredDays, removedItems, keptItems };
}

/** The sentence next to the button. Never promises a window it does not have. */
export function undoWindowSentence(args: { importedAt: Date | string; undoneAt: Date | string | null; now?: Date }): string {
  const decision = decideImportUndo(args);
  if (decision.reason === 'already_undone') return 'This import was removed.';
  if (decision.reason === 'window_expired') return 'Too long ago to remove in one step.';
  if (decision.daysLeft === 1) return 'You can remove this import today.';
  return `You can remove this import for another ${decision.daysLeft} days.`;
}
