import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import {
  AmbiguousAdminCompanyPreviewTargetError,
  UnavailableAdminCompanyPreviewTargetError,
  adminPreviewWindowIsActive,
  assertExactSingleHotelRelationshipScope,
  makeAdminCompanyAccessReadOnly,
  resolveAdminCompanyPreviewTarget,
  runAdminPreviewReadWithRetry,
  type AdminCompanyPreviewViewerContext,
  type AdminPreviewOrganizationTarget,
} from '@/lib/company-access/admin-preview';
import { IncompleteCompanyProjectionError } from '@/lib/company-access/projection-query';
import { EMPTY_COMPANY_ACCESS, type CompanyAccessData } from '@/lib/company-access/dto';

const NOW = new Date('2026-07-20T15:00:00.000Z');
const PROPERTY = { id: 'property-1', name: 'Comfort Suites' };
const COMPANY: AdminPreviewOrganizationTarget = {
  id: 'organization-1',
  name: 'Northstar Management',
  organizationType: 'management_company',
  status: 'active',
  legacyPropertyId: null,
};
const ANCHOR: AdminPreviewOrganizationTarget = {
  id: 'anchor-1',
  name: 'Comfort Suites',
  organizationType: 'single_hotel',
  status: 'active',
  legacyPropertyId: PROPERTY.id,
};

const currentPrimary = (organizationId: string) => ({
  id: `relationship-${organizationId}`,
  organizationId,
  propertyId: PROPERTY.id,
  isPrimaryGrouping: true,
  startsAt: '2026-01-01T00:00:00.000Z',
  endsAt: null,
});

describe('admin Company Hub preview target resolution', () => {
  test('resolves a current primary real organization without creating an admin membership', () => {
    const target = resolveAdminCompanyPreviewTarget({
      property: PROPERTY,
      relationships: [currentPrimary(COMPANY.id)],
      organizations: [COMPANY, ANCHOR],
      now: NOW,
    });

    assert.equal(target.scope, 'organization');
    assert.equal(target.organization.id, COMPANY.id);
    assert.equal(target.property.id, PROPERTY.id);
  });

  test('uses only active primary windows and falls back to the exact hotel anchor', () => {
    const target = resolveAdminCompanyPreviewTarget({
      property: PROPERTY,
      relationships: [
        { ...currentPrimary(COMPANY.id), startsAt: '2026-08-01T00:00:00.000Z' },
        { ...currentPrimary(COMPANY.id), id: 'expired', endsAt: '2026-07-01T00:00:00.000Z' },
        { ...currentPrimary(COMPANY.id), id: 'non-primary', isPrimaryGrouping: false },
        currentPrimary(ANCHOR.id),
      ],
      organizations: [COMPANY, ANCHOR],
      now: NOW,
    });

    assert.equal(target.scope, 'property');
    assert.equal(target.organization?.id, ANCHOR.id);
    assert.equal(adminPreviewWindowIsActive(null, null, NOW), true);
    assert.equal(adminPreviewWindowIsActive('2026-08-01T00:00:00.000Z', null, NOW), false);
    assert.equal(adminPreviewWindowIsActive(null, '2026-07-01T00:00:00.000Z', NOW), false);
  });

  test('fails closed for ambiguous or unavailable primary topology', () => {
    const secondCompany: AdminPreviewOrganizationTarget = {
      ...COMPANY,
      id: 'organization-2',
      name: 'Second Company',
    };
    assert.throws(() => resolveAdminCompanyPreviewTarget({
      property: PROPERTY,
      relationships: [currentPrimary(COMPANY.id), currentPrimary(secondCompany.id)],
      organizations: [COMPANY, secondCompany, ANCHOR],
      now: NOW,
    }), AmbiguousAdminCompanyPreviewTargetError);

    assert.throws(() => resolveAdminCompanyPreviewTarget({
      property: PROPERTY,
      relationships: [currentPrimary(COMPANY.id)],
      organizations: [{ ...COMPANY, status: 'suspended' }, ANCHOR],
      now: NOW,
    }), UnavailableAdminCompanyPreviewTargetError);

    assert.throws(() => resolveAdminCompanyPreviewTarget({
      property: PROPERTY,
      relationships: [currentPrimary('missing-organization')],
      organizations: [ANCHOR],
      now: NOW,
    }), UnavailableAdminCompanyPreviewTargetError);
  });

  test('keeps an independent hotel exact even before its hidden anchor exists', () => {
    const target = resolveAdminCompanyPreviewTarget({
      property: PROPERTY,
      relationships: [],
      organizations: [],
      now: NOW,
    });
    assert.deepEqual(target, { scope: 'property', property: PROPERTY, organization: null });
  });

  test('fails closed when a single-hotel anchor is missing or contains another hotel', () => {
    assert.doesNotThrow(() => assertExactSingleHotelRelationshipScope({
      selectedPropertyId: PROPERTY.id,
      relationships: [currentPrimary(ANCHOR.id)],
      now: NOW,
    }));
    assert.throws(() => assertExactSingleHotelRelationshipScope({
      selectedPropertyId: PROPERTY.id,
      relationships: [],
      now: NOW,
    }), UnavailableAdminCompanyPreviewTargetError);
    assert.throws(() => assertExactSingleHotelRelationshipScope({
      selectedPropertyId: PROPERTY.id,
      relationships: [
        currentPrimary(ANCHOR.id),
        { ...currentPrimary(ANCHOR.id), id: 'foreign', propertyId: 'property-2' },
      ],
      now: NOW,
    }), UnavailableAdminCompanyPreviewTargetError);
  });
});

