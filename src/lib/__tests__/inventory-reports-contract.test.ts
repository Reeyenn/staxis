import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { isInventoryAccountingSummaryPayload } from '../inventory-accounting-contract';

function validSummary(): Record<string, unknown> {
  return {
    monthKey: '2026-07',
    monthStart: '2026-07-01T05:00:00.000Z',
    totals: {
      openingValue: 100,
      receiptsValue: 20,
      loggedPurchasesValue: 20,
      knownLoggedPurchasesValue: 20,
      purchasesValue: 20,
      actualUsageValue: null,
      actualStatus: 'pending',
      allocation: 'pending',
      isPartial: true,
      budgetComparisonAvailable: false,
      discardsValue: 4,
      knownDiscardsValue: 4,
      discardsComplete: true,
      closingValue: null,
      unaccountedShrinkageValue: null,
      knownUnaccountedShrinkageValue: 0,
      shrinkageComplete: false,
      budgetCents: null,
      spendCents: null,
    },
    byCategory: [{ reconciliationsThisMonth: 2 }],
    ytd: [{
      monthStart: '2026-07-01T05:00:00.000Z',
      receiptsValue: 20,
      purchasesValue: 20,
      actualUsageValue: null,
      actualStatus: 'pending',
      isPartial: true,
      discardsValue: 4,
      knownDiscardsValue: 4,
      discardsComplete: true,
    }],
    costPerOccupiedRoom: { thisMonth: null, occupiedNightsThisMonth: 123 },
  };
}

test('reports accepts a complete accounting response', () => {
  assert.equal(isInventoryAccountingSummaryPayload(validSummary()), true);
});

test('reports rejects partial 200 responses instead of inventing zeroes', () => {
  const missingTotals = validSummary();
  delete missingTotals.totals;
  assert.equal(isInventoryAccountingSummaryPayload(missingTotals), false);

  const partialTotals = validSummary();
  delete (partialTotals.totals as Record<string, unknown>).openingValue;
  assert.equal(isInventoryAccountingSummaryPayload(partialTotals), false);

  const invalidOccupancy = validSummary();
  (invalidOccupancy.costPerOccupiedRoom as Record<string, unknown>).occupiedNightsThisMonth = -1;
  assert.equal(isInventoryAccountingSummaryPayload(invalidOccupancy), false);
});

test('compare uses effective corrected deliveries and fails closed on an invalid hotel timezone', () => {
  const source = readFileSync(fileURLToPath(new URL(
    '../../app/api/inventory/compare/route.ts', import.meta.url,
  )), 'utf8');

  assert.match(source, /summarizeEffectivePurchasesForProperty\(/);
  assert.match(source, /purchaseSummary\.loggedPurchaseCents/);
  assert.match(source, /property timezone is unavailable/);
  assert.doesNotMatch(source, /invalid stored zone[^\n]*UTC/i);
});
