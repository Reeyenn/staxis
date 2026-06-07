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
  //
  // NOTE: deriveStatus stays purely status_log-based for back-compat with
  // its callers and tests. Out-of-service rooms are split out at the Room
  // composition layer below (isOutOfServiceStatus), where the full row
  // context is available — so 'dirty' here is a safe default; it gets
  // overridden for OOO/OOS rooms before the Room is emitted.
  return 'dirty';
}

// PMS status_log values that mean the room is blocked / out of service —
// not a housekeeping turn. A guest can't be placed in it and HK won't
// clean it, so it must NOT land in the 'dirty' ("needs turning") bucket
// that the dashboard / laundry counts read. RoomsTab has a work-order
// badge overlay that catches OOO rooms with an open WO, but the dashboard
// and laundry have no such overlay — they read Room.status directly and
// would otherwise count these as dirty. We tag them with isOutOfService so
// those surfaces can bucket them separately. Mirrors BLOCKED_ROOM_STATUSES
// in rules-engine/context.ts.
const OUT_OF_SERVICE_STATUSES = new Set<string>([
  'out_of_order',
  'out_of_inventory',
]);

export function isOutOfServiceStatus(
  rawStatus: string | null | undefined,
): boolean {
  return !!rawStatus && OUT_OF_SERVICE_STATUSES.has(rawStatus);
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

// Normalize a name for cross-source matching:
//   NFD decompose → strip combining diacritics → NFC recompose →
//   lower-case + trim + collapse internal whitespace.
//
// "María" and "Maria" both → "maria". "Maria  Smith  " → "maria smith".
// Diacritics ARE stripped (not just NFC-normalized) — PMS entry rarely
// preserves accents while Staxis-side staff records often do, so this
// gives the most reliable cross-source match.
export function normalizeName(raw: string | null | undefined): string {
  if (!raw) return '';
  return raw
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip combining diacritical marks (U+0300–U+036F)
    .normalize('NFC')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

// Re-export for tests + readability where the assignment-first rule is
// referenced. mapStatus is the entry point for status derivation.
export const mapStatus = deriveStatus;

// Reverse: legacy RoomType → cleaning_type, for the write path that lands
// a tile-cycle into pms_housekeeping_assignments.cleaning_type.
export function reverseMapType(
  type: RoomType | null | undefined,
): string | null {
  if (type === 'stayover') return 'stayover';
  if (type === 'checkout') return 'departure';
  return null;
}

// ── Cross-date Room.id format ──────────────────────────────────────────────
// The housekeeper SMS link page (mergePmsRoomsForStaff below) returns rooms
// across multiple dates. Room.id needs to be unique per (date, room_number);
// the inventory UUID alone doesn't carry the date. Compose / parse helpers
// keep the format consistent and parseable on the write side.

export function composeRoomId(date: string, roomNumber: string): string {
  return `${date}:${roomNumber}`;
}

export function parseRoomId(
  rid: string,
): { date: string; roomNumber: string } | null {
  if (!rid || !rid.includes(':')) return null;
  const idx = rid.indexOf(':');
  const date = rid.slice(0, idx);
  const roomNumber = rid.slice(idx + 1);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !roomNumber) return null;
  return { date, roomNumber };
}

// ── Staff lookup (collision-aware first-name fallback) ─────────────────────
// Two-tier match:
//   1. Exact normalized full-name match (NFC + strip diacritics + lower +
//      collapse whitespace).
//   2. First-name fallback — ONLY when the first name is unique among
//      this property's staff. Two housekeepers named "Maria" disable the
//      first-name fallback for both, so neither gets the other's rooms.

export interface StaffLookup {
  /** Look up a staff id by housekeeper name string. Returns undefined on no match. */
  resolve(name: string | null | undefined): string | undefined;
}

export function buildStaffLookup(
  rows: Array<{ id: string; name: string | null }>,
): StaffLookup {
  const byFullName = new Map<string, string>();
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
      const firstName = full.split(' ')[0];
      if (!firstName) return undefined;
      // Collision-aware: only fall back when the first name is unique.
      if ((firstNameCounts.get(firstName) ?? 0) !== 1) return undefined;
      return firstNameIds.get(firstName);
    },
  };
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
  status: string | null;
  started_at: string | null;
  completed_at: string | null;
  dnd_active: boolean | null;
  // Workflow state (migration 0269) — persisted by the housekeeper
  // start/pause/resume/complete/exception + checklist endpoints. Optional so
  // callers/tests that build a minimal assignment shape still satisfy the type.
  is_paused?: boolean | null;
  paused_at?: string | null;
  total_paused_seconds?: number | null;
  exception_type?: string | null;
  exception_note?: string | null;
  exception_at?: string | null;
  checklist_template_id?: string | null;
  checklist_progress?: string[] | null;
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
// types in TypeScript without a guard. Supabase queries without
// `.single()` resolve to `{ data: T[] | null; error }` — the signature
// must reflect that or strict tsc rejects every call site.
function fulfilledData<T>(
  result: PromiseSettledResult<{ data: T[] | null; error: unknown }>,
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
  return data ?? [];
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
      .select('room_number, housekeeper_name, cleaning_type, status, started_at, completed_at, dnd_active, is_paused, paused_at, total_paused_seconds, exception_type, exception_note, exception_at, checklist_template_id, checklist_progress')
      .eq('property_id', pid)
      .eq('date', date),
    // M4 fix — deterministic order so double-bookings produce the
    // earliest-arrival reservation consistently, not Postgres page order.
    supabaseAdmin
      .from('pms_reservations')
      .select('room_number, arrival_date, departure_date, status')
      .eq('property_id', pid)
      .lte('arrival_date', date)
      // .gte (not .gt) so today's checkouts (departure_date == date) are
      // included — laundry checkout/stayover counts read 0 on a turn day
      // otherwise, before the CUA has populated assignments.
      .gte('departure_date', date)
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

  // Staff name → id lookup with collision-aware fuzzy match. Two staff
  // sharing a first name disable the first-name fallback for both, so
  // a bare "Maria" assignment doesn't get routed to the wrong Maria.
  const staffLookup = buildStaffLookup(staffRows);

  // 6. Compose Room[] — one per inventory row.
  const rooms: Room[] = [];
  for (const inv of inventory) {
    const num = String(inv.room_number);
    const assignment = assignmentByRoom.get(num);
    const reservation = reservationByRoom.get(num);
    const rawStatus = latestStatusByRoom.get(num) ?? null;

    // Out-of-service rooms (OOO / OOS in the status_log) with no active
    // HK assignment must not be counted as 'dirty'. They're blocked, not a
    // turn — force a non-dirty status and flag them so the dashboard /
    // laundry (no work-order overlay) can bucket them as out-of-service.
    const outOfService = !assignment && isOutOfServiceStatus(rawStatus);
    const status = outOfService ? 'clean' : deriveStatus(assignment, rawStatus);
    // Type: assignment wins once it exists. Before the CUA has populated
    // assignments, fall back to deriving the turn type from the reservation
    // so laundry checkout/stayover counts aren't all 0 on a real turn day.
    let reservationDerivedType: RoomType | undefined;
    if (!assignment && reservation) {
      if (reservation.departure_date === date) {
        reservationDerivedType = 'checkout';
      } else if (
        (reservation.arrival_date ?? '') < date &&
        (reservation.departure_date ?? '') > date
      ) {
        reservationDerivedType = 'stayover';
      }
    }
    const type = assignment
      ? mapType(assignment.cleaning_type)
      : (reservationDerivedType ?? 'vacant');

    const assignedNameRaw = assignment?.housekeeper_name?.trim() || undefined;
    const assignedTo = staffLookup.resolve(assignedNameRaw);

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
      // Composite "${date}:${room_number}" id (Codex Major #2). The previous
      // version used inv.id (a UUID with no date encoded), which made the
      // write path ambiguous when a manager edited a non-today view —
      // resolveRoomKey would default to today on a UUID rid even when the
      // tile actually belonged to yesterday. Composite ids carry the
      // viewed date through, so writes land on the right assignment row.
      id: composeRoomId(date, num),
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
      ...workflowStateFields(assignment),
      ...(arrival ? { arrival } : {}),
      ...(stayoverDay !== undefined ? { stayoverDay } : {}),
      // isOutOfService: distinct out-of-service flag so dirty/ready counts
      // can exclude OOO/OOS rooms. Cast: the `Room` type (src/types) does
      // not yet declare this optional field; producer-side cast keeps tsc
      // green here. Consumers read it as an optional boolean.
      ...(outOfService ? { isOutOfService: true } : {}),
    } as Room;
    rooms.push(room);
  }

  return rooms;
}

