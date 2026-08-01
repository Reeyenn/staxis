import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import {
  inventoryFinancialDataEnabled,
  inventoryOperationalDetailsFailed,
} from '@/app/inventory/_components/inventory-financial-access';

function source(...parts: string[]): string {
  return readFileSync(join(process.cwd(), ...parts), 'utf8');
}

const propertyContext = source('src', 'contexts', 'PropertyContext.tsx');
const inventoryShell = source(
  'src', 'app', 'inventory', '_components', 'InventoryShell.tsx',
);

test('capability readiness is tagged to the resolved identity and hotel', () => {
  assert.match(
    propertyContext,
    /interface CapabilityOverrideSnapshot \{[\s\S]*?viewerKey: string;[\s\S]*?propertyId: string;[\s\S]*?overrides: CapabilityOverrideMap;/,
  );
  assert.match(
    propertyContext,
    /const resolvedPropertyId = activeProperty\?\.id \?\? null;[\s\S]*?const activePropertyViewerKey = userUid && userAccountId && resolvedPropertyId[\s\S]*?const expectedCapabilityViewerKey = activePropertyViewerKey/,
  );
  assert.match(
    propertyContext,
    /capabilitySnapshot\.viewerKey === expectedCapabilityViewerKey[\s\S]*?capabilitySnapshot\.propertyId === resolvedPropertyId/,
  );
  assert.match(
    propertyContext,
    /const map = await withPromiseDeadline\(fetchOverridesFor\(resolvedPropertyId\), \{[\s\S]*?PROPERTY_CONTEXT_TIMEOUT_MS[\s\S]*?expectedCapabilityViewerKeyRef\.current === expectedCapabilityViewerKey[\s\S]*?setCapabilitySnapshot\(\{[\s\S]*?propertyId: resolvedPropertyId,[\s\S]*?overrides: map/,
  );
  assert.match(
    propertyContext,
    /source: 'selector',[\s\S]*?\}\)\) return;[\s\S]*?setCapabilitySnapshot\(null\);[\s\S]*?setActivePropertyIdState\(id\)/,
  );
  assert.match(
    propertyContext,
    /source: 'cross-tab',[\s\S]*?\}\)\) return;[\s\S]*?setCapabilitySnapshot\(null\);[\s\S]*?setActivePropertyIdState\(next\)/,
  );
});

