import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import {
  authorizedCompanySelection,
  companyBootstrapPath,
} from '@/app/property-selector/company-selection';
import { propertySelectorRateLimitKey } from '@/lib/company/property-selector-rate-limit';

const ORG_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const ORG_B = 'bbbbbbbb-0000-4000-8000-000000000002';

describe('property selector company boundary', () => {
  test('only ids from the latest authoritative catalog become request sources', () => {
    const companies = [{ organizationId: ORG_A }, { organizationId: ORG_B }];
    assert.equal(authorizedCompanySelection(companies, ORG_B), ORG_B);
    assert.equal(
      authorizedCompanySelection(companies, 'cccccccc-0000-4000-8000-000000000003'),
      null,
    );
    assert.equal(authorizedCompanySelection([], ORG_A), null);
  });

  test('the organization id is an explicit, encoded bootstrap resource identity', () => {
    assert.equal(companyBootstrapPath(null), '/api/property-selector/bootstrap');
    assert.equal(
      companyBootstrapPath(ORG_A),
      `/api/property-selector/bootstrap?organizationId=${ORG_A}`,
    );
    assert.equal(
      companyBootstrapPath('company/a?b'),
      '/api/property-selector/bootstrap?organizationId=company%2Fa%3Fb',
    );
  });

  test('the page consumes the catalog, changes source identity, and keys chat by company', () => {
    const page = readFileSync(
      join(process.cwd(), 'src/app/property-selector/page.tsx'),
      'utf8',
    );
    const commandCenter = readFileSync(
      join(process.cwd(), 'src/app/property-selector/CommandCenter.tsx'),
      'utf8',
    );

    assert.match(page, /companyBootstrapPath\(selectedOrganizationId\)/);
    assert.match(page, /authorizedCompanySelection\(data\?\.companies \?\? \[\], organizationId\)/);
    assert.match(page, /data\.company\?\.organizationId !== selectedOrganizationId/);
    assert.match(page, /key=\{data\.company\?\.organizationId \?\? 'company-choice'\}/);
    assert.match(commandCenter, /requiresCompanySelection/);
    assert.match(commandCenter, /<select[\s\S]*?value=\{selectedOrganizationId \?\? ''\}/);
    assert.match(commandCenter, /<AskAcrossHotels[\s\S]*?key=\{company\.organizationId\}/);
  });

  test('catalog fan-out and 50 company choices share one pre-catalog account budget', () => {
    const portfolio = readFileSync(
      join(process.cwd(), 'src/lib/company/portfolio.ts'),
      'utf8',
    );
    const bootstrap = readFileSync(
      join(process.cwd(), 'src/app/api/property-selector/bootstrap/route.ts'),
      'utf8',
    );

    assert.match(portfolio, /MAX_PORTFOLIO_COMPANIES_PER_ACCOUNT = 50/);
    assert.match(
      portfolio,
      /candidateOrganizationIds\.length > MAX_PORTFOLIO_COMPANIES_PER_ACCOUNT/,
    );
    const choices = Array.from({ length: 50 }, (_, index) => ({
      organizationId: `f1000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    }));
    assert.equal(
      new Set(choices.map(() => propertySelectorRateLimitKey(ORG_A))).size,
      1,
      'company choices rotated the account limiter identity',
    );
    const limiter = bootstrap.indexOf("checkAndIncrementRateLimit(\n      'property-selector'");
    const catalog = bootstrap.indexOf('listPortfolioCompaniesUncached(account.accountId)');
    assert.ok(limiter >= 0 && catalog >= 0 && limiter < catalog, 'catalog fan-out ran before the limiter');
    assert.doesNotMatch(bootstrap, /propertyIds\?\.\[0\].*access\.propertyIds\[0\]/);
  });
});