// Map the workflow-state columns (migration 0269) onto the Room shape. Shared
// by both the single-date and cross-date merges so the housekeeper page sees
// pause / checklist / exception state persisted by the workflow endpoints.
function workflowStateFields(assignment: AssignmentRow | undefined): Partial<Room> {
  if (!assignment) return {};
  const out: Partial<Room> = {};
  if (assignment.is_paused === true) out.isPaused = true;
  if (assignment.paused_at) out.pausedAt = new Date(assignment.paused_at);
  if (assignment.total_paused_seconds && assignment.total_paused_seconds > 0) {
    out.totalPausedSeconds = assignment.total_paused_seconds;
  }
  if (assignment.exception_type) {
    out.exceptionType = assignment.exception_type as Room['exceptionType'];
  }
  if (assignment.exception_note) out.exceptionNote = assignment.exception_note;
  if (assignment.exception_at) out.exceptionAt = new Date(assignment.exception_at);
  if (assignment.checklist_template_id) out.checklistTemplateId = assignment.checklist_template_id;
  if (assignment.checklist_progress && assignment.checklist_progress.length > 0) {
    out.checklistProgress = assignment.checklist_progress;
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// mergePmsRoomsForStaff — housekeeper SMS link (cross-date)
// ═══════════════════════════════════════════════════════════════════════════
// /api/housekeeper/rooms historically returned ALL rooms ever assigned to
// one housekeeper across dates (the page picks today/next-future/last-past
// client-side via byDate.get(today)). We need the same shape here.
//
// Differences from mergePmsRoomsForDate:
//   - Cross-date: returns one Room per (assignment date, room_number)
//   - Room.id format: "${date}:${room_number}" so the React keys + the
//     page's byDate grouping stay unique across dates
//   - Window: assignments [today-30d, today+30d] — generous on both sides
//     so a HK returning to the page after a few days off still sees their
//     last-worked date, and tomorrow's prebooked work shows up too
//   - Match: staff resolved by canonical name via StaffLookup; collision-
//     aware first-name fallback means "Maria S." matches "Maria Smith"
//     only if she's the only Maria on the property
//   - Reservations: queried for the full assignment window so per-date
//     arrival/stayoverDay flags are correct on past/future cards too
//   - Assignments: hard-required (Codex Major #13 — silent empty when the
//     assignments query fails would render every shift as "no work")

export async function mergePmsRoomsForStaff(
  pid: string,
  staffId: string,
): Promise<Room[]> {
  // 1. Resolve the staff record — canonical name to filter assignments by.
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

  // 2. Date window + assignments + full staff roster (for collision-aware
  //    fallback) in parallel.
  //
  // Codex Major #7: a 60-day window (-30/+30) returned every assignment
  // for the property — ~3,600 rows for a 60-room hotel before TS-side
  // filtering to this staff. Tightened to -14/+14 days (29-day window,
  // ~1,700 rows worst-case). The housekeeper page realistically needs
  // today + yesterday's overflow + tomorrow's pre-load; 14 days each
  // side is generous.
  const today = new Date().toISOString().slice(0, 10);
  const windowBack = new Date(Date.now() - 14 * 86_400_000)
    .toISOString().slice(0, 10);
  const windowAhead = new Date(Date.now() + 14 * 86_400_000)
    .toISOString().slice(0, 10);

  const [assignRes, staffListRes] = await Promise.allSettled([
    supabaseAdmin
      .from('pms_housekeeping_assignments')
      .select('date, room_number, housekeeper_name, cleaning_type, status, started_at, completed_at, dnd_active, is_paused, paused_at, total_paused_seconds, exception_type, exception_note, exception_at, checklist_template_id, checklist_progress')
      .eq('property_id', pid)
      .gte('date', windowBack)
      .lte('date', windowAhead),
    supabaseAdmin
      .from('staff')
      .select('id, name')
      .eq('property_id', pid),
  ]);

  // Assignments — hard requirement. Fail closed; silent empty would render
  // every HK shift as "no work."
  if (assignRes.status === 'rejected') {
    log.error('[pms-rooms-server] assignments-for-staff query rejected', {
      pid, staffId, msg: String(assignRes.reason),
    });
    throw new Error('assignments query failed');
  }
  if (assignRes.value.error) {
    log.error('[pms-rooms-server] assignments-for-staff query failed', {
      pid, staffId, msg: assignRes.value.error.message,
    });
    throw assignRes.value.error;
  }
  const allAssignments = (assignRes.value.data ?? []) as (AssignmentRow & { date: string })[];
  const staffListRows = fulfilledData<StaffNameRow>(staffListRes, 'staff', pid, today);

  // 3. Filter assignments to THIS staff member via the StaffLookup
  //    (collision-aware first-name fallback).
  const staffLookup = buildStaffLookup(staffListRows);
  const matching = allAssignments.filter(a => {
    const resolved = staffLookup.resolve(a.housekeeper_name);
    return resolved === staffId;
  });
  if (matching.length === 0) return [];

  // 4. Supporting feeds for the matching room-numbers / date-window.
  //    Status log: 90-day window, latest per room.
  //    Reservations: full assignment window, per-(date,room) lookup.
  const [statusRes, resRes] = await Promise.allSettled([
    supabaseAdmin
      .from('pms_room_status_log')
      .select('room_number, status, changed_at')
      .eq('property_id', pid)
      .gte('changed_at', new Date(Date.now() - 90 * 86_400_000).toISOString())
      .order('changed_at', { ascending: false }),
    supabaseAdmin
      .from('pms_reservations')
      .select('room_number, arrival_date, departure_date, status')
      .eq('property_id', pid)
      .lte('arrival_date', windowAhead)
      .gt('departure_date', windowBack)
      .in('status', ['booked', 'checked_in'])
      .order('arrival_date', { ascending: true }),
  ]);

  const statusRows = fulfilledData<StatusLogRow>(statusRes, 'status_log', pid, today);
  const reservationRows = fulfilledData<ReservationRow>(resRes, 'reservations', pid, today);

  const latestStatusByRoom = new Map<string, string>();
  for (const row of statusRows) {
    const num = String(row.room_number ?? '');
    if (!num || latestStatusByRoom.has(num)) continue;
    latestStatusByRoom.set(num, String(row.status ?? 'unknown'));
  }

  // Per-(date, room) reservation lookup so future/past assignment cards
  // get the right arrival/stayover flags.
  const reservationByDateRoom = new Map<string, Map<string, ReservationRow>>();
  for (const r of reservationRows) {
    const num = String(r.room_number ?? '');
    if (!num || !r.arrival_date || !r.departure_date) continue;
    const start = r.arrival_date > windowBack ? r.arrival_date : windowBack;
    const endExclusive = r.departure_date < windowAhead ? r.departure_date : windowAhead;
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

  // 5. Compose one Room per assignment row.
  const out: Room[] = [];
  for (const a of matching) {
    const num = String(a.room_number);
    const assignment = a;
    const reservation = reservationByDateRoom.get(a.date)?.get(num);
    const rawStatus = latestStatusByRoom.get(num) ?? null;

    const status = deriveStatus(assignment, rawStatus);
    const type = mapType(assignment.cleaning_type);

    const assignedNameRaw = assignment.housekeeper_name?.trim() || undefined;
    const assignedTo = staffLookup.resolve(assignedNameRaw);

    let arrival: string | undefined;
    let stayoverDay: number | undefined;
    if (reservation?.arrival_date) {
      if (reservation.arrival_date === a.date) {
        arrival = formatArrivalMDY(reservation.arrival_date);
      } else if (
        reservation.arrival_date < a.date &&
        (reservation.departure_date ?? '') > a.date
      ) {
        stayoverDay = daysBetween(reservation.arrival_date, a.date);
      }
    }

    out.push({
      id: composeRoomId(a.date, num),
      number: num,
      type,
      priority: 'standard',
      status,
      date: a.date,
      propertyId: pid,
      ...(assignedTo ? { assignedTo } : {}),
      ...(assignedNameRaw ? { assignedName: assignedNameRaw } : {}),
      ...(assignment.started_at ? { startedAt: new Date(assignment.started_at) } : {}),
      ...(assignment.completed_at ? { completedAt: new Date(assignment.completed_at) } : {}),
      ...(assignment.dnd_active === true ? { isDnd: true } : {}),
      ...workflowStateFields(assignment),
      ...(arrival ? { arrival } : {}),
      ...(stayoverDay !== undefined ? { stayoverDay } : {}),
    });
  }
  return out;
}