describe('admin Company Hub stable reads', () => {
  test('retries one incomplete paged read and then succeeds', async () => {
    let calls = 0;
    const value = await runAdminPreviewReadWithRetry(async () => {
      calls += 1;
      if (calls === 1) throw new IncompleteCompanyProjectionError('count changed');
      return 'ok';
    });
    assert.equal(value, 'ok');
    assert.equal(calls, 2);
  });

  test('retries at most once and never retries ordinary failures', async () => {
    let incompleteCalls = 0;
    await assert.rejects(runAdminPreviewReadWithRetry(async () => {
      incompleteCalls += 1;
      throw new IncompleteCompanyProjectionError('count changed');
    }), IncompleteCompanyProjectionError);
    assert.equal(incompleteCalls, 2);

    let ordinaryCalls = 0;
    await assert.rejects(runAdminPreviewReadWithRetry(async () => {
      ordinaryCalls += 1;
      throw new Error('database unavailable');
    }), /database unavailable/);
    assert.equal(ordinaryCalls, 1);
  });
});

describe('admin Company Hub preview read-only boundary', () => {
  const viewerContext: AdminCompanyPreviewViewerContext = {
    kind: 'staxis_admin_preview',
    readOnly: true,
    hub: 'company',
    requestedPropertyId: PROPERTY.id,
    scope: 'organization',
    targetId: COMPANY.id,
    targetName: COMPANY.name,
    organizationId: COMPANY.id,
  };

  test('scrubs every action and effective receipt at the final response boundary', () => {
    const unsafeProjection: CompanyAccessData = {
      ...EMPTY_COMPANY_ACCESS,
      memberships: [
        {
          id: 'admin-membership',
          organizationId: COMPANY.id,
          accountId: 'admin-account',
          displayName: 'Platform Admin',
          status: 'active',
          propertyIds: [PROPERTY.id],
          isCurrentUser: true,
          grants: [],
          canSuspend: true,
          canResume: true,
          canRemove: true,
        },
        {
          id: 'customer-membership',
          organizationId: COMPANY.id,
          accountId: 'customer-account',
          displayName: 'Customer Owner',
          status: 'active',
          propertyIds: [PROPERTY.id],
          isCurrentUser: true,
          grants: [{
            id: 'grant-1',
            accessProfile: 'organization_owner',
            scopeType: 'organization',
            scopeLabel: COMPANY.name,
            propertyIds: [PROPERTY.id],
            canRevoke: true,
          }],
          canSuspend: true,
          canResume: true,
          canRemove: true,
        },
      ],
      effectiveAccess: [{
        id: 'fake-admin-receipt',
        organizationId: COMPANY.id,
        accessProfile: 'organization_owner',
        scopeType: 'organization',
        scopeLabel: COMPANY.name,
        propertyIds: [PROPERTY.id],
        source: 'unsafe',
        status: 'active',
      }],
      invitations: [{
        id: 'invitation-1',
        organizationId: COMPANY.id,
        email: 'customer@example.test',
        accessProfile: 'viewer',
        scopeLabel: COMPANY.name,
        propertyIds: [PROPERTY.id],
        status: 'pending',
        canCancel: true,
      }],
      requests: [{
        id: 'request-1',
        organizationId: COMPANY.id,
        requesterName: 'Requester',
        requestedProfile: 'viewer',
        scopeLabel: COMPANY.name,
        propertyIds: [PROPERTY.id],
        status: 'pending',
        createdAt: NOW.toISOString(),
        canReview: true,
      }],
      permissions: {
        viewHotels: true,
        viewPeople: true,
        managePeople: true,
        manageInvitations: true,
        viewAccess: true,
        manageAccess: true,
        viewActivity: true,
        requestAccess: true,
        availableProfiles: ['organization_owner'],
        delegationPolicies: [{
          organizationId: COMPANY.id,
          profiles: [{
            accessProfile: 'organization_owner',
            organizationScope: true,
            portfolioIds: [],
            propertyIds: [],
          }],
        }],
      },
    };

    const preview = makeAdminCompanyAccessReadOnly({
      projection: unsafeProjection,
      viewerContext,
      adminAccountId: 'admin-account',
    });

    assert.equal(preview.memberships.length, 1);
    assert.equal(preview.memberships[0].accountId, 'customer-account');
    assert.equal(preview.memberships[0].isCurrentUser, false);
    assert.equal(preview.memberships[0].canSuspend, false);
    assert.equal(preview.memberships[0].canResume, false);
    assert.equal(preview.memberships[0].canRemove, false);
    assert.equal(preview.memberships[0].grants[0].canRevoke, false);
    assert.deepEqual(preview.effectiveAccess, []);
    assert.equal(preview.invitations[0].canCancel, false);
    assert.equal(preview.requests[0].canReview, false);
    assert.equal(preview.permissions.managePeople, false);
    assert.equal(preview.permissions.manageInvitations, false);
    assert.equal(preview.permissions.manageAccess, false);
    assert.equal(preview.permissions.requestAccess, false);
    assert.deepEqual(preview.permissions.availableProfiles, []);
    assert.deepEqual(preview.permissions.delegationPolicies, []);
    assert.deepEqual(preview.viewerContext, viewerContext);
  });
});

