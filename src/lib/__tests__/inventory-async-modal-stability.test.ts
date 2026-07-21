import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

function source(...parts: string[]): string {
  return readFileSync(join(process.cwd(), ...parts), 'utf8');
}

test('Inventory AI Helper opens at its final size and caches only the active property', () => {
  const panel = source(
    'src', 'app', 'inventory', '_components', 'overlays', 'AiReportSheet.tsx',
  );
  const css = source(
    'src', 'app', 'inventory', '_components', 'overlays', 'AiReportSheet.module.css',
  );
  const loadingState = panel.slice(
    panel.indexOf('function AiReportLoadingState'),
    panel.indexOf('// ═══════════════════════════ TRACKER'),
  );

  assert.match(panel, /propertyReport\?\.propertyId === activePropertyId/);
  assert.match(panel, /failedPropertyId === activePropertyId/);
  assert.match(panel, /setPropertyReport\(\{ propertyId, data: json\.data \}\)/);
  assert.doesNotMatch(panel, /setData\(null\)/);
  assert.match(panel, /const showInitialLoading = !summary && !loadFailed;/);
  assert.match(panel, /className=\{styles\.reportContent\}[\s\S]*?aria-busy=/);
  assert.match(loadingState, /role="status" aria-live="polite"/);
  assert.match(loadingState, /className=\{styles\.loadingVisual\} aria-hidden="true"/);
  assert.match(loadingState, /styles\.loadingHero/);
  assert.match(loadingState, /styles\.loadingTiles/);
  assert.match(css, /\.reportContent\s*\{[\s\S]*?min-height:\s*min\(700px, calc\(90vh - 120px\)\)/);
  assert.match(css, /@media \(max-width: 760px\)[\s\S]*?\.reportContent\s*\{[\s\S]*?min-height:\s*0/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.skeleton::after\s*\{[\s\S]*?animation:\s*none/);
});

test('Inventory Month Close keeps loading and error states inside stable final geometry', () => {
  const panel = source(
    'src', 'app', 'inventory', '_components', 'overlays', 'MonthClosePanel.tsx',
  );
  const loadingState = panel.slice(
    panel.indexOf('function LoadingState'),
    panel.indexOf('export function MonthClosePanel'),
  );

  assert.match(panel, /propertyDashboard\?\.propertyId === activePropertyId/);
  assert.match(panel, /failedPropertyId === activePropertyId/);
  assert.match(panel, /const showInitialLoading = Boolean\(activePropertyId\) && !dashboard && !loadError;/);
  assert.match(panel, /aria-busy=\{loading \|\| showInitialLoading\}/);
  assert.match(panel, /loading \|\| showInitialLoading \? \(/);
  assert.match(loadingState, /role="status" aria-live="polite"/);
  assert.match(loadingState, /className="mc-loading-visual" aria-hidden="true"/);
  assert.match(loadingState, /mc-loading-equation/);
  assert.match(loadingState, /mc-loading-readiness/);
  assert.match(panel, /\.mc-root \{[\s\S]*?min-height: min\(700px, calc\(90vh - 120px\)\)/);
  assert.match(panel, /@media \(max-width: 760px\) \{[\s\S]*?\.mc-root \{ min-height: 0; \}/);
  assert.match(panel, /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.mc-skeleton::after \{ animation: none; \}/);
  assert.match(panel, /loadError \|\| !dashboard \? \([\s\S]*?className="mc-state-panel"/);
});