test('inventory starts ordinary stock from hotel reach while sensitive controls wait for capabilities', () => {
  assert.match(
    inventoryShell,
    /const inventoryViewerContextReady = Boolean\([\s\S]*?activeProperty\?\.id === activePropertyId[\s\S]*?\);/,
  );
  assert.match(
    inventoryShell,
    /const inventoryContextReady = Boolean\([\s\S]*?inventoryViewerContextReady[\s\S]*?capabilityOverridesPropertyId === activePropertyId[\s\S]*?capabilityOverridesViewerKey === capabilityViewerKey/,
  );
  assert.match(inventoryShell, /const canViewFinancials = inventoryFinancialDataEnabled\(\{[\s\S]*?contextReady: inventoryContextReady,[\s\S]*?hasCapability: can\('view_financials'\),[\s\S]*?enabledSections: activeProperty\?\.enabledSections/);
  assert.ok(
    (inventoryShell.match(/if \(!uid \|\| !activePropertyId \|\| !inventoryViewerContextReady\) return;/g) ?? []).length >= 3,
  );
  assert.match(
    inventoryShell,
    /const inventoryDataMatchesViewer = inventoryViewerContextReady[\s\S]*?inventoryDataViewerKey === capabilityViewerKey/,
  );
  assert.match(
    inventoryShell,
    /const dataReady = inventoryDataMatchesViewer && itemsLoaded && bundleLoaded/,
  );
  assert.match(
    inventoryShell,
    /if \(!inventoryDataMatchesViewer \|\| !revealed\) \{/,
  );
  assert.doesNotMatch(
    inventoryShell,
    /if \(!inventoryDataMatchesViewer \|\| !revealed \|\| !itemsLoaded \|\| !bundleLoaded\) \{/,
  );
});

test('read-only hotel standings retain reads but receive no inventory mutation path', () => {
  assert.match(inventoryShell, /const hotelStanding = useActiveHotelStanding\(\)/);
  assert.match(
    inventoryShell,
    /const canManage = inventoryContextReady[\s\S]*?hotelStanding\.ready[\s\S]*?hotelStanding\.hotelMutationAllowed[\s\S]*?can\('manage_inventory_orders'\)/,
  );
  assert.match(
    inventoryShell,
    /\(action === 'count' \|\| action === 'delivery' \|\| action === 'ordering' \|\| action === 'add'\) && !canManage/,
  );
  assert.match(inventoryShell, /onQuickCount=\{canManage \? onQuickCount : undefined\}/);
  assert.match(inventoryShell, /onEdit=\{canManage \? onEditItem : undefined\}/);
  assert.match(inventoryShell, /open=\{overlay === 'count' && canManage\}/);
  assert.match(inventoryShell, /open=\{overlay === 'add' && canManage\}/);
  assert.match(inventoryShell, /if \(!canManageRef\.current\) return/);

  // Financial and AI reads are deliberately not tied to mutation standing.
  assert.doesNotMatch(
    inventoryShell,
    /const canViewFinancials = [^;]*hotelMutationAllowed/,
  );
  assert.match(inventoryShell, /open=\{overlay === 'ai'\}/);
});

test('finance availability is separate from the generic inventory connection warning', () => {
  assert.match(
    inventoryShell,
    /const closeDashboardPromise[\s\S]*?canViewFinancials && financialDataReady[\s\S]*?: Promise\.resolve\(null\)/,
  );
  assert.ok(
    (inventoryShell.match(/canViewFinancials && financialDataReady/g) ?? []).length >= 4,
  );
  assert.match(
    inventoryShell,
    /partialFailure: inventoryOperationalDetailsFailed\(requiredResults\)/,
  );
  assert.doesNotMatch(inventoryShell, /month close financial data is unavailable/);
});

test('Inventory-only hotels treat finance denial and empty inventory as valid startup states', () => {
  assert.equal(inventoryFinancialDataEnabled({
    contextReady: true,
    hasCapability: true,
    enabledSections: { inventory: true, financials: false },
  }), false);
  assert.equal(inventoryFinancialDataEnabled({
    contextReady: true,
    hasCapability: true,
    enabledSections: { inventory: true, financials: true },
  }), true);
  assert.equal(inventoryOperationalDetailsFailed([
    { occupancy: [] },
    { averages: {} },
    [], // counts
    [], // deliveries
    [], // losses
    [], // custom categories
  ]), false);
  assert.equal(inventoryOperationalDetailsFailed([[], null, []]), true);

  // Every money-bearing request and surface consumes the section-aware value,
  // so Financials-off cannot merely hide the nav while calls continue behind
  // the Inventory page.
  assert.match(
    inventoryShell,
    /const financialEvidencePromise[\s\S]*?canViewFinancials && financialDataReady[\s\S]*?\/api\/inventory\/financial-evidence/,
  );
  assert.match(
    inventoryShell,
    /const closeDashboardPromise[\s\S]*?canViewFinancials && financialDataReady[\s\S]*?\/api\/inventory\/month-close/,
  );
  assert.match(inventoryShell, /canViewFinancials && financialDataReady[\s\S]*?listInventoryBudgets/);
  assert.match(inventoryShell, /open=\{overlay === 'reports' && canViewFinancials\}/);
  assert.match(inventoryShell, /open=\{overlay === 'budgets' && canViewFinancials\}/);
  assert.match(inventoryShell, /open=\{overlay === 'close' && canManage && canViewFinancials\}/);
  assert.match(inventoryShell, /const canScanInvoices = canManage && canViewFinancials/);
  assert.match(inventoryShell, /if \(action === 'scan' && !canScanInvoices\) return/);
  assert.match(inventoryShell, /setOverlay\(action === 'scan' \? 'delivery'/);
  assert.match(inventoryShell, /canScanInvoices=\{canScanInvoices\}/);
  assert.doesNotMatch(inventoryShell, /open=\{overlay === 'scan'/);
});

test('the core snapshot gets one transient retry inside the original eight-second ceiling', () => {
  assert.match(inventoryShell, /function retryableInitialInventoryError\(error: unknown\): boolean/);
  assert.match(inventoryShell, /const timeout = window\.setTimeout\([\s\S]*?\}, 8000\);/);
  assert.match(inventoryShell, /const subscribe = \(attempt: 0 \| 1\) => \{/);
  assert.match(
    inventoryShell,
    /attempt === 0 && retryableInitialInventoryError\(error\)[\s\S]*?activeUnsubscribe\?\.\(\);[\s\S]*?subscribe\(1\);[\s\S]*?\}, 250\);/,
  );
  assert.equal((inventoryShell.match(/subscribe\(0\);/g) ?? []).length, 1);
});
