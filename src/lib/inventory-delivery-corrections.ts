import type {
  EffectiveInventoryDelivery,
  InventoryDeliveryCorrection,
  InventoryOrder,
} from '@/types';

export const INVENTORY_DELIVERY_CORRECTION_ROOT_CHUNK_SIZE = 400;

/** The database list RPC rejects more than 500 roots. Keep the transport
 * contract pure/testable so long-history duplicate checks cannot regress into
 * one oversized request. */
export function inventoryDeliveryCorrectionRootChunks(
  rootOrderIds: readonly string[],
): string[][] {
  const uniqueIds = [...new Set(rootOrderIds.filter((id) => id.trim() !== ''))];
  const chunks: string[][] = [];
  for (let index = 0; index < uniqueIds.length; index += INVENTORY_DELIVERY_CORRECTION_ROOT_CHUNK_SIZE) {
    chunks.push(uniqueIds.slice(index, index + INVENTORY_DELIVERY_CORRECTION_ROOT_CHUNK_SIZE));
  }
  return chunks;
}

/**
 * Build the delivery read model used by History. The original receipt stays
 * visible, while its latest immutable correction supplies the effective state.
 * UI code never needs to infer correction groups from notes or timestamps.
 */
export function mergeInventoryDeliveryCorrections(
  orders: readonly InventoryOrder[],
  corrections: readonly InventoryDeliveryCorrection[],
): EffectiveInventoryDelivery[] {
  const byRoot = new Map<string, InventoryDeliveryCorrection[]>();
  for (const correction of corrections) {
    const group = byRoot.get(correction.originalOrderId);
    if (group) group.push(correction);
    else byRoot.set(correction.originalOrderId, [correction]);
  }

  return orders.map((original) => {
    const audit = (byRoot.get(original.id) ?? []).slice().sort((a, b) => {
      const aTime = a.createdAt?.getTime() ?? a.correctedAt?.getTime() ?? 0;
      const bTime = b.createdAt?.getTime() ?? b.correctedAt?.getTime() ?? 0;
      return aTime - bTime || a.id.localeCompare(b.id);
    });
    const referencedPriors = new Set(audit.flatMap((row) => row.priorCorrectionId ? [row.priorCorrectionId] : []));
    // The database prevents forks with a unique prior-correction index. Use
    // the one event that is not referenced by a child instead of guessing
    // chain order from equal transaction timestamps or random UUID order.
    const terminals = audit.filter((row) => !referencedPriors.has(row.id));
    const last = terminals.at(-1) ?? audit.at(-1) ?? null;
    if (!last) {
      return {
        rootOrderId: original.id,
        original,
        status: 'active',
        effectiveItemId: original.itemId,
        effectiveItemName: original.itemName,
        effectiveQuantity: original.quantity,
        effectiveUnitCost: original.unitCost ?? null,
        effectiveTotalCost: original.totalCost ?? (
          original.unitCost == null ? null : original.quantity * original.unitCost
        ),
        correctionCount: 0,
        lastCorrection: null,
      };
    }
    return {
      rootOrderId: original.id,
      original,
      status: last.kind === 'void' ? 'voided' : 'corrected',
      effectiveItemId: last.correctedItemId ?? null,
      effectiveItemName: last.correctedItemName ?? null,
      effectiveQuantity: last.correctedQuantity,
      effectiveUnitCost: last.correctedUnitCost ?? null,
      effectiveTotalCost: last.correctedTotalCost ?? null,
      correctionCount: audit.length,
      lastCorrection: last,
    };
  });
}
