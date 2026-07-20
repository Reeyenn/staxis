import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

function source(...parts: string[]): string {
  return readFileSync(join(process.cwd(), ...parts), 'utf8');
}

describe('inventory month-close fail-closed wiring', () => {
  test('the API separates a committed mutation from dashboard hydration failure', () => {
    const route = source('src', 'app', 'api', 'inventory', 'month-close', 'route.ts');
    const mutationIndex = route.indexOf('await startInventoryMonthClose');
    const mutationFailureIndex = route.indexOf('inventoryMonthCloseMutationFailure(error, body.action)', mutationIndex);
    const hydrationIndex = route.indexOf('const dashboard = await getInventoryMonthCloseDashboard', mutationFailureIndex);
    const receiptIndex = route.indexOf('inventoryMonthCloseMutationReceipt({', hydrationIndex);

    assert.ok(mutationIndex >= 0);
    assert.ok(mutationFailureIndex > mutationIndex);
    assert.ok(hydrationIndex > mutationFailureIndex);
    assert.ok(receiptIndex > hydrationIndex);
    assert.match(route.slice(receiptIndex), /propertyId: gate\.pid/);
    assert.match(route.slice(receiptIndex), /mutationRequestId: body\.requestId/);
    assert.match(route.slice(receiptIndex), /status: 202/);
  });

  test('the client invalidates late save responses on hotel switch and reloads a committed receipt', () => {
    const panel = source(
      'src', 'app', 'inventory', '_components', 'overlays', 'MonthClosePanel.tsx',
    );
    assert.match(panel, /activePropertyIdRef\.current = activePropertyId/);
    assert.match(panel, /mutationSequence\.current \+= 1/);
    assert.match(panel, /const mutationIsCurrent = \(\) => isCurrentMonthCloseMutation/);
    assert.match(panel, /if \(!mutationIsCurrent\(\)\) return;/);
    assert.match(panel, /normalizeMonthCloseMutationReceipt\(payload\)/);
    assert.match(panel, /if \(!returned && !validReceipt\) throw/);
    assert.match(panel, /if \(!refreshed\) setCommittedRefreshPending\(true\)/);
    assert.match(panel, /copy\.committedRefreshBody/);
  });
});
