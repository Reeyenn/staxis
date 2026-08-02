import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import type { CompanyMembership } from '@/lib/company-access/dto';
import {
  groupAccessMemberships,
  isAccessHistoryStatus,
  isDirectAccessGrant,
  splitAccessMemberships,
} from '@/lib/company-access/access-people';

function source(...parts: string[]): string {
  return readFileSync(join(process.cwd(), ...parts), 'utf8');
}

function membership(overrides: Partial<CompanyMembership> & Pick<CompanyMembership, 'id' | 'accountId'>): CompanyMembership {
  return {
    organizationId: 'org-a',
    displayName: 'Alex Morgan',
    status: 'active',
    propertyIds: ['hotel-a'],
    grants: [],
    canSuspend: false,
    canResume: false,
    canRemove: false,
    ...overrides,
  };
}

describe('Access person grouping', () => {
  test('groups multiple organizations and roles by stable account identity', () => {
    const groups = groupAccessMemberships([
      membership({ id: 'membership-a', accountId: 'account-a', organizationId: 'org-a', accessProfile: 'property_manager' }),
      membership({ id: 'membership-b', accountId: 'account-a', organizationId: 'org-b', displayName: 'Alex M.', accessProfile: 'viewer' }),
      membership({ id: 'membership-c', accountId: 'account-b', displayName: 'Alex Morgan', accessProfile: 'viewer' }),
    ]);

    assert.equal(groups.length, 2);
    assert.equal(groups[0].accountId, 'account-a');
    assert.equal(groups[0].displayName, 'Alex Morgan');
    assert.deepEqual(groups[0].memberships.map((item) => item.id), ['membership-a', 'membership-b']);
    assert.deepEqual(groups[1].memberships.map((item) => item.id), ['membership-c']);
  });

  test('keeps active, suspended, and pending states visible while moving history out', () => {
    const records = [
      membership({ id: 'active', accountId: 'account-a', status: 'active' }),
      membership({ id: 'pending', accountId: 'account-a', status: 'pending' }),
      membership({ id: 'suspended', accountId: 'account-a', status: 'suspended' }),
      membership({ id: 'revoked', accountId: 'account-a', status: 'revoked' }),
    ];
    const split = splitAccessMemberships(records);

    assert.deepEqual(split.current.map((item) => item.id), ['active', 'pending', 'suspended']);
    assert.deepEqual(split.history.map((item) => item.id), ['revoked']);
    assert.equal(isAccessHistoryStatus('cancelled'), true);
    assert.equal(isAccessHistoryStatus('active'), false);
  });

  test('marks only property-scoped grants as direct access', () => {
    assert.equal(isDirectAccessGrant({ scopeType: 'property' }), true);
    assert.equal(isDirectAccessGrant({ scopeType: 'portfolio' }), false);
    assert.equal(isDirectAccessGrant({ scopeType: 'organization' }), false);
  });
});

describe('Access tab placement contract', () => {
  const page = source('src', 'app', 'company', 'page.tsx');

  test('removes redundant grant headings and keeps action/privacy gates explicit', () => {
    assert.doesNotMatch(page, /Customer grants|Roles and scopes by person/);
    assert.match(page, /groupAccessMemberships\(visibleMemberships\)/);
    assert.match(page, /const renderedPeople = showHistory/);
    assert.match(page, /showDirectAccess=\{adminPreview\}/);
    assert.match(page, /isDirectAccessGrant\(grant\)/);
    assert.match(page, /onEditAccess=\{setEditingMembershipId\}/);
    assert.match(page, /onReviewRequest=\{onReviewRequest\}/);
    assert.match(page, /const revocableGrants = adminPreview \? \[\] :/);
    assert.doesNotMatch(page, /AdminHotelRelationshipManager/);
  });
});
