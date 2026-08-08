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
  assert.match(shell, /const \[projectionLoadState, setProjectionLoadState\] = useState<InventoryLoadState>\('idle'\)/);
  assert.match(shell, /const \[secondaryLoadState, setSecondaryLoadState\] = useState<InventoryLoadState>\('idle'\)/);
  assert.match(shell, /const safe = async <T,>\(label: string, promise: Promise<T>\): Promise<T \| null>/);
  assert.match(shell, /const operationalFailure = loadOperational && inventoryOperationalDetailsFailed\(\[occ, avg\]\)/);
  assert.match(shell, /const secondaryFailure = loadSecondary\s+&& inventoryOperationalDetailsFailed\(\[ct, deliveryRows, lossRows, cats\]\)/);
  assert.doesNotMatch(shell, /financialResults/);
  assert.match(shell, /if \(itemsLoadError\) \{/);
  assert.doesNotMatch(shell, /if \(itemsLoadError \|\| bundleLoadError\)/);
  assert.match(shell, /\{bundleLoadError && \(/);
  assert.match(shell, /if \(d\.spend != null && d\.financialEvidenceAttempted\) \{\s*setSpendDetail\(d\.spend\);\s*setSpendDataAvailable\(true\)/);
});

test('initial loads and refreshes expose partial failure without cross-hotel repainting', () => {
  assert.match(
    shell,
    /setBundleLoadError\(d\.secondaryFailure\)/,
  );
  assert.match(shell, /const requestedPropertyId = activePropertyId/);
  assert.match(
    shell,
    /activePropertyIdRef\.current !== requestedPropertyId[\s\S]*?inventoryBoardRequestIsCurrent\(data\.requestScope, boardRequestScopeRef\.current\)/,
  );
  assert.match(shell, /setBundleLoadError\(data\.secondaryFailure\)/);
  assert.match(shell, /fetchBoardData\(uid, activePropertyId, 'operational'\)/);
  assert.match(shell, /fetchBoardData\(uid, activePropertyId, 'secondary'\)/);
  assert.match(shell, /fetchBoardData\(uid, requestedPropertyId, 'all'\)/);
});

test('the board bundle has a firm terminal deadline and no cosmetic reveal failsafe', () => {
  assert.match(shell, /const INVENTORY_BOARD_LOAD_TIMEOUT_MS = 12_000/);
  assert.equal(
    (shell.match(/withPromiseDeadline\(fetchBoardData\(/g) ?? []).length,
    3,
    'projections, secondary details, and manual refresh must share the board deadline',
  );
  assert.match(shell, /label: 'Inventory projections'/);
  assert.match(shell, /label: 'Inventory secondary details'/);
  assert.match(shell, /label: 'Inventory details'/);
  assert.doesNotMatch(shell, /setTimeout\(\(\) => setRevealed\(true\), 3500\)/);
  assert.match(
    shell,
    /const dataReady = inventoryDataMatchesViewer && itemsLoaded;[\s\S]*?if \(dataReady\) setRevealed\(true\)/,
  );
  assert.match(
    shell,
    /if \(!inventoryDataMatchesViewer \|\| !revealed\)/,
  );
  assert.doesNotMatch(
    shell,
    /bundleLoaded/,
  );
});
