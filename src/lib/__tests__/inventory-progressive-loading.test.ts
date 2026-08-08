import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const shell = readFileSync(join(process.cwd(), 'src/app/inventory/_components/InventoryShell.tsx'), 'utf8');
const mobile = readFileSync(join(process.cwd(), 'src/app/inventory/_components/MobileInventoryTriage.tsx'), 'utf8');
const sidebar = readFileSync(join(process.cwd(), 'src/app/inventory/_components/Sidebar.tsx'), 'utf8');

test('inventory reveals the item snapshot before secondary phases', () => {
  assert.match(shell, /const dataReady = inventoryDataMatchesViewer && itemsLoaded;/);
  assert.match(shell, /fetchBoardData\(uid, activePropertyId, 'operational'\)/);
  assert.match(shell, /fetchBoardData\(uid, activePropertyId, 'secondary'\)/);
  assert.match(shell, /setProjectionLoadState\('loading'\)/);
  assert.match(shell, /setSecondaryLoadState\('loading'\)/);
  assert.match(shell, /const \[financialLoadState, setFinancialLoadState\] = useState<InventoryLoadState>/);
  assert.match(shell, /financialLoadState === 'error'/);
  assert.match(shell, /secondaryLoadState === 'ready' \? historyEvents\.length : null/);
});

test('inventory secondary data cannot masquerade as loaded zero values', () => {
  assert.match(shell, /const shelfValueAvailable = !canViewFinancials \|\| financialEvidenceReady;/);
  assert.match(shell, /shelfValueAvailable\s*\? <CountUp value=\{tabStat\.value\}/);
  assert.match(shell, /aria-label="Shelf value unavailable"/);
  assert.match(mobile, /shelfValueAvailable: boolean/);
  assert.match(mobile, /shelfValueAvailable\s*\? fmtMoney/);
  assert.match(sidebar, /historyCount: number \| null/);
  assert.match(sidebar, /badge=\{historyCount \?\? undefined\}/);
});

test('inventory phase responses are scoped to the current request and property', () => {
  assert.match(shell, /sequence !== projectionLoadSequence\.current/);
  assert.match(shell, /sequence !== secondaryLoadSequence\.current/);
  assert.match(shell, /inventoryBoardRequestIsCurrent\(d\.requestScope, boardRequestScopeRef\.current\)/);
  assert.match(shell, /refreshSequence !== refreshLoadSequence\.current/);
  assert.match(shell, /activePropertyIdRef\.current !== requestedPropertyId/);
});
