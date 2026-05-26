// ═══════════════════════════════════════════════════════════════════════════
// pms-rooms-server — server-only merge: pms_* tables → legacy Room shape.
//
// Why this exists:
//   Plan v4 (migration 0204) dropped the legacy `rooms` table; migration
//   0205 re-created it as an empty stub so dead code doesn't crash. Live
//   room status now flows into the 15 service-role-only `pms_*` tables
//   (migration 0202), written by the persistent CUA browser per hotel.
//
//   Every consumer of Room[] still needs the same camel-cased shape from
//   `src/types`. This module bridges the two:
//     - `mergePmsRoomsForDate(pid, date)`        — manager board (one date)
//     - `mergePmsRoomsForStaff(pid, staffId)`    — housekeeper SMS link (cross-date)
//
// Server-only:
//   pms_* tables are RLS deny-all-browser (migration 0202). The browser
//   anon/authenticated clients cannot read them. This module imports
//   `supabaseAdmin` and MUST never be imported from a client-side file.
//
// Room.id format:
//   "${date}:${room_number}" — composite, stable per (property, date,
//   room_number), parseable by the write path. Phantom rows (rooms in
//   the property's static inventory but not yet in pms_rooms_inventory)
//   still use the "phantom-${number}" prefix the UI checks for.
//
// Mapping notes (legacy Room field ← new pms_* source):
//   number          ← pms_rooms_inventory.room_number (or assignment row's)
//   type            ← derived from pms_housekeeping_assignments.cleaning_type
//   priority        ← always 'standard' (no clean source in new schema)
//   status          ← assignment-first:
//                       started_at AND NOT completed_at → 'in_progress'
//                       completed_at set                → 'clean'
//                       assignment present + not started → 'dirty'
//                       no assignment + 'inspected'     → 'inspected'
//                       no assignment + '_clean' suffix → 'clean'
//                       no assignment + 'occupied'      → 'clean'
//                       everything else                 → 'dirty'
//   assignedTo      ← fuzzy lookup of staff by normalized name (NFC, strip
//                     diacritics, lowercase, collapse whitespace), then
//                     first-name fallback if no exact match
//   assignedName    ← pms_housekeeping_assignments.housekeeper_name (trimmed)
//   startedAt       ← pms_housekeeping_assignments.started_at
//   completedAt     ← pms_housekeeping_assignments.completed_at
//   isDnd           ← pms_housekeeping_assignments.dnd_active
//   arrival         ← if reservation.arrival_date == date AND
//                     status IN ('booked','checked_in'): "M/D/YY"
//   stayoverDay     ← if reservation overlaps date (arrival < date <
//                     departure), date - arrival_date in nights
//   stayoverMinutes ← undefined
//   issueNote, inspectedBy, inspectedAt, dndNote, helpRequested,
//   checklist, photoUrl
//                   ← undefined (no clean source in new schema; Maria-set
//                     annotations are not preserved on write either —
//                     they'd be clobbered by CUA on next sync.)
// ═══════════════════════════════════════════════════════════════════════════

import { supabaseAdmin } from './supabase-admin';
import type { Room, RoomStatus, RoomType } from '@/types';
import { log } from './log';

// ── Pure helpers (exported for unit tests) ─────────────────────────────────

/**
 * Assignment-first status derivation. Codex post-merge review #2 (Critical):
 * the original `mapStatus(rawStatus, hasInProgressAssignment)` only checked
 * the in-progress condition and otherwise fell through to PMS status_log,
 * so `applyRoomUpdate()` could persist `completed_at` and the read path
 * still rendered the room dirty.
 *
 * New rule:
 *   1. Assignment is authoritative when present:
 *        - status='completed' OR completed_at set    → 'clean'
 *        - started_at set AND completed_at not set   → 'in_progress'
 *        - assignment present but neither set        → 'dirty' (not started)
 *   2. No assignment → fall back to PMS status_log:
 *        - 'inspected'                               → 'inspected'
 *        - ends with '_clean'                        → 'clean'
 *        - 'occupied' (steady-state, no work needed) → 'clean'
 *        - everything else                           → 'dirty'
 *
 * The legacy two-arg `mapStatus(rawStatus, hasInProgressAssignment)` is
 * preserved below for backwards compatibility with the existing unit
 * tests, but composeRoom() uses the new `deriveStatus()` directly.
 */
export interface AssignmentForStatus {
  status?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
}

