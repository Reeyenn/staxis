/**
 * "Find a clean room of type X" for the walk-in flow.
 *
 *   - Looks at pms_room_status_log for the latest status per room
 *     (matches the "current status of room X" pattern from migration
 *     0202, table 4) and keeps only rooms whose latest status is
 *     'inspected' or 'vacant_clean'.
 *   - Cross-references pms_rooms_inventory to filter by room_type.
 *   - Excludes rooms that already have a reservation arriving today
 *     (don't double-book).
 *   - Tie-breaks by "least recently changed" (oldest inspected wins) so
 *     the room that's been waiting longest gets used first.
 *
 * Returns at most one candidate. If no PMS data exists yet for the
 * property (greenfield / brand new hotel), falls back to the manager-side
 * `rooms` table — picks the oldest clean+inspected row of that type
 * for today.
 */

import { supabaseAdmin } from '@/lib/supabase-admin';
import { log } from '@/lib/log';

export interface NextReadyRoomInput {
  propertyId: string;
  roomType: string;
  /** Today's business date in the property TZ (YYYY-MM-DD). */
  today: string;
}

export interface NextReadyRoomCandidate {
  roomNumber: string;
  roomType: string;
  source: 'pms' | 'rooms_fallback';
  /** When the room entered its current status (for tie-break visibility). */
  readySince: string | null;
}

/**
 * Internal: the latest-status row per room_number from pms_room_status_log.
 * Mirrors the "current status of room X" intent of the index
 * `pms_room_status_log_current_idx` (property_id, room_number, changed_at desc).
 */
interface LatestStatusRow {
  roomNumber: string;
  status: string;
  changedAt: string;
}

async function loadLatestPmsStatuses(propertyId: string): Promise<LatestStatusRow[]> {
  // PostgREST doesn't have a clean DISTINCT ON; pull recent rows ordered
  // by (room_number asc, changed_at desc) and dedupe in JS. Cap at 2000
  // to keep the response bounded — even a 200-room hotel rarely has
  // >10 rows per room in the last 7 days of churn.
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabaseAdmin
    .from('pms_room_status_log')
    .select('room_number, status, changed_at')
    .eq('property_id', propertyId)
    .gte('changed_at', sevenDaysAgo)
    .order('room_number', { ascending: true })
    .order('changed_at', { ascending: false })
    .limit(2000);
  if (error) {
    log.warn('[next-ready-room] pms_room_status_log read failed', {
      propertyId, err: error.message,
    });
    return [];
  }
  const seen = new Set<string>();
  const out: LatestStatusRow[] = [];
  for (const row of data ?? []) {
    const r = row as { room_number: string; status: string; changed_at: string };
    if (seen.has(r.room_number)) continue;
    seen.add(r.room_number);
    out.push({ roomNumber: r.room_number, status: r.status, changedAt: r.changed_at });
  }
  return out;
}

/**
 * Returns the "best" ready room of the requested type, or null if
 * nothing matches. "Best" = the room that has been clean/inspected
 * the longest (FIFO across ready rooms).
 */
export async function findNextReadyRoom(
  input: NextReadyRoomInput,
): Promise<NextReadyRoomCandidate | null> {
  // Step 1: build {room → type} from pms_rooms_inventory for type filtering.
  const { data: inv, error: invErr } = await supabaseAdmin
    .from('pms_rooms_inventory')
    .select('room_number, room_type')
    .eq('property_id', input.propertyId);
  if (invErr) {
    log.warn('[next-ready-room] pms_rooms_inventory read failed', {
      propertyId: input.propertyId, err: invErr.message,
    });
  }
  const typeByRoom = new Map<string, string | null>();
  for (const row of inv ?? []) {
    const r = row as { room_number: string; room_type: string | null };
    typeByRoom.set(r.room_number, r.room_type);
  }

  // Step 2: rooms with an arrival today — exclude these so a walk-in
  // doesn't get assigned a room someone else is checking into.
  const { data: arrivals, error: arrErr } = await supabaseAdmin
    .from('pms_reservations')
    .select('room_number')
    .eq('property_id', input.propertyId)
    .eq('arrival_date', input.today);
  if (arrErr) {
    log.warn('[next-ready-room] pms_reservations read failed', {
      propertyId: input.propertyId, err: arrErr.message,
    });
  }
  const arrivalRooms = new Set<string>();
  for (const a of arrivals ?? []) {
    const num = (a as { room_number?: string | null }).room_number;
    if (num) arrivalRooms.add(num);
  }

  // Step 3: PMS-latest path. Walk pms_room_status_log → keep
  // 'inspected' / 'vacant_clean' / 'clean' → filter by type + arrival
  // exclusion → pick oldest changed_at.
  const latest = await loadLatestPmsStatuses(input.propertyId);
  const readyStatuses = new Set(['inspected', 'vacant_clean']);
  const candidates = latest
    .filter((r) => readyStatuses.has(r.status))
    .filter((r) => !arrivalRooms.has(r.roomNumber))
    .filter((r) => {
      // If we have inventory data, enforce the type match. If we don't,
      // (brand-new hotel pre-CUA pull), skip the filter — we still
      // need SOMETHING for the front desk to assign.
      if (typeByRoom.size === 0) return true;
      const t = typeByRoom.get(r.roomNumber);
      if (!t) return false;
      return t.toLowerCase() === input.roomType.toLowerCase();
    })
    .sort((a, b) => a.changedAt.localeCompare(b.changedAt));

  if (candidates.length > 0) {
    const winner = candidates[0];
    return {
      roomNumber: winner.roomNumber,
      roomType: typeByRoom.get(winner.roomNumber) ?? input.roomType,
      source: 'pms',
      readySince: winner.changedAt,
    };
  }

  // Step 4: rooms-table fallback (no PMS data yet). Pick today's oldest
  // clean+inspected row of the requested type. The manager UI's "rooms"
  // table doesn't carry room_type explicitly — the closest analogue is
  // checking the inventory join. If inventory is empty too, give up.
  if (typeByRoom.size === 0) {
    return null;
  }

  const candidateRoomNumbers = Array.from(typeByRoom.entries())
    .filter(([num, t]) => t && t.toLowerCase() === input.roomType.toLowerCase() && !arrivalRooms.has(num))
    .map(([num]) => num);

  if (candidateRoomNumbers.length === 0) return null;

  const { data: fallback, error: fbErr } = await supabaseAdmin
    .from('rooms')
    .select('number, status, completed_at, inspected_at')
    .eq('property_id', input.propertyId)
    .eq('date', input.today)
    .in('status', ['clean', 'inspected'])
    .in('number', candidateRoomNumbers);
  if (fbErr) {
    log.warn('[next-ready-room] rooms fallback read failed', {
      propertyId: input.propertyId, err: fbErr.message,
    });
    return null;
  }
  const ranked = (fallback ?? [])
    .map((r) => {
      const row = r as {
        number: string;
        status: string;
        completed_at: string | null;
        inspected_at: string | null;
      };
      const t = row.inspected_at ?? row.completed_at ?? '';
      return { number: row.number, readySince: t };
    })
    .sort((a, b) => a.readySince.localeCompare(b.readySince));

  if (ranked.length === 0) return null;
  return {
    roomNumber: ranked[0].number,
    roomType: input.roomType,
    source: 'rooms_fallback',
    readySince: ranked[0].readySince || null,
  };
}
