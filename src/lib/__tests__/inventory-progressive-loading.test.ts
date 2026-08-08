import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import {
  inventoryBoardRequestIsCurrent,
  type InventoryFinancialRequestScope,
} from '@/app/inventory/_components/inventory-financial-evidence';

const shell = readFileSync(join(process.cwd(), 'src/app/inventory/_components/InventoryShell.tsx'), 'utf8');
const mobile = readFileSync(join(process.cwd(), 'src/app/inventory/_components/MobileInventoryTriage.tsx'), 'utf8');
const sidebar = readFileSync(join(process.cwd(), 'src/app/inventory/_components/Sidebar.tsx'), 'utf8');

test('inventory reveals the item snapshot before secondary phases', () => {
  assert.match(shell, /const dataReady = inventoryDataMatchesViewer && itemsLoaded;/);
  assert.match(shell, /fetchBoardData\(uid, activePropertyId, 'operational', capabilityViewerKey\)/);
  assert.match(shell, /fetchBoardData\(uid, activePropertyId, 'secondary', capabilityViewerKey\)/);
  assert.match(shell, /fetchBoardData\(uid, requestedPropertyId, 'all', requestedViewerKey\)/);
  assert.match(shell, /viewerKey,\n\s+financialsEnabled/);
  assert.doesNotMatch(shell, /viewerKey: `\$\{uid\}:\$\{pid\}`/);
  assert.match(shell, /setProjectionLoadState\('loading'\)/);
  assert.match(shell, /setSecondaryLoadState\('loading'\)/);
  assert.match(shell, /const \[financialLoadState, setFinancialLoadState\] = useState<InventoryLoadState>/);
  assert.match(shell, /financialLoadState === 'error'/);
  assert.match(shell, /secondaryLoadState === 'ready' \? historyEvents\.length : null/);
});

test('inventory secondary data cannot masquerade as loaded zero values', () => {
  assert.match(shell, /const shelfValueAvailable = !financialSurfaceEnabled \|\| financialEvidenceReady;/);
  assert.match(shell, /shelfValueAvailable\s*\? <CountUp value=\{tabStat\.value\}/);
  assert.match(shell, /aria-label="Shelf value unavailable"/);
  assert.match(mobile, /shelfValueAvailable: boolean/);
  assert.match(mobile, /shelfValueAvailable\s*\? fmtMoney/);
  assert.match(sidebar, /historyCount: number \| null/);
  assert.match(sidebar, /badge=\{historyCount \?\? undefined\}/);
});

test('invalid finance timezone strips stale money and gates finance surfaces', () => {
  assert.match(shell, /const financialSurfaceEnabled = canViewFinancials && financialTimezoneValid;/);
  assert.match(shell, /setFinancialEvidenceReady\(!financialSurfaceEnabled\)/);
  assert.match(shell, /setFinancialLoadState\(\s*financialSurfaceEnabled \? 'idle' : canViewFinancials \? 'error' : 'ready'/);
  assert.match(shell, /if \(!financialSurfaceEnabled\)/);
  assert.match(shell, /setItems\(\(current\) => hydrateInventoryItems\(current, EMPTY_INVENTORY_FINANCIAL_EVIDENCE\.inventory\)\)/);
  assert.match(shell, /setBudgets\(\[\]\)/);
  assert.match(shell, /setBudgetSections\(\[\]\)/);
  assert.match(shell, /setSpendDataAvailable\(false\)/);
  assert.match(shell, /setMonthCloseDashboard\(null\)/);
  assert.match(shell, /open=\{overlay === 'reports' && financialSurfaceEnabled\}/);
  assert.match(shell, /open=\{overlay === 'budgets' && financialSurfaceEnabled\}/);
  assert.match(shell, /canViewFinancials=\{financialSurfaceEnabled\}/);
});

test('inventory phase responses are scoped to the current request and property', () => {
  assert.match(shell, /sequence !== projectionLoadSequence\.current/);
  assert.match(shell, /sequence !== secondaryLoadSequence\.current/);
  assert.match(shell, /inventoryBoardRequestIsCurrent\(d\.requestScope, boardRequestScopeRef\.current\)/);
  assert.match(shell, /refreshSequence !== refreshLoadSequence\.current/);
  assert.match(shell, /activePropertyIdRef\.current !== requestedPropertyId/);
});

test('inventory board scopes accept the full current viewer and reject account, acting, and hotel changes', () => {
  const current: InventoryFinancialRequestScope = {
    propertyId: 'hotel-a',
    viewerKey: 'user-a:account-a:hotel-a:acting-a',
    financialsEnabled: true,
  };
  assert.equal(inventoryBoardRequestIsCurrent(current, current), true);
  assert.equal(inventoryBoardRequestIsCurrent(
    { ...current, viewerKey: 'user-a:account-b:hotel-a:acting-a' }, current,
  ), false);
  assert.equal(inventoryBoardRequestIsCurrent(
    { ...current, viewerKey: 'user-a:account-a:hotel-a:acting-b' }, current,
  ), false);
  assert.equal(inventoryBoardRequestIsCurrent(
    { ...current, propertyId: 'hotel-b', viewerKey: 'user-a:account-a:hotel-b:acting-a' }, current,
  ), false);
});
