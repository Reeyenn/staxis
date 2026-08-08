import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import {
  ALL_HOTELS_FILTER,
  conversationsWithHotelContext,
  hotelConversationKey,
  hotelScopeOptions,
  sortHotelConversations,
  visibleHotelConversations,
  type HotelBootstrap,
} from '@/app/communications/_components/comms-hotels';

const HOTEL_A = '11111111-1111-4111-8111-111111111111';
const HOTEL_B = '22222222-2222-4222-8222-222222222222';
const HOTEL_OUTSIDE_SCOPE = '33333333-3333-4333-8333-333333333333';

function bootstrap(propertyId: string, propertyName: string, overrides: Record<string, unknown> = {}): HotelBootstrap {
  return {
    propertyId,
    propertyName,
    data: {
      me: { staffId: `staff-${propertyId}`, role: 'manager', isManager: true, dept: null, lang: 'en', displayName: 'Manager' },
      conversations: [{
        id: `conversation-${propertyId}`,
        kind: 'channel',
        channelKey: 'all_staff',
        title: 'All Staff',
        lastMessageAt: '2026-08-08T12:00:00.000Z',
        lastMessagePreview: 'Hello',
        unread: 0,
        pendingAck: 0,
      }],
      staff: [],
      unreadTotal: 0,
      onlineStaffIds: [],
      ...overrides,
    },
  };
}

describe('Messages hotel scope/filter composition', () => {
  test('company scope uses only the current authoritative hotel ids', () => {
    const options = hotelScopeOptions({
      activePropertyId: HOTEL_A,
      activeScope: { kind: 'company', scope: { propertyIds: [HOTEL_A, HOTEL_B] } },
      properties: [
        { id: HOTEL_A, name: 'Harbor Inn' },
        { id: HOTEL_B, name: 'Lakeside Hotel' },
        { id: HOTEL_OUTSIDE_SCOPE, name: 'Outside Hotel' },
      ] as never,
    });
    assert.deepEqual(options, [
      { propertyId: HOTEL_A, propertyName: 'Harbor Inn' },
      { propertyId: HOTEL_B, propertyName: 'Lakeside Hotel' },
    ]);
  });

  test('single hotel scope stays one hotel and cannot render All hotels choices', () => {
    const options = hotelScopeOptions({
      activePropertyId: HOTEL_A,
      activeScope: { kind: 'hotel', propertyId: HOTEL_A },
      properties: [{ id: HOTEL_A, name: 'Harbor Inn' }] as never,
    });
    assert.deepEqual(options, [{ propertyId: HOTEL_A, propertyName: 'Harbor Inn' }]);
    assert.equal(options.length > 1, false);
  });

  test('all and specific filters retain hotel identity and composite keys', () => {
    const conversations = [
      ...conversationsWithHotelContext(bootstrap(HOTEL_A, 'Harbor Inn')),
      ...conversationsWithHotelContext(bootstrap(HOTEL_B, 'Lakeside Hotel')),
    ];
    assert.equal(conversations[0].propertyName, 'Harbor Inn');
    assert.equal(visibleHotelConversations(conversations, ALL_HOTELS_FILTER).length, 2);
    assert.deepEqual(visibleHotelConversations(conversations, HOTEL_B).map((c) => c.propertyId), [HOTEL_B]);
    assert.notEqual(hotelConversationKey(HOTEL_A, conversations[0].id), hotelConversationKey(HOTEL_B, conversations[0].id));
  });

  test('aggregate ordering remains attention-first then most recent', () => {
    const older = bootstrap(HOTEL_A, 'Harbor Inn', { conversations: [{
      id: 'older', kind: 'channel', channelKey: 'all_staff', title: 'Older', lastMessageAt: '2026-08-01T12:00:00.000Z', lastMessagePreview: 'old', unread: 0,
    }] });
    const urgent = bootstrap(HOTEL_B, 'Lakeside Hotel', { conversations: [{
      id: 'urgent', kind: 'channel', channelKey: 'all_staff', title: 'Urgent', lastMessageAt: '2026-08-01T01:00:00.000Z', lastMessagePreview: 'new', unread: 1,
    }] });
    assert.deepEqual(sortHotelConversations([
      ...conversationsWithHotelContext(older),
      ...conversationsWithHotelContext(urgent),
    ]).map((c) => c.id), ['urgent', 'older']);
  });

  test('new hotel selector is labeled and has a mobile-sized target', () => {
    const source = readFileSync(join(process.cwd(), 'src/app/communications/_components/CommsApp.tsx'), 'utf8');
    assert.match(source, /aria-label=\{'Filter messages by hotel'\}/);
    assert.match(source, /<option value=\{ALL_HOTELS_FILTER\}>\{'All hotels'\}<\/option>/);
    assert.match(source, /minHeight: 44/);
  });
});
