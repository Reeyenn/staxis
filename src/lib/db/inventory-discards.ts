// ═══════════════════════════════════════════════════════════════════════════
// Inventory Discards — waste / shrinkage write-off log.
//
// One row per discard event (stained linen, damaged goods, lost, theft,
// other). This is the WRITE path for inventory_discards (migration 0061): the
// table existed and the ML already subtracts discards from consumption, but
// nothing in the app wrote a row — so thrown-away stock read as normal usage
// and inflated the learned burn rate. This closes that gap.
//
// Mirrors addInventoryOrder (inventory-orders.ts): anon client + RLS (this is
// an authed page; the "owner rw inventory_discards" policy in 0061 permits the
// property owner to insert). After logging the discard we DECREMENT the item's
// current_stock so the on-hand number reflects the write-off immediately.
// ═══════════════════════════════════════════════════════════════════════════

import type { InventoryDiscard } from '@/types';
import { supabase, logErr } from './_common';
import { toInventoryDiscardRow } from '../db-mappers';

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
  pid: string,
  discard: Omit<InventoryDiscard, 'id'>,
): Promise<AddInventoryDiscardResult> {
  // Auto-compute cost_value when both pieces are present (quantity × unit cost
  // at discard time) so callers don't have to. Round to cents on write so
  // float artefacts don't accumulate in the shrinkage ledger.
  const costValue =
    discard.costValue ??
    (discard.unitCost != null
      ? Math.round(Number(discard.unitCost) * Number(discard.quantity ?? 0) * 100) / 100
      : undefined);

  const row = {
    ...toInventoryDiscardRow({ ...discard, propertyId: pid, costValue }),
    property_id: pid,
  };
  const { data: inserted, error } = await supabase
    .from('inventory_discards').insert(row).select('id').single();
  if (error) { logErr('addInventoryDiscard', error); throw error; }

  // Decrement the item's current_stock by the discarded quantity so the
  // on-hand figure drops immediately (waste leaves the shelf). Read-modify-
  // write: fetch current, clamp at 0, write back. Non-fatal on failure — the
  // discard is durably logged; a stale stock number is a recoverable UI issue.
  // (This mirrors addInventoryOrder's non-atomic stamp; concurrent write-offs
  // of the same item can lose an update, drifting the on-hand number — the
  // discard rows themselves stay durable, and the next count corrects it.)
  let newStock: number | null = null;
  if (discard.itemId && discard.quantity && discard.quantity > 0) {
    const { data: itemRow, error: readErr } = await supabase
      .from('inventory')
      .select('current_stock')
      .eq('id', discard.itemId)
      .eq('property_id', pid)
      .maybeSingle();
    if (readErr) {
      logErr('addInventoryDiscard: stock read failed (non-fatal)', readErr);
    } else if (itemRow) {
      const current = Number((itemRow as { current_stock?: unknown }).current_stock ?? 0);
      const next = Math.max(0, current - Number(discard.quantity));
      const { error: decErr } = await supabase
        .from('inventory')
        .update({ current_stock: next })
        .eq('id', discard.itemId)
        .eq('property_id', pid);
      if (decErr) {
        logErr('addInventoryDiscard: stock decrement failed (non-fatal)', decErr);
      } else {
        newStock = next;
      }
    }
  }

  return { id: String(inserted.id), newStock };
}
