import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const shellPath = path.resolve(
  process.cwd(),
  'src/app/inventory/_components/InventoryShell.tsx',
);
const shell = fs.readFileSync(shellPath, 'utf8');

test('inventory board keeps core item work available while failed supporting data stays unavailable', () => {
  assert.match(shell, /const \[bundleLoadError, setBundleLoadError\] = useState\(false\)/);
  assert.match(shell, /const safe = async <T,>\(label: string, promise: Promise<T>\): Promise<T \| null>/);
  assert.match(shell, /partialFailure: inventoryOperationalDetailsFailed\(requiredResults\)/);
  assert.doesNotMatch(shell, /partialFailure: .*financialResults/);
  assert.match(shell, /if \(itemsLoadError\) \{/);
  assert.doesNotMatch(shell, /if \(itemsLoadError \|\| bundleLoadError\)/);
  assert.match(shell, /\{bundleLoadError && \(/);
  assert.match(shell, /if \(d\.spend != null\) \{\s*setSpendDetail\(d\.spend\);\s*setSpendDataAvailable\(true\)/);
});

test('initial loads and refreshes expose partial failure without cross-hotel repainting', () => {
  assert.match(
    shell,
    /setBundleLoadError\(d\.partialFailure\)/,
  );
  assert.match(shell, /const requestedPropertyId = activePropertyId/);
  assert.match(
    shell,
    /activePropertyIdRef\.current !== requestedPropertyId[\s\S]*?inventoryBoardRequestIsCurrent\(data\.requestScope, boardRequestScopeRef\.current\)/,
  );
  assert.match(shell, /setBundleLoadError\(data\.partialFailure\)/);
});
