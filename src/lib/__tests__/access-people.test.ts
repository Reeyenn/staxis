import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  buildAccessPeople,
  resolveCompanyAccessContext,
} from '@/lib/company-access/access-people';
import {
  EMPTY_COMPANY_ACCESS,
  type CompanyAccessData,
} from '@/lib/company-access/dto';

const ORG_A = 'org-a';
const ORG_B = 'org-b';
const A1 = 'hotel-a1';
const A2 = 'hotel-a2';
const B1 = 'hotel-b1';
const MARIA = 'account-maria';
const FIONA = 'account-fiona';
const FRANK = 'account-frank';
const PENDING_ONLY = 'account-pending-only';

function baseData(): CompanyAccessData {
  return {
    ...EMPTY_COMPANY_ACCESS,
    organizations: [
      { id: ORG_A, name: 'North Star Hotels', type: 'management_company', status: 'active' },
      { id: ORG_B, name: 'South Star Hotels', type: 'management_company', status: 'active' },
    ],
    properties: [
      { nodeId: `${ORG_A}:${A1}`, id: A1, name: 'Aster Hotel', organizationId: ORG_A, portfolioIds: [], status: 'active' },
      { nodeId: `${ORG_A}:${A2}`, id: A2, name: 'Birch Hotel', organizationId: ORG_A, portfolioIds: [], status: 'active' },
      { nodeId: `${ORG_B}:${B1}`, id: B1, name: 'Cedar Hotel', organizationId: ORG_B, portfolioIds: [], status: 'active' },
    ],
    memberships: [
      {
        id: 'm-maria-hat', organizationId: ORG_A, accountId: MARIA, displayName: 'Maria Owner',
        accessProfile: 'organization_owner', status: 'active', propertyIds: [A1, A2],
        grants: [{
          id: 'g-maria-company', accessProfile: 'organization_owner', scopeType: 'organization',
          scopeLabel: 'North Star Hotels', propertyIds: [A1, A2], canRevoke: false,
          source: 'company', status: 'active', isMembershipAccess: true,
        }], canSuspend: false, canResume: false, canRemove: false,
      },
      {
        id: 'm-maria-direct', organizationId: ORG_A, accountId: MARIA, displayName: 'Maria Owner',
        accessProfile: 'organization_owner', status: 'active', propertyIds: [A1],
        grants: [{
          id: 'g-maria-direct', accessProfile: 'organization_owner', scopeType: 'property',
          scopeLabel: 'Aster Hotel', propertyIds: [A1], canRevoke: true,
          source: 'direct', status: 'active',
        }], canSuspend: false, canResume: false, canRemove: false,
      },
      {
        id: 'm-fiona-1', organizationId: ORG_A, accountId: FIONA, displayName: 'Fiona Staff',
        accessProfile: 'viewer', status: 'active', propertyIds: [A1, A2],
        grants: [{
          id: 'g-fiona-a1', accessProfile: 'viewer', scopeType: 'property',
          scopeLabel: 'Aster Hotel', propertyIds: [A1], canRevoke: true,
          source: 'direct', status: 'active',
        }, {
          id: 'g-fiona-a2', accessProfile: 'viewer', scopeType: 'property',
          scopeLabel: 'Birch Hotel', propertyIds: [A2], canRevoke: true,
          source: 'direct', status: 'active',
        }], canSuspend: false, canResume: false, canRemove: false,
      },
      {
        id: 'm-fiona-2', organizationId: ORG_A, accountId: FIONA, displayName: 'Fiona Staff',
        accessProfile: 'viewer', status: 'active', propertyIds: [A1],
        grants: [{
          id: 'g-fiona-a1-duplicate', accessProfile: 'viewer', scopeType: 'property',
          scopeLabel: 'Aster Hotel', propertyIds: [A1], canRevoke: false,
          source: 'direct', status: 'active',
        }], canSuspend: false, canResume: false, canRemove: false,
      },
      {
        id: 'm-frank-b', organizationId: ORG_B, accountId: FRANK, displayName: 'Frank Other Company',
        accessProfile: 'organization_owner', status: 'active', propertyIds: [B1],
        grants: [{
          id: 'g-frank-b1', accessProfile: 'organization_owner', scopeType: 'organization',
          scopeLabel: 'South Star Hotels', propertyIds: [B1], canRevoke: false,
          source: 'company', status: 'active',
        }], canSuspend: false, canResume: false, canRemove: false,
      },
    ],
    requests: [{
      id: 'request-fiona', organizationId: ORG_A, requesterAccountId: FIONA,
      scopeType: 'property', requesterName: 'Fiona Staff', requestedProfile: 'viewer',
      scopeLabel: 'Aster Hotel', propertyIds: [A1], reason: 'Needs a hotel login',
      status: 'pending', createdAt: '2026-08-01T00:00:00.000Z', canReview: true,
    }, {
      id: 'request-pending-only', organizationId: ORG_A, requesterAccountId: PENDING_ONLY,
      scopeType: 'property', requesterName: 'Pending Only', requestedProfile: 'viewer',
      scopeLabel: 'Aster Hotel', propertyIds: [A1], reason: 'Needs approval before starting',
      status: 'pending', createdAt: '2026-08-02T00:00:00.000Z', canReview: false,
    }],
    accessHistory: [{
      id: 'history-vera', organizationId: ORG_A, membershipId: 'm-vera', accountId: 'account-vera',
      displayName: 'Vera Former', record: {
        id: 'g-vera-revoked', accessProfile: 'viewer', scopeType: 'property',
        scopeLabel: 'Aster Hotel', propertyIds: [A1], canRevoke: false,
        source: 'direct', status: 'revoked', reason: 'Access was removed',
      },
    }],
  };
}

