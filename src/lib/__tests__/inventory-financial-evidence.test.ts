import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import {
  hydrateInventoryCounts,
  hydrateInventoryDeliveries,
  hydrateInventoryDiscards,
  hydrateInventoryItems,
  inventoryBoardRequestIsCurrent,
  inventoryFinancialEvidenceFromPayload,
  inventoryFinancialRequestIsCurrent,
} from '@/app/inventory/_components/inventory-financial-evidence';
import type {
  EffectiveInventoryDelivery,
  InventoryCount,
  InventoryDiscard,
  InventoryItem,
} from '@/types';

const evidencePayload = {
  ok: true,
  data: {
    inventory: {
      item: { unitCost: 3.5, openingAdjustmentUnitCost: 3 },
    },
    counts: {
      count: { unitCost: 3.5, varianceValue: -7 },
    },
    orders: {
      order: { unitCost: 4, totalCost: 20 },
    },
    discards: {
      discard: { unitCost: 3.5, costValue: 7 },
    },
    currentMonthSpend: { total: 20, complete: true },
  },
};

function item(): InventoryItem {
  return {
    id: 'item', propertyId: 'hotel-a', name: 'Towels', category: 'housekeeping',
    currentStock: 5, parLevel: 10, unit: 'each', updatedAt: null,
    unitCost: 999, openingAdjustmentUnitCost: 999,
  };
}

function count(): InventoryCount {
  return {
    id: 'count', propertyId: 'hotel-a', itemId: 'item', itemName: 'Towels',
    countedStock: 5, countedAt: null, unitCost: 999, varianceValue: 999,
  };
}

function discard(): InventoryDiscard {
  return {
    id: 'discard', propertyId: 'hotel-a', itemId: 'item', itemName: 'Towels',
    quantity: 2, reason: 'damaged', discardedAt: null, unitCost: 999, costValue: 999,
  };
}

function delivery(): EffectiveInventoryDelivery {
  return {
    rootOrderId: 'order',
    original: {
      id: 'order', propertyId: 'hotel-a', itemId: 'item', itemName: 'Towels',
      quantity: 5, receivedAt: null, unitCost: 999, totalCost: 999,
    },
    status: 'corrected',
    effectiveItemId: 'item',
    effectiveItemName: 'Towels',
    effectiveQuantity: 4,
    effectiveUnitCost: 5,
    effectiveTotalCost: 20,
    correctionCount: 1,
    lastCorrection: {
      id: 'correction', propertyId: 'hotel-a', requestId: 'request', lineKey: 'line',
      originalOrderId: 'order', kind: 'correction', reason: 'quantity fix',
      correctedAt: null, previousItemId: 'item', previousItemName: 'Towels',
      previousQuantity: 5, previousUnitCost: 4, previousTotalCost: 20,
      correctedItemId: 'item', correctedItemName: 'Towels', correctedQuantity: 4,
      correctedUnitCost: 5, correctedTotalCost: 20, stockEffect: [], createdAt: null,
    },
  };
}

