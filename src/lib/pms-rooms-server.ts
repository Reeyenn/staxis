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
//   status          ← assignment-first derivation:
//                       assignment.completed_at set                → 'clean'
//                       assignment.started_at + !completed_at      → 'in_progress'
//                       assignment present + not started           → 'dirty'
//                       no assignment + status='inspected'         → 'inspected'
//                       no assignment + status ends with '_clean'  → 'clean'
//                       no assignment + status='occupied'          → 'clean'
//                       no assignment + everything else            → 'dirty'
//                     Rationale: today's HK assignment is the authoritative
//                     "needs cleaning" signal. PMS status only matters when
//                     no assignment exists (room not on today's HK plan).
//                     Out-of-order rooms ride the work-order badge layer
//                     in the UI, not a separate status — RoomsTab's openWoRooms
//                     set picks them up via pms_work_orders_v2.
//   assignedTo      ← lookup staff by NFC-normalized space-collapsed name
//                     match (best-effort; M7 fix). Diacritic-safe.
//   assignedName    ← pms_housekeeping_assignments.housekeeper_name (trimmed)
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
//   pms_room_status_log is append-only. We fetch the last 90 days of rows
//   for the property (no row limit — Supabase default page size is bumped
//   via range), ordered by changed_at DESC, then take the first
//   occurrence per room_number — that's the latest status. The 90-day
//   window is generous: a limited-service hotel turns every room many
//   times a month, so genuine 90+ day gaps essentially don't happen.
//   Status is also a fallback signal — the authoritative "needs cleaning
//   today" signal is the assignments table.
//
// Resilience (M8):
//   Inventory is the only hard requirement — without rooms, there's
//   nothing to render. The other four queries (status_log, assignments,
//   reservations, staff) run via Promise.allSettled. Any individual
//   query failure degrades gracefully (the corresponding map is empty,
//   the merge proceeds). The whole endpoint does NOT 500 because one
//   secondary feed had a transient error.
// ═══════════════════════════════════════════════════════════════════════════

import { supabaseAdmin } from './supabase-admin';
import type { Room, RoomStatus, RoomType } from '@/types';
import { log } from './log';

// ── Status mapping ─────────────────────────────────────────────────────────
// Assignment-first derivation. Today's HK assignment row is the canonical
// "what's the room's housekeeping state right now?" signal. PMS status_log
// is only a fallback when no assignment exists. M1 + M2 fix.
function deriveStatus(
  assignment: AssignmentRow | undefined,
  rawStatus: string | null,
): RoomStatus {
  if (assignment) {
    // Assignment status enum (pms_housekeeping_assignments.status):
    // 'not_started' | 'in_progress' | 'completed' | 'refused' | 'skipped'.
    // Plus the started_at / completed_at timestamps which can be set
    // independently by the CUA.
    if (assignment.status === 'completed' || assignment.completed_at) {
      return 'clean';
    }
    if (assignment.started_at && !assignment.completed_at) {
      return 'in_progress';
    }
    // not_started / refused / skipped / null → needs attention from staff.
    return 'dirty';
  }
  // No assignment today — fall back to PMS status_log.
  if (rawStatus === 'inspected') return 'inspected';
  if (rawStatus && rawStatus.endsWith('_clean')) return 'clean';
  // 'occupied' (steady-state, no clean needed today) → 'clean'. The room
  // isn't on today's HK plan AND the PMS says a guest is in it; the
  // housekeeping board has no work to do here.
  if (rawStatus === 'occupied') return 'clean';
  // Everything else (vacant_dirty, occupied_dirty, out_of_order,
  // out_of_inventory, unknown, null) defaults to 'dirty'. Out-of-order
  // rooms get a separate visual treatment via pms_work_orders_v2 / the
  // openWoRooms badge layer in RoomsTab.
  return 'dirty';
}

