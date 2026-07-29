import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { HotelActingContextV1 } from '@/lib/portfolio-ui/hotel-acting-contract';
import { portfolioHotelSurfacePolicy } from '@/lib/portfolio-ui/hotel-path-policy';

const ORG = 'aaaaaaaa-0000-4000-8000-000000000001';
const HOTEL = '11111111-0000-4000-8000-000000000001';

function portfolioContext(): HotelActingContextV1 {
  return {
    version: 'hotel-acting-context.v1',
    verifiedAt: '2026-07-28T12:00:00.000Z',
    source: 'portfolio',
    organization: { id: ORG, name: 'Gulf Coast Hotels' },
    parentScope: { kind: 'company', id: ORG, name: 'Gulf Coast Hotels' },
    property: {
      id: HOTEL, name: 'Comfort Suites', region: 'North Texas', totalRooms: 84,
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
      dashboard: true,
      housekeeping: true,
      communications: true,
      maintenance: true,
      inventory: true,
      staff: true,
      financials: true,
      staxis: true,
    },
  };
}

describe('portfolio-origin hotel path policy', () => {
  test('maps allowed destinations to separate restricted implementations', () => {
    const context = portfolioContext();
    assert.deepEqual(portfolioHotelSurfacePolicy(context, '/home'), { mode: 'restricted_home' });
    assert.deepEqual(portfolioHotelSurfacePolicy(context, '/financials'), { mode: 'readonly_financials' });
    assert.deepEqual(portfolioHotelSurfacePolicy(context, '/maintenance'), {
      mode: 'restricted_section', section: 'maintenance',
    });
    assert.deepEqual(portfolioHotelSurfacePolicy(context, '/company'), { mode: 'my_portfolio' });
    assert.deepEqual(portfolioHotelSurfacePolicy(context, '/feed'), { mode: 'portfolio_feed' });
  });

  test('never allows a portfolio drill-down to mount private hotel detail paths', () => {
    const context = portfolioContext();
    for (const path of [
      '/settings', '/onboard', '/laundry', '/housekeeper', '/maintenance/private-id',
      '/financials/capex/private-id', '//evil', '/../settings',
    ]) {
      assert.deepEqual(portfolioHotelSurfacePolicy(context, path), {
        mode: 'denied', reason: 'private_hotel_detail',
      }, path);
    }
  });

  test('financial, queue, and section doors remain independent and fail closed', () => {
    const noFinance = portfolioContext();
    noFinance.standing.seesFinancials = false;
    assert.deepEqual(portfolioHotelSurfacePolicy(noFinance, '/financials'), {
      mode: 'denied', reason: 'financials_forbidden',
    });

    const noQueue = portfolioContext();
    noQueue.portfolioFeatures.queueAvailable = false;
    assert.deepEqual(portfolioHotelSurfacePolicy(noQueue, '/feed'), {
      mode: 'denied', reason: 'queue_unavailable',
    });

    const disabled = portfolioContext();
    disabled.sectionAvailability.housekeeping = false;
    assert.deepEqual(portfolioHotelSurfacePolicy(disabled, '/housekeeping'), {
      mode: 'denied', reason: 'section_disabled',
    });
  });

  test('a deliberate local context preserves the existing hotel application', () => {
    const local: HotelActingContextV1 = {
      ...portfolioContext(),
      source: 'local',
      organization: null,
      parentScope: null,
      standing: {
        ...portfolioContext().standing,
        operationalRole: 'general_manager',
        localHotelAccess: true,
        hotelDetailRead: true,
        hotelMutationAllowed: true,
      },
      portfolioFeatures: { queueAvailable: false },
    };
    for (const path of ['/home', '/communications', '/settings', '/laundry/123']) {
      assert.deepEqual(portfolioHotelSurfacePolicy(local, path), { mode: 'local' }, path);
    }
  });
});
