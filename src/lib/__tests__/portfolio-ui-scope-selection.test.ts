import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  selectAuthoritativePortfolioUiScope,
  type PortfolioUiAuthoritativeScopeInput,
} from '@/lib/portfolio-ui/scope-selection';

const ORG = 'aaaaaaaa-0000-4000-8000-000000000001';
const OTHER_ORG = 'bbbbbbbb-0000-4000-8000-000000000002';
const HOTEL_A = '11111111-0000-4000-8000-000000000001';
const HOTEL_B = '22222222-0000-4000-8000-000000000002';
const HOTEL_C = '33333333-0000-4000-8000-000000000003';
const REGION = 'aaaaaaaa-1111-4000-8000-000000000001';
const PORTFOLIO = 'aaaaaaaa-2222-4000-8000-000000000001';
const SELECTED = 'aaaaaaaa-3333-4000-8000-000000000001';

function authority(
  overrides: Partial<PortfolioUiAuthoritativeScopeInput> = {},
): PortfolioUiAuthoritativeScopeInput {
  return {
    organizationId: ORG,
    organizationName: 'Gulf Coast Hotels',
    propertyIds: [HOTEL_A, HOTEL_B, HOTEL_C],
    descriptors: [
      {
        kind: 'company', id: ORG, name: 'Gulf Coast Hotels',
        propertyIds: [HOTEL_A, HOTEL_B, HOTEL_C],
      },
      { kind: 'region', id: REGION, name: 'North Texas', propertyIds: [HOTEL_A, HOTEL_B] },
      { kind: 'portfolio', id: PORTFOLIO, name: 'Extended stay', propertyIds: [HOTEL_B, HOTEL_C] },
      { kind: 'selected_hotels', id: SELECTED, name: 'Selected hotels (1)', propertyIds: [HOTEL_C] },
    ],
    ...overrides,
  };
}

describe('authoritative portfolio UI scope selection', () => {
  test('company context selects the full receipt without trusting a URL hotel set', () => {
    const result = selectAuthoritativePortfolioUiScope(authority(), {
      scope: 'portfolio', organizationId: ORG,
    });
    assert.deepEqual(result, {
      ok: true,
      scope: {
        organizationId: ORG,
        organizationName: 'Gulf Coast Hotels',
        kind: 'company',
        id: ORG,
        name: 'Gulf Coast Hotels',
        propertyIds: [HOTEL_A, HOTEL_B, HOTEL_C],
        selector: { type: 'all_authorized' },
        requestedHotelId: null,
      },
    });
  });

  test('region and named portfolio contexts use only their native receipt descriptor', () => {
    const region = selectAuthoritativePortfolioUiScope(authority(), {
      scope: 'region', organizationId: ORG, portfolioId: REGION,
    });
    assert.equal(region.ok, true);
    if (!region.ok) return;
    assert.equal(region.scope.kind, 'region');
    assert.deepEqual(region.scope.propertyIds, [HOTEL_A, HOTEL_B]);
    assert.deepEqual(region.scope.selector, { type: 'portfolio', portfolioId: REGION });

    const portfolio = selectAuthoritativePortfolioUiScope(authority(), {
      scope: 'portfolio', organizationId: ORG, portfolioId: PORTFOLIO,
    });
    assert.equal(portfolio.ok, true);
    if (!portfolio.ok) return;
    assert.equal(portfolio.scope.kind, 'portfolio');
    assert.deepEqual(portfolio.scope.propertyIds, [HOTEL_B, HOTEL_C]);
    assert.deepEqual(portfolio.scope.selector, { type: 'portfolio', portfolioId: PORTFOLIO });
  });

  test('selected-hotels uses the current descriptor property set, never URL-carried ids', () => {
    const result = selectAuthoritativePortfolioUiScope(authority(), {
      scope: 'selected_hotels', organizationId: ORG, descriptorId: SELECTED,
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.scope.propertyIds, [HOTEL_C]);
    assert.deepEqual(result.scope.selector, {
      type: 'property_subset', propertyIds: [HOTEL_C],
    });
  });

  test('hotel drill-down remains bound to its current parent descriptor', () => {
    const allowed = selectAuthoritativePortfolioUiScope(authority(), {
      scope: 'hotel', propertyId: HOTEL_A, organizationId: ORG, portfolioId: REGION,
    });
    assert.equal(allowed.ok, true);
    if (!allowed.ok) return;
    assert.equal(allowed.scope.kind, 'region');
    assert.equal(allowed.scope.requestedHotelId, HOTEL_A);

    assert.deepEqual(selectAuthoritativePortfolioUiScope(authority(), {
      scope: 'hotel', propertyId: HOTEL_C, organizationId: ORG, portfolioId: REGION,
    }), { ok: false, reason: 'hotel_not_in_scope' });
  });

  test('foreign, stale, wrong-kind, and duplicate descriptor selectors fail closed', () => {
    assert.deepEqual(selectAuthoritativePortfolioUiScope(authority(), {
      scope: 'portfolio', organizationId: OTHER_ORG,
    }), { ok: false, reason: 'organization_mismatch' });
    assert.deepEqual(selectAuthoritativePortfolioUiScope(authority(), {
      scope: 'region', organizationId: ORG, portfolioId: PORTFOLIO,
    }), { ok: false, reason: 'descriptor_not_found' });
    assert.deepEqual(selectAuthoritativePortfolioUiScope(authority(), {
      scope: 'selected_hotels', organizationId: ORG,
      descriptorId: 'aaaaaaaa-4444-4000-8000-000000000001',
    }), { ok: false, reason: 'descriptor_not_found' });
    assert.deepEqual(selectAuthoritativePortfolioUiScope(authority({
      descriptors: [
        { kind: 'region', id: REGION, name: 'North', propertyIds: [HOTEL_A] },
        { kind: 'region', id: REGION, name: 'Duplicate', propertyIds: [HOTEL_B] },
      ],
    }), {
      scope: 'region', organizationId: ORG, portfolioId: REGION,
    }), { ok: false, reason: 'invalid_authoritative_scope' });
  });

  test('malformed, cross-receipt, empty, and duplicate property sets invalidate the authority input', () => {
    for (const input of [
      authority({ propertyIds: [] }),
      authority({ propertyIds: [HOTEL_A, HOTEL_A] }),
      authority({ descriptors: [
        { kind: 'region', id: REGION, name: 'North', propertyIds: [OTHER_ORG] },
      ] }),
      authority({ descriptors: [
        { kind: 'region', id: REGION, name: 'North', propertyIds: [] },
      ] }),
    ]) {
      assert.deepEqual(selectAuthoritativePortfolioUiScope(input, {
        scope: 'portfolio', organizationId: ORG,
      }), { ok: false, reason: 'invalid_authoritative_scope' });
    }
  });
});