export function deriveStatus(
  assignment: AssignmentForStatus | undefined | null,
  rawStatus: string | null | undefined,
): RoomStatus {
  if (assignment) {
    if (assignment.status === 'completed' || assignment.completed_at) {
      return 'clean';
    }
    if (assignment.started_at && !assignment.completed_at) {
      return 'in_progress';
    }
    return 'dirty';
  }
  if (rawStatus === 'inspected') return 'inspected';
  if (rawStatus && rawStatus.endsWith('_clean')) return 'clean';
  if (rawStatus === 'occupied') return 'clean';
  return 'dirty';
}

/**
 * Legacy two-arg API. Internally delegates to deriveStatus by reconstructing
 * a minimal AssignmentForStatus from the in-progress flag. Kept for the
 * unit tests and any external callers.
 */
export function mapStatus(
  rawStatus: string | null | undefined,
  hasInProgressAssignment: boolean,
): RoomStatus {
  if (hasInProgressAssignment) return 'in_progress';
  if (rawStatus === 'inspected') return 'inspected';
  if (rawStatus && rawStatus.endsWith('_clean')) return 'clean';
  if (rawStatus === 'occupied') return 'clean';
  return 'dirty';
}

/** cleaning_type → legacy RoomType. */
export function mapType(cleaningType: string | null | undefined): RoomType {
  if (cleaningType === 'stayover') return 'stayover';
  if (cleaningType === 'departure') return 'checkout';
  return 'vacant';
}

/** Reverse: RoomType → cleaning_type for writes. */
export function reverseMapType(type: RoomType | null | undefined): string | null {
  if (type === 'stayover') return 'stayover';
  if (type === 'checkout') return 'departure';
  return null;
}

/** "M/D/YY" — legacy CSV badge format kept identical so the UI renders unchanged. */
export function formatArrivalMDY(isoDate: string): string {
  const [y, m, d] = isoDate.split('-');
  return `${parseInt(m, 10)}/${parseInt(d, 10)}/${y.slice(-2)}`;
}

/** Whole-day diff between two YYYY-MM-DD strings (UTC midnight anchor). */
export function daysBetween(fromIso: string, toIso: string): number {
  const a = Date.parse(fromIso + 'T00:00:00Z');
  const b = Date.parse(toIso + 'T00:00:00Z');
  if (isNaN(a) || isNaN(b)) return 0;
  return Math.floor((b - a) / 86_400_000);
}

/**
 * Normalize a name for cross-source matching:
 *   - NFD decompose → strip combining diacritics → NFC recompose
 *   - lowercase, trim, collapse internal whitespace
 *
 * "María" and "Maria" both → "maria". "Maria  Smith  " → "maria smith".
 * Diacritic-stripped to match how PMS-vs-staff data may drift —
 * the PMS might store "Maria" while the staff record has "María".
 */
export function normalizeName(raw: string | null | undefined): string {
  if (!raw) return '';
  return raw
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip combining marks
    .normalize('NFC')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/**
 * Compose Room.id from (date, room_number). Stable across polls, parseable
 * by the write path, and uniquely identifies a Room across the housekeeper
 * cross-date view.
 */
export function composeRoomId(date: string, roomNumber: string): string {
  return `${date}:${roomNumber}`;
}

/**
 * Inverse of composeRoomId. Returns null on shapes that don't match
 * (e.g. legacy UUIDs from a stale cache, phantom-XXX ids).
 */
export function parseRoomId(rid: string): { date: string; roomNumber: string } | null {
  if (!rid || !rid.includes(':')) return null;
  const idx = rid.indexOf(':');
  const date = rid.slice(0, idx);
  const roomNumber = rid.slice(idx + 1);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !roomNumber) return null;
  return { date, roomNumber };
}

/**
 * Build a staff name → id lookup map with collision-aware fuzzy fallback.
 *
 * Two-tier match:
 *   1. Exact normalized full-name match (NFC + strip diacritics + lower +
 *      collapse whitespace).
 *   2. First-name fallback — ONLY when the first name is unique among
 *      this property's staff. Two housekeepers named "Maria" disable the
 *      first-name fallback for both, so neither gets the other's rooms.
 *
 * Codex post-merge review fix (Critical #4 + Major #5): the original
 * fallback was first-wins, which silently routed every "Maria *" PMS row
 * to the first Maria in the staff list — collapsing two staffers' rooms
 * into one's view.
 */
export interface StaffLookup {
  /** Look up a staff id by housekeeper name string. Returns undefined on no match. */
  resolve(name: string | null | undefined): string | undefined;
}

