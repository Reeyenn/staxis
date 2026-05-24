// ═══════════════════════════════════════════════════════════════════════════
// pms-rooms-server — server-only merge: pms_* tables → legacy Room shape.
//
// Why this exists:
//   Plan v4 (migration 0204) dropped the legacy `rooms` table. Live room
//   status now flows into 15 service-role-only `pms_*` tables written by
//   the persistent CUA browser per hotel. The housekeeping page (and
//   dashboard, front-desk, etc.) still consume the camel-cased `Room`
//   shape from `src/types`. This module bridges the two without changing
//   the UI: pull the four relevant pms_* feeds, dedupe to "current per
//   room", and emit Room[] in the legacy shape.
//
// Server-only:
//   pms_* tables are RLS deny-all-browser (migration 0202). The browser
//   anon/authenticated clients cannot read them. This module imports
//   `supabaseAdmin` and MUST never be imported from a client-side file —
//   doing so would crash at module load (supabase-admin.ts throws when
//   env vars are missing on the browser side). The data path is:
//
//     browser  →  /api/housekeeping/rooms  →  mergePmsRoomsForDate()
//                                            (this file, supabaseAdmin)
//
// Mapping notes (legacy Room field ← new pms_* source):
//   number          ← pms_rooms_inventory.room_number
//   type            ← derived from pms_housekeeping_assignments.cleaning_type
//                     ('departure'→'checkout', 'stayover'→'stayover',
//                     else 'vacant')
//   priority        ← always 'standard' (no clean source in new schema)
//   status          ← derived from (assignment in-progress?) +
//                     latest pms_room_status_log.status:
//                       started_at AND NOT completed_at → 'in_progress'
//                       latest = 'inspected'            → 'inspected'
//                       latest ends with '_clean'       → 'clean'
//                       latest in {'vacant_dirty','occupied_dirty',
//                                  'occupied','out_of_order',
//                                  'out_of_inventory','unknown',null} → 'dirty'
//   assignedTo      ← lookup staff by name match against
//                     pms_housekeeping_assignments.housekeeper_name; null
//                     if no match (the "On the floor" strip degrades to
//                     empty for unmapped names — see UI line 272-289)
//   assignedName    ← pms_housekeeping_assignments.housekeeper_name
//   startedAt       ← pms_housekeeping_assignments.started_at
//   completedAt     ← pms_housekeeping_assignments.completed_at
//   isDnd           ← pms_housekeeping_assignments.dnd_active
//   arrival         ← if pms_reservations.arrival_date == date AND
//                     status IN ('booked','checked_in'): formatted M/D/YY
//   stayoverDay     ← if reservation overlaps date (arrival < date <
//                     departure), date - arrival_date in nights
//   stayoverMinutes ← undefined (Optii-style time classification not in
//                     the new schema)
//   issueNote, inspectedBy, inspectedAt, dndNote, helpRequested,
//   checklist, photoUrl
//                   ← undefined (no clean source in new schema; these
//                     were Maria-set fields on the legacy `rooms` table.
//                     Writes will land in a separate branch.)
//
// "Current status" dedupe:
//   pms_room_status_log is append-only. We pull the last 30 days of rows
//   for the property ordered by changed_at DESC, then take the first
//   occurrence per room_number — that's the latest status. The 30-day
//   window covers any realistic gap; rooms that haven't changed status
//   in 30+ days are extremely rare in limited-service hotels (guests
//   check in/out daily) and default to 'dirty' which is the safer
//   render (visible to housekeepers, not silently "ready").
//
// Volume:
//   Realistic churn is 10-100 rows/day per hotel (status only writes on
//   actual change). 30 days at the high end ≈ 3,000 rows — a single
//   fetch with the (property_id, room_number, changed_at desc) index is
//   sub-100ms. The 10,000-row cap is paranoia, not a real ceiling.
// ═══════════════════════════════════════════════════════════════════════════

import { supabaseAdmin } from './supabase-admin';
import type { Room, RoomStatus, RoomType } from '@/types';
import { log } from './log';

// ── Status mapping ─────────────────────────────────────────────────────────
// pms_room_status_log.status (new) → legacy RoomStatus
function mapStatus(
  rawStatus: string | null | undefined,
  hasInProgressAssignment: boolean,
): RoomStatus {
  // An in-progress assignment ALWAYS wins. The status_log lags behind a
  // housekeeper tapping Start (the CUA only sees status changes the PMS
  // shows; "cleaning" is a Staxis-side state, not a PMS state).
  if (hasInProgressAssignment) return 'in_progress';
  if (rawStatus === 'inspected') return 'inspected';
  if (rawStatus && rawStatus.endsWith('_clean')) return 'clean';
  // Everything else (dirty variants, occupied, out_of_order, unknown, null)
  // renders as 'dirty' — visible to housekeepers, not silently "ready".
  return 'dirty';
}