describe('admin Company Hub preview API contract', () => {
  const route = readFileSync(
    join(process.cwd(), 'src/app/api/admin/company-access-preview/route.ts'),
    'utf8',
  );

  test('requires an active Staxis admin and one UUID hotel selector', () => {
    assert.match(route, /requireAdmin\(req\)/);
    assert.match(route, /validateUuid\(new URL\(req\.url\)\.searchParams\.get\(['"]pid['"]\), ['"]pid['"]\)/);
    assert.match(route, /AdminCompanyPreviewPropertyNotFoundError/);
  });

  test('resolves scope server-side and never routes through customer actor projection', () => {
    assert.match(route, /resolveAdminCompanyPreviewTarget/);
    assert.match(route, /\.eq\(['"]property_id['"], pid\)/);
    assert.match(route, /\.eq\(['"]is_primary_grouping['"], true\)/);
    assert.doesNotMatch(route, /normalizedProjection|loadOrganizationActor|activeMembershipsForActor/);
  });

  test('returns an explicit no-store read-only preview and retries unstable reads', () => {
    assert.match(route, /makeAdminCompanyAccessReadOnly/);
    assert.match(route, /viewerContext/);
    assert.match(route, /kind: ['"]staxis_admin_preview['"]/);
    assert.match(route, /readOnly: true/);
    assert.match(route, /effectiveAccess: \[\]/);
    assert.match(route, /Cache-Control['"]?: ['"]no-store, max-age=0['"]/);
    assert.match(route, /runAdminPreviewReadWithRetry\(/);
    assert.match(route, /IncompleteCompanyProjectionError/);
    assert.match(route, /endingEpoch !== startingEpoch/);
  });

  test('uses bounded indexes and validates exact single-hotel scope', () => {
    const build = route.slice(
      route.indexOf('async function buildScopedProjection'),
      route.indexOf('function viewerContext'),
    );
    assert.doesNotMatch(build, /activeAssignments\.filter\(/);
    assert.doesNotMatch(build, /activeGrantRows\.filter\(\(grant\) => grant\.membership_id/);
    assert.doesNotMatch(build, /companyPortfolios\.find\(/);
    assert.match(build, /portfolioIdsByProperty\.get\(/);
    assert.match(build, /propertyIdsByPortfolio\.get\(/);
    assert.match(build, /grantsByMembership\.get\(/);
    assert.match(build, /portfolioById\.get\(/);
    assert.match(route, /ID_CHUNK_CONCURRENCY = 4/);
    assert.match(route, /assertExactSingleHotelRelationshipScope\(/);
  });

  test('contains no membership creation or customer mutation RPC', () => {
    assert.doesNotMatch(route, /\.insert\(|\.update\(|\.delete\(|\.rpc\(/);
    assert.doesNotMatch(route, /staxis_(?:grant|revoke|create_organization_invitation|review|change)/);
  });
});
