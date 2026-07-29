import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import {
  shouldLoadPortfolioBootstrap,
  shouldWaitForPortfolioEntry,
} from '@/lib/portfolio-ui/entry-routing';

const HOTEL_ONLY_STANDING = { portfolioIntelligenceRead: false } as const;
const PORTFOLIO_STANDING = { portfolioIntelligenceRead: true } as const;

function source(...parts: string[]): string {
  return readFileSync(join(process.cwd(), ...parts), 'utf8');
}

function homeDecision(overrides: Partial<Parameters<typeof shouldLoadPortfolioBootstrap>[0]> = {}) {
  return shouldLoadPortfolioBootstrap({
    signedIn: true,
    authLoading: false,
    browserRoleIsAdmin: false,
    authorizationChecked: true,
    platformAdmin: false,
    propertyStandings: [HOTEL_ONLY_STANDING],
    explicitPortfolioContext: false,
    entryRoute: true,
    ...overrides,
  });
}

describe('portfolio bootstrap entry routing', () => {
  test('platform Admin never loads or waits for portfolio bootstrap on Home', () => {
    assert.equal(homeDecision({ browserRoleIsAdmin: true, platformAdmin: true }), false);
    assert.equal(homeDecision({ browserRoleIsAdmin: false, platformAdmin: true }), false);
    assert.equal(shouldWaitForPortfolioEntry({
      hotelDrilldown: false,
      portfolioLoading: false,
    }), false);
  });

  test('single-hotel and ordinary hotel roles neither load nor wait for portfolio bootstrap', () => {
    for (const role of ['general manager', 'front desk', 'housekeeping', 'maintenance', 'staff']) {
      assert.equal(
        homeDecision({ propertyStandings: [HOTEL_ONLY_STANDING] }),
        false,
        role,
      );
    }
    assert.equal(shouldWaitForPortfolioEntry({
      hotelDrilldown: false,
      portfolioLoading: false,
    }), false);
  });

  test('fresh company and regional portfolio standing enables bootstrap and its terminal wait', () => {
    for (const actor of ['company owner', 'company VP', 'regional portfolio actor']) {
      assert.equal(
        homeDecision({ propertyStandings: [PORTFOLIO_STANDING] }),
        true,
        actor,
      );
    }
    assert.equal(shouldWaitForPortfolioEntry({
      hotelDrilldown: false,
      portfolioLoading: true,
    }), true);
  });

  test('entry routes do not infer portfolio access before the authoritative check', () => {
    assert.equal(homeDecision({
      authorizationChecked: false,
      propertyStandings: [PORTFOLIO_STANDING],
    }), false);
  });

  test('a failed bootstrap stops only an eligible actor wait', () => {
    assert.equal(homeDecision({ propertyStandings: [PORTFOLIO_STANDING] }), true);
    assert.equal(shouldWaitForPortfolioEntry({
      hotelDrilldown: false,
      portfolioLoading: false,
    }), false);
    assert.equal(homeDecision({ propertyStandings: [HOTEL_ONLY_STANDING] }), false);
  });

  test('multi-hat actors retain explicit hotel and portfolio acting-context rules', () => {
    assert.equal(homeDecision({
      propertyStandings: [HOTEL_ONLY_STANDING, PORTFOLIO_STANDING],
      entryRoute: false,
    }), false, 'explicit hotel drill-down bypasses portfolio bootstrap');
    assert.equal(shouldWaitForPortfolioEntry({
      hotelDrilldown: true,
      portfolioLoading: true,
    }), false);
    assert.equal(homeDecision({
      propertyStandings: [HOTEL_ONLY_STANDING, PORTFOLIO_STANDING],
      entryRoute: false,
      explicitPortfolioContext: true,
    }), true, 'explicit portfolio context still reaches its server gate');
  });

  test('provider and Home wire the decisions directly to the request and wait boundaries', () => {
    const provider = source('src', 'contexts', 'PortfolioContext.tsx');
    const home = source('src', 'app', 'home', 'page.tsx');
    assert.match(provider, /const enabled = shouldLoadPortfolioBootstrap\(\{/);
    assert.match(provider, /useApiResource<PortfolioUiBootstrapV1>[\s\S]{0,300}?enabled: enabled && !malformedSelection/);
    assert.match(home, /portfolioEntryPending = shouldWaitForPortfolioEntry\(\{[\s\S]{0,120}?portfolioLoading: portfolio\.loading/);
    assert.doesNotMatch(home, /!portfolio\.data && Boolean\(user\)/);
  });
});