// cleaning_type → legacy RoomType. Limited-service hotels only really see
// departure / stayover; deep/refresh/inspection/arrival aren't in the
// legacy union so default to 'checkout' for rendering purposes.
function mapType(cleaningType: string | null | undefined): RoomType {
  if (cleaningType === 'stayover') return 'stayover';
  if (cleaningType === 'departure') return 'checkout';
  return 'vacant';
}

// "M/D/YY" — what the legacy CSV scraper wrote into Room.arrival, kept
// identical so the existing UI badge renders unchanged.
function formatArrivalMDY(isoDate: string): string {
  const [y, m, d] = isoDate.split('-');
  return `${parseInt(m, 10)}/${parseInt(d, 10)}/${y.slice(-2)}`;
}

// Difference in whole days between two YYYY-MM-DD strings. arrivalDate
// must be strictly before targetDate for stayoverDay to be >= 1.
function daysBetween(fromIso: string, toIso: string): number {
  const a = Date.parse(fromIso + 'T00:00:00Z');
  const b = Date.parse(toIso + 'T00:00:00Z');
  if (isNaN(a) || isNaN(b)) return 0;
  return Math.floor((b - a) / 86_400_000);
}

interface InventoryRow {
  id: string;
  room_number: string;
  room_type: string | null;
}

interface StatusLogRow {
  room_number: string;
  status: string;
  changed_at: string;
}

interface AssignmentRow {
  room_number: string;
  housekeeper_name: string | null;
  cleaning_type: string | null;
  started_at: string | null;
  completed_at: string | null;
  dnd_active: boolean | null;
}

interface ReservationRow {
  room_number: string | null;
  arrival_date: string | null;
  departure_date: string | null;
  status: string | null;
}

interface StaffNameRow {
  id: string;
  name: string;
}

/**
 * Merge pms_* tables into the legacy `Room[]` shape for a (property, date).
 * Used by /api/housekeeping/rooms (today's board) and any other server-
 * side caller that needs the same view.
 *
 * Strategy:
 *   1. Pull pms_rooms_inventory — every known room for the property.
 *   2. Pull pms_room_status_log (last 30 days) — dedupe to latest per room.
 *   3. Pull pms_housekeeping_assignments for `date` — one row per room.
 *   4. Pull pms_reservations relevant to `date` — for arrival/stayover flags.
 *   5. Pull staff (id+name) for the property — to map housekeeper_name
 *      back to staff.id (best-effort; lowercase exact match).
 *   6. Compose one Room per inventory row.
 *
 * Returns `Room[]` shaped exactly as `fromRoomRow()` did — startedAt /
 * completedAt are ISO strings here (JSON-serializable); the client
 * helper re-hydrates them to Date via `toDate()` before publishing.
 *
 * Why ISO strings: the API serializes JSON, and Date instances become
 * strings anyway. Skipping the new Date() construction server-side
 * keeps this function pure (no surprise wall-clock dependency) and
 * leaves the client-side toDate() as the single rehydration point.
 */
