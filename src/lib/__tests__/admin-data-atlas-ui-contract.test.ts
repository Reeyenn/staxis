import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (...parts: string[]): string => readFileSync(join(process.cwd(), ...parts), 'utf8');

const liveSurface = read(
  'src', 'app', 'admin', '_components', 'studio', 'surfaces', 'LiveSurface.tsx',
);
const link = read('src', 'app', 'admin', '_components', 'DataAtlasLink.tsx');
const page = read('src', 'app', 'admin', 'data-atlas', 'page.tsx');
const css = read('src', 'app', 'admin', 'data-atlas', 'DataAtlas.module.css');

describe('Database Atlas entry point', () => {
  test('sits beside the existing Hotels administration tools', () => {
    assert.match(liveSurface, /<AccessPopover\s*\/>[\s\S]*<DataAtlasLink\s*\/>[\s\S]*<AIControlCenter\s*\/>[\s\S]*<TwoFactorSwitch\s*\/>/);
    assert.match(link, /href="\/admin\/data-atlas"/);
    assert.match(link, /aria-label="Open Database Atlas"/);
    assert.match(link, /<span[^>]*>Database Atlas<\/span>/);
  });

  test('keeps the existing 44px action-button and keyboard-focus contract', () => {
    const triggerCss = read('src', 'app', 'admin', '_components', 'AIControlCenter.module.css');
    assert.match(triggerCss, /\.trigger\s*\{[\s\S]*min-height:\s*44px/);
    assert.match(triggerCss, /\.trigger:focus-visible/);
    assert.match(triggerCss, /text-decoration:\s*none/);
  });
});
describe('Database Atlas page states', () => {
  test('is one read-only page with a clear way back to Hotels', () => {
    assert.match(page, /href="\/admin\/properties#live"/);
    assert.match(page, /<h1 id="atlas-title">Database Atlas<\/h1>/);
    assert.doesNotMatch(page, /\.(insert|update|upsert|delete)\s*\(/);
  });

  test('loads authenticated live data without caching and refreshes every minute', () => {
    assert.match(page, /fetchWithAuth\('\/api\/admin\/data-atlas',[\s\S]*cache:\s*'no-store'/);
    assert.match(page, /fetchWithAuth\('\/api\/admin\/system-status',[\s\S]*cache:\s*'no-store'/);
    assert.match(page, /const AUTO_REFRESH_MS = 60_000/);
    assert.match(page, /window\.setInterval/);
    assert.match(page, /\? 'Refreshing' : 'Refresh'/);
  });

  test('renders honest loading, error, retry, stale-snapshot, and empty states', () => {
    assert.match(page, /Loading Database Atlas/);
    assert.match(page, /Database Atlas could not load/);
    assert.match(page, /Try again/);
    assert.match(page, /Showing the last update\. Refresh failed/);
    assert.match(page, /No hotels have been added yet/);
    assert.match(page, /Database details are unavailable/);
    assert.match(page, /snapshot \? 'Stale' : 'Unavailable'/);
    assert.match(page, /accessDenied[\s\S]*\? 'Admin only'/);
    assert.match(page, /snapshot\.schema\.status === 'unavailable'[\s\S]*\? 'Unavailable'/);
  });

  test('keeps the live view simple and hides technical table names behind disclosures', () => {
    assert.match(page, /<dt>Hotels<\/dt>/);
    assert.match(page, /<dt>Rooms<\/dt>/);
    assert.match(page, /<dt>Staff<\/dt>/);
    assert.match(page, /placeholder="Search hotels"/);
    assert.match(page, /<th scope="col">Hotel<\/th>[\s\S]*<th scope="col">Rooms<\/th>[\s\S]*<th scope="col">Staff<\/th>[\s\S]*<th scope="col">Setup<\/th>[\s\S]*<th scope="col">Data<\/th>/);
    assert.match(page, /<h2>Systems<\/h2>/);
    assert.match(page, /<span>Database details<\/span>/);
    assert.match(page, /<details className=\{styles\.areaDetails\}/);

    [
      'Admin · Live backend view',
      'A simple, read-only window',
      'Read-only controls',
      'Right now',
      'Staxis at a glance',
      'Live hotel catalog',
      'The filing cabinets',
      'The machinery',
      'Data guard on',
      'Tables with rules',
      'Recognized tenant key',
      'receipt book',
      'Latest version',
      'app areas on',
    ].forEach((removedCopy) => assert.doesNotMatch(page, new RegExp(removedCopy)));
  });
});

describe('Database Atlas responsive and motion contract', () => {
  test('supports keyboard focus, mobile layouts, and reduced motion', () => {
    assert.match(css, /:focus-visible/);
    assert.match(css, /@media \(max-width: 760px\)/);
    assert.match(css, /@media \(max-width: 520px\)/);
    assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
    assert.match(css, /min-height:\s*44px/);
    assert.match(css, /\.hotelLink\s*\{[\s\S]*?min-height:\s*44px/);
    assert.match(css, /@media \(max-width: 760px\)[\s\S]*?\.searchField input\s*\{\s*font-size:\s*16px/);
    assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.spinning\s*\{\s*animation:\s*none/);
  });
});
