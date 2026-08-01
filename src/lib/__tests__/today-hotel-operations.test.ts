import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  TODAY_HOTEL_OPERATIONS_CONTRACT_VERSION,
  assembleTodayHotelOperations,
} from '@/lib/hotel-operations';

describe('TodayHotelOperations contract', () => {
  it('preserves the existing room and count projections without merging ownership', () => {
    const rooms = [{
      room_number: '214',
      stay_type: 'C/O' as const,
      housekeeper: 'Alex',
      stayover_day: null,
    }];
    const counts = {
      checkouts: 1,
      stayovers: 0,
      vacant_clean: 10,
      vacant_dirty: 2,
      ooo: 1,
      total_rooms: 14,
      total_checkouts_today: 1,
      in_house: 8,
    };

    const result = assembleTodayHotelOperations({
      propertyId: 'property-a',
      businessDate: '2026-07-31',
      rooms,
      counts,
    });

    assert.equal(result.contractVersion, TODAY_HOTEL_OPERATIONS_CONTRACT_VERSION);
    assert.equal(result.propertyId, 'property-a');
    assert.equal(result.businessDate, '2026-07-31');
    assert.equal(result.rooms, rooms);
    assert.equal(result.counts, counts);
    assert.deepEqual(result.provenance, {
      rooms: 'today_room_work_v1',
      counts: 'today_property_counts_v1',
    });
  });
});
