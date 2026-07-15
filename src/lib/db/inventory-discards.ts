// ═══════════════════════════════════════════════════════════════════════════
// Inventory Discards — waste / shrinkage write-off log.
//
// One row per discard event (stained linen, damaged goods, lost, theft,
// other). This is the WRITE path for inventory_discards (migration 0061): the
// table existed and the ML already subtracts discards from consumption. The
// former helper split its ledger insert and stock decrement across two browser
// writes. Migration 0310 blocks that unsafe path; this unused API now fails
// before writing until a dedicated atomic discard RPC is introduced.
// ═══════════════════════════════════════════════════════════════════════════

import type { InventoryDiscard } from '@/types';

export interface AddInventoryDiscardResult {
  id: string;
  /**
   * The item's authoritative current_stock AFTER the decrement, read back from
   * the DB. The UI should display THIS value rather than deriving one from an
   * editable on-hand field — the field may have been changed since load, and
   * the decrement always applies to the real stored value, so a locally-derived
   * number can silently diverge from the DB (and, if later saved, overwrite
   * real stock). null when the item couldn't be read back.
   */
  newStock: number | null;
}

export async function addInventoryDiscard(
  _uid: string,
  _pid: string,
  _discard: Omit<InventoryDiscard, 'id'>,
): Promise<AddInventoryDiscardResult> {
  // Migration 0310 deliberately blocks browser stock updates that bypass an
  // atomic stock+ledger transaction. This legacy helper used to insert the
  // discard row first and then decrement stock in a separate request, which
  // could leave the ledger and on-hand total disagreeing. There is no current
  // caller; fail before either write until a dedicated discard RPC is shipped.
  throw new Error('Discard recording is unavailable until its atomic inventory transaction is enabled.');
}
