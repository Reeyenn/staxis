import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { inventoryOverlayAfterCountSave } from '@/app/inventory/_components/inventory-count-navigation';
import { missingPriceItemNames } from '@/app/inventory/_components/inventory-value';
import type { DisplayItem } from '@/app/inventory/_components/types';

function source(...parts: string[]) {
  return readFileSync(join(process.cwd(), 'src', ...parts), 'utf8');
}

describe('inventory manager workflow regressions', () => {
  test('normal counts return to inventory and month-close counts return to the close checklist', () => {
    assert.equal(inventoryOverlayAfterCountSave(false), null);
    assert.equal(inventoryOverlayAfterCountSave(true), 'close');

    const shell = source('app', 'inventory', '_components', 'InventoryShell.tsx');
    assert.match(shell, /inventoryOverlayAfterCountSave\(countForMonthClose\)/);
    assert.doesNotMatch(shell, /onSaved=\{\(\) => \{[\s\S]*?setOverlay\('close'\)/);
  });

  test('month close requires a bilingual final review before the existing safe submit', () => {
    const panel = source('app', 'inventory', '_components', 'overlays', 'MonthClosePanel.tsx');
    assert.match(panel, /confirmTitle: \(month: string\) => `Close \$\{month\}\?`/);
    assert.match(panel, /confirmTitle: \(month: string\) => `¿Cerrar \$\{month\}\?`/);
    assert.match(panel, /if \(action === 'close' && !confirmingClose\)/);
    assert.match(panel, /ref=\{cancelConfirmationRef\}[\s\S]*?aria-describedby=\{`\$\{formId\}-confirm-title \$\{formId\}-confirm-copy`\}/);
    assert.match(panel, /if \(!confirmingClose\) return;[\s\S]*?cancelConfirmationRef\.current\?\.focus/);
    assert.match(panel, /copy\.confirmMonth[\s\S]*?sourceLabel\(purchaseSource, copy\)[\s\S]*?<Equation/);
    assert.match(panel, /copy\.confirmAction\(title\)/);
    assert.match(panel, /\.mc-spinner \{ animation: none; \}/);
  });

  test('mobile inventory exposes search, overflow controls, and per-item save locks', () => {
    const mobile = source('app', 'inventory', '_components', 'MobileInventoryTriage.tsx');
    const css = source('app', 'inventory', '_components', 'MobileInventoryTriage.module.css');
    const shell = source('app', 'inventory', '_components', 'InventoryShell.tsx');

    assert.match(mobile, /type="search"[\s\S]*?aria-label=\{tx\.searchInventory\}/);
    assert.match(mobile, /aria-label=\{tx\.clearSearch\}/);
    assert.match(mobile, /aria-label=\{tx\.previousActions\}/);
    assert.match(mobile, /aria-label=\{tx\.moreActions\}/);
    assert.match(mobile, /aria-busy=\{quickCountLocked\}/);
    assert.match(mobile, /disabled=\{quickCountLocked \|\| onHand === 0\}/);
    assert.match(mobile, /disabled=\{quickCountLocked\}/);
    assert.match(shell, /<MobileInventoryTriage[\s\S]*?query=\{query\}[\s\S]*?quickCountLockedIds=\{quickCountLockedIds\}/);
    assert.match(css, /\.searchWrap\s*\{[\s\S]*?height:\s*48px/);
    assert.match(css, /\.railScrollButton\s*\{[\s\S]*?width:\s*44px;[\s\S]*?height:\s*44px/);
    assert.match(css, /\.quickSaving > span\s*\{[\s\S]*?animation:\s*mobileInventorySpin/);
  });

  test('shelf totals use a small missing-price alert instead of a greater-than symbol', () => {
    const shell = source('app', 'inventory', '_components', 'InventoryShell.tsx');
    const mobile = source('app', 'inventory', '_components', 'MobileInventoryTriage.tsx');
    const warning = source('app', 'inventory', '_components', 'ShelfValueWarning.tsx');
    const warningCss = source('app', 'inventory', '_components', 'ShelfValueWarning.module.css');
    const strings = source('app', 'inventory', '_components', 'inv-i18n.ts');

    assert.doesNotMatch(shell, /aria-hidden>≥/);
    assert.doesNotMatch(mobile, /activeTabValueComplete \? '' : '≥ '/);
    assert.doesNotMatch(mobile, /shelfValueComplete \? '' : '≥ '/);
    assert.equal((shell.match(/<ShelfValueWarning/g) ?? []).length, 2);
    assert.equal((mobile.match(/warning=\{/g) ?? []).length, 2);
    assert.match(warning, /aria-describedby=\{tooltipId\}/);
    assert.match(warning, /role="tooltip"/);
    assert.match(warning, /itemNames\.map/);
    assert.match(warningCss, /\.trigger\s*\{[\s\S]*?width:\s*14px;[\s\S]*?height:\s*14px;/);
    assert.match(strings, /shelfValueWarningIntro: 'This total is incomplete because prices are missing\.'/);
    assert.match(strings, /shelfValueWarningList: 'Missing prices:'/);
    assert.match(strings, /shelfValueWarningResolution: 'Once added, the total will update automatically\.'/);
  });

  test('lists only stocked items whose prices are missing', () => {
    const items = [
      { id: 'towels', name: 'Bath Towels', counted: 12, raw: { unitCost: null } },
      { id: 'soap', name: 'Soap', counted: 4, raw: { unitCost: 1.25 } },
      { id: 'pillows', name: 'Pillows', counted: 0, raw: { unitCost: null } },
      { id: 'sheets', name: 'Sheets', counted: 8, raw: { unitCost: null } },
    ] as unknown as DisplayItem[];

    assert.deepEqual(missingPriceItemNames(items), ['Bath Towels', 'Sheets']);
  });

  test('Ask Staxis docks in the inventory header instead of covering count controls', () => {
    const ask = source('components', 'agent', 'AskStaxisBar.tsx');
    assert.match(ask, /onInventory \? ' asx-mobile-fab-inventory' : ''/);
    assert.match(ask, /\.asx-mobile-fab\.asx-mobile-fab-inventory\{top:[^;]+;right:68px;bottom:auto;/);
    assert.match(ask, /width:44px;height:44px/);
    assert.match(ask, /\.asx-mobile-sheet-inventory \.asx-mobile-composer\{padding-right:12px;\}/);
  });
});
