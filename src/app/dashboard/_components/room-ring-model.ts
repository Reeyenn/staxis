import type { Room } from '@/types';
import type { RingKey } from './palette';
import type { RingTick } from './RoomRing';

type RingRoom = Pick<Room, 'number' | 'status' | 'statusSource' | 'type' | 'arrival'> & {
  isOutOfService?: boolean;
};

function hasObservedStatusSource(room: RingRoom): boolean {
  return room.statusSource === 'assignment' || room.statusSource === 'pms';
}

/**
 * Translate only room-level facts into the ring vocabulary.
 *
 * Aggregate property counts deliberately do not participate here. A room tick
 * names a specific room, so its colour must come from a fact attached to that
 * same room. Missing/default provenance stays neutral instead of borrowing a
 * status from a property-wide total.
 */
export function ringStatusForRoom(room: RingRoom): RingKey {
  // `isOutOfService` is itself an explicit room-level fact and does not need
  // housekeeping-status provenance to remain truthful.
  if (room.isOutOfService) return 'ooo';
  if (!hasObservedStatusSource(room)) return 'none';

  if (room.status === 'in_progress') return 'inprog';
  if (room.status === 'dirty') return 'dirty';

  // Reservation context is also room-specific. It can make a clean
  // housekeeping state more precise without inventing an occupancy identity.
  if (room.arrival) return 'arriving';
  if (room.type === 'stayover') return 'occupied';
  if (room.type === 'checkout') return 'departing';

  return 'clean';
}

/**
 * Build one tick per real room identity.
 *
 * `roomInventory` is the hotel's canonical roster. Rooms returned by today's
 * operational feed are appended when the roster has not caught up yet. A
 * roster-only room has no observed status and therefore renders as `none`.
 */
export function buildRoomRingTicks(
  rooms: readonly RingRoom[],
  roomInventory: readonly string[] = [],
): RingTick[] {
  const roomByNumber = new Map<string, RingRoom>();
  for (const room of rooms) {
    const number = room.number.trim();
    if (!number) continue;

    const previous = roomByNumber.get(number);
    // Prefer an observed duplicate over a default/no-signal duplicate. The
    // normal server contract emits one row per room, but this keeps the visual
    // truthful through a transient duplicate rather than depending on order.
    if (!previous || (!hasObservedStatusSource(previous) && hasObservedStatusSource(room))) {
      roomByNumber.set(number, room);
    }
  }

  const identities: string[] = [];
  const seen = new Set<string>();
  const addIdentity = (raw: string) => {
    const number = raw.trim();
    if (!number || seen.has(number)) return;
    seen.add(number);
    identities.push(number);
  };

  roomInventory.forEach(addIdentity);
  rooms.forEach((room) => addIdentity(room.number));

  return identities.map((number, idx) => {
    const room = roomByNumber.get(number);
    return {
      idx,
      num: number,
      status: room ? ringStatusForRoom(room) : 'none',
    };
  });
}