export async function mergePmsRoomsForDate(
  pid: string,
  date: string,
): Promise<Room[]> {
  // 1. Inventory — the canonical list of rooms for the property.
  const { data: inventoryRows, error: invErr } = await supabaseAdmin
    .from('pms_rooms_inventory')
    .select('id, room_number, room_type')
    .eq('property_id', pid)
    .order('room_number', { ascending: true });
  if (invErr) {
    log.error('[pms-rooms-server] inventory query failed', {
      pid, date, msg: invErr.message,
    });
    throw invErr;
  }
  const inventory = (inventoryRows ?? []) as InventoryRow[];
  if (inventory.length === 0) return [];

  // 2. Status log — last 30 days, all rooms for property, newest first.
  // Dedupe to latest per room_number.
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const { data: statusRows, error: statusErr } = await supabaseAdmin
    .from('pms_room_status_log')
    .select('room_number, status, changed_at')
    .eq('property_id', pid)
    .gte('changed_at', thirtyDaysAgo)
    .order('changed_at', { ascending: false })
    .limit(10_000);
  if (statusErr) {
    log.error('[pms-rooms-server] status_log query failed', {
      pid, date, msg: statusErr.message,
    });
    throw statusErr;
  }
  const latestStatusByRoom = new Map<string, string>();
  for (const row of (statusRows ?? []) as StatusLogRow[]) {
    const num = String(row.room_number ?? '');
    if (!num || latestStatusByRoom.has(num)) continue;
    latestStatusByRoom.set(num, String(row.status ?? 'unknown'));
  }

  // 3. Today's HK assignments (one row per room per date).
  const { data: assignmentRows, error: assignErr } = await supabaseAdmin
    .from('pms_housekeeping_assignments')
    .select('room_number, housekeeper_name, cleaning_type, started_at, completed_at, dnd_active')
    .eq('property_id', pid)
    .eq('date', date);
  if (assignErr) {
    log.error('[pms-rooms-server] assignments query failed', {
      pid, date, msg: assignErr.message,
    });
    throw assignErr;
  }
  const assignmentByRoom = new Map<string, AssignmentRow>();
  for (const row of (assignmentRows ?? []) as AssignmentRow[]) {
    assignmentByRoom.set(String(row.room_number ?? ''), row);
  }

  // 4. Reservations relevant to `date` — for arrival + stayover flags.
  //    Need any reservation whose arrival_date == date OR whose stay span
  //    contains date (arrival_date <= date AND departure_date > date).
  const { data: reservationRows, error: resErr } = await supabaseAdmin
    .from('pms_reservations')
    .select('room_number, arrival_date, departure_date, status')
    .eq('property_id', pid)
    .lte('arrival_date', date)
    .gt('departure_date', date)
    .in('status', ['booked', 'checked_in']);
  if (resErr) {
    log.error('[pms-rooms-server] reservations query failed', {
      pid, date, msg: resErr.message,
    });
    throw resErr;
  }
  const reservationByRoom = new Map<string, ReservationRow>();
  for (const row of (reservationRows ?? []) as ReservationRow[]) {
    const num = String(row.room_number ?? '');
    if (!num) continue;
    // First match wins (Supabase doesn't guarantee order; in practice
    // there's one active reservation per room at any time).
    if (!reservationByRoom.has(num)) reservationByRoom.set(num, row);
  }

  // 5. Staff name → id lookup. We only need it for the assignedTo field
  // so the "On the floor" crew strip can render. Best-effort: a hotel
  // typically has 5-20 housekeepers, names rarely collide.
  const { data: staffRows, error: staffErr } = await supabaseAdmin
    .from('staff')
    .select('id, name')
    .eq('property_id', pid);
  if (staffErr) {
    log.error('[pms-rooms-server] staff lookup failed', {
      pid, msg: staffErr.message,
    });
    // Not fatal — the page still works without crew mapping.
  }
  const staffIdByLowerName = new Map<string, string>();
  for (const row of (staffRows ?? []) as StaffNameRow[]) {
    const nm = String(row.name ?? '').trim().toLowerCase();
    if (nm && !staffIdByLowerName.has(nm)) staffIdByLowerName.set(nm, row.id);
  }

  // 6. Compose Room[] — one per inventory row.
  const rooms: Room[] = [];
  for (const inv of inventory) {
    const num = String(inv.room_number);
    const assignment = assignmentByRoom.get(num);
    const reservation = reservationByRoom.get(num);
    const rawStatus = latestStatusByRoom.get(num) ?? null;

    const hasInProgress = Boolean(
      assignment?.started_at && !assignment?.completed_at,
    );
    const status = mapStatus(rawStatus, hasInProgress);
    const type = mapType(assignment?.cleaning_type);

    const assignedName = assignment?.housekeeper_name?.trim() || undefined;
    const assignedTo = assignedName
      ? staffIdByLowerName.get(assignedName.toLowerCase())
      : undefined;

    let arrival: string | undefined;
    let stayoverDay: number | undefined;
    if (reservation?.arrival_date) {
      if (reservation.arrival_date === date) {
        arrival = formatArrivalMDY(reservation.arrival_date);
      } else if (
        reservation.arrival_date < date &&
        (reservation.departure_date ?? '') > date
      ) {
        stayoverDay = daysBetween(reservation.arrival_date, date);
      }
    }

    const room: Room = {
      id: String(inv.id),
      number: num,
      type,
      priority: 'standard',
      status,
      date,
      propertyId: pid,
      // Optional fields — omit when undefined to keep the JSON tight.
      ...(assignedTo ? { assignedTo } : {}),
      ...(assignedName ? { assignedName } : {}),
      ...(assignment?.started_at
        ? { startedAt: new Date(assignment.started_at) }
        : {}),
      ...(assignment?.completed_at
        ? { completedAt: new Date(assignment.completed_at) }
        : {}),
      ...(assignment?.dnd_active === true ? { isDnd: true } : {}),
      ...(arrival ? { arrival } : {}),
      ...(stayoverDay !== undefined ? { stayoverDay } : {}),
    };
    rooms.push(room);
  }

  return rooms;
}
