import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { AuthorizationScopeReceipt } from '@/lib/authorization';
import {
  companyRoleFromAuthorizationReceipt,
  propertyStandingsFromAuthorizationReceipt,
  presentationCapabilitiesFromAuthorizationReceipt,
  queueAvailableFromAuthorizationReceipt,
  receiptRepresentsPortfolioActor,
  scopeDescriptorsFromAuthorizationReceipt,
} from '@/lib/company/authoritative-scope';

const ORG = '91000000-0000-4000-8000-000000000001';
const ACCOUNT = '91000000-0000-4000-8000-000000000002';
const HOTEL_A = '91000000-0000-4000-8000-000000000003';
const HOTEL_B = '91000000-0000-4000-8000-000000000004';
const REGION = '91000000-0000-4000-8000-000000000005';
const GRANT = '91000000-0000-4000-8000-000000000006';
const MEMBERSHIP = '91000000-0000-4000-8000-000000000007';

function regionReceipt(): AuthorizationScopeReceipt {
  return {
    id: '91000000-0000-4000-8000-000000000008',
    accountId: ACCOUNT,
    organizationId: ORG,
    organizationName: 'Gulf Coast Hotels',
    authorityMode: 'normalized',
    selectorType: 'all_authorized',
    requestedPortfolioId: null,
    requestedPropertyIds: [],
    authorizedPropertyIds: [HOTEL_A, HOTEL_B],
    propertyIds: [HOTEL_A, HOTEL_B],
    authorizedPropertyCount: 2,
    selectedPropertyCount: 2,
    portfolioCatalog: [{
      portfolioId: REGION,
      name: 'North Region',
      portfolioType: 'region',
      parentId: null,
      directPropertyIds: [HOTEL_A, HOTEL_B],
      propertyIds: [HOTEL_A, HOTEL_B],
    }],
    accountAuthorizationVersion: 2,
    organizationAccessEpoch: 3,
    resolverVersion: 'test',
    authorizationHash: 'a'.repeat(64),
    scopeHash: 'b'.repeat(64),
    provenance: {
      entitlements: [HOTEL_A, HOTEL_B].map((propertyId) => ({
        propertyId,
        entitlementKind: 'access_grant' as const,
        entitlementId: GRANT,
        membershipId: MEMBERSHIP,
        accessProfile: 'portfolio_manager' as const,
        staxisRole: null,
        scopeType: 'portfolio' as const,
        portfolioId: REGION,
      })),
      governingRelationshipTypes: ['operator', 'owner'],
      selectionWasTruncated: false,
    },
    resolvedAt: '2030-01-01T00:00:00.000Z',
    expiresAt: '2030-01-01T00:02:00.000Z',
  };
}

test('normalized region grants produce exact UI-safe scope and capability hints', () => {
  const receipt = regionReceipt();
  // A portfolio grant with no company hat of its own. `regional_manager` is the
  // read-only presentation word for that standing since 0464; before it, the
  // synthesized word was `finance`.
  assert.equal(companyRoleFromAuthorizationReceipt(receipt), 'regional_manager');
  assert.deepEqual(scopeDescriptorsFromAuthorizationReceipt(receipt), [{
    kind: 'region',
    id: REGION,
    name: 'North Region',
    propertyIds: [HOTEL_A, HOTEL_B],
  }]);
  const capabilities = presentationCapabilitiesFromAuthorizationReceipt(receipt);
  assert.ok(capabilities.includes('view_company'));
  assert.ok(capabilities.includes('portfolio_intelligence_read'));
  assert.ok(capabilities.includes('manage_portfolios'));
  assert.equal(capabilities.includes('manage_billing'), false);
  assert.equal(capabilities.includes('transfer_ownership'), false);
  assert.deepEqual(propertyStandingsFromAuthorizationReceipt(receipt), [
    {
      propertyId: HOTEL_A,
      operationalRole: 'front_desk',
      canManageHotel: false,
      seesFinancials: false,
      portfolioIntelligenceRead: true,
    },
    {
      propertyId: HOTEL_B,
      operationalRole: 'front_desk',
      canManageHotel: false,
      seesFinancials: false,
      portfolioIntelligenceRead: true,
    },
  ]);
  assert.equal(receiptRepresentsPortfolioActor(receipt), true);
  assert.equal(queueAvailableFromAuthorizationReceipt(receipt), false);
});

test('selected-hotel descriptors do not become organization-wide scope', () => {
  const receipt = regionReceipt();
  receipt.provenance.entitlements = receipt.provenance.entitlements.map((item) => ({
    ...item,
    scopeType: 'property',
    portfolioId: null,
  }));
  assert.deepEqual(scopeDescriptorsFromAuthorizationReceipt(receipt), [{
    kind: 'selected_hotels',
    id: GRANT,
    name: 'Selected hotels (2)',
    propertyIds: [HOTEL_A, HOTEL_B],
  }]);
});

test('queue availability requires broad provenance for every exact hotel', () => {
  const receipt = regionReceipt();
  receipt.provenance.entitlements = receipt.provenance.entitlements.map((item, index) => ({
    ...item,
    scopeType: index === 0 ? 'organization' : 'property',
    portfolioId: null,
  }));
  assert.equal(queueAvailableFromAuthorizationReceipt(receipt), false);
});

test('company oversight is read-only while an explicit property GM standing may manage', () => {
  const receipt = regionReceipt();
  receipt.provenance.entitlements = [
    ...[HOTEL_A, HOTEL_B].map((propertyId) => ({
      propertyId,
      entitlementKind: 'membership_hat' as const,
      entitlementId: MEMBERSHIP,
      membershipId: MEMBERSHIP,
      accessProfile: null,
      staxisRole: 'regional_manager' as const,
      scopeType: 'company' as const,
      portfolioId: null,
    })),
    {
      propertyId: HOTEL_A,
      entitlementKind: 'membership_hat',
      entitlementId: '91000000-0000-4000-8000-000000000009',
      membershipId: '91000000-0000-4000-8000-000000000009',
      accessProfile: null,
      staxisRole: 'general_manager',
      scopeType: 'property',
      portfolioId: null,
    },
  ];
  assert.deepEqual(propertyStandingsFromAuthorizationReceipt(receipt), [
    {
      propertyId: HOTEL_A,
      operationalRole: 'general_manager',
      canManageHotel: true,
      seesFinancials: true,
      portfolioIntelligenceRead: true,
    },
    {
      propertyId: HOTEL_B,
      operationalRole: 'front_desk',
      canManageHotel: false,
      seesFinancials: true,
      portfolioIntelligenceRead: true,
    },
  ]);
  assert.equal(queueAvailableFromAuthorizationReceipt(receipt), true);
});

test('one-hotel property-only GM stays on the hotel surface', () => {
  const receipt = regionReceipt();
  receipt.authorizedPropertyIds = [HOTEL_A];
  receipt.propertyIds = [HOTEL_A];
  receipt.authorizedPropertyCount = 1;
  receipt.selectedPropertyCount = 1;
  receipt.provenance.entitlements = [{
    propertyId: HOTEL_A,
    entitlementKind: 'membership_hat',
    entitlementId: MEMBERSHIP,
    membershipId: MEMBERSHIP,
    accessProfile: null,
    staxisRole: 'general_manager',
    scopeType: 'property',
    portfolioId: null,
  }];
  assert.equal(receiptRepresentsPortfolioActor(receipt), false);
  assert.equal(queueAvailableFromAuthorizationReceipt(receipt), false);
});
