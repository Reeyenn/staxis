// Commit executor for the scan-invoice flow. Extracted VERBATIM from
// ScanInvoiceSheet — do not restructure the progress bookkeeping: the
// CommitProgress sets are what make a retry after a partial failure resume
// the failed step and never double-insert an order / re-create an item /
// re-apply a stock update. The sheet owns the progress object in a ref and
// passes it in on every attempt.

import {
  addInventoryItem,
  addInventoryOrder,
  updateInventoryItem,
} from '@/lib/db';
import type { InventoryCategory } from '@/types';
import type { CommitPlan } from '@/lib/inventory-invoice-commit';

export const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

// Per-line commit progress, so a retry after a partial failure resumes the
// failed step and never double-inserts an order / re-creates an item.
export interface CommitProgress {
  createdIds: Map<string, string>;
  orderedKeys: Set<string>;
  stockedIds: Set<string>;
}

export function newCommitProgress(): CommitProgress {
  return { createdIds: new Map(), orderedKeys: new Set(), stockedIds: new Set() };
}

export interface CommitFailure {
  lineKey?: string;
  reason: string;
  collision?: boolean;
}

export async function executeCommit(
  plan: CommitPlan,
  prog: CommitProgress,
  ctx: { uid: string; pid: string; nameExists: string },
): Promise<CommitFailure[]> {
  const failures: CommitFailure[] = [];
  const { uid, pid } = ctx;

  for (const c of plan.creates) {
    if (prog.createdIds.has(c.createKey)) continue;
    try {
      const id = await addInventoryItem(uid, pid, {
        propertyId: pid,
        name: c.name,
        category: c.category as InventoryCategory,
        currentStock: c.initialStock,
        parLevel: c.parLevel,
        unit: c.unit,
        unitCost: c.unitCost,
        vendorName: plan.vendorName,
        lastCountedAt: plan.receivedAt,
      });
      prog.createdIds.set(c.createKey, id);
    } catch (e) {
      const collision = (e as { code?: string })?.code === '23505' || /duplicate key|unique/i.test(errMsg(e));
      failures.push({
        lineKey: c.createKey,
        collision,
        reason: collision ? ctx.nameExists : errMsg(e),
      });
    }
  }

  for (const o of plan.orders) {
    if (prog.orderedKeys.has(o.lineKey)) continue;
    const itemId = o.itemId ?? (o.createKey ? prog.createdIds.get(o.createKey) : undefined);
    if (!itemId) continue; // its create failed — skip the order
    try {
      await addInventoryOrder(uid, pid, {
        propertyId: pid,
        itemId,
        itemName: o.itemName,
        quantity: o.quantity,
        quantityCases: o.quantityCases ?? undefined,
        unitCost: o.unitCost ?? undefined,
        vendorName: plan.vendorName,
        orderedAt: null,
        receivedAt: plan.receivedAt,
        notes: plan.notesTag,
      });
      prog.orderedKeys.add(o.lineKey);
    } catch (e) {
      failures.push({ lineKey: o.lineKey, reason: errMsg(e) });
    }
  }

  for (const s of plan.stockUpdates) {
    if (prog.stockedIds.has(s.itemId)) continue;
    try {
      await updateInventoryItem(uid, pid, s.itemId, { currentStock: s.finalStock, lastCountedAt: plan.receivedAt });
      prog.stockedIds.add(s.itemId);
    } catch (e) {
      failures.push({ reason: errMsg(e) });
    }
  }
  return failures;
}
