import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { inventoryOverlayAfterCountSave } from '@/app/inventory/_components/inventory-count-navigation';

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

  test('Ask Staxis docks in the inventory header instead of covering count controls', () => {
    const ask = source('components', 'agent', 'AskStaxisBar.tsx');
    assert.match(ask, /onInventory \? ' asx-mobile-fab-inventory' : ''/);
    assert.match(ask, /\.asx-mobile-fab\.asx-mobile-fab-inventory\{top:[^;]+;right:68px;bottom:auto;/);
    assert.match(ask, /width:44px;height:44px/);
    assert.match(ask, /\.asx-mobile-sheet-inventory \.asx-mobile-composer\{padding-right:12px;\}/);
  });
});
