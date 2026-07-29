import assert from 'node:assert/strict';
import test from 'node:test';

import {
  hotelActingContextMatchesRequest,
  resolveHotelActingRequest,
} from '@/lib/portfolio-ui/hotel-acting-request';
import type { HotelActingContextV1 } from '@/lib/portfolio-ui/hotel-acting-contract';

const ORGANIZATION_ID = '11111111-1111-4111-8111-111111111111';
const PROPERTY_ID = '22222222-2222-4222-8222-222222222222';
const PORTFOLIO_ID = '33333333-3333-4333-8333-333333333333';
const DESCRIPTOR_ID = '44444444-4444-4444-8444-444444444444';

test('ordinary hotel routes remain in the existing local app context', () => {
  assert.deepEqual(resolveHotelActingRequest({
    pathname: '/home',
    search: '?unrelated=value',
  }), {
    kind: 'local_app',
    requestKey: 'local:/home',
  });
});

test('portfolio routes quiesce hotel-local providers without requiring a scope query', () => {
  const result = resolveHotelActingRequest({
    pathname: '/portfolio/maintenance',
    search: `?organizationId=${ORGANIZATION_ID}&status=attention`,
  });
  assert.equal(result.kind, 'portfolio_scope');
  if (result.kind !== 'portfolio_scope') return;
  assert.equal(result.context, null);
});

test('portfolio-origin hotel request carries selectors but no client hotel set', () => {
  const result = resolveHotelActingRequest({
    pathname: '/maintenance',
    search: `?scope=hotel&organizationId=${ORGANIZATION_ID}&descriptorId=${DESCRIPTOR_ID}&propertyId=${PROPERTY_ID}&returnTo=%2Fportfolio%2Fmaintenance%3Fstatus%3Dattention`,
  });
  assert.equal(result.kind, 'hotel');
  if (result.kind !== 'hotel') return;
  assert.equal(
    result.endpoint,
    `/api/portfolio/v1/hotel-context?scope=hotel&propertyId=${PROPERTY_ID}&organizationId=${ORGANIZATION_ID}&descriptorId=${DESCRIPTOR_ID}`,
  );
  assert.equal(result.returnTo, '/portfolio/maintenance?status=attention');
  assert.equal(result.endpoint.includes('propertyIds'), false);
});

test('native portfolio-origin hotel request preserves the one portfolio selector', () => {
  const result = resolveHotelActingRequest({
    pathname: '/financials',
    search: `?scope=hotel&organizationId=${ORGANIZATION_ID}&portfolioId=${PORTFOLIO_ID}&propertyId=${PROPERTY_ID}`,
  });
  assert.equal(result.kind, 'hotel');
  if (result.kind !== 'hotel') return;
  assert.match(result.endpoint, new RegExp(`portfolioId=${PORTFOLIO_ID}`));
  assert.equal(result.context.descriptorId, undefined);
});

test('duplicate and mixed selectors fail before any request is made', () => {
  const duplicate = resolveHotelActingRequest({
    pathname: '/home',
    search: `?scope=hotel&scope=hotel&propertyId=${PROPERTY_ID}`,
  });
  assert.equal(duplicate.kind, 'invalid');
  if (duplicate.kind === 'invalid') assert.equal(duplicate.error, 'duplicate_reserved_key');

  const mixed = resolveHotelActingRequest({
    pathname: '/home',
    search: `?scope=hotel&organizationId=${ORGANIZATION_ID}&portfolioId=${PORTFOLIO_ID}&descriptorId=${DESCRIPTOR_ID}&propertyId=${PROPERTY_ID}`,
  });
  assert.equal(mixed.kind, 'invalid');
  if (mixed.kind === 'invalid') assert.equal(mixed.error, 'unexpected_descriptor_id');
});

test('destination path is part of the hotel request identity', () => {
  const search = `?scope=hotel&propertyId=${PROPERTY_ID}`;
  const home = resolveHotelActingRequest({ pathname: '/home', search });
  const staff = resolveHotelActingRequest({ pathname: '/staff', search });
  assert.equal(home.kind, 'hotel');
  assert.equal(staff.kind, 'hotel');
  assert.notEqual(home.requestKey, staff.requestKey);
});

function portfolioContext(parent: HotelActingContextV1['parentScope']): HotelActingContextV1 {
  return {
    version: 'hotel-acting-context.v1',
    verifiedAt: '2026-07-28T00:00:00.000Z',
    source: 'portfolio',
    organization: { id: ORGANIZATION_ID, name: 'Example Management' },
    parentScope: parent,
    property: {
      id: PROPERTY_ID,
      name: 'Example Hotel',
      region: 'North',
      totalRooms: 91,
      timezone: 'America/Chicago',
    },
    standing: {
      operationalRole: 'front_desk',
      localHotelAccess: false,
      hotelDetailRead: false,
      hotelMutationAllowed: false,
      seesFinancials: true,
      portfolioIntelligenceRead: true,
    },
    portfolioFeatures: { queueAvailable: true },
    sectionAvailability: {
      staxis: true,
      dashboard: true,
      housekeeping: true,
      communications: true,
      maintenance: true,
      inventory: true,
      staff: true,
      financials: true,
    },
  };
}

test('response binding rejects a stale or substituted parent descriptor', () => {
  const request = resolveHotelActingRequest({
    pathname: '/home',
    search: `?scope=hotel&organizationId=${ORGANIZATION_ID}&descriptorId=${DESCRIPTOR_ID}&propertyId=${PROPERTY_ID}`,
  });
  assert.equal(request.kind, 'hotel');
  if (request.kind !== 'hotel') return;

  assert.equal(hotelActingContextMatchesRequest(request, portfolioContext({
    kind: 'selected_hotels',
    id: DESCRIPTOR_ID,
    name: 'Select Service',
  })), true);
  assert.equal(hotelActingContextMatchesRequest(request, portfolioContext({
    kind: 'company',
    id: ORGANIZATION_ID,
    name: 'Example Management',
  })), false);
});

test('local response binding cannot inherit portfolio provenance', () => {
  const request = resolveHotelActingRequest({
    pathname: '/home',
    search: `?scope=hotel&propertyId=${PROPERTY_ID}`,
  });
  assert.equal(request.kind, 'hotel');
  if (request.kind !== 'hotel') return;
  assert.equal(hotelActingContextMatchesRequest(request, portfolioContext({
    kind: 'company',
    id: ORGANIZATION_ID,
    name: 'Example Management',
  })), false);

  const local: HotelActingContextV1 = {
    ...portfolioContext(null),
    source: 'local',
    organization: null,
    parentScope: null,
    standing: {
      operationalRole: 'general_manager',
      localHotelAccess: true,
      hotelDetailRead: true,
      hotelMutationAllowed: true,
      seesFinancials: true,
      portfolioIntelligenceRead: false,
    },
    portfolioFeatures: { queueAvailable: false },
  };
  assert.equal(hotelActingContextMatchesRequest(request, local), true);
});