// cleaning_type → legacy RoomType. Limited-service hotels only really see
// departure / stayover; deep/refresh/inspection/arrival aren't in the
// legacy union so default to 'checkout' for rendering purposes.
export function mapType(cleaningType: string | null | undefined): RoomType {
  if (cleaningType === 'stayover') return 'stayover';
  if (cleaningType === 'departure') return 'checkout';
  return 'vacant';
}

// "M/D/YY" — what the legacy CSV scraper wrote into Room.arrival, kept
// identical so the existing UI badge renders unchanged.
export function formatArrivalMDY(isoDate: string): string {
  const [y, m, d] = isoDate.split('-');
  return `${parseInt(m, 10)}/${parseInt(d, 10)}/${y.slice(-2)}`;
}

// Difference in whole days between two YYYY-MM-DD strings. arrivalDate
// must be strictly before targetDate for stayoverDay to be >= 1.
export function daysBetween(fromIso: string, toIso: string): number {
  const a = Date.parse(fromIso + 'T00:00:00Z');
  const b = Date.parse(toIso + 'T00:00:00Z');
  if (isNaN(a) || isNaN(b)) return 0;
  return Math.floor((b - a) / 86_400_000);
}

// Normalize a name for cross-source matching: NFC unicode form, lower-cased,
// internal whitespace collapsed, trimmed. M7 fix — "María" vs "Maria",
// "Maria  Smith" (double space) vs "Maria Smith", and "  Maria " all
// reduce to the same key. Does NOT strip diacritics (NFC keeps them);
// caller-side staff entry should also be normalized consistently.
export function normalizeName(raw: string | null | undefined): string {
  if (!raw) return '';
  return raw.normalize('NFC').trim().toLowerCase().replace(/\s+/g, ' ');
}

// Re-export for tests + readability where the assignment-first rule is
// referenced. mapStatus is the entry point for status derivation.
export const mapStatus = deriveStatus;

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
  status: string | null;
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

// Type-narrowing helpers — Promise.allSettled doesn't preserve our row
// types in TypeScript without a guard.
function fulfilledData<T>(
  result: PromiseSettledResult<{ data: T | null; error: unknown }>,
  tag: string,
  pid: string,
  date: string,
): T[] {
  if (result.status === 'rejected') {
    log.error(`[pms-rooms-server] ${tag} query rejected`, {
      pid, date, msg: String(result.reason),
    });
    return [];
  }
  const { data, error } = result.value;
  if (error) {
    log.error(`[pms-rooms-server] ${tag} query failed`, {
      pid, date, msg: (error as { message?: string }).message ?? String(error),
    });
    return [];
  }
  return (data ?? []) as unknown as T[];
}

/**
 * Merge pms_* tables into the legacy `Room[]` shape for a (property, date).
 * Used by /api/housekeeping/rooms (today's board) and any other server-
 * side caller that needs the same view.
 *
 * Strategy:
 *   1. Pull pms_rooms_inventory — every known room for the property.
 *      Hard requirement; throws on failure.
 *   2-5. Pull status_log + assignments + reservations + staff in parallel
 *      via Promise.allSettled. Each is non-fatal; a failure produces an
 *      empty map for that feed and the merge proceeds.
 *   6. Compose one Room per inventory row.
 */
