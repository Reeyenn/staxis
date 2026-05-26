/**
 * Component-rooms helpers — multi-room suites cleaned as one unit.
 *
 * The persistence shape (`component_rooms` table, migration 0225):
 *   - parent_room_number: the room number the housekeeper sees on their
 *     queue (e.g. "305")
 *   - child_room_numbers: jsonb array of the sub-rooms the suite contains
 *     (e.g. ["305A", "305B", "305C"]). These rooms still exist as their
 *     own `rooms` rows so other surfaces (manager dashboard, PMS sync)
 *     can address them individually.
 *
 * UI flow on the housekeeper page:
 *   - The room list is filtered by collapseChildComponents() so child
 *     rooms don't render as separate cards.
 *   - The parent room card renders with the "Suite · 305 (includes 305A,
 *     305B, 305C)" badge.
 *   - The complete-clean action fans out: completing the parent applies
 *     the same transition to every child via fanOutChildCompletions().
 */
import type { Room } from '@/types';

export interface ComponentRoomLink {
  parent_room_number: string;
  child_room_numbers: string[];
  label?: string | null;
}

/**
 * Drop any room from `rooms` whose number appears in some component
 * parent's child_room_numbers list. Returns the filtered list.
 *
 * O(n + total children) — both small in practice.
 */
export function collapseChildComponents(
  rooms: Room[],
  components: ComponentRoomLink[],
): Room[] {
  if (!components || components.length === 0) return rooms;
  const childSet = new Set<string>();
  for (const c of components) {
    for (const child of c.child_room_numbers) childSet.add(child);
  }
  if (childSet.size === 0) return rooms;
  return rooms.filter((r) => !childSet.has(r.number));
}

/**
 * Look up the component-room link a given room is the parent of. Returns
 * null if the room is a regular non-component room.
 */
export function componentForRoom(
  roomNumber: string,
  components: ComponentRoomLink[],
): ComponentRoomLink | null {
  return components.find((c) => c.parent_room_number === roomNumber) ?? null;
}

/**
 * Convenience: format the "includes" label for the JobCard.
 */
export function formatComponentLabel(link: ComponentRoomLink): string {
  return link.child_room_numbers.join(' · ');
}
