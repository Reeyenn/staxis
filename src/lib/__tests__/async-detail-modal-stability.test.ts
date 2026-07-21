import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

function source(...parts: string[]): string {
  return readFileSync(join(process.cwd(), ...parts), 'utf8');
}

const equipment = source(
  'src', 'app', 'maintenance', '_components', 'EquipmentRegistry.tsx',
);
const capexDetail = source(
  'src', 'app', 'financials', '_components', 'CapexDetailModal.tsx',
);
const capexTab = source(
  'src', 'app', 'financials', '_components', 'CapexTab.tsx',
);

describe('async detail modal layout stability', () => {
  test('equipment detail reserves final geometry and scopes last-good data', () => {
    assert.match(equipment, /className="equipment-detail-viewport" aria-busy=\{loading \|\| undefined\}/);
    assert.match(equipment, /role="status" aria-live="polite"/);
    assert.match(equipment, /className="equipment-detail-skeleton" aria-hidden="true"/);
    assert.match(equipment, /\.equipment-detail-viewport \{[\s\S]*?height: clamp\(340px, calc\(100dvh - 300px\), 560px\);[\s\S]*?overflow-y: auto;/);
    assert.match(equipment, /@media \(max-width: 640px\)[\s\S]*?\.equipment-detail-viewport \{ height: clamp\(300px, calc\(100dvh - 260px\), 520px\); \}/);
    assert.match(equipment, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?animation: none;/);

    assert.match(equipment, /const scope = `\$\{pid\}:\$\{id\}`;/);
    assert.match(equipment, /sequence !== detailRequestSequence\.current \|\| detailScopeRef\.current !== scope/);
    assert.match(equipment, /detailCacheScope === activeDetailScope \? detail : null/);
  });

  test('CapEx detail uses the same scrollable viewport for loading and loaded binders', () => {
    const emptyBranch = capexDetail.slice(
      capexDetail.indexOf('if (!project)'),
      capexDetail.indexOf('const spent = project.spentCents'),
    );

    assert.match(emptyBranch, /footer=\{<Btn variant="ghost" onClick=\{onClose\}>/);
    assert.match(emptyBranch, /<CapexDetailViewport busy=\{!loadError\}>/);
    assert.match(capexDetail, /<CapexDetailViewport busy=\{refreshing\}>/);
    assert.match(capexDetail, /role="status" aria-live="polite"/);
    assert.match(capexDetail, /className="capex-detail-skeleton" aria-hidden="true"/);
    assert.match(capexDetail, /\.capex-detail-viewport \{[\s\S]*?height: clamp\(340px, calc\(100dvh - 300px\), 560px\);[\s\S]*?overflow-y: auto;/);
    assert.match(capexDetail, /@media \(max-width: 640px\)[\s\S]*?\.capex-detail-viewport \{ height: clamp\(300px, calc\(100dvh - 260px\), 520px\); \}/);
    assert.match(capexDetail, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?animation: none;/);
  });

  test('CapEx keeps cached detail only for the exact property and project', () => {
    assert.match(capexTab, /useState<\{ propertyId: string; id: string; project: CapexProject \} \| null>/);
    assert.match(capexTab, /detailRes\.data\?\.project\?\.propertyId === pid[\s\S]*?detailRes\.data\.project\.id === openId/);
    assert.match(capexTab, /setDetailCache\(\{ propertyId: pid, id: openId, project: freshDetail \}\)/);
    assert.match(capexTab, /detailCache\?\.propertyId === pid && detailCache\.id === openId/);
    assert.match(capexTab, /refreshing=\{detailRes\.loading\}/);
  });
});
