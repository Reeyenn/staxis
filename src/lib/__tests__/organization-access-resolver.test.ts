import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  canDelegateAccess,
  resolvePropertyAccess,
  type AccessFacts,
} from '@/lib/organization-access';

const NOW = new Date('2030-01-15T12:00:00.000Z');
const ORG = 'org-a';
const OTHER_ORG = 'org-b';
const PROPERTY = 'hotel-a';
const OTHER_PROPERTY = 'hotel-b';
const RELATIONSHIP = 'relationship-a';
const PORTFOLIO = 'portfolio-a';
const ACCOUNT = 'account-a';
const MEMBERSHIP = 'membership-a';

function baseFacts(): AccessFacts {
  return {
    organizations: [
      { id: ORG, status: 'active' },
      { id: OTHER_ORG, status: 'active' },
    ],
    memberships: [{
      id: MEMBERSHIP,
      organizationId: ORG,
      accountId: ACCOUNT,
      status: 'active',
      startsAt: '2029-01-01T00:00:00Z',
    }],
    grants: [],
    propertyRelationships: [{
      id: RELATIONSHIP,
      organizationId: ORG,
      propertyId: PROPERTY,
      startsAt: '2029-01-01T00:00:00Z',
    }],
    portfolios: [{ id: PORTFOLIO, organizationId: ORG, status: 'active' }],
    portfolioProperties: [{
      organizationId: ORG,
      portfolioId: PORTFOLIO,
      propertyRelationshipId: RELATIONSHIP,
      propertyId: PROPERTY,
      assignedAt: '2029-01-01T00:00:00Z',
    }],
  };
}

describe('organization access resolver', () => {
  test('organization scope reaches every actively related property and returns an access receipt', () => {
    const facts = baseFacts();
    facts.grants = [{
      id: 'grant-owner',
      organizationId: ORG,
      membershipId: MEMBERSHIP,
      accessProfile: 'organization_owner',
      scopeType: 'organization',
      status: 'active',
      source: 'manual',
      startsAt: '2029-01-01T00:00:00Z',
    }];

    const decision = resolvePropertyAccess(ACCOUNT, PROPERTY, facts, NOW);
    assert.equal(decision.allowed, true);
    assert.deepEqual(decision.profiles, ['organization_owner']);
    assert.ok(decision.capabilities.includes('transfer_ownership'));
    assert.equal(decision.receipts[0].reason, 'Inherited from organization access');
  });

  test('portfolio scope only reaches active assignments tied to an active relationship', () => {
    const facts = baseFacts();
    facts.grants = [{
      id: 'grant-portfolio',
      organizationId: ORG,
      membershipId: MEMBERSHIP,
      accessProfile: 'portfolio_manager',
      scopeType: 'portfolio',
      portfolioId: PORTFOLIO,
      status: 'active',
      source: 'invitation',
      startsAt: '2029-01-01T00:00:00Z',
    }];

    assert.equal(resolvePropertyAccess(ACCOUNT, PROPERTY, facts, NOW).allowed, true);

    facts.portfolioProperties = facts.portfolioProperties.map((assignment) => ({
      ...assignment,
      removedAt: '2030-01-01T00:00:00Z',
    }));
    const removed = resolvePropertyAccess(ACCOUNT, PROPERTY, facts, NOW);
    assert.equal(removed.allowed, false);
    assert.equal(removed.denialReason, 'no_matching_active_grant');
  });

  test('direct property grants cannot cross an organization relationship boundary', () => {
    const facts = baseFacts();
    facts.grants = [{
      id: 'grant-property',
      organizationId: ORG,
      membershipId: MEMBERSHIP,
      accessProfile: 'property_manager',
      scopeType: 'property',
      propertyRelationshipId: 'relationship-from-another-org',
      propertyId: PROPERTY,
      status: 'active',
      source: 'manual',
      startsAt: '2029-01-01T00:00:00Z',
    }];

    const decision = resolvePropertyAccess(ACCOUNT, PROPERTY, facts, NOW);
    assert.equal(decision.allowed, false);
    assert.equal(decision.denialReason, 'no_matching_active_grant');
  });

  test('expired grants, suspended memberships, and ended relationships fail closed', () => {
    const facts = baseFacts();
    facts.grants = [{
      id: 'grant-expired',
      organizationId: ORG,
      membershipId: MEMBERSHIP,
      accessProfile: 'viewer',
      scopeType: 'organization',
      status: 'active',
      source: 'manual',
      startsAt: '2029-01-01T00:00:00Z',
      expiresAt: '2030-01-01T00:00:00Z',
    }];
    assert.equal(resolvePropertyAccess(ACCOUNT, PROPERTY, facts, NOW).allowed, false);

    facts.grants = [{ ...facts.grants[0], expiresAt: null }];
    facts.memberships = [{ ...facts.memberships[0], status: 'suspended' }];
    assert.equal(
      resolvePropertyAccess(ACCOUNT, PROPERTY, facts, NOW).denialReason,
      'no_active_membership',
    );

    facts.memberships = [{ ...facts.memberships[0], status: 'active', accountActive: false }];
    assert.equal(
      resolvePropertyAccess(ACCOUNT, PROPERTY, facts, NOW).denialReason,
      'no_active_membership',
    );

    facts.memberships = [{ ...facts.memberships[0], status: 'active', accountActive: true }];
    facts.propertyRelationships = [{
      ...facts.propertyRelationships[0],
      endsAt: '2030-01-01T00:00:00Z',
    }];
    assert.equal(
      resolvePropertyAccess(ACCOUNT, PROPERTY, facts, NOW).denialReason,
      'no_active_relationship',
    );
  });

  test('an internal admin gets no implicit customer access', () => {
    const facts = baseFacts();
    const decision = resolvePropertyAccess('staxis-admin-account', PROPERTY, facts, NOW);
    assert.equal(decision.allowed, false);
    assert.equal(decision.denialReason, 'no_active_membership');
  });

  test('multiple valid grants union capabilities without losing their receipts', () => {
    const facts = baseFacts();
    facts.grants = [
      {
        id: 'grant-viewer', organizationId: ORG, membershipId: MEMBERSHIP,
        accessProfile: 'viewer', scopeType: 'organization', status: 'active',
        source: 'manual', startsAt: '2029-01-01T00:00:00Z',
      },
      {
        id: 'grant-property', organizationId: ORG, membershipId: MEMBERSHIP,
        accessProfile: 'property_manager', scopeType: 'property',
        propertyRelationshipId: RELATIONSHIP, propertyId: PROPERTY,
        status: 'active', source: 'access_request', startsAt: '2029-01-01T00:00:00Z',
      },
    ];

    const decision = resolvePropertyAccess(ACCOUNT, PROPERTY, facts, NOW);
    assert.equal(decision.allowed, true);
    assert.equal(decision.receipts.length, 2);
    assert.ok(decision.capabilities.includes('manage_people'));
    assert.ok(!decision.capabilities.includes('manage_billing'));
  });
});

