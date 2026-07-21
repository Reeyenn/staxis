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

test('reports opens with a stable full-size loading layout', () => {
  const panel = readFileSync(fileURLToPath(new URL(
    '../../app/inventory/_components/overlays/ReportsPanel.tsx', import.meta.url,
  )), 'utf8');
  const css = readFileSync(fileURLToPath(new URL(
    '../../app/inventory/_components/overlays/ReportsPanel.module.css', import.meta.url,
  )), 'utf8');
  const loadingState = panel.slice(
    panel.indexOf('function ReportsLoadingState'),
    panel.indexOf('function Card'),
  );

  assert.match(panel, /const showInitialLoading = !summary && !loadFailed;/);
  assert.doesNotMatch(panel, /\{loading && !summary \? \(/);
  assert.match(panel, /className=\{styles\.reportContent\}[\s\S]*?aria-busy=/);
  assert.match(loadingState, /role="status" aria-live="polite"/);
  assert.match(loadingState, /className=\{styles\.loadingVisual\} aria-hidden="true"/);
  assert.match(loadingState, /styles\.primaryGrid/);
  assert.match(loadingState, /styles\.secondaryGrid/);
  assert.match(css, /\.reportContent\s*\{[\s\S]*?min-height:\s*min\(700px, calc\(90vh - 120px\)\)/);
  assert.match(css, /@media \(max-width: 760px\)[\s\S]*?\.reportContent\s*\{[\s\S]*?min-height:\s*0/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.skeletonLine::after\s*\{[\s\S]*?animation:\s*none/);
});

test('reports caches loaded data only for the active property', () => {
  const source = readFileSync(fileURLToPath(new URL(
    '../../app/inventory/_components/overlays/ReportsPanel.tsx', import.meta.url,
  )), 'utf8');

  assert.match(source, /propertySummary\?\.propertyId === activePropertyId/);
  assert.match(source, /failedPropertyId === activePropertyId/);
  assert.match(source, /setPropertySummary\(\{ propertyId: activePropertyId, data: json\.data \}\)/);
  assert.doesNotMatch(source, /setSummary\(null\)/);
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
