import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  validateAccessRequestMutation,
  validateGrantRevocationMutation,
  validateInvitationMutation,
  validateInvitationCancellationMutation,
  validateMembershipLifecycleMutation,
} from '@/lib/company-access/mutations';
import { isCompanyAccessUnavailable } from '@/lib/company-access/database-errors';

const ORG = '11111111-1111-1111-1111-111111111111';
const PORTFOLIO = '22222222-2222-2222-2222-222222222222';
const PROPERTY = '33333333-3333-3333-3333-333333333333';
const NOW = new Date('2026-07-19T12:00:00.000Z');

function invite(overrides: Record<string, unknown> = {}) {
  return {
    organizationId: ORG,
    email: 'Leader@Example.com',
    jobCategory: 'regional_manager',
    jobTitle: ' Regional Vice President ',
    accessProfile: 'viewer',
    scopeType: 'property',
    propertyId: PROPERTY,
    ...overrides,
  };
}

describe('company invitation validation', () => {
  test('normalizes email/title and preserves the exact property scope', () => {
    const result = validateInvitationMutation(invite(), NOW);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.email, 'leader@example.com');
    assert.equal(result.value.jobTitle, 'Regional Vice President');
    assert.equal(result.value.propertyId, PROPERTY);
    assert.equal(result.value.portfolioId, null);
  });

  test('rejects invalid profile/scope combinations and stray scope ids', () => {
    assert.equal(validateInvitationMutation(invite({
      accessProfile: 'organization_admin', scopeType: 'property',
    }), NOW).ok, false);
    assert.equal(validateInvitationMutation(invite({
      scopeType: 'organization', propertyId: PROPERTY,
    }), NOW).ok, false);
    assert.equal(validateInvitationMutation(invite({
      scopeType: 'portfolio', propertyId: undefined, portfolioId: PORTFOLIO,
      accessProfile: 'property_manager',
    }), NOW).ok, false);
  });

  test('external access must outlive the fixed seven-day invite window', () => {
    assert.equal(validateInvitationMutation(invite({
      accessProfile: 'external_collaborator', expiresAt: '2026-07-20',
    }), NOW).ok, false);
    assert.equal(validateInvitationMutation(invite({
      accessProfile: 'external_collaborator', expiresAt: '2026-08-01',
    }), NOW).ok, true);
  });

  test('organization owner access is organization-wide and permanent', () => {
    assert.equal(validateInvitationMutation(invite({
      accessProfile: 'organization_owner', scopeType: 'organization',
      propertyId: undefined, expiresAt: '2026-08-01',
    }), NOW).ok, false);
    assert.equal(validateInvitationMutation(invite({
      accessProfile: 'organization_owner', scopeType: 'organization',
      propertyId: undefined,
    }), NOW).ok, true);
  });
});

describe('company access-request validation', () => {
  test('requires an exact scope and a useful reason', () => {
    assert.equal(validateAccessRequestMutation({
      organizationId: ORG,
      requestedProfile: 'portfolio_manager',
      scopeType: 'portfolio',
      portfolioId: PORTFOLIO,
      reason: 'I manage this regional portfolio.',
    }).ok, true);
    assert.equal(validateAccessRequestMutation({
      organizationId: ORG,
      requestedProfile: 'portfolio_manager',
      scopeType: 'organization',
      reason: 'Need this access',
    }).ok, false);
    assert.equal(validateAccessRequestMutation({
      organizationId: ORG,
      requestedProfile: 'viewer',
      scopeType: 'organization',
      reason: 'short',
    }).ok, false);
  });
});

describe('company access lifecycle validation', () => {
  test('accepts opaque target ids and normalizes an audit reason', () => {
    const grant = validateGrantRevocationMutation({
      grantId: PROPERTY,
      reason: '  This access is no longer required.  ',
    });
    assert.equal(grant.ok, true);
    if (grant.ok) assert.equal(grant.value.reason, 'This access is no longer required.');

    assert.equal(validateInvitationCancellationMutation({
      invitationId: PORTFOLIO,
      reason: 'The recipient changed roles.',
    }).ok, true);
    assert.equal(validateMembershipLifecycleMutation({
      membershipId: ORG,
      action: 'suspend',
      reason: 'Temporary leave of absence.',
    }).ok, true);
    assert.equal(validateMembershipLifecycleMutation({
      membershipId: ORG,
      action: 'resume',
      reason: 'The team member has returned.',
    }).ok, true);
  });

  test('rejects guessed tenant fields, invalid actions, and weak reasons', () => {
    assert.equal(validateGrantRevocationMutation({
      grantId: 'not-a-uuid', reason: 'Long enough reason',
    }).ok, false);
    assert.equal(validateInvitationCancellationMutation({
      invitationId: PORTFOLIO, reason: 'short',
    }).ok, false);
    assert.equal(validateMembershipLifecycleMutation({
      membershipId: ORG, action: 'reactivate', reason: 'A detailed reason',
    }).ok, false);
  });
});

describe('company access deployment errors', () => {
  test('classifies missing RPC/table and schema-cache errors as retryable', () => {
    assert.equal(isCompanyAccessUnavailable({ code: 'PGRST202' }), true);
    assert.equal(isCompanyAccessUnavailable({ code: 'PGRST205' }), true);
    assert.equal(isCompanyAccessUnavailable({ code: '42P01' }), true);
    assert.equal(isCompanyAccessUnavailable({ message: 'relation organization_access_epochs does not exist' }), true);
    assert.equal(isCompanyAccessUnavailable({ code: '42501' }), false);
  });
});
