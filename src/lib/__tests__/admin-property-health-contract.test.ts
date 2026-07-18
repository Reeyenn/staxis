/**
 * Regression guards for the admin property-health route.
 *
 * The route was rebuilt after the legacy pms_recipes table was removed, but
 * the rebuild also (incorrectly) treated scraper_credentials as deleted. That
 * made every hotel display "No credentials saved" and hid the recipe repair
 * action. These source guards pin the current schema contract without requiring
 * a live Supabase project in the unit suite.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const routeSource = readFileSync(
  join(process.cwd(), 'src', 'app', 'api', 'admin', 'property-health', 'route.ts'),
  'utf8',
);

const pageSource = readFileSync(
  join(process.cwd(), 'src', 'app', 'admin', 'properties', '[id]', 'page.tsx'),
  'utf8',
);

describe('admin property-health credential contract', () => {
  test('reads live credential metadata and returns the mapped summary', () => {
    assert.match(routeSource, /\.from\(['"]scraper_credentials['"]\)/);
    assert.match(routeSource, /credentials,\s*activeRecipe/);
    assert.doesNotMatch(routeSource, /credentials:\s*null/);
  });

  test('never selects encrypted or plaintext PMS secrets', () => {
    const credentialSelect = routeSource.match(
      /\.from\(['"]scraper_credentials['"]\)[\s\S]*?\.select\(([^\n]+)\)/,
    )?.[1] ?? '';
    assert.ok(credentialSelect, 'expected a scraper_credentials select');
    assert.doesNotMatch(credentialSelect, /username|password|encrypted/i);
  });

  test('only offers regeneration for active credentials', () => {
    assert.match(pageSource, /data\.credentials\?\.isActive/);
  });

  test('reads the active recipe from the current knowledge-file table', () => {
    assert.match(routeSource, /\.from\(['"]pms_knowledge_files['"]\)/);
    assert.doesNotMatch(routeSource, /\.from\(['"]pms_recipes['"]\)/);
  });
});