function buildStaffLookup(rows: Array<{ id: string; name: string | null }>): StaffLookup {
  const byFullName = new Map<string, string>();
  // Count first-name occurrences across the staff. We only allow the
  // first-name fallback when the count is exactly 1 (unambiguous match).
  const firstNameCounts = new Map<string, number>();
  const firstNameIds = new Map<string, string>();
  for (const row of rows) {
    const full = normalizeName(row.name);
    if (!full) continue;
    if (!byFullName.has(full)) byFullName.set(full, row.id);
    const firstName = full.split(' ')[0];
    if (firstName) {
      firstNameCounts.set(firstName, (firstNameCounts.get(firstName) ?? 0) + 1);
      if (!firstNameIds.has(firstName)) firstNameIds.set(firstName, row.id);
    }
  }
  return {
    resolve(rawName) {
      const full = normalizeName(rawName);
      if (!full) return undefined;
      const exact = byFullName.get(full);
      if (exact) return exact;
      // First-name fallback ONLY when unambiguous on this property.
      const firstName = full.split(' ')[0];
      if (!firstName) return undefined;
      if ((firstNameCounts.get(firstName) ?? 0) !== 1) return undefined;
      return firstNameIds.get(firstName);
    },
  };
}

// ── Row shapes ─────────────────────────────────────────────────────────────

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
  date: string;
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

// ── Compose helpers ────────────────────────────────────────────────────────

interface ComposeContext {
  staff: StaffLookup;
  statusByRoom: Map<string, string>;
  reservationByRoom: Map<string, ReservationRow>;
}

function composeRoom(
  inv: InventoryRow | { id?: string; room_number: string },
  assignment: AssignmentRow | undefined,
  date: string,
  pid: string,
  ctx: ComposeContext,
): Room {
  const num = String(inv.room_number);
  const rawStatus = ctx.statusByRoom.get(num) ?? null;
  const reservation = ctx.reservationByRoom.get(num);

  // Codex post-merge review fix (Critical #2): assignment lifecycle is
  // authoritative when an assignment row exists. PMS status_log is only
  // the fallback for rooms with no assignment today.
  const status = deriveStatus(assignment, rawStatus);
  const type = mapType(assignment?.cleaning_type);

  const assignedName = assignment?.housekeeper_name?.trim() || undefined;
  const assignedTo = ctx.staff.resolve(assignedName);

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

  return {
    // Composite id — stable across polls, parseable by writes.
    id: composeRoomId(date, num),
    number: num,
    type,
    priority: 'standard',
    status,
    date,
    propertyId: pid,
    ...(assignedTo ? { assignedTo } : {}),
    ...(assignedName ? { assignedName } : {}),
    ...(assignment?.started_at ? { startedAt: new Date(assignment.started_at) } : {}),
    ...(assignment?.completed_at ? { completedAt: new Date(assignment.completed_at) } : {}),
    ...(assignment?.dnd_active === true ? { isDnd: true } : {}),
    ...(arrival ? { arrival } : {}),
    ...(stayoverDay !== undefined ? { stayoverDay } : {}),
  };
}

// ── mergePmsRoomsForDate — manager board (one date) ────────────────────────

/**
 * Merge pms_* tables into the legacy `Room[]` shape for a (property, date).
 * Used by /api/housekeeping/rooms and /api/laundry/bootstrap.
 *
 * Inventory is the hard requirement. The other four queries
 * (status_log, assignments, reservations, staff) run in parallel and
 * any individual failure degrades gracefully — an empty map for that
 * feed, the merge proceeds.
 */
