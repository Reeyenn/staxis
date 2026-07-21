import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

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
    /const resolvedPropertyId = activeProperty\?\.id \?\? null;[\s\S]*?const expectedCapabilityViewerKey = userUid && resolvedPropertyId/,
  );
  assert.match(
    propertyContext,
    /capabilitySnapshot\.viewerKey === expectedCapabilityViewerKey[\s\S]*?capabilitySnapshot\.propertyId === resolvedPropertyId/,
  );
  assert.match(
    propertyContext,
    /const map = await fetchOverridesFor\(resolvedPropertyId\);[\s\S]*?expectedCapabilityViewerKeyRef\.current === expectedCapabilityViewerKey[\s\S]*?setCapabilitySnapshot\(\{[\s\S]*?propertyId: resolvedPropertyId,[\s\S]*?overrides: map/,
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

test('inventory waits for the matching capability snapshot and masks stale hotel data', () => {
  assert.match(
    inventoryShell,
    /activeProperty\?\.id === activePropertyId[\s\S]*?capabilityOverridesPropertyId === activePropertyId[\s\S]*?capabilityOverridesViewerKey === capabilityViewerKey/,
  );
  assert.match(inventoryShell, /const canViewFinancials = inventoryContextReady && can\('view_financials'\)/);
  assert.ok(
    (inventoryShell.match(/if \(!uid \|\| !activePropertyId \|\| !inventoryContextReady\) return;/g) ?? []).length >= 2,
  );
  assert.match(
    inventoryShell,
    /const inventoryDataMatchesViewer = inventoryContextReady[\s\S]*?inventoryDataViewerKey === capabilityViewerKey/,
  );
  assert.match(
    inventoryShell,
    /if \(!inventoryDataMatchesViewer \|\| !revealed \|\| !itemsLoaded\) \{/,
  );
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
    /partialFailure: requiredResults\.some\(\(value\) => value == null\)/,
  );
  assert.doesNotMatch(inventoryShell, /month close financial data is unavailable/);
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
