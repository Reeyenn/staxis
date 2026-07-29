import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { parseAuthorizationScopeResult } from '@/lib/authorization';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const ORG = '22222222-2222-4222-8222-222222222222';
const HOTEL_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const HOTEL_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const RECEIPT = '33333333-3333-4333-8333-333333333333';
const PORTFOLIO = '44444444-4444-4444-8444-444444444444';
const PORTFOLIO_B = '55555555-5555-4555-8555-555555555555';
const ENTITLEMENT = '66666666-6666-4666-8666-666666666666';
const MEMBERSHIP = '77777777-7777-4777-8777-777777777777';
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

function validPayload(): Record<string, unknown> {
  return {
    ok: true,
    receipt: {
      id: RECEIPT,
      accountId: ACCOUNT,
      organizationId: ORG,
      organizationName: 'Gulf Coast Hotels',
      authorityMode: 'normalized',
      selectorType: 'property_subset',
      requestedPortfolioId: null,
      requestedPropertyIds: [HOTEL_A],
      authorizedPropertyIds: [HOTEL_A, HOTEL_B],
      propertyIds: [HOTEL_A],
      authorizedPropertyCount: 2,
      selectedPropertyCount: 1,
      portfolioCatalog: [{
        portfolioId: PORTFOLIO,
        name: 'East Region',
        portfolioType: 'region',
        parentId: null,
        directPropertyIds: [HOTEL_A],
        propertyIds: [HOTEL_A, HOTEL_B],
      }],
      accountAuthorizationVersion: 7,
      organizationAccessEpoch: 9,
      resolverVersion: 'portfolio-scope-v1',
      authorizationHash: HASH_A,
      scopeHash: HASH_B,
      provenance: {
        entitlements: [{
          propertyId: HOTEL_A,
          entitlementKind: 'access_grant',
          entitlementId: ENTITLEMENT,
          membershipId: MEMBERSHIP,
          accessProfile: 'portfolio_manager',
          staxisRole: null,
          scopeType: 'portfolio',
          portfolioId: PORTFOLIO,
        }],
        governingRelationshipTypes: ['operator', 'owner'],
        selectionWasTruncated: false,
      },
      resolvedAt: '2030-01-01T00:00:00.000Z',
      expiresAt: '2030-01-01T00:02:00.000Z',
    },
  };
}

describe('authorization scope receipt parser', () => {
  test('keeps full authorization and selected subset distinct', () => {
    const parsed = parseAuthorizationScopeResult(validPayload());
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.deepEqual(parsed.receipt.authorizedPropertyIds, [HOTEL_A, HOTEL_B]);
    assert.deepEqual(parsed.receipt.propertyIds, [HOTEL_A]);
    assert.equal(parsed.receipt.authorizationHash, HASH_A);
    assert.equal(parsed.receipt.scopeHash, HASH_B);
  });

  test('fails closed on unsorted, duplicated, out-of-universe or count-mismatched arrays', () => {
    for (const mutate of [
      (r: Record<string, unknown>) => { r.authorizedPropertyIds = [HOTEL_B, HOTEL_A]; },
      (r: Record<string, unknown>) => { r.propertyIds = [HOTEL_A, HOTEL_A]; },
      (r: Record<string, unknown>) => {
        r.propertyIds = ['cccccccc-cccc-4ccc-8ccc-cccccccccccc'];
      },
      (r: Record<string, unknown>) => { r.selectedPropertyCount = 2; },
    ]) {
      const payload = validPayload();
      mutate(payload.receipt as Record<string, unknown>);
      assert.deepEqual(
        parseAuthorizationScopeResult(payload),
        { ok: false, reason: 'store_unavailable' },
      );
    }
  });

  test('rejects a catalog that contains a hotel outside the authorization universe', () => {
    const payload = validPayload();
    const receipt = payload.receipt as Record<string, unknown>;
    const catalog = receipt.portfolioCatalog as Array<Record<string, unknown>>;
    catalog[0].propertyIds = ['cccccccc-cccc-4ccc-8ccc-cccccccccccc'];
    assert.deepEqual(
      parseAuthorizationScopeResult(payload),
      { ok: false, reason: 'store_unavailable' },
    );
  });

  test('rejects mismatched portfolio selections, cyclic topology and overlong receipts', () => {
    const mismatched = validPayload();
    Object.assign(mismatched.receipt as Record<string, unknown>, {
      selectorType: 'portfolio',
      requestedPortfolioId: PORTFOLIO,
      requestedPropertyIds: [],
    });
    assert.deepEqual(
      parseAuthorizationScopeResult(mismatched),
      { ok: false, reason: 'store_unavailable' },
      'selected hotels did not match the requested portfolio catalog entry',
    );

    const cyclic = validPayload();
    (cyclic.receipt as Record<string, unknown>).portfolioCatalog = [{
      portfolioId: PORTFOLIO,
      name: 'East Region',
      portfolioType: 'region',
      parentId: PORTFOLIO_B,
      directPropertyIds: [HOTEL_A],
      propertyIds: [HOTEL_A, HOTEL_B],
    }, {
      portfolioId: PORTFOLIO_B,
      name: 'Loop',
      portfolioType: 'portfolio',
      parentId: PORTFOLIO,
      directPropertyIds: [HOTEL_B],
      propertyIds: [HOTEL_B],
    }];
    assert.deepEqual(
      parseAuthorizationScopeResult(cyclic),
      { ok: false, reason: 'store_unavailable' },
    );

    const overlong = validPayload();
    (overlong.receipt as Record<string, unknown>).expiresAt = '2030-01-01T00:05:01.000Z';
    assert.deepEqual(
      parseAuthorizationScopeResult(overlong),
      { ok: false, reason: 'store_unavailable' },
    );
  });

  test('validates entitlement provenance instead of trusting raw scope and role strings', () => {
    const mutations: Array<(entry: Record<string, unknown>, provenance: Record<string, unknown>) => void> = [
      (entry) => { entry.scopeType = 'planet'; },
      (entry) => { entry.accessProfile = 'super_admin'; },
      (entry) => { entry.propertyId = HOTEL_B; },
      (entry) => { entry.membershipId = 'not-a-uuid'; },
      (entry) => { entry.staxisRole = 'vp'; },
      (entry) => { entry.portfolioId = null; },
      (_entry, provenance) => { provenance.selectionWasTruncated = true; },
      (_entry, provenance) => { provenance.governingRelationshipTypes = ['owner', 'operator']; },
    ];
    for (const mutate of mutations) {
      const payload = validPayload();
      const receipt = payload.receipt as Record<string, unknown>;
      const provenance = receipt.provenance as Record<string, unknown>;
      const entry = (provenance.entitlements as Array<Record<string, unknown>>)[0];
      mutate(entry, provenance);
      assert.deepEqual(
        parseAuthorizationScopeResult(payload),
        { ok: false, reason: 'store_unavailable' },
      );
    }
  });

  test('does not turn an unknown database refusal into an allowed result', () => {
    assert.deepEqual(
      parseAuthorizationScopeResult({ ok: false, reason: 'surprise' }),
      { ok: false, reason: 'store_unavailable' },
    );
  });
});