export async function mergePmsRoomsForDate(
  pid: string,
  date: string,
): Promise<Room[]> {
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
      .select('date, room_number, housekeeper_name, cleaning_type, status, started_at, completed_at, dnd_active')
      .eq('property_id', pid)
      .eq('date', date),
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

  // Assignments are the authoritative signal for "needs cleaning today."
  // A DB outage there means rooms get derived from stale status_log only —
  // a manager looking at the board would see every started room flip back
  // to dirty. Fail closed instead (Codex Major #13).
  if (assignRes.status === 'rejected') {
    log.error('[pms-rooms-server] assignments query rejected', {
      pid, date, msg: String(assignRes.reason),
    });
    throw new Error('assignments query failed');
  }
  if (assignRes.value.error) {
    log.error('[pms-rooms-server] assignments query failed', {
      pid, date, msg: assignRes.value.error.message,
    });
    throw assignRes.value.error;
  }
  const assignmentRows = (assignRes.value.data ?? []) as AssignmentRow[];

  // Status, reservations, and staff are secondary — degrade gracefully.
  const statusRows = fulfilledData<StatusLogRow>(statusRes, 'status_log', pid, date);
  const reservationRows = fulfilledData<ReservationRow>(resRes, 'reservations', pid, date);
  const staffRows = fulfilledData<StaffNameRow>(staffRes, 'staff', pid, date);

  const statusByRoom = new Map<string, string>();
  for (const row of statusRows) {
    const num = String(row.room_number ?? '');
    if (!num || statusByRoom.has(num)) continue;
    statusByRoom.set(num, String(row.status ?? 'unknown'));
  }

  const assignmentByRoom = new Map<string, AssignmentRow>();
  for (const row of assignmentRows) {
    assignmentByRoom.set(String(row.room_number ?? ''), row);
  }

  const reservationByRoom = new Map<string, ReservationRow>();
  for (const row of reservationRows) {
    const num = String(row.room_number ?? '');
    if (!num || reservationByRoom.has(num)) continue;
    reservationByRoom.set(num, row);
  }

  const ctx: ComposeContext = {
    staff: buildStaffLookup(staffRows),
    statusByRoom,
    reservationByRoom,
  };

  return inventory.map(inv =>
    composeRoom(inv, assignmentByRoom.get(String(inv.room_number)), date, pid, ctx),
  );
}

// ── mergePmsRoomsForStaff — housekeeper SMS link (cross-date) ──────────────

/**
 * Build Room[] for every assignment matching a given staff member,
 * across recent dates. Used by /api/housekeeper/rooms (the SMS-linked
 * page). The housekeeper page picks the right date bucket client-side
 * so we return ALL of their recent assignments (last 30 days + next 30
 * days — covers yesterday's overflow + tomorrow's pre-load).
 *
 * Returns Room[] where each Room.date is the assignment's date and
 * Room.id = "${date}:${room_number}" — so the housekeeper page's
 * `byDate.get(today)` grouping still works.
 */
