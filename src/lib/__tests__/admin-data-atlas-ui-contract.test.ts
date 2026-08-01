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
    assert.match(page, /Read-only controls · this page cannot edit hotel data/);
    assert.match(page, /A simple, read-only window into what Staxis stores/);
    assert.doesNotMatch(page, /\.(insert|update|upsert|delete)\s*\(/);
  });

  test('loads authenticated live data without caching and refreshes every minute', () => {
    assert.match(page, /fetchWithAuth\('\/api\/admin\/data-atlas',[\s\S]*cache:\s*'no-store'/);
    assert.match(page, /fetchWithAuth\('\/api\/admin\/system-status',[\s\S]*cache:\s*'no-store'/);
    assert.match(page, /const AUTO_REFRESH_MS = 60_000/);
    assert.match(page, /window\.setInterval/);
    assert.match(page, /Refresh now/);
  });

  test('renders honest loading, error, retry, stale-snapshot, and empty states', () => {
    assert.match(page, /Reading the live Staxis backend/);
    assert.match(page, /The Atlas could not load/);
    assert.match(page, /Try again/);
    assert.match(page, /The latest refresh failed\. The page is still showing the last successful snapshot/);
    assert.match(page, /No hotels have been added yet/);
    assert.match(page, /Database unavailable/);
    assert.match(page, /Showing last snapshot/);
    assert.doesNotMatch(page, /status="healthy" label="Live database"/);
  });

  test('explains backend details in founder language and keeps table names collapsed', () => {
    assert.match(page, /The filing cabinets/);
    assert.match(page, /Data guard on/);
    assert.match(page, /Tables with rules/);
    assert.match(page, /Recognized tenant key/);
    assert.match(page, /<details className=\{styles\.tableDetails\}>/);
    assert.match(page, /Show technical table names/);
    assert.match(page, /receipt book/);
  });
});

describe('Database Atlas responsive and motion contract', () => {
  test('supports keyboard focus, mobile layouts, and reduced motion', () => {
    assert.match(css, /:focus-visible/);
    assert.match(css, /@media \(max-width: 760px\)/);
    assert.match(css, /@media \(max-width: 520px\)/);
    assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
    assert.match(css, /min-height:\s*44px/);
  });
});
