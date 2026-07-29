import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8');
}

describe('portfolio access outage contract', () => {
  test('bootstrap distinguishes an unavailable authority store from no company access', () => {
    const route = source('src/app/api/portfolio/v1/bootstrap/route.ts');
    assert.match(route, /listPortfolioCompaniesUncached\(account\.accountId\)/);
    assert.match(route, /status:\s*503[\s\S]*code:\s*'access_unavailable'/);
    assert.match(route, /Company access was not found[\s\S]*status:\s*404/);
    assert.match(route, /assertAuthorizationScopeReceipt/);
  });

  test('section and hotel context reassert the exact receipt before egress', () => {
    for (const path of [
      'src/app/api/portfolio/v1/section/route.ts',
      'src/app/api/portfolio/v1/hotel-context/route.ts',
    ]) {
      const route = source(path);
      assert.match(route, /resolveManagementCompanyScopeUncached/);
      assert.match(route, /assertAuthorizationScopeReceipt/);
      assert.match(route, /status:\s*409[\s\S]*code:\s*'scope_changed'/);
      assert.match(route, /Cache-Control': 'private, no-store/);
    }
  });

  test('portfolio and region pages keep PropertyContext fully quiescent', () => {
    const context = source('src/contexts/PropertyContext.tsx');
    assert.match(context, /portfolioScopeQuiescent/);
    assert.match(
      context,
      /authFlowActive \|\| portfolioScopeQuiescent[\s\S]*setProperties\(\[\]\)/,
    );
    assert.match(context, /loadActingHotelId[\s\S]*getProperty\(loadUserUid, loadActingHotelId\)/);
  });
});