describe('Company Hub effective access presentation', () => {
  test('deduplicates hats and direct rows by person while retaining source and scope', () => {
    const data = baseData();
    const context = resolveCompanyAccessContext(data, A1);
    assert.equal(context.state, 'ready');
    const result = buildAccessPeople(data, context, MARIA);

    assert.deepEqual(result.effectivePeople.map((person) => person.displayName), ['Fiona Staff', 'Maria Owner']);
    const maria = result.effectivePeople.find((person) => person.accountId === MARIA)!;
    assert.equal(maria.currentRecords.length, 2);
    assert.deepEqual(maria.currentRecords.map((record) => record.source), ['direct', 'company']);
    assert.ok(maria.currentRecords.some((record) => record.scopeLabel === 'All company hotels'));
    assert.ok(maria.currentRecords.some((record) => record.scopeLabel === 'This hotel'));

    const fiona = result.effectivePeople.find((person) => person.accountId === FIONA)!;
    assert.equal(fiona.currentRecords.length, 1, 'same-role direct rows should merge into one person record');
    assert.deepEqual(fiona.currentRecords[0].propertyIds, [A1, A2]);
    assert.equal(fiona.pendingRecords.length, 1);
    assert.equal(result.effectivePeople.filter((person) => person.accountId === FIONA).length, 1);
    assert.equal(result.effectivePeople.some((person) => person.accountId === FRANK), false);
    assert.equal(result.effectivePeople.some((person) => person.accountId === PENDING_ONLY), false);
    assert.deepEqual(result.pendingPeople.map((person) => person.accountId), [FIONA, PENDING_ONLY]);
  });

  test('keeps pending and revoked states out of active access', () => {
    const data = baseData();
    const context = resolveCompanyAccessContext(data, A1);
    const result = buildAccessPeople(data, context, MARIA);
    const fiona = result.effectivePeople.find((person) => person.accountId === FIONA)!;
    assert.equal(fiona.hasCurrentAccess, true);
    assert.equal(fiona.pendingRecords[0].status, 'pending');
    const vera = result.historyPeople.find((person) => person.displayName === 'Vera Former')!;
    assert.equal(vera.hasCurrentAccess, false);
    assert.equal(vera.history[0].status, 'revoked');
    assert.equal(result.peopleWithoutHotelAccess.some((person) => person.displayName === 'Vera Former'), false);
  });

  test('switching hotels changes the exact effective records without crossing companies', () => {
    const data = baseData();
    const switched = resolveCompanyAccessContext(data, A2);
    const result = buildAccessPeople(data, switched, MARIA);
    const fiona = result.effectivePeople.find((person) => person.accountId === FIONA)!;
    assert.deepEqual(fiona.currentRecords[0].propertyIds, [A1, A2]);
    assert.equal(fiona.currentRecords[0].scopeLabel, '2 selected hotels');
    assert.equal(result.effectivePeople.some((person) => person.accountId === FRANK), false);
  });

  test('fails closed for missing or ambiguous hotel-company context', () => {
    const data = baseData();
    assert.equal(resolveCompanyAccessContext(data, null).state, 'missing');
    assert.equal(resolveCompanyAccessContext(data, 'unknown').state, 'missing');
    const ambiguous = {
      ...data,
      properties: [...data.properties, {
        ...data.properties[0], nodeId: `${ORG_B}:${A1}`, organizationId: ORG_B,
      }],
    };
    assert.equal(resolveCompanyAccessContext(ambiguous, A1).state, 'ambiguous');
    assert.deepEqual(buildAccessPeople(data, resolveCompanyAccessContext(data, null), MARIA).people, []);
  });

  test('uses the server-targeted admin context and never exposes admin actions', () => {
    const data = baseData();
    const context = resolveCompanyAccessContext(data, A1, {
      kind: 'staxis_admin_preview', readOnly: true, requestedPropertyId: A1,
      scope: 'organization', targetId: ORG_A, targetName: 'North Star Hotels',
    });
    assert.equal(context.state, 'ready');
    const scrubbed = {
      ...data,
      viewerContext: {
        kind: 'staxis_admin_preview' as const, readOnly: true as const,
        requestedPropertyId: A1, scope: 'organization' as const,
        targetId: ORG_A, targetName: 'North Star Hotels',
      },
      permissions: { ...data.permissions, manageAccess: false, managePeople: false },
      memberships: data.memberships.map((membership) => ({
        ...membership,
        canSuspend: false, canResume: false, canRemove: false,
        grants: membership.grants.map((grant) => ({ ...grant, canRevoke: false })),
      })),
    };
    const result = buildAccessPeople(scrubbed, context, 'admin-account');
    assert.equal(result.effectivePeople.length, 2);
    assert.equal(scrubbed.permissions.manageAccess, false);
    assert.equal(scrubbed.memberships.some((membership) => membership.grants.some((grant) => grant.canRevoke)), false);
  });
});
