import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  HOTEL_ACTING_CONTEXT_VERSION,
  parseHotelActingContext,
  type HotelActingContextV1,
} from '@/lib/portfolio-ui/hotel-acting-contract';

const ORG = 'aaaaaaaa-0000-4000-8000-000000000001';
const HOTEL = '11111111-0000-4000-8000-000000000001';

function sections(): HotelActingContextV1['sectionAvailability'] {
  return {
    dashboard: true,
    housekeeping: true,
    communications: true,
    maintenance: true,
    inventory: true,
    staff: true,
    financials: true,
    staxis: true,
  };
}

function portfolioContext(): HotelActingContextV1 {
  return {
    version: HOTEL_ACTING_CONTEXT_VERSION,
    verifiedAt: '2026-07-28T12:00:00.000Z',
    source: 'portfolio',
    organization: { id: ORG, name: 'Gulf Coast Hotels' },
    parentScope: { kind: 'company', id: ORG, name: 'Gulf Coast Hotels' },
    property: {
      id: HOTEL,
      name: 'Comfort Suites',
      region: 'North Texas',
      totalRooms: 84,
      timezone: 'America/Chicago',
    },
    standing: {
      operationalRole: 'front_desk',
      localHotelAccess: false,
      hotelDetailRead: true,
      hotelMutationAllowed: false,
      seesFinancials: true,
      portfolioIntelligenceRead: true,
    },
    portfolioFeatures: { queueAvailable: true },
    sectionAvailability: sections(),
  };
}

describe('hotel acting-context wire contract', () => {
  test('accepts a safe portfolio-origin read-only context', () => {
    assert.deepEqual(parseHotelActingContext(portfolioContext()), portfolioContext());
  });

  test('accepts a deliberate local hotel context without a portfolio parent', () => {
    const local: HotelActingContextV1 = {
      ...portfolioContext(),
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
    assert.deepEqual(parseHotelActingContext(local), local);
  });

  test('keeps portfolio detail reach distinct from local hotel authority', () => {
    const localElevation = portfolioContext();
    localElevation.standing.localHotelAccess = true;
    assert.equal(parseHotelActingContext(localElevation), null);

    const missingDetailReach = portfolioContext();
    missingDetailReach.standing.hotelDetailRead = false;
    assert.equal(parseHotelActingContext(missingDetailReach), null);

    // A person can legitimately hold both a portfolio job and an exact local
    // hotel assignment. The server—not the URL or this parser—derives that
    // mutation bit from the current per-hotel standing.
    const exactLocalWrite = portfolioContext();
    exactLocalWrite.standing.hotelMutationAllowed = true;
    assert.deepEqual(parseHotelActingContext(exactLocalWrite), exactLocalWrite);
  });

  test('rejects a local context without an explicit local standing', () => {
    const value = {
      ...portfolioContext(),
      source: 'local',
      organization: null,
      parentScope: null,
      standing: {
        ...portfolioContext().standing,
        localHotelAccess: false,
        hotelDetailRead: false,
      },
    };
    assert.equal(parseHotelActingContext(value), null);
  });

  test('rejects malformed, extra-field, incomplete-section, and admin-role responses', () => {
    const extra = { ...portfolioContext(), receiptId: 'secret' };
    assert.equal(parseHotelActingContext(extra), null);

    const { financials: _financials, ...incompleteSections } = sections();
    const incomplete = {
      ...portfolioContext(),
      sectionAvailability: incompleteSections,
    };
    assert.equal(parseHotelActingContext(incomplete), null);

    assert.equal(parseHotelActingContext({
      ...portfolioContext(),
      standing: { ...portfolioContext().standing, operationalRole: 'admin' },
    }), null);
    assert.equal(parseHotelActingContext({
      ...portfolioContext(),
      verifiedAt: 'not-a-date',
    }), null);
  });
});
