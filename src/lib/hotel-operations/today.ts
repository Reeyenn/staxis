/**
 * Canonical, versioned read contract for one hotel's operating day.
 *
 * This is deliberately a read model over the existing property-scoped RPCs,
 * not a new source of truth and not a writable aggregate. PMS-reported facts
 * and Staxis-owned `room_work` remain physically separate in Postgres; the
 * RPCs are responsible for projecting them without changing that ownership.
 */

import {
  fetchTodayPropertyCounts,
  fetchTodayRoomWork,
  type TodayPropertyCounts,
  type TodayRoomWorkRow,
} from '@/lib/db/today-room-work';

export const TODAY_HOTEL_OPERATIONS_CONTRACT_VERSION = 1 as const;

export interface TodayHotelOperations {
  contractVersion: typeof TODAY_HOTEL_OPERATIONS_CONTRACT_VERSION;
  propertyId: string;
  businessDate: string;
  rooms: TodayRoomWorkRow[];
  counts: TodayPropertyCounts;
  provenance: {
    rooms: 'today_room_work_v1';
    counts: 'today_property_counts_v1';
  };
}
export interface TodayHotelOperationsReadOptions {
  /** Preserve the existing bridge behavior: callers opt into surfaced errors. */
  throwOnError?: boolean;
}

interface AssembleTodayHotelOperationsInput {
  propertyId: string;
  businessDate: string;
  rooms: TodayRoomWorkRow[];
  counts: TodayPropertyCounts;
}

/** Pure assembler kept separate so contract shape can be parity-tested. */
export function assembleTodayHotelOperations(
  input: AssembleTodayHotelOperationsInput,
): TodayHotelOperations {
  return {
    contractVersion: TODAY_HOTEL_OPERATIONS_CONTRACT_VERSION,
    propertyId: input.propertyId,
    businessDate: input.businessDate,
    rooms: input.rooms,
    counts: input.counts,
    provenance: {
      rooms: 'today_room_work_v1',
      counts: 'today_property_counts_v1',
    },
  };
}

/**
 * Read the existing per-room and property-count projections together.
 *
 * Both source reads retain their current fallback/throw behavior. This facade
 * only gives consumers one stable contract to migrate toward incrementally.
 */
export async function fetchTodayHotelOperations(
  propertyId: string,
  businessDate: string,
  options: TodayHotelOperationsReadOptions = {},
): Promise<TodayHotelOperations> {
  const [rooms, counts] = await Promise.all([
    fetchTodayRoomWork(propertyId, businessDate, options),
    fetchTodayPropertyCounts(propertyId, businessDate, options),
  ]);

  return assembleTodayHotelOperations({
    propertyId,
    businessDate,
    rooms,
    counts,
  });
}