export async function mergePmsRoomsForStaff(
  pid: string,
  staffId: string,
): Promise<Room[]> {
  // 1. Resolve the staff record — we need the canonical name to match
  //    against pms_housekeeping_assignments.housekeeper_name.
  const { data: staffRow, error: staffErr } = await supabaseAdmin
    .from('staff')
    .select('id, name')
    .eq('id', staffId)
    .eq('property_id', pid)
    .maybeSingle();
  if (staffErr) {
    log.error('[pms-rooms-server] staff lookup failed', {
      pid, staffId, msg: staffErr.message,
    });
    throw staffErr;
  }
  if (!staffRow || !staffRow.name) return [];

  const canonicalName = normalizeName(staffRow.name);
  if (!canonicalName) return [];

  // 2. Pull this staff's date window of assignments + the full staff list
  //    (for collision-aware first-name fallback — Codex Critical #4).
  const today = new Date().toISOString().slice(0, 10);
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000)
    .toISOString().slice(0, 10);
  const thirtyDaysAhead = new Date(Date.now() + 30 * 86_400_000)
    .toISOString().slice(0, 10);

  const [assignmentsRes, staffListRes] = await Promise.allSettled([
    supabaseAdmin
      .from('pms_housekeeping_assignments')
      .select('date, room_number, housekeeper_name, cleaning_type, status, started_at, completed_at, dnd_active')
      .eq('property_id', pid)
      .gte('date', thirtyDaysAgo)
      .lte('date', thirtyDaysAhead),
    supabaseAdmin
      .from('staff')
      .select('id, name')
      .eq('property_id', pid),
  ]);

  // Assignments — Critical for board accuracy. Fail closed if the query
  // errored (Codex Major #13 — don't silently return "valid pair, no rooms"
  // when the DB is down).
  if (assignmentsRes.status === 'rejected') {
    log.error('[pms-rooms-server] assignments-for-staff query rejected', {
      pid, staffId, msg: String(assignmentsRes.reason),
    });
    throw new Error('assignments query failed');
  }
  if (assignmentsRes.value.error) {
    log.error('[pms-rooms-server] assignments-for-staff query failed', {
      pid, staffId, msg: assignmentsRes.value.error.message,
    });
    throw assignmentsRes.value.error;
  }

  const allAssignments = (assignmentsRes.value.data ?? []) as AssignmentRow[];
  const staffListRows = fulfilledData<StaffNameRow>(staffListRes, 'staff', pid, today);

  // 3. Filter to assignments whose housekeeper_name resolves to THIS staff.
  //    Build the StaffLookup from the full roster so the first-name
  //    collision logic applies — if there's another "Maria *" on staff,
  //    a bare "Maria" assignment doesn't get pulled into either's view.
  const staffLookup = buildStaffLookup(staffListRows);
  const matchingAssignments = allAssignments.filter(a => {
    const name = a.housekeeper_name?.trim();
    if (!name) return false;
    const resolvedId = staffLookup.resolve(name);
    return resolvedId === staffId;
  });

  if (matchingAssignments.length === 0) return [];

  // 4. Pull supporting data:
  //      - status_log (latest per room) — for status fallback
  //      - reservations spanning the assignment date window — for
  //        arrival/stayover flags across PAST/FUTURE date cards
  //        (Codex Major #8 — fetching only "today" gave the wrong
  //        arrival/stayover badge on cards for non-today dates).
  //    Inventory is NOT required here: every Room comes from an assignment row,
  //    so room_number is already known. Staff list was already fetched above.
  const [statusRes, resRes] = await Promise.allSettled([
    supabaseAdmin
      .from('pms_room_status_log')
      .select('room_number, status, changed_at')
      .eq('property_id', pid)
      .gte('changed_at', new Date(Date.now() - 90 * 86_400_000).toISOString())
      .order('changed_at', { ascending: false }),
    // Reservations whose stay overlaps ANY date in [thirtyDaysAgo, thirtyDaysAhead].
    // A reservation is relevant to a date D when arrival_date <= D < departure_date.
    // For the window [a, b] this means arrival_date <= b AND departure_date > a.
    supabaseAdmin
      .from('pms_reservations')
      .select('room_number, arrival_date, departure_date, status')
      .eq('property_id', pid)
      .lte('arrival_date', thirtyDaysAhead)
      .gt('departure_date', thirtyDaysAgo)
      .in('status', ['booked', 'checked_in'])
      .order('arrival_date', { ascending: true }),
  ]);

  const statusRows = fulfilledData<StatusLogRow>(statusRes, 'status_log', pid, today);
  const reservationRows = fulfilledData<ReservationRow>(resRes, 'reservations', pid, today);

  const statusByRoom = new Map<string, string>();
  for (const row of statusRows) {
    const num = String(row.room_number ?? '');
    if (!num || statusByRoom.has(num)) continue;
    statusByRoom.set(num, String(row.status ?? 'unknown'));
  }

  // For per-date composition we need a per-(date, room_number) reservation
  // lookup. Build a Map<date, Map<room_number, reservation>> to keep the
  // composeRoom() signature stable. (composeRoom takes a single
  // reservationByRoom for whichever date it's composing.)
  const reservationByDateRoom = new Map<string, Map<string, ReservationRow>>();
  for (const r of reservationRows) {
    const num = String(r.room_number ?? '');
    if (!num || !r.arrival_date || !r.departure_date) continue;
    // For each date D in the window where the reservation is active
    // (arrival <= D < departure), index this reservation under D.
    // Bound iteration to the assignment window to keep it tight.
    const start = r.arrival_date > thirtyDaysAgo ? r.arrival_date : thirtyDaysAgo;
    const endExclusive = r.departure_date < thirtyDaysAhead ? r.departure_date : thirtyDaysAhead;
    const startMs = Date.parse(start + 'T00:00:00Z');
    const endMs = Date.parse(endExclusive + 'T00:00:00Z');
    if (isNaN(startMs) || isNaN(endMs) || startMs >= endMs) continue;
    for (let t = startMs; t < endMs; t += 86_400_000) {
      const d = new Date(t).toISOString().slice(0, 10);
      let perDate = reservationByDateRoom.get(d);
      if (!perDate) {
        perDate = new Map();
        reservationByDateRoom.set(d, perDate);
      }
      if (!perDate.has(num)) perDate.set(num, r);
    }
  }

  // 5. Compose. One Room per (date, room_number). Each iteration uses
  //    the reservation map for THAT assignment's date so future/past
  //    cards get the right arrival/stayover flags (Codex Major #8).
  const emptyReservationMap = new Map<string, ReservationRow>();
  return matchingAssignments.map(a => {
    const reservationByRoom = reservationByDateRoom.get(a.date) ?? emptyReservationMap;
    const ctx: ComposeContext = {
      staff: staffLookup,
      statusByRoom,
      reservationByRoom,
    };
    return composeRoom(
      { room_number: a.room_number },
      a,
      a.date,
      pid,
      ctx,
    );
  });
}

// ── Result helpers ─────────────────────────────────────────────────────────

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