export async function mergePmsRoomsForDate(
  pid: string,
  date: string,
): Promise<Room[]> {
  // 1. Inventory — the canonical list of rooms. HARD requirement.
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

  // 2-5. Parallel non-fatal queries — M8 fix.
  // Status log: 90-day window, ordered newest-first, dedupe-to-latest in TS.
  // No row-cap on this query — the index (property_id, room_number,
  // changed_at desc) handles it. M2 + M3 fix replaces the original
  // 30-day-window + 10k-cap which could silently miss rooms.
  const ninetyDaysAgo = new Date(Date.now() - 90 * 86_400_000).toISOString();
  const [statusRes, assignRes, resRes, staffRes] = await Promise.allSettled([
    supabaseAdmin
      .from('pms_room_status_log')
      .select('room_number, status, changed_at')
      .eq('property_id', pid)
      .gte('changed_at', ninetyDaysAgo)
      .order('changed_at', { ascending: false }),
    supabaseAdmin
      .from('pms_housekeeping_assignments')
      .select('room_number, housekeeper_name, cleaning_type, status, started_at, completed_at, dnd_active')
      .eq('property_id', pid)
      .eq('date', date),
    // M4 fix — deterministic order so double-bookings produce the
    // earliest-arrival reservation consistently, not Postgres page order.
    supabaseAdmin
      .from('pms_reservations')
      .select('room_number, arrival_date, departure_date, status')
      .eq('property_id', pid)
      .lte('arrival_date', date)
      .gt('departure_date', date)
      .in('status', ['booked', 'checked_in'])
      .order('arrival_date', { ascending: true }),
    supabaseAdmin
      .from('staff')
      .select('id, name')
      .eq('property_id', pid),
  ]);

  const statusRows = fulfilledData<StatusLogRow>(statusRes, 'status_log', pid, date);
  const assignmentRows = fulfilledData<AssignmentRow>(assignRes, 'assignments', pid, date);
  const reservationRows = fulfilledData<ReservationRow>(resRes, 'reservations', pid, date);
  const staffRows = fulfilledData<StaffNameRow>(staffRes, 'staff', pid, date);

  // Dedupe status_log → latest per room_number.
  const latestStatusByRoom = new Map<string, string>();
  for (const row of statusRows) {
    const num = String(row.room_number ?? '');
    if (!num || latestStatusByRoom.has(num)) continue;
    latestStatusByRoom.set(num, String(row.status ?? 'unknown'));
  }

  // One assignment per (date, room). The unique constraint in the schema
  // makes this 1:1, but we still take the last write in case of dedupe edge.
  const assignmentByRoom = new Map<string, AssignmentRow>();
  for (const row of assignmentRows) {
    assignmentByRoom.set(String(row.room_number ?? ''), row);
  }

  // Reservation per room — deterministic first-match-wins via the
  // arrival_date order. For double-booked rooms this consistently picks
  // the reservation that started first (typically the original booking).
  const reservationByRoom = new Map<string, ReservationRow>();
  let doubleBookedCount = 0;
  for (const row of reservationRows) {
    const num = String(row.room_number ?? '');
    if (!num) continue;
    if (reservationByRoom.has(num)) {
      doubleBookedCount++;
      continue;
    }
    reservationByRoom.set(num, row);
  }
  if (doubleBookedCount > 0) {
    log.warn('[pms-rooms-server] reservations: overlapping bookings detected', {
      pid, date, doubleBookedCount,
    });
  }

  // Staff name → id lookup with normalization (M7). Hotel rarely has > 50
  // active staff, so the linear lookup cost is trivial.
  const staffIdByNormName = new Map<string, string>();
  for (const row of staffRows) {
    const nm = normalizeName(row.name);
    if (nm && !staffIdByNormName.has(nm)) staffIdByNormName.set(nm, row.id);
  }

  // 6. Compose Room[] — one per inventory row.
  const rooms: Room[] = [];
  for (const inv of inventory) {
    const num = String(inv.room_number);
    const assignment = assignmentByRoom.get(num);
    const reservation = reservationByRoom.get(num);
    const rawStatus = latestStatusByRoom.get(num) ?? null;

    const status = deriveStatus(assignment, rawStatus);
    const type = mapType(assignment?.cleaning_type);

    const assignedNameRaw = assignment?.housekeeper_name?.trim() || undefined;
    const assignedTo = assignedNameRaw
      ? staffIdByNormName.get(normalizeName(assignedNameRaw))
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
      ...(assignedTo ? { assignedTo } : {}),
      ...(assignedNameRaw ? { assignedName: assignedNameRaw } : {}),
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