describe('inventory financial evidence hydration', () => {
  test('accepts only a complete finite server envelope', () => {
    const parsed = inventoryFinancialEvidenceFromPayload(evidencePayload);
    assert.ok(parsed);
    assert.equal(parsed.inventory.item.unitCost, 3.5);
    assert.deepEqual(parsed.currentMonthSpend, { total: 20, complete: true });

    assert.equal(inventoryFinancialEvidenceFromPayload({
      ...evidencePayload,
      data: { ...evidencePayload.data, orders: { order: { unitCost: 4 } } },
    }), null);
    assert.equal(inventoryFinancialEvidenceFromPayload({
      ...evidencePayload,
      data: { ...evidencePayload.data, currentMonthSpend: { total: Number.NaN, complete: true } },
    }), null);
  });

  test('hydrates every board ledger by immutable row id', () => {
    const parsed = inventoryFinancialEvidenceFromPayload(evidencePayload)!;
    assert.equal(hydrateInventoryItems([item()], parsed.inventory)[0].unitCost, 3.5);
    assert.equal(hydrateInventoryCounts([count()], parsed.counts)[0].varianceValue, -7);
    assert.equal(hydrateInventoryDiscards([discard()], parsed.discards)[0].costValue, 7);

    const hydratedDelivery = hydrateInventoryDeliveries([delivery()], parsed.orders)[0];
    assert.equal(hydratedDelivery.original.unitCost, 4);
    assert.equal(hydratedDelivery.original.totalCost, 20);
    // Correction costs were independently gated by the correction RPC and
    // survive only because the root order exists in the finance evidence.
    assert.equal(hydratedDelivery.effectiveUnitCost, 5);
    assert.equal(hydratedDelivery.lastCorrection?.correctedUnitCost, 5);
  });

  test('a denied or failed hydration strips stale costs instead of preserving them', () => {
    assert.equal(hydrateInventoryItems([item()], {})[0].unitCost, undefined);
    assert.equal(hydrateInventoryCounts([count()], {})[0].varianceValue, undefined);
    assert.equal(hydrateInventoryDiscards([discard()], {})[0].costValue, undefined);

    const strippedDelivery = hydrateInventoryDeliveries([delivery()], {})[0];
    assert.equal(strippedDelivery.original.unitCost, undefined);
    assert.equal(strippedDelivery.effectiveUnitCost, null);
    assert.equal(strippedDelivery.effectiveTotalCost, null);
    assert.equal(strippedDelivery.lastCorrection?.previousUnitCost, null);
    assert.equal(strippedDelivery.lastCorrection?.correctedTotalCost, null);
  });

  test('late responses cannot cross hotel, identity, or finance-access boundaries', () => {
    const requested = { propertyId: 'hotel-a', viewerKey: 'user-a:hotel-a', financialsEnabled: true };
    assert.equal(inventoryBoardRequestIsCurrent(requested, requested), true);
    assert.equal(inventoryFinancialRequestIsCurrent(requested, requested), true);
    assert.equal(inventoryFinancialRequestIsCurrent(requested, {
      ...requested, propertyId: 'hotel-b', viewerKey: 'user-a:hotel-b',
    }), false);
    assert.equal(inventoryFinancialRequestIsCurrent(requested, {
      ...requested, viewerKey: 'user-b:hotel-a',
    }), false);
    assert.equal(inventoryFinancialRequestIsCurrent(requested, {
      ...requested, financialsEnabled: false,
    }), false);
  });

  test('browser projections cannot opt back into hidden money columns', () => {
    const dbFile = (name: string) => readFileSync(
      join(process.cwd(), 'src', 'lib', 'db', name),
      'utf8',
    );
    const inventory = dbFile('inventory.ts');
    const counts = dbFile('inventory-counts.ts');
    const orders = dbFile('inventory-orders.ts');
    const discards = dbFile('inventory-discards.ts');

    const inventoryRead = inventory.slice(
      inventory.indexOf('export function subscribeToInventory'),
      inventory.indexOf('type InventoryItemPatch'),
    );
    const countRead = counts.slice(counts.indexOf('export async function listInventoryCounts'));
    const orderRead = orders.slice(
      orders.indexOf('export async function listInventoryOrders'),
      orders.indexOf('function fromCorrectionRow'),
    );
    const discardRead = discards.slice(discards.indexOf('export async function listInventoryDiscards'));

    for (const readPath of [inventoryRead, countRead, orderRead, discardRead]) {
      assert.doesNotMatch(readPath, /includeFinancials\s*=\s*true/);
      assert.doesNotMatch(readPath, /\.select\(['"]\*['"]\)/);
    }
    assert.doesNotMatch(inventoryRead, /unit_cost|opening_adjustment_unit_cost/);
    assert.doesNotMatch(countRead, /variance_value|unit_cost/);
    assert.doesNotMatch(orderRead, /total_cost|unit_cost/);
    assert.doesNotMatch(discardRead, /cost_value|unit_cost/);
  });

  test('the live receipt subtotal never fabricates unused category or item maps', () => {
    const shell = readFileSync(join(
      process.cwd(),
      'src', 'app', 'inventory', '_components', 'InventoryShell.tsx',
    ), 'utf8');
    assert.match(shell, /interface InventoryCurrentMonthSpend \{[\s\S]*?total: number;[\s\S]*?complete: boolean;/);
    assert.doesNotMatch(shell, /spendDetail\.byCat|spendDetail\.byItem/);
    assert.doesNotMatch(shell, /financialEvidence\.currentMonthSpend[\s\S]{0,200}byCat/);
    assert.match(shell, /const purchasesThisMonth = spendDetail\.total/);
    assert.match(shell, /const purchasesComplete = spendDetail\.complete/);
  });
});