describe('organization access delegation', () => {
  test('an organization owner may delegate a property manager inside the organization', () => {
    const facts = baseFacts();
    facts.grants = [{
      id: 'grant-owner', organizationId: ORG, membershipId: MEMBERSHIP,
      accessProfile: 'organization_owner', scopeType: 'organization',
      status: 'active', source: 'manual', startsAt: '2029-01-01T00:00:00Z',
    }];

    assert.deepEqual(canDelegateAccess({
      actorAccountId: ACCOUNT,
      organizationId: ORG,
      requestedProfile: 'property_manager',
      requestedScopeType: 'property',
      requestedPropertyId: PROPERTY,
      at: NOW,
    }, facts), {
      allowed: true,
      reason: 'allowed',
      authorizingGrantId: 'grant-owner',
    });
  });

  test('rejects profile/scope combinations the database would reject', () => {
    const facts = baseFacts();
    facts.grants = [{
      id: 'grant-owner', organizationId: ORG, membershipId: MEMBERSHIP,
      accessProfile: 'organization_owner', scopeType: 'organization',
      status: 'active', source: 'manual', startsAt: '2029-01-01T00:00:00Z',
    }];

    const decision = canDelegateAccess({
      actorAccountId: ACCOUNT,
      organizationId: ORG,
      requestedProfile: 'organization_owner',
      requestedScopeType: 'property',
      requestedPropertyId: PROPERTY,
      at: NOW,
    }, facts);
    assert.equal(decision.allowed, false);
    assert.equal(decision.reason, 'invalid_requested_scope');
  });

  test('a portfolio manager may delegate inside their portfolio, never outside it', () => {
    const facts = baseFacts();
    facts.propertyRelationships = [
      ...facts.propertyRelationships,
      {
        id: 'relationship-b', organizationId: ORG, propertyId: OTHER_PROPERTY,
        startsAt: '2029-01-01T00:00:00Z',
      },
    ];
    facts.grants = [{
      id: 'grant-portfolio', organizationId: ORG, membershipId: MEMBERSHIP,
      accessProfile: 'portfolio_manager', scopeType: 'portfolio', portfolioId: PORTFOLIO,
      status: 'active', source: 'manual', startsAt: '2029-01-01T00:00:00Z',
    }];

    assert.equal(canDelegateAccess({
      actorAccountId: ACCOUNT,
      organizationId: ORG,
      requestedProfile: 'viewer',
      requestedScopeType: 'property',
      requestedPropertyId: PROPERTY,
      at: NOW,
    }, facts).allowed, true);

    const outside = canDelegateAccess({
      actorAccountId: ACCOUNT,
      organizationId: ORG,
      requestedProfile: 'viewer',
      requestedScopeType: 'property',
      requestedPropertyId: OTHER_PROPERTY,
      at: NOW,
    }, facts);
    assert.equal(outside.allowed, false);
    assert.equal(outside.reason, 'scope_not_contained');
  });

  test('organization admins cannot create owners or peer organization admins', () => {
    const facts = baseFacts();
    facts.grants = [{
      id: 'grant-admin', organizationId: ORG, membershipId: MEMBERSHIP,
      accessProfile: 'organization_admin', scopeType: 'organization',
      status: 'active', source: 'manual', startsAt: '2029-01-01T00:00:00Z',
    }];

    for (const requestedProfile of ['organization_owner', 'organization_admin'] as const) {
      const decision = canDelegateAccess({
        actorAccountId: ACCOUNT,
        organizationId: ORG,
        requestedProfile,
        requestedScopeType: 'organization',
        at: NOW,
      }, facts);
      assert.equal(decision.allowed, false);
      assert.equal(decision.reason, 'profile_not_delegatable');
    }
  });
});
